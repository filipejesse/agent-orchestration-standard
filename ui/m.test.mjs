// node ui/m.test.mjs : static checks for the mobile list view (m.html / m.js / m.css). The layout itself was checked in a real
// browser at 390px (iPhone 12 Pro) in light and dark, with live data and with a mocked state (errored, stalled, needs-input, two machines).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url)); let fails = 0;
const ok = (n, c) => { if (!c) fails++; console.log((c ? 'ok   ' : 'FAIL ') + n); };
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const html = read('m.html'), js = read('m.js'), css = read('m.css'), index = read('index.html');

ok('m.html loads theme tokens, m.css and m.js', /theme\.css\?v=\d+/.test(html) && /m\.css\?v=\d+/.test(html) && /m\.js\?v=\d+/.test(html));
ok('m.html has a way back to the full dashboard', /href="\.\/\?full=1"/.test(html));
ok('m.js renders with textContent only (no innerHTML / insertAdjacentHTML)', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(js));
ok('m.js is read-only: GETs /api/state and nothing else', (js.match(/fetch\(/g) || []).length === 1 && /fetch\('\/api\/state'/.test(js) && !/method:/.test(js));
ok('m.js pauses polling in a background tab', /document\.hidden/.test(js) && /visibilitychange/.test(js));
ok('m.js shares the theme key with the full dashboard', /'aos\.theme'/.test(js));
ok('m.css uses palette tokens, no hard-coded colours', !/#[0-9a-fA-F]{3,8}\b/.test(css) && /var\(--running\)/.test(css));
ok('touch targets >= 36px', /\.m-seg button\{min-height:36px/.test(css) && /\.m-chips button\{flex:none;min-height:36px/.test(css) && /\.m-row\{[^}]*min-height:56px/.test(css));
ok('reduced motion stops the pulse', /prefers-reduced-motion:reduce\)\{\.m-dot,\.m-live i\{animation:none/.test(css));
const redirect = (index.match(/<script>\/\* phones get the list view[\s\S]*?<\/script>/) || [''])[0];
ok('index.html sends phones (narrow + coarse pointer) to m.html', /max-width:720px\) and \(pointer:coarse\)/.test(redirect) && /location\.replace\('m\.html'\)/.test(redirect));
ok('index.html redirect honours ?full=1', /full=1/.test(redirect));
ok('redirect runs before the stylesheets load', index.indexOf('phones get the list view') < index.indexOf('styles.css'));
console.log(fails ? fails + ' FAILED' : 'mobile list view: all ok'); process.exit(fails ? 1 : 0);
