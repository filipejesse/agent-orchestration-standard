// Optional exact cost: Claude Code's OpenTelemetry metrics (OTLP over http/json), posted by Claude Code to this monitor.
// Opt-in on the Claude Code side (see docs/otel.md):
//   CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_METRICS_EXPORTER=otlp OTEL_EXPORTER_OTLP_PROTOCOL=http/json OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
// Only claude_code.cost.usage and claude_code.token.usage are kept, per session.id, split by query_source (main | subagent | auxiliary)
// and agent.name (subagent type). Everything else in the payload is ignored. Bounded: body size, series count, label lengths.

export const BODY_MAX = 1024 * 1024;
const SERIES_MAX = 20000;
const COST = 'claude_code.cost.usage', TOKENS = 'claude_code.token.usage';
const SOURCES = new Set(['main', 'subagent', 'auxiliary']);
const TOKEN_TYPES = new Set(['input', 'output', 'cacheRead', 'cacheCreation']);
const LABEL_RE = /^[A-Za-z0-9 ._:@/-]{1,64}$/;
const DELTA = 1, CUMULATIVE = 2; // OTLP AggregationTemporality

const label = (v) => (typeof v === 'string' && LABEL_RE.test(v) ? v : null);
function attrsOf(list) {
  const o = Object.create(null);
  if (!Array.isArray(list)) return o;
  for (const a of list.slice(0, 64)) {
    if (!a || typeof a.key !== 'string' || !a.value || typeof a.value !== 'object') continue;
    const v = a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue;
    if (v !== undefined && v !== null) o[a.key] = String(v).slice(0, 200);
  }
  return o;
}
function pointValue(p) {
  const v = p.asDouble !== undefined ? Number(p.asDouble) : p.asInt !== undefined ? Number(p.asInt) : NaN; // int64 arrives as a string in OTLP/JSON
  return Number.isFinite(v) && v >= 0 && v < 1e12 ? v : null;
}

export function createOtelStore({ now = () => Date.now() } = {}) {
  // series key -> { sid, metric, source, agent, type, value, last }. Delta points add; cumulative points replace (keyed with their start time).
  const series = new Map();
  let lastAt = null, accepted = 0, rejected = 0;

  function ingest(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.resourceMetrics)) { rejected++; return { ok: false, error: 'not an OTLP metrics request' }; }
    let points = 0;
    for (const rm of body.resourceMetrics.slice(0, 100)) {
      const res = attrsOf(rm && rm.resource && rm.resource.attributes);
      for (const sm of (Array.isArray(rm && rm.scopeMetrics) ? rm.scopeMetrics : []).slice(0, 100)) {
        for (const m of (Array.isArray(sm && sm.metrics) ? sm.metrics : []).slice(0, 1000)) {
          if (!m || (m.name !== COST && m.name !== TOKENS) || !m.sum || !Array.isArray(m.sum.dataPoints)) continue;
          const temporality = m.sum.aggregationTemporality === CUMULATIVE ? CUMULATIVE : DELTA;
          for (const p of m.sum.dataPoints.slice(0, 5000)) {
            if (!p || typeof p !== 'object') continue;
            const a = { ...res, ...attrsOf(p.attributes) }, v = pointValue(p), sid = label(a['session.id']);
            if (v === null || !sid) continue;
            const source = SOURCES.has(a.query_source) ? a.query_source : 'other';
            const agent = label(a['agent.name']), model = label(a.model);
            const type = m.name === TOKENS ? (TOKEN_TYPES.has(a.type) ? a.type : null) : null;
            if (m.name === TOKENS && !type) continue;
            const key = [m.name, sid, source, agent || '', model || '', type || '', a.effort || '', a.speed || '', a['skill.name'] || '', a['mcp_server.name'] || '', a['mcp_tool.name'] || '',
              temporality === CUMULATIVE ? 'c' + String(p.startTimeUnixNano || '') : 'd'].join('\u0000');
            let s = series.get(key);
            if (s) series.delete(key); // re-inserted below: Map order = least recently updated first
            else {
              if (series.size >= SERIES_MAX) series.delete(series.keys().next().value); // evict the series idle longest
              s = { sid, metric: m.name, source, agent, type, value: 0, last: 0 };
            }
            series.set(key, s);
            if (temporality === CUMULATIVE) s.value = v; else s.value += v;
            s.last = now(); points++;
          }
        }
      }
    }
    accepted++; if (points) lastAt = now();
    return { ok: true, points };
  }

  // Exact figures for the given sessions (null when no telemetry has arrived for any of them). The hook log keeps the first 8 characters
  // of a session id and OTel sends it whole, so a series matches a wanted sid exactly or by that prefix; by_session is keyed by the wanted sid.
  function summary(sids) {
    const want = sids instanceof Set ? sids : new Set(sids || []);
    const by_source = { main: 0, subagent: 0, auxiliary: 0, other: 0 }, by_agent_type = Object.create(null), by_session = Object.create(null);
    const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    const TK = { input: 'input', output: 'output', cacheRead: 'cache_read', cacheCreation: 'cache_write' };
    const seen = new Set(); let total = 0, last = 0;
    for (const s of series.values()) {
      const sid = want.has(s.sid) ? s.sid : want.has(s.sid.slice(0, 8)) ? s.sid.slice(0, 8) : null;
      if (!sid) continue;
      seen.add(sid); if (s.last > last) last = s.last;
      if (s.metric === COST) {
        total += s.value; by_source[s.source] += s.value; by_session[sid] = (by_session[sid] || 0) + s.value;
        if (s.source === 'subagent') { const k = s.agent || 'unnamed'; by_agent_type[k] = (by_agent_type[k] || 0) + s.value; }
      } else tokens[TK[s.type]] += s.value;
    }
    if (!seen.size) return null;
    const r = (x) => Math.round(x * 1e6) / 1e6;
    for (const k of Object.keys(by_source)) by_source[k] = r(by_source[k]);
    for (const k of Object.keys(by_agent_type)) by_agent_type[k] = r(by_agent_type[k]);
    for (const k of Object.keys(by_session)) by_session[k] = r(by_session[k]);
    return { source: 'otel', total_usd: r(total), by_source, by_agent_type, by_session, tokens, sessions: seen.size, updated_at: new Date(last).toISOString() };
  }

  const stats = () => ({ series: series.size, accepted, rejected, last_export_at: lastAt ? new Date(lastAt).toISOString() : null });
  return { ingest, summary, stats };
}
