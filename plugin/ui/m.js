/* Mobile view: polls /api/state and renders projects -> agents as a list. Read-only; DOM built with textContent only. */
(function () {
  'use strict';
  var POLL_MS = 3000, KEY_F = 'aos.m.filter', KEY_T = 'aos.theme';
  var RANK = { errored: 0, stalled: 1, running: 2, idle: 3 };
  var state = null, failures = 0, open = new Set(), machine = 'all', filter = 'all';
  try { filter = localStorage.getItem(KEY_F) === 'active' ? 'active' : 'all'; } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmtTok(n) { n = n || 0; return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }
  function fmtUsd(v) { return v >= 100 ? '$' + v.toFixed(0) : '$' + v.toFixed(2); }
  function fmtDur(s) { s = Math.max(0, Math.round(s || 0)); if (s < 60) return s + 's'; var m = Math.floor(s / 60); if (m < 60) return m + 'm'; var hh = Math.floor(m / 60); return hh < 48 ? hh + 'h ' + (m % 60) + 'm' : Math.floor(hh / 24) + 'd'; }
  function now() { return state && state.server_time ? Date.parse(state.server_time) : Date.now(); }
  function ago(ts) { var t = Date.parse(ts); return isNaN(t) ? '' : fmtDur((now() - t) / 1000) + ' ago'; }
  function newTok(u) { return u ? (u.input || 0) + (u.output || 0) + (u.cache_write || 0) : 0; }
  function split(id) { var i = String(id).lastIndexOf('·'); return i < 0 ? [String(id), ''] : [id.slice(0, i), id.slice(i + 1)]; }
  function isSession(a) { return Array.isArray(a.capabilities) && a.capabilities.indexOf('claude-code') >= 0; }
  function statusOf(a) { return a.status === 'idle' && a.stuck ? 'stalled' : a.status; }

  /* ---------- theme (same key and cycle as the full dashboard) ---------- */
  var THEMES = { auto: ['◐', 'light'], light: ['☀', 'dark'], dark: ['☾', 'auto'] };
  function theme() { try { var t = localStorage.getItem(KEY_T); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; } }
  function paintTheme() { var t = theme(), b = $('m-theme'); b.textContent = THEMES[t][0]; b.setAttribute('aria-label', 'Theme: ' + t + '. Switch to ' + THEMES[t][1]); }
  $('m-theme').addEventListener('click', function () {
    var n = THEMES[theme()][1];
    try { if (n === 'auto') localStorage.removeItem(KEY_T); else localStorage.setItem(KEY_T, n); } catch (e) {}
    if (n === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', n);
    paintTheme();
  });
  paintTheme();

  /* ---------- filter ---------- */
  var segs = document.querySelectorAll('.m-seg button');
  function paintSeg() { segs.forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.f === filter)); }); }
  segs.forEach(function (b) { b.addEventListener('click', function () { filter = b.dataset.f; try { localStorage.setItem(KEY_F, filter); } catch (e) {} paintSeg(); render(); }); });
  paintSeg();

  /* ---------- render ---------- */
  function inMachine(x) { return machine === 'all' || (x.machine || 'local') === machine; }

  function renderTotals(agents) {
    var running = agents.filter(function (a) { return a.status === 'running'; }).length;
    var r = $('m-running'); r.textContent = String(running); r.appendChild(h('small', null, ' / ' + agents.length));
    $('m-tokens').textContent = fmtTok(agents.reduce(function (s, a) { return s + newTok(a.usage); }, 0));
    var c = state.cost || {}, ex = c.exact && typeof c.exact.total_usd === 'number' ? c.exact.total_usd : null;
    if (machine !== 'all') ex = null;
    var est = machine === 'all' ? c.total_usd_est : ((c.by_machine || {})[machine] || {}).total_usd_est;
    if (ex !== null) { $('m-cost').textContent = fmtUsd(ex); $('m-cost-k').textContent = 'Cost · exact'; }
    else if (typeof est === 'number') { $('m-cost').textContent = fmtUsd(est); $('m-cost-k').textContent = 'Cost · est.'; }
    else { $('m-cost').textContent = '–'; $('m-cost-k').textContent = 'Cost'; }
  }

  // Errored or stalled agents, plus needs-input alerts the agent has not moved past (no later event from it).
  function renderAttention(agents, alerts) {
    var items = [], seen = new Set(), byId = new Map(agents.map(function (a) { return [a.id, a]; }));
    agents.forEach(function (a) {
      var s = statusOf(a), n = split(a.id)[0];
      if (s === 'errored') { items.push({ cls: 'err', title: n, text: 'Error' + (a.error_kind ? ': ' + a.error_kind : ''), ts: a.last_event_at, p: a.project }); seen.add(a.id); }
      else if (s === 'stalled') { items.push({ cls: '', title: n, text: 'Stalled' + (a.stuck_for_s ? ' for ' + fmtDur(a.stuck_for_s) : ''), ts: a.last_event_at, p: a.project }); seen.add(a.id); }
    });
    alerts.slice().reverse().forEach(function (al) {
      if (al.kind !== 'needs_input' || seen.has(al.agent)) return;
      var a = byId.get(al.agent), t = Date.parse(al.ts);
      if (!a || now() - t > 2 * 3600e3) return;
      if (Date.parse(a.last_event_at) > t + 2000) return; // it carried on after asking
      seen.add(al.agent);
      items.push({ cls: '', title: split(al.agent)[0], text: 'Waiting for your input', ts: al.ts, p: al.project });
    });
    $('m-attn').hidden = !items.length;
    var ul = $('m-attn-list'); ul.textContent = '';
    items.forEach(function (it) {
      var li = h('li', it.cls), t = h('div', 'm-t');
      t.appendChild(h('b', null, it.title)); t.appendChild(h('span', null, it.text + (it.p ? ' · ' + it.p : '')));
      li.appendChild(t); li.appendChild(h('span', 'm-ago', ago(it.ts))); ul.appendChild(li);
    });
  }

  function renderMachines() {
    var ms = state.machines || [], nav = $('m-machines');
    nav.hidden = ms.length < 2; if (nav.hidden) { machine = 'all'; return; }
    if (machine !== 'all' && !ms.some(function (m) { return m.name === machine; })) machine = 'all';
    nav.textContent = '';
    [{ name: 'all', ok: true }].concat(ms).forEach(function (m) {
      var b = h('button'); b.type = 'button'; b.setAttribute('aria-pressed', String(m.name === machine));
      if (m.name !== 'all') b.appendChild(h('i', m.ok ? '' : 'down'));
      b.appendChild(document.createTextNode(m.name === 'all' ? 'All' : m.name + (m.totals ? ' · ' + m.totals.running + '/' + m.totals.agents : '')));
      if (!m.ok && m.error) b.title = m.error;
      b.addEventListener('click', function () { machine = m.name; render(); });
      nav.appendChild(b);
    });
  }

  function agentRow(a) {
    var s = statusOf(a), parts = split(a.id), li = h('div', 'm-ag s-' + s + (isSession(a) ? '' : ' sub') + (open.has(a.id) ? ' open' : ''));
    var row = h('button', 'm-row'); row.type = 'button'; row.setAttribute('aria-expanded', String(open.has(a.id)));
    row.appendChild(h('i', 'm-dot'));
    row.appendChild(h('span', 'm-name', parts[0]));
    row.appendChild(h('span', 'm-tok', fmtTok(newTok(a.usage))));
    var meta = h('span', 'm-meta');
    meta.appendChild(h('span', 'm-st', s));
    if (s === 'running' && a.current_tool && a.current_tool.name) {
      meta.appendChild(document.createTextNode(' · '));
      meta.appendChild(h('span', 'm-tool', a.current_tool.name + (a.current_tool.summary ? ' ' + a.current_tool.summary : '')));
    } else meta.appendChild(document.createTextNode(' · ' + ago(a.last_event_at)));
    if (a.model_label) meta.appendChild(document.createTextNode(' · ' + a.model_label));
    row.appendChild(meta);
    row.addEventListener('click', function () { if (open.has(a.id)) open.delete(a.id); else open.add(a.id); li.classList.toggle('open'); row.setAttribute('aria-expanded', String(open.has(a.id))); });
    li.appendChild(row);

    var det = h('div', 'm-det'), dl = h('dl'), u = a.usage || {};
    function kv(k, v) { if (v === '' || v == null) return; dl.appendChild(h('dt', null, k)); dl.appendChild(h('dd', null, v)); }
    kv('Kind', isSession(a) ? 'Session' : (a.role || 'Subagent'));
    kv('Id', parts[1]);
    if (a.machine && a.machine !== 'local') kv('Machine', a.machine);
    kv('Last activity', ago(a.last_event_at));
    kv('Ran', fmtDur(a.ran_s));
    kv('Tokens', fmtTok(u.input) + ' in · ' + fmtTok(u.output) + ' out · ' + fmtTok(u.cache_read) + ' cache');
    if (a.tok_per_min) kv('Rate', fmtTok(a.tok_per_min) + ' tok/min');
    var usd = typeof u.usd_exact_session === 'number' ? fmtUsd(u.usd_exact_session) + ' (exact)' : typeof u.usd_est === 'number' ? fmtUsd(u.usd_est) + ' (est.)' : '';
    kv('Cost', usd);
    if (a.goal_title) kv('Goal', a.goal_title);
    if (a.error_kind) kv('Error', a.error_kind);
    det.appendChild(dl);
    var tools = (a.recent_tools || []).slice(-6).reverse();
    if (tools.length) {
      det.appendChild(h('h3', null, 'Recent tools'));
      var ul = h('ul'); tools.forEach(function (t) { ul.appendChild(h('li', null, (t.name || '?') + (t.summary ? ' ' + t.summary : ''))); }); det.appendChild(ul);
    }
    var files = (a.files || []).slice(0, 8);
    if (files.length) {
      det.appendChild(h('h3', null, 'Files'));
      var fl = h('ul'); files.forEach(function (f) { fl.appendChild(h('li', null, typeof f === 'string' ? f : f.path || f.file || '')); }); det.appendChild(fl);
    }
    li.appendChild(det);
    return li;
  }

  function renderProjects(agents) {
    var box = $('m-projects'); box.textContent = '';
    var shown = filter === 'active' ? agents.filter(function (a) { return statusOf(a) !== 'idle'; }) : agents;
    if (!shown.length) {
      var p = h('p', 'm-empty', filter === 'active' && agents.length ? 'No agent active right now.' : 'No Claude Code activity yet.');
      box.appendChild(p); return;
    }
    var groups = new Map();
    shown.forEach(function (a) { var k = (a.machine || 'local') + '\u0000' + (a.project || '—'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); });
    var last = function (a) { return Date.parse(a.last_event_at) || 0; };
    var list = Array.from(groups.values()).map(function (as) {
      as.sort(function (x, y) { return (isSession(y) - isSession(x)) || (RANK[statusOf(x)] - RANK[statusOf(y)]) || (last(y) - last(x)); });
      return { as: as, running: as.filter(function (a) { return a.status === 'running'; }).length, last: Math.max.apply(null, as.map(last)) };
    });
    list.sort(function (x, y) { return (y.running - x.running) || (y.last - x.last); });
    list.forEach(function (g) {
      var sec = h('section', 'm-proj'), hd = h('header'), a0 = g.as[0];
      hd.appendChild(h('b', null, (a0.project || '—') + (a0.machine && a0.machine !== 'local' && machine === 'all' ? ' @' + a0.machine : '')));
      hd.appendChild(h('span', null, (g.running ? g.running + ' running · ' : '') + g.as.length + (g.as.length === 1 ? ' agent' : ' agents')));
      sec.appendChild(hd);
      g.as.forEach(function (a) { sec.appendChild(agentRow(a)); });
      box.appendChild(sec);
    });
  }

  function renderAlerts(alerts) {
    var list = alerts.slice(-15).reverse(), ul = $('m-alerts-list');
    $('m-alerts').hidden = !list.length; $('m-alerts-n').textContent = alerts.length ? String(alerts.length) : '';
    ul.textContent = '';
    list.forEach(function (al) { var li = h('li'); li.appendChild(h('span', null, al.text || al.kind)); li.appendChild(h('span', 'm-ago', ago(al.ts))); ul.appendChild(li); });
  }

  function render() {
    if (!state) return;
    renderMachines();
    var agents = (state.agents || []).filter(inMachine), alerts = (state.alerts || []).filter(inMachine);
    renderTotals(agents); renderAttention(agents, alerts); renderProjects(agents); renderAlerts(alerts);
    var hb = state.heartbeat || {}, live = $('m-live');
    live.className = 'm-live ' + (hb.liveness === 'alive' ? 'ok' : '');
    live.lastChild.textContent = hb.liveness === 'alive' ? 'Live' : 'Quiet';
    $('m-updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function poll() {
    fetch('/api/state', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (s) { state = s; failures = 0; render(); })
      .catch(function () {
        if (++failures < 2) return;
        var live = $('m-live'); live.className = 'm-live bad'; live.lastChild.textContent = 'Offline';
      });
  }
  poll();
  setInterval(function () { if (!document.hidden) poll(); }, POLL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
