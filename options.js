// options.js
(async function () {
  const $ = (id) => document.getElementById(id);
  const elGlobal  = $("globalId");
  const elStyle   = $("styleModule");
  const elOutput  = $("outputSuffix");
  const elSaved   = $("saved");
  const elSave    = $("saveBtn");

  async function load() {
    const { runner_options } = await chrome.storage.sync.get("runner_options");
    if (runner_options) {
      elGlobal.value = runner_options.globalId || "";
      elStyle.value  = runner_options.styleModule || "";
      elOutput.value = runner_options.outputSuffix || " [OUTPUT] High resolution, aspect ratio 3:2, single-frame composition, no collage.";
    }
  }
  async function save() {
    const obj = {
      globalId: elGlobal.value || "",
      styleModule: elStyle.value || "",
      outputSuffix: elOutput.value || ""
    };
    await chrome.storage.sync.set({ runner_options: obj });
    elSaved.style.display = "inline";
    setTimeout(() => { elSaved.style.display = "none"; }, 1500);
  }

  elSave.addEventListener("click", save);
  await load();
})();
