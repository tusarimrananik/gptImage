// background.js — stop re-downloads + guaranteed renaming via downloadId→index binding
// Requires: "downloads", "tabs", "scripting", "alarms", "storage" permissions.

const RUNTIME = {
  active: false,
  paused: false,

  prompts: [],
  total: 0,
  done: 0,

  folder: "assets/images",
  mode: "cap", // "all" | "cap"
  k: 8,
  pad: 2,

  // queue items: queued → assigned → submitted → waiting → downloading → done|error
  queue: [],

  // tab bookkeeping
  createdTabs: new Set(),        // tabIds we opened
  assignedByTab: new Map(),      // tabId -> index
  tabIdByIndex: new Map(),       // index -> tabId
  windowByTab: new Map(),        // tabId -> windowId

  // download bookkeeping
  nextDlIndexByTab: new Map(),   // tabId -> [indices queued for rename]
  downloadIdToIndex: new Map(),  // downloadId -> index

  // UI log
  recent: [],

  // rotation
  rotating: false,
  rotIdx: 0,

  // prompt modules
  opts: {
    globalId: "",
    styleModule: "",
    outputSuffix: " [OUTPUT] High resolution, aspect ratio 3:2, single-frame composition, no collage."
  }
};

const log = (s) => {
  RUNTIME.recent.push(s);
  if (RUNTIME.recent.length > 300) RUNTIME.recent.shift();
  chrome.runtime.sendMessage({ type: "RUN_UPDATE", done: RUNTIME.done, total: RUNTIME.total, note: s });
};

const padWidth = (n) => Math.max(2, String(n).length);
const numName  = (i, pad) => String(i + 1).padStart(pad, "0");

// small helper to promisify downloads.download for MV3
function startDownload(opts) {
  return new Promise((resolve, reject) => {
    try {
      chrome.downloads.download(opts, (id) => {
        if (chrome.runtime.lastError || typeof id !== "number") {
          reject(new Error(chrome.runtime.lastError?.message || "download failed"));
        } else {
          resolve(id);
        }
      });
    } catch (e) { reject(e); }
  });
}

// ---------------- message hub (popup + content) ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      // popup controls
      case "RUN_START": {
        if (!Array.isArray(msg.prompts) || msg.prompts.length === 0) {
          sendResponse({ ok: false, error: "No prompts." });
          return;
        }
        await startRun(msg);
        sendResponse({ ok: true });
        break;
      }
      case "RUN_PAUSE": {
        RUNTIME.paused = true;
        stopRotator();
        chrome.runtime.sendMessage({ type: "RUN_PAUSED" });
        log("Paused by user");
        sendResponse({ ok: true });
        break;
      }
      case "RUN_RESUME": {
        RUNTIME.paused = false;
        chrome.runtime.sendMessage({ type: "RUN_RESUMED" });
        log("Resumed");
        pump();
        startRotator();
        sendResponse({ ok: true });
        break;
      }
      case "RUN_STOP": {
        await stopRun("Stopped by user");
        chrome.runtime.sendMessage({ type: "RUN_STOPPED" });
        sendResponse({ ok: true });
        break;
      }
      case "RUN_SNAPSHOT": {
        sendResponse({
          running: RUNTIME.active && !RUNTIME.paused,
          paused:  RUNTIME.active && RUNTIME.paused,
          done:    RUNTIME.done,
          total:   RUNTIME.total,
          recent:  RUNTIME.recent.slice(-12)
        });
        break;
      }

      // from content
      case "PROMPT_SUBMITTED": {
        const it = RUNTIME.queue[msg.index];
        if (it) it.status = "waiting";
        log(`#${numName(msg.index, RUNTIME.pad)} submitted`);
        sendResponse({ ok: true });
        break;
      }

      // register that the very next browser download from this tab belongs to this index
      case "SET_NEXT_DOWNLOAD_INDEX": {
        const tabId = sender?.tab?.id;
        if (tabId != null) {
          const q = RUNTIME.nextDlIndexByTab.get(tabId) || [];
          q.push(msg.index);
          RUNTIME.nextDlIndexByTab.set(tabId, q);
        }
        sendResponse({ ok: true });
        break;
      }

      case "ITEM_ERROR": {
        setItemError(msg.index, msg.message || "Unknown error");
        sendResponse({ ok: true });
        break;
      }

      case "NEED_LOGIN": {
        RUNTIME.paused = true;
        stopRotator();
        chrome.runtime.sendMessage({ type: "RUN_PAUSED" });
        log("Paused: login required. Complete login in any one tab, then Resume.");
        sendResponse({ ok: true });
        break;
      }

      // Intercepted payload → extension initiates download (deterministic filename)
      case "DOWNLOAD_URL": {
        const idx = msg.index;
        const url = msg.url;
        const ext = inferExt(url, null);
        const filename = `${RUNTIME.folder}/${numName(idx, RUNTIME.pad)}.${ext}`;
        try {
          setItemDownloading(idx);
          const id = await startDownload({ url, filename, saveAs: false, conflictAction: "overwrite" });
          bindDownloadToIndex(idx, id);
          sendResponse({ ok: true });
        } catch (e) {
          setItemError(idx, "Download failed: " + String(e?.message || e));
          sendResponse({ ok: false });
        }
        break;
      }
      case "DOWNLOAD_DATAURL": {
        const idx = msg.index;
        const dataUrl = msg.dataUrl;
        const ext = (msg.ext || "png").replace(/^\./, "");
        const filename = `${RUNTIME.folder}/${numName(idx, RUNTIME.pad)}.${ext}`;
        try {
          setItemDownloading(idx);
          const id = await startDownload({ url: dataUrl, filename, saveAs: false, conflictAction: "overwrite" });
          bindDownloadToIndex(idx, id);
          sendResponse({ ok: true });
        } catch (e) {
          setItemError(idx, "Download failed (data): " + String(e?.message || e));
          sendResponse({ ok: false });
        }
        break;
      }

      default:
        sendResponse(); // ignore
    }
  })();
  return true; // async
});

// ---------------- run control ----------------
async function startRun(payload) {
  const { runner_options } = await chrome.storage.sync.get("runner_options");
  RUNTIME.opts = {
    globalId:     runner_options?.globalId || "",
    styleModule:  runner_options?.styleModule || "",
    outputSuffix: runner_options?.outputSuffix || " [OUTPUT] High resolution, aspect ratio 3:2, single-frame composition, no collage."
  };

  RUNTIME.active  = true;
  RUNTIME.paused  = false;
  RUNTIME.prompts = payload.prompts.slice();
  RUNTIME.total   = RUNTIME.prompts.length;
  RUNTIME.done    = 0;

  RUNTIME.folder  = payload.folder || "assets/images";
  RUNTIME.mode    = payload.mode === "all" ? "all" : "cap";
  RUNTIME.k       = Number.isFinite(payload.k) ? Math.max(1, payload.k) : 8;
  RUNTIME.pad     = padWidth(RUNTIME.total);

  RUNTIME.queue = RUNTIME.prompts.map((p, i) => ({ index: i, prompt: p, status: "queued" }));

  RUNTIME.createdTabs.clear();
  RUNTIME.assignedByTab.clear();
  RUNTIME.tabIdByIndex.clear();
  RUNTIME.windowByTab.clear();
  RUNTIME.nextDlIndexByTab.clear();
  RUNTIME.downloadIdToIndex.clear();
  RUNTIME.rotIdx = 0;

  chrome.runtime.sendMessage({ type: "RUN_STARTED", total: RUNTIME.total });
  log(`Run started: ${RUNTIME.total} prompts · mode=${RUNTIME.mode}, k=${RUNTIME.k}`);

  pump();
  startRotator();
}

async function stopRun(reason) {
  if (!RUNTIME.active) return;
  RUNTIME.active = false;
  RUNTIME.paused = false;

  stopRotator();

  const ids = Array.from(RUNTIME.createdTabs);
  if (ids.length) { try { chrome.tabs.remove(ids); } catch {} }

  RUNTIME.createdTabs.clear();
  RUNTIME.assignedByTab.clear();
  RUNTIME.tabIdByIndex.clear();
  RUNTIME.windowByTab.clear();
  RUNTIME.nextDlIndexByTab.clear();
  RUNTIME.downloadIdToIndex.clear();

  log(reason || "Run stopped");
}

function nextQueued() { return RUNTIME.queue.find(q => q.status === "queued"); }
function activeCount() { // tabs that still need foreground interaction
  return RUNTIME.queue.filter(q => ["assigned", "submitted", "waiting"].includes(q.status)).length;
}

function pump() {
  if (!RUNTIME.active || RUNTIME.paused) return;

  const cap = (RUNTIME.mode === "all") ? RUNTIME.total : Math.min(RUNTIME.k, RUNTIME.total);
  while (activeCount() < cap) {
    const item = nextQueued();
    if (!item) break;
    assignToTab(item);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  RUNTIME.createdTabs.delete(tabId);
  const idx = RUNTIME.assignedByTab.get(tabId);
  if (typeof idx === "number") {
    const it = RUNTIME.queue[idx];
    if (it && !["done","error"].includes(it.status)) setItemError(idx, "Tab closed before download");
  }
  const i = RUNTIME.assignedByTab.get(tabId);
  if (typeof i === "number") RUNTIME.tabIdByIndex.delete(i);
  RUNTIME.assignedByTab.delete(tabId);
  RUNTIME.windowByTab.delete(tabId);
  RUNTIME.nextDlIndexByTab.delete(tabId);
  pump();
});

function assignToTab(item) {
  item.status = "assigned";
  chrome.tabs.create({ url: "https://chatgpt.com/", active: false }, (tab) => {
    if (!tab || !tab.id) { setItemError(item.index, "Failed to open tab"); return; }
    const tabId = tab.id;
    RUNTIME.createdTabs.add(tabId);
    RUNTIME.assignedByTab.set(tabId, item.index);
    RUNTIME.tabIdByIndex.set(item.index, tabId);
    RUNTIME.windowByTab.set(tabId, tab.windowId);

    const onUpdated = (tid, info) => {
      if (tid !== tabId) return;
      if (info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        injectRunner(tabId, item);
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);

    // safety
    setTimeout(() => {
      try { chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError || !t) return;
        if (item.status === "assigned") {
          setItemError(item.index, "Page load timeout");
          try { chrome.tabs.remove(tabId); } catch {}
        }
      }); } catch {}
    }, 60000);
  });
}

function injectRunner(tabId, item) {
  chrome.scripting.executeScript(
    { target: { tabId }, files: ["content_chatgpt.js"] },
    () => {
      if (chrome.runtime.lastError) {
        setItemError(item.index, "Injection failed");
        try { chrome.tabs.remove(tabId); } catch {}
        return;
      }
      item.status = "submitted";
      chrome.tabs.sendMessage(tabId, {
        type: "RUN_PROMPT",
        index: item.index,
        prompt: item.prompt,
        globalId: RUNTIME.opts.globalId,
        styleModule: RUNTIME.opts.styleModule,
        outputSuffix: RUNTIME.opts.outputSuffix
      }, () => void 0);
    }
  );
}

function setItemDownloading(index) {
  const it = RUNTIME.queue[index];
  if (!it || it.status === "downloading" || it.status === "done") return;
  it.status = "downloading";
  // tell this tab to stop clicking (download has started)
  const tabId = RUNTIME.tabIdByIndex.get(index);
  if (tabId != null) {
    try { chrome.tabs.sendMessage(tabId, { type: "DL_STARTED", index }); } catch {}
  }
}

function setItemError(index, message) {
  const it = RUNTIME.queue[index];
  if (!it || ["done","error"].includes(it.status)) return;
  it.status = "error";
  log(`#${numName(index, RUNTIME.pad)} error: ${message}`);
  maybeFinish(); pump();
}

function setItemDone(index) {
  const it = RUNTIME.queue[index];
  if (!it || it.status === "done") return;
  it.status = "done";
  RUNTIME.done += 1;

  chrome.runtime.sendMessage({
    type: "RUN_UPDATE",
    done: RUNTIME.done,
    total: RUNTIME.total,
    item: { index, status: "downloaded" }
  });

  // close its tab to avoid any future rotation clicks
  const tabId = RUNTIME.tabIdByIndex.get(index);
  if (tabId != null) {
    try { chrome.tabs.remove(tabId); } catch {}
    RUNTIME.createdTabs.delete(tabId);
    RUNTIME.assignedByTab.delete(tabId);
    RUNTIME.windowByTab.delete(tabId);
    RUNTIME.nextDlIndexByTab.delete(tabId);
    RUNTIME.tabIdByIndex.delete(index);
  }

  if (RUNTIME.done === RUNTIME.total) {
    RUNTIME.active = false;
    stopRotator();
    chrome.runtime.sendMessage({ type: "RUN_COMPLETED", done: RUNTIME.done, total: RUNTIME.total });
    log("All prompts processed");
  }
}

function maybeFinish() {
  const allDone = RUNTIME.queue.every(q => ["done","error"].includes(q.status));
  if (allDone) {
    RUNTIME.active = false;
    stopRotator();
    chrome.runtime.sendMessage({ type: "RUN_COMPLETED", done: RUNTIME.done, total: RUNTIME.total });
    log("Run completed (some items may have errors)");
  }
}

// ---------------- active rotation (bring each tab foreground briefly) ----------------
function startRotator() {
  if (RUNTIME.rotating) return;
  RUNTIME.rotating = true;
  chrome.alarms.create("rotate_tabs", { periodInMinutes: 0.033 }); // ~2s
}
function stopRotator() {
  RUNTIME.rotating = false;
  chrome.alarms.clear("rotate_tabs");
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "rotate_tabs") return;
  if (!RUNTIME.active || RUNTIME.paused) return;

  // rotate only tabs that still need user‑gesture (NOT downloading/done/error)
  const candidates = Array.from(RUNTIME.createdTabs).filter(tabId => {
    const idx = RUNTIME.assignedByTab.get(tabId);
    const st  = (idx != null) ? RUNTIME.queue[idx]?.status : null;
    return st && ["assigned","submitted","waiting"].includes(st);
  });
  if (!candidates.length) return;

  if (RUNTIME.rotIdx >= candidates.length) RUNTIME.rotIdx = 0;
  const tabId = candidates[RUNTIME.rotIdx++];
  const winId = RUNTIME.windowByTab.get(tabId);

  try {
    if (winId != null) await chrome.windows.update(winId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: "FOREGROUND_TICK" }, () => void 0);
    }, 350);
  } catch {}
});

// ---------------- downloads hooks ----------------

// A download was created (this fires for page‑initiated downloads as well)
chrome.downloads.onCreated.addListener((item) => {
  // If a page initiated the download, it will have a tabId >= 0
  if (typeof item.tabId === "number" && item.tabId >= 0) {
    const tabId = item.tabId;
    let idxQ = RUNTIME.nextDlIndexByTab.get(tabId) || [];
    let idx = idxQ.length ? idxQ.shift() : RUNTIME.assignedByTab.get(tabId);
    RUNTIME.nextDlIndexByTab.set(tabId, idxQ);
    if (typeof idx === "number") {
      bindDownloadToIndex(idx, item.id);
    }
  }
});

// We must rename synchronously using the bound downloadId → index mapping.
chrome.downloads.onDeterminingFilename.addListener((details, suggest) => {
  const idx = RUNTIME.downloadIdToIndex.get(details.id);
  if (typeof idx === "number") {
    const ext = inferExt(details.filename, details.mime);
    const name = `${RUNTIME.folder}/${numName(idx, RUNTIME.pad)}.${ext}`;
    suggest({ filename: name, conflictAction: "overwrite" });
  } else {
    // unknown download; leave as-is
    suggest({});
  }
});

// Mark complete/error and close the tab
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.state) return;
  if (delta.state.current === "complete") {
    const idx = RUNTIME.downloadIdToIndex.get(delta.id);
    if (typeof idx === "number") {
      RUNTIME.downloadIdToIndex.delete(delta.id);
      setItemDone(idx);
      pump();
    }
  } else if (delta.state.current === "interrupted") {
    const idx = RUNTIME.downloadIdToIndex.get(delta.id);
    if (typeof idx === "number") {
      RUNTIME.downloadIdToIndex.delete(delta.id);
      setItemError(idx, "Download interrupted");
      pump();
    }
  }
});

// ---- helpers ----
function bindDownloadToIndex(index, downloadId) {
  RUNTIME.downloadIdToIndex.set(downloadId, index);
  setItemDownloading(index);
}

function inferExt(filenameOrUrl, mime) {
  const s = (filenameOrUrl || "").toLowerCase();
  if (/\.(png)(\?|$)/.test(s))  return "png";
  if (/\.(jpe?g)(\?|$)/.test(s))return "jpg";
  if (/\.(webp)(\?|$)/.test(s)) return "webp";
  if (mime) {
    const m = mime.toLowerCase();
    if (m.includes("png"))  return "png";
    if (m.includes("jpeg")) return "jpg";
    if (m.includes("webp")) return "webp";
  }
  return "png";
}
