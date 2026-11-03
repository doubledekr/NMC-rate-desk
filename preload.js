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
  open: (url) => ipcRenderer.invoke("shell:open", url),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  openReleases: () => ipcRenderer.invoke("update:openReleases"),
  onUpdateStatus: (fn) => ipcRenderer.on("update:status", (e, s) => fn(s)),
});
