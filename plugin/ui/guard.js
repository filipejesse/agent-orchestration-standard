/* AOS-1 GUARD view: verdicts of `aos-orch verify` (re-runs the original tests in a sandbox + anti-cheat diff analysis) for single sessions.
 * Read-only: GET /api/verdicts on the monitor (same origin) and the `verdicts` summary / agent `guard` field in /api/state.
 * Pure helpers (badge, kindText, rowModel) load in node for tests (module.exports); the DOM part runs only in a browser.
 * Vanilla ES5, no deps. Every string is hostile: textContent / setAttribute of known-safe attributes only, never innerHTML.
 */
(function (root) {
  'use strict';
  var STATES = { verified: 1, integrity: 1, capability: 1 };
  function str(x, n) { x = x == null ? '' : String(x); return n && x.length > n ? x.slice(0, n) + '…' : x; }
  function kindText(k) { return str(k).replace(/[_.-]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  /* agent.guard (or a verdict) -> { state: verified|integrity|capability|none, text, title } */
  function badge(g) {
    var v = g && typeof g === 'object' ? g.verdict : null;
    if (!STATES[v]) return { state: 'none', text: 'guard: none', title: 'No guard verdict for this session' };
    if (v === 'verified') return { state: v, text: 'verified', title: 'aos-orch verify accepted this work: the original tests pass in a sandbox and no integrity issue was found' };
    if (v === 'integrity') return { state: v, text: 'rejected: ' + (g.kind ? kindText(g.kind) : 'integrity'), title: 'Integrity rejection: the work changed, skipped or weakened the tests (or passed vacuously). Do not merge without a look.' };
    return { state: v, text: 'rejected: checks failed', title: 'Capability rejection: the original tests or checks failed in the sandbox' };
  }
  function fmtMs(ms) { ms = Number(ms); if (!isFinite(ms) || ms < 0) return ''; return ms < 1000 ? Math.round(ms) + 'ms' : ms < 60000 ? (ms / 1000).toFixed(1).replace(/\.0$/, '') + 's' : Math.round(ms / 60000) + 'm'; }
  function when(iso) { var t = Date.parse(iso); if (!isFinite(t)) return ''; var d = new Date(t), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
  function list(x) { return Array.isArray(x) ? x : []; }
  /* one verdict -> plain display model (strings only) */
  function rowModel(v) {
    var b = badge(v), meta = [when(v.created_at), v.source && v.source !== 'unknown' ? 'via ' + str(v.source, 10) : '', v.agent ? str(v.agent, 60) : '', v.tree === 'working' ? 'working tree' : v.tree ? 'commit ' + str(v.tree, 12) : '', v.base ? 'base ' + (v.base_ref ? str(v.base_ref, 40) + ' ' : '') + str(v.base, 12) : '', fmtMs(v.duration_ms)].filter(Boolean);
    return { id: str(v.id, 40), state: b.state, label: b.text, title: b.title, repo: str(v.repo_name || 'repo', 60), meta: meta.join(' · '),
      reasons: list(v.rejections).map(function (r) { return { kind: kindText(r && r.kind), detail: str(r && r.detail, 200) }; }),
      warnings: list(v.warnings).map(function (w) { return str(w, 200); }), failing: list(v.failing_tests).map(function (t) { return str(t, 200); }),
      checks: list(v.checks).map(function (c) { c = c || {}; return { cmd: str(c.cmd, 200) || '(command)', ok: c.ok === true, text: (c.ok === true ? 'ok' : 'failed' + (c.exit_code != null ? ' (exit ' + str(c.exit_code, 6) + ')' : '')) + (fmtMs(c.duration_ms) ? ' · ' + fmtMs(c.duration_ms) : '') }; }) };
  }
  var api = { badge: badge, kindText: kindText, rowModel: rowModel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AOSGuard = api;
  if (typeof document === 'undefined' || !document.createElement) return;

  /* ---------------- DOM ---------------- */
  var SVGNS = 'http://www.w3.org/2000/svg', R = {}, open = false, poll = 0, ac = null, rows = [], focusId = null, sum = null, lastFocus = null;
  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function chip(state, text, title) { var c = el('span', 'guard-chip g-' + state, text); c.setAttribute('data-guard', state); if (title) c.title = title; return c; }
  /* drawer badge for an agent: its verdict, or "guard: none" on a session when the guard view is active (any verdict exists) */
  function badgeEl(a, st) {
    if (!a) return null;
    var isSess = list(a.capabilities).indexOf('claude-code') >= 0, any = st && st.verdicts && Number(st.verdicts.total) > 0;
    if (!a.guard && !(isSess && any)) return null;
    var b = badge(a.guard), t = el(a.guard ? 'button' : 'span', 'tag guard-badge g-' + b.state, b.text); t.setAttribute('data-guard', b.state); t.title = b.title;
    if (a.guard) { t.type = 'button'; t.setAttribute('aria-label', 'Guard verdict: ' + b.text + '. Open the guard panel'); t.addEventListener('click', function () { openPanel(str(a.guard.id, 40)); }); }
    return t;
  }
  api.badgeEl = badgeEl;
  function buildBtn() {
    var top = document.querySelector('header.top'), theme = $('theme-btn'); if (!top) return;
    var b = el('button', 'orch-hbtn guard-hbtn'); b.type = 'button'; b.id = 'guard-btn'; b.hidden = true;
    b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'guard-panel'); b.setAttribute('aria-haspopup', 'dialog');
    b.appendChild(document.createTextNode('Guard')); R.n = el('b', 'tnum', '0'); b.appendChild(R.n);
    R.dot = el('i', 'guard-dot'); R.dot.hidden = true; R.dot.setAttribute('aria-hidden', 'true'); b.appendChild(R.dot);
    if (theme && theme.parentNode === top) top.insertBefore(b, theme); else top.appendChild(b);
    b.addEventListener('click', function () { if (open) closePanel(); else openPanel(null); });
    R.btn = b;
  }
  function buildPanel() {
    var p = el('aside', 'orch-panel guard-panel'); p.id = 'guard-panel'; p.hidden = true; p.setAttribute('aria-labelledby', 'guard-title');
    var head = el('div', 'orch-head'), t = el('h2', 'orch-title', 'Guard verdicts'); t.id = 'guard-title';
    var x = el('button', 'icon-btn orch-x'); x.type = 'button'; x.setAttribute('aria-label', 'Close guard panel');
    var s = document.createElementNS(SVGNS, 'svg'), pa = document.createElementNS(SVGNS, 'path');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true'); pa.setAttribute('d', 'M4 4l8 8M12 4l-8 8'); pa.setAttribute('fill', 'none'); pa.setAttribute('stroke-width', '1.8'); pa.setAttribute('stroke-linecap', 'round');
    s.appendChild(pa); x.appendChild(s); x.addEventListener('click', closePanel);
    head.appendChild(t); head.appendChild(x); p.appendChild(head);
    R.note = el('p', 'orch-conn guard-note', 'Verdicts from aos-orch verify: the original tests re-run in a sandbox plus anti-cheat checks. Read-only.');
    p.appendChild(R.note); R.body = el('div', 'orch-pbody'); p.appendChild(R.body);
    p.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } });
    document.body.appendChild(p); R.panel = p;
  }
  function section(parent, title, items, cls) {
    if (!items.length) return;
    parent.appendChild(el('h4', 'guard-h', title));
    var ul = el('ul', 'guard-l ' + (cls || '')); items.forEach(function (n) { ul.appendChild(n); }); parent.appendChild(ul);
  }
  function renderRow(v) {
    var m = rowModel(v), li = el('li', 'guard-v g-' + m.state); li.setAttribute('data-id', m.id); li.setAttribute('data-verdict', m.state); li.tabIndex = -1;
    var r1 = el('div', 'guard-r1'); r1.appendChild(chip(m.state, m.label, m.title)); r1.appendChild(el('span', 'guard-repo', m.repo)); li.appendChild(r1);
    if (m.meta) li.appendChild(el('div', 'guard-meta', m.meta));
    section(li, 'Reasons', m.reasons.map(function (r) { var i = el('li'); i.appendChild(el('b', 'guard-k', r.kind)); if (r.detail) i.appendChild(document.createTextNode(' ' + r.detail)); return i; }), 'guard-reasons');
    section(li, 'Failing tests', m.failing.map(function (t) { return el('li', null, t); }), 'guard-failing');
    section(li, 'Warnings', m.warnings.map(function (w) { return el('li', null, w); }), 'guard-warn');
    section(li, 'Checks', m.checks.map(function (c) { var i = el('li', c.ok ? 'ok' : 'bad'); i.appendChild(el('code', 'guard-cmd', c.cmd)); i.appendChild(el('span', 'guard-res', ' ' + c.text)); return i; }), 'guard-checks');
    return li;
  }
  function render() {
    if (!R.body) return; clear(R.body);
    if (!rows.length) { R.body.appendChild(el('p', 'orch-empty', 'No guard verdicts yet.')); return; }
    var ul = el('ul', 'guard-list'); rows.forEach(function (v) { if (v && typeof v === 'object') ul.appendChild(renderRow(v)); }); R.body.appendChild(ul);
    if (focusId) { var n = R.body.querySelector('[data-id="' + focusId.replace(/[^A-Za-z0-9-]/g, '') + '"]'); if (n) { n.classList.add('focus'); safe(function () { n.scrollIntoView({ block: 'nearest' }); n.focus({ preventScroll: true }); }); } focusId = null; }
  }
  function load() {
    clearTimeout(poll); safe(function () { if (ac) ac.abort(); }); ac = window.AbortController ? new AbortController() : null;
    if (!open || document.hidden) return;
    fetch('/api/verdicts', { cache: 'no-store', credentials: 'same-origin', signal: ac ? ac.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && Array.isArray(j.verdicts)) { rows = j.verdicts; render(); } }, function () { /* keep the last list */ })
      .then(function () { if (open) poll = setTimeout(load, 5000); });
  }
  function openPanel(id) {
    if (!R.panel) buildPanel();
    focusId = id || null;
    if (!open) { safe(function () { var gp = $('orch-panel'), gx = gp && !gp.hidden ? gp.querySelector('.orch-x') : null; if (gx) gx.click(); }); lastFocus = document.activeElement; }
    open = true; R.panel.hidden = false; setBtn(); render(); load();
    if (!focusId) safe(function () { R.panel.querySelector('.orch-x').focus(); });
  }
  function closePanel() {
    if (!open) return; open = false; clearTimeout(poll); safe(function () { if (ac) ac.abort(); }); R.panel.hidden = true; setBtn();
    if (lastFocus && document.body.contains(lastFocus)) safe(function () { lastFocus.focus(); });
  }
  api.open = openPanel; api.close = closePanel;
  function setBtn() {
    if (!R.btn) return;
    var total = sum ? Number(sum.total) || 0 : 0, bad = sum ? list(sum.latest).filter(function (v) { return v && v.verdict === 'integrity'; }).length : 0;
    R.btn.hidden = total <= 0; R.n.textContent = String(total); R.dot.hidden = bad <= 0;
    R.btn.classList.toggle('on', open); R.btn.setAttribute('aria-expanded', String(open));
    R.btn.setAttribute('aria-label', 'Guard: ' + total + (total === 1 ? ' verdict' : ' verdicts') + (bad ? ', ' + bad + ' integrity rejection' + (bad === 1 ? '' : 's') : '') + (open ? '. Close guard panel' : '. Open guard panel'));
    if (total <= 0 && open) closePanel();
  }
  var lastSig = '';
  function onState(st) {
    safe(function () {
      if (!st || st.replay) return;                     // replay omits verdicts: keep the live view
      sum = st.verdicts && typeof st.verdicts === 'object' ? st.verdicts : null;
      var sig = JSON.stringify(sum); if (sig === lastSig) return; lastSig = sig;
      setBtn(); if (open) load();
    });
  }
  api.setSummary = function (s) { sum = s; setBtn(); };   /* tests */
  function init() {
    safe(buildBtn);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && open) load(); });
    var n = 0, iv = setInterval(function () { var a = window.AosApp; if ((a && typeof a.onState === 'function' && (a.onState(onState), a.getState && onState(a.getState()), true)) || ++n > 60) clearInterval(iv); }, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : globalThis);
