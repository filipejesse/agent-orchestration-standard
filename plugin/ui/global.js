/* AOS-1 global overlays: cost readout, alert toasts, replay scrubber. Owner: global agent.
 * Vanilla ES5, no deps. Everything is try/catch wrapped and a no-op when the data (or window.AosApp) is absent.
 */
(function () {
  'use strict';

  function safe(fn, dflt) { try { return fn(); } catch (e) { return dflt; } }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hms(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function hm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtN(n) {
    n = Number(n) || 0;
    function f(v, s) { return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') + s; }
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
  function fmtUsd(v) { return '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2)); }
  function fam(id) { id = String(id || ''); return /opus/i.test(id) ? 'opus' : /sonnet/i.test(id) ? 'sonnet' : /haiku/i.test(id) ? 'haiku' : 'other'; }
  var FAM_LABEL = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', other: 'Other' };
  var FAMS = ['opus', 'sonnet', 'haiku', 'other'];

  var PAGE_LOAD = Date.now();
  var app = null;          /* window.AosApp once present */
  var lastLive = null;     /* last non-replay state */
  var inReplay = false;

  /* ================= 1) toasts ================= */
  var toastBox = null, seen = {}, firstAlerts = true;
  function ensureToastBox() {
    if (toastBox) return toastBox;
    toastBox = el('div', 'aos-toasts');
    toastBox.setAttribute('aria-live', 'polite');
    toastBox.setAttribute('role', 'status');
    document.body.appendChild(toastBox);
    placeToasts();
    return toastBox;
  }
  function placeToasts() {
    safe(function () {
      var h = document.querySelector('header.top');
      var top = h ? h.getBoundingClientRect().bottom : 56;
      /* sit below the cost readout (top-right of the panel) so the two never collide */
      if (cost.root && !cost.root.hidden && window.innerWidth > 720) top = Math.max(top, cost.root.getBoundingClientRect().bottom);
      document.documentElement.style.setProperty('--aos-toast-top', Math.round(top + 10) + 'px');
    });
  }
  var KIND_LABEL = { needs_input: 'Waiting for you', stuck: 'Stuck', agent_done: 'Agent done', session_done: 'Session done', info: 'Notice' };
  function dismiss(t) {
    if (!t || t._gone) return;
    t._gone = true;
    clearTimeout(t._timer);
    t.className += ' out';
    setTimeout(function () { safe(function () { if (t.parentNode) t.parentNode.removeChild(t); }); }, 260);
  }
  function showToast(kind, agent, text) {
    safe(function () {
      var box = ensureToastBox();
      var live = [];
      var i, c = box.children;
      for (i = 0; i < c.length; i++) if (!c[i]._gone) live.push(c[i]);
      while (live.length >= 3) dismiss(live.shift());
      var t = el('button', 'aos-toast k-' + kind);
      t.type = 'button';
      var k = el('span', 'k', KIND_LABEL[kind] ? (kind === 'needs_input' ? 'WAITING FOR YOU' : KIND_LABEL[kind]) : String(kind || 'Notice'));
      t.appendChild(k);
      var body = (agent ? agent + (text ? ' · ' : '') : '') + (text || '');
      if (body) t.appendChild(el('span', 'x', body));
      t.addEventListener('click', function () {
        safe(function () { if (agent && app && app.selectAgent) app.selectAgent(agent); });
        dismiss(t);
      });
      box.appendChild(t);
      t._timer = setTimeout(function () { dismiss(t); }, 8000);
    });
  }
  function processAlerts(st) {
    safe(function () {
      var al = st && st.alerts;
      if (!al || !al.length) return;
      for (var i = 0; i < al.length; i++) {
        var a = al[i]; if (!a) continue;
        var key = a.ts + '|' + a.kind + '|' + a.agent;
        if (seen[key]) continue;
        seen[key] = 1;
        if (firstAlerts) {
          var ms = Date.parse(a.ts);
          if (!(ms >= PAGE_LOAD)) continue; /* older than page load (or unparseable): ignore */
        }
        showToast(a.kind, a.agent, a.text);
      }
      firstAlerts = false;
    });
  }

  /* ================= 2) cost readout ================= */
  var cost = { root: null, btn: null, val: null, bar: null, pop: null, built: false };
  function buildCost() {
    if (cost.built) return;
    var stage = $('stage'); if (!stage) return;
    cost.built = true;
    var root = el('div', 'aos-cost'); root.id = 'aos-cost'; root.hidden = true;
    var btn = el('button', 'aos-cost-btn'); btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'aos-cost-pop');
    var l = el('span', 'aos-cost-l', 'Tokens');
    var v = el('span', 'aos-cost-v tnum');
    var bar = el('span', 'aos-cost-bar'); bar.setAttribute('aria-hidden', 'true');
    btn.appendChild(l); btn.appendChild(v); btn.appendChild(bar);
    var pop = el('div', 'aos-cost-pop'); pop.id = 'aos-cost-pop'; pop.hidden = true;
    root.appendChild(btn); root.appendChild(pop);
    stage.appendChild(root);
    cost.root = root; cost.btn = btn; cost.val = v; cost.bar = bar; cost.pop = pop;
    function setOpen(o) { pop.hidden = !o; btn.setAttribute('aria-expanded', String(o)); }
    btn.addEventListener('click', function () { setOpen(pop.hidden); });
    root.addEventListener('mouseenter', function () { setOpen(true); });
    root.addEventListener('mouseleave', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden) setOpen(false); });
    document.addEventListener('click', function (e) { if (!pop.hidden && !root.contains(e.target)) setOpen(false); });
  }
  function renderCost(st) {
    safe(function () {
      var c = st && st.cost;
      buildCost();
      if (!cost.root) return;
      if (!c || !isFinite(Number(c.tokens_total)) || c.tokens_total == null) { cost.root.hidden = true; return; }
      cost.root.hidden = false;
      var tot = Number(c.tokens_total) || 0;
      var ex = c.exact && typeof c.exact === 'object' && isFinite(Number(c.exact.total_usd)) ? c.exact : null; /* OpenTelemetry: exact, beats the price-table estimate */
      var exAll = ex && ex.complete !== false; /* only replace the estimate when every session in view sends telemetry */
      var usd = exAll ? Number(ex.total_usd) : c.total_usd_est;
      /* families */
      var by = c.by_model || {}, agg = {}, priced = true, any = false, sum = 0, cached = 0, id, f, m;
      for (id in by) {
        if (!Object.prototype.hasOwnProperty.call(by, id)) continue;
        m = by[id] || {}; f = fam(id); any = true;
        var a = agg[f] || (agg[f] = { input: 0, output: 0, cr: 0, cw: 0, usd: 0, hasUsd: false, tot: 0 });
        a.input += +m.input || 0; a.output += +m.output || 0; a.cr += +m.cache_read || 0; a.cw += +m.cache_write || 0;
        if (m.usd_est != null) { a.usd += +m.usd_est || 0; a.hasUsd = true; } else priced = false;
        a.tot = a.input + a.output + a.cw; sum += (+m.input || 0) + (+m.output || 0) + (+m.cache_write || 0); cached += +m.cache_read || 0; /* headline counts new tokens only: cache reads are cheap re-reads of earlier context */
      }
      var fresh = (any && sum > 0) ? sum : tot;
      cost.val.textContent = '';
      cost.val.appendChild(document.createTextNode(fmtN(fresh)));
      cost.val.appendChild(el('small', null, (any && sum > 0 ? 'new tok' : 'tok') + (usd != null ? ' \u00b7 ' + fmtUsd(Number(usd)) : '')));
      cost.bar.textContent = '';
      var pop = cost.pop; pop.textContent = '';
      if (any && sum > 0) {
        var h = el('div', 'aos-pop-h');
        h.appendChild(el('span', null, 'Model')); h.appendChild(el('span', null, 'Output')); h.appendChild(el('span', null, 'Cache read')); h.appendChild(el('span', null, priced ? 'USD' : ''));
        pop.appendChild(h);
        for (var i = 0; i < FAMS.length; i++) {
          f = FAMS[i]; var g = agg[f]; if (!g) continue;
          var seg = el('i', 'f-' + f); seg.style.width = (g.tot / sum * 100).toFixed(2) + '%'; seg.title = FAM_LABEL[f] + ' ' + fmtN(g.tot);
          cost.bar.appendChild(seg);
          var r = el('div', 'aos-pop-r f-' + f);
          r.appendChild(el('b', null, FAM_LABEL[f]));
          r.appendChild(el('span', null, fmtN(g.output)));
          r.appendChild(el('span', null, fmtN(g.cr)));
          r.appendChild(el('span', null, g.hasUsd ? fmtUsd(g.usd) : ''));
          pop.appendChild(r);
        }
        pop.appendChild(el('p', 'aos-pop-note', 'New = input + output + cache writes. ' + fmtN(cached) + ' cache reads not counted (' + fmtN(tot) + ' total).'));
        if (usd == null || !priced) pop.appendChild(el('p', 'aos-pop-note', 'add prices in live/prices.json for $'));
      } else {
        pop.appendChild(el('p', 'aos-pop-note', fmtN(tot) + ' tokens total'));
      }
      if (ex) {
        var bs = ex.by_source || {}, parts = ['main ' + fmtUsd(+bs.main || 0), 'subagents ' + fmtUsd(+bs.subagent || 0)];
        if (+bs.auxiliary) parts.push('background ' + fmtUsd(+bs.auxiliary));
        if (+bs.other) parts.push('other ' + fmtUsd(+bs.other));
        pop.appendChild(el('p', 'aos-pop-note', 'Exact cost from Claude Code telemetry: ' + fmtUsd(+ex.total_usd || 0) + ' (' + parts.join(' \u00b7 ') + ') across ' + (+ex.sessions || 0) + ' session' + (+ex.sessions === 1 ? '' : 's')
          + (exAll ? '.' : ' of ' + (+ex.live_sessions || 0) + ' in view (partial: the headline stays the estimate).')));
        var bt = ex.by_agent_type || {}, types = Object.keys(bt).sort(function (a, b) { return (+bt[b] || 0) - (+bt[a] || 0); }).slice(0, 6);
        if (types.length) pop.appendChild(el('p', 'aos-pop-note', 'Subagents by type: ' + types.map(function (k) { return k + ' ' + fmtUsd(+bt[k] || 0); }).join(' \u00b7 ')));
      }
      placeToasts();
      cost.btn.setAttribute('aria-label', 'New tokens ' + fmtN(fresh) + ' of ' + fmtN(tot) + ' total' + (usd != null ? ', ' + (exAll ? 'exact ' : '') + fmtUsd(Number(usd)) : '') + '. Show breakdown by model');
    });
  }

  /* ================= 3) replay ================= */
  var H = { first: 0, last: 0, count: 0, markers: [], at: 0 };
  var R = { btn: null, tag: null, bar: null, track: null, fill: null, head: null, ticks: null, time: null, play: null, speed: null,
            open: false, t: 0, playing: false, speedIdx: 0, timer: null, deb: null, ctl: null, cache: {}, cacheN: 0, drag: false, histTimer: null, reqSeq: 0 };
  var SPEEDS = [1, 4, 16];

  function fetchJson(url, ctl) {
    var opt = { cache: 'no-store' }; if (ctl) opt.signal = ctl.signal;
    return fetch(url, opt).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  }
  function loadHistory() {
    if (!window.fetch) return;
    safe(function () {
      fetchJson('/api/history?limit=2000').then(function (j) {
        safe(function () {
          var f = Date.parse(j && j.first_ts), l = Date.parse(j && j.last_ts);
          if (!j || !(j.count > 0) || !isFinite(f) || !isFinite(l)) { H.count = 0; syncReplayUi(); return; }
          H.first = f; H.last = Math.max(l, f + 1000); H.count = j.count; H.markers = j.markers || []; H.at = Date.now();
          syncReplayUi(); if (R.open) { drawTicks(); paintHead(); }
        });
      }, function () { /* no history endpoint: stay hidden */ });
    });
  }
  function isLiveState(st) { return !!(st && st.mode === 'live'); }

  function buildReplay() {
    if (R.bar) return;
    var stage = $('stage'), live = $('live-ind'); if (!stage || !live || !live.parentNode) return;
    R.btn = el('button', 'aos-replay-btn', 'Replay'); R.btn.type = 'button'; R.btn.hidden = true;
    R.btn.setAttribute('aria-label', 'Open replay timeline');
    R.tag = el('span', 'aos-replay-tag', 'Replay'); R.tag.hidden = true; R.tag.setAttribute('role', 'status');
    live.parentNode.insertBefore(R.btn, live.nextSibling);
    live.parentNode.insertBefore(R.tag, R.btn.nextSibling);
    R.btn.addEventListener('click', function () { openReplay(); });

    var bar = el('div', 'aos-replay'); bar.id = 'aos-replay'; bar.hidden = true;
    bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Replay timeline');
    R.play = el('button', 'aos-rb', 'Play'); R.play.type = 'button';
    R.speed = el('button', 'aos-rb', '1x'); R.speed.type = 'button'; R.speed.setAttribute('aria-label', 'Playback speed');
    var tr = el('div', 'aos-track'); tr.tabIndex = 0; tr.setAttribute('role', 'slider'); tr.setAttribute('aria-label', 'Replay position');
    R.ticks = el('div', 'aos-ticks'); R.fill = el('div', 'aos-fill'); R.head = el('div', 'aos-head');
    tr.appendChild(el('div', 'aos-line')); tr.appendChild(R.fill); tr.appendChild(R.ticks); tr.appendChild(R.head);
    R.time = el('span', 'aos-time', '--:--:--');
    var lv = el('button', 'aos-rb live', 'Live'); lv.type = 'button';
    R.l0 = el('span', 'aos-tl', '--:--'); R.l1 = el('span', 'aos-tl', '--:--'); R.l0.setAttribute('aria-hidden', 'true'); R.l1.setAttribute('aria-hidden', 'true');
    bar.appendChild(R.play); bar.appendChild(R.speed); bar.appendChild(R.l0); bar.appendChild(tr); bar.appendChild(R.l1); bar.appendChild(R.time); bar.appendChild(lv);
    stage.appendChild(bar);
    R.bar = bar; R.track = tr;

    R.play.addEventListener('click', function () { setPlaying(!R.playing); });
    R.speed.addEventListener('click', function () { R.speedIdx = (R.speedIdx + 1) % SPEEDS.length; R.speed.textContent = SPEEDS[R.speedIdx] + 'x'; });
    lv.addEventListener('click', function () { closeReplay(); });

    function posToT(ev) {
      var r = R.track.getBoundingClientRect(); var x = (ev.clientX - r.left) / (r.width || 1);
      x = Math.max(0, Math.min(1, x)); return H.first + x * (H.last - H.first);
    }
    function onDown(ev) {
      R.drag = true; safe(function () { R.track.setPointerCapture && ev.pointerId != null && R.track.setPointerCapture(ev.pointerId); });
      seek(posToT(ev), true); ev.preventDefault();
    }
    function onMove(ev) { if (R.drag) seek(posToT(ev), true); }
    function onUp() { R.drag = false; }
    if (window.PointerEvent) {
      tr.addEventListener('pointerdown', onDown); tr.addEventListener('pointermove', onMove);
      tr.addEventListener('pointerup', onUp); tr.addEventListener('pointercancel', onUp);
    } else {
      tr.addEventListener('mousedown', onDown); document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    }
    document.addEventListener('keydown', onKey);
  }
  function onKey(e) {
    safe(function () {
      if (!R.open) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      var inBar = t && R.bar && R.bar.contains(t);
      var neutral = !t || t === document.body || tag === 'HTML';
      if (!inBar && !neutral) return;
      var step = Math.max(1000, (H.last - H.first) / 100) * (e.shiftKey ? 10 : 1);
      if (e.key === ' ' || e.key === 'Spacebar') { if (tag === 'BUTTON' && inBar) { /* native click handles it */ return; } setPlaying(!R.playing); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { seek(R.t - step, true); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { seek(R.t + step, true); e.preventDefault(); }
      else if (e.key === 'Escape') { closeReplay(); }
    });
  }
  function syncReplayUi() {
    safe(function () {
      buildReplay(); if (!R.btn) return;
      var show = H.count > 0 && !!lastLive && isLiveState(lastLive);
      R.btn.hidden = !show || R.open;
      if (!show && R.open) closeReplay();
    });
  }
  function drawTicks() {
    safe(function () {
      R.ticks.textContent = '';
      var span = H.last - H.first; if (!(span > 0)) return;
      var w = R.track.getBoundingClientRect().width || 600, slots = Math.max(20, Math.floor(w / 3)), seenSlot = {};
      var ms = H.markers || [];
      for (var i = 0; i < ms.length; i++) {
        var t = Date.parse(ms[i].ts); if (!isFinite(t)) continue;
        var type = ms[i].type, cls = (type === 'collision' || type === 'stuck') ? 't-warn' : (type === 'task.completed' ? 't-done' : (type === 'agent.spawned' || type === 'session.start' || type === 'task.started') ? 't-spawn' : 't-other');
        var p = (t - H.first) / span; if (p < 0 || p > 1) continue;
        var slot = Math.round(p * slots), k = cls + slot; if (seenSlot[k]) continue; seenSlot[k] = 1;
        var tick = el('i', cls); tick.style.left = (slot / slots * 100).toFixed(2) + '%'; R.ticks.appendChild(tick);
      }
    });
  }
  function paintHead() {
    var span = H.last - H.first, p = span > 0 ? Math.max(0, Math.min(1, (R.t - H.first) / span)) : 1;
    R.head.style.left = (p * 100).toFixed(3) + '%'; R.fill.style.width = (p * 100).toFixed(3) + '%';
    R.l0.textContent = hm(H.first); R.l1.textContent = hm(H.last);
    var s = hms(R.t); R.time.textContent = s; R.tag.textContent = 'Replay ' + s;
    R.track.setAttribute('aria-valuetext', s);
  }
  window.AosReplay = { at: function () { return R.open ? R.t : null; } };   /* read by timeline.js */
  function openReplay() {
    safe(function () {
      if (!R.bar || R.open) return;
      R.open = true; R.bar.hidden = false; R.btn.hidden = true;
      document.body.classList.add('aos-replay-open');
      R.t = H.last; R.playing = false; R.play.textContent = 'Play';
      drawTicks(); paintHead();
      R.tag.hidden = false; document.body.classList.add('aos-replaying'); inReplay = true; setCostDim(true);
      requestState(R.t, true);
      loadHistory(); R.histTimer = setInterval(loadHistory, 20000);
    });
  }
  function closeReplay() {
    safe(function () {
      if (!R.open) return;
      R.open = false; setPlaying(false);
      clearTimeout(R.deb); if (R.ctl) { safe(function () { R.ctl.abort(); }); R.ctl = null; }
      clearInterval(R.histTimer); R.reqSeq++;
      R.bar.hidden = true; R.tag.hidden = true;
      document.body.classList.remove('aos-replay-open'); document.body.classList.remove('aos-replaying');
      inReplay = false; setCostDim(false);
      if (app && app.setOverride) app.setOverride(null);
      if (lastLive) renderCost(lastLive);
      syncReplayUi();
    });
  }
  function setCostDim(d) { if (cost.root) { if (d) cost.root.className = 'aos-cost dim'; else cost.root.className = 'aos-cost'; } }
  function setPlaying(p) {
    R.playing = !!p; R.play.textContent = R.playing ? 'Pause' : 'Play';
    clearInterval(R.timer); R.timer = null;
    if (!R.playing) return;
    if (R.t >= H.last) R.t = H.first;
    R.timer = setInterval(function () {
      safe(function () {
        R.t += 250 * SPEEDS[R.speedIdx];
        if (R.t >= H.last) { R.t = H.last; setPlaying(false); }
        paintHead(); requestState(R.t, false);
      });
    }, 250);
  }
  function seek(t, debounced) {
    t = Math.max(H.first, Math.min(H.last, t)); R.t = t; paintHead();
    if (debounced) { clearTimeout(R.deb); R.deb = setTimeout(function () { requestState(R.t, false); }, 120); }
  }
  function cacheGet(k) { return R.cache[k]; }
  function cachePut(k, v) { if (!R.cache[k]) { if (R.cacheN > 80) { R.cache = {}; R.cacheN = 0; } R.cacheN++; } R.cache[k] = v; }
  function requestState(t, immediate) {
    safe(function () {
      var key = new Date(Math.floor(t / 1000) * 1000).toISOString();
      var hit = cacheGet(key);
      if (hit) { if (R.ctl) { safe(function () { R.ctl.abort(); }); R.ctl = null; } applyOverride(hit); return; }
      if (R.ctl) safe(function () { R.ctl.abort(); });
      var ctl = window.AbortController ? new AbortController() : null; R.ctl = ctl;
      var seq = ++R.reqSeq;
      fetchJson('/api/state?at=' + encodeURIComponent(key), ctl).then(function (st) {
        if (seq !== R.reqSeq || !R.open) return;
        cachePut(key, st); R.ctl = null; applyOverride(st);
      }, function (err) {
        if (seq !== R.reqSeq || !R.open) return;
        if (err && err.name === 'AbortError') return;
        showToast('info', '', 'Replay unavailable, back to live');
        closeReplay();
      });
    });
  }
  function applyOverride(st) { safe(function () { if (app && app.setOverride && R.open) app.setOverride(st); }); }

  /* ================= wiring ================= */
  function onState(st) {
    safe(function () {
      if (!st) return;
      if (st.replay) return;                 /* replayed states: no cost, no alerts, no history logic */
      lastLive = st;
      if (!inReplay) renderCost(st);         /* cost is not time-sliced: frozen/dimmed during replay */
      processAlerts(st);
      if (isLiveState(st) && !H.at) { H.at = Date.now(); loadHistory(); }
      syncReplayUi();
    });
  }
  var bound = false;
  function bind() {
    if (bound) return true;
    var a = window.AosApp;
    if (!a || typeof a.onState !== 'function') return false;
    bound = true; app = a;
    safe(function () { a.onState(onState); });
    safe(function () { if (a.getState) onState(a.getState()); });
    return true;
  }
  function init() {
    safe(function () {
      buildCost(); buildReplay(); ensureToastBox(); placeToasts();
      window.addEventListener('resize', function () { placeToasts(); if (R.open) drawTicks(); });
      if (bind()) return;
      var n = 0, iv = setInterval(function () { if (bind() || ++n > 60) clearInterval(iv); }, 500);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
