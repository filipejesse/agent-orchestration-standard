#!/usr/bin/env node
// Helper for the Makefile: doctor / link / unlink / statusline / statusline-off.
// Zero dependencies. Every change to user config makes a timestamped backup first and is reversible.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const PLUGIN_ID = 'aos-dashboard@aos-local';
const DATA = path.join(HOME, '.claude', 'plugins', 'data', 'aos-dashboard-aos-local');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const BIN = process.env.BIN || path.join(HOME, '.local', 'bin');
const PORT = Number(process.env.PORT || process.env.AOS_PORT) || 4318;
const STATUSLINE_CMD = `node "${path.join(REPO, 'plugin', 'bin', 'aos-statusline.mjs')}"`;
// Windows refuses symlinks without admin or Developer Mode, so there `link` writes two launcher shims
// instead: `aos-dash` (Git Bash) and `aos-dash.cmd` (cmd, PowerShell). The marker line lets
// `link` / `unlink` recognise their own shims and leave anything else alone, and carries the launch target as JSON
// so `doctor` reads it back from there instead of parsing the quoting of the launch line. A symlink counts as
// ours only when it points at a plugin/bin/aos-dash (this checkout's or another AOS checkout's), never at another tool.
const WIN = process.platform === 'win32';
const SHIM_MARK = 'aos-dash shim (scripts/aos.mjs link)';
const targets = () => WIN ? [path.join(BIN, 'aos-dash'), path.join(BIN, 'aos-dash.cmd')] : [path.join(BIN, 'aos-dash')];
const lexists = (f) => { try { fs.lstatSync(f); return true; } catch { return false; } };
const isOurs = (f) => { try { const st = fs.lstatSync(f); return st.isSymbolicLink() ? /[\\/]plugin[\\/]bin[\\/]aos-dash$/.test(fs.readlinkSync(f)) : st.isFile() && fs.readFileSync(f, 'utf8').includes(SHIM_MARK); } catch { return false; } };
// The shims as written. The marker line is plain ASCII whatever the path (anything else becomes a JSON \u escape),
// because a .cmd is decoded in the console code page. sh: the native path in single quotes (' as '\''), which Git Bash
// passes to node untouched. cmd: % doubled. A non-ASCII path needs the console in UTF-8 while cmd decodes the launch
// line, so that line starts by putting the code page back: it is decoded already when node starts, and an interrupted
// node (Ctrl-C, "Terminate batch job?") cannot leave the console switched.
const mark = (src) => `${SHIM_MARK} ${JSON.stringify({ target: src }).replace(/[^\w .:\\\/"{}-]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))}`;
const shimSh = (src) => `#!/bin/sh\n# ${mark(src)}\nexec node '${src.replace(/'/g, `'\\''`)}' "$@"\n`;
const shimCmd = (src) => {
  const run = `node "${src.replace(/%/g, '%%')}" %*`;
  const utf8 = ['setlocal', `for /f "tokens=*" %%a in ('chcp') do for %%b in (%%a) do set "cp=%%~nb"`, 'chcp 65001 >nul', `chcp %cp% >nul & ${run}`];
  return ['@echo off', `rem ${mark(src)}`, ...(/^[\x20-\x7e]*$/.test(src) ? [run] : utf8)].join('\r\n') + '\r\n';
};
// What a shim written by `link` launches; null for a foreign or unreadable file, a shim from before the marker carried
// the target, or a marker whose target is not a path (edited by hand).
const shimTarget = (f) => {
  try {
    const line = fs.readFileSync(f, 'utf8').split(/\r?\n/).find((l) => l.includes(SHIM_MARK)) || '';
    const t = JSON.parse(line.slice(line.indexOf(SHIM_MARK) + SHIM_MARK.length)).target;
    return typeof t === 'string' && t ? t : null;
  } catch { return null; }
};
const isLink = (f) => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } };
const pathDirs = () => (process.env.PATH || '').split(path.delimiter).filter(Boolean);
const norm = (p) => WIN ? path.resolve(p).toLowerCase() : p;

const ok = (s) => console.log(`  ✓ ${s}`), bad = (s) => console.log(`  ✗ ${s}`), warn = (s) => console.log(`  ! ${s}`);
const EXEC = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 };
const run = (cmd, args) => { try { return execFileSync(cmd, args, EXEC); } catch (e) { return null; } };
// `claude` from npm is claude.cmd on Windows, which Node will not spawn without a shell (EINVAL; a bare name is ENOENT).
// The arguments are fixed words, so they can be joined into the command line.
const runClaude = (...args) => { try { return WIN ? execFileSync(['claude', ...args].join(' '), { ...EXEC, shell: true }) : execFileSync('claude', args, EXEC); } catch (e) { return null; } };
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
function backup(f) { if (fs.existsSync(f)) { const b = `${f}.bak-aos-${stamp()}`; fs.copyFileSync(f, b); return b; } return null; }
function probe(timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false));
  });
}

async function doctor() {
  let essential = 0;
  console.log('AOS doctor\n');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  nodeMajor >= 18 ? ok(`node ${process.versions.node}`) : (bad(`node ${process.versions.node} (need 18 or newer)`), essential++);
  const ver = runClaude('--version');
  ver ? ok(`claude CLI ${ver.trim()}`) : (bad('claude CLI not found on PATH (install Claude Code first)'), essential++);
  const list = ver ? runClaude('plugin', 'list') : null;
  if (list && list.includes('aos-dashboard') && /enabled/.test(list.split('aos-dashboard')[1] || '')) ok(`plugin ${PLUGIN_ID} installed and enabled`);
  else { bad(`plugin ${PLUGIN_ID} not installed (run: make install)`); essential++; }
  const settings = readJSON(SETTINGS);
  settings && settings.extraKnownMarketplaces && settings.extraKnownMarketplaces['aos-local'] ? ok('marketplace aos-local registered') : warn('marketplace aos-local not registered');
  const hooksLog = path.join(DATA, 'live', 'hook-events.ndjson');
  if (fs.existsSync(hooksLog)) { const age = (Date.now() - fs.statSync(hooksLog).mtimeMs) / 3600000; age < 24 ? ok(`hooks are logging (last event ${age < 1 ? Math.round(age * 60) + ' min' : age.toFixed(1) + ' h'} ago)`) : warn(`hook log is ${age.toFixed(0)} h old: open a NEW Claude Code session (existing ones keep their old hooks; or /reload-plugins)`); }
  else warn('no hook log yet: normal before your first session. Start a new Claude Code session and it appears');
  (await probe()) ? ok(`monitor reachable at http://127.0.0.1:${PORT}`) : warn(`monitor not running on :${PORT} (it starts with a session, or: make start)`);
  // What actually runs: on Windows Git Bash takes the first bare `aos-dash` on PATH and cmd / PowerShell the
  // first PATHEXT match, so both must exist and be ours; elsewhere `which` answers.
  const first = (names) => pathDirs().flatMap((d) => names.map((n) => path.join(d, n))).find((f) => fs.existsSync(f));
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean);
  const launchers = WIN ? [['Git Bash', first(['aos-dash', 'aos-dash.exe'])], ['cmd / PowerShell', first(exts.map((e) => `aos-dash${e}`))]] : [['', (run('which', ['aos-dash']) || '').trim()]];
  const onPath = [...new Set(launchers.map(([, f]) => f).filter(Boolean))], missing = launchers.filter(([, f]) => !f).map(([name]) => name);
  if (!onPath.length) warn('aos-dash not on PATH (make link)');
  else {
    // Resolve what each one launches (the symlink target, or the target recorded in a Windows shim) and the
    // checkout itself through realpath, so a symlinked / junctioned checkout still counts as this one.
    const launched = (f) => { const t = (WIN && shimTarget(f)) || f; try { return fs.realpathSync(t); } catch { return t; } };
    let repoReal = REPO; try { repoReal = fs.realpathSync(REPO); } catch {}
    const mine = norm(path.join(repoReal, 'plugin', 'bin')) + path.sep;
    const other = onPath.map((f) => [f, launched(f)]).find(([, real]) => !norm(real).startsWith(mine));
    // An older shim is ours but carries no target; a symlink (to another checkout here) never carries one.
    const older = other && WIN && !isLink(other[0]) && isOurs(other[0]) && !shimTarget(other[0]);
    if (older) warn(`aos-dash on PATH (${other[0]}) is a launcher from an older make link: run: make link to refresh it`);
    else if (other) warn(`aos-dash on PATH is a different install: ${other[0]}${other[1] === other[0] ? '' : ` -> ${other[1]}`} (not in this checkout ${REPO}; run: make link)`);
    else if (missing.length) warn(`aos-dash on PATH (${onPath.join(', ')}) but not for ${missing.join(' or ')} (run: make link, and put ${BIN} on your PATH)`);
    else ok(`aos-dash on PATH (${onPath.join(', ')})`);
  }
  settings && settings.statusLine && String(settings.statusLine.command || '').includes('aos-statusline') ? ok('status line configured') : warn('status line not configured (optional: make statusline)');
  fs.existsSync(path.join(DATA, 'AOS Notifier.app')) ? ok('notifier app built (branded macOS alerts)') : warn('notifier app not built (optional: make notifier)');
  console.log(essential ? `\n${essential} essential problem(s).` : '\nAll essentials OK.');
  process.exit(essential ? 1 : 0);
}

// [pid, command line] of each process listening on PORT, or null when the listeners could not be listed at all
// (so "nothing listens" is never guessed from a failed query). Windows has no lsof/ps, so ask PowerShell: any error
// (a missing cmdlet) ends in exit 2, except the "no such connection / process" ones that the two calls hide with
// -ErrorAction SilentlyContinue; the final `exit 0` is for the success case, where PowerShell would otherwise exit 1
// after a hidden non-fatal error even with the pid lines already printed. lsof exits 1 both when nothing matches and
// after a warning (an unreadable mount), so only a missing or killed lsof counts as "could not list".
function listeners() {
  if (WIN) {
    const ps = `$ErrorActionPreference = 'Stop'; try { foreach ($id in @(Get-NetTCPConnection -State Listen -LocalPort ${PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)) { "$id" + [char]9 + (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).CommandLine } } catch { exit 2 }; exit 0`;
    const out = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    return out === null ? null : out.split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
  }
  let out;
  try { out = execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], EXEC); } catch (e) { if (e.status !== 1) return null; out = e.stdout || ''; }
  return out.split('\n').filter(Boolean).map((p) => [p, run('ps', ['-p', p, '-o', 'command=']) || '']);
}

// Stop only the AOS monitor listening on PORT (never other monitors).
async function stop() {
  const all = listeners();
  if (!all) { bad(`could not list what listens on :${PORT} (is ${WIN ? 'powershell available' : 'lsof installed'}?): nothing was stopped`); process.exit(1); }
  const alive = (p) => { try { process.kill(Number(p), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const mine = all.filter(([, cmd]) => /monitor\.mjs/.test(cmd || '')).map(([p]) => p);
  // A live listener whose command line cannot be read (another user's or an elevated process) may well be the
  // monitor, but we cannot tell, so say so (and fail when it is the only listener, so `make restart` does not go
  // on to report the old monitor as started) instead of reporting "not running" while the port stays bound.
  // One that already exited is not a listener any more (it can go between the lsof and the ps call).
  const unknown = all.filter(([p, cmd]) => !(cmd || '').trim() && alive(p)).map(([p]) => p);
  if (unknown.length) (mine.length ? warn : bad)(`pid ${unknown.join(', ')} listens on :${PORT} but its command line could not be read${WIN ? ' (started elevated or by another user?)' : ''}: left alone`);
  if (!mine.length) { if (unknown.length) process.exit(1); console.log(`monitor was not running on :${PORT}`); return; }
  for (const p of mine) { try { process.kill(Number(p)); } catch {} }
  for (let i = 0; i < 20 && mine.some((p) => { try { process.kill(Number(p), 0); return true; } catch { return false; } }); i++) await new Promise((r) => setTimeout(r, 100));
  console.log(`monitor on :${PORT} stopped (other AOS monitors left alone)`);
}

function link() {
  const src = path.join(REPO, 'plugin', 'bin', 'aos-dash');
  if (!fs.existsSync(src)) { bad(`missing ${src} (run: make build)`); process.exit(1); }
  fs.mkdirSync(BIN, { recursive: true });
  // Decide before touching anything: if any target is foreign, refuse and leave every file as it was.
  const present = targets().filter(lexists);
  const foreign = present.find((dst) => !isOurs(dst));
  if (foreign) { bad(`${foreign} exists and is not ours: left alone (nothing changed)`); process.exit(1); }
  for (const dst of present) { try { fs.unlinkSync(dst); } catch (e) { bad(`could not replace ${dst} (${e.code}): delete it by hand, then run: make link`); process.exit(1); } }
  if (WIN) {
    const [sh, cmd] = targets();
    fs.writeFileSync(sh, shimSh(src), { mode: 0o755 });
    fs.writeFileSync(cmd, shimCmd(src));
    ok(`wrote ${sh} and ${cmd} -> ${src}`);
  } else { fs.symlinkSync(src, targets()[0]); ok(`linked ${targets()[0]} -> ${src}`); }
  if (!pathDirs().map(norm).includes(norm(BIN))) {
    const line = `export PATH="${BIN === path.join(HOME, '.local', 'bin') ? '$HOME/.local/bin' : BIN}:$PATH"`;
    if (!WIN) warn(`${BIN} is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc):\n      ${line}`);
    else warn(`${BIN} is not on your PATH. Add it for each shell you use:\n      Git Bash: add this line to ~/.bashrc:\n        ${line}\n      cmd and PowerShell: add the folder to your user PATH (then open a new terminal), either in\n        Settings > "Edit environment variables for your account" > Path > New, or in PowerShell:\n        [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User') + ';${BIN.replace(/'/g, "''")}', 'User')`);
  }
}
// A launcher that cannot be removed is reported, not thrown: `make uninstall` runs this before removing the plugin.
function unlink() {
  let any = false;
  for (const dst of targets()) {
    if (isOurs(dst)) { try { fs.unlinkSync(dst); ok(`removed ${dst}`); } catch (e) { warn(`could not remove ${dst} (${e.code}): delete it by hand`); } any = true; }
    else if (lexists(dst)) { warn(`${dst} is not ours: left alone`); any = true; }
  }
  if (!any) ok('aos-dash link not present');
}

function statusline(on) {
  const s = readJSON(SETTINGS);
  if (!s) { bad(`cannot read ${SETTINGS}`); process.exit(1); }
  if (on) {
    if (s.statusLine && !String(s.statusLine.command || '').includes('aos-statusline')) { warn(`you already have a different status line (${JSON.stringify(s.statusLine)}): left alone`); return; }
    const b = backup(SETTINGS); s.statusLine = { type: 'command', command: STATUSLINE_CMD };
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n'); ok(`status line enabled (backup: ${b})`);
  } else {
    if (!s.statusLine || !String(s.statusLine.command || '').includes('aos-statusline')) { ok('status line is not ours: nothing to remove'); return; }
    const b = backup(SETTINGS); delete s.statusLine; fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n'); ok(`status line removed (backup: ${b})`);
  }
}

const cmd = process.argv[2];
({ doctor, stop, link, unlink, statusline: () => statusline(true), 'statusline-off': () => statusline(false) }[cmd] || (() => { console.error('usage: aos.mjs doctor|stop|link|unlink|statusline|statusline-off'); process.exit(2); }))();
