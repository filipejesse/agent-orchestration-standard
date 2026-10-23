// Shared helpers for monitor tests: spawn a TEST monitor on a free port with temp live/orch dirs (never the live monitor).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'tests-monitor', 'fixtures');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tmpDir = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
export const hookEv = (o) => JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n';
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, text: b }); }); }).on('error', reject);
  });
}
export async function startMonitor({ orch, live, env = {} }) {
  const port = await freePort();
  const p = spawn(process.execPath, [path.join(ROOT, 'monitor.mjs')], { env: { ...process.env, PORT: String(port), AOS_LIVE_DIR: live, AOS_ORCH_DIR: orch, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => { p.stdout.on('data', (d) => { if (String(d).includes('live monitor on')) res(); }); p.on('exit', () => rej(new Error('monitor exited'))); setTimeout(() => rej(new Error('monitor start timeout')), 8000); });
  return { port, get: (u) => get(port, u), stop: () => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); setTimeout(() => p.kill('SIGKILL'), 1500).unref(); }) };
}
