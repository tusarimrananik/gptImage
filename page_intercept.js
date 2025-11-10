// page_intercept.js — runs in MAIN world (no CSP violations).
(() => {
  if (window.__EXT_DL_INSTALLED__) return;
  window.__EXT_DL_INSTALLED__ = true;
  window.__EXT_DL_ARMED__ = false;

  // Arm/disarm via postMessage from the content script
  window.addEventListener("message", (ev) => {
    const d = ev && ev.data;
    if (!d || d.__extFlag__ !== true) return;
    if (d.type === "ARM_DL") window.__EXT_DL_ARMED__ = true;
  });

  const post = (data) => {
    if (!window.__EXT_DL_ARMED__) return; // only when armed
    window.__EXT_DL_ARMED__ = false;      // one-shot
    window.postMessage(Object.assign({ __extFlag__: true }, data), "*");
  };

  // Track blob URLs → turn them into data URLs when possible
  const urlToBlob = new Map();
  const origURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = origURL.call(this, obj);
    try { urlToBlob.set(url, obj); } catch {}
    return url;
  };

  // Intercept <a>.click()
  const aClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (...args) {
    try {
      const href = this.href || "";
      const hasDownloadAttr = this.getAttribute("download") != null;
      const looksImg = /^data:image\//i.test(href) || /^blob:/i.test(href) || /\.(png|jpe?g|webp)$/i.test(href);

      if ((hasDownloadAttr || looksImg) && window.__EXT_DL_ARMED__) {
        const b = urlToBlob.get(href);
        if (b) {
          const fr = new FileReader();
          fr.onload = () => {
            const type = (b.type || "").toLowerCase();
            const ext  = type.includes("jpeg") ? "jpg" : (type.includes("webp") ? "webp" : "png");
            post({ type: "EXT_DL_DATAURL", dataUrl: String(fr.result), ext });
          };
          fr.readAsDataURL(b);
        } else {
          post({ type: "EXT_DL_URL", url: href });
        }
        // Block site-initiated download; extension will download instead
        return;
      }
    } catch {}
    return aClick.apply(this, args);
  };

  // Intercept window.open()
  const wOpen = window.open;
  window.open = function (url, n, s) {
    try {
      if (typeof url === "string") {
        const looksImg = /^data:image\//i.test(url) || /^blob:/i.test(url) || /\.(png|jpe?g|webp)$/i.test(url);
        if (looksImg && window.__EXT_DL_ARMED__) {
          post({ type: "EXT_DL_URL", url });
          // Block site-initiated open; extension will download instead
          return null;
        }
      }
    } catch {}
    return wOpen.call(this, url, n, s);
  };
})();
