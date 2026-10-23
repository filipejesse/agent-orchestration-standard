// /v1/metrics: Claude Code's OpenTelemetry cost/token metrics (OTLP http/json) -> cost.exact in /api/state (live view only).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { sleep, tmpDir, hookEv, startMonitor } from './harness.mjs';
import { createOtelStore } from '../otel.mjs';

const TMP = tmpDir('aos-monotel-'); let M; const now = Date.now(), at = (m) => new Date(now + m * 60e3).toISOString();
const FULL = '1fcd66f8-2f99-4870-b803-a5050c3e37df', SID = FULL.slice(0, 8), OTHER = 'aaaabbbb-not-in-view'; // the hook logs the first 8 chars; OTel sends the whole id
function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const S = (k, v) => ({ key: k, value: { stringValue: v } });
// one OTLP/JSON export: session.id on the resource (as the SDK may send it) or on each point
function exportOf(points, { temporality = 1, sid = FULL, onResource = false } = {}) {
  const byMetric = {};
  for (const p of points) (byMetric[p.metric] = byMetric[p.metric] || []).push({
    attributes: [...(onResource ? [] : [S('session.id', p.sid || sid)]), ...Object.entries(p.attrs || {}).map(([k, v]) => S(k, v))],
    startTimeUnixNano: p.start || '1700000000000000000', timeUnixNano: String(BigInt(Date.now()) * 1000000n), ...(Number.isInteger(p.v) && p.metric.endsWith('token.usage') ? { asInt: String(p.v) } : { asDouble: p.v }) });
  return { resourceMetrics: [{ resource: { attributes: [S('service.name', 'claude-code'), ...(onResource ? [S('session.id', sid)] : [])] }, scopeMetrics: [{ scope: { name: 'com.anthropic.claude_code' },
    metrics: Object.entries(byMetric).map(([name, dataPoints]) => ({ name, unit: name.endsWith('cost.usage') ? 'USD' : 'tokens', sum: { aggregationTemporality: temporality, isMonotonic: true, dataPoints } })) }] }] };
}
const COST = 'claude_code.cost.usage', TOK = 'claude_code.token.usage';

before(async () => {
  const live = path.join(TMP, 'live'), orch = path.join(TMP, 'orch'); fs.mkdirSync(live, { recursive: true }); fs.mkdirSync(orch, { recursive: true });
  const w = { cwd: 'proj', cwdp: '/x/proj' };
  fs.writeFileSync(path.join(live, 'hook-events.ndjson'), [hookEv({ ts: at(-5), ev: 'SessionStart', sid: SID, ...w }), hookEv({ ts: at(-4), ev: 'UserPromptSubmit', sid: SID, ...w })].join(''));
  M = await startMonitor({ orch, live }); await sleep(300);
});
after(async () => { await M.stop(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('no telemetry yet: no cost.exact (the estimate path is unchanged)', async () => {
  const st = (await M.get('/api/state')).json;
  assert.equal(st.cost.exact, undefined);
});

test('delta exports add up per session, split by main / subagent / agent type; tokens by type', async () => {
  let r = await post(M.port, '/v1/metrics', exportOf([
    { metric: COST, v: 0.5, attrs: { query_source: 'main', model: 'claude-opus-5-5' } },
    { metric: COST, v: 0.25, attrs: { query_source: 'subagent', 'agent.name': 'Explore', model: 'claude-haiku-5-5' } },
    { metric: COST, v: 1, sid: OTHER, attrs: { query_source: 'main' } },
    { metric: TOK, v: 1000, attrs: { type: 'input', query_source: 'main' } },
    { metric: TOK, v: 200, attrs: { type: 'cacheRead', query_source: 'main' } },
    { metric: 'claude_code.session.count', v: 1 } ]));
  assert.equal(r.status, 200); assert.deepEqual(r.json, {});
  r = await post(M.port, '/v1/metrics', exportOf([{ metric: COST, v: 0.25, attrs: { query_source: 'main', model: 'claude-opus-5-5' } }]));
  assert.equal(r.status, 200);
  const st = (await M.get('/api/state')).json, ex = st.cost.exact;
  assert.ok(ex, 'cost.exact present');
  assert.equal(ex.source, 'otel'); assert.equal(ex.complete, true); assert.equal(ex.live_sessions, 1); assert.equal(ex.total_usd, 1); assert.equal(ex.sessions, 1, 'a session not in view is not counted');
  assert.deepEqual(ex.by_source, { main: 0.75, subagent: 0.25, auxiliary: 0, other: 0 });
  assert.deepEqual(ex.by_agent_type, { Explore: 0.25 });
  assert.deepEqual(ex.tokens, { input: 1000, output: 0, cache_read: 200, cache_write: 0 });
  const a = st.agents.find((x) => x.capabilities && x.capabilities.includes('claude-code'));
  assert.equal(a.usage.usd_exact_session, 1);
  assert.equal(typeof st.cost.tokens_total, 'number', 'the transcript-based figures are still there');
});

test('cumulative exports replace, not add; session.id on the resource works', async () => {
  const sid = FULL; // same session, a separate cumulative series (its own start time)
  const send = (v) => post(M.port, '/v1/metrics', exportOf([{ metric: COST, v, start: '1800000000000000000', attrs: { query_source: 'auxiliary' } }], { temporality: 2, sid, onResource: true }));
  assert.equal((await send(0.1)).status, 200); assert.equal((await send(0.3)).status, 200);
  const ex = (await M.get('/api/state')).json.cost.exact;
  assert.equal(ex.by_source.auxiliary, 0.3); assert.equal(ex.total_usd, 1.3);
});

test('replay (?at=) never shows telemetry: it is not time-sliced', async () => {
  const st = (await M.get('/api/state?at=' + encodeURIComponent(at(-1)))).json;
  assert.equal(st.replay, true); assert.equal(st.cost.exact, undefined);
});

test('rejects: protobuf, bad JSON, not OTLP, too large, GET, foreign Origin; logs/traces say metrics only', async () => {
  assert.equal((await post(M.port, '/v1/metrics', 'x', { 'Content-Type': 'application/x-protobuf' })).status, 415);
  assert.equal((await post(M.port, '/v1/metrics', '{nope')).status, 400);
  assert.equal((await post(M.port, '/v1/metrics', '{}', { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await post(M.port, '/v1/metrics', { hello: 1 })).status, 400);
  assert.equal((await post(M.port, '/v1/metrics', JSON.stringify({ resourceMetrics: [], pad: 'x'.repeat(1024 * 1024 + 10) }))).status, 413);
  assert.equal((await M.get('/v1/metrics')).status, 405);
  assert.equal((await post(M.port, '/v1/metrics', exportOf([{ metric: COST, v: 99, attrs: { query_source: 'main' } }]), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(M.port, '/v1/logs', { resourceLogs: [] })).status, 404);
  assert.equal((await M.get('/api/state')).json.cost.exact.total_usd, 1.3, 'nothing rejected was counted');
});

test('store: bad values and labels are dropped; bounded series', () => {
  const s = createOtelStore();
  s.ingest(exportOf([{ metric: COST, v: -1, attrs: { query_source: 'main' } }, { metric: COST, v: 'NaN', attrs: { query_source: 'main' } },
    { metric: COST, v: 1, sid: 'bad sid\n<script>', attrs: { query_source: 'main' } }, { metric: TOK, v: 5, attrs: { type: 'weird' } },
    { metric: COST, v: 2, attrs: { query_source: 'surprise', 'agent.name': '__proto__' } }]));
  const ex = s.summary([FULL, 'bad sid\n<script>']);
  assert.equal(ex.total_usd, 2); assert.equal(ex.by_source.other, 2); assert.deepEqual(ex.tokens, { input: 0, output: 0, cache_read: 0, cache_write: 0 });
  assert.equal(s.summary(['nobody']), null);
  assert.equal(s.summary([SID]).total_usd, 2, 'an 8-char hook sid matches the full OTel session.id');
  for (let i = 0; i < 25000; i++) s.ingest(exportOf([{ metric: COST, v: 0.001, sid: 's' + i, attrs: { query_source: 'main' } }]));
  assert.ok(s.stats().series <= 20000);
  const lru = createOtelStore(); lru.ingest(exportOf([{ metric: COST, v: 1, sid: 'keepme01-x', attrs: { query_source: 'main' } }]));
  for (let i = 0; i < 19999; i++) lru.ingest(exportOf([{ metric: COST, v: 0.001, sid: 'f' + i, attrs: { query_source: 'main' } }]));
  lru.ingest(exportOf([{ metric: COST, v: 1, sid: 'keepme01-x', attrs: { query_source: 'main' } }])); // still active: moves to the back
  for (let i = 0; i < 100; i++) lru.ingest(exportOf([{ metric: COST, v: 0.001, sid: 'g' + i, attrs: { query_source: 'main' } }]));
  assert.equal(lru.summary(['keepme01-x']).total_usd, 2, 'an active series is not evicted, only the idle ones');
});

test('partial coverage: a second live session without telemetry makes cost.exact incomplete (the headline keeps the estimate)', async () => {
  fs.appendFileSync(path.join(TMP, 'live', 'hook-events.ndjson'), hookEv({ ts: new Date().toISOString(), ev: 'SessionStart', sid: 'nootel01', cwd: 'proj', cwdp: '/x/proj' }));
  await sleep(1100);
  const ex = (await M.get('/api/state')).json.cost.exact;
  assert.equal(ex.live_sessions, 2); assert.equal(ex.sessions, 1); assert.equal(ex.complete, false);
});
