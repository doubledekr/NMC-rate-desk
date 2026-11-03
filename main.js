/* NMC Rate Desk — desktop shell.
   Publishes rates/rates.json and rates/history.json to the GitHub repo through the Contents API, then pings the
   relay so every NMC Toolkit wakes up at once. The publishing token is encrypted with the OS keychain (safeStorage)
   and kept in the app's data folder; it never leaves this machine and survives app updates. */
const { app, BrowserWindow, ipcMain, shell, safeStorage, Menu } = require("electron");
const fs = require("fs"), path = require("path");

const REPO = { owner: "doubledekr", repo: "nmc-rate-desk", branch: "main" };
const RELEASES_URL = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest`;
const DATA = () => { const d = app.getPath("userData"); fs.mkdirSync(d, { recursive: true }); return d; };
const SETTINGS_FILE = () => path.join(DATA(), "rate-desk-settings.json");
const TOKEN_FILE = () => path.join(DATA(), "publish-token.bin");

/* ---- settings (plain JSON, nothing secret in here) ---- */
function readSettings(){ try { return JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")); } catch (e) { return {}; } }
function writeSettings(s){ try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2)); } catch (e) {} }
function settings(){ const s = readSettings(); let changed = false;
  if (!s.pingTopic) { s.pingTopic = "nmc-rates-" + [...Array(20)].map(() => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join(""); changed = true; }
  if (!s.pingServer) { s.pingServer = "https://ntfy.sh"; changed = true; }
  if (!s.publisher) { s.publisher = "Rate Desk"; changed = true; }
  if (changed) writeSettings(s); return s; }
ipcMain.handle("settings:get", () => settings());
ipcMain.handle("settings:set", (e, patch) => { const s = Object.assign(settings(), patch || {}); writeSettings(s); return s; });

/* ---- the publishing token: encrypted at rest, decrypted only to make a request ---- */
function tokenGet(){ try { const buf = fs.readFileSync(TOKEN_FILE()); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString("utf8"); } catch (e) { return ""; } }
function tokenSet(t){ t = String(t || "").trim(); if (!t) { try { fs.unlinkSync(TOKEN_FILE()); } catch (e) {} return; }
  fs.writeFileSync(TOKEN_FILE(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : Buffer.from(t, "utf8")); }
ipcMain.handle("token:has", () => !!tokenGet());
ipcMain.handle("token:set", (e, t) => { tokenSet(t); return !!tokenGet(); });
ipcMain.handle("token:clear", () => { tokenSet(""); return true; });

/* ---- GitHub ---- */
const API = "https://api.github.com";
async function gh(method, url, body, token){ const t = token == null ? tokenGet() : token; if (!t) throw new Error("No publishing token — paste it in Settings");
  const r = await fetch(API + url, { method, headers: { "Authorization": "Bearer " + t, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "NMC-Rate-Desk/" + app.getVersion(), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok) { const msg = j && j.message ? j.message : (r.status + " " + r.statusText); const e = new Error(r.status === 401 ? "GitHub rejected the token (expired or wrong) — " + msg : r.status === 403 ? "The token can’t write to this repo — " + msg : r.status === 404 ? "Repo or file not found — " + msg : msg); e.status = r.status; throw e; }
  return j; }
const b64 = s => Buffer.from(s, "utf8").toString("base64");
const unb64 = s => Buffer.from(String(s || "").replace(/\n/g, ""), "base64").toString("utf8");
async function getFile(p){ try { const j = await gh("GET", `/repos/${REPO.owner}/${REPO.repo}/contents/${p}?ref=${REPO.branch}`); return { sha: j.sha, text: unb64(j.content) }; } catch (e) { if (e.status === 404) return { sha: null, text: null }; throw e; } }
async function putFile(p, text, message, sha){ return gh("PUT", `/repos/${REPO.owner}/${REPO.repo}/contents/${p}`, { message, content: b64(text), branch: REPO.branch, ...(sha ? { sha } : {}) }); }

ipcMain.handle("github:verify", async (e, token) => { try { const r = await gh("GET", `/repos/${REPO.owner}/${REPO.repo}`, null, token); return { ok: true, repo: r.full_name, permissions: r.permissions || null }; } catch (err) { return { ok: false, error: String(err.message || err) }; } });
ipcMain.handle("github:live", async () => { try { const f = await getFile("rates/rates.json"); return f.text ? JSON.parse(f.text) : null; } catch (e) { return { error: String(e.message || e) }; } });
ipcMain.handle("github:history", async () => { try { const f = await getFile("rates/history.json"); return f.text ? JSON.parse(f.text) : []; } catch (e) { return { error: String(e.message || e) }; } });

/* publish: one commit for rates.json, one for history.json (both tiny); then the ping. Returns the commit link. */
ipcMain.handle("github:publish", async (e, payload) => {
  const s = settings(); const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const rates = { version: now, published: now, by: payload.by || s.publisher || "Rate Desk", note: String(payload.note || "").trim(), ping: { server: s.pingServer, topic: s.pingTopic }, products: payload.products };
  const label = Object.entries(rates.products).map(([k, p]) => `${p.label || k} 680+ ${p.tiers["680+"]}%`).join(", ");
  const msg = `Rates ${now.slice(0, 16).replace("T", " ")} UTC — ${label}`;
  const cur = await getFile("rates/rates.json"); const r1 = await putFile("rates/rates.json", JSON.stringify(rates, null, 2) + "\n", msg, cur.sha);
  const hist = await getFile("rates/history.json"); let list = []; try { list = hist.text ? JSON.parse(hist.text) : []; } catch (x) { list = []; }
  const cutoff = Date.now() - 90 * 86400000; list = [rates].concat(list.filter(x => x && x.published && Date.parse(x.published) > cutoff)).slice(0, 2000);
  await putFile("rates/history.json", JSON.stringify(list) + "\n", msg + " (history)", hist.sha);
  let pinged = false; try { const p = await fetch(`${s.pingServer.replace(/\/+$/, "")}/${s.pingTopic}`, { method: "POST", headers: { "Title": "NMC rates", "Tags": "chart_with_downwards_trend", "Priority": "3" }, body: JSON.stringify({ kind: "rates", version: now }) }); pinged = p.ok; } catch (x) {}
  return { ok: true, version: now, commit: r1 && r1.commit ? r1.commit.html_url : null, pinged, rates }; });
ipcMain.handle("ping:test", async () => { const s = settings(); try { const p = await fetch(`${s.pingServer.replace(/\/+$/, "")}/${s.pingTopic}`, { method: "POST", headers: { "Title": "NMC rates (test)" }, body: JSON.stringify({ kind: "test", at: new Date().toISOString() }) }); return p.ok; } catch (x) { return false; } });

/* ---- updates: same pattern as the toolkit ---- */
let updater = null, mainWin = null, pendingVersion = null;
function setupUpdates(){ if (process.env.NMC_NO_UPDATES) return;
  try { updater = require("electron-updater").autoUpdater; } catch (e) { return; }
  updater.autoDownload = process.platform !== "darwin"; updater.autoInstallOnAppQuit = true; updater.allowDowngrade = false; updater.allowPrerelease = false;
  updater.on("error", () => { if (pendingVersion && mainWin) mainWin.webContents.send("update:status", { state: "manual", version: pendingVersion, url: RELEASES_URL }); });
  updater.on("update-available", info => { pendingVersion = info.version; if (mainWin) mainWin.webContents.send("update:status", process.platform === "darwin" ? { state: "manual", version: info.version, url: RELEASES_URL } : { state: "downloading", version: info.version }); });
  updater.on("update-downloaded", info => { if (mainWin) mainWin.webContents.send("update:status", { state: "ready", version: info.version }); });
  setTimeout(() => updater.checkForUpdates().catch(() => {}), 8000); setInterval(() => updater.checkForUpdates().catch(() => {}), 5 * 60 * 1000); }
ipcMain.handle("update:install", () => { if (!updater) return false; setTimeout(() => updater.quitAndInstall(false, true), 300); return true; });
ipcMain.handle("update:openReleases", () => { shell.openExternal(RELEASES_URL); return true; });
ipcMain.on("app:versionSync", e => { e.returnValue = app.getVersion(); });
ipcMain.handle("shell:open", (e, url) => { if (/^https:\/\//.test(String(url))) shell.openExternal(url); return true; });

function createWindow(){
  const win = mainWin = new BrowserWindow({ width: 1080, height: 820, minWidth: 820, minHeight: 600, title: "NMC Rate Desk " + app.getVersion(), backgroundColor: "#FBF8F2", icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  win.loadFile(path.join(__dirname, "app", "index.html"));
  win.webContents.on("context-menu", (e, p) => { const items = []; if (p.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }); else if (p.selectionText) items.push({ role: "copy" }); if (items.length) Menu.buildFromTemplate(items).popup(); });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  return win; }
app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); setupUpdates(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
