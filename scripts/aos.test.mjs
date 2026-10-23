// Tests for scripts/aos.mjs: `stop` is port-scoped; doctor flags a foreign aos-dash and explains a missing hook log;
// link / unlink touch only their own launchers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AOS = path.join(REPO, 'scripts', 'aos.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Fake monitors: a file literally named monitor.mjs, listening on a given port.
const fake = path.join(tmp, 'plugin', 'monitor.mjs');
fs.mkdirSync(path.dirname(fake), { recursive: true });
fs.writeFileSync(fake, "import http from 'node:http'; http.createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');");
const free = () => 41000 + Math.floor(Math.random() * 2000);
const pa = free(), pb = pa + 2001;
const kids = [pa, pb].map((p) => spawn(process.execPath, [fake], { env: { ...process.env, PORT: String(p) }, stdio: 'ignore' }));
await sleep(700);
assert.ok(kids.every((k) => alive(k.pid)), 'fake monitors up');
const r = spawnSync(process.execPath, [AOS, 'stop'], { env: { ...process.env, PORT: String(pa) }, encoding: 'utf8' });
await sleep(300);
assert.match(r.stdout, new RegExp(`:${pa} stopped`));
assert.equal(alive(kids[0].pid), false, 'monitor on PORT stopped');
assert.equal(alive(kids[1].pid), true, 'monitor on another port untouched');
kids[1].kill();

const WIN = process.platform === 'win32';
// Nothing on the port is "not running" (lsof exits 1 then), but a failed query (no powershell or lsof on PATH: Node
// looks it up there) is an error, never "nothing listens"
const idle = spawnSync(process.execPath, [AOS, 'stop'], { env: { ...process.env, PORT: String(pa) }, encoding: 'utf8' });
assert.equal(idle.status, 0, `stop succeeds when nothing listens: ${idle.stdout}`);
assert.match(idle.stdout, /was not running/);
const noTool = spawnSync(process.execPath, [AOS, 'stop'], { env: { PATH: path.join(tmp, 'nowhere'), PORT: String(pa) }, encoding: 'utf8' });
assert.equal(noTool.status, 1, 'stop fails when the listeners cannot be listed');
assert.match(noTool.stdout, WIN ? /could not list what listens .*powershell/ : /could not list what listens .*lsof/);

// doctor: foreign aos-dash on PATH and missing hook log
// (Windows: no symlinks without admin, so the other install is another checkout's `link` output, made by a copy of
// this script run from there; os.homedir() reads USERPROFILE)
const home = path.join(tmp, 'home'); fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
const other = path.join(tmp, 'other-install'); fs.mkdirSync(path.join(other, 'plugin', 'bin'), { recursive: true });
fs.writeFileSync(path.join(other, 'plugin', 'bin', 'aos-dash'), '#!/bin/sh\n', { mode: 0o755 });
if (WIN) {
  fs.mkdirSync(path.join(other, 'scripts')); fs.copyFileSync(AOS, path.join(other, 'scripts', 'aos.mjs'));
  assert.equal(spawnSync(process.execPath, [path.join(other, 'scripts', 'aos.mjs'), 'link'], { env: { ...process.env, BIN: path.join(home, 'bin') }, encoding: 'utf8' }).status, 0);
} else fs.symlinkSync(path.join(other, 'plugin', 'bin', 'aos-dash'), path.join(home, 'bin', 'aos-dash'));
const sysPath = WIN ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
const doctor = (h, dirs) => spawnSync(process.execPath, [AOS, 'doctor'], { env: { HOME: h, USERPROFILE: h, PATH: [...dirs, ...sysPath].join(path.delimiter), PORT: '1' }, encoding: 'utf8' });
const d = doctor(home, [path.join(home, 'bin')]);
assert.match(d.stdout, /different install: .* -> .*other-install[\\/]plugin[\\/]bin[\\/]aos-dash/, 'doctor names what the foreign launcher runs');
assert.match(d.stdout, /normal before your first session/);

// doctor: a claude that is a .cmd (what npm installs on Windows) is found and run
const fakeBin = path.join(tmp, 'fakeclaude'); fs.mkdirSync(fakeBin);
if (WIN) fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@echo off\r\nif "%1"=="--version" echo 9.9.9 (Claude Code)\r\nif "%1"=="plugin" echo aos-dashboard@aos-local  enabled\r\n');
else fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\n[ "$1" = --version ] && echo "9.9.9 (Claude Code)"\n[ "$1" = plugin ] && echo "aos-dashboard@aos-local  enabled"\nexit 0\n', { mode: 0o755 });
const dc = doctor(home, [path.join(home, 'bin'), fakeBin]);
assert.match(dc.stdout, /claude CLI 9\.9\.9/, 'doctor runs claude');
assert.match(dc.stdout, /plugin aos-dashboard@aos-local installed and enabled/);

// doctor: an aos-dash that reaches this checkout through an alias (junction on Windows, symlink elsewhere) is ours
// (Windows shims as `link` writes them: the marker line names the target)
const OK = /\u2713 aos-dash on PATH \(/;
const markLine = (t) => `aos-dash shim (scripts/aos.mjs link) ${JSON.stringify({ target: t })}`;
const writeShims = (dir, t, which = ['sh', 'cmd']) => {
  fs.mkdirSync(dir, { recursive: true });
  if (which.includes('sh')) fs.writeFileSync(path.join(dir, 'aos-dash'), `#!/bin/sh\n# ${markLine(t)}\n`);
  if (which.includes('cmd')) fs.writeFileSync(path.join(dir, 'aos-dash.cmd'), `@echo off\r\nrem ${markLine(t)}\r\n`);
};
const alias = path.join(tmp, 'alias'); fs.symlinkSync(REPO, alias, WIN ? 'junction' : 'dir');
try {
  const viaAlias = path.join(alias, 'plugin', 'bin', 'aos-dash');
  const home2 = path.join(tmp, 'home2'); fs.mkdirSync(path.join(home2, 'bin'), { recursive: true });
  if (WIN) writeShims(path.join(home2, 'bin'), viaAlias);
  else fs.symlinkSync(viaAlias, path.join(home2, 'bin', 'aos-dash'));
  const d2 = doctor(home2, [path.join(home2, 'bin')]);
  assert.match(d2.stdout, OK, 'aliased checkout recognised as this install');
  assert.doesNotMatch(d2.stdout, /different install/);
  if (WIN) {
    // each of Git Bash and cmd / PowerShell needs its own launcher on PATH
    writeShims(path.join(tmp, 'only-cmd'), viaAlias, ['cmd']);
    assert.match(doctor(home, [path.join(tmp, 'only-cmd')]).stdout, /aos-dash on PATH .* but not for Git Bash/, 'doctor warns when Git Bash has no launcher');
    writeShims(path.join(tmp, 'only-sh'), viaAlias, ['sh']);
    assert.match(doctor(home, [path.join(tmp, 'only-sh')]).stdout, /aos-dash on PATH .* but not for cmd \/ PowerShell/, 'doctor warns when cmd has no launcher');
    // a shim from before the marker carried the target is ours to refresh, not "a different install"
    const older = path.join(tmp, 'older'); fs.mkdirSync(older);
    for (const n of ['aos-dash', 'aos-dash.cmd']) fs.writeFileSync(path.join(older, n), 'rem aos-dash shim (scripts/aos.mjs link)\r\n');
    assert.match(doctor(home, [older]).stdout, /launcher from an older make link/);
    // a marker edited by hand, with a target that is not a path, is reported, not a crash
    const edited = path.join(tmp, 'edited'); fs.mkdirSync(edited);
    for (const n of ['aos-dash', 'aos-dash.cmd']) fs.writeFileSync(path.join(edited, n), 'rem aos-dash shim (scripts/aos.mjs link) {"target":5}\r\n');
    const de = doctor(home, [edited]);
    assert.doesNotMatch(de.stderr, /TypeError|Error:/, `doctor does not throw on a bad marker: ${de.stderr}`);
    assert.match(de.stdout, /All essentials OK|essential problem/, 'doctor runs to the end');
  }
} finally { fs.unlinkSync(alias); } // never leave a link into the live checkout behind in the temp folder

// link / unlink: own launchers are replaced and removed; a foreign file is left alone
const bin = path.join(tmp, 'linkbin'), names = WIN ? ['aos-dash', 'aos-dash.cmd'] : ['aos-dash'];
const aos = (c) => spawnSync(process.execPath, [AOS, c], { env: { ...process.env, BIN: bin }, encoding: 'utf8' });
for (let i = 0; i < 2; i++) assert.equal(aos('link').status, 0, 'link (twice: replaces its own launchers)');
assert.ok(names.every((n) => fs.existsSync(path.join(bin, n))), 'launchers written');
assert.match(doctor(home, [bin]).stdout, OK, 'doctor reads back the launchers link wrote');
if (WIN) {
  // cmd and PowerShell run the first PATHEXT match on PATH, so a foreign .bat ahead of the shims is what they get
  const early = path.join(tmp, 'early'); fs.mkdirSync(early); fs.writeFileSync(path.join(early, 'aos-dash.bat'), '@echo off\r\n');
  assert.match(doctor(home, [early, bin]).stdout, /different install: .*early[\\/]aos-dash\.bat/, 'doctor checks what cmd runs, not just any .cmd');
}
aos('unlink');
assert.ok(names.every((n) => !fs.existsSync(path.join(bin, n))), 'launchers removed');
fs.writeFileSync(path.join(bin, 'aos-dash'), 'not ours\n');
assert.equal(aos('link').status, 1, 'link refuses to replace a foreign aos-dash');
aos('unlink');
assert.equal(fs.readFileSync(path.join(bin, 'aos-dash'), 'utf8'), 'not ours\n', 'unlink leaves a foreign aos-dash alone');

// link reports an own launcher it cannot remove instead of throwing (a read-only folder; skipped on Windows, where
// Node deletes read-only files, and for root, who may write anywhere)
if (!WIN && process.getuid() !== 0) {
  const robin = path.join(tmp, 'robin'), raos = (c) => spawnSync(process.execPath, [AOS, c], { env: { ...process.env, BIN: robin }, encoding: 'utf8' });
  assert.equal(raos('link').status, 0);
  fs.chmodSync(robin, 0o555);
  try {
    const rl = raos('link');
    assert.equal(rl.status, 1, 'link fails when its launcher cannot be removed');
    assert.match(rl.stdout, /could not replace .*delete it by hand/);
    assert.doesNotMatch(rl.stderr, /at .*aos\.mjs/, 'no stack trace');
  } finally { fs.chmodSync(robin, 0o755); }
}

// A symlink is ours only when it points at a plugin/bin/aos-dash: one to another tool (dangling or not) is left alone
// (skipped where the account may not create symlinks)
const sbin = path.join(tmp, 'symbin'), sdst = path.join(sbin, 'aos-dash'), saos = (c) => spawnSync(process.execPath, [AOS, c], { env: { ...process.env, BIN: sbin }, encoding: 'utf8' });
fs.mkdirSync(sbin);
let symlinks = true; try { fs.symlinkSync(path.join(tmp, 'some-other-tool'), sdst); } catch { symlinks = false; }
if (symlinks) {
  assert.equal(saos('link').status, 1, 'link refuses to replace a symlink to another tool');
  saos('unlink');
  assert.ok(fs.lstatSync(sdst).isSymbolicLink(), 'unlink leaves a symlink to another tool alone');
  fs.unlinkSync(sdst); fs.symlinkSync(path.join(other, 'plugin', 'bin', 'aos-dash'), sdst);
  // a symlink into another checkout is that install, not an older shim of this one
  const ds = doctor(home, [sbin]).stdout;
  assert.match(ds, /different install: .*other-install/, `doctor names the other checkout: ${ds}`);
  assert.doesNotMatch(ds, /older make link/);
  assert.equal(saos('link').status, 0, 'link replaces a symlink to an aos-dash');
}
if (WIN) {
  // Refusal changes nothing: own sh shim + foreign .cmd must leave the sh shim in place
  fs.unlinkSync(path.join(bin, 'aos-dash'));
  assert.equal(aos('link').status, 0);
  const ownSh = fs.readFileSync(path.join(bin, 'aos-dash'), 'utf8');
  fs.writeFileSync(path.join(bin, 'aos-dash.cmd'), '@echo off\r\nrem someone else\r\n');
  assert.equal(aos('link').status, 1, 'link refuses when the .cmd is foreign');
  assert.equal(fs.readFileSync(path.join(bin, 'aos-dash'), 'utf8'), ownSh, 'refusal left the own sh shim untouched');
  assert.match(fs.readFileSync(path.join(bin, 'aos-dash.cmd'), 'utf8'), /someone else/, 'refusal left the foreign .cmd untouched');

  // Both launchers survive a checkout path with non-ASCII and shell-special characters (a copy of this script
  // in such a folder, with a stand-in aos-dash that echoes its arguments, can report the console code page it runs
  // under and exits with a code it is given; 0x142 is the Polish l with stroke)
  const odd = path.join(tmp, `Micha${String.fromCharCode(0x142)} 100% $x 'q' a&b ^(!)`);
  fs.mkdirSync(path.join(odd, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(odd, 'plugin', 'bin'), { recursive: true });
  fs.copyFileSync(AOS, path.join(odd, 'scripts', 'aos.mjs'));
  fs.writeFileSync(path.join(odd, 'plugin', 'bin', 'aos-dash'), "console.log(JSON.stringify(process.argv.slice(2)));\nif (process.env.AOS_TEST_CP) { try { console.log('cp ' + require('node:child_process').execSync('chcp', { encoding: 'utf8' })); } catch {} }\nprocess.exit(Number(process.env.AOS_TEST_EXIT || 0));\n");
  const oddBin = path.join(tmp, 'oddbin');
  assert.equal(spawnSync(process.execPath, [path.join(odd, 'scripts', 'aos.mjs'), 'link'], { env: { ...process.env, BIN: oddBin }, encoding: 'utf8' }).status, 0);
  // cmd /s /c "<line>" keeps the line as written, so a temp folder with a space in it (C:\Users\John Smith) works too
  const cmdRun = (line, env) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', windowsVerbatimArguments: true, env: { ...process.env, ...env } });
  const launcher = `"${path.join(oddBin, 'aos-dash.cmd')}"`;
  const viaCmd = cmdRun(`${launcher} "a b" c`);
  assert.match(viaCmd.stdout, /\["a b","c"\]/, `cmd launcher ran the odd path: ${viaCmd.stderr}`);
  assert.equal(cmdRun(`${launcher} x`, { AOS_TEST_EXIT: '3' }).status, 3, 'cmd launcher passes the exit code through');
  const cpOf = (s) => (/(\d+)\s*$/.exec(s) || [])[1];
  const cpBefore = cpOf(cmdRun('chcp').stdout);
  if (cpBefore) { // needs a console to read the code page from
    assert.equal(cpOf(cmdRun(`${launcher} x & chcp`, { AOS_TEST_CP: '1' }).stdout), cpBefore, 'console code page is back as it was');
    assert.match(cmdRun(`${launcher} x`, { AOS_TEST_CP: '1' }).stdout, new RegExp(`cp [^\\n]*${cpBefore}`), 'node already runs under the original code page');
  }
  const cmdBytes = fs.readFileSync(path.join(oddBin, 'aos-dash.cmd'));
  assert.ok(cmdBytes.subarray(0, cmdBytes.indexOf('chcp 65001')).every((b) => b < 0x80), 'what cmd decodes before it switches to UTF-8 is ASCII');
  const viaSh = spawnSync('sh', [path.join(oddBin, 'aos-dash'), 'a b', 'c'], { encoding: 'utf8' });
  if (!viaSh.error) assert.match(viaSh.stdout, /\["a b","c"\]/, `sh launcher ran the odd path: ${viaSh.stderr}`);
  // doctor reads the target back out of the marker, whatever is in the path
  const dOdd = spawnSync(process.execPath, [AOS, 'doctor'], { env: { HOME: home, USERPROFILE: home, PATH: [oddBin, ...sysPath].join(path.delimiter), PORT: '1' }, encoding: 'utf8' });
  assert.ok(dOdd.stdout.includes(path.join(odd, 'plugin', 'bin', 'aos-dash')), `doctor names the odd target: ${dOdd.stdout}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('aos.mjs: all tests passed');
