# Golden goal fixtures

Each `<name>/goals/<gid>/` is a real orchestrator goal dir (only the files the monitor reads: `goal.json`, `tasks.json`,
`events.ndjson`, `approvals/`), with the sandbox root rewritten to `/fixture`. Tests copy one into a temp `AOS_ORCH_DIR`.

| Fixture | gid | State |
|---|---|---|
| `all-success` | `g-test` | 3 tasks, all haiku, first try, achieved |
| `escalation` | `g-esc` | haiku fails checks, sonnet succeeds, achieved |
| `failed` | `g-fail` | t1 fails on every tier, t2 never runs |
| `waiting` | `g-wait` | `escalation` + pending approval A-1 (placeholder `requested_at`; the test rewrites it) |
| `scope` | `g-scope` | `escalation` whose first attempt has `outcome: scope_violation` (changed files outside `path_scope`) |
| `plan` | `g-plan` | `escalation` as a draft awaiting plan approval (`plan_awaiting_since_ms: 0`; the test rewrites it) |
| `rules` | `g-rules` | `escalation` with a rule-set summary in `goal.orch.rules` (1 loosening, 1 dropped repo loosening), a `verify: human` criterion `c2` and `data.rule` on `task.retried` (hand-derived) |
| `integrity` | `g-integ` | `escalation` hand-extended with anti-cheat data (contract section "Anti-cheat fields"): attempt 1 `tests_weakened` (fail) + `vacuous_pass` warn, 2 self-checks, a hostile `stderr_tail`; attempt 2 `literal_copy` warn on a different `claude_version`; `protected_result` ok, advisory `review`, `orch.check.self_run` events (hand-derived, not generated) |

Regenerate (only while `./orchestrator` exists; uses the fake claude, never a real one):

    node tests-monitor/gen-fixtures.mjs

`gen-fixtures.mjs` is the only file in `tests-monitor/` that may reference the orchestrator, and the tests never run it.
Timestamps are kept as generated; tests do not depend on their values except where they patch them relative to "now".
Contract the fixtures must satisfy: `docs/orch-state-contract.md`.

`verdicts/` holds three hand-written `aos.verdict/1` records (from the contract, not generated): `…aaaaaa` accepted (shop), `…bbbbbb`
an integrity rejection (shop, `tests_edited` + `vacuous_pass`, linked to session `sessAAAA…`, absolute paths in its text),
`…cccccc` a capability rejection (api, 2 failing tests). `monitor-verdicts.test.mjs` copies them into a temp `<orch>/verdicts/`.
