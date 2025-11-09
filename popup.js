(() => {
  // ---- Elements ----
  const $ = (id) => document.getElementById(id);
  const elFile        = $("promptsFile");
  const elFileName    = $("fileName");
  const elPromptCount = $("promptCount");
  const elConcAll     = $("concAll");
  const elConcCap     = $("concCap");
  const elKInput      = $("kInput");
  const elFolder      = $("folderName");
  const elStart       = $("startBtn");
  const elPause       = $("pauseBtn");
  const elResume      = $("resumeBtn");
  const elStop        = $("stopBtn");
  const elProgress    = $("progressBar");
  const elRunStatus   = $("runStatus");
  const elCountDone   = $("countDone");
  const elCountTotal  = $("countTotal");
  const elRecentList  = $("recentList");
  const elErrorBox    = $("errorBox");

  // ---- State ----
  const state = {
    prompts: [],        // strictly from data.image_prompts
    fileName: "none",
    total: 0,
    done: 0,
    running: false,
    paused: false,
    mode: "cap",        // "all" | "cap"
    k: 8,               // default per your request
    folder: "assets/images",
  };

  // ---- Helpers ----
  function showError(msg) {
    elErrorBox.style.display = "block";
    elErrorBox.textContent = msg || "Unexpected error.";
  }
  function clearError() {
    elErrorBox.style.display = "none";
    elErrorBox.textContent = "";
  }
  function setStatus(text) {
    elRunStatus.textContent = text;
  }
  function setButtons({ idle=false, running=false, paused=false, done=false }) {
    // Idle: only Start enabled if prompts loaded
    // Running: Pause/Stop enabled
    // Paused: Resume/Stop enabled
    // Done: Start enabled again
    const hasPrompts = state.prompts.length > 0;
    elStart.disabled  = running || paused || !hasPrompts;
    elPause.disabled  = !running;
    elResume.disabled = !paused;
    elStop.disabled   = !(running || paused);

    if (idle)    setStatus("Idle");
    if (running) setStatus("Running");
    if (paused)  setStatus("Paused");
    if (done)    setStatus("Done");
  }
  function setProgress(done, total) {
    state.done = done;
    state.total = total;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    elProgress.value = pct;
    elCountDone.textContent = String(done);
    elCountTotal.textContent = String(total);
  }
  function addRecent(line, cls) {
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.textContent = line;
    const right = document.createElement("span");
    if (cls) right.className = cls;
    li.appendChild(left);
    li.appendChild(right);
    elRecentList.prepend(li);
    // keep list to ~50 entries
    while (elRecentList.children.length > 50) {
      elRecentList.removeChild(elRecentList.lastChild);
    }
  }
  function readConcurrencyFromUI() {
    state.mode = elConcAll.checked ? "all" : "cap";
    let k = parseInt(elKInput.value, 10);
    if (!Number.isFinite(k) || k < 1) k = 1;
    state.k = k;
    state.folder = (elFolder.value || "assets/images").trim();
  }
  function saveSettings() {
    readConcurrencyFromUI();
    chrome.storage.local.set({
      popup_settings: {
        mode: state.mode,
        k: state.k,
        folder: state.folder,
      }
    });
  }
  async function loadSettings() {
    const { popup_settings } = await chrome.storage.local.get("popup_settings");
    if (popup_settings) {
      if (popup_settings.mode === "all" || popup_settings.mode === "cap") {
        (popup_settings.mode === "all" ? elConcAll : elConcCap).checked = true;
      } else {
        elConcCap.checked = true; // default
      }
      elKInput.value = String(popup_settings.k ?? 8);
      elFolder.value = popup_settings.folder ?? "assets/images";
    } else {
      // Defaults you requested
      elConcCap.checked = true;
      elKInput.value = "8";
      elFolder.value = "assets/images";
    }
    readConcurrencyFromUI();
  }

  // ---- File handling (ONLY image_prompts) ----
  elFile.addEventListener("change", async () => {
    clearError();
    setProgress(0, 0);
    state.prompts = [];
    elPromptCount.textContent = "0";
    elFileName.textContent = "none";

    const f = elFile.files && elFile.files[0];
    if (!f) return;

    elFileName.textContent = f.name;

    try {
      const text = await f.text();
      const data = JSON.parse(text);

      // STRICT: only take image_prompts
      const arr = Array.isArray(data?.image_prompts) ? data.image_prompts : [];
      const prompts = arr
        .filter((x) => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean);

      if (prompts.length === 0) {
        showError("No valid entries found in \"image_prompts\".");
        return;
      }

      state.prompts = prompts;
      elPromptCount.textContent = String(prompts.length);
      setProgress(0, prompts.length);

      // Save the raw prompts to storage so background can read them if needed
      await chrome.storage.local.set({ uploaded_image_prompts: prompts });

      addRecent(`Loaded ${prompts.length} image prompts from ${f.name}`, "ok");
    } catch (e) {
      console.error(e);
      showError("Invalid JSON. Make sure the file is valid and contains an \"image_prompts\" array of strings.");
    }
    setButtons({ idle: true });
  });

  // ---- Control handlers ----
  elStart.addEventListener("click", async () => {
    clearError();
    if (state.prompts.length === 0) {
      showError("Load a prompts.json first (must have image_prompts).");
      return;
    }
    saveSettings();

    // Send run request to background
    const payload = {
      type: "RUN_START",
      prompts: state.prompts,        // strictly image_prompts
      mode: state.mode,              // "all" | "cap"
      k: state.k,                    // cap value if mode = cap
      folder: state.folder,          // download subfolder
      numbering: "json-order",       // 01..NN by JSON order
    };

    chrome.runtime.sendMessage(payload, (resp) => {
      if (chrome.runtime.lastError) {
        showError(chrome.runtime.lastError.message || "Could not contact background.");
        return;
      }
      // Best-effort UI set (background will also confirm via RUN_STARTED)
      state.running = true; state.paused = false;
      setButtons({ running: true });
      addRecent("Run started", "ok");
    });
  });

  elPause.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "RUN_PAUSE" });
  });

  elResume.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "RUN_RESUME" });
  });

  elStop.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "RUN_STOP" });
  });

  // Persist settings on change
  [elConcAll, elConcCap, elKInput, elFolder].forEach((el) => {
    el.addEventListener("change", saveSettings);
    el.addEventListener("input",  saveSettings);
  });

  // ---- Incoming messages from background ----
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case "RUN_STARTED": {
        state.running = true; state.paused = false;
        setButtons({ running: true });
        setProgress(0, msg.total ?? state.prompts.length);
        addRecent("Background acknowledged start", "ok");
        break;
      }
      case "RUN_UPDATE": {
        // { type, done, total, note?, item? }
        const done = Number.isFinite(msg.done) ? msg.done : state.done;
        const total = Number.isFinite(msg.total) ? msg.total : state.total || state.prompts.length;
        setProgress(done, total);
        if (msg.note) addRecent(msg.note);
        if (msg.item && msg.item.status) {
          const idx = (msg.item.index ?? 0) + 1;
          const label = `#${String(idx).padStart(2,"0")}`;
          const cls = msg.item.status === "downloaded" ? "ok"
                    : msg.item.status === "error"      ? "err"
                    : undefined;
          addRecent(`${label} — ${msg.item.status}`, cls);
        }
        break;
      }
      case "RUN_PAUSED": {
        state.running = false; state.paused = true;
        setButtons({ paused: true });
        addRecent("Paused", "warnTxt");
        break;
      }
      case "RUN_RESUMED": {
        state.running = true; state.paused = false;
        setButtons({ running: true });
        addRecent("Resumed", "ok");
        break;
      }
      case "RUN_STOPPED": {
        state.running = false; state.paused = false;
        setButtons({ idle: true });
        addRecent("Stopped", "warnTxt");
        break;
      }
      case "RUN_COMPLETED": {
        state.running = false; state.paused = false;
        setProgress(msg.done ?? state.total, msg.total ?? state.total);
        setButtons({ done: true });
        addRecent("All prompts processed", "ok");
        break;
      }
      case "RUN_ERROR": {
        if (msg.message) showError(msg.message);
        state.running = false; state.paused = false;
        setButtons({ idle: true });
        addRecent("Error occurred", "err");
        break;
      }
      default:
        // ignore unknown
        break;
    }
  });

  // ---- Init ----
  document.addEventListener("DOMContentLoaded", async () => {
    clearError();
    await loadSettings();
    // If background is mid-run, request status snapshot (optional)
    chrome.runtime.sendMessage({ type: "RUN_SNAPSHOT" }, (snap) => {
      if (!snap || chrome.runtime.lastError) {
        setButtons({ idle: true });
        setProgress(0, 0);
        return;
      }
      // Snap format expected from background:
      // { running, paused, done, total, recent?: string[] }
      state.running = !!snap.running;
      state.paused  = !!snap.paused;
      setProgress(snap.done ?? 0, snap.total ?? 0);

      if (state.running) setButtons({ running: true });
      else if (state.paused) setButtons({ paused: true });
      else setButtons({ idle: true });

      if (Array.isArray(snap.recent)) {
        snap.recent.slice(-10).forEach((r) => addRecent(r));
      }
    });
  });
})();
