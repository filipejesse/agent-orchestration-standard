/* Cross-machine view: header machine chips (All / local / each remote), state filter, per-machine totals. Read-only.
   Everything from a remote machine is untrusted text: rendered with textContent only, never innerHTML. */
(function () {
  var sel = 'all', names = [], root = null;
  try { sel = localStorage.getItem('aos-machine') || 'all'; } catch (e) { /* storage may be blocked */ }
  var mach = function (x) { return x.machine || 'local'; };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmtTok(n) { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }
  function totalsText(m) { var t = m.totals || {}; return (t.agents || 0) + ' agents · ' + fmtTok(t.tokens) + ' tok' + (t.cost_usd_est != null ? ' · $' + Number(t.cost_usd_est).toFixed(2) : ''); }
  /* ids from remote machines are "<name>:<id>"; the original id is what the existing label code expects */
  function strip(id) { var s = String(id == null ? '' : id), i = s.indexOf(':'); return i > 0 && names.indexOf(s.slice(0, i)) >= 0 ? s.slice(i + 1) : s; }
  function filter(s) {
    if (!s || !Array.isArray(s.machines)) return s;
    names = s.machines.map(function (m) { return m.name; }).filter(function (n) { return n !== 'local'; });
    if (sel === 'all' || !s.machines.some(function (m) { return m.name === sel; })) return s;
    var o = {}, k; for (k in s) o[k] = s[k];
    ['agents', 'tasks', 'projects', 'alerts', 'collisions', 'events', 'goals'].forEach(function (f) { if (Array.isArray(s[f])) o[f] = s[f].filter(function (x) { return mach(x) === sel; }); });
    var m = s.machines.filter(function (x) { return x.name === sel; })[0], t = m && m.totals || {};
    o.cost = { total_usd_est: t.cost_usd_est == null ? null : t.cost_usd_est, tokens_total: t.tokens || 0, by_model: (s.cost && s.cost.by_model) || {} };
    return o;
  }
  function render(s) {
    if (!root) { root = document.getElementById('machines'); if (!root) return; }
    var ms = s && Array.isArray(s.machines) ? s.machines : [];
    root.hidden = ms.length < 2; if (ms.length < 2) return;
    if (sel !== 'all' && !ms.some(function (m) { return m.name === sel; })) sel = 'all';
    while (root.firstChild) root.removeChild(root.firstChild);
    var group = el('div', 'mach-chips'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Machine filter');
    [{ name: 'all', label: 'All' }].concat(ms.map(function (m) { return { name: m.name, label: m.name, m: m }; })).forEach(function (c) {
      var b = el('button', 'mach-chip' + (c.name === sel ? ' on' : ''));
      b.type = 'button'; b.setAttribute('aria-pressed', c.name === sel ? 'true' : 'false');
      if (c.m) { b.appendChild(el('i', 'mach-dot ' + (c.m.ok ? 'up' : 'down'))); b.title = c.m.ok ? totalsText(c.m) : c.name + ' offline: ' + (c.m.error || 'unreachable'); }
      else b.title = (s.totals ? s.totals.agents + ' agents · ' + fmtTok(s.totals.tokens) + ' tok' + (s.totals.cost_usd_est != null ? ' · $' + Number(s.totals.cost_usd_est).toFixed(2) : '') : '');
      b.appendChild(el('span', null, c.label));
      b.addEventListener('click', function () { sel = c.name; try { localStorage.setItem('aos-machine', sel); } catch (e) { /* ignore */ } if (window.AosApp && AosApp.refresh) AosApp.refresh(); });
      group.appendChild(b);
    });
    root.appendChild(group);
    var tot = el('div', 'mach-totals'); tot.setAttribute('aria-label', 'Per-machine totals');
    ms.forEach(function (m) { tot.appendChild(el('span', 'mach-tot' + (m.ok ? '' : ' off'), m.name + ': ' + (m.ok ? totalsText(m) : 'offline' + (m.error ? ' (' + m.error + ')' : '')))); });
    root.appendChild(tot);
  }
  window.AosMachines = { filter: filter, render: render, strip: strip, selected: function () { return sel; } };
})();
