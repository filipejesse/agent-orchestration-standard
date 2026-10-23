// Cross-machine aggregation (read-only). The monitor polls other machines' dashboards over the user's existing SSH auth:
//   ssh -o BatchMode=yes -o ConnectTimeout=5 -- <target> curl -sf --max-time 4 'http://127.0.0.1:<port>/api/state?local=1'
// No new listener or port is opened anywhere. Remote data is untrusted: validated structurally here, escaped (textContent) in the UI.
// Zero dependencies, Node 18+ ESM. Pure functions + an injectable runner so tests never touch real ssh.
import { execFile } from 'node:child_process';

export const LOCAL = 'local';
export const MAX_REMOTES = 16, MAX_BYTES = 8 * 1024 * 1024, STALE_MS = 20000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/, USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;

// Strict validation: anything unexpected throws. ssh target = [user@]host (alnum, dot, dash, underscore only; never a leading dash).
export function validateRemote(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('remote must be an object');
  const name = r.name, ssh = r.ssh;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('bad remote name (use letters, digits, . _ -; max 32)');
  if (name.toLowerCase() === LOCAL || name.toLowerCase() === 'all') throw new Error('remote name "' + name.toLowerCase() + '" is reserved');
  if (typeof ssh !== 'string' || ssh.length > 300) throw new Error('bad ssh target');
  const at = ssh.indexOf('@'), user = at < 0 ? null : ssh.slice(0, at), host = at < 0 ? ssh : ssh.slice(at + 1);
  if ((user !== null && !USER_RE.test(user)) || !HOST_RE.test(host) || host.includes('..')) throw new Error('bad ssh target (expected [user@]host, no spaces or shell characters)');
  const port = r.port === undefined ? 4318 : r.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
  return { name, ssh, port };
}

// Keeps every valid, unique remote; reports the rest through warn(). Never throws.
export function parseRemotes(list, warn = () => {}) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) { warn('remotes must be an array'); return []; }
  const out = [], seen = new Set();
  for (const raw of list) {
    if (out.length >= MAX_REMOTES) { warn('too many remotes (max ' + MAX_REMOTES + ')'); break; }
    try {
      const r = validateRemote(raw), k = r.name.toLowerCase();
      if (seen.has(k)) throw new Error('duplicate remote name ' + r.name);
      seen.add(k); out.push(r);
    } catch (e) { warn('ignored remote: ' + e.message); }
  }
  return out;
}

export function remotesFromEnv(env = process.env, warn) {
  if (!env.AOS_REMOTES) return null;
  try { return parseRemotes(JSON.parse(env.AOS_REMOTES), warn); } catch { if (warn) warn('AOS_REMOTES is not valid JSON'); return []; }
}

export const sshArgv = (r) => ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=no', '--', r.ssh, `curl -sf --max-time 4 'http://127.0.0.1:${r.port}/api/state?local=1'`];

const cleanErr = (s) => String(s || '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 160);

export function sshRunner(exec = execFile, bin = 'ssh') {
  return (argv, { maxBytes = MAX_BYTES, timeoutMs = 12000 } = {}) => new Promise((resolve, reject) => {
    exec(bin, argv, { timeout: timeoutMs, maxBuffer: maxBytes + 1, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('response too large'));
      if (err.code === 'ENOENT') return reject(new Error('ssh not found'));
      if (err.killed) return reject(new Error('timed out'));
      reject(new Error(`ssh failed (exit ${err.code})${stderr ? ': ' + cleanErr(String(stderr).split('\n')[0]) : ''}`));
    });
  });
}

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
export const MAX_ROWS = 2000, MAX_NESTED = 64, MAX_STR = 512, MAX_KEYS = 64;
// Recursively bound a remote value: strings <= MAX_STR, arrays <= MAX_NESTED, objects <= MAX_KEYS keys, depth <= 4.
function clean(v, d = 0) {
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (d >= 4) return null;
  if (Array.isArray(v)) return v.slice(0, MAX_NESTED).map((x) => clean(x, d + 1));
  if (isObj(v)) { const o = {}; for (const k of Object.keys(v).slice(0, MAX_KEYS)) if (k !== '__proto__') o[k.slice(0, 64)] = clean(v[k], d + 1); return o; }
  return null;
}
// Parse + structurally validate one remote /api/state body. Drops non-object entries; caps list sizes, nested arrays and string lengths.
export function parseState(text, maxBytes = MAX_BYTES) {
  const len = typeof text === 'string' ? Buffer.byteLength(text) : text ? text.length : 0;
  if (len > maxBytes) throw new Error('response too large');
  let j; try { j = JSON.parse(String(text)); } catch { throw new Error('invalid JSON from remote'); }
  if (!isObj(j) || !Array.isArray(j.agents)) throw new Error('not an AOS state');
  const list = (a, n) => (Array.isArray(a) ? a.filter(isObj).slice(0, n).map((x) => clean(x)) : []);
  const s = { agents: list(j.agents, MAX_ROWS).filter((a) => a.id !== null && a.id !== undefined), tasks: list(j.tasks, MAX_ROWS), projects: list(j.projects, 500), alerts: list(j.alerts, 100),
    collisions: list(j.collisions, 200), events: list(j.events, 200), goals: list(j.goals, 200), cost: isObj(j.cost) ? clean(j.cost) : {}, server_time: typeof j.server_time === 'string' ? j.server_time.slice(0, 64) : null };
  return s;
}

// The poller. tick() is driven by a timer in the monitor (or called directly by tests with a fake `now`).
export function createCollector({ remotes, run = sshRunner(), now = Date.now, intervalMs = 5000, maxBackoffMs = 60000, maxBytes = MAX_BYTES } = {}) {
  const st = new Map(remotes.map((r) => [r.name, { r, ok: false, last_seen: null, error: 'not polled yet', data: null, rows: null, fails: 0, nextAt: 0, busy: false }]));
  async function poll(s) {
    s.busy = true;
    try {
      const out = await run(sshArgv(s.r), { maxBytes, timeoutMs: 12000 });
      s.data = parseState(out, maxBytes); s.rows = tagRemote(s.r.name, s.data, now()); s.ok = true; s.error = null; s.fails = 0; s.last_seen = now(); s.nextAt = now() + intervalMs;
    } catch (e) {
      s.ok = false; s.error = cleanErr(e && e.message) || 'failed'; s.fails++;
      s.nextAt = now() + Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(s.fails, 10));
    } finally { s.busy = false; }
  }
  return {
    tick: () => Promise.all([...st.values()].filter((s) => !s.busy && now() >= s.nextAt).map(poll)),
    snapshot: () => [...st.values()].map((s) => ({ name: s.r.name, ok: s.ok, last_seen: s.last_seen === null ? null : new Date(s.last_seen).toISOString(), error: s.ok ? undefined : s.error,
      fails: s.fails, next_in_s: Math.max(0, Math.round((s.nextAt - now()) / 1000)), data: s.data && s.last_seen !== null && now() - s.last_seen <= Math.max(STALE_MS, 2 * intervalMs) ? s.data : null,
      rows: s.rows && s.last_seen !== null && now() - s.last_seen <= Math.max(STALE_MS, 2 * intervalMs) ? s.rows : null })),
    names: () => [...st.keys()],
  };
}

// ---------- merge ----------
// Every remote-supplied id/reference is coerced to a string and prefixed with the machine name (so it can never equal a local id).
// null/undefined stay as-is (optional reference); empty strings get a generated <name>:anon-N (counter per tagRemote call).
const mkNs = () => { let n = 0; const ns = (m, v) => (v === null || v === undefined ? v : `${m}:${String(v) || 'anon-' + ++n}`);
  return { ns, nsList: (m, l) => (Array.isArray(l) ? l.map((x) => ns(m, x === null || x === undefined ? '' : x)) : l) }; };
const FUTURE_SKEW_MS = 60000;
// Only valid ISO timestamps not in the future survive; anything else is clamped to the poll time.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const safeTs = (ts, nowMs) => { const ms = typeof ts === 'string' && ISO_RE.test(ts) ? Date.parse(ts) : NaN; return new Date(Number.isFinite(ms) && ms <= nowMs + FUTURE_SKEW_MS ? ms : nowMs).toISOString(); };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sumCost = (items) => { const v = items.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : null; };

function totalsOf(agents, cost) {
  return { agents: agents.length, running: agents.filter((a) => a.status === 'running').length, stalled: agents.filter((a) => a.status === 'stalled').length,
    errored: agents.filter((a) => a.status === 'errored').length, tokens: num(cost && cost.tokens_total), cost_usd_est: cost && typeof cost.total_usd_est === 'number' ? cost.total_usd_est : null };
}

export function tagRemote(m, d, nowMs = Date.now()) {
  const { ns, nsList } = mkNs();
  const label = (p) => (typeof p === 'string' && p ? `${p} @${m}` : p);
  const agents = d.agents.map((a) => ({ ...a, machine: m, id: ns(m, a.id), current_task: ns(m, a.current_task), goal_id: ns(m, a.goal_id), task_id: ns(m, a.task_id), project: label(a.project), project_id: ns(m, a.project_id) }));
  for (const a of agents) for (const k of ['current_task', 'goal_id', 'task_id', 'project_id']) if (a[k] === undefined || a[k] === null) delete a[k];
  const tasks = d.tasks.map((t) => ({ ...t, machine: m, id: ns(m, t.id), goal_id: ns(m, t.goal_id), assignee: ns(m, t.assignee), depends_on: nsList(m, t.depends_on) }));
  const projects = d.projects.map((p) => ({ ...p, machine: m, id: ns(m, p.id), name: label(p.name), agents: nsList(m, p.agents) }));
  const alerts = d.alerts.map((x) => ({ ...x, machine: m, ts: safeTs(x.ts, nowMs), agent: ns(m, x.agent), project: label(x.project) }));
  const collisions = d.collisions.map((c) => ({ ...c, machine: m, agents: nsList(m, c.agents) }));
  const events = d.events.map((e) => ({ ...e, machine: m, ts: safeTs(e.ts, nowMs), actor: ns(m, e.actor), goal_id: ns(m, e.goal_id), task_id: ns(m, e.task_id) }));
  const goals = d.goals.map((g) => ({ ...g, machine: m, id: ns(m, g.id) }));
  return { agents, tasks, projects, alerts, collisions, events, goals };
}

// local: the monitor's own /api/state object (not mutated). snaps: collector.snapshot(). Returns the aggregated state.
export function mergeState(local, snaps = []) {
  const out = { ...local };
  const lAgents = (local.agents || []).map((a) => ({ ...a, machine: LOCAL }));
  const lTasks = (local.tasks || []).map((t) => ({ ...t, machine: LOCAL }));
  const machines = [{ name: LOCAL, ok: true, last_seen: local.server_time || new Date().toISOString(), totals: totalsOf(lAgents, local.cost) }];
  const parts = { agents: [lAgents], tasks: [lTasks], projects: [(local.projects || []).map((p) => ({ ...p, machine: LOCAL }))],
    alerts: [(local.alerts || []).map((x) => ({ ...x, machine: LOCAL }))], collisions: [(local.collisions || []).map((c) => ({ ...c, machine: LOCAL }))],
    events: [(local.events || []).map((e) => ({ ...e, machine: LOCAL }))], goals: [(local.goals || []).map((g) => ({ ...g, machine: LOCAL }))] };
  const costs = [local.cost || {}], byMachine = { [LOCAL]: { tokens_total: num(local.cost && local.cost.tokens_total), total_usd_est: local.cost && typeof local.cost.total_usd_est === 'number' ? local.cost.total_usd_est : null } };
  for (const s of snaps) {
    const mach = { name: s.name, ok: s.ok, last_seen: s.last_seen };
    if (!s.ok) mach.error = s.error || 'unreachable';
    if (s.data) {
      const t = s.rows || tagRemote(s.name, s.data);
      for (const k of Object.keys(parts)) parts[k].push(t[k]);
      costs.push(s.data.cost);
      mach.totals = totalsOf(t.agents, s.data.cost);
      byMachine[s.name] = { tokens_total: num(s.data.cost.tokens_total), total_usd_est: typeof s.data.cost.total_usd_est === 'number' ? s.data.cost.total_usd_est : null };
    } else mach.totals = totalsOf([], null);
    machines.push(mach);
  }
  const cat = (k) => parts[k].flat();
  out.agents = cat('agents'); out.tasks = cat('tasks'); out.projects = cat('projects'); out.collisions = cat('collisions');
  // Each machine contributes at most its newest ceil(budget / machines) rows, so one machine (with any timestamps) cannot evict the others.
  const byTs = (a, b) => (String(a.ts) < String(b.ts) ? -1 : String(a.ts) > String(b.ts) ? 1 : 0);
  const share = (k, budget) => { const cap = Math.ceil(budget / parts[k].length); return parts[k].flatMap((rows) => [...rows].sort(byTs).slice(-cap)).sort(byTs).slice(-budget); };
  out.alerts = share('alerts', 20);
  out.events = share('events', 200).map((e, i) => ({ ...e, seq: i }));
  if (local.goals !== undefined) out.goals = cat('goals');
  const by_model = Object.create(null);
  for (const c of costs) for (const [mdl, u] of Object.entries(isObj(c.by_model) ? c.by_model : {})) {
    if (mdl === '__proto__' || !isObj(u)) continue;
    const t = by_model[mdl] = by_model[mdl] || { input: 0, output: 0, cache_read: 0, cache_write: 0, usd_est: null };
    for (const k of ['input', 'output', 'cache_read', 'cache_write']) t[k] += num(u[k]);
    if (typeof u.usd_est === 'number') t.usd_est = (t.usd_est || 0) + u.usd_est;
  }
  out.cost = { total_usd_est: sumCost(costs.map((c) => c.total_usd_est)), tokens_total: costs.reduce((a, c) => a + num(c.tokens_total), 0), by_model, by_machine: byMachine };
  if (local.cost && isObj(local.cost.exact)) out.cost.exact = { ...local.cost.exact, machine: LOCAL }; // OTel exact cost covers this machine only
  out.machines = machines;
  out.totals = { machines: machines.length, agents: out.agents.length, running: out.agents.filter((a) => a.status === 'running').length, tokens: out.cost.tokens_total, cost_usd_est: out.cost.total_usd_est };
  return out;
}
