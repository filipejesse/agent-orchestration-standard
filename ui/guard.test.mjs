// node ui/guard.test.mjs : GUARD view. Pure badge/row helpers, Needs-you on integrity rejections, and the real guard.js DOM code run
// against a minimal fake DOM (button hidden without verdicts, panel rows rendered as text only), plus static wiring/CSS checks.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const dir = path.dirname(fileURLToPath(import.meta.url)); let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + n); };
const rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const req = createRequire(import.meta.url), G = req('./guard.js'), { compute } = req('./needs-you.js');

// badge states
const b = (g) => G.badge(g);
ok('verified', b({ verdict: 'verified' }).state === 'verified' && b({ verdict: 'verified' }).text === 'verified');
ok('integrity rejection names the kind', b({ verdict: 'integrity', kind: 'tests_edited' }).state === 'integrity' && b({ verdict: 'integrity', kind: 'tests_edited' }).text === 'rejected: tests edited');
ok('integrity without kind', b({ verdict: 'integrity', kind: null }).text === 'rejected: integrity');
ok('capability rejection = checks failed', b({ verdict: 'capability', kind: 'checks_failed' }).state === 'capability' && b({ verdict: 'capability' }).text === 'rejected: checks failed');
ok('none for missing / junk', b(null).state === 'none' && b({ verdict: '<img>' }).state === 'none' && b('x').state === 'none');
const V = { id: 'v-20261021-110000-bbbbbb', created_at: '2026-10-21T11:00:00.000Z', repo_name: 'shop', verdict: 'integrity', kind: 'tests_edited', source: 'hook', agent: 'Claude Code·sess', tree: 'working', base: '0123456789ab', base_ref: null,
  rejections: [{ kind: 'tests_edited', detail: '<img src=x onerror=alert(1)>' }], warnings: ['literal_copy src/expand.js: copied'], failing_tests: ['test/vat.test.js: adds 20% VAT'], checks: [{ cmd: 'npm test', ok: false, exit_code: 1, duration_ms: 1534 }], duration_ms: 4100 };
const m = G.rowModel(V);
ok('row model: repo, reasons, failing tests, checks', m.repo === 'shop' && m.reasons[0].kind === 'tests edited' && m.failing[0] === 'test/vat.test.js: adds 20% VAT' && m.checks[0].text === 'failed (exit 1) · 1.5s' && /via hook/.test(m.meta) && /working tree/.test(m.meta));
ok('row model tolerates junk', G.rowModel({ rejections: 'x', checks: [null] }).checks[0].cmd === '(command)');

// Needs you
const S = { total: 3, latest: [{ id: 'v-1', repo_name: 'shop', verdict: 'integrity', kind: 'tests_skipped' }, { id: 'v-2', repo_name: 'api', verdict: 'capability' }, { id: 'v-3', repo_name: 'web', verdict: 'verified' }] };
const n = compute([], S);
ok('integrity rejection raises one Needs-you item; capability/verified do not', n.total === 1 && n.items[0].kind === 'integrity' && n.items[0].id === 'v-1' && n.items[0].text === 'guard rejected: tests skipped');
ok('needs-you unchanged without verdicts', compute([], null).total === 0 && compute([], { latest: 'x' }).total === 0);
ok('needs-you sums goals and verdicts', compute([{ id: 'a', title: 'A', status: 'active', approvals_pending: 2 }], S).total === 3);

// real DOM code against a fake DOM
class CL { constructor(n) { this.n = n; } _l() { return this.n.className.split(/\s+/).filter(Boolean); } add(c) { const l = this._l(); if (!l.includes(c)) l.push(c); this.n.className = l.join(' '); } remove(c) { this.n.className = this._l().filter((x) => x !== c).join(' '); } toggle(c, on) { if (on === undefined) on = !this.contains(c); if (on) this.add(c); else this.remove(c); } contains(c) { return this._l().includes(c); } }
class N {
  constructor(t) { this.tag = t; this.children = []; this.attrs = {}; this.className = ''; this._t = ''; this.hidden = false; this.classList = new CL(this); this.parentNode = null; this.ev = {}; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); } set textContent(v) { this._t = String(v); this.children = []; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; } insertBefore(c, r) { const i = this.children.indexOf(r); c.parentNode = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; } setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(e, f) { (this.ev[e] = this.ev[e] || []).push(f); } click() { (this.ev.click || []).forEach((f) => f({ stopPropagation() {} })); } focus() {} scrollIntoView() {}
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  querySelector(s) { const m = s.match(/^\[data-id="(.*)"\]$/); return this.all().find((x) => (m ? x.attrs['data-id'] === m[1] : s.startsWith('.') ? x.classList.contains(s.slice(1)) : x.tag === s)) || null; }
}
const header = new N('header'), body = new N('body');
const doc = { readyState: 'complete', hidden: false, body, activeElement: null, createElement: (t) => new N(t), createElementNS: (ns, t) => new N(t), createTextNode: (t) => { const x = new N('#text'); x.textContent = t; return x; },
  getElementById: (id) => [header, body].flatMap((r) => r.all()).find((x) => x.id === id) || null, querySelector: (s) => (s === 'header.top' ? header : null), addEventListener() {} };
body.contains = () => true;
let fetched = 0;
const win = { document: doc, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {}, AbortController: undefined, JSON, Date, Number, String, Array, Math, isFinite,
  fetch: () => { fetched++; return Promise.resolve({ ok: true, json: () => Promise.resolve({ verdicts: [V, { ...V, id: 'v-20261021-120000-cccccc', verdict: 'capability', kind: 'checks_failed', rejections: [] }] }) }); } };
win.window = win; vm.createContext(win); vm.runInContext(rd('guard.js'), win);
const A = win.AOSGuard, btn = header.children.find((x) => x.id === 'guard-btn');
ok('GUARD button exists and is hidden before any state', !!btn && btn.hidden === true);
A.setSummary({ total: 0, latest: [] }); ok('hidden with zero verdicts', btn.hidden === true);
A.setSummary(S); ok('shown with verdicts, count + integrity dot', btn.hidden === false && btn.textContent.includes('3') && btn.attrs['aria-label'].includes('1 integrity rejection'));
A.open('v-20261021-110000-bbbbbb');
await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
const panel = body.children.find((x) => x.id === 'guard-panel'), rows = panel.all().filter((x) => x.tag === 'li' && x.attrs['data-verdict']);
ok('panel opens and fetches /api/verdicts', panel.hidden === false && fetched === 1);
ok('rows: integrity (red) + capability (amber), focused row highlighted', rows.length === 2 && rows[0].attrs['data-verdict'] === 'integrity' && rows[1].attrs['data-verdict'] === 'capability' && rows[0].classList.contains('focus'));
ok('row shows repo, reasons, failing tests, checks', /shop/.test(rows[0].textContent) && /adds 20% VAT/.test(rows[0].textContent) && /npm test/.test(rows[0].textContent) && /rejected: tests edited/.test(rows[0].textContent));
ok('hostile detail stays text (no element created from it)', rows[0].textContent.includes('<img src=x onerror=alert(1)>') && !rows[0].all().some((x) => x.tag === 'img'));
A.close(); ok('panel closes', panel.hidden === true);
const sess = { id: 'Claude Code·sess', capabilities: ['claude-code'], guard: { id: V.id, verdict: 'integrity', kind: 'tests_edited' } };
const be = A.badgeEl(sess, { verdicts: S });
ok('drawer badge: integrity, red class, kind text', be && be.textContent === 'rejected: tests edited' && /g-integrity/.test(be.className) && be.attrs['data-guard'] === 'integrity');
ok('drawer badge: verified / capability', A.badgeEl({ ...sess, guard: { verdict: 'verified' } }, {}).textContent === 'verified' && A.badgeEl({ ...sess, guard: { verdict: 'capability' } }, {}).attrs['data-guard'] === 'capability');
ok('drawer badge: none on a session only when verdicts exist', A.badgeEl({ ...sess, guard: undefined }, { verdicts: S }).textContent === 'guard: none' && A.badgeEl({ ...sess, guard: undefined }, { verdicts: { total: 0 } }) === null && A.badgeEl({ id: 'x·1', capabilities: [] }, { verdicts: S }) === null);

// static wiring
const g = rd('guard.js'), app = rd('app.js'), orch = rd('orch.js'), css = rd('orch.css'), theme = rd('theme.css'), html = rd('index.html');
ok('guard.js never uses innerHTML', !/\.(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write/.test(g));
ok('guard.js is read-only: GET /api/verdicts only', (g.match(/fetch\(/g) || []).length === 1 && /fetch\('\/api\/verdicts'/.test(g) && !/method:|POST/.test(g));
ok('script loaded after needs-you and orch', html.indexOf('guard.js') > html.indexOf('orch.js') && html.indexOf('orch.js') > html.indexOf('needs-you.js'));
ok('session node mark + tooltip + drawer badge wired in app.js', /'guardmark'/.test(app) && /' g-' \+ guardSt\(a\)/.test(app) && /'GUARD: '/.test(app) && /AOSGuard\.badgeEl\(a, state\)/.test(app));
ok('Needs you counts verdicts and opens the guard panel', /AOSNeeds\.compute\(on \? goalList\(\) : \[\], verdictSum\)/.test(orch) && /it\.kind === 'integrity'[\s\S]{0,80}AOSGuard\.open\(it\.id\)/.test(orch));
ok('node mark colours from theme tokens (red/amber/accent)', /g-integrity \.guardmark\{fill:var\(--errored\)\}/.test(theme) && /g-capability \.guardmark\{fill:var\(--stalled\)\}/.test(theme) && /g-verified \.guardmark\{fill:var\(--running\)\}/.test(theme));
ok('panel CSS uses tokens only (no hex colours)', !/#[0-9a-f]{3,6}\b/i.test(css.slice(css.indexOf('GUARD view'))));
ok('mobile: 36px targets for the button and badge, panel is the shared bottom sheet', /@media \(max-width:720px\)\{\.guard-hbtn\{order:2;min-height:36px\}button\.guard-badge\{min-height:36px/.test(css) && /orch-panel guard-panel/.test(g));
console.log(fails ? fails + ' FAILED' : 'guard: all ok'); process.exit(fails ? 1 : 0);
