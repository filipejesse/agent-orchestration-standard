// node ui/machines.test.mjs : machine filter + id stripping + chip rendering (textContent only) with a minimal fake DOM.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url)); let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + n); };
const mkEl = (tag) => ({ tag, children: [], className: '', textContent: '', hidden: false, attrs: {}, listeners: {}, appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }, get firstChild() { return this.children[0] || null; },
  setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(e, f) { this.listeners[e] = f; } });
const root = mkEl('div'); let refreshed = 0;
const win = { AosApp: { refresh() { refreshed++; } }, localStorage: { getItem: () => null, setItem() {} } };
const ctx = vm.createContext({ window: win, localStorage: win.localStorage, document: { getElementById: () => root, createElement: mkEl }, console });
ctx.AosApp = win.AosApp; vm.runInContext(fs.readFileSync(path.join(dir, 'machines.js'), 'utf8'), ctx);
const M = win.AosMachines;
const st = { agents: [{ id: 'a', machine: 'local' }, { id: 'laptop2:b', machine: 'laptop2' }, { id: 'c' }], tasks: [{ id: 't', machine: 'laptop2' }], projects: [], alerts: [], collisions: [], events: [], cost: { by_model: { m: {} } },
  machines: [{ name: 'local', ok: true, totals: { agents: 2, tokens: 5 } }, { name: 'laptop2', ok: true, totals: { agents: 1, tokens: 2000, cost_usd_est: 1.234 } }, { name: 'dead', ok: false, error: '<img src=x onerror=alert(1)>', totals: {} }], totals: { agents: 3, tokens: 2005 } };
ok('all: unfiltered', M.filter(st) === st);
ok('strip known remote prefix only', M.strip('laptop2:Claude Code·ab') === 'Claude Code·ab' && M.strip('Run A: x·1') === 'Run A: x·1' && M.strip('dead:z') === 'z');
M.render(st);
const group = root.children[0], chips = group.children;
ok('chips: All + 3 machines', chips.length === 4 && root.hidden === false);
ok('offline chip has down dot and title', chips[3].children[0].className.includes('down') && chips[3].title.includes('offline'));
ok('hostile error is text only', root.children[1].children.some((s) => s.textContent.includes('<img') && s.className.includes('off')));
chips[2].listeners.click();
ok('click -> refresh + filter laptop2', refreshed === 1 && M.selected() === 'laptop2');
const f = M.filter(st);
ok('filtered rows', f.agents.length === 1 && f.agents[0].id === 'laptop2:b' && f.tasks.length === 1 && f.cost.tokens_total === 2000 && f.cost.total_usd_est === 1.234);
ok('unknown selection falls back to all', (() => { M.render({ ...st, machines: [st.machines[0], st.machines[2]] }); return M.selected() === 'all'; })());
M.render({ machines: [st.machines[0]] }); ok('single machine hides chips', root.hidden === true);
process.exit(fails ? 1 : 0);
