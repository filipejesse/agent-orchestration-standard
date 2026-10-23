/* AOS-1 goals UI: GOALS panel (list, detail, plan review, approvals inbox, controls, new goal) + agent-drawer goal line.
 * Reads goals from the monitor (same origin: state.goals and GET /api/goals/:id). Writes go to the control server
 * (http://127.0.0.1:4319, Bearer token). The token is only ever sent to that origin, never to the monitor.
 * Vanilla ES5, no deps. Every string from either server is hostile: textContent / setAttribute of known-safe attributes only.
 */
(function () {
  'use strict';

  /* ---------------- config / helpers ---------------- */
  var CTRL = 'http://127.0.0.1:4319';
  try { var ov = document.documentElement.getAttribute('data-aos-control-url'); if (ov && /^https?:\/\/[^\s\/?#]+$/.test(ov)) CTRL = ov; } catch (e0) { /* keep default */ }
  var TOKEN_KEY = 'aos.orchToken';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var INSTRUCTION = 'run: aos-orch login-link and open the link';
  var SRV_DOWN = 'Control server not running: run aos-orch serve';

  function safe(fn, d) { try { return fn(); } catch (e) { return d; } }
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function svg(tag, attrs, txt) { var e = document.createElementNS(SVGNS, tag), k; for (k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]); if (txt != null) e.textContent = txt; return e; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function num(x, d) { x = Number(x); return isFinite(x) ? x : (d || 0); }
  function enc(s) { return encodeURIComponent(String(s)); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function hms(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function tsOf(x) { if (typeof x === 'number') return x < 1e12 ? x * 1000 : x; if (typeof x === 'string' && x) { var n = Date.parse(x); return isFinite(n) ? n : NaN; } return NaN; }
  function fmtN(n) {
    n = num(n);
    if (n >= 1e9) return trim1(n / 1e9) + 'B';
    if (n >= 1e6) return trim1(n / 1e6) + 'M';
    if (n >= 1e3) return trim1(n / 1e3) + 'K';
    return String(Math.round(n));
  }
  function trim1(v) { return v.toFixed(1).replace(/\.0$/, ''); }
  function fmtDur(s) {
    s = Math.max(0, Math.round(num(s)));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm' + (s % 60 ? pad(s % 60) + 's' : '');
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h + 'h' + (m ? pad(m) + 'm' : '');
  }
  function fmtCountdown(ms) {
    if (!isFinite(ms)) return '';
    var s = Math.floor(ms / 1000);
    if (s <= 0) return 'expired';
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return 'expires in ' + (h ? h + 'h ' + pad(m) + 'm' : m + 'm ' + pad(s % 60) + 's');
  }
  function fmtResume(v) {
    var t = tsOf(v); if (!isFinite(t)) return '';
    var d = new Date(t), now = new Date(), same = d.toDateString() === now.toDateString(), abs;
    try {
      abs = d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).replace(',', '');
      if (same) abs = abs.replace(/^\d+ \w+ /, '');
    } catch (e) { abs = (same ? '' : d.getDate() + '/' + (d.getMonth() + 1) + ' ') + hm(t); }
    var ms = t - now.getTime(), rel = '';
    if (ms > 0) { var mins = Math.round(ms / 60000), h = Math.floor(mins / 60); rel = 'in ' + (h ? h + 'h ' + (mins % 60) + 'm' : mins + 'm') + ' \u00b7 '; }
    return 'resumes ' + rel + abs;
  }
  function limitText(g) { var rs = fmtResume(g.resume_at).replace(/^resumes /, ''); return 'Paused by plan limit' + (rs ? ' \u2014 resumes ' + rs : ''); }
  function baseName(p) { var parts = String(p || '').split('/').filter(Boolean); return parts.length ? parts[parts.length - 1] : ''; }
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
  function arr(x) { return Array.isArray(x) ? x : []; }
  var G_ST = { draft: 1, planning: 1, active: 1, paused: 1, blocked: 1, achieved: 1, failed: 1, cancelled: 1 };
  var T_ST = { pending: 1, ready: 1, running: 1, done: 1, failed: 1, cancelled: 1, stalled: 1 };
  var TERMINAL = { achieved: 1, failed: 1, cancelled: 1 };
  var ORDER = { active: 0, planning: 1, blocked: 2, paused: 3, draft: 4, achieved: 5, failed: 6, cancelled: 7 };
  function stCls(prefix, set, v) { return prefix + (set[v] ? v : 'unknown'); }

  /* ---------------- state ---------------- */
  var app = null, replay = false;
  var goals = null, goalsSeen = false, lastLiveGoals = null;
  var panelOpen = false, view = 'list', curId = null;
  var detail = null, detailErr = null, detailLoading = false;
  var plan = null, planErr = null, planFor = null;
  var planUi = { hash: null, checked: false, rejecting: false, reason: '' };
  var appr = [], apprLoaded = false;
  var confirmMode = null, focusConfirm = false;
  var token = null;
  var ctl = { st: 'noToken', expired: false, srvDown: false };      /* noToken | idle | connecting | ok | down */
  var lastFocus = null;

  /* ---------------- token capture (URL fragment -> sessionStorage), done immediately ---------------- */
  (function captureToken() {
    var found = null;
    safe(function () {
      var h = location.hash || '';
      if (h.indexOf('aos_token=') < 0) return;
      var parts = h.slice(1).split('&'), keep = [], i;
      for (i = 0; i < parts.length; i++) {
        if (parts[i].indexOf('aos_token=') === 0) found = safe(function () { return decodeURIComponent(parts[i].slice(10)); }, null);
        else if (parts[i]) keep.push(parts[i]);
      }
      history.replaceState(history.state, '', location.pathname + location.search + (keep.length ? '#' + keep.join('&') : ''));
    });
    if (found && /^[\x21-\x7e]{8,512}$/.test(found)) { token = found; safe(function () { sessionStorage.setItem(TOKEN_KEY, found); }); }
    else token = safe(function () { return sessionStorage.getItem(TOKEN_KEY); }, null) || null;
    found = null;
    ctl.st = token ? 'idle' : 'noToken';
  })();
  function clearToken(expired) {
    token = null; safe(function () { sessionStorage.removeItem(TOKEN_KEY); });
    ctl.st = 'noToken'; ctl.expired = !!expired; apprLoaded = false; appr = []; plan = null;
  }

  /* ---------------- control server client ---------------- */
  function mkErr(code, status, message) { var e = new Error(message); e.code = code; e.status = status; return e; }
  function creq(method, path, body, signal) {
    if (!token) return Promise.reject(mkErr('no_token', 0, 'Not connected'));
    var init = { method: method, headers: { 'Authorization': 'Bearer ' + token }, cache: 'no-store', credentials: 'omit', mode: 'cors', signal: signal };
    if (method !== 'GET') { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body === undefined ? {} : body); }
    return fetch(CTRL + path, init).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (r.status === 401) { clearToken(true); refreshConn(); throw mkErr('unauthorized', 401, 'Session expired or invalid'); }
        if (!r.ok) { var er = (j && isObj(j.error)) ? j.error : {}; throw mkErr(String(er.code || 'http_' + r.status), r.status, clip(er.message || ('HTTP ' + r.status), 400)); }
        if (ctl.st !== 'ok') { ctl.st = 'ok'; ctl.expired = false; refreshConn(); }
        return j;
      });
    }, function (err) {
      if (err && err.name === 'AbortError') throw err;
      if (ctl.st !== 'down') { ctl.st = 'down'; refreshConn(); }
      throw mkErr('unreachable', 0, 'Control server unreachable');
    });
  }
  function writeOk() { return ctl.st === 'ok' && !replay; }
  function writeWhy() {
    if (replay) return 'Replay mode: controls are disabled.';
    if (ctl.st === 'noToken' && ctl.srvDown) return SRV_DOWN;
    if (ctl.st === 'noToken') return 'Not connected to the control server. ' + INSTRUCTION;
    if (ctl.st === 'down') return 'Control server unreachable: write actions are disabled.';
    if (ctl.st === 'connecting' || ctl.st === 'idle') return 'Connecting to the control server…';
    return '';
  }

  /* ---------------- derived data ---------------- */
  function goalList() { return arr(goals).filter(isObj); }
  function activeCount() { return goalList().filter(function (g) { return g.status === 'active'; }).length; }
  function pendingCount() {
    if (ctl.st === 'ok' && apprLoaded) return appr.length;
    return goalList().reduce(function (a, g) { return a + Math.max(0, num(g.approvals_pending)); }, 0);
  }
  function summaryOf(id) { var l = goalList(), i; for (i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function merged() {
    var s = summaryOf(curId), d = detail && detail.id === curId ? detail : null;
    if (!s && !d) return null;
    if (!d) return s;
    if (s && tsOf(s.updated_at) > tsOf(d.updated_at)) return Object.assign({}, d, s);
    return d;
  }
  function goalTitle(id) { var s = summaryOf(id); return s ? s.title : (detail && detail.id === id ? detail.title : id); }

  /* ---------------- UI scaffolding ---------------- */
  var R = {};   /* dom refs */
  function btn(label, cls, onClick) {
    var b = el('button', 'orch-btn' + (cls ? ' ' + cls : ''), label); b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  /* write button: disabled unless the control server is connected, not replaying, and the optional extra condition holds */
  function wbtn(label, cls, onClick, extraOk) {
    var b = btn(label, cls, function () { if (b.disabled || b._busy) return; onClick(b); });
    b.setAttribute('data-w', '1'); b._ok = extraOk || null; return b;
  }
  function applyWrite() {
    if (!R.panel) return;
    var ok = writeOk(), why = writeWhy(), bs = R.panel.querySelectorAll('[data-w]'), i, b, dis;
    for (i = 0; i < bs.length; i++) {
      b = bs[i]; dis = !ok || !!b._busy || (b._ok ? !b._ok() : false);
      b.disabled = dis;
      if (!ok) b.setAttribute('title', why); else b.removeAttribute('title');
    }
  }
  function sect(parent, key, cls) { var s = el('div', 'orch-sec' + (cls ? ' ' + cls : '')); s.setAttribute('data-sec', key); parent.appendChild(s); return s; }
  function paint(sec, sig, fn) { if (sec._sig === sig) return false; sec._sig = sig; clear(sec); fn(sec); applyWrite(); return true; }
  function label(parent, txt) { var h = el('h3', 'orch-h', txt); parent.appendChild(h); return h; }

  function toast(msg, bad) {
    if (!R.toasts) return;
    var t = el('div', 'orch-toast' + (bad ? ' bad' : ''), clip(msg, 300));
    if (bad) t.setAttribute('role', 'alert');
    R.toasts.appendChild(t);
    while (R.toasts.children.length > 3) R.toasts.removeChild(R.toasts.firstChild);
    setTimeout(function () { safe(function () { if (t.parentNode) t.parentNode.removeChild(t); }); }, bad ? 8000 : 4000);
  }
  function errToast(e) { toast(e && e.message ? e.message : 'Request failed', true); }

  function statusPill(prefix, set, v) {
    var p = el('span', 'orch-st ' + stCls(prefix, set, v), set[v] ? v : 'unknown');
    return p;
  }
  function meter(name, used, max, fmt, cls) {
    var u = Math.max(0, num(used)), m = Math.max(0, num(max)), pct = m > 0 ? Math.min(100, u / m * 100) : 0;
    var d = el('div', 'orch-meter' + (pct >= 90 ? ' hot' : '') + (cls ? ' ' + cls : ''));
    d.setAttribute('data-m', name);
    d.appendChild(el('span', 'orch-ml', name));
    var tr = el('span', 'orch-track'); var bar = el('i'); bar.style.width = pct.toFixed(2) + '%'; bar.setAttribute('data-pct', pct.toFixed(2)); tr.appendChild(bar); d.appendChild(tr);
    d.appendChild(el('span', 'orch-mv', fmt(u) + ' / ' + fmt(m)));
    d.setAttribute('role', 'meter'); d.setAttribute('aria-label', name + ' ' + fmt(u) + ' of ' + fmt(m));
    d.setAttribute('aria-valuemin', '0'); d.setAttribute('aria-valuemax', String(m)); d.setAttribute('aria-valuenow', String(u));
    return d;
  }
  function budgetMeters(parent, b) {
    b = isObj(b) ? b : {};
    var box = el('div', 'orch-meters');
    box.appendChild(meter('tokens', b.used_new_tokens, b.max_new_tokens, fmtN));
    box.appendChild(meter('wall', b.used_wall_s, b.max_wall_s, fmtDur));
    box.appendChild(meter('parallel', b.running, b.max_parallel, function (x) { return String(Math.round(x)); }));
    parent.appendChild(box);
  }

  /* ---------------- header control ---------------- */
  function buildHeaderBtn() {
    var top = document.querySelector('header.top'), theme = $('theme-btn');
    if (!top) return;
    var b = el('button', 'orch-hbtn'); b.type = 'button'; b.id = 'orch-btn'; b.hidden = true;
    b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'orch-panel'); b.setAttribute('aria-haspopup', 'dialog');
    b.appendChild(document.createTextNode('Goals'));
    R.n = el('b', 'orch-n tnum', '0'); b.appendChild(R.n);
    R.dot = el('i', 'orch-pdot'); R.dot.hidden = true; R.dot.setAttribute('aria-hidden', 'true'); b.appendChild(R.dot);
    if (theme && theme.parentNode === top) top.insertBefore(b, theme); else top.appendChild(b);
    b.addEventListener('click', function () { if (panelOpen) closePanel(); else openPanel(); });
    R.hbtn = b;
    var nb = el('button', 'orch-needs'); nb.type = 'button'; nb.id = 'needs-btn'; nb.hidden = true;
    nb.setAttribute('aria-haspopup', 'true'); nb.setAttribute('aria-expanded', 'false'); nb.setAttribute('aria-controls', 'needs-pop');
    R.needsN = el('b', 'tnum', '0'); nb.appendChild(document.createTextNode('Needs you ')); nb.appendChild(R.needsN);
    top.insertBefore(nb, b); R.needs = nb;
    var pop = el('div', 'orch-needs-pop'); pop.id = 'needs-pop'; pop.hidden = true; pop.setAttribute('role', 'region'); pop.setAttribute('aria-label', 'Waiting on you'); document.body.appendChild(pop); R.needsPop = pop;
    nb.addEventListener('click', function (e) { e.stopPropagation(); setNeedsOpen(pop.hidden); });
    document.addEventListener('click', function (e) { if (!pop.hidden && !pop.contains(e.target)) setNeedsOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden) { setNeedsOpen(false); nb.focus(); } });
    updateHeader();
  }
  function setNeedsOpen(on) { if (!R.needsPop) return; R.needsPop.hidden = !on; R.needs.setAttribute('aria-expanded', String(!!on)); if (on) renderNeeds(); }
  function renderNeeds() {
    var nd = window.AOSNeeds.compute(orchOn() ? goalList() : [], verdictSum), pop = R.needsPop; clear(pop);
    nd.items.forEach(function (it) {
      var b = el('button', 'orch-needs-it'); b.type = 'button'; b.setAttribute('data-id', it.id); b.setAttribute('data-kind', it.kind);
      b.appendChild(el('span', 'orch-needs-t', clip(it.title, 80))); b.appendChild(el('span', 'orch-needs-w', it.text));
      b.addEventListener('click', function () { setNeedsOpen(false); if (it.kind === 'integrity') { if (window.AOSGuard && window.AOSGuard.open) window.AOSGuard.open(it.id); return; } if (!panelOpen) openPanel(); goDetail(it.id); });
      pop.appendChild(b);
    });
  }
  /* the orchestrator UI (GOALS button, Needs you badge) only shows for users who have it: at least one goal, or the control server answers /api/health */
  var ctlUp = false, presTimer = null;
  function orchOn() { return goalList().length > 0 || ctlUp; }
  function checkPresence() {
    var ac = window.AbortController ? new AbortController() : null, to = ac ? setTimeout(function () { ac.abort(); }, 3000) : null;
    fetch(CTRL + '/api/health', { cache: 'no-store', credentials: 'omit', mode: 'cors', signal: ac ? ac.signal : undefined })
      .then(function () { return true; }, function () { return false; })
      .then(function (up) { if (to) clearTimeout(to); if (up !== ctlUp) { ctlUp = up; updateHeader(); } });
  }
  function startPresence() { checkPresence(); if (!presTimer) presTimer = setInterval(checkPresence, 30000); }
  function updateHeader() {
    if (!R.hbtn) return;
    var on = orchOn(); R.hbtn.hidden = !on;
    /* Needs you also carries guard integrity rejections, so it can show without any goal */
    var nd = window.AOSNeeds ? window.AOSNeeds.compute(on ? goalList() : [], verdictSum) : { total: 0 };
    if (!on) { if (panelOpen) closePanel(); }
    if (R.needs) { R.needs.hidden = nd.total <= 0; R.needsN.textContent = String(nd.total); R.needs.setAttribute('aria-label', 'Needs you: ' + nd.total + (nd.total === 1 ? ' item' : ' items') + ' waiting on you'); if (nd.total <= 0) setNeedsOpen(false); else if (!R.needsPop.hidden) renderNeeds(); }
    if (!on) return;
    var n = activeCount(), p = pendingCount();
    R.n.textContent = n + ' active'; R.dot.hidden = p <= 0;
    R.hbtn.setAttribute('aria-label', 'Goals: ' + n + ' active' + (p > 0 ? ', ' + p + ' approval' + (p === 1 ? '' : 's') + ' pending' : '') + (panelOpen ? '. Close goals panel' : '. Open goals panel'));
    R.hbtn.classList.toggle('on', panelOpen); R.hbtn.setAttribute('aria-expanded', String(panelOpen));
  }

  /* ---------------- panel ---------------- */
  function buildPanel() {
    var p = el('aside', 'orch-panel'); p.id = 'orch-panel'; p.hidden = true;
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-labelledby', 'orch-title'); p.setAttribute('aria-modal', 'false');
    var head = el('div', 'orch-head');
    R.back = btn('Back', 'orch-back', function () { goList(); }); R.back.hidden = true; R.back.setAttribute('aria-label', 'Back to goals');
    R.title = el('h2', 'orch-title', 'Goals'); R.title.id = 'orch-title';
    R.close = el('button', 'icon-btn orch-x'); R.close.type = 'button'; R.close.setAttribute('aria-label', 'Close goals panel');
    R.close.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke-width="1.8" stroke-linecap="round"/></svg>'; /* static markup, no data */
    R.close.addEventListener('click', closePanel);
    head.appendChild(R.back); head.appendChild(R.title); head.appendChild(R.close);
    R.conn = el('div', 'orch-conn'); R.conn.setAttribute('role', 'status');
    R.body = el('div', 'orch-pbody');
    R.toasts = el('div', 'orch-toasts'); R.toasts.setAttribute('aria-live', 'polite');
    p.appendChild(head); p.appendChild(R.conn); p.appendChild(R.body); p.appendChild(R.toasts);
    document.body.appendChild(p); R.panel = p;

    R.vList = el('div', 'orch-view'); R.vDetail = el('div', 'orch-view'); R.vForm = el('div', 'orch-view');
    R.body.appendChild(R.vList); R.body.appendChild(R.vDetail); R.body.appendChild(R.vForm);
    R.sNew = sect(R.vList, 'new'); R.sInbox = sect(R.vList, 'inbox'); R.sList = sect(R.vList, 'list');
    var names = ['head', 'ctl', 'plan', 'appr', 'crit', 'rules', 'budget', 'integ', 'dag', 'tasks', 'events'];
    R.d = {}; names.forEach(function (n) { R.d[n] = sect(R.vDetail, n); });
    buildForm();

    p.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (confirmMode) { confirmMode = null; paintCtl(true); return; }
      if (view === 'new' || view === 'detail') { goList(); return; }
      closePanel();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panelOpen && !e.defaultPrevented && !R.panel.contains(e.target)) closePanel();
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) stopPolling(); else if (panelOpen) startPolling(); });
    setInterval(tick, 1000);
  }

  function refreshConn() {
    if (!R.conn) { updateHeader(); return; }
    var c = R.conn, msg = '', cls = '';
    if (replay) { msg = 'Replay mode: controls are disabled.'; cls = 'info'; }
    else if (ctl.st === 'noToken' && ctl.srvDown) { msg = SRV_DOWN; cls = 'bad'; }
    else if (ctl.st === 'noToken') { msg = (ctl.expired ? 'Session expired. ' : 'Not connected. ') + INSTRUCTION; cls = 'warn'; }
    else if (ctl.st === 'down') { msg = 'Control server unreachable. Goals are still shown from the monitor; write actions are disabled until it is back.'; cls = 'bad'; }
    else if (ctl.st === 'connecting' || ctl.st === 'idle') { msg = 'Connecting to the control server…'; cls = 'info'; }
    c.hidden = !msg; c.className = 'orch-conn ' + cls;
    if (c.textContent !== msg) {
      clear(c);
      if (ctl.st === 'noToken' && !ctl.srvDown && !replay) {
        c.appendChild(document.createTextNode((ctl.expired ? 'Session expired. ' : 'Not connected. ')));
        var code = el('code', 'orch-code', INSTRUCTION); c.appendChild(code);
      } else c.appendChild(document.createTextNode(msg));
    }
    c.setAttribute('data-state', replay ? 'replay' : ctl.st);
    applyWrite(); updateHeader();
  }

  function openPanel() {
    if (panelOpen) return;
    safe(function () { if (window.AOSGuard && window.AOSGuard.close) window.AOSGuard.close(); }); /* one side panel at a time */
    if (!R.panel) buildPanel();
    panelOpen = true; lastFocus = document.activeElement;
    if (token && ctl.st !== 'ok') ctl.st = 'connecting';
    R.panel.hidden = false; R.panel.classList.remove('closing');
    refreshConn(); renderAll(); startPolling();
    R.close.focus();
  }
  function closePanel() {
    if (!panelOpen) return;
    panelOpen = false; stopPolling(); R.panel.hidden = true; confirmMode = null;
    updateHeader();
    if (lastFocus && document.body.contains(lastFocus)) safe(function () { lastFocus.focus(); }); else if (R.hbtn) R.hbtn.focus();
  }

  /* ---------------- navigation ---------------- */
  function goList() { view = 'list'; curId = null; detail = null; detailErr = null; plan = null; confirmMode = null; renderAll(); startPolling(); focusTop(); }
  function goDetail(id) {
    view = 'detail'; curId = id; detail = null; detailErr = null; detailLoading = true; plan = null; planErr = null; confirmMode = null; planUi = { hash: null, checked: false, rejecting: false, reason: '' };
    clearDetailSecs(); renderAll(); startPolling(); focusTop();
  }
  function goNew() { view = 'new'; renderAll(); stopPolling(); startPolling(); focusTop(); safe(function () { F.title.focus(); }); }
  function focusTop() { safe(function () { R.body.scrollTop = 0; }); }
  function clearDetailSecs() { Object.keys(R.d).forEach(function (k) { R.d[k]._sig = null; clear(R.d[k]); }); }

  /* ---------------- polling ---------------- */
  var P = { dT: null, dA: null, dSeq: 0, cT: null, cA: null, cSeq: 0 };
  function canPoll() { return panelOpen && !document.hidden; }
  function stopPolling() {
    clearTimeout(P.dT); clearTimeout(P.cT); P.dSeq++; P.cSeq++;
    safe(function () { if (P.dA) P.dA.abort(); }); safe(function () { if (P.cA) P.cA.abort(); });
    P.dA = P.cA = null;
  }
  function startPolling() { pollDetail(); pollCtl(); }
  function pollDetail() {
    clearTimeout(P.dT); safe(function () { if (P.dA) P.dA.abort(); }); P.dA = null;
    if (!canPoll() || view !== 'detail' || !curId) return;
    var my = ++P.dSeq, id = curId, ac = window.AbortController ? new AbortController() : null; P.dA = ac;
    fetch('/api/goals/' + enc(id), { cache: 'no-store', credentials: 'same-origin', signal: ac ? ac.signal : undefined })
      .then(function (r) {
        if (r.status === 404) { var e = new Error('Goal not found. It may have been removed.'); e.code = 'nf'; throw e; }
        if (!r.ok) throw new Error('Monitor returned HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (my !== P.dSeq || id !== curId) return;
        if (j && isObj(j.goal)) { detail = j.goal; detailErr = null; } else detailErr = 'Unexpected response from the monitor.';
        detailLoading = false; renderDetail();
      }, function (err) {
        if (my !== P.dSeq || (err && err.name === 'AbortError')) return;
        detailLoading = false; detailErr = err && err.code === 'nf' ? err.message : 'Monitor unreachable: showing the last known data.'; renderDetail();
      })
      .then(function () { if (my !== P.dSeq) return; P.dA = null; P.dT = setTimeout(pollDetail, 3000); });
  }
  function needPlan() { var g = merged(); return view === 'detail' && g && g.plan_state === 'awaiting_approval'; }
  function pollCtl() {
    clearTimeout(P.cT); safe(function () { if (P.cA) P.cA.abort(); }); P.cA = null;
    if (!canPoll()) return;
    if (!token) { probe(); return; }
    var my = ++P.cSeq, ac = window.AbortController ? new AbortController() : null; P.cA = ac; var sig = ac ? ac.signal : undefined;
    var wantPlan = needPlan(), pid = curId;
    var mk1 = function () { return creq('GET', '/api/approvals', undefined, sig).then(function (j) {
      if (my !== P.cSeq) return;
      appr = arr(j && j.approvals).filter(function (a) { return isObj(a) && (a.status == null || a.status === 'pending'); }); apprLoaded = true; renderApprovals(); updateHeader();
    }); };
    var mk2 = function () { return wantPlan ? creq('GET', '/api/goals/' + enc(pid) + '/plan', undefined, sig).then(function (j) {
      if (my !== P.cSeq || pid !== curId) return;
      plan = isObj(j) ? j : null; planErr = null; planFor = pid; renderPlan();
    }, function (e) {
      if (my !== P.cSeq || (e && e.name === 'AbortError')) return;
      if (e && e.status === 401) throw e;
      planErr = e && e.message ? e.message : 'Plan unavailable'; renderPlan();
    }) : Promise.resolve(); };
    var pre = ctl.st === 'ok' ? Promise.resolve() : creq('GET', '/api/health', undefined, sig);
    pre.then(function () { return Promise.all([mk1(), mk2()]); }).catch(function (e) { /* connection state is handled in creq */ void e; })
      .then(function () { if (my !== P.cSeq) return; P.cA = null; renderConnected(); if (token) P.cT = setTimeout(pollCtl, 2000); });
  }
  /* no token yet: tell 'server not running' from 'not connected' with an unauthenticated probe (401 = up) */
  function probe() {
    var my = ++P.cSeq, ac = window.AbortController ? new AbortController() : null; P.cA = ac;
    fetch(CTRL + '/api/health', { cache: 'no-store', credentials: 'omit', mode: 'cors', signal: ac ? ac.signal : undefined }).then(function () { return false; }, function (e) { if (e && e.name === 'AbortError') return null; return true; })
      .then(function (down) {
        if (my !== P.cSeq || down === null) return;
        if (!token) { var ch = ctl.srvDown !== down; ctl.srvDown = down; if (ch) refreshConn(); }
        P.cA = null; if (!token) P.cT = setTimeout(pollCtl, 2000);
      });
  }
  function renderConnected() { applyWrite(); }

  function tick() {
    safe(function () { var r = !!(app && app.isLive && !app.isLive()); if (r !== replay) { replay = r; refreshConn(); } });
    if (!panelOpen || !R.panel) return;
    var ns = R.panel.querySelectorAll('[data-exp]'), i, t;
    for (i = 0; i < ns.length; i++) { t = fmtCountdown(Number(ns[i].getAttribute('data-exp')) - Date.now()); if (ns[i].textContent !== t) ns[i].textContent = t; }
  }

  /* ---------------- rendering: dispatch ---------------- */
  function renderAll() {
    if (!R.panel) return;
    R.vList.hidden = view !== 'list'; R.vDetail.hidden = view !== 'detail'; R.vForm.hidden = view !== 'new';
    R.back.hidden = view === 'list';
    R.title.textContent = view === 'list' ? 'Goals' : view === 'new' ? 'New goal' : clip((merged() || {}).title || 'Goal', 80);
    if (view === 'list') { renderListView(); } else if (view === 'detail') renderDetail();
    refreshConn(); applyWrite();
  }
  function renderListView() { renderNewBtn(); renderApprovals(); renderGoalList(); }

  function renderNewBtn() {
    paint(R.sNew, 'n', function (s) {
      var b = wbtn('+ New goal', 'primary', function () { goNew(); }); b.setAttribute('data-act', 'new-goal');
      b.setAttribute('aria-label', 'New goal'); s.appendChild(b);
    });
  }

  /* ---- goal list ---- */
  function renderGoalList() {
    if (!R.sList || view !== 'list') return;
    var list = goalList().slice().sort(function (a, b) {
      var oa = ORDER[a.status], ob = ORDER[b.status]; oa = oa == null ? 9 : oa; ob = ob == null ? 9 : ob;
      return oa !== ob ? oa - ob : (tsOf(b.updated_at) || 0) - (tsOf(a.updated_at) || 0);
    });
    var sig = JSON.stringify([goalsSeen, list]);
    paint(R.sList, sig, function (s) {
      if (!goalsSeen) { s.appendChild(el('p', 'orch-empty', 'Loading goals…')); return; }
      if (!list.length) { s.appendChild(el('p', 'orch-empty', 'No goals yet.')); return; }
      var ul = el('ul', 'orch-goals');
      list.forEach(function (g) { ul.appendChild(goalRow(g)); });
      s.appendChild(ul);
    });
  }
  /* rule-set chip (read-only): profile, hash, loosenings. Data comes from the monitor's GoalSummary.rules (counts and a 12-char hash only). */
  function rulesChip(r) {
    var n = num(r.loosenings), dr = num(r.dropped);
    var c = el('span', 'orch-rules tnum', clip(r.profile || 'strict', 24) + ' \u00b7 ' + clip(r.hash, 12) + (n ? ' \u00b7 ' + n + (n === 1 ? ' loosening' : ' loosenings') : ''));
    c.setAttribute('data-rules', String(clip(r.hash, 12)));
    c.title = 'Rule set ' + clip(r.hash, 12) + (r.legacy ? ' (legacy goal)' : '') + (dr ? '; ' + dr + ' repo loosening' + (dr === 1 ? '' : 's') + ' not applied' : '');
    return c;
  }
  /* integrity (anti-cheat) badges, read-only. Data: GoalSummary.integrity {status,failed_attempts,warning_attempts,kinds}, tasks[].integrity {status,reasons[]},
     tasks[].attempt_log[]. Everything is set with textContent; unknown/missing fields render nothing (old goals). */
  var INTEG_OK = { clean: 1, warning: 1, failed: 1 };
  function integChip(st, label) {
    st = INTEG_OK[st] ? st : 'clean';
    var c = el('span', 'orch-integ orch-integ-' + st, label || ('integrity: ' + st)); c.setAttribute('data-integrity', st); return c;
  }
  function reasonChips(parent, reasons) {
    arr(reasons).slice(0, 8).forEach(function (k) { var c = el('span', 'orch-reason', clip(String(k).replace(/_/g, ' '), 40)); c.setAttribute('data-reason', String(clip(k, 40))); parent.appendChild(c); });
  }
  function textDetails(label, text, cls) {
    var d = el('details', 'orch-fold ' + (cls || '')); d.appendChild(el('summary', null, label)); d.appendChild(el('pre', 'orch-pre', clip(text, 2000))); return d;
  }
  function goalRow(g) {
    var li = el('li'); var b = el('button', 'orch-goal'); b.type = 'button'; b.setAttribute('data-id', String(g.id));
    b.setAttribute('aria-label', 'Open goal: ' + clip(g.title, 120) + ', ' + (G_ST[g.status] ? g.status : 'unknown'));
    var r1 = el('span', 'orch-r1');
    r1.appendChild(statusPill('st-', G_ST, g.status));
    r1.appendChild(el('span', 'orch-gt', clip(g.title, 300)));
    b.appendChild(r1);
    var r2 = el('span', 'orch-r2');
    if (g.repo_name) r2.appendChild(el('span', 'orch-repo', clip(g.repo_name, 80)));
    if (isObj(g.rules)) r2.appendChild(rulesChip(g.rules));
    if (isObj(g.integrity) && g.integrity.checked && g.integrity.status !== 'clean') r2.appendChild(integChip(g.integrity.status));
    var td = num(g.tasks_done), tt = num(g.tasks_total);
    var pr = el('span', 'orch-prog tnum', td + '/' + tt + ' tasks'); pr.setAttribute('data-prog', td + '/' + tt); r2.appendChild(pr);
    if (num(g.tasks_failed) > 0) r2.appendChild(el('span', 'orch-failed tnum', g.tasks_failed + ' failed'));
    if (num(g.approvals_pending) > 0) { var ab = el('span', 'orch-abadge tnum', g.approvals_pending + (num(g.approvals_pending) === 1 ? ' approval' : ' approvals')); r2.appendChild(ab); }
    b.appendChild(r2);
    var pb = el('span', 'orch-pbar'); var pi = el('i'); pi.style.width = (tt > 0 ? Math.min(100, td / tt * 100) : 0).toFixed(2) + '%'; pb.appendChild(pi); b.appendChild(pb);
    budgetMeters(b, g.budget);
    var why = [];
    if (g.paused_reason) why.push(clip(g.paused_reason, 160));
    var rs = fmtResume(g.resume_at); if (rs) why.push(rs);
    if (num(g.out_of_scope_count) > 0) { var oc = el('span', 'orch-oos tnum', num(g.out_of_scope_count) + ' out of scope'); oc.title = 'Tasks with an attempt rejected for changing files outside their path_scope'; r2.appendChild(oc); }
    if (g.limit_paused) b.appendChild(el('span', 'orch-why orch-limit', limitText(g) + (num(g.rerun_count) ? ' · ' + g.rerun_count + ' to rerun' : '')));
    else if (why.length) b.appendChild(el('span', 'orch-why', why.join(' · ')));
    b.addEventListener('click', function () { goDetail(g.id); });
    li.appendChild(b); return li;
  }

  /* ---- approvals inbox ---- */
  function renderApprovals() {
    if (!R.panel) return;
    if (view === 'list') paintApprovals(R.sInbox, null);
    else if (view === 'detail') paintApprovals(R.d.appr, curId);
  }
  function paintApprovals(sec, goalId) {
    var list = appr.filter(function (a) { return goalId == null || a.goal_id === goalId; });
    var titles = list.map(function (a) { return goalTitle(a.goal_id); });
    var sig = JSON.stringify([list, titles, ctl.st === 'ok' && apprLoaded]);
    paint(sec, sig, function (s) {
      if (!list.length) return;
      label(s, 'Approvals (' + list.length + ')');
      var ul = el('ul', 'orch-appr');
      list.forEach(function (a) { ul.appendChild(approvalCard(a)); });
      s.appendChild(ul);
    });
  }
  function approvalCard(a) {
    var li = el('li', 'orch-acard'); li.setAttribute('data-aid', String(a.id));
    var h = el('div', 'orch-ah');
    h.appendChild(el('span', 'orch-kind', clip(a.kind, 40)));
    h.appendChild(el('span', 'orch-agoal', clip(goalTitle(a.goal_id), 120) + (a.task_id ? ' · ' + clip(a.task_id, 60) : '')));
    li.appendChild(h);
    li.appendChild(el('p', 'orch-asum', clip(a.summary, 1500)));
    var m = el('div', 'orch-ameta');
    if (a.cwd) { var c = el('span', 'orch-cwd', baseName(a.cwd) || '/'); c.setAttribute('title', clip(a.cwd, 300)); m.appendChild(c); }
    var exp = tsOf(a.expires_at);
    if (isFinite(exp)) { var cd = el('span', 'orch-cd tnum', fmtCountdown(exp - Date.now())); cd.setAttribute('data-exp', String(exp)); m.appendChild(cd); }
    li.appendChild(m);
    var row = el('div', 'orch-arow');
    function decide(kind, scope) {
      return function (b) {
        b._busy = true; applyWrite();
        creq('POST', '/api/approvals/' + enc(a.id) + '/' + kind, { scope: scope }).then(function () {
          toast(kind === 'approve' ? 'Approved (' + scope + ')' : 'Denied');
          appr = appr.filter(function (x) { return x.id !== a.id; }); renderApprovals(); updateHeader(); pollCtl(); pollDetail();
        }, function (e) { b._busy = false; applyWrite(); errToast(e); });
      };
    }
    var b1 = wbtn('Approve once', 'primary', decide('approve', 'once')); b1.setAttribute('data-act', 'approve-once');
    var b2 = wbtn('Approve for task', '', decide('approve', 'task')); b2.setAttribute('data-act', 'approve-task');
    var b3 = wbtn('Deny', 'danger', decide('deny', 'once')); b3.setAttribute('data-act', 'deny');
    row.appendChild(b1); row.appendChild(b2); row.appendChild(b3); li.appendChild(row);
    return li;
  }

  /* ---- detail ---- */
  function renderDetail() {
    if (!R.panel || view !== 'detail') return;
    var g = merged();
    R.title.textContent = clip((g || {}).title || 'Goal', 80);
    var D = R.d;
    if (!g) {
      var msg = detailErr || (detailLoading ? 'Loading goal…' : 'Goal not found.');
      paint(D.head, 'nf|' + msg, function (s) { s.appendChild(el('p', 'orch-empty', msg)); });
      ['ctl', 'plan', 'appr', 'crit', 'rules', 'budget', 'integ', 'dag', 'tasks', 'events'].forEach(function (k) { paint(D[k], 'none', function () {}); });
      return;
    }
    var d = detail && detail.id === g.id ? detail : null;
    paint(D.head, JSON.stringify([g.title, g.status, g.repo_name, g.plan_state, g.paused_reason, g.resume_at, g.limit_paused, d && d.description, d && arr(d.tasks).filter(function (t) { return t.rerun; }).map(function (t) { return t.id + t.title; }), detailErr, g.created_at]), function (s) {
      var r = el('div', 'orch-dh');
      r.appendChild(statusPill('st-', G_ST, g.status));
      if (g.repo_name) r.appendChild(el('span', 'orch-repo', clip(g.repo_name, 80)));
      if (g.plan_state && g.plan_state !== 'none') r.appendChild(el('span', 'orch-ps', 'plan: ' + clip(g.plan_state, 24).replace(/_/g, ' ')));
      s.appendChild(r);
      s.appendChild(el('h3', 'orch-gtitle', clip(g.title, 400)));
      var why = []; if (g.paused_reason) why.push(clip(g.paused_reason, 300)); var rs = fmtResume(g.resume_at); if (rs) why.push(rs);
      if (g.limit_paused) {
        var bn = el('div', 'orch-limit-banner'); bn.setAttribute('role', 'status');
        bn.appendChild(el('strong', null, limitText(g)));
        if (g.paused_reason) bn.appendChild(el('span', 'orch-why', clip(g.paused_reason, 300)));
        var rr = d ? arr(d.tasks).filter(function (t) { return t && t.rerun; }) : [];
        if (rr.length) {
          bn.appendChild(el('span', 'orch-why', 'Interrupted, will rerun (' + rr.length + '):'));
          var ul = el('ul', 'orch-rerun'); rr.slice(0, 50).forEach(function (t) { ul.appendChild(el('li', null, clip(t.id, 40) + ' \u00b7 ' + clip(t.title, 120) + (t.tier ? ' \u00b7 ' + clip(t.tier, 20) : ''))); }); bn.appendChild(ul);
        }
        s.appendChild(bn);
      } else if (why.length) s.appendChild(el('p', 'orch-why', why.join(' · ')));
      if (d && d.description) s.appendChild(el('p', 'orch-desc', clip(d.description, 6000)));
      if (detailErr) s.appendChild(el('p', 'orch-note', detailErr));
    });
    paintCtl(false);
    renderPlan();
    renderApprovals();
    paint(D.crit, JSON.stringify([g.id, d && d.criteria]), function (s) {
      var cr = arr(d && d.criteria).filter(isObj);
      if (!d) { return; }
      label(s, 'Success criteria');
      if (!cr.length) { s.appendChild(el('p', 'orch-muted', 'None defined.')); return; }
      var ul = el('ul', 'orch-crit');
      cr.forEach(function (c) {
        var li = el('li', c.met ? 'met' : ''); li.appendChild(el('span', 'sr-only', c.met ? 'Met: ' : 'Not met: '));
        li.appendChild(el('span', 'orch-ck', c.met ? '✓' : '○')); li.lastChild.setAttribute('aria-hidden', 'true');
        var ct = el('span', 'orch-ct', clip(c.text || c.id, 600));
        if (c.verify === 'human') { /* read-only: a human confirms these with the CLI (aos-orch confirm), never from this panel */
          var hb = el('span', 'orch-human', c.needs_confirmation ? 'needs confirmation' : 'human review'); hb.setAttribute('data-human', c.needs_confirmation ? 'pending' : 'done');
          if (c.needs_confirmation) hb.title = 'Blocks the goal from finishing until a human confirms it: aos-orch confirm ' + clip(g.id, 80) + ' ' + clip(c.id, 40);
          ct.appendChild(document.createTextNode(' ')); ct.appendChild(hb);
        }
        li.appendChild(ct); ul.appendChild(li);
      });
      s.appendChild(ul);
    });
    paint(D.rules, JSON.stringify(d && d.rules), function (s) {
      var r = d && d.rules; if (!isObj(r)) return;
      label(s, 'Rules'); s.appendChild(rulesChip(r));
      var ly = arr(r.layers).filter(isObj);
      if (ly.length) s.appendChild(el('p', 'orch-muted tnum', 'layers: ' + ly.map(function (l) { return clip(l.layer, 16) + (l.sha12 ? '(' + clip(l.sha12, 6) + ')' : ''); }).join(' ')));
      function idList(title, items, cls) {
        items = arr(items).filter(isObj); if (!items.length) return;
        s.appendChild(el('p', 'orch-muted', title + ' (' + items.length + ')'));
        var ul = el('ul', 'orch-ruleids ' + cls); items.slice(0, 30).forEach(function (x) { ul.appendChild(el('li', null, clip(x.rule_id, 160))); }); s.appendChild(ul);
      }
      idList('Loosenings approved with the plan', r.loosening_ids, 'lo'); idList('Repo loosenings not applied', r.dropped_ids, 'dr');
    });
    paint(D.budget, JSON.stringify([g.budget, g.outcome]), function (s) {
      label(s, 'Budget'); budgetMeters(s, g.budget); outcomeLine(s, g.outcome);
      var b = g.budget || {}; if (b.max_attempts != null) s.appendChild(el('p', 'orch-muted tnum', 'max attempts per task: ' + num(b.max_attempts)));
    });
    paint(D.integ, JSON.stringify([g.integrity, d && d.protected_tests, d && d.review, d && d.claude_version_start]), function (s) {
      var I = g.integrity; if (!isObj(I) || !d) return;
      label(s, 'Integrity');
      var row = el('p', 'orch-integrow'); row.appendChild(integChip(I.status));
      var kinds = isObj(I.kinds) ? Object.keys(I.kinds).slice(0, 8) : []; reasonChips(row, kinds); s.appendChild(row);
      if (!I.checked) s.appendChild(el('p', 'orch-muted', 'No anti-cheat data recorded for this goal.'));
      var pt = d.protected_tests;
      if (isObj(pt)) {
        var pl = el('p', 'orch-muted tnum orch-prot', 'protected tests: ' + (pt.ok ? 'passed' : 'FAILED') + ' (' + num(pt.files) + ' file' + (num(pt.files) === 1 ? '' : 's') + (num(pt.not_executed) ? ', ' + num(pt.not_executed) + ' not executed' : '') + ')');
        pl.setAttribute('data-protected', pt.ok ? 'ok' : 'failed'); s.appendChild(pl);
        if (!pt.ok && pt.output) s.appendChild(textDetails('protected test output', pt.output, 'orch-err'));
      }
      if (d.claude_version_start) s.appendChild(el('p', 'orch-muted tnum', 'claude ' + clip(d.claude_version_start, 40)));
      var rv = d.review;
      if (isObj(rv)) s.appendChild(textDetails('Reviewer notes (advisory, model-written, not verified)' + (rv.tier ? ' \u00b7 ' + clip(rv.tier, 20) : ''), rv.error ? 'The advisory review did not complete: ' + rv.error : (rv.text || '(empty)'), 'orch-review'));
    });
    var tasks = arr(d && d.tasks).filter(isObj);
    paint(D.dag, JSON.stringify(tasks.map(function (t) { return [t.id, t.status, t.tier, t.depends_on, t.attempts, t.max_attempts, t.title]; })), function (s) {
      if (!d) return;
      label(s, 'Task graph'); if (!tasks.length) { s.appendChild(el('p', 'orch-muted', 'No tasks yet.')); return; }
      s.appendChild(buildDag(tasks));
    });
    paint(D.tasks, JSON.stringify(tasks), function (s) {
      if (!d) return;
      label(s, 'Tasks (' + tasks.length + ')'); if (!tasks.length) return;
      var ul = el('ul', 'orch-tasks'); tasks.forEach(function (t) { ul.appendChild(taskRow(t)); }); s.appendChild(ul);
    });
    var evs = arr(d && d.last_events).filter(isObj);
    paint(D.events, JSON.stringify(evs), function (s) {
      if (!d) return;
      label(s, 'Recent events'); if (!evs.length) { s.appendChild(el('p', 'orch-muted', 'No events yet.')); return; }
      var ul = el('ul', 'orch-events');
      evs.slice(-12).reverse().forEach(function (e) {
        var li = el('li'); var t = tsOf(e.ts);
        li.appendChild(el('time', 'orch-et tnum', isFinite(t) ? hms(t) : ''));
        li.appendChild(el('span', 'orch-ety', clip(e.type, 60)));
        if (e.task_id) li.appendChild(el('span', 'orch-etask', clip(e.task_id, 60)));
        if (e.text) li.appendChild(el('span', 'orch-etx', clip(e.text, 500)));
        ul.appendChild(li);
      });
      s.appendChild(ul);
    });
    applyWrite();
  }

  function fmtUsd(v) { return '$' + Number(v).toFixed(v < 1 ? 4 : 2); }
  function outcomeLine(parent, o) {
    if (!isObj(o)) return;
    var bits = ['merged ' + num(o.merged) + ' · discarded ' + num(o.discarded)];
    if (o.tokens_per_accepted != null) bits.push(fmtN(o.tokens_per_accepted) + ' tok per accepted result');
    if (o.cost_usd != null) bits.push('cost ' + fmtUsd(num(o.cost_usd)));
    parent.appendChild(el('p', 'orch-muted tnum orch-outcome', bits.join(' · ')));
    if (o.waiting_s != null) parent.appendChild(el('p', 'orch-waitnote tnum', 'Waiting on you for ' + fmtDur(o.waiting_s) + (o.waiting_on === 'plan' ? ' (plan approval)' : ' (approval)')));
  }
  function outcomeWord(t) {
    var o = t.outcome, tp = arr(t.tier_path).map(function (x) { return tierWord(x); });
    if (o === 'escalated') return 'escalated ' + tp.join(' → ') + (num(t.retries) ? ' · ' + num(t.retries) + (num(t.retries) === 1 ? ' retry' : ' retries') : '');
    if (o === 'retried') return 'retried ' + num(t.retries) + (num(t.retries) === 1 ? ' time' : ' times');
    if (o === 'achieved' || o === 'failed' || o === 'discarded') return o + (o === 'failed' && tp.length > 1 ? ' (' + tp.join(' → ') + ')' : '');
    return '';
  }
  function taskRow(t) {
    var li = el('li', 'orch-task'); li.setAttribute('data-tid', String(t.id));
    var r1 = el('div', 'orch-tr1');
    r1.appendChild(statusPill('ts-', T_ST, t.status));
    r1.appendChild(el('span', 'orch-tid', clip(t.id, 60)));
    r1.appendChild(el('span', 'orch-ttl', clip(t.title, 300)));
    li.appendChild(r1);
    var r2 = el('div', 'orch-tr2');
    r2.appendChild(el('span', 'orch-tier', tierWord(t.tier)));
    if (t.phase) r2.appendChild(el('span', 'orch-phase', clip(t.phase, 20)));
    if (t.attempts != null) r2.appendChild(el('span', 'tnum', 'attempt ' + num(t.attempts) + '/' + num(t.max_attempts)));
    if (t.ran_s != null) r2.appendChild(el('span', 'orch-ran tnum', 'ran ' + fmtDur(t.ran_s)));
    if (t.new_tokens != null) r2.appendChild(el('span', 'orch-tok tnum', fmtN(t.new_tokens) + ' tok'));
    if (arr(t.depends_on).length) r2.appendChild(el('span', 'orch-deps', 'after ' + clip(arr(t.depends_on).join(', '), 120)));
    if (t.cost_usd != null && num(t.cost_usd) > 0) r2.appendChild(el('span', 'orch-tok tnum', fmtUsd(num(t.cost_usd))));
    if (t.out_of_scope) { var os = el('span', 'orch-oos', 'out of scope' + (num(t.scope_violations) > 1 ? ' \u00d7' + t.scope_violations : '')); os.title = 'An attempt changed files outside this task\'s path_scope and was rejected'; r2.appendChild(os); }
    if (t.waiting_for_human) { var w = el('span', 'orch-wait', 'waiting for you' + (t.waiting_s != null ? ' ' + fmtDur(t.waiting_s) : '')); r2.appendChild(w); }
    li.appendChild(r2);
    var ti = isObj(t.integrity) ? t.integrity : null, sc = num(t.self_checks);
    if (ti || sc > 0 || t.version_mismatch) {
      var r3 = el('div', 'orch-tr3');
      if (ti) { r3.appendChild(integChip(ti.status)); if (ti.status !== 'clean') reasonChips(r3, ti.reasons); }
      if (sc > 0) r3.appendChild(el('span', 'orch-selfchk tnum', sc + (sc === 1 ? ' self-check' : ' self-checks')));
      if (t.version_mismatch) { var vm = el('span', 'orch-vwarn', 'claude version changed'); vm.title = 'An attempt ran on a different claude CLI version than the goal started with'; r3.appendChild(vm); }
      li.appendChild(r3);
    }
    var ow = outcomeWord(t); if (ow) li.appendChild(el('div', 'orch-out orch-out-' + clip(t.outcome, 20), ow));
    if (t.check_summary) li.appendChild(el('div', 'orch-chk', clip(t.check_summary, 800)));
    if (t.error) li.appendChild(el('div', 'orch-err', clip(t.error, 800)));
    arr(t.attempt_log).filter(isObj).forEach(function (a) {
      if (a.stderr_tail) li.appendChild(textDetails('worker error, attempt ' + num(a.n) + (a.tier ? ' (' + tierWord(a.tier) + ')' : ''), a.stderr_tail, 'orch-werr'));
    });
    return li;
  }
  function tierWord(t) { return t === 'haiku' || t === 'sonnet' || t === 'opus' ? t : '?'; }
  function tierLetter(t) { return t === 'haiku' ? 'H' : t === 'sonnet' ? 'S' : t === 'opus' ? 'O' : '?'; }

  /* ---- DAG: deterministic layered layout (left to right) ---- */
  var NW = 116, NH = 40, GX = 36, GY = 14, PADX = 10, PADY = 10;
  function layoutDag(tasks) {
    var idx = {}, i; tasks.forEach(function (t, k) { if (idx[t.id] == null) idx[t.id] = k; });
    var layer = {}, state = {};
    function lay(id) {
      if (layer[id] != null) return layer[id];
      if (state[id] === 1) return 0;                    /* cycle guard */
      state[id] = 1; var t = tasks[idx[id]], m = -1;
      arr(t.depends_on).forEach(function (d) { if (idx[d] != null && d !== id) m = Math.max(m, lay(d)); });
      state[id] = 2; layer[id] = m + 1; return layer[id];
    }
    tasks.forEach(function (t) { lay(t.id); });
    var cols = [];
    tasks.forEach(function (t, k) { if (idx[t.id] !== k) return; (cols[layer[t.id]] = cols[layer[t.id]] || []).push(t.id); });
    var row = {};
    cols.forEach(function (c, ci) {
      if (ci > 0) {
        var bary = {};
        c.forEach(function (id, k) {
          var ds = arr(tasks[idx[id]].depends_on).filter(function (d) { return row[d] != null && layer[d] < ci; });
          bary[id] = ds.length ? ds.reduce(function (a, d) { return a + row[d]; }, 0) / ds.length : 1e6 + k;
        });
        c.sort(function (a, b) { return bary[a] - bary[b] || idx[a] - idx[b]; });
      }
      c.forEach(function (id, k) { row[id] = k; });
    });
    var pos = {}, maxRows = 0;
    cols.forEach(function (c, ci) { maxRows = Math.max(maxRows, c.length); c.forEach(function (id, k) { pos[id] = { x: PADX + ci * (NW + GX), y: PADY + k * (NH + GY), layer: ci, row: k }; }); });
    return { pos: pos, cols: cols.length, rows: maxRows, w: PADX * 2 + cols.length * NW + Math.max(0, cols.length - 1) * GX, h: PADY * 2 + maxRows * NH + Math.max(0, maxRows - 1) * GY };
  }
  function buildDag(tasks) {
    var L = layoutDag(tasks), wrap = el('div', 'orch-dag');
    wrap.tabIndex = 0; wrap.setAttribute('role', 'group');
    var edgesN = 0;
    var s = svg('svg', { viewBox: '0 0 ' + L.w + ' ' + L.h, width: String(L.w), height: String(L.h), role: 'img', class: 'orch-dagsvg' });
    var g1 = svg('g', { class: 'orch-edges' }), g2 = svg('g', { class: 'orch-nodes' });
    var seen = {};
    tasks.forEach(function (t) {
      if (seen[t.id]) return; seen[t.id] = 1;
      var q = L.pos[t.id];
      arr(t.depends_on).forEach(function (d) {
        var p = L.pos[d]; if (!p || d === t.id) return;
        var x1 = p.x + NW, y1 = p.y + NH / 2, x2 = q.x, y2 = q.y + NH / 2, mx = (x1 + x2) / 2;
        var e = svg('path', { d: 'M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2, class: 'orch-edge', 'data-from': String(d), 'data-to': String(t.id) });
        g1.appendChild(e); edgesN++;
      });
    });
    seen = {};
    tasks.forEach(function (t) {
      if (seen[t.id]) return; seen[t.id] = 1;
      var p = L.pos[t.id];
      var n = svg('g', { class: 'orch-node ' + stCls('ts-', T_ST, t.status), transform: 'translate(' + p.x + ',' + p.y + ')', 'data-id': String(t.id), 'data-layer': String(p.layer), 'data-row': String(p.row), 'data-tier': tierLetter(t.tier) });
      n.appendChild(svg('title', {}, clip(t.id + ': ' + t.title + ' (' + (T_ST[t.status] ? t.status : 'unknown') + ')', 300)));
      n.appendChild(svg('rect', { width: String(NW), height: String(NH), rx: '3' }));
      n.appendChild(svg('text', { x: '8', y: '16', class: 'orch-nid' }, clip(t.id, 14)));
      n.appendChild(svg('text', { x: '8', y: '31', class: 'orch-nmeta' }, tierLetter(t.tier) + ' · ' + num(t.attempts) + '/' + num(t.max_attempts)));
      g2.appendChild(n);
    });
    s.appendChild(g1); s.appendChild(g2);
    s.setAttribute('aria-label', 'Task graph: ' + Object.keys(seen).length + ' tasks, ' + edgesN + ' dependencies');
    wrap.setAttribute('aria-label', 'Task graph, scrollable');
    wrap.setAttribute('data-nodes', String(Object.keys(seen).length)); wrap.setAttribute('data-edges', String(edgesN)); wrap.setAttribute('data-layers', String(L.cols));
    wrap.appendChild(s); return wrap;
  }

  /* ---- controls ---- */
  function paintCtl(force) {
    var g = merged(); if (!g || view !== 'detail') return;
    var st = g.status, sig = JSON.stringify([g.id, st, confirmMode, g.title]);
    if (force) R.d.ctl._sig = null;
    paint(R.d.ctl, sig, function (s) {
      var term = !!TERMINAL[st];
      var row = el('div', 'orch-ctl');
      var bp = wbtn('Pause', '', function (b) { act(b, 'pause'); }, function () { return st === 'active' || st === 'planning'; });
      var br = wbtn('Resume', '', function (b) { act(b, 'resume'); }, function () { return st === 'paused' || st === 'blocked'; });
      var bc = wbtn('Cancel', 'danger', function () { confirmMode = 'cancel'; focusConfirm = true; paintCtl(true); }, function () { return !term; });
      var bk = wbtn('Kill', 'danger', function () { confirmMode = 'kill'; focusConfirm = true; paintCtl(true); }, function () { return !term; });
      bp.setAttribute('data-act', 'pause'); br.setAttribute('data-act', 'resume'); bc.setAttribute('data-act', 'cancel'); bk.setAttribute('data-act', 'kill');
      row.appendChild(bp); row.appendChild(br); row.appendChild(bc); row.appendChild(bk); s.appendChild(row);
      if (confirmMode) {
        var box = el('div', 'orch-confirm'); box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-labelledby', 'orch-cf-t');
        var kill = confirmMode === 'kill';
        var t = el('p', null, kill ? 'Kill this goal? Workers are stopped immediately and unfinished work may be left in their worktrees. This cannot be undone.' : 'Cancel this goal? Running workers are stopped and no further tasks start. This cannot be undone.');
        t.id = 'orch-cf-t'; box.appendChild(t);
        var y = wbtn(kill ? 'Yes, kill now' : 'Yes, cancel goal', 'danger solid', function (b) { act(b, kill ? 'kill' : 'cancel', kill ? { confirm: true } : {}); });
        y.setAttribute('data-act', kill ? 'kill-confirm' : 'cancel-confirm');
        var n = btn(kill ? 'Do not kill' : 'Keep running', '', function () { confirmMode = null; paintCtl(true); });
        n.setAttribute('data-act', 'confirm-no');
        box.appendChild(n); box.appendChild(y); s.appendChild(box);
        if (focusConfirm) { focusConfirm = false; safe(function () { n.focus(); }); }
      }
    });
  }
  function act(b, kind, body) {
    var g = merged(); if (!g) return;
    b._busy = true; applyWrite();
    creq('POST', '/api/goals/' + enc(g.id) + '/' + kind, body || {}).then(function () {
      toast(kind + ' sent'); confirmMode = null; b._busy = false; paintCtl(true); pollDetail(); pollCtl();
    }, function (e) { b._busy = false; applyWrite(); errToast(e); });
  }

  /* ---- plan review ---- */
  function renderPlan() {
    if (view !== 'detail' || !R.d) return;
    var g = merged(), sec = R.d.plan;
    if (!g || g.plan_state !== 'awaiting_approval') { paint(sec, 'none', function () {}); return; }
    var usable = plan && planFor === g.id && Array.isArray(plan.tasks) && plan.plan_hash;
    if (!usable) {
      var msg = ctl.st === 'noToken' ? 'A plan is awaiting approval. Connect to the control server to review it: ' + INSTRUCTION
        : ctl.st === 'down' ? 'A plan is awaiting approval, but the control server is unreachable.'
        : planErr ? planErr : 'Loading plan for review…';
      paint(sec, 'pm|' + msg, function (s) { label(s, 'Plan review'); s.appendChild(el('p', 'orch-note', msg)); });
      return;
    }
    var hash = String(plan.plan_hash);
    if (planUi.hash !== hash) planUi = { hash: hash, checked: false, rejecting: false, reason: '' };
    paint(sec, JSON.stringify([plan.tasks, hash, planUi.rejecting]), function (s) {
      label(s, 'Plan review: ' + arr(plan.tasks).length + ' tasks');
      s.appendChild(el('p', 'orch-warnline', 'These commands run on your machine in a sandbox; workers cannot run code, only checks can.'));
      var ul = el('ul', 'orch-plan');
      arr(plan.tasks).filter(isObj).forEach(function (t) {
        var li = el('li', 'orch-ptask'); li.setAttribute('data-tid', String(t.id));
        var h = el('div', 'orch-ph'); h.appendChild(el('span', 'orch-tid', clip(t.id, 60))); h.appendChild(el('span', 'orch-ttl', clip(t.title, 300)));
        h.appendChild(el('span', 'orch-tier', tierWord(t.tier))); li.appendChild(h);
        li.appendChild(planField('depends on', arr(t.depends_on).length ? arr(t.depends_on).map(function (x) { return clip(x, 60); }).join(', ') : 'none'));
        li.appendChild(planBlock('path scope', arr(t.path_scope), 'ps'));
        li.appendChild(planBlock('allowed commands', arr(t.allowed_commands), 'ac'));
        var cb = el('div', 'orch-pf'); cb.appendChild(el('span', 'orch-pl', 'checks'));
        var cks = arr(t.checks).filter(isObj);
        if (!cks.length) cb.appendChild(el('span', 'orch-muted', 'none'));
        cks.forEach(function (c) {
          var w = el('div', 'orch-cmdrow'); w.appendChild(el('pre', 'orch-cmd', String(c.cmd == null ? '' : c.cmd)));
          if (c.timeout_s != null) w.appendChild(el('span', 'orch-to tnum', 'timeout ' + num(c.timeout_s) + 's'));
          w.lastChild.parentNode.firstChild.setAttribute('data-kind', 'check'); cb.appendChild(w);
        });
        li.appendChild(cb);
        if (arr(t.allowed_tools).length) li.appendChild(planField('allowed tools', arr(t.allowed_tools).map(function (x) { return clip(x, 60); }).join(', ')));
        ul.appendChild(li);
      });
      s.appendChild(ul);
      var lab = el('label', 'orch-ack'); var cbx = el('input'); cbx.type = 'checkbox'; cbx.id = 'orch-ack'; cbx.checked = planUi.checked;
      lab.appendChild(cbx); lab.appendChild(el('span', null, 'I reviewed the commands')); s.appendChild(lab);
      var row = el('div', 'orch-arow');
      var ap = wbtn('Approve plan', 'primary', function (b) {
        var h0 = hash; b._busy = true; applyWrite();
        creq('POST', '/api/goals/' + enc(g.id) + '/plan/approve', { plan_hash: h0 }).then(function () {
          toast('Plan approved'); plan = null; b._busy = false; pollDetail(); pollCtl();
        }, function (e) { b._busy = false; applyWrite(); errToast(e); pollCtl(); });
      }, function () { return cbx.checked; });
      ap.setAttribute('data-act', 'plan-approve'); ap.setAttribute('data-hash', hash.slice(0, 80));
      cbx.addEventListener('change', function () { planUi.checked = cbx.checked; applyWrite(); });
      var rj = wbtn('Reject', 'danger', function () { planUi.rejecting = true; sec._sig = null; renderPlan(); }); rj.setAttribute('data-act', 'plan-reject');
      row.appendChild(ap); row.appendChild(rj); s.appendChild(row);
      if (planUi.rejecting) {
        var rb = el('div', 'orch-confirm'); var il = el('label', 'orch-fl', 'Reason'); var inp = el('input', 'orch-in'); inp.type = 'text'; inp.maxLength = 500; inp.id = 'orch-rej-reason'; inp.value = planUi.reason;
        il.setAttribute('for', 'orch-rej-reason'); inp.addEventListener('input', function () { planUi.reason = inp.value; });
        var go = wbtn('Send rejection', 'danger solid', function (b) {
          b._busy = true; applyWrite();
          creq('POST', '/api/goals/' + enc(g.id) + '/plan/reject', { reason: planUi.reason.trim() || 'rejected' }).then(function () {
            toast('Plan rejected'); plan = null; planUi.rejecting = false; planUi.reason = ''; b._busy = false; pollDetail(); pollCtl();
          }, function (e) { b._busy = false; applyWrite(); errToast(e); });
        }); go.setAttribute('data-act', 'plan-reject-confirm');
        var no = btn('Keep reviewing', '', function () { planUi.rejecting = false; sec._sig = null; renderPlan(); });
        rb.appendChild(il); rb.appendChild(inp); rb.appendChild(no); rb.appendChild(go); s.appendChild(rb);
        safe(function () { inp.focus(); });
      }
    });
    applyWrite();
  }
  function planField(name, text) { var d = el('div', 'orch-pf'); d.appendChild(el('span', 'orch-pl', name)); d.appendChild(el('span', 'orch-pv', text)); return d; }
  function planBlock(name, items, kind) {
    var d = el('div', 'orch-pf'); d.appendChild(el('span', 'orch-pl', name));
    if (!items.length) { d.appendChild(el('span', 'orch-muted', 'none')); return d; }
    items.forEach(function (x) { var p = el('pre', 'orch-cmd', String(x == null ? '' : x)); p.setAttribute('data-kind', kind); d.appendChild(p); });
    return d;
  }

  /* ---------------- new goal form ---------------- */
  var F = {};
  function field(parent, id, labelTxt, ctrl, hint) {
    var w = el('div', 'orch-field'); var l = el('label', 'orch-fl', labelTxt); l.setAttribute('for', id); ctrl.id = id;
    var er = el('div', 'orch-ferr'); er.id = id + '-err'; er.hidden = true;
    ctrl.setAttribute('aria-describedby', id + '-err');
    w.appendChild(l); w.appendChild(ctrl);
    if (hint) w.appendChild(el('div', 'orch-hint', hint));
    w.appendChild(er); parent.appendChild(w); ctrl._err = er; return ctrl;
  }
  function buildForm() {
    var f = el('form', 'orch-form'); f.noValidate = true; f.setAttribute('aria-label', 'New goal');
    function inp(type, name) { var i = el('input', 'orch-in'); i.type = type; i.name = name; i.autocomplete = 'off'; return i; }
    /* draft from a prompt: a PROPOSAL only. The control server returns a draft (no goal exists); this form is pre-filled for review and edit, and only "Create goal" creates anything. */
    var dw = el('fieldset', 'orch-field orch-draft'); dw.appendChild(el('legend', 'orch-fl', 'Draft from a prompt (optional)'));
    var pt = el('textarea', 'orch-in orch-ta'); pt.name = 'prompt'; pt.rows = 3; pt.maxLength = 4000;
    F.prompt = field(dw, 'og-prompt', 'What should be done?', pt, 'Uses the repo path below. A model proposes a goal; you review and edit it, and nothing is created until you press Create goal.');
    F.draftOut = el('div', 'orch-draftout'); F.draftOut.setAttribute('aria-live', 'polite');
    var an = el('textarea', 'orch-in orch-ta'); an.name = 'answers'; an.rows = 3; an.maxLength = 2000; an.hidden = true; an.setAttribute('aria-label', 'Answers to the draft questions'); F.answers = an;
    F.draftBtn = wbtn('Draft goal', '', function () { runDraft(); }); F.draftBtn.setAttribute('data-act', 'draft-goal'); F.draftRound = 0; F.draftQs = [];
    dw.appendChild(F.draftOut); dw.appendChild(an); dw.appendChild(F.draftBtn); f.appendChild(dw);
    F.title = field(f, 'og-title', 'Title', inp('text', 'title')); F.title.maxLength = 200;
    var ta = el('textarea', 'orch-in orch-ta'); ta.name = 'description'; ta.rows = 4; ta.maxLength = 20000;
    F.desc = field(f, 'og-desc', 'Description', ta, 'What should be done, and what must not change.');
    F.repo = field(f, 'og-repo', 'Repo path', inp('text', 'repo'), 'Absolute path to a git repository on this machine.'); F.repo.placeholder = '/Users/you/project';
    F.branch = field(f, 'og-branch', 'Base branch (optional)', inp('text', 'base_branch')); F.branch.placeholder = 'main';
    /* criteria */
    var cw = el('fieldset', 'orch-field orch-crits'); var lg = el('legend', 'orch-fl', 'Success criteria'); cw.appendChild(lg);
    F.critList = el('div', 'orch-critlist'); cw.appendChild(F.critList);
    F.critErr = el('div', 'orch-ferr'); F.critErr.hidden = true; F.critErr.id = 'og-crit-err'; F.critErr.setAttribute('role', 'alert');
    var add = btn('+ Add criterion', 'orch-addc', function () { addCrit('', true); }); add.setAttribute('data-act', 'add-criterion');
    cw.appendChild(add); cw.appendChild(F.critErr); f.appendChild(cw);
    addCrit('', false);
    var al = el('textarea', 'orch-in orch-ta'); al.name = 'check_allowlist'; al.rows = 3;
    F.allow = field(f, 'og-allow', 'Allowed check commands (optional)', al, 'Checks run in a sandbox, one command per line; leave empty for no checks.'); al.spellcheck = false;
    /* budgets */
    var bw = el('fieldset', 'orch-field orch-budgets'); bw.appendChild(el('legend', 'orch-fl', 'Budgets'));
    var grid = el('div', 'orch-bgrid');
    function nf(id, lab, val, key) { var i = inp('number', key); i.value = String(val); i.min = '1'; i.step = '1'; i.inputMode = 'numeric'; return field(grid, id, lab, i); }
    F.tok = nf('og-tok', 'Max new tokens', 2000000, 'max_new_tokens');
    F.wall = nf('og-wall', 'Max wall seconds', 2700, 'max_wall_s');
    F.par = nf('og-par', 'Max parallel', 3, 'max_parallel');
    F.att = nf('og-att', 'Max attempts', 3, 'max_attempts');
    bw.appendChild(grid); f.appendChild(bw);
    /* advanced */
    var adv = el('details', 'orch-adv'); adv.appendChild(el('summary', null, 'Advanced (dangerous)'));
    function toggle(id, name, labelTxt, warnTxt) {
      var w = el('div', 'orch-tog'); var l = el('label'); var c = el('input'); c.type = 'checkbox'; c.id = id; c.name = name; c.checked = false;
      c.setAttribute('aria-describedby', id + '-w'); l.appendChild(c); l.appendChild(el('span', null, labelTxt)); w.appendChild(l);
      var wn = el('p', 'orch-warn', warnTxt); wn.id = id + '-w'; w.appendChild(wn); adv.appendChild(w); return c;
    }
    F.trust = toggle('og-trust', 'trust_repo_config', 'Trust repo config', 'Warning: the repo can then define its own hooks and commands, which run on your machine. Only enable for repos you fully trust.');
    F.unsb = toggle('og-unsb', 'unsandboxed_checks', 'Run checks without the sandbox', 'Warning: checks run with your full user permissions and can read or change anything you can. Leave off unless a check cannot run sandboxed.');
    f.appendChild(adv);
    F.err = el('div', 'orch-ferr orch-formerr'); F.err.hidden = true; F.err.setAttribute('role', 'alert'); f.appendChild(F.err);
    var row = el('div', 'orch-arow');
    F.submit = wbtn('Create goal', 'primary', function () { submitForm(); }); F.submit.setAttribute('data-act', 'create-goal');
    var cancel = btn('Cancel', '', function () { goList(); });
    row.appendChild(F.submit); row.appendChild(cancel); f.appendChild(row);
    f.addEventListener('submit', function (e) { e.preventDefault(); if (!F.submit.disabled) submitForm(); });
    R.vForm.appendChild(f); F.form = f;
  }
  function addCrit(val, focus, meta) {
    /* one wrapper per criterion: the input (+ remove) and, for a drafted criterion, its check or HUMAN REVIEW marker. The check argv is carried to the submit unchanged. */
    var wrap = el('div', 'orch-critwrap'); var row = el('div', 'orch-critrow'); var i = el('input', 'orch-in');
    i.type = 'text'; i.maxLength = 500; i.value = val; i.setAttribute('aria-label', 'Success criterion'); i.setAttribute('data-crit', '1');
    wrap._input = i; wrap._check = null; wrap._verify = null;
    var rm = btn('Remove', 'orch-rm', function () {
      if (F.critList.children.length <= 1) { i.value = ''; wrap._check = null; wrap._verify = null; var m0 = wrap.querySelector('.orch-critmeta'); if (m0) wrap.removeChild(m0); i.focus(); return; }
      var nxt = wrap.nextSibling || wrap.previousSibling; F.critList.removeChild(wrap); safe(function () { nxt.querySelector('input').focus(); });
    });
    rm.setAttribute('aria-label', 'Remove criterion'); rm.textContent = '×'; rm.setAttribute('data-act', 'remove-criterion');
    row.appendChild(i); row.appendChild(rm); wrap.appendChild(row);
    if (isObj(meta) && (isObj(meta.check) || meta.verify === 'human')) {
      wrap._check = isObj(meta.check) ? { argv: arr(meta.check.argv).map(String), timeout_s: num(meta.check.timeout_s) } : null; wrap._verify = meta.verify === 'human' ? 'human' : null;
      var mt = el('div', 'orch-critmeta'); mt.setAttribute('data-crit-meta', wrap._verify ? 'human' : 'check');
      mt.textContent = wrap._verify ? 'HUMAN REVIEW: a person must confirm this before the goal can finish'
        : 'check: ' + wrap._check.argv.map(function (a) { return cleanTxt(a, 120); }).join(' ') + ' (sandboxed, ' + wrap._check.timeout_s + 's)' + (meta.matched_rule ? ' \u00b7 allowed by ' + cleanTxt(meta.matched_rule, 80) : '');
      wrap.appendChild(mt);
    }
    F.critList.appendChild(wrap); if (focus) i.focus();
  }
  function cleanTxt(v, n) { return clip(String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g, ' '), n); }
  function setErr(ctrl, msg) { var er = ctrl._err; if (!er) return; er.hidden = !msg; er.textContent = msg || ''; if (msg) ctrl.setAttribute('aria-invalid', 'true'); else ctrl.removeAttribute('aria-invalid'); }
  function intIn(c, lo, hi, name) {
    var raw = String(c.value).trim(), v = Number(raw);
    if (!/^\d+$/.test(raw) || !isFinite(v)) { setErr(c, name + ' must be a whole number.'); return null; }
    if (v < lo || v > hi) { setErr(c, name + ' must be between ' + lo + ' and ' + hi + '.'); return null; }
    setErr(c, ''); return v;
  }
  function validateForm() {
    var bad = [], title = F.title.value.trim(), desc = F.desc.value.trim(), repo = F.repo.value.trim(), br = F.branch.value.trim();
    if (!title) { setErr(F.title, 'Title is required.'); bad.push(F.title); } else if (title.length > 200) { setErr(F.title, 'Title must be 200 characters or fewer.'); bad.push(F.title); } else setErr(F.title, '');
    if (!desc) { setErr(F.desc, 'Description is required.'); bad.push(F.desc); } else setErr(F.desc, '');
    if (!repo) { setErr(F.repo, 'Repo path is required.'); bad.push(F.repo); }
    else if (repo.charAt(0) !== '/' && repo.indexOf('~/') !== 0) { setErr(F.repo, 'Use an absolute path (starting with / or ~/).'); bad.push(F.repo); }
    else if (/[\0\r\n]/.test(repo)) { setErr(F.repo, 'Repo path contains invalid characters.'); bad.push(F.repo); } else setErr(F.repo, '');
    if (br && (!/^[A-Za-z0-9._\/-]+$/.test(br) || br.charAt(0) === '-' || br.indexOf('..') >= 0)) { setErr(F.branch, 'Branch name has invalid characters.'); bad.push(F.branch); } else setErr(F.branch, '');
    var crits = [], critObjs = [], ins = F.critList.querySelectorAll('input'), i, longCrit = false, ws = F.critList.children;
    for (i = 0; i < ins.length; i++) {
      var t = ins[i].value.trim();
      if (t) { crits.push(t); if (t.length > 500) longCrit = true; var o = { text: t }; if (ws[i] && ws[i]._check) o.check = ws[i]._check; if (ws[i] && ws[i]._verify) o.verify = 'human'; critObjs.push(o); }
    }
    if (!crits.length) { F.critErr.hidden = false; F.critErr.textContent = 'Add at least one success criterion.'; bad.push(ins[0]); }
    else if (crits.length > 20) { F.critErr.hidden = false; F.critErr.textContent = 'At most 20 criteria.'; bad.push(ins[0]); }
    else if (longCrit) { F.critErr.hidden = false; F.critErr.textContent = 'Each criterion must be 500 characters or fewer.'; bad.push(ins[0]); }
    else { F.critErr.hidden = true; F.critErr.textContent = ''; }
    var allow = F.allow.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    if (allow.length > 20) { setErr(F.allow, 'At most 20 commands.'); bad.push(F.allow); }
    else if (allow.some(function (x) { return x.length > 300; })) { setErr(F.allow, 'Each command must be 300 characters or fewer.'); bad.push(F.allow); } else setErr(F.allow, '');
    var tok = intIn(F.tok, 1000, 1000000000, 'Max new tokens'), wall = intIn(F.wall, 60, 604800, 'Max wall seconds'), par = intIn(F.par, 1, 16, 'Max parallel'), att = intIn(F.att, 1, 10, 'Max attempts');
    [[F.tok, tok], [F.wall, wall], [F.par, par], [F.att, att]].forEach(function (p) { if (p[1] == null) bad.push(p[0]); });
    if (bad.length) { safe(function () { bad[0].focus(); }); return null; }
    var body = { title: title, description: desc, repo: repo };
    if (br) body.base_branch = br;
    body.success_criteria = critObjs;
    if (allow.length) body.check_allowlist = allow;
    body.budgets = { max_new_tokens: tok, max_wall_s: wall, max_parallel: par, max_attempts: att };
    body.trust_repo_config = !!F.trust.checked; body.unsandboxed_checks = !!F.unsb.checked;
    return body;
  }
  /* ---- draft from prompt: POST /api/goals/draft returns a proposal; nothing is created here ---- */
  var DRAFT_ROUNDS = 2;
  function draftNote(cls, txt) { var p = el('p', cls, txt); F.draftOut.appendChild(p); return p; }
  function runDraft() {
    clear(F.draftOut);
    if (!writeOk()) { draftNote('orch-ferr', writeWhy()); return; }
    var prompt = F.prompt.value.trim(), repo = F.repo.value.trim(), ans = F.answers.value.trim();
    if (!prompt) { setErr(F.prompt, 'Describe what should be done.'); safe(function () { F.prompt.focus(); }); return; } setErr(F.prompt, '');
    if (!repo || (repo.charAt(0) !== '/' && repo.indexOf('~/') !== 0) || /[\0\r\n]/.test(repo)) { setErr(F.repo, 'Enter the absolute repo path first (the draft reads its files list and scripts).'); safe(function () { F.repo.focus(); }); return; } setErr(F.repo, '');
    if (F.draftQs.length && ans) { if (F.draftRound >= DRAFT_ROUNDS) { draftNote('orch-hint', 'Two rounds of questions are enough: edit the form below directly.'); return; } F.draftRound++; }
    var full = F.draftQs.length && ans ? prompt + '\n\nAnswers to your questions:\n' + ans : prompt;
    F.draftBtn._busy = true; applyWrite(); draftNote('orch-hint', 'Drafting\u2026');
    creq('POST', '/api/goals/draft', { prompt: clip(full, 4000), repo: repo }).then(function (j) { F.draftBtn._busy = false; applyWrite(); showDraft(j); }, function (e) {
      F.draftBtn._busy = false; applyWrite(); clear(F.draftOut); draftNote('orch-ferr', (e && e.message) ? e.message : 'Request failed');
    });
  }
  function showDraft(j) {
    clear(F.draftOut);
    var d = isObj(j && j.draft) ? j.draft : null, errs = arr(j && j.errors), qs = arr((j && j.questions) || (d && d.questions)).map(function (x) { return cleanTxt(x, 300); }).filter(Boolean).slice(0, 3);
    F.draftQs = qs;
    if (errs.length) { var ue = el('ul', 'orch-ferr'); errs.slice(0, 8).forEach(function (x) { ue.appendChild(el('li', null, cleanTxt(x, 300))); }); F.draftOut.appendChild(ue); }
    if (qs.length) {
      draftNote('orch-hint', 'The draft needs more detail. Answer these, then press Draft goal again' + (F.draftRound >= DRAFT_ROUNDS ? ' (or edit the form directly)' : '') + ':');
      var ql = el('ul', 'orch-draftq'); qs.forEach(function (x) { ql.appendChild(el('li', null, x)); }); F.draftOut.appendChild(ql); F.answers.hidden = false;
    } else F.answers.hidden = true;
    if (!d || errs.length && !arr(d.success_criteria).length) return;
    if (typeof d.title === 'string') F.title.value = cleanTxt(d.title, 200);
    if (typeof d.description === 'string') F.desc.value = d.description.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g, ' ').slice(0, 20000);
    var cs = arr(d.success_criteria).filter(isObj).slice(0, 20);
    if (cs.length) { clear(F.critList); cs.forEach(function (c) { addCrit(cleanTxt(c.text, 500), false, c); }); }
    var b = isObj(d.budgets) ? d.budgets : {};
    [[F.tok, b.max_new_tokens, 1000, 1000000000], [F.wall, b.max_wall_s, 60, 604800], [F.par, b.max_parallel, 1, 16], [F.att, b.max_attempts, 1, 10]].forEach(function (x) { var v = Number(x[1]); if (isFinite(v) && v >= x[2] && v <= x[3] && Math.floor(v) === v) x[0].value = String(v); });
    arr(d.risks).slice(0, 5).forEach(function (r) { draftNote('orch-hint', 'Risk: ' + cleanTxt(r, 200)); });
    draftNote('orch-hint', 'Draft loaded below' + (j && j.rules_hash ? ' (rules ' + clip(j.rules_hash, 12) + ')' : '') + '. Review and edit it; nothing has been created yet.');
  }
  function submitForm() {
    F.err.hidden = true; F.err.textContent = '';
    if (!writeOk()) { F.err.hidden = false; F.err.textContent = writeWhy(); return; }
    var body = validateForm(); if (!body) return;
    F.submit._busy = true; applyWrite();
    creq('POST', '/api/goals', body).then(function (j) {
      F.submit._busy = false; applyWrite();
      var g = j && j.goal; toast('Goal created');
      resetForm();
      if (g && g.id != null) goDetail(g.id); else goList();
    }, function (e) {
      F.submit._busy = false; applyWrite();
      F.err.hidden = false; F.err.textContent = (e && e.status === 422 ? 'Rejected by server' + (e.code && e.code !== 'http_422' ? ' (' + clip(e.code, 60) + ')' : '') + ': ' : '') + (e && e.message ? e.message : 'Request failed');
      F.err.scrollIntoView && safe(function () { F.err.scrollIntoView({ block: 'nearest' }); });
    });
  }
  function resetForm() {
    F.title.value = ''; F.desc.value = ''; F.allow.value = ''; F.repo.value = ''; F.branch.value = '';
    clear(F.critList); addCrit('', false);
    F.tok.value = '2000000'; F.wall.value = '2700'; F.par.value = '3'; F.att.value = '3'; F.trust.checked = false; F.unsb.checked = false;
    [F.title, F.desc, F.repo, F.branch, F.allow, F.tok, F.wall, F.par, F.att].forEach(function (c) { setErr(c, ''); });
    F.critErr.hidden = true; F.err.hidden = true;
    F.prompt.value = ''; F.answers.value = ''; F.answers.hidden = true; clear(F.draftOut); F.draftRound = 0; F.draftQs = [];
  }

  /* ---------------- state wiring ---------------- */
  var lastGoalsSig = '', verdictSum = null;
  function onState(st) {
    safe(function () {
      if (!st) return;
      var isReplay = !!st.replay || (app && app.isLive && !app.isLive());
      if (isReplay !== replay) { replay = isReplay; refreshConn(); }
      if (Array.isArray(st.goals)) { goals = st.goals; goalsSeen = true; if (!isReplay) lastLiveGoals = st.goals; }
      else if (isReplay && lastLiveGoals) { goals = lastLiveGoals; }
      else if (!isReplay && st.goals === undefined && !goalsSeen) { goals = []; goalsSeen = true; }
      if (!isReplay) verdictSum = st.verdicts && typeof st.verdicts === 'object' ? st.verdicts : null; /* replay omits verdicts: keep the live ones */
      var sig = JSON.stringify(goals) + JSON.stringify(verdictSum); if (sig === lastGoalsSig) return; lastGoalsSig = sig;
      updateHeader();
      if (panelOpen) { if (view === 'list') renderListView(); else if (view === 'detail') { renderApprovals(); renderDetail(); } }
    });
  }

  /* ---------------- agent drawer: GOAL / TASK line (no changes to app.js) ---------------- */
  function decorateDrawer() {
    safe(function () {
      var body = $('dr-body'), title = $('dr-title'); if (!body || !title || !app || !app.getState) return;
      if (body.querySelector('.orch-agent-goal')) return;
      var st = app.getState(); if (!st) return;
      var id = title.textContent, a = arr(st.agents).filter(function (x) { return x && x.id === id; })[0];
      if (!a || (a.goal_id == null && a.task_id == null)) return;
      var line = el('p', 'orch-agent-goal');
      line.appendChild(el('span', 'orch-ag-l', 'Goal: '));
      var gt = a.goal_title || (a.goal_id != null ? goalTitle(a.goal_id) : '');
      if (a.goal_id != null) {
        var b = el('button', 'linkbtn orch-ag-g', clip(gt || a.goal_id, 120)); b.type = 'button';
        b.addEventListener('click', function () { openPanel(); goDetail(a.goal_id); });
        line.appendChild(b);
      } else line.appendChild(document.createTextNode(clip(gt, 120)));
      if (a.task_id != null) { line.appendChild(document.createTextNode(' · ')); line.appendChild(el('span', 'orch-ag-l', 'Task: ')); line.appendChild(el('span', 'orch-ag-t', clip(a.task_id, 80))); }
      var pills = body.querySelector('.dr-pills');
      if (pills && pills.nextSibling) body.insertBefore(line, pills.nextSibling); else body.appendChild(line);
    });
  }
  function watchDrawer() {
    var body = $('dr-body'); if (!body || !window.MutationObserver) return;
    new MutationObserver(function () { decorateDrawer(); }).observe(body, { childList: true });
    decorateDrawer();
  }

  /* ---------------- init ---------------- */
  var bound = false;
  function bind() {
    if (bound) return true;
    var a = window.AosApp; if (!a || typeof a.onState !== 'function') return false;
    bound = true; app = a;
    safe(function () { a.onState(onState); });
    safe(function () { if (a.getState) onState(a.getState()); });
    return true;
  }
  function init() {
    safe(function () {
      buildHeaderBtn(); watchDrawer(); startPresence();
      if (bind()) return;
      var n = 0, iv = setInterval(function () { if (bind() || ++n > 60) clearInterval(iv); }, 500);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
