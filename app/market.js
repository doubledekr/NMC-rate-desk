/* NMC Rate Desk — market engine. Pure functions, no network, no DOM.
   Loaded by the main process (require) to parse feeds, and by the page (<script>) to compute the lean and the recap.

   Everything here describes what the market has done. Nothing here forecasts rates. */
(function (root) {
  "use strict";

  /* ---------------- sources (fetched by main.js) ---------------- */
  const FEEDS = [
    { id: "fed", name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
    { id: "fedspeech", name: "Fed speeches", url: "https://www.federalreserve.gov/feeds/speeches.xml" },
    { id: "mw", name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
    { id: "mwrt", name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines" },
  ];
  const yyyymm = d => d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0");
  function treasuryUrls(now) { const d = new Date(now || Date.now()); const months = [2, 1, 0].map(k => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)));
    return months.map(m => "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=" + yyyymm(m)); }
  const FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10";
  const BLS_ICS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
  /* FOMC decision days (statement at 2:00 PM ET on the second day), from federalreserve.gov. 2027 dates are tentative. */
  const FOMC = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
    "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08"];

  /* ---------------- small helpers ---------------- */
  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  function decode(s) { return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : m))
    .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); }
  const tag = (block, name) => { const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i")); return m ? decode(m[1]) : ""; };
  const bps = v => Math.round(v * 100);

  /* Eastern-time wall clock → epoch ms (handles daylight saving without a library). */
  function etToMs(y, mo, d, h, mi) { let guess = Date.UTC(y, mo - 1, d, h + 5, mi);
    for (let i = 0; i < 2; i++) { const p = etParts(guess); const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi); guess += Date.UTC(y, mo - 1, d, h, mi) - asUTC; }
    return guess; }
  function etParts(ms) { const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
    const o = {}; f.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, wd: o.weekday, key: `${o.year}-${o.month}-${o.day}` }; }
  const etDay = ms => etParts(ms).key;

  /* ---------------- 10-year Treasury ---------------- */
  function parseTreasuryXML(text) { const out = [];
    String(text || "").split(/<m:properties>/i).slice(1).forEach(b => { const d = (b.match(/<d:NEW_DATE[^>]*>([^<]+)</i) || [])[1]; const y = (b.match(/<d:BC_10YEAR[^>]*>([^<]+)</i) || [])[1];
      if (d && y && !isNaN(parseFloat(y))) out.push({ date: d.slice(0, 10), y: parseFloat(y) }); });
    return out; }
  function parseFredCSV(text) { return String(text || "").split(/\r?\n/).slice(1).map(l => l.split(",")).filter(r => r.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && !isNaN(parseFloat(r[1])))
    .map(r => ({ date: r[0], y: parseFloat(r[1]) })); }
  function mergeSeries(...lists) { const m = new Map(); lists.flat().forEach(p => { if (p && p.date && p.y != null) m.set(p.date, p.y); });
    return [...m.entries()].map(([date, y]) => ({ date, y })).sort((a, b) => a.date < b.date ? -1 : 1); }

  /* ---------------- headlines ---------------- */
  function parseFeed(text, feed) { const s = String(text || ""); const items = [];
    const blocks = s.match(/<item[\s>][\s\S]*?<\/item>/gi) || s.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    blocks.forEach(b => { const title = tag(b, "title"); if (!title) return;
      let link = tag(b, "link"); if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ""; }
      const when = tag(b, "pubDate") || tag(b, "updated") || tag(b, "published") || tag(b, "dc:date"); const t = Date.parse(when);
      items.push({ title, link: /^https?:\/\//.test(link) ? link : "", at: isNaN(t) ? null : new Date(t).toISOString(), source: feed ? feed.name : "", feed: feed ? feed.id : "", category: tag(b, "category") }); });
    return items; }

  const MACRO = /\b(fed|fomc|powell|federal reserve|central bank|rate cuts?|rate hikes?|interest rates?|inflation|cpi|pce|ppi|consumer prices|jobs report|jobs|payrolls?|jobless|unemployment|labor market|hiring|wages|treasur(y|ies)|yields?|bonds?|mortgages?|housing|home sales|home prices|gdp|recession|economy|economic|retail sales|consumer spending|shutdown|debt ceiling)\b/i;
  const FED_KEEP = /\b(fomc|monetary policy|minutes|beige book|projections|discount rate|statement|testimony|speech|remarks|economic|outlook|inflation|interest)\b/i;
  const FED_DROP = /\b(enforcement|application|approval of|termination|penalty|consent order|merger|acquisition|bancorp|bancshares|holding company)\b/i;
  function isRelevant(it) { const t = it.title || "";
    if (it.feed === "fed" || it.feed === "fedspeech") return it.feed === "fedspeech" || (FED_KEEP.test(t) && !FED_DROP.test(t)) || /monetary/i.test(it.category || "");
    return MACRO.test(t); }

  /* Rates read: "better" means pushes mortgage rates down; "worse" means pushes them up. Keyword rules, not judgment. */
  const INFL = /\b(inflation|cpi|pce|ppi|consumer prices|prices)\b/i, JOBS = /\b(jobs|payrolls?|hiring|labor market|employment|employers)\b/i;
  const RULES = [
    { re: /\b(no|rules? out|ruled out|pushes? back on|delays?|fewer|pause[sd]?|skip)\b.{0,30}\brate cuts?\b|\bhigher for longer\b|\bhawkish\b|\b(stay|remain|keep\w*) restrictive\b|\bprogress (has |on inflation )?(slowed|stalled)\b|\brate hikes?\b|\bhikes? rates\b|\braises? rates\b/i, tag: "worse", why: "Fed leaning tighter tends to push rates up", final: true },
    { re: /\brate cuts?\b|\bcuts? (interest )?rates\b|\blowers? rates\b|\bdovish\b|\beas(e|es|ing) policy\b/i, tag: "better", why: "Fed easing tends to pull rates down" },
    { re: /\b(yields?|treasur(y|ies))\b.{0,25}\b(fall|falls|fell|drop|drops|dropped|slide|slides|slip|slips|sink|sinks|tumble|tumbles|retreat|retreats|decline|declines|lower|ease|eases)\b|\bbonds? rall(y|ies)\b|\btreasur(y|ies) rall(y|ies)\b/i, tag: "better", why: "Falling yields usually mean better mortgage rates" },
    { re: /\b(yields?|treasur(y|ies))\b.{0,25}\b(rise|rises|rose|climb|climbs|jump|jumps|surge|surges|spike|spikes|soar|soars|higher|top|tops|hit|hits)\b|\bbond sell-?off\b|\bbonds? (slide|slump|sell off)\b/i, tag: "worse", why: "Rising yields usually mean worse mortgage rates" },
    { test: t => INFL.test(t) && /\b(cool|cools|cooler|cooling|soft|softer|eases?|easing|slows?|slowed|slowing|slower|tame|moderat\w*|below (forecast|expectations)|lower than expected|falls?|fell|declines?)\b/i.test(t), tag: "better", why: "Cooler inflation tends to pull rates down" },
    { test: t => INFL.test(t) && /\b(hot|hotter|accelerat\w*|surges?|jumps?|rises?|rose|climbs?|sticky|heats? up|above (forecast|expectations)|higher than expected|firm|firmer)\b/i.test(t), tag: "worse", why: "Hotter inflation tends to push rates up" },
    { re: /\b(jobless claims|unemployment( rate)?)\b.{0,20}\b(rise|rises|rose|jump|jumps|climb|climbs|ticks? up|increase[sd]?)\b|\blayoffs?\b|\brecession\b|\bslowdown\b|\bcontraction\b|\bshrinks?\b/i, tag: "better", why: "Signs of a slowing economy tend to pull rates down" },
    { test: t => JOBS.test(t) && /\b(weak|weaker|miss(es|ed)?|disappoint\w*|slump\w*|fewer|slows?|slowed|cool\w*|lowest)\b/i.test(t), tag: "better", why: "A softer job market tends to pull rates down" },
    { test: t => JOBS.test(t) && /\b(strong|stronger|beats?|surges?|jumps?|robust|blowout|solid|hot|more than expected)\b/i.test(t), tag: "worse", why: "A strong job market tends to push rates up" },
  ];
  function tagHeadline(title) { const t = String(title || ""); const hits = [];
    for (const r of RULES) { if (r.re ? r.re.test(t) : r.test(t)) { if (r.final) return { tag: r.tag, why: r.why }; hits.push(r); } }
    if (!hits.length) return { tag: "neutral", why: "" };
    const first = hits[0]; if (hits.some(h => h.tag !== first.tag)) return { tag: "neutral", why: "Mixed signals" };
    return { tag: first.tag, why: first.why }; }
  function prepareHeadlines(lists, limit) { const seen = new Set(); const out = [];
    lists.flat().filter(isRelevant).forEach(it => { const k = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); if (seen.has(k)) return; seen.add(k); out.push(Object.assign({}, it, tagHeadline(it.title))); });
    return out.sort((a, b) => (b.at || "") < (a.at || "") ? -1 : 1).slice(0, limit || 40); }

  /* ---------------- calendar ---------------- */
  const BIG = [
    { re: /^employment situation/i, name: "Jobs report" },
    { re: /^consumer price index/i, name: "CPI" },
    { re: /^producer price index/i, name: "PPI" },
    { re: /^job openings and labor turnover/i, name: "JOLTS job openings" },
    { re: /^employment cost index/i, name: "Employment Cost Index" },
  ];
  function parseICS(text) { const out = [];
    String(text || "").replace(/\r?\n[ \t]/g, "").split(/BEGIN:VEVENT/).slice(1).forEach(b => { const sum = ((b.match(/\nSUMMARY:(.*)/) || [])[1] || "").replace(/\\,/g, ",").trim();
      const dt = (b.match(/\nDTSTART[^:\n]*:(\d{8})T?(\d{4})?/) || []); if (!sum || !dt[1]) return;
      const big = BIG.find(x => x.re.test(sum)); if (!big) return;
      const y = +dt[1].slice(0, 4), mo = +dt[1].slice(4, 6), d = +dt[1].slice(6, 8), hh = dt[2] ? +dt[2].slice(0, 2) : 8, mi = dt[2] ? +dt[2].slice(2, 4) : 30;
      out.push({ name: big.name, at: new Date(etToMs(y, mo, d, hh, mi)).toISOString(), source: "BLS" }); });
    return out; }
  function fomcEvents() { return FOMC.map(d => { const [y, mo, dd] = d.split("-").map(Number); return { name: "Fed decision", at: new Date(etToMs(y, mo, dd, 14, 0)).toISOString(), source: "Federal Reserve" }; }); }
  function upcoming(events, now, days) { const n = now || Date.now(), end = n + (days || 14) * 86400000; const seen = new Set();
    return events.filter(e => { const t = Date.parse(e.at); const k = e.name + e.at; if (seen.has(k) || t < n - 3600000 || t > end) return false; seen.add(k); return true; })
      .sort((a, b) => a.at < b.at ? -1 : 1); }
  function whenLabel(iso, now) { const t = Date.parse(iso), n = now || Date.now(); const p = etParts(t);
    const time = new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
    const today = etDay(n), tomorrow = etDay(n + 86400000);
    const day = p.key === today ? "today" : p.key === tomorrow ? "tomorrow" : new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
    return day + " " + time; }

  /* ---------------- the lean ---------------- */
  function lean(series, headlines, events, now) { const n = now || Date.now(); const s = (series || []).filter(p => p && p.y != null);
    const res = { state: "unknown", label: "Not enough data", strength: "", line: "", tilt: "", warn: "", last: null };
    if (s.length) res.last = s[s.length - 1];
    if (s.length >= 6) {
      const last = s[s.length - 1].y, d5 = last - s[s.length - 6].y, d10 = s.length >= 11 ? last - s[s.length - 11].y : null;
      let down = 0; for (let i = s.length - 5; i < s.length; i++) if (s[i].y < s[i - 1].y - 1e-9) down++;
      const b5 = bps(d5), b10 = d10 == null ? null : bps(d10);
      if (Math.abs(b5) < 4 && (b10 == null || Math.abs(b10) < 6)) { res.state = "steady"; res.label = "Steady"; }
      else if (b10 != null && Math.abs(b5) >= 4 && Math.abs(b10) >= 4 && Math.sign(b5) !== Math.sign(b10)) { res.state = "choppy"; res.label = "Choppy"; }
      else { const dir = Math.abs(b5) >= 4 ? Math.sign(b5) : Math.sign(b10); res.state = dir < 0 ? "improving" : "worsening"; res.label = dir < 0 ? "Improving" : "Worsening";
        res.strength = Math.abs(b5) >= 10 && (b10 == null || Math.sign(b10) === Math.sign(b5)) ? "strong" : "mild"; }
      res.line = `10-yr down ${down} of the last 5 days, ${b5 > 0 ? "+" : b5 < 0 ? "−" : "±"}${Math.abs(b5)} bps over 5 days` + (b10 != null ? `, ${b10 > 0 ? "+" : b10 < 0 ? "−" : "±"}${Math.abs(b10)} over 10` : "");
      res.d5 = b5; res.d10 = b10; res.down = down;
    }
    const recent = (headlines || []).filter(h => h.at && Date.parse(h.at) > n - 36 * 3600000);
    const good = recent.filter(h => h.tag === "better").length, bad = recent.filter(h => h.tag === "worse").length;
    if (good + bad) res.tilt = good > bad ? `Headlines tilt better (${good} vs ${bad})` : bad > good ? `Headlines tilt worse (${bad} vs ${good})` : `Headlines mixed (${good} vs ${bad})`;
    if ((res.state === "steady" || res.state === "unknown") && Math.abs(good - bad) >= 2) { res.label = good > bad ? "Leaning better" : "Leaning worse"; res.state = good > bad ? "improving" : "worsening"; res.strength = "headlines"; }
    const next = upcoming(events || [], n, 2).find(e => Date.parse(e.at) > n);
    if (next && Date.parse(next.at) - n < 36 * 3600000) res.warn = `${next.name} ${whenLabel(next.at, n)} — lean could flip`;
    return res; }

  /* ---------------- morning recap (fits the 140-character note) ---------------- */
  function recap(series, ln, events, headlines, now) { const n = now || Date.now(); const s = (series || []).filter(p => p && p.y != null); const parts = [];
    if (s.length >= 2) { const a = s[s.length - 1], b = s[s.length - 2], d = bps(a.y - b.y); parts.push(`10-yr ${a.y.toFixed(2)}% (${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)} bps)`); }
    if (ln && ln.state !== "unknown") parts.push(`Lean: ${ln.label.toLowerCase()}`);
    const today = upcoming(events || [], n, 1).filter(e => etDay(Date.parse(e.at)) === etDay(n));
    if (today.length) parts.push(today.map(e => `${e.name} ${new Date(e.at).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })}`).join(", ") + " today");
    let out = parts.join(" · ");
    const top = (headlines || []).find(h => h.tag !== "neutral" && h.at && Date.parse(h.at) > n - 24 * 3600000);
    if (top && out.length + top.title.length + 3 <= 140) out += " · " + top.title;
    return out.length > 140 ? out.slice(0, 139) + "…" : out; }

  /* ---------------- publish timer + streak ---------------- */
  function publishPace(history, now) { const n = now || Date.now(); const pubs = (history || []).map(h => Date.parse(h && h.published)).filter(t => !isNaN(t)).sort((a, b) => b - a);
    const res = { lastAt: pubs[0] || null, ageMin: pubs[0] ? Math.round((n - pubs[0]) / 60000) : null, today: 0, streak: 0, stale: false };
    const days = new Set(pubs.map(etDay)); res.today = pubs.filter(t => etDay(t) === etDay(n)).length;
    /* streak = consecutive weekdays with a publish, counting back from today (today may still be pending) */
    let d = n, first = true, guard = 0;
    while (guard++ < 400) { const p = etParts(d); const wk = p.wd === "Sat" || p.wd === "Sun";
      if (!wk) { if (days.has(p.key)) res.streak++; else if (!first) break; first = false; }
      d -= 86400000; }
    const p = etParts(n); const market = !(p.wd === "Sat" || p.wd === "Sun") && p.h >= 9 && p.h < 18;
    res.stale = market && (res.ageMin == null || res.ageMin > 180);
    return res; }
  function ago(min) { if (min == null) return "never"; if (min < 1) return "just now"; if (min < 60) return min + "m ago"; const h = Math.floor(min / 60); if (h < 24) return h + "h " + (min % 60) + "m ago"; const d = Math.floor(h / 24); return d + (d === 1 ? " day ago" : " days ago"); }

  /* ---------------- live quotes (Yahoo chart endpoint; unofficial, so everything degrades quietly) ---------------- */
  const METRICS = [
    { sym: "^TNX", key: "ten", label: "10-yr Treasury", kind: "yield", good: "down" },
    { sym: "^FVX", key: "five", label: "5-yr Treasury", kind: "yield", good: "down" },
    { sym: "^TYX", key: "thirty", label: "30-yr Treasury", kind: "yield", good: "down" },
    { sym: "MBB", key: "mbs", label: "MBS (MBB ETF)", kind: "price", good: "up" },
    { sym: "^GSPC", key: "spx", label: "S&P 500", kind: "price", good: "" },
    { sym: "CL=F", key: "oil", label: "Oil (WTI)", kind: "price", good: "" },
    { sym: "DX-Y.NYB", key: "usd", label: "Dollar index", kind: "price", good: "" },
  ];
  const yahooUrl = sym => "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?range=1d&interval=5m&includePrePost=false";
  function parseYahooChart(json) { const r = json && json.chart && json.chart.result && json.chart.result[0]; if (!r || !r.meta) return null; const m = r.meta;
    const ts = r.timestamp || [], q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {}; const closes = q.close || [];
    const points = ts.map((t, i) => ({ t: t * 1000, v: closes[i] })).filter(p => p.v != null && !isNaN(p.v));
    let price = m.regularMarketPrice; if (price == null && points.length) price = points[points.length - 1].v; if (price == null || isNaN(price)) return null;
    const prev = m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose;
    const vals = points.map(p => p.v);
    return { price: +price, prevClose: prev != null ? +prev : null, time: m.regularMarketTime ? m.regularMarketTime * 1000 : (points.length ? points[points.length - 1].t : null),
      open: points.length ? points[0].v : null, high: vals.length ? Math.max(...vals) : (m.regularMarketDayHigh || null), low: vals.length ? Math.min(...vals) : (m.regularMarketDayLow || null), points: points.slice(-120) }; }
  function metricChange(metric, q) { if (!q || q.prevClose == null) return null;
    if (metric.kind === "yield") { const b = Math.round((q.price - q.prevClose) * 100); return { value: b, text: (b > 0 ? "+" : b < 0 ? "−" : "±") + Math.abs(b) + " bps", sign: Math.sign(b) }; }
    const pc = (q.price - q.prevClose) / q.prevClose * 100; const r = Math.round(pc * 100) / 100; return { value: r, text: (r > 0 ? "+" : r < 0 ? "−" : "±") + Math.abs(r).toFixed(2) + "%", sign: Math.sign(r) }; }
  function metricTone(metric, chg) { if (!chg || !metric.good || !chg.sign) return "flat"; return (metric.good === "down") === (chg.sign < 0) ? "better" : "worse"; }
  function fmtMetric(metric, v) { if (v == null) return "—"; return metric.kind === "yield" ? v.toFixed(3).replace(/0$/, "") + "%" : metric.key === "spx" ? Math.round(v).toLocaleString("en-US") : v.toFixed(2); }
  /* The daily series plus today's live 10-yr as a provisional last point, so the lean reacts during the day. */
  function withLive(series, ten, now) { const s = (series || []).slice(); if (!ten || ten.price == null) return s; const key = etDay(ten.time || now || Date.now());
    if (s.length && s[s.length - 1].date >= key) return s; s.push({ date: key, y: +ten.price.toFixed(3), live: true }); return s; }

  /* ---------------- 10-yr move alerts ---------------- */
  /* ref = {y, at, why}: the level bankers last heard about (last market note today) or yesterday's close. */
  function moveCheck(ten, ref, threshold) { if (!ten || ten.price == null || !ref || ref.y == null) return null; const b = Math.round((ten.price - ref.y) * 100);
    return { bps: b, crossed: Math.abs(b) >= (threshold || 5), dir: b > 0 ? "up" : "down", from: ref.y, to: ten.price, since: ref.at, why: ref.why }; }
  const etTime = ms => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
  function moveNote(mv, ratesNote) { if (!mv) return ""; const since = mv.why === "close" ? "since yesterday's close" : mv.since ? "since " + etTime(Date.parse(mv.since)) : "";
    return `10-yr ${mv.dir} ${Math.abs(mv.bps)} bps to ${mv.to.toFixed(2)}% ${since}`.trim() + ". " + (ratesNote || (mv.dir === "up" ? "Rates unchanged for now — could worsen if this holds." : "Rates unchanged for now — could improve if this holds.")); }

  /* ---------------- briefs ---------------- */
  const sgn = b => (b > 0 ? "+" : b < 0 ? "−" : "±") + Math.abs(b);
  function rateLine(history, now) { const n = now || Date.now(); const pubs = (history || []).filter(h => h && h.published && h.products && h.products.va_irrrl);
    const get = h => { const t = h.products.va_irrrl.tiers || {}; return t["640+"] != null ? t["640+"] : t["680+"]; };
    if (!pubs.length) return { text: "No rates published yet.", cur: null };
    const cur = get(pubs[0]); const today = etDay(n);
    const before = pubs.find(h => etDay(Date.parse(h.published)) < today); const prev = before ? get(before) : null; const todayCount = pubs.filter(h => etDay(Date.parse(h.published)) === today).length;
    let txt = `VA Streamline 640+ ${(+cur).toFixed(3).replace(/0$/, "")}%`;
    if (prev != null) { const d = Math.round((cur - prev) * 1000) / 1000; txt += d === 0 ? " (unchanged vs yesterday)" : ` (${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(3).replace(/0$/, "")} vs yesterday)`; }
    return { text: txt, cur, prev, todayCount }; }
  function brief(kind, ctx) { const n = ctx.now || Date.now(); const s = (ctx.series || []).filter(p => p && p.y != null && !p.live); const L = ctx.live || {}; const ten = L.ten;
    const ln = ctx.lean || lean(withLive(s, ten, n), ctx.headlines, ctx.events, n); const lines = []; const dayName = new Date(n).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" });
    const last = s[s.length - 1], prev = s[s.length - 2]; const d1 = last && prev ? Math.round((last.y - prev.y) * 100) : null;
    const d5 = s.length >= 6 ? Math.round((last.y - s[s.length - 6].y) * 100) : null, d10 = s.length >= 11 ? Math.round((last.y - s[s.length - 11].y) * 100) : null;
    const tenDay = ten && ten.prevClose != null ? Math.round((ten.price - ten.prevClose) * 100) : null;
    const mbs = L.mbs && L.mbs.prevClose ? (L.mbs.price - L.mbs.prevClose) / L.mbs.prevClose * 100 : null; const mbsTxt = mbs == null ? "" : `MBS ${mbs >= 0 ? "+" : "−"}${Math.abs(mbs).toFixed(2)}% (${mbs > 0.05 ? "helping rates" : mbs < -0.05 ? "hurting rates" : "flat"})`;
    const ev = upcoming(ctx.events || [], n, 2); const todayEv = ev.filter(e => etDay(Date.parse(e.at)) === etDay(n)); const tomEv = ev.filter(e => etDay(Date.parse(e.at)) === etDay(n + 86400000));
    const evTxt = list => list.map(e => `${e.name} ${etTime(Date.parse(e.at))}`).join(", ");
    const heads = (ctx.headlines || []).filter(h => h.tag !== "neutral" && h.at && Date.parse(h.at) > n - (kind === "morning" ? 18 : 8) * 3600000).slice(0, 2);
    const rl = rateLine(ctx.history, n); let title, short;
    if (kind === "morning") { title = "Morning brief · " + dayName;
      if (last) lines.push(`10-yr closed ${last.y.toFixed(2)}% last session${d1 != null ? ` (${sgn(d1)} bps)` : ""}${d5 != null ? `; ${sgn(d5)} bps over 5 days` : ""}${d10 != null ? `, ${sgn(d10)} over 10` : ""}.`);
      if (ten && tenDay != null && Math.abs(tenDay) >= 1) lines.push(`Early trading: 10-yr ${ten.price.toFixed(2)}% (${sgn(tenDay)} bps vs close).`);
      if (ln.state !== "unknown") lines.push(`Lean: ${ln.label}${ln.strength && ln.strength !== "headlines" ? " (" + ln.strength + ")" : ""}. ${ln.tilt || ""}`.trim());
      lines.push(todayEv.length ? `Today: ${evTxt(todayEv)}.` : "No major releases today.");
      lines.push(`Rates: ${rl.text}.`);
      short = [last ? `10-yr ${last.y.toFixed(2)}%${d1 != null ? " (" + sgn(d1) + " bps)" : ""}` : "", ln.state !== "unknown" ? "lean " + ln.label.toLowerCase() : "", todayEv.length ? evTxt(todayEv) + " today" : ""].filter(Boolean).join(" · ");
    } else if (kind === "midday") { title = "Midday brief · " + dayName;
      if (ten) lines.push(`10-yr ${ten.price.toFixed(2)}%${tenDay != null ? `, ${sgn(tenDay)} bps on the day` : ""}${ten.low != null ? ` (range ${ten.low.toFixed(2)}–${ten.high.toFixed(2)})` : ""}.`); else lines.push("Live 10-yr quote unavailable.");
      if (mbsTxt) lines.push(mbsTxt + ".");
      if (ln.state !== "unknown") lines.push(`Lean: ${ln.label}.`);
      lines.push(`Rates: ${rl.text}${rl.todayCount ? ` · ${rl.todayCount} publish${rl.todayCount > 1 ? "es" : ""} today` : " · no publish yet today"}.`);
      const later = todayEv.filter(e => Date.parse(e.at) > n); if (later.length) lines.push(`Still to come: ${evTxt(later)}.`);
      short = [ten ? `10-yr ${ten.price.toFixed(2)}%${tenDay != null ? " (" + sgn(tenDay) + " bps today)" : ""}` : "", mbsTxt, ln.state !== "unknown" ? "lean " + ln.label.toLowerCase() : ""].filter(Boolean).join(" · ");
    } else { title = "End-of-day brief · " + dayName;
      const px = ten ? ten.price : last ? last.y : null; const wk = s.length >= 5 && px != null ? Math.round((px - s[Math.max(0, s.length - 5)].y) * 100) : null;
      if (px != null) lines.push(`10-yr ${px.toFixed(2)}%${tenDay != null ? `, ${sgn(tenDay)} bps today` : ""}${wk != null ? `, ${sgn(wk)} over the past week` : ""}.`);
      if (mbsTxt) lines.push(mbsTxt + " on the day.");
      lines.push(`Rates: ${rl.text}${rl.todayCount ? ` · ${rl.todayCount} publish${rl.todayCount > 1 ? "es" : ""} today` : ""}.`);
      if (ln.state !== "unknown") lines.push(`Lean going into tomorrow: ${ln.label}.`);
      lines.push(tomEv.length ? `Tomorrow: ${evTxt(tomEv)}.` : "Nothing major scheduled tomorrow.");
      short = [px != null ? `10-yr ${px.toFixed(2)}%${tenDay != null ? " (" + sgn(tenDay) + " bps today)" : ""}` : "", ln.state !== "unknown" ? "lean " + ln.label.toLowerCase() : "", tomEv.length ? evTxt(tomEv) + " tomorrow" : ""].filter(Boolean).join(" · ");
    }
    heads.forEach(h => lines.push(`• ${h.title}`));
    return { kind, title, lines, text: title + "\n" + lines.join("\n"), short: short.length > 140 ? short.slice(0, 139) + "…" : short, lean: ln }; }
  /* Which brief fits right now (ET): morning before 11:30, midday until 3:30, end of day after. */
  function briefFor(now) { const p = etParts(now || Date.now()); const m = p.h * 60 + p.mi; return m < 690 ? "morning" : m < 930 ? "midday" : "eod"; }
  function isMarketHours(now) { const p = etParts(now || Date.now()); return !(p.wd === "Sat" || p.wd === "Sun") && p.h >= 7 && p.h < 18; }

  /* ---------------- archive + range summary (for the trends panel) ---------------- */
  function archiveHeadlines(prev, fresh, now, days) { const n = now || Date.now(), cut = n - (days || 120) * 86400000; const m = new Map();
    (prev || []).concat(fresh || []).forEach(h => { if (!h || !h.title) return; const k = h.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); if (!m.has(k) || (fresh || []).includes(h)) m.set(k, h); });
    return [...m.values()].filter(h => !h.at || Date.parse(h.at) > cut).sort((a, b) => (b.at || "") < (a.at || "") ? -1 : 1).slice(0, 600); }
  function eventsWindow(events, now, back, fwd) { const n = now || Date.now(); const seen = new Set();
    return (events || []).filter(e => { const t = Date.parse(e.at), k = e.name + e.at; if (seen.has(k) || t < n - (back || 120) * 86400000 || t > n + (fwd || 60) * 86400000) return false; seen.add(k); return true; }).sort((a, b) => a.at < b.at ? -1 : 1); }
  /* What happened between t0 and t1: 10-yr move, rate changes, publishes, events, headlines. */
  function rangeSummary(t0, t1, ctx) { const inR = t => t >= t0 && t <= t1;
    const ten = (ctx.ten || []).filter(p => inR(p.t)); const rates = (ctx.rates || []).filter(p => inR(p.t));
    const before = (ctx.rates || []).filter(p => p.t < t0).slice(-1)[0];
    const firstRate = before || rates[0], lastRate = rates[rates.length - 1] || before;
    const tenFrom = (ctx.ten || []).filter(p => p.t <= t0).slice(-1)[0] || ten[0], tenTo = ten[ten.length - 1] || tenFrom;
    const tenBps = tenFrom && tenTo ? Math.round((tenTo.v - tenFrom.v) * 100) : null; const rateChg = firstRate && lastRate ? Math.round((lastRate.v - firstRate.v) * 1000) / 1000 : null;
    const events = (ctx.events || []).filter(e => inR(Date.parse(e.at))); const heads = (ctx.headlines || []).filter(h => h.at && inR(Date.parse(h.at)));
    const better = heads.filter(h => h.tag === "better").length, worse = heads.filter(h => h.tag === "worse").length;
    let read = "";
    if (tenBps != null && rateChg != null) { if (Math.abs(tenBps) >= 5 && Math.abs(rateChg) < 0.001) read = `The 10-yr moved ${sgn(tenBps)} bps but rates didn't change — ${tenBps < 0 ? "room to improve rates" : "rates may be due to worsen"}.`;
      else if (tenBps < -4 && rateChg < 0) read = "Rates followed the 10-yr down."; else if (tenBps > 4 && rateChg > 0) read = "Rates followed the 10-yr up.";
      else if (Math.abs(tenBps) < 5 && Math.abs(rateChg) >= 0.125) read = "Rates moved more than the 10-yr did."; }
    return { t0, t1, tenFrom, tenTo, tenBps, rateFrom: firstRate, rateTo: lastRate, rateChg, publishes: rates.length, events, headlines: heads, better, worse, read }; }

  const M = { archiveHeadlines, eventsWindow, rangeSummary, METRICS, yahooUrl, parseYahooChart, metricChange, metricTone, fmtMetric, withLive, moveCheck, moveNote, brief, briefFor, isMarketHours, rateLine, etTime,
    FEEDS, FRED_URL, BLS_ICS_URL, FOMC, treasuryUrls, parseTreasuryXML, parseFredCSV, mergeSeries, parseFeed, isRelevant, tagHeadline, prepareHeadlines,
    parseICS, fomcEvents, upcoming, whenLabel, lean, recap, publishPace, ago, etToMs, etDay, decode };
  if (typeof module !== "undefined" && module.exports) module.exports = M; else root.NMCMarket = M;
})(typeof window !== "undefined" ? window : this);
