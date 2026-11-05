/* NMC Rate Desk — desktop shell.
   Publishes rates/rates.json and rates/history.json to the GitHub repo through the Contents API, then pings the
   relay so every NMC Toolkit wakes up at once. The publishing token is encrypted with the OS keychain (safeStorage)
   and kept in the app's data folder; it never leaves this machine and survives app updates. */
const { app, BrowserWindow, ipcMain, shell, safeStorage, Menu, net } = require("electron");
const MK = require("./app/market.js");
const fs = require("fs"), path = require("path");

const REPO = { owner: "doubledekr", repo: "nmc-rate-desk", branch: "main" };
/* The shape of rates.json is a contract with the NMC Toolkit — see CONTRACT.md. Bump RATES_FORMAT only for a change the toolkit
   can't read (a renamed or removed field); adding fields or products never needs a bump. Toolkits ignore a format newer than they know. */
const RATES_FORMAT = 2;
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
  /* Credit tiers are 640+ / 620-639 / 580-619 / <580 (v1.1). Until every NMC Toolkit reads the new names, each publish
     also carries the old 7 tier names filled from the new ones, so older toolkits keep flagging eligible clients. */
  const LEGACY_FROM = { "680+": "640+", "660-679": "640+", "640-659": "640+", "600-619": "580-619", "580-599": "580-619" };
  Object.values(payload.products || {}).forEach(p => { if (!p || !p.tiers || p.tiers["640+"] == null) return;
    Object.entries(LEGACY_FROM).forEach(([old, nu]) => { if (p.tiers[old] == null) p.tiers[old] = p.tiers[nu]; }); });
  const s = settings(); const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const rates = { format: RATES_FORMAT, version: now, published: now, by: payload.by || s.publisher || "Rate Desk", note: String(payload.note || "").trim(), ping: { server: s.pingServer, topic: s.pingTopic }, products: payload.products, ...(payload.market ? { market: payload.market } : {}) };
  const label = Object.entries(rates.products).map(([k, p]) => `${p.label || k} 640+ ${p.tiers["640+"]}%`).join(", ");
  const msg = `Rates ${now.slice(0, 16).replace("T", " ")} UTC — ${label}`;
  const cur = await getFile("rates/rates.json"); const r1 = await putFile("rates/rates.json", JSON.stringify(rates, null, 2) + "\n", msg, cur.sha);
  const hist = await getFile("rates/history.json"); let list = []; try { list = hist.text ? JSON.parse(hist.text) : []; } catch (x) { list = []; }
  const cutoff = Date.now() - 90 * 86400000; list = [rates].concat(list.filter(x => x && x.published && Date.parse(x.published) > cutoff)).slice(0, 2000);
  await putFile("rates/history.json", JSON.stringify(list) + "\n", msg + " (history)", hist.sha);
  let pinged = false; try { const p = await fetch(`${s.pingServer.replace(/\/+$/, "")}/${s.pingTopic}`, { method: "POST", headers: { "Title": "NMC rates", "Tags": "chart_with_downwards_trend", "Priority": "3" }, body: JSON.stringify({ kind: "rates", version: now }) }); pinged = p.ok; } catch (x) {}
  return { ok: true, version: now, commit: r1 && r1.commit ? r1.commit.html_url : null, pinged, rates }; });
ipcMain.handle("ping:test", async () => { const s = settings(); try { const p = await fetch(`${s.pingServer.replace(/\/+$/, "")}/${s.pingTopic}`, { method: "POST", headers: { "Title": "NMC rates (test)" }, body: JSON.stringify({ kind: "test", at: new Date().toISOString() }) }); return p.ok; } catch (x) { return false; } });

/* ---- market data: 10-yr Treasury, headlines, release calendar ----
   Read-only public sources, fetched from this computer. Cached to disk so the panel still shows the last good data offline.
   Nothing here is published to the toolkits. */
const MARKET_FILE = () => path.join(DATA(), "market-cache.json");
let marketCache = null, marketBusy = null;
function readMarketCache(){ if (marketCache) return marketCache; try { marketCache = JSON.parse(fs.readFileSync(MARKET_FILE(), "utf8")); } catch (e) { marketCache = null; } return marketCache; }
async function getText(url){ const r = await net.fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) NMC-Rate-Desk/" + app.getVersion(), "Accept": "*/*" } });
  if (!r.ok) throw new Error(r.status + " " + r.statusText); return r.text(); }
async function loadMarket(){ const prev = readMarketCache() || {}; const errors = [];
  const tre = await Promise.allSettled(MK.treasuryUrls(Date.now()).map(getText));
  let series = MK.mergeSeries(...tre.filter(x => x.status === "fulfilled").map(x => MK.parseTreasuryXML(x.value))), source = "U.S. Treasury";
  if (series.length < 11) { try { const fred = MK.parseFredCSV(await getText(MK.FRED_URL)); if (fred.length) { series = MK.mergeSeries(fred.slice(-60), series); source = series.length ? "FRED / Treasury" : source; } } catch (e) { errors.push("10-yr: " + e.message); } }
  if (!series.length && prev.series) { series = prev.series; source = prev.source; errors.push("10-yr: showing last saved data"); }
  const feeds = await Promise.allSettled(MK.FEEDS.map(f => getText(f.url).then(t => MK.parseFeed(t, f))));
  feeds.forEach((r, i) => { if (r.status !== "fulfilled") errors.push(MK.FEEDS[i].name + ": " + (r.reason && r.reason.message || "unavailable")); });
  /* headlines are archived on this computer (120 days) so the trends panel can show news on past dates */
  const fresh = MK.prepareHeadlines(feeds.filter(r => r.status === "fulfilled").map(r => r.value), 80);
  const headlines = MK.archiveHeadlines(prev.headlines, fresh, Date.now(), 120);
  let bls = [];
  try { bls = MK.parseICS(await getText(MK.BLS_ICS_URL)); } catch (e) { errors.push("BLS calendar: " + e.message); bls = (prev.events || []).filter(e => e.source === "BLS"); }
  const events = MK.eventsWindow(bls.concat(MK.fomcEvents()), Date.now(), 120, 60);
  marketCache = { fetchedAt: new Date().toISOString(), series: series.slice(-80), source, headlines, events, errors };
  try { fs.writeFileSync(MARKET_FILE(), JSON.stringify(marketCache)); } catch (e) {}
  return marketCache; }
ipcMain.handle("market:get", async (e, force) => { const c = readMarketCache();
  if (!force && c && Date.now() - Date.parse(c.fetchedAt) < 10 * 60 * 1000) return c;
  if (!marketBusy) marketBusy = loadMarket().finally(() => { marketBusy = null; });
  try { return await marketBusy; } catch (err) { return Object.assign({}, c || {}, { errors: ["Market data: " + (err.message || err)] }); } });

/* live quotes: one small request per symbol; a symbol that fails is simply missing */
let liveCache = null, liveBusy = null;
ipcMain.handle("market:live", async (e, force) => {
  if (!force && liveCache && Date.now() - liveCache.t < 60 * 1000) return liveCache.data;
  if (!liveBusy) liveBusy = (async () => { const out = { at: new Date().toISOString(), quotes: {}, errors: [] };
    const res = await Promise.allSettled(MK.METRICS.map(m => getText(MK.yahooUrl(m.sym)).then(t => MK.parseYahooChart(JSON.parse(t)))));
    res.forEach((r, i) => { const m = MK.METRICS[i]; if (r.status === "fulfilled" && r.value) out.quotes[m.key] = r.value; else out.errors.push(m.label + ": " + (r.reason && r.reason.message || "no data")); });
    liveCache = { t: Date.now(), data: out }; return out; })().finally(() => { liveBusy = null; });
  return liveBusy; });

/* market notes: 10-yr moves, briefs and the lean, sent to bankers without touching rates.json (so no rate banner, no eligibility change).
   Written to rates/market.json + rates/market-history.json; the ping carries kind "market". See CONTRACT.md. */
const MARKET_FORMAT = 1;
ipcMain.handle("github:marketNote", async (e, payload) => {
  const s = settings(); const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const note = { format: MARKET_FORMAT, id: now, at: now, by: payload.by || s.publisher || "Rate Desk", kind: String(payload.kind || "note"),
    title: String(payload.title || "").slice(0, 80), text: String(payload.text || "").trim().slice(0, 280),
    ...(String(payload.comment || "").trim() ? { comment: String(payload.comment).trim().slice(0, 200) } : {}),
    tenYear: payload.tenYear || null, lean: payload.lean || null, ping: { server: s.pingServer, topic: s.pingTopic } };
  if (!note.text) throw new Error("The note is empty");
  const msg = `Market note ${now.slice(0, 16).replace("T", " ")} UTC — ${note.kind}: ${note.text.slice(0, 60)}`;
  const cur = await getFile("rates/market.json"); const r1 = await putFile("rates/market.json", JSON.stringify(note, null, 2) + "\n", msg, cur.sha);
  const hist = await getFile("rates/market-history.json"); let list = []; try { list = hist.text ? JSON.parse(hist.text) : []; } catch (x) { list = []; }
  const keep = Object.assign({}, note); delete keep.ping;
  list = [keep].concat(list.filter(x => x && x.at && Date.parse(x.at) > Date.now() - 30 * 86400000)).slice(0, 300);
  await putFile("rates/market-history.json", JSON.stringify(list) + "\n", msg + " (history)", hist.sha);
  let pinged = false; try { const p = await fetch(`${s.pingServer.replace(/\/+$/, "")}/${s.pingTopic}`, { method: "POST", headers: { "Title": "NMC market note", "Priority": "3" }, body: JSON.stringify({ kind: "market", id: now }) }); pinged = p.ok; } catch (x) {}
  return { ok: true, id: now, commit: r1 && r1.commit ? r1.commit.html_url : null, pinged }; });
ipcMain.handle("github:marketHistory", async () => { try { const f = await getFile("rates/market-history.json"); return f.text ? JSON.parse(f.text) : []; } catch (e) { return []; } });

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
ipcMain.handle("app:attention", (e, n) => { try { app.setBadgeCount(n || 0); } catch (x) {} if (n && mainWin && !mainWin.isFocused()) mainWin.flashFrame(true); if (!n && mainWin) mainWin.flashFrame(false); return true; });
ipcMain.handle("shell:open", (e, url) => { if (/^https:\/\//.test(String(url))) shell.openExternal(url); return true; });

function createWindow(){
  /* Our own title band instead of the stock one (same as Toolkit v1.17.0): the page draws a 38px strip and the OS keeps only its
     window buttons — Windows draws them top-right (title-bar overlay), macOS keeps its traffic lights top-left.
     Snap layouts, the system shadow and Windows 11's rounded corners still apply because this is still a normal window. */
  const mac = process.platform === "darwin";
  const win = mainWin = new BrowserWindow({ width: 1280, height: 880, minWidth: MIN_W, minHeight: MIN_H, title: "NMC Rate Desk " + app.getVersion(), backgroundColor: "#FBF8F2", icon: path.join(__dirname, "build", "icon.png"), show: false,
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    ...(mac ? { trafficLightPosition: { x: 14, y: 12 } } : { titleBarOverlay: { color: "#FBF8F2", symbolColor: "#2B2622", height: 38 } }),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  win.once("ready-to-show", () => win.show());                                     /* appears painted, never a white flash */
  win.loadFile(path.join(__dirname, "app", "index.html"));
  win.webContents.on("context-menu", (e, p) => { const items = []; if (p.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }); else if (p.selectionText) items.push({ role: "copy" }); if (items.length) Menu.buildFromTemplate(items).popup(); });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  return win; }
/* window floor: below this the two-column layout and the live strip start to crowd (checked at 1100x800 outer) */
const MIN_W = 1100, MIN_H = 800;
ipcMain.on("win:toggleMax", e => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return; if (process.platform === "darwin") { w.isFullScreen() ? w.setFullScreen(false) : (w.isMaximized() ? w.unmaximize() : w.maximize()); } else { w.isMaximized() ? w.unmaximize() : w.maximize(); } });
app.whenReady().then(() => { Menu.setApplicationMenu(null); createWindow(); setupUpdates(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
