/* ============================================================================
   NMC motion — the small library behind the theme's movement.
   Shared by the Toolkit and the Rate Desk. No dependencies.

     NMC.icons(root)      swap emoji in text for drawn line icons (sized to text)
     NMC.icon(name)       the <svg> markup for one icon, for use in templates
     NMC.tick(root)       numbers marked data-tick count up on first appearance
                          and tick old→new when their value changes
     NMC.enter(ms)        "a screen or view was just opened": entrance animations
                          (row cascade, chart draw, tile slide) run for ms, then stop
     NMC.charts(root)     measure chart paths so they can draw themselves
     NMC.copied(btn)      morph a Copy button to "✓ Copied" and back
     NMC.snapHeight(el, stops, tol)   settle a dragged height onto the nearest stop
     NMC.closeThen(el, fn, ms)        add .closing, then run fn (exit animations)

   Everything respects prefers-reduced-motion and pauses when the window is hidden.
   ============================================================================ */
(function(){
  const reduce = () => window.__nmcNoMotion || typeof requestAnimationFrame !== "function" || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  /* ---------- icons ---------- */
  const PATHS = {
    flame:    '<path d="M8 1.5c.5 2.5 3.5 3.5 3.5 7a3.5 3.5 0 0 1-7 0c0-1.5.8-2.5 1.2-3 .2 1 .8 1.8 1.5 2 .2-2.4.3-4.5.8-6z"/>',
    sparkle:  '<path d="M8 1.5l1.5 4.5L14 7.5 9.5 9 8 13.5 6.5 9 2 7.5l4.5-1.5z" fill="currentColor" stroke="none"/>',
    bell:     '<path d="M4.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5l1 1.5H3.5zM6.5 13.5a1.5 1.5 0 0 0 3 0"/>',
    hourglass:'<path d="M4 2h8M4 14h8M5 2c0 4 3 4 3 6s-3 2-3 6M11 2c0 4-3 4-3 6s3 2 3 6"/>',
    calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/>',
    home:     '<path d="M2.5 8L8 3l5.5 5M4 7v6.5h8V7"/>',
    clock:    '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
    chat:     '<path d="M3 3h10v7H7l-3 3v-3H3z"/>',
    bolt:     '<path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"/>',
    check:    '<path d="M3 8.5l3 3 7-7"/>',
    x:        '<path d="M4 4l8 8M12 4l-8 8"/>',
    redo:     '<path d="M12.5 7A5 5 0 1 0 11 11.5M12.5 3v4h-4"/>',
    up:       '<path d="M3 11l5-6 5 6z" fill="currentColor" stroke="none"/>',
    down:     '<path d="M3 5l5 6 5-6z" fill="currentColor" stroke="none"/>',
    arrowUp:  '<path d="M8 13V3M4 7l4-4 4 4"/>',
    arrowDown:'<path d="M8 3v10M4 9l4 4 4-4"/>',
    star:     '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor" stroke="none"/>',
    starO:    '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>'
  };
  const EMOJI = {
    "\u{1F525}":"flame", "✨":"sparkle", "\u{1F514}":"bell", "⏳":"hourglass", "\u{1F4C5}":"calendar",
    "\u{1F3E1}":"home", "\u{1F550}":"clock", "\u{1F552}":"clock", "\u{1F4AC}":"chat", "⚡":"bolt",
    "⬆":"arrowUp", "⬇":"arrowDown", "★":"star", "☆":"starO"
  };
  const CLS = {sparkle:"fill", up:"fill tri", down:"fill tri", star:"fill"};
  function icon(name, extra){ const p = PATHS[name]; if(!p) return ""; return `<svg class="ic ${name}${CLS[name]?" "+CLS[name]:""}${extra?" "+extra:""}" viewBox="0 0 16 16" aria-hidden="true">${p}</svg>`; }
  const RE = new RegExp("(" + Object.keys(EMOJI).join("|") + ")\\uFE0F?\\s?", "gu");
  const SKIP = {SCRIPT:1, STYLE:1, TEXTAREA:1, INPUT:1, OPTION:1, SVG:1, TITLE:1};
  function icons(root){
    const walk = n => {
      if(n.nodeType === 3){ const v = n.nodeValue; if(!v || !RE.test(v)) return; RE.lastIndex = 0;
        const span = document.createElement("span"); span.innerHTML = v.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])).replace(RE, (m, k) => icon(EMOJI[k]));
        n.replaceWith(...span.childNodes); return; }
      if(n.nodeType !== 1 || SKIP[n.nodeName] || n.hasAttribute("data-noicon")) return;
      for(const c of [...n.childNodes]) walk(c);
    };
    walk(root || document.body);
  }

  /* ---------- number ticks ---------- */
  const last = new Map();
  const fmt = (m, v) => { const dec = (m.split(".")[1] || "").length; return dec ? v.toFixed(dec) : Math.round(v).toLocaleString("en-US"); };
  function run(tn, host, from, to, txt, m, dur){
    if(reduce() || document.hidden){ tn.nodeValue = txt; return; }
    const t0 = performance.now(); host.classList.add("ticking");
    const step = t => { const p = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - p, 3);
      tn.nodeValue = p < 1 ? txt.replace(m, fmt(m, from + (to - from) * e)) : txt;
      if(p < 1 && tn.isConnected) requestAnimationFrame(step); else host.classList.remove("ticking"); };
    requestAnimationFrame(step);
  }
  function tick(root){
    const R = root || document;
    // stat tiles key themselves by their label, so render functions need no markup
    R.querySelectorAll(".stat > .v:not([data-tick])").forEach(v => { const lab = (v.parentNode.textContent || "").replace(v.textContent, "").trim().slice(0, 40); v.dataset.tick = "stat:" + lab; });
    R.querySelectorAll("[data-tick]").forEach(el => {
      if(el.dataset.tk) return; el.dataset.tk = "1";
      const tn = [...el.childNodes].find(n => n.nodeType === 3 && /\d/.test(n.nodeValue)); if(!tn) return;
      const txt = tn.nodeValue; const m = txt.match(/-?[\d,]*\.?\d+(?=%)/) || txt.match(/-?[\d,]*\.?\d+/); if(!m) return;
      const to = +m[0].replace(/,/g, ""); if(isNaN(to)) return;
      const key = el.dataset.tick; const prev = last.get(key); last.set(key, to);
      if(prev == null){ if(el.dataset.tickFirst !== "no") run(tn, el, 0, to, txt, m[0], 900); }
      else if(prev !== to) run(tn, el, prev, to, txt, m[0], 420);
    });
  }

  /* ---------- entrance window + charts ---------- */
  let enterT = null;
  function enter(ms){ if(reduce()) return; document.body.classList.remove("nmc-enter"); void document.body.offsetWidth; document.body.classList.add("nmc-enter"); clearTimeout(enterT); enterT = setTimeout(() => document.body.classList.remove("nmc-enter"), ms || 1800); charts(); }
  function charts(root){ (root || document).querySelectorAll("svg.chart path[stroke], svg.chart polyline").forEach(p => { if(p.dataset.len || typeof p.getTotalLength !== "function") return; try{ const L = p.getTotalLength(); if(L > 0){ p.dataset.len = "1"; p.style.setProperty("--len", L); } }catch(e){} }); }

  /* ---------- small satisfactions ---------- */
  function copied(btn, label){ if(!btn || btn.dataset.copied) return; btn.dataset.copied = "1"; const html = btn.innerHTML; btn.classList.add("copied"); btn.innerHTML = icon("check") + (label || "Copied"); setTimeout(() => { btn.classList.remove("copied"); btn.innerHTML = html; delete btn.dataset.copied; }, 1100); }
  function snapHeight(el, stops, tol){ const h = parseInt(el.style.height) || el.getBoundingClientRect().height; const near = stops.reduce((a, b) => Math.abs(b - h) < Math.abs(a - h) ? b : a); if(Math.abs(near - h) < (tol || 70)){ el.classList.add("snapped"); el.style.height = near + "px"; setTimeout(() => el.classList.remove("snapped"), 300); return near; } return h; }
  function closeThen(el, fn, ms){ if(!el || reduce()){ fn(); return; } el.classList.add("closing"); setTimeout(() => { el.classList.remove("closing"); fn(); }, ms || 190); }

  /* ---------- keep the page quiet when nobody's looking; keep icons current ---------- */
  document.addEventListener("visibilitychange", () => document.body.classList.toggle("nmc-bg", document.hidden));
  let moT = null; const mo = new MutationObserver(() => { clearTimeout(moT); moT = setTimeout(() => { icons(); tick(); }, 30); });
  function start(){ icons(); tick(); mo.observe(document.body, {childList:true, subtree:true}); }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();

  window.NMC = {icons, icon, tick, enter, charts, copied, snapHeight, closeThen, PATHS};
})();
