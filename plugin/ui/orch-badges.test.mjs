// node ui/orch-badges.test.mjs : static checks that the UI renders the out-of-scope flag (goal card, task row, worker drawer/tooltip) and the Needs-you inbox.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url)); let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + n); };
const rd = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const orch = rd('orch.js'), app = rd('app.js'), css = rd('orch.css') + rd('styles.css') + rd('global.css'), html = rd('index.html');
ok('goal card shows out_of_scope_count', /g\.out_of_scope_count[\s\S]{0,200}out of scope/.test(orch));
ok('task row shows out_of_scope badge', /t\.out_of_scope\)[\s\S]{0,200}'orch-oos'/.test(orch));
ok('worker drawer + tooltip show out of scope only from a.out_of_scope', /a\.out_of_scope\) \{ var sb = el\('span', 'tag oos-badge'/.test(app) && /a\.out_of_scope\) ml =/.test(app));
ok('badge styles exist', /\.orch-oos\{/.test(css) && /\.oos-badge\{/.test(css));
// integrity (anti-cheat) badges: static checks plus a DOM-style render of the real helper functions against a minimal fake DOM
ok('goal detail has an Integrity section fed by integrity/protected_tests/review', /label\(s, 'Integrity'\)/.test(orch) && /d\.protected_tests/.test(orch) && /d\.review/.test(orch));
ok('task row shows integrity badge, self-checks, version warning and worker error fold', /integChip\(ti\.status\)/.test(orch) && /self-checks/.test(orch) && /claude version changed/.test(orch) && /worker error, attempt/.test(orch));
ok('integrity code writes with textContent only (the single pre-existing innerHTML is the static close icon)', (orch.match(/innerHTML|insertAdjacentHTML|outerHTML/g) || []).length === 1 && /R\.close\.innerHTML = '<svg/.test(orch));
ok('integrity styles exist', /\.orch-integ-failed\{/.test(css) && /\.orch-reason\{/.test(css) && /\.orch-fold\{/.test(css));
{
  const grab = (name) => { const i = orch.indexOf('  function ' + name + '('), e = orch.indexOf('\n', i), line = orch.slice(i, e); if (/\}\s*$/.test(line) && !/\{\s*$/.test(line)) return line; const j = orch.indexOf('\n  }\n', i); return orch.slice(i, j + 4); };
  class N { constructor(t) { this.tag = t; this.children = []; this.attrs = {}; this.className = ''; this.textContent = ''; } appendChild(c) { this.children.push(c); return c; } setAttribute(k, v) { this.attrs[k] = v; } }
  const doc = { createElement: (t) => new N(t) };
  const src = 'var INTEG_OK = { clean: 1, warning: 1, failed: 1 };\n' + ['el', 'clip', 'arr', 'integChip', 'reasonChips', 'textDetails'].map(grab).join('\n');
  const f = new Function('document', src + '\nreturn { integChip, reasonChips, textDetails };')(doc);
  const c = f.integChip('failed'); ok('integChip failed', c.textContent === 'integrity: failed' && c.attrs['data-integrity'] === 'failed' && /orch-integ-failed/.test(c.className));
  ok('integChip unknown status -> clean', f.integChip('weird').attrs['data-integrity'] === 'clean');
  const p = new N('div'); f.reasonChips(p, ['tests_weakened', 'harness_tamper', 'vacuous_pass']);
  ok('reason chips', p.children.length === 3 && p.children[0].textContent === 'tests weakened' && p.children[1].attrs['data-reason'] === 'harness_tamper');
  const q = new N('div'); f.reasonChips(q, null); ok('reason chips tolerate missing', q.children.length === 0);
  const d = f.textDetails('worker error', '<img src=x onerror=alert(1)>', 'orch-werr');
  ok('stderr tail is textContent, not markup', d.tag === 'details' && d.children[1].textContent === '<img src=x onerror=alert(1)>' && d.children[1].children.length === 0);
}
console.log(fails ? fails + ' FAILED' : 'orch-badges: all ok'); process.exit(fails ? 1 : 0);
