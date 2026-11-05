const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("rateDesk", {
  version: () => ipcRenderer.sendSync("app:versionSync"),
  settings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  hasToken: () => ipcRenderer.invoke("token:has"),
  setToken: (t) => ipcRenderer.invoke("token:set", t),
  clearToken: () => ipcRenderer.invoke("token:clear"),
  verify: (t) => ipcRenderer.invoke("github:verify", t),
  live: () => ipcRenderer.invoke("github:live"),
  history: () => ipcRenderer.invoke("github:history"),
  publish: (payload) => ipcRenderer.invoke("github:publish", payload),
  pingTest: () => ipcRenderer.invoke("ping:test"),
  market: (force) => ipcRenderer.invoke("market:get", !!force),
  platform: process.platform,                                   /* "win32" | "darwin" — the page lays out the title band for each */
  titleBand: 38,                                                /* px the page reserves at the top for the window buttons */
  toggleMaximize: () => ipcRenderer.send("win:toggleMax"),       /* double-click on the band, like a title bar */
  quotes: (force) => ipcRenderer.invoke("market:live", !!force),
  marketNote: (payload) => ipcRenderer.invoke("github:marketNote", payload),
  marketHistory: () => ipcRenderer.invoke("github:marketHistory"),
  attention: (n) => ipcRenderer.invoke("app:attention", n),
  open: (url) => ipcRenderer.invoke("shell:open", url),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  openReleases: () => ipcRenderer.invoke("update:openReleases"),
  onUpdateStatus: (fn) => ipcRenderer.on("update:status", (e, s) => fn(s)),
});
