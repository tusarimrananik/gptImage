// content_chatgpt.js — guaranteed submit + single download per prompt.
// Stops clicking as soon as background says "DL_STARTED" (or when payload is intercepted).

(function () {
  let RUNNING = false;
  let CURRENT = null;
  let SENT_PAYLOAD = false;
  let DL_ALREADY_STARTED = false;
  let lastClickAt = 0;
  let clickRetries = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qs  = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function compose({ globalId = "", styleModule = "", prompt, outputSuffix = "" }) {
    return [globalId, styleModule, `[SCENE] ${prompt}`, outputSuffix]
      .filter(Boolean)
      .map(s => String(s).replace(/\s+/g, " ").trim())
      .join(" ");
  }

  // --- MAIN-WORLD download intercept (anchor + window.open) ---
  function installDownloadIntercept() {
    const code = `
      (function(){
        if (window.__EXT_DL_INSTALLED__) return;
        window.__EXT_DL_INSTALLED__ = true;
        window.__EXT_DL_ARMED__ = false;

        window.addEventListener("message", (ev) => {
          const d = ev && ev.data; if (!d || d.__extFlag__ !== true) return;
          if (d.type === "ARM_DL") window.__EXT_DL_ARMED__ = true;
        });
        const post = (data) => {
          if (!window.__EXT_DL_ARMED__) return;
          window.__EXT_DL_ARMED__ = false;
          window.postMessage(Object.assign({__extFlag__:true}, data), "*");
        };

        const urlToBlob = new Map();
        const origURL = URL.createObjectURL;
        URL.createObjectURL = function(obj){
          const url = origURL.call(this, obj);
          try { urlToBlob.set(url, obj); } catch(e){}
          return url;
        };

        const aClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function(...args){
          try{
            const href = this.href || "";
            const dl   = this.getAttribute("download");
            const looksImg = /^data:image\\//i.test(href) || /^blob:/i.test(href) || /\\.(png|jpe?g|webp)$/i.test(href);
            if (dl != null || looksImg) {
              const b = urlToBlob.get(href);
              if (b) {
                const fr = new FileReader();
                fr.onload = () => {
                  const type = (b.type || "").toLowerCase();
                  const ext  = type.includes("jpeg") ? "jpg" : (type.includes("webp") ? "webp" : "png");
                  post({ type:"EXT_DL_DATAURL", dataUrl:String(fr.result), ext });
                };
                fr.readAsDataURL(b);
              } else {
                post({ type:"EXT_DL_URL", url: href });
              }
            }
          }catch(e){}
          return aClick.apply(this, args);
        };

        const wOpen = window.open;
        window.open = function(url,n,s){
          try{
            if (typeof url === "string") {
              const looksImg = /^data:image\\//i.test(url) || /^blob:/i.test(url) || /\\.(png|jpe?g|webp)$/i.test(url);
              if (looksImg) post({ type:"EXT_DL_URL", url });
            }
          }catch(e){}
          return wOpen.call(this,url,n,s);
        };
      })();
    `;
    const s = document.createElement("script");
    s.textContent = code;
    (document.documentElement || document.head || document.body).appendChild(s);
    s.remove();
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data; if (!d || d.__extFlag__ !== true) return;
    if (!CURRENT || SENT_PAYLOAD) return;

    if (d.type === "EXT_DL_DATAURL" && d.dataUrl) {
      SENT_PAYLOAD = true;
      chrome.runtime.sendMessage({ type: "DOWNLOAD_DATAURL", index: CURRENT.index, dataUrl: d.dataUrl, ext: d.ext || "png" });
    } else if (d.type === "EXT_DL_URL" && d.url) {
      SENT_PAYLOAD = true;
      chrome.runtime.sendMessage({ type: "DOWNLOAD_URL", index: CURRENT.index, url: d.url });
    }
  });

  // --- editor + send helpers ---
  function findEditorOnce() {
    return (
      qs('textarea#prompt-textarea') ||
      qs('textarea[aria-label*="message" i]') ||
      qs('div[contenteditable="true"][data-lexical-editor]') ||
      qs('div.ProseMirror[contenteditable="true"]') ||
      qs('[contenteditable="true"][role="textbox"]')
    );
  }

  async function waitForEditor(timeout = 90000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const ed = findEditorOnce();
      if (ed) return ed;
      document.scrollingElement && (document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight);
      await sleep(150);
    }
    throw new Error("Editor not found (are you logged in?)");
  }

  function setText(editor, text) {
    const tag = (editor.tagName || "").toLowerCase();
    if (tag === "textarea") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(editor, text); else editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      editor.focus();
      try {
        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);
      } catch {
        editor.textContent = text;
        editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
    }
  }

  function clickWithEvents(el) {
    try {
      el.focus();
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.click();
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    } catch {}
  }

  function pressEnterOn(el) {
    try {
      el.dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true }));
      el.dispatchEvent(new KeyboardEvent("keypress",{ key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true }));
      el.dispatchEvent(new KeyboardEvent("keyup",   { key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true }));
    } catch {}
  }

  function findSendButton() {
    return (
      qs('button[data-testid="send-button"]:not([disabled])') ||
      qs('button[aria-label="Send message"]:not([disabled])') ||
      qs('button[aria-label*="send" i]:not([disabled])') ||
      qs('form button[type="submit"]:not([disabled])') ||
      qs('button:has(svg)')
    );
  }

  async function waitForSendButtonEnabled(timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const b = findSendButton();
      if (b) return b;
      await sleep(120);
    }
    return null;
  }

  // --- download button helpers ---
  function newestDownloadBtn() {
    const visible = el => { const r = el?.getBoundingClientRect?.(); return r && r.width > 0 && r.height > 0; };
    const btns = qsa('button[aria-label*="download" i]').filter(visible);
    return btns.length ? btns.at(-1) : null;
  }
  async function waitForDownloadBtn(timeout = 300000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const b = newestDownloadBtn();
      if (b) return b;
      document.scrollingElement && (document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight);
      await sleep(300);
    }
    throw new Error('Timed out waiting for "Download" button');
  }

  function loginGatePresent() {
    return (qs('a[href*="/login"]') || qs('button[data-testid="login-button"]') || /log in|sign in/i.test(document.body.innerText || ""));
  }

  function armAndClick(btn) {
    // tell background to rename the next browser-initiated download from this tab
    chrome.runtime.sendMessage({ type: "SET_NEXT_DOWNLOAD_INDEX", index: CURRENT.index });
    // arm main-world intercept
    window.postMessage({ __extFlag__: true, type: "ARM_DL" }, "*");
    clickWithEvents(btn);
    lastClickAt = Date.now();
    clickRetries++;
  }

  async function runPromptFlow(payload) {
    installDownloadIntercept();

    if (loginGatePresent()) {
      chrome.runtime.sendMessage({ type: "NEED_LOGIN", index: payload.index, note: "Login required" });
      return;
    }

    const text = compose(payload);
    const editor = await waitForEditor(90000);
    editor.scrollIntoView({ block: "center" });
    editor.focus();
    setText(editor, text);
    await sleep(120);

    const sendBtn = await waitForSendButtonEnabled(6000);
    if (sendBtn) { clickWithEvents(sendBtn); await sleep(200); }
    pressEnterOn(editor); // also press Enter as backup

    chrome.runtime.sendMessage({ type: "PROMPT_SUBMITTED", index: payload.index });

    const dlBtn = await waitForDownloadBtn(300000);
    SENT_PAYLOAD = false;
    DL_ALREADY_STARTED = false;
    clickRetries = 0;
    armAndClick(dlBtn);
  }

  // ------------ listeners ------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Start a new prompt
    if (msg?.type === "RUN_PROMPT" && !RUNNING) {
      RUNNING = true;
      CURRENT = { index: msg.index };
      (async () => {
        try {
          await runPromptFlow({
            index: msg.index,
            prompt: msg.prompt,
            globalId: msg.globalId,
            styleModule: msg.styleModule,
            outputSuffix: msg.outputSuffix
          });
          sendResponse && sendResponse({ ok: true });
        } catch (err) {
          chrome.runtime.sendMessage({ type: "ITEM_ERROR", index: msg.index, message: String(err?.message || err) });
          sendResponse && sendResponse({ ok: false, error: String(err?.message || err) });
        } finally {
          RUNNING = false;
        }
      })();
      return true; // async
    }

    // Foreground rotation tick: if download hasn't started and we haven't captured payload, try again BUT throttle.
    if (msg?.type === "FOREGROUND_TICK") {
      if (!CURRENT || DL_ALREADY_STARTED || SENT_PAYLOAD) return;
      const now = Date.now();
      if (now - lastClickAt < 1800) return;             // throttle re-clicks
      if (clickRetries >= 3) return;                     // hard cap retries
      const b = newestDownloadBtn();
      if (b) armAndClick(b);
    }

    // Background tells us the download started (from onCreated or our own download).
    if (msg?.type === "DL_STARTED" && CURRENT && msg.index === CURRENT.index) {
      DL_ALREADY_STARTED = true; // stop any further clicks
    }
  });

  // take intercepted payload → background download (deterministic name)
  window.addEventListener("message", (ev) => {
    const d = ev.data; if (!d || d.__extFlag__ !== true) return;
    if (!CURRENT || SENT_PAYLOAD) return;
    if (d.type === "EXT_DL_DATAURL" && d.dataUrl) {
      SENT_PAYLOAD = true;
      chrome.runtime.sendMessage({ type: "DOWNLOAD_DATAURL", index: CURRENT.index, dataUrl: d.dataUrl, ext: d.ext || "png" });
    } else if (d.type === "EXT_DL_URL" && d.url) {
      SENT_PAYLOAD = true;
      chrome.runtime.sendMessage({ type: "DOWNLOAD_URL", index: CURRENT.index, url: d.url });
    }
  });
})();
