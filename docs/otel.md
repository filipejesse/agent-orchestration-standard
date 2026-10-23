# Exact cost from Claude Code telemetry (optional)

By default the dashboard estimates cost: it reads token counts from session transcripts and multiplies them by `live/prices.json`.
Claude Code can also report its own cost and token counts over OpenTelemetry. If you turn that on and point it at the monitor,
the cost readout shows Claude Code's exact figures, split into the main agent, subagents (by subagent type) and background calls.

## Turn it on

Add this to the `env` block of `~/.claude/settings.json` (or export it in your shell), then start a new Claude Code session:

```json
"env": {
  "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
  "OTEL_METRICS_EXPORTER": "otlp",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
  "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318"
}
```

Use your monitor's port if you changed it from 4318. Only `http/json` is accepted (not gRPC or protobuf). The monitor reads metrics
only, so leave `OTEL_LOGS_EXPORTER` unset or `none`. If you already send telemetry to a collector, set `OTEL_METRICS_EXPORTER`
to that collector instead and add an extra OTLP/http exporter there that forwards to the monitor.

## What you see

- The cost chip shows the exact total; its popover adds "Exact cost from Claude Code telemetry" with main, subagents and
  background, and the subagent cost by type (for example Explore).
- `/api/state` gains `cost.exact`: `total_usd`, `by_source` (`main`, `subagent`, `auxiliary`, `other`), `by_agent_type`,
  `by_session`, `tokens` (`input`, `output`, `cache_read`, `cache_write`), `sessions`, `updated_at`. Each session row in
  `agents` gains `usage.usd_exact_session` (that session including its subagents). The transcript-based fields are unchanged.
- Only sessions in the current view are counted, as with the estimate. Replay (`?at=`) never shows exact figures: telemetry
  is not stored by time.

## Limits

- Claude Code exports every 60 s by default (`OTEL_METRIC_EXPORT_INTERVAL`, in ms), so exact cost lags by up to that long.
  The live agent view still comes from hooks.
- Subagent cost is reported by type, not per subagent run, so two Explore subagents in one session share one figure.
- Sessions are matched on the first 8 characters of the session id (what the hook log keeps).
- If only some sessions in view send telemetry, the headline keeps the estimate and the popover shows the exact figure as partial
  (`cost.exact.complete` is false).
- With the default delta temporality, an export the exporter retries after a lost response is counted twice. Set
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=cumulative` to avoid that.
- Compressed exports are refused: leave `OTEL_EXPORTER_OTLP_COMPRESSION` unset.
- Figures live in memory and reset when the monitor restarts.

## Privacy and security

- The monitor listens on 127.0.0.1 only and applies the same Host and Origin checks as the rest of its API, so web pages
  cannot post to it.
- Claude Code's export includes identity fields (`user.email`, `user.account_uuid`, `organization.id` and others). The monitor
  keeps only the cost and token values with `session.id`, `query_source`, `agent.name`, `model`, `type` and a few labels needed
  to keep series apart. It drops everything else, writes nothing to disk, and never returns identity fields from its API.
- Bounded: 1 MB per request, 20,000 series (the one idle longest is dropped first), short labels only.
- Any process on this machine can post to a localhost port, so another local program could send made-up figures. Treat the
  exact cost as Claude Code's own report on a machine you trust, not as a billing record.
