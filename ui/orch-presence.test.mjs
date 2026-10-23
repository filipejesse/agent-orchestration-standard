// node ui/orch-presence.test.mjs : behavioural check (fake DOM, fake fetch) that the GOALS button and Needs-you badge
// render only when /api/goals-derived state has a goal OR the control server (4319) answers /api/health.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url)); let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + n); };
const src = fs.readFileSync(path.join(dir, 'orch.js'), 'utf8');
const mk = (tag) => { const e = { tag, children: [], attrs: {}, hidden: false, className: '', textContent: '', style: {}, firstChild: null, parentNode: null,
  classList: { toggle() {}, add() {}, remove() {} }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }, insertBefore(c) { c.parentNode = this; this.children.push(c); return c; },
  addEventListener() {}, removeChild() {}, contains() { return false; }, focus() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  Object.defineProperty(e, 'id', { value: '', writable: true }); return e; };
const run = async ({ goals, health }) => {
  const els = {}, top = mk('header'), timers = []; let fetches = 0, healthUp = health;
  const document = { readyState: 'complete', documentElement: mk('html'), body: mk('body'), createElement: mk, createElementNS: mk, createTextNode: (t) => ({ t }),
    getElementById: () => null, addEventListener() {}, querySelector: (s) => (s === 'header.top' ? top : null), activeElement: null };
  const win = { document, AbortController, setInterval: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearInterval() {}, MutationObserver: undefined, AOSNeeds: { compute: (g) => ({ total: g.length ? 1 : 0, items: [] }) } };
  let onState = null;
  win.AosApp = { onState: (f) => { onState = f; }, getState: () => ({ goals }), isLive: () => true };
  const ctx = vm.createContext({ ...win, window: win, document, fetch: () => { fetches++; return healthUp ? Promise.resolve({ ok: true }) : Promise.reject(new Error('down')); },
    setTimeout, clearTimeout, console, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } });
  vm.runInContext(src, ctx);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  await tick();
  const btn = () => top.children.find((c) => c.id === 'orch-btn'), needs = () => top.children.find((c) => c.id === 'needs-btn');
  return { btn, needs, tick, timers, onState: (s) => onState(s), setHealth: (v) => { healthUp = v; }, fetches: () => fetches };
};
{ const t = await run({ goals: [], health: false });
  ok('no goals + control down: GOALS button hidden', t.btn() && t.btn().hidden === true);
  ok('no goals + control down: Needs-you hidden', t.needs() && t.needs().hidden === true);
  ok('presence re-check scheduled every 30000 ms', t.timers.some((x) => x.ms === 30000));
  t.setHealth(true); t.timers.find((x) => x.ms === 30000).f(); await t.tick();
  ok('control server comes up: GOALS button appears', t.btn().hidden === false);
  ok('re-check cost: 2 fetches total', t.fetches() === 2); }
{ const t = await run({ goals: [], health: false });
  t.onState({ goals: [{ id: 'g1', title: 'x', status: 'running', approvals_pending: 1 }] }); await t.tick();
  ok('first goal appears: GOALS button shown', t.btn().hidden === false);
  ok('first goal with pending approval: Needs-you shown', t.needs().hidden === false); }
{ const t = await run({ goals: [{ id: 'g1', title: 'x', status: 'running' }], health: false });
  ok('goals exist, control down: GOALS button shown', t.btn().hidden === false); }
{ const t = await run({ goals: [], health: true });
  ok('control up, no goals: GOALS button shown', t.btn().hidden === false);
  ok('control up, no goals: Needs-you stays hidden (nothing waiting)', t.needs().hidden === true); }
console.log(fails ? fails + ' FAILED' : 'orch-presence: all ok'); process.exit(fails ? 1 : 0);
