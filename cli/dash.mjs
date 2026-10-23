#!/usr/bin/env node
// AOS terminal dashboard. Zero dependencies, Node 18+. Talks to 127.0.0.1 only.
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- palette
const PAL = {
  bone: [232, 225, 210], text2: [194, 188, 174], muted: [169, 167, 159], dim: [107, 103, 94],
  brass: [196, 163, 90], brasshi: [220, 192, 124], brassdim: [128, 108, 62],
  idle: [138, 148, 170], stalled: [217, 142, 58], errored: [208, 104, 92],
};
const SGR16 = { bone: '37', text2: '37', muted: '37', dim: '90', brass: '33', brasshi: '93', brassdim: '33', idle: '36', stalled: '95', errored: '31' };
const STATUS_ROLE = { running: 'brass', idle: 'idle', stalled: 'stalled', errored: 'errored' };
const STATUS_GLYPH = { running: '●', idle: '○', stalled: '◆', errored: '■' };
const PARTICLES = ['·', '∙', '•', '⋅'];

export function detectColor(env = process.env, stream = process.stdout, argv = []) {
  if (argv.includes('--no-color') || (env.NO_COLOR !== undefined && env.NO_COLOR !== '') || !stream.isTTY) return 'none';
  if (/truecolor|24bit/i.test(env.COLORTERM || '')) return 'true';
  if (/256/.test(env.TERM || '')) return '256';
  return '16';
}
function sgr(role, mode, bold) {
  if (mode === 'none' || !role) return '';
  const b = bold ? '1;' : '';
  if (mode === '16') return `\x1b[${b}${SGR16[role] || '37'}m`;
  const [r, g, bl] = PAL[role] || PAL.bone;
  if (mode === '256') {
    const q = (v) => Math.round(v / 255 * 5);
    return `\x1b[${b}38;5;${16 + 36 * q(r) + 6 * q(g) + q(bl)}m`;
  }
  return `\x1b[${b}38;2;${r};${g};${bl}m`;
}

// ---------------------------------------------------------------- helpers
const len = (s) => [...s].length;
const clip = (s, n) => { const a = [...s]; return a.length <= n ? s : n <= 0 ? '' : a.slice(0, n - 1).join('') + '…'; };
let remoteNames = []; // remote machine names in the current state: their agent ids are "<name>:<id>"
export function splitId(id) {
  let s = String(id || ''); const c = s.indexOf(':');
  if (c > 0 && remoteNames.includes(s.slice(0, c))) s = s.slice(c + 1); const i = s.lastIndexOf('·');
  return i < 0 ? { name: s.replace(/^agent[-_]/, ''), short: '' } : { name: s.slice(0, i).trim(), short: s.slice(i + 1).trim() };
}
// --machine <name>: keep only that machine's rows (cost falls back to the agents' own usage)
export function filterMachine(state, name) {
  if (!state || !name || !Array.isArray(state.agents)) return state;
  const keep = (l) => (Array.isArray(l) ? l.filter((x) => (x.machine || 'local') === name) : l);
  return { ...state, agents: keep(state.agents), tasks: keep(state.tasks), projects: keep(state.projects), alerts: keep(state.alerts), collisions: keep(state.collisions), events: keep(state.events), goals: keep(state.goals), cost: { by_model: {} } };
}
export function machinesLine(state) {
  const ms = state && Array.isArray(state.machines) ? state.machines : [];
  if (ms.length < 2) return '';
  return 'machines: ' + ms.map((m) => m.ok ? `${m.name} ● ${(m.totals && m.totals.agents) || 0} agents ${fmtN(m.totals && m.totals.tokens)} tok` : `${m.name} ○ offline${m.error ? ' (' + m.error + ')' : ''}`).join(' · ');
}
const isMain = (a) => splitId(a.id).name === 'Claude Code';
const fmtN = (n) => { n = Number(n) || 0; return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)); };
const newTok = (u) => u ? (u.input || 0) + (u.output || 0) + (u.cache_write || 0) : 0;
// wall-clock run time: 45s, 12m, 1h 05m; '-' when the monitor did not send ran_s (older monitor)
export function fmtDur(s) {
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) return '-';
  s = Math.round(s); if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
export function costTotals(state) {
  const bm = state && state.cost && state.cost.by_model;
  let nw = 0, cr = 0;
  if (bm && Object.keys(bm).length) for (const m of Object.values(bm)) { nw += newTok(m); cr += m.cache_read || 0; }
  else for (const a of (state && state.agents) || []) { nw += newTok(a.usage); cr += (a.usage && a.usage.cache_read) || 0; }
  return { nw, cr };
}
export function snapshotJson(state) {
  const agents = ((state && state.agents) || []).map((a) => ({ id: a.id, role: a.role, status: a.status, model_label: a.model_label }));
  const out = { agents };
  if (state && Array.isArray(state.tasks) && state.tasks.length) out.tasks = state.tasks;
  out.totals = { agents: agents.length, tokens_total: costTotals(state).nw };
  return out;
}
function wrapName(name, max) {
  if (len(name) <= max) return [name];
  const words = name.split(/\s+/); let l1 = '', i = 0;
  while (i < words.length && len((l1 ? l1 + ' ' : '') + words[i]) <= max) l1 += (l1 ? ' ' : '') + words[i++];
  if (!l1) return [clip(name, max)];
  return [l1, clip(words.slice(i).join(' '), max)];
}

// ---------------------------------------------------------------- grid
class Grid { // put() replaces control characters from state with spaces, so no terminal escapes are ever emitted from data
  constructor(cols, rows) { this.cols = cols; this.rows = rows; this.ch = Array.from({ length: rows }, () => Array(cols).fill(' ')); this.st = Array.from({ length: rows }, () => Array(cols).fill(null)); }
  put(x, y, text, role, bold) { let i = 0; for (let c of String(text)) { if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(c)) c = ' '; const xx = x + i++; if (xx >= 0 && xx < this.cols && y >= 0 && y < this.rows) { this.ch[y][xx] = c; this.st[y][xx] = role ? role + (bold ? '!' : '') : null; } } }
  segs(x, y, segs) { for (const [t, r, b] of segs) { this.put(x, y, t, r, b); x += len(t); } }
  text() { return this.ch.map((r) => r.join('').replace(/\s+$/, '')); }
  ansi(mode) {
    return this.ch.map((row, y) => {
      let end = row.length; while (end > 0 && row[end - 1] === ' ' && !this.st[y][end - 1]) end--;
      let out = '', cur = undefined;
      for (let x = 0; x < end; x++) {
        const s = this.st[y][x];
        if (s !== cur) { out += (cur ? '\x1b[0m' : '') + (s ? sgr(s.replace('!', ''), mode, s.endsWith('!')) : ''); cur = s; }
        out += row[x];
      }
      return out + (cur ? '\x1b[0m' : '');
    });
  }
}

// ---------------------------------------------------------------- layout
const rectsOverlap = (a, b, gap = 0) => a.x0 - gap < b.x0 + b.w && b.x0 - gap < a.x0 + a.w && a.y0 - gap < b.y0 + b.h && b.y0 - gap < a.y0 + a.h;

function labelSegs(a, level) {
  const sp = splitId(a.id); const L = [];
  if (level === 3) return [[[clip(sp.name, 14), 'bone', true]]]; // compact: name only
  const nm = level === 0 ? wrapName(sp.name, 22) : [clip(sp.name, 22)];
  for (const n of nm) L.push([[n, 'bone', true]]);
  const st = String(a.status || 'idle');
  const stSeg = [...(sp.short ? [[sp.short + ' · ', 'muted']] : []), [st.toUpperCase(), STATUS_ROLE[st] || 'idle']];
  if (typeof a.ran_s === 'number' && segW(stSeg) + len(' · ran ' + fmtDur(a.ran_s)) <= 22) stSeg.push([' · ran ' + fmtDur(a.ran_s), 'muted']); // only when it fits the label width
  L.push(stSeg);
  if (level < 2 && a.model_label) L.push([[clip((a.model_mismatch ? '!' + a.requested_tier + ' ' : '') + String(a.model_label), 22), a.model_mismatch ? 'stalled' : 'muted']]);
  return L;
}
const segW = (segs) => segs.reduce((n, s) => n + len(s[0]), 0);

function centreInfo(mains) {
  const n = mains.length; const running = mains.filter((a) => a.status === 'running').length;
  const status = running ? 'running' : mains.some((a) => a.status === 'errored') ? 'errored' : mains.some((a) => a.status === 'stalled') ? 'stalled' : 'idle';
  let lines;
  if (n === 0) lines = [[['ORCHESTRATOR', 'bone', true]]];
  else if (n === 1) {
    const sp = splitId(mains[0].id);
    lines = [[['CLAUDE CODE', 'bone', true]], [[(sp.short ? sp.short + ' · ' : ''), 'muted'], [String(mains[0].status || 'idle').toUpperCase(), STATUS_ROLE[mains[0].status] || 'idle']]];
    if (mains[0].model_label) lines.push([[clip(String(mains[0].model_label), 24), 'muted']]);
  } else {
    lines = [[['CLAUDE CODE · ' + n + ' SESSIONS', 'bone', true]], [[running + ' running · ' + (n - running) + ' other', 'muted']]];
    const models = [...new Set(mains.map((a) => a.model_label).filter(Boolean))];
    if (models.length) lines.push([[clip(models.join(' / '), 26), 'muted']]);
  }
  return { status, lines };
}

// opts.labels: 'full' | 'compact' (name only) | null (orbs only, no label text).
// Orbs-only never fails: orbs that cannot be placed without touching the centre or another orb are skipped.
function tryLayout(ring, mains, cols, rows, opts = {}) {
  const { gap = 1, labels = 'full' } = opts;
  const orbsOnly = labels === null;
  const top = 2, bottom = orbsOnly ? rows - 3 : rows - 2; // inclusive body rows; orbs-only keeps row rows-2 for the notice
  const cx = Math.floor((cols - 1) / 2), cy = top + Math.floor((bottom - top) / 2);
  const ry = orbsOnly ? Math.max(0, Math.min(cy - top, bottom - cy) - 1) : Math.min(cy - top, bottom - cy) - 4;
  if (!orbsOnly && ry < 3) return null;
  let cinfo = centreInfo(mains);
  const cw = Math.max(...cinfo.lines.map(segW));
  const cbox = { x0: cx - Math.floor(cw / 2), y0: cy + 1, w: cw, h: cinfo.lines.length };
  if (orbsOnly) { // keep the centre text above the notice row
    cinfo = { ...cinfo, lines: cinfo.lines.slice(0, Math.max(0, Math.min(cinfo.lines.length, bottom - cbox.y0 + 1))) };
    cbox.h = cinfo.lines.length;
  }
  const occupied = [{ x0: cx, y0: cy, w: 1, h: 1 }, cbox];
  const n = ring.length;
  const maxLabel = labels === 'compact' ? 14 : 22;
  const side0 = orbsOnly ? 2 : maxLabel + 3;
  const rx = Math.max(0, Math.min(Math.round(Math.max(ry, 0) * 2.2), cx - side0, cols - 1 - cx - side0));
  if (!orbsOnly && n && rx < 6) return null;
  const out = { cx, cy, ry, rx, cinfo, cbox, orbs: [], labels: [], mode: 'ring', labelMode: orbsOnly ? null : labels };
  const placed = [];
  for (let i = 0; i < n; i++) {
    const th = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const ox = cx + Math.round(rx * Math.cos(th)), oy = cy + Math.round(ry * Math.sin(th));
    const orb = { x0: ox, y0: oy, w: 1, h: 1 };
    if (occupied.some((r) => rectsOverlap(orb, r)) || placed.some((p) => rectsOverlap(orb, p.orb))) {
      if (orbsOnly) continue;
      return null;
    }
    placed.push({ orb, ox, oy, th, a: ring[i] });
    out.orbs.push({ id: ring[i].id, x: ox, y: oy, status: ring[i].status });
  }
  for (const p of placed) occupied.push(p.orb);
  if (orbsOnly) return out;
  const levels = labels === 'compact' ? [3] : [0, 1, 2];
  const cs = Math.cos;
  for (const p of placed) {
    const side = Math.abs(cs(p.th)) < 0.3 ? (Math.sin(p.th) < 0 ? 'top' : 'bottom') : cs(p.th) < 0 ? 'left' : 'right';
    let ok = null;
    for (const level of levels) {
      if (ok) break;
      const lines = labelSegs(p.a, level); const w = Math.max(...lines.map(segW)); const h = lines.length;
      const cands = [];
      for (let d = 0; d <= 9; d++) {
        const ds = d === 0 ? [0] : [-d, d];
        for (const s of ds) { cands.push([0, s]); if (side === 'top' || side === 'bottom') cands.push([s * 2, 0]); }
      }
      for (const [dx, dy] of cands) {
        let x0, y0;
        if (side === 'left') { x0 = p.ox - 1 - w; y0 = p.oy - Math.floor((h - 1) / 2); }
        else if (side === 'right') { x0 = p.ox + 2; y0 = p.oy - Math.floor((h - 1) / 2); }
        else { x0 = p.ox - Math.floor(w / 2); y0 = side === 'top' ? p.oy - h : p.oy + 1; }
        x0 += dx; y0 += dy;
        const box = { x0, y0, w, h };
        if (x0 < 0 || x0 + w > cols || y0 < top || y0 + h - 1 > bottom) continue;
        if (occupied.some((r) => rectsOverlap(box, r, r === p.orb ? 0 : (r.w === 1 && r.h === 1 ? 0 : gap)))) continue;
        ok = { box, lines, side, w }; break;
      }
    }
    if (!ok) return null;
    occupied.push(ok.box);
    out.labels.push({ id: p.a.id, ...ok.box, side: ok.side, lines: ok.lines });
  }
  return out;
}

function bresenham(x0, y0, x1, y1) {
  const pts = []; let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
  for (;;) { pts.push([x0, y0]); if (x0 === x1 && y0 === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; } }
  return pts;
}

// particle schedule: [spacing in cells, frames per cell step]
const FLOW = { running: [3, 1], stalled: [11, 6], idle: [9, 4], errored: null };

// ---------------------------------------------------------------- project graph
// heart (all Claude Code sessions) -> project hubs on an ellipse -> agents on an outward arc around each hub.
// Static and deterministic. A layout cache ({layouts, fails} Maps, passed as opts.cache) keeps existing cells when agents arrive.
const TAU = Math.PI * 2;
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
export function projectGroups(state) {
  if (!state || !Array.isArray(state.projects) || !state.projects.length) return null;
  const agents = state.agents || []; const byId = new Map(agents.map((a) => [a.id, a])); const seen = new Set(); const out = [];
  for (const p of state.projects) {
    const ag = (p.agents || []).map((id) => byId.get(id)).filter((a) => a && !seen.has(a.id));
    ag.forEach((a) => seen.add(a.id));
    if (ag.length) out.push({ id: String(p.id), name: String(p.name || p.id), agents: ag, p });
  }
  const rest = agents.filter((a) => !seen.has(a.id));
  if (rest.length) out.push({ id: '~other', name: 'other', agents: rest, p: null });
  return out.length ? out : null;
}
const nRun = (g) => g.agents.filter((a) => a.status === 'running').length;
function hubStatus(g) {
  if (nRun(g)) return 'running';
  if (g.agents.some((a) => a.status === 'errored')) return 'errored';
  return g.agents.some((a) => a.status === 'stalled') ? 'stalled' : 'idle';
}
function hubLines(g, labels, W) {
  const head = [[clip(g.name, W), 'brasshi', true]];
  return labels === 'compact' ? [head] : [head, [[clip(plural(g.agents.length, 'agent') + ' · ' + nRun(g) + ' running', W), 'muted']]];
}
const sideOf = (phi) => { const c = Math.cos(phi); return Math.abs(c) < 0.3 ? (Math.sin(phi) < 0 ? 'top' : 'bottom') : c < 0 ? 'left' : 'right'; };
function boxAt(side, x, y, w, h, dx = 0, dy = 0) {
  let x0, y0;
  if (side === 'left') { x0 = x - 1 - w; y0 = y - Math.floor((h - 1) / 2); }
  else if (side === 'right') { x0 = x + 2; y0 = y - Math.floor((h - 1) / 2); }
  else { x0 = x - Math.floor(w / 2); y0 = side === 'top' ? y - h : y + 1; }
  return { x0: x0 + dx, y0: y0 + dy, w, h };
}
const CAND = {};
for (const side of ['left', 'right', 'top', 'bottom']) {
  const c = [];
  for (let d = 0; d <= 9; d++) for (const s of d ? [-d, d] : [0]) { c.push([0, s]); if (side === 'top' || side === 'bottom') c.push([s * 2, 0]); }
  if (side === 'left' || side === 'right') for (let d = 1; d <= 8; d++) c.push([(side === 'left' ? -1 : 1) * d * 2, 0]);
  CAND[side] = c;
}
const SIDE_ORDER = { left: ['left', 'bottom', 'top', 'right'], right: ['right', 'bottom', 'top', 'left'], top: ['top', 'right', 'left', 'bottom'], bottom: ['bottom', 'right', 'left', 'top'] };

function layoutGraph(groups, nMains, cols, rows, opts = {}, cache = null) {
  const { gap = 1, labels = 'full' } = opts; const orbsOnly = labels === null;
  const top = 2, bottom = orbsOnly ? rows - 3 : rows - 2;
  if (bottom - top < 6) return null;
  const cxC = Math.floor((cols - 1) / 2), cyC = top + Math.floor((bottom - top) / 2);
  let cx = cxC, cy = cyC;
  const W = labels === 'compact' ? 14 : 22; const levels = labels === 'compact' ? [3] : [0, 1, 2];
  const total = groups.reduce((n, g) => n + g.agents.length, 0);
  const sig = `${cols}x${rows}|${labels}|${gap}|${groups.map((g) => g.id).join('\u0001')}`;
  if (cache && cache.fails.get(sig) === total) return null;
  const allA = groups.flatMap((g) => g.agents); const running = allA.filter((a) => a.status === 'running').length;
  const cstatus = running ? 'running' : allA.some((a) => a.status === 'errored') ? 'errored' : allA.some((a) => a.status === 'stalled') ? 'stalled' : 'idle';
  const sessions = nMains || groups.length;
  let clines = [[['CLAUDE CODE · ' + sessions + (sessions === 1 ? ' SESSION' : ' SESSIONS'), 'bone', true]], [[running + ' running', 'muted']]];
  const cw = Math.max(...clines.map(segW));
  const cbox = { x0: cx - Math.floor(cw / 2), y0: cy + 1, w: cw, h: clines.length };
  if (orbsOnly) { clines = clines.slice(0, Math.max(0, Math.min(clines.length, bottom - cbox.y0 + 1))); cbox.h = clines.length; }
  if (cbox.x0 < 0 || cbox.x0 + cbox.w > cols) return null;
  const setHeart = (x, y) => { cx = x; cy = y; cbox.x0 = x - Math.floor(cw / 2); cbox.y0 = y + 1; };
  const cinfo = { status: cstatus, lines: clines };

  const occ = new Uint8Array(cols * rows);
  const inb = (x, y) => x >= 0 && x < cols && y >= top && y <= bottom;
  const orbFree = (x, y) => inb(x, y) && !occ[y * cols + x];
  const mark = (b, v) => { for (let y = b.y0; y < b.y0 + b.h; y++) for (let x = b.x0; x < b.x0 + b.w; x++) occ[y * cols + x] = v; };
  const boxOk = (b) => {
    if (b.x0 < 0 || b.x0 + b.w > cols || b.y0 < top || b.y0 + b.h - 1 > bottom) return false;
    for (let y = Math.max(0, b.y0 - gap); y <= Math.min(rows - 1, b.y0 + b.h - 1 + gap); y++) for (let x = Math.max(0, b.x0 - gap); x <= Math.min(cols - 1, b.x0 + b.w - 1 + gap); x++) {
      const v = occ[y * cols + x]; if (!v) continue;
      if (x >= b.x0 && x < b.x0 + b.w && y >= b.y0 && y < b.y0 + b.h) return false;
      if (v === 2) return false;
    }
    return true;
  };
  const reset = () => { occ.fill(0); occ[cy * cols + cx] = 1; mark(cbox, 2); };
  const findOrb = (x, y, r) => {
    for (let k = 0; k <= r; k++) for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) { if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue; if (orbFree(x + dx, y + dy)) return [x + dx, y + dy]; }
    return null;
  };
  const labelFor = (x, y, phi, a) => {
    const prim = sideOf(phi);
    for (const level of levels) {
      const lines = labelSegs(a, level);
      for (const side of SIDE_ORDER[prim]) for (const [dx, dy] of CAND[side]) {
        const box = boxAt(side, x, y, W, lines.length, dx, dy);
        if (boxOk(box)) return { box, side, lines, level };
      }
    }
    return null;
  };
  const placeHubLabel = (h) => {
    const hh = h.lines.length; const trunk = new Set(bresenham(cx, cy, h.x, h.y).map(([x, y]) => y * cols + x));
    const inw = [-Math.cos(h.th), -Math.sin(h.th)]; let best = null;
    for (const side of ['bottom', 'top', 'left', 'right']) {
      const b = boxAt(side, h.x, h.y, W, hh); if (!boxOk(b)) continue;
      let sc = ((b.x0 + b.w / 2 - h.x) * inw[0] + (b.y0 + b.h / 2 - h.y) * 2 * inw[1]) / W;
      for (let y = b.y0; y < b.y0 + b.h; y++) for (let x = b.x0; x < b.x0 + b.w; x++) if (trunk.has(y * cols + x)) sc -= 100;
      if (!best || sc > best.sc) best = { b, sc };
    }
    return best && best.b;
  };

  // hubs: stable order, wedge width proportional to sqrt(agent count)
  const wts = groups.map((g) => Math.sqrt(g.agents.length)); const sw = wts.reduce((a, b) => a + b, 0);
  let acc = -TAU * wts[0] / sw / 2; // first project faces right, the rest follow clockwise
  const hubs = groups.map((g, i) => { const Wd = TAU * wts[i] / sw; const th = acc + Wd / 2; acc += Wd; return { g, Wd, th, lines: orbsOnly ? [] : hubLines(g, labels, W), box: null }; });
  if (groups.length === 1) { // side with the most free room (default right)
    const rooms = [[cols - 1 - cxC, 0], [cxC, Math.PI], [(bottom - cyC) * 2, Math.PI / 2], [(cyC - top) * 2, -Math.PI / 2]];
    let best = rooms[0]; for (const r of rooms) if (r[0] > best[0] + 3) best = r;
    hubs[0].th = best[1];
  }
  const ex = Math.min(cxC, cols - 1 - cxC) - 1, ey = Math.min(cyC - top, bottom - cyC); // hub reach from the centred frame (independent of where the heart sits)
  const idealPos = (h, k, n) => {
    const par = h.par; const phi = h.th + (k - (n - 1) / 2) * par.step;
    return { phi, x: h.x + Math.round(par.arx * Math.cos(phi)), y: h.y + Math.round(par.ary * Math.sin(phi)) };
  };
  const clampIn = (x, y) => [Math.min(cols - 1, Math.max(0, x)), Math.min(bottom, Math.max(top, y))];
  const dist2 = (x, y, h) => (x - h.x) ** 2 + ((y - h.y) * 2) ** 2;
  const finalize = (place) => {
    const orbs = [], labs = [], hubsOut = [];
    hubs.forEach((h) => {
      hubsOut.push({ id: h.g.id, x: h.x, y: h.y, status: hubStatus(h.g), name: h.g.name, count: h.g.agents.length, running: nRun(h.g), agents: h.g.agents.map((a) => a.id) });
      if (h.box) labs.push({ id: 'hub:' + h.g.id, ...h.box, side: 'top', lines: h.lines, hub: true });
      for (const a of h.g.agents) {
        const p = place.get(a.id); if (!p) continue;
        orbs.push({ id: a.id, x: p.x, y: p.y, status: a.status, hub: h.g.id });
        if (p.box) labs.push({ id: a.id, ...p.box, side: p.side, lines: p.lines });
      }
    });
    return { graph: true, cx, cy, cinfo, cbox: { ...cbox }, orbs, labels: labs, hubs: hubsOut, mode: 'ring', labelMode: orbsOnly ? null : labels, snap: { cx, cy, hubs: hubs.map((h) => ({ id: h.g.id, x: h.x, y: h.y, th: h.th, par: h.par, box: h.box })), place } };
  };
  const nearestOwn = (place) => {
    if (hubs.length < 2 || orbsOnly) return true;
    for (const h of hubs) for (const a of h.g.agents) {
      const p = place.get(a.id); if (!p) continue;
      for (const o of hubs) if (o !== h && (dist2(p.x, p.y, o) <= dist2(p.x, p.y, h) || (p.x - o.x) ** 2 + (p.y - o.y) ** 2 <= (p.x - h.x) ** 2 + (p.y - h.y) ** 2)) return false;
    }
    return true;
  };

  const attempt = (f, kx, s, sm, S = null) => {
    reset();
    for (const h of hubs) {
      h.x = cx + Math.round(f * ex * Math.cos(h.th)); h.y = cy + Math.round(f * ey * Math.sin(h.th)); h.box = null;
      if (!orbFree(h.x, h.y)) { const c2 = findOrb(Math.min(cols - 1, Math.max(0, h.x)), Math.min(bottom, Math.max(top, h.y)), 3); if (!c2) return null; [h.x, h.y] = c2; }
      occ[h.y * cols + h.x] = 1;
    }
    if (!orbsOnly) for (const h of hubs) { const b = placeHubLabel(h); if (!b) return null; mark(b, 2); h.box = b; }
    const place = new Map();
    for (const h of hubs) {
      const n = h.g.agents.length; const spanMax = groups.length === 1 ? Math.PI * 4 / 3 : Math.min(Math.PI * 4 / 3, Math.max(1.2, h.Wd * sm));
      const span = Math.min(spanMax, 0.62 * (n - 1)); const step = n > 1 ? span / (n - 1) : 0;
      const ary = s * Math.max(5, 3.4 / Math.max(step, 0.12));
      h.par = S ? { arx: kx * ary * S.sx, ary: ary * S.sy, step } : { arx: kx * ary, ary, step };
      for (let k = 0; k < n; k++) {
        const a = h.g.agents[k]; const id = idealPos(h, k, n);
        let [x, y] = clampIn(id.x, id.y);
        const cell = findOrb(x, y, 3); if (!cell) { if (orbsOnly) continue; return null; }
        occ[cell[1] * cols + cell[0]] = 1;
        const rec = { x: cell[0], y: cell[1], hub: h.g.id, box: null, side: null, lines: null, level: 0 };
        if (!orbsOnly) {
          const L = labelFor(cell[0], cell[1], id.phi, a); if (!L) return null;
          mark(L.box, 2); Object.assign(rec, { box: L.box, side: L.side, lines: L.lines, level: L.level });
        }
        place.set(a.id, rec);
      }
    }
    return nearestOwn(place) ? finalize(place) : null;
  };

  // incremental: keep every existing cell, put new agents on the nearest free cells
  const incremental = (prev) => {
    if (prev.cx !== undefined) setHeart(prev.cx, prev.cy);
    reset();
    const place = new Map();
    for (let i = 0; i < hubs.length; i++) {
      const ph = prev.hubs[i]; const h = hubs[i];
      if (!ph || ph.id !== h.g.id) return null;
      h.x = ph.x; h.y = ph.y; h.th = ph.th; h.par = ph.par; h.box = ph.box;
      occ[h.y * cols + h.x] = 1; if (h.box) mark(h.box, 2);
    }
    const pending = [];
    for (const h of hubs) h.g.agents.forEach((a, k) => {
      const p = prev.place.get(a.id);
      if (p && p.hub === h.g.id && (orbsOnly || (p.box && labelSegs(a, p.level).length <= p.box.h)) && orbFree(p.x, p.y)) {
        occ[p.y * cols + p.x] = 1; if (p.box) mark(p.box, 2);
        place.set(a.id, { ...p, lines: orbsOnly ? null : labelSegs(a, p.level) });
      } else pending.push([h, a, k]);
    });
    for (const [h, a, k] of pending) {
      const n = h.g.agents.length; const id = idealPos(h, k, n); let [x, y] = clampIn(id.x, id.y);
      let done = null;
      outer: for (let r = 0; r <= 8 && !done; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !orbFree(x + dx, y + dy)) continue;
        const ox = x + dx, oy = y + dy;
        if (orbsOnly) { done = { x: ox, y: oy, hub: h.g.id, box: null, side: null, lines: null, level: 0 }; break outer; }
        occ[oy * cols + ox] = 1;
        const L = labelFor(ox, oy, Math.atan2((oy - h.y) * 2, ox - h.x), a);
        if (L) { mark(L.box, 2); done = { x: ox, y: oy, hub: h.g.id, box: L.box, side: L.side, lines: L.lines, level: L.level }; break outer; }
        occ[oy * cols + ox] = 0;
      }
      if (!done) { if (orbsOnly) continue; return null; }
      place.set(a.id, done);
    }
    return nearestOwn(place) ? finalize(place) : null;
  };

  // Scale-up: the compact layout is the 1x floor; bigger terminals spread distances (never label sizes) towards ~85-92% of the usable area.
  const bboxOf = (R) => {
    let x0 = R.cx, x1 = R.cx, y0 = R.cy, y1 = R.cy;
    const add = (a, b, c, d) => { x0 = Math.min(x0, a); x1 = Math.max(x1, b); y0 = Math.min(y0, c); y1 = Math.max(y1, d); };
    // footprints, not live text widths: the scale must not depend on status
    add(R.cx - 11, R.cx + 10, R.cbox.y0, R.cbox.y0 + R.cbox.h - 1);
    for (const o of R.orbs) add(o.x, o.x, o.y, o.y);
    for (const h of R.hubs) add(h.x, h.x, h.y, h.y);
    for (const l of R.labels) add(l.x0, l.x0 + l.w - 1, l.y0, l.y0 + l.h - 1);
    return { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };
  const scaleUp = (base, bp) => {
    const capx = Math.min(3, Math.max(1, cols / 100)), capy = Math.min(3, Math.max(1, (bottom - top + 1) / 30));
    const H = bottom - top + 1; const single = groups.length === 1; const th0 = hubs[0].th;
    const startHeart = () => {
      if (!single) return setHeart(cxC, cyC);
      const c = Math.cos(th0), sn = Math.sin(th0);
      setHeart(c > 0.5 ? 1 + Math.floor(cw / 2) : c < -0.5 ? cols - 2 - Math.floor(cw / 2) : cxC, sn > 0.5 ? top + 1 : sn < -0.5 ? bottom - 4 : cyC);
    };
    const fill = (R) => { const b = bboxOf(R); return b.w <= 0.92 * cols && b.h <= 0.92 * H ? Math.min(b.w / cols, b.h / H) : -1; };
    let best = base, bf = fill(base), bpar = null;
    const lst = (cap, lo) => [...lo, 1, 1.5, 2, 2.5, 3, 3.6, 4.4].filter((v) => v <= Math.max(1, Math.min(4.4, cap * 1.4)) + 1e-9);
    const tryP = (sx, sy, f) => {
      startHeart();
      const R = attempt(f, bp[1], bp[2], bp[3], { sx, sy }); if (!R) return;
      const v = fill(R); if (v > bf + 1e-9) { best = R; bf = v; bpar = [f, { sx, sy }]; }
    };
    for (const lo of [[], [0.55, 0.7, 0.85]]) { // sub-1x only when the compact layout itself already overfills
      if (bpar) break;
      for (const sx of lst(capx, lo)) for (const sy of lst(capy, lo)) for (const f of [0.9, 0.78, 0.66, 0.55, 0.45, 0.36, bp[0]]) tryP(sx, sy, f);
    }
    // local refinement around the best coarse point
    for (const d of bpar ? [0.4, 0.2, 0.1] : []) for (let round = 0; round < 2; round++) {
      const [f0, { sx: x0, sy: y0 }] = bpar;
      for (const dx of [-d, 0, d]) for (const dy of [-d, 0, d]) for (const df of [-d / 4, 0, d / 4]) if (dx || dy || df) tryP(Math.max(0.5, x0 + dx), Math.max(0.5, y0 + dy), Math.min(0.95, Math.max(0.2, f0 + df)));
    }
    if (!bpar) { setHeart(cxC, cyC); return attempt(bp[0], bp[1], bp[2], bp[3]) || base; }
    startHeart(); const R0 = attempt(bpar[0], bp[1], bp[2], bp[3], bpar[1]);
    if (single && R0) { // centre the whole composition
      const b = bboxOf(R0);
      const dx = Math.round((cols - 1) / 2 - (b.x0 + b.x1) / 2), dy = Math.round((top + bottom) / 2 - (b.y0 + b.y1) / 2);
      setHeart(cx + dx, cy + dy); const R1 = attempt(bpar[0], bp[1], bp[2], bp[3], bpar[1]);
      if (R1) return R1;
      startHeart(); return attempt(bpar[0], bp[1], bp[2], bp[3], bpar[1]);
    }
    return R0 || best;
  };

  const prev = cache && cache.layouts.get(sig);
  let L = prev ? incremental(prev) : null;
  if (!L) {
    setHeart(cxC, cyC);
    const F = orbsOnly ? [0.38] : [0.38, 0.3, 0.46, 0.53], KX = orbsOnly ? [2] : [2, 3, 4], S = orbsOnly ? [1] : [1, 1.25, 1.5, 1.8, 2.2, 0.8], SM = orbsOnly ? [1.5] : [1.5, 2.2];
    let bp = null;
    search: for (const sm of SM) for (const f of F) for (const s of S) for (const kx of KX) { L = attempt(f, kx, s, sm); if (L) { bp = [f, kx, s, sm]; break search; } }
    if (L && !orbsOnly && (cols > 100 || rows > 30)) L = scaleUp(L, bp);
  }
  if (cache) { if (L) { cache.layouts.set(sig, L.snap); cache.fails.delete(sig); } else cache.fails.set(sig, total); }
  return L;
}

// ---------------------------------------------------------------- views
function headerLines(state, cols, opts) {
  const agents = state.agents || []; const running = agents.filter((a) => a.status === 'running').length;
  const { nw, cr } = costTotals(state);
  const coll = (state.collisions || []).length, al = (state.alerts || []).length;
  const segs = [[' AOS ', 'brasshi', true], ['LIVE', 'brass', true], ['   ', null],
    [agents.length + ' agents · ' + running + ' running', 'bone'], ['   ', null],
    ['new tokens ', 'muted'], [fmtN(nw), 'bone'], ...(cols >= 100 ? [['  cache reads ', 'dim'], [fmtN(cr), 'dim']] : []), ['   ', null],
    ['conflicts ', 'muted'], [String(coll), coll ? 'brasshi' : 'bone'], ['  alerts ', 'muted'], [String(al), al ? 'brasshi' : 'bone']];
  if (opts.paused) segs.push(['   PAUSED', 'brasshi', true]);
  const g = (state.goal && state.goal.title) || '';
  const last = al ? (state.alerts[al - 1].text || state.alerts[al - 1].kind || '') : '';
  const ml = machinesLine(state);
  const line2 = [[' ' + clip(g, Math.max(10, Math.floor(cols * (ml ? 0.25 : 0.45)))), 'dim']];
  if (ml) line2.push(['  ' + clip(ml, Math.max(10, cols - Math.floor(cols * 0.25) - 4)), al ? 'muted' : 'text2']);
  if (last && !ml) line2.push(['   ! ' + last, 'text2']);
  return [segs, line2];
}
// view: 'auto' | 'list' (forced) | 'ring' (forced). Ring is forced only by the user, never by agent count.
function footer(g, cols, rows, opts, tag) {
  const full = ' q quit · space pause · l view · ? help', short = ' q quit · l view · ? help';
  const keys = len(full) + 5 + len(tag) <= cols ? full : short;
  g.put(0, rows - 1, clip(keys, cols), 'dim');
  const tx = len(keys) + 5;
  if (tx + len(tag) <= cols) { g.put(len(keys), rows - 1, '  ·  ', 'dim'); g.put(tx, rows - 1, tag, 'muted'); }
  const right = opts.footerRight ? opts.footerRight + ' ' : '';
  if (right && tx + len(tag) + len(right) + 2 <= cols) g.put(cols - len(right), rows - 1, right, 'dim');
}
function viewTag(view, mode, labelMode) {
  if (view === 'auto') return `view: ${mode} (auto)`;
  if (view === 'list') return 'view: list (forced)';
  if (labelMode === 'compact') return 'view: ring (forced, labels compact)';
  if (labelMode === null) return 'view: ring (forced, labels hidden)';
  return 'view: ring (forced)';
}
// Auto: ring only if the full labels fit without overlap. Forced ring: full labels, then compact, then orbs only.
function chooseRing(ring, mains, cols, rows, view) {
  if (view === 'auto') {
    if (cols < 80 || rows < 24) return null;
    return tryLayout(ring, mains, cols, rows, { gap: 1 }) || tryLayout(ring, mains, cols, rows, { gap: 0 });
  }
  for (const labels of ['full', 'compact']) {
    const L = tryLayout(ring, mains, cols, rows, { gap: 1, labels }) || tryLayout(ring, mains, cols, rows, { gap: 0, labels });
    if (L) return L;
  }
  return tryLayout(ring, mains, cols, rows, { gap: 1, labels: null });
}

function chooseGraph(groups, nMains, cols, rows, view, cache) {
  if (view === 'auto') {
    if (cols < 80 || rows < 24) return null;
    return layoutGraph(groups, nMains, cols, rows, { gap: 1 }, cache) || layoutGraph(groups, nMains, cols, rows, { gap: 0 }, cache);
  }
  for (const labels of ['full', 'compact']) {
    const L = layoutGraph(groups, nMains, cols, rows, { gap: 1, labels }, cache) || layoutGraph(groups, nMains, cols, rows, { gap: 0, labels }, cache);
    if (L) return L;
  }
  return layoutGraph(groups, nMains, cols, rows, { gap: 1, labels: null }, cache);
}

function drawGrid(state, cols, rows, opts) {
  const view = opts.view || 'auto';
  const agents = state.agents || [];
  const mains = agents.filter(isMain), ring = agents.filter((a) => !isMain(a));
  const frame = opts.frame || 0;
  const g = new Grid(cols, rows);
  const [h1, h2] = headerLines(state, cols, opts);
  g.segs(0, 0, h1); g.segs(0, 1, h2);
  const model = { mode: 'list', labelMode: null, notice: null, orbs: [], labels: [], hubs: [], particles: [], reserved: new Set(), cols, rows };
  const groups = projectGroups(state);
  const L = view === 'list' ? null : groups ? chooseGraph(groups, mains.length, cols, rows, view, opts.cache || null) : chooseRing(ring, mains, cols, rows, view);
  if (!L) { drawList(g, agents, cols, rows, groups); footer(g, cols, rows, opts, viewTag(view, 'list')); return finish(g, model, opts); }
  model.mode = 'ring'; model.labelMode = L.labelMode; model.orbs = L.orbs; model.labels = L.labels; model.centre = { x: L.cx, y: L.cy }; model.centreLabel = L.cbox;
  model.hubs = L.hubs || [];
  if (L.labelMode === null) {
    model.notice = `ring: ${L.graph ? agents.length : ring.length} agents too many for this size, labels hidden: press l for list`;
    g.put(1, rows - 2, clip(model.notice, cols - 1), 'dim');
  }
  const R = model.reserved; const rk = (x, y) => y * cols + x;
  R.add(rk(L.cx, L.cy));
  for (let y = 0; y < L.cbox.h; y++) for (let x = 0; x < L.cbox.w; x++) R.add(rk(L.cbox.x0 + x, L.cbox.y0 + y));
  for (const o of L.orbs) R.add(rk(o.x, o.y));
  for (const h of model.hubs) R.add(rk(h.x, h.y));
  for (const l of L.labels) for (let y = 0; y < l.h; y++) for (let x = 0; x < l.w; x++) R.add(rk(l.x0 + x, l.y0 + y));
  // streams first, so labels/orbs are drawn on top: heart -> hub trunks, hub -> agent branches (or heart -> agent in the flat ring)
  const edges = L.graph
    ? [...model.hubs.map((h) => ({ a: [L.cx, L.cy], b: [h.x, h.y], status: h.status, id: 'hub:' + h.id })),
      ...L.orbs.map((o) => { const h = model.hubs.find((q) => q.id === o.hub); return { a: [h.x, h.y], b: [o.x, o.y], status: o.status, id: o.id }; })]
    : L.orbs.map((o) => ({ a: [L.cx, L.cy], b: [o.x, o.y], status: o.status, id: o.id }));
  for (const e of edges) {
    const flow = FLOW[e.status] === undefined ? FLOW.idle : FLOW[e.status];
    if (!flow) continue;
    const [sp, per] = flow; const path = bresenham(e.a[0], e.a[1], e.b[0], e.b[1]);
    const off = Math.floor(frame / per);
    for (let i = 2; i < path.length - 1; i++) {
      const k = ((i - off) % sp + sp) % sp; if (k !== 0) continue;
      const [x, y] = path[i]; if (R.has(rk(x, y))) continue;
      const seq = Math.floor((i - off) / sp);
      const q4 = ((seq % 4) + 4) % 4;
      const glyph = e.status === 'running' ? ['•', '∙', '·', '∙'][q4] : (q4 % 2 ? '·' : '⋅');
      const role = e.status === 'running' ? (((seq % 2) + 2) % 2 ? 'brass' : 'brassdim') : 'dim';
      g.put(x, y, glyph, role); model.particles.push({ x, y, id: e.id });
    }
  }
  for (const h of model.hubs) g.put(h.x, h.y, '◎', STATUS_ROLE[h.status] || 'idle', true);
  for (const l of L.labels) l.lines.forEach((segs, i) => {
    const w = segW(segs); const x = l.side === 'left' ? l.x0 + l.w - w : l.side === 'right' ? l.x0 : l.x0 + Math.floor((l.w - w) / 2);
    g.segs(x, l.y0 + i, segs);
  });
  for (const o of L.orbs) g.put(o.x, o.y, STATUS_GLYPH[o.status] || '○', STATUS_ROLE[o.status] || 'idle', o.status === 'running');
  g.put(L.cx, L.cy, '◉', STATUS_ROLE[L.cinfo.status], true);
  L.cinfo.lines.forEach((segs, i) => g.segs(L.cbox.x0 + Math.floor((L.cbox.w - segW(segs)) / 2), L.cbox.y0 + i, segs));
  footer(g, cols, rows, opts, viewTag(view, 'ring', L.labelMode));
  return finish(g, model, opts);
}

function drawList(g, agents, cols, rows, groups = null) {
  const top = 2, avail = rows - 1 - top - 1; // minus column header, footer
  const showTool = cols >= 76, showModel = cols >= 56, showRan = cols >= 56, showTok = cols >= 40, showTpm = cols >= 120;
  const wTok = showTok ? 8 : 0, wSt = 9, wMod = showModel ? 14 : 0, wTool = showTool ? 20 : 0, wRan = showRan ? 8 : 0, wTpm = showTpm ? 9 : 0;
  const ind = groups ? 2 : 0;
  const wName = Math.max(8, cols - 3 - wSt - wMod - wTool - wRan - wTok - wTpm - 1);
  const cell = (s, w) => clip(s, w).padEnd(w);
  const rj = (s, w) => clip(s, w - 1).padStart(w - 1).padEnd(w); // right-aligned numeric cell, one gap column
  const hdr = '   ' + cell('AGENT', wName) + cell('STATUS', wSt) + (showModel ? cell('MODEL', wMod) : '') + (showTool ? cell('TOOL', wTool) : '') +
    (showRan ? rj('RAN', wRan) : '') + (showTok ? rj('NEW TOK', wTok) : '') + (showTpm ? rj('TOK/MIN', wTpm) : '');
  g.put(0, top, hdr, 'dim');
  // rows: project header rows (grouped) followed by their agents sorted by start time
  const rowsList = [];
  if (groups) for (const gr of groups) {
    const sorted = gr.agents.map((a, i) => [a, i]).sort((p, q) => { const x = p[0].started_at, y = q[0].started_at; return x && y && x !== y ? (x < y ? -1 : 1) : p[1] - q[1]; }).map((p) => p[0]);
    const ranT = gr.p && typeof gr.p.ran_s_total === 'number' ? ' · ran ' + fmtDur(gr.p.ran_s_total) : '';
    rowsList.push({ head: '▸ ' + gr.name + ' · ' + plural(gr.agents.length, 'agent') + ' · ' + nRun(gr) + ' running' + ranT });
    for (const a of sorted) rowsList.push({ a });
  } else for (const a of agents) rowsList.push({ a });
  const nAgents = (list) => list.filter((r) => r.a).length;
  const shown = rowsList.length > avail ? Math.max(0, avail - 1) : rowsList.length;
  for (let i = 0; i < Math.min(shown, Math.max(avail, 0)); i++) {
    const y = top + 1 + i; const r = rowsList[i];
    if (r.head) { g.put(1, y, clip(r.head, cols - 2), 'brasshi', true); continue; }
    const a = r.a; const sp = splitId(a.id); const st = String(a.status || 'idle');
    g.put(1 + ind, y, STATUS_GLYPH[st] || '○', STATUS_ROLE[st] || 'idle', st === 'running');
    let x = 3 + ind;
    g.put(x, y, cell(sp.name + (sp.short ? ' ' + sp.short : ''), wName - ind), 'bone'); x += wName - ind;
    g.put(x, y, cell(st.toUpperCase(), wSt), STATUS_ROLE[st] || 'idle'); x += wSt;
    if (showModel) { g.put(x, y, cell((a.model_mismatch ? '!' + a.requested_tier + ' ' : '') + (a.model_label || ''), wMod), a.model_mismatch ? 'stalled' : 'muted'); x += wMod; }
    if (showTool) { const t = a.current_tool; g.put(x, y, cell(t ? t.name + (t.summary ? ' ' + t.summary : '') : '', wTool), 'text2'); x += wTool; }
    if (showRan) { g.put(x, y, rj(fmtDur(a.ran_s), wRan), 'bone'); x += wRan; }
    if (showTok) { g.put(x, y, rj(fmtN(newTok(a.usage)), wTok), 'bone'); x += wTok; }
    if (showTpm) g.put(x, y, rj(typeof a.tok_per_min === 'number' ? fmtN(a.tok_per_min) : '-', wTpm), 'bone');
  }
  if (shown < rowsList.length) g.put(3, top + avail, '… +' + (nAgents(rowsList) - nAgents(rowsList.slice(0, shown))) + ' more (enlarge the terminal)', 'dim');
}

function drawHelp(g, cols, rows) {
  const t = ['AOS terminal dashboard', '', 'q / ctrl-c  quit', 'space       pause / resume', 'l           view: auto -> list -> ring -> auto', '?           close this help', '',
    'ring: heart = all sessions, project hubs, agents on arcs', 'view auto = ring when all labels fit, else list', 'running = brass, idle = slate, stalled = ochre, errored = brick', 'new tokens = input + output + cache write'];
  const w = Math.min(cols - 2, Math.max(...t.map(len)) + 4), h = t.length + 2;
  if (w < 20 || h > rows) return;
  const x0 = Math.floor((cols - w) / 2), y0 = Math.floor((rows - h) / 2);
  for (let y = 0; y < h; y++) g.put(x0, y0 + y, ' '.repeat(w), null);
  g.put(x0, y0, '┌' + '─'.repeat(w - 2) + '┐', 'dim'); g.put(x0, y0 + h - 1, '└' + '─'.repeat(w - 2) + '┘', 'dim');
  for (let y = 1; y < h - 1; y++) { g.put(x0, y0 + y, '│', 'dim'); g.put(x0 + w - 1, y0 + y, '│', 'dim'); g.put(x0 + 2, y0 + y, clip(t[y - 1], w - 4), y === 1 ? 'brasshi' : 'text2'); }
}

function finish(g, model, opts) {
  if (opts.help) drawHelp(g, g.cols, g.rows);
  const mode = opts.color || 'none';
  model.plain = g.text();
  model.lines = mode === 'none' ? model.plain : g.ansi(mode);
  model.text = model.lines.join('\n');
  return model;
}

function drawDown(cols, rows, opts) {
  const g = new Grid(cols, rows);
  g.put(1, 0, ' AOS ', 'brasshi', true); g.put(6, 0, 'LIVE', 'dim', true);
  const msg = ['monitor not reachable', (opts.target || '127.0.0.1') + ' · retrying every second'];
  const y = Math.max(1, Math.floor(rows / 2) - 1);
  msg.forEach((m, i) => g.put(Math.max(0, Math.floor((cols - len(m)) / 2)), y + i, clip(m, cols), i ? 'dim' : 'text2'));
  if (rows > 2) g.put(0, rows - 1, clip(' q quit', cols), 'dim');
  const model = { mode: 'down', orbs: [], labels: [], particles: [], reserved: new Set(), cols, rows };
  return finish(g, model, opts);
}

function drawWaiting(cols, rows, opts) {
  const g = new Grid(cols, rows);
  g.put(1, 0, ' AOS ', 'brasshi', true); g.put(6, 0, 'LIVE', 'dim', true);
  const msg = ['Waiting for your first Claude Code session', 'start one in any project and it appears here'];
  const y = Math.max(1, Math.floor(rows / 2) - 1);
  msg.forEach((m, i) => g.put(Math.max(0, Math.floor((cols - len(m)) / 2)), y + i, clip(m, cols), i ? 'dim' : 'text2'));
  if (rows > 2) g.put(0, rows - 1, clip(' q quit', cols), 'dim');
  const model = { mode: 'waiting', orbs: [], labels: [], particles: [], reserved: new Set(), cols, rows };
  return finish(g, model, opts);
}

// If the install dir (default ~/.local/bin) is not on PATH, the exact line to add; else ''.
export function pathHint(env = process.env, home = os.homedir()) {
  const bin = path.join(home, '.local', 'bin');
  if ((env.PATH || '').split(path.delimiter).includes(bin)) return '';
  return `${bin} is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc):\n  export PATH="$HOME/.local/bin:$PATH"`;
}

export function renderModel(state, cols, rows, opts = {}) {
  cols = Math.max(20, cols | 0); rows = Math.max(5, rows | 0);
  const view = opts.view || (opts.list ? 'list' : 'auto');
  if (state && Array.isArray(state.machines)) remoteNames = state.machines.map((m) => m.name).filter((n) => n !== 'local');
  if (state && opts.machine) state = filterMachine(state, opts.machine);
  if (!state || !Array.isArray(state.agents)) return drawDown(cols, rows, opts);
  if (!state.agents.length) return drawWaiting(cols, rows, opts);
  return drawGrid(state, cols, rows, { ...opts, view });
}

// Pure key handler. The view cycles auto -> list (forced) -> ring (forced) -> auto.
export const VIEWS = ['auto', 'list', 'ring'];
export function initialUi(o = {}) { return { view: o.list ? 'list' : 'auto', paused: false, help: false }; }
export function handleKey(ui, key) {
  const k = String(key);
  if (k === 'q' || k === 'Q' || k === '\x03') return { ui, quit: true, handled: true };
  if (k === ' ') return { ui: { ...ui, paused: !ui.paused }, quit: false, handled: true };
  if (k === 'l' || k === 'L') return { ui: { ...ui, view: VIEWS[(VIEWS.indexOf(ui.view) + 1) % VIEWS.length] }, quit: false, handled: true };
  if (k === '?') return { ui: { ...ui, help: !ui.help }, quit: false, handled: true };
  if (k === '\x1b' && ui.help) return { ui: { ...ui, help: false }, quit: false, handled: true };
  return { ui, quit: false, handled: false };
}
export function render(state, cols, rows, opts = {}) { return renderModel(state, cols, rows, opts).text; }

// ---------------------------------------------------------------- terminal
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[2J';
const LEAVE = '\x1b[0m\x1b[?25h\x1b[?1049l';
let restored = false;
export function cleanup(stream = process.stdout, stdin = process.stdin) {
  if (restored) return false; restored = true;
  try { if (stdin && stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false); } catch {}
  try { stream.write(LEAVE); } catch {}
  return true;
}
export function _resetCleanup() { restored = false; }

async function fetchState(port) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 2000);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function parseArgs(argv) {
  const o = { once: false, list: false, port: Number(process.env.AOS_PORT) || 4318, size: null, help: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = true; else if (a === '--list') o.list = true; else if (a === '--json') o.json = true;
    else if (a === '--port') o.port = Number(argv[++i]); else if (a.startsWith('--port=')) o.port = Number(a.slice(7));
    else if (a === '--machine') o.machine = argv[++i]; else if (a.startsWith('--machine=')) o.machine = a.slice(10);
    else if (a === '--size') o.size = argv[++i]; else if (a === '--help' || a === '-h') o.help = true;
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) { console.error('invalid --port'); process.exit(2); }
  if (o.machine !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(o.machine || '')) { console.error('invalid --machine'); process.exit(2); }
  return o;
}

async function main() {
  const argv = process.argv.slice(2); const o = parseArgs(argv);
  if (o.help) { console.log('usage: aos-dash [--once] [--list] [--json] [--port N] [--machine NAME] [--no-color] [--size WxH]\n--json prints {agents:[{id,role,status,model_label}],tasks?,totals:{agents,tokens_total}} for all machines and exits; prints {"error":"monitor unreachable"} and exits 1 if the monitor is unreachable\n--machine NAME shows one machine of a cross-machine setup (see docs/cross-machine.md)\nreads the monitor at 127.0.0.1:4318 (change with --port N or AOS_PORT); shows "Waiting for your first Claude Code session" until one has run\nkeys: q quit, space pause, l view (auto -> list -> ring), ? help' + (pathHint() ? '\n\n' + pathHint() : '')); return; }
  const out = process.stdout; const color = detectColor(process.env, out, argv);
  const target = `127.0.0.1:${o.port}`;
  if (o.json) {
    let st;
    try { st = await fetchState(o.port); } catch { process.stdout.write(JSON.stringify({ error: 'monitor unreachable' }) + '\n'); process.exitCode = 1; return; }
    process.stdout.write(JSON.stringify(snapshotJson(st)) + '\n');
    return;
  }
  if (o.once || !out.isTTY) {
    let cols = out.columns || Number(process.env.COLUMNS) || 140, rows = out.rows || Number(process.env.LINES) || 40;
    const m = o.size && /^(\d+)x(\d+)$/.exec(o.size); if (m) { cols = +m[1]; rows = +m[2]; }
    let st = null; try { st = await fetchState(o.port); } catch {}
    process.stdout.write(renderModel(st, cols, rows, { color, list: o.list, target, machine: o.machine }).text + '\n');
    return;
  }
  let state = null, ui = initialUi(o), frame = 0, last = '', lastOk = 0;
  const cache = { layouts: new Map(), fails: new Map() }; // keeps graph cells stable across refreshes
  const draw = (force) => {
    const cols = out.columns || 80, rows = out.rows || 24;
    const age = lastOk ? Math.round((Date.now() - lastOk) / 1000) : 0;
    const m = renderModel(state, cols, rows, { color, machine: o.machine, cache, view: ui.view, help: ui.help, paused: ui.paused, frame, target, footerRight: state ? target + (age > 2 ? ` · ${age}s old` : '') : '' });
    if (!force && m.text === last) return; last = m.text;
    out.write('\x1b[H' + m.lines.map((l) => l + '\x1b[K').join('\r\n'));
  };
  const quit = (code = 0) => { cleanup(out, process.stdin); process.exit(code); };
  out.write(ENTER);
  process.on('exit', () => cleanup(out, process.stdin));
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => quit(0));
  process.on('uncaughtException', (e) => { cleanup(out, process.stdin); console.error(e && e.stack || e); process.exit(1); });
  process.on('unhandledRejection', (e) => { cleanup(out, process.stdin); console.error(e && e.stack || e); process.exit(1); });
  out.on('resize', () => { last = ''; out.write('\x1b[2J'); draw(true); });
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    process.stdin.on('data', (k) => {
      const r = handleKey(ui, k);
      if (r.quit) return quit(0);
      if (!r.handled) return;
      ui = r.ui; last = ''; draw(true);
    });
  }
  const poll = async () => {
    try { state = await fetchState(o.port); lastOk = Date.now(); } catch { state = null; }
    setTimeout(poll, 1000);
  };
  poll();
  setInterval(() => { if (!ui.paused) frame++; draw(false); }, 125);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
