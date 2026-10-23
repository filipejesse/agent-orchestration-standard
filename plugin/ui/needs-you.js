/* Pure, read-only aggregation of what is waiting on the human across goals (from the /api/state goal summaries).
   Loaded as a plain script (window.AOSNeeds) and by node (module.exports) for tests. */
(function (root) {
  'use strict';
  var TERMINAL = { achieved: 1, failed: 1, cancelled: 1 };
  function cnt(x) { x = Number(x); return isFinite(x) && x > 0 ? Math.floor(x) : 0; }
  /* -> { total, items: [{ id, title, kind: approval|plan|blocked|limit|integrity, n, text }] }; one item per (goal, reason), terminal goals skipped.
     verdicts (optional): the /api/state guard summary; a repo whose NEWEST verdict is an integrity rejection is one item (id = verdict id) */
  function compute(goals, verdicts) {
    var items = [], total = 0;
    (Array.isArray(goals) ? goals : []).forEach(function (g) {
      if (!g || typeof g !== 'object' || !g.id || TERMINAL[g.status]) return;
      var title = String(g.title || g.id);
      function add(kind, n, text) { items.push({ id: String(g.id), title: title, kind: kind, n: n, text: text }); total += n; }
      var a = cnt(g.approvals_pending);
      if (a) add('approval', a, a + (a === 1 ? ' approval' : ' approvals') + ' pending');
      if (g.plan_state === 'awaiting_approval' && g.status === 'draft') add('plan', 1, 'plan awaiting approval');
      if (g.status === 'blocked') add('blocked', 1, 'blocked' + (g.blocked_reason ? ': ' + String(g.blocked_reason).slice(0, 80) : ''));
      if (g.limit_paused && !g.resume_at) add('limit', 1, 'paused by plan limit, resume manually');
    });
    var latest = verdicts && typeof verdicts === 'object' && Array.isArray(verdicts.latest) ? verdicts.latest : [];
    latest.forEach(function (v) {
      if (!v || typeof v !== 'object' || v.verdict !== 'integrity' || !v.id) return;
      items.push({ id: String(v.id), title: String(v.repo_name || 'repo'), kind: 'integrity', n: 1, text: 'guard rejected: ' + (v.kind ? String(v.kind).replace(/[_.-]+/g, ' ').slice(0, 60) : 'integrity') }); total += 1;
    });
    return { total: total, items: items };
  }
  var api = { compute: compute };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AOSNeeds = api;
})(typeof window !== 'undefined' ? window : globalThis);
