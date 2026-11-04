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
  function treasuryUrls(now) { const d = new Date(now || Date.now()); const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    return [prev, d].map(m => "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=" + yyyymm(m)); }
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

  const M = { FEEDS, FRED_URL, BLS_ICS_URL, FOMC, treasuryUrls, parseTreasuryXML, parseFredCSV, mergeSeries, parseFeed, isRelevant, tagHeadline, prepareHeadlines,
    parseICS, fomcEvents, upcoming, whenLabel, lean, recap, publishPace, ago, etToMs, etDay, decode };
  if (typeof module !== "undefined" && module.exports) module.exports = M; else root.NMCMarket = M;
})(typeof window !== "undefined" ? window : this);
