# Orchestrator state contract (what the dashboard relies on)

The monitor (`monitor.mjs`, port 4318) never imports or calls the orchestrator. Its whole coupling is the files below, the
hook env tags, and two ports. Anything that writes this layout (the engine in https://github.com/tomtomsatnav/aos-orchestrator, or any other orchestrator) is compatible. Source of truth for the mapping: the comment block above `loadGoalEntry` in `monitor.mjs`.

## On-disk layout (read-only for the monitor)

Roots: `$AOS_ORCH_DIR` if set (only that dir is read). Otherwise BOTH of: the default dir `$XDG_STATE_HOME/aos/orch` (when `XDG_STATE_HOME` is set) or `~/.aos/orch`, and the legacy
`${CLAUDE_PLUGIN_DATA:-~/.claude/plugins/data/aos-dashboard-aos-local}/orch` (the engine keeps using the legacy dir when only that exists). Goal lists are merged and deduped by goal id; when an
id exists in both, the copy whose `goal.json` has the newer mtime (heartbeat) wins. Roots are only read: the monitor never creates either dir.
Goals: `<root>/goals/<gid>/`, `gid` matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (others are ignored). Only dirs containing a
parseable `goal.json` count; the 50 most recently modified `goal.json` are read. Files are size-capped (2 MB), cached by
mtime+size, rescanned at most once a second. A partial/corrupt write keeps the last good data; a missing file = empty.

| File | Read as | Fields used |
|---|---|---|
| `goal.json` (object) | goal | `title`, `description`, `status` (`achieved\|failed\|cancelled` are terminal), `created_at`, `updated_at`, `blocked_reason`, `success_criteria[{id,text,met,verify?}]` (`verify: "human"` = a person must confirm it; the engine keeps such a goal `blocked` until then), `budget.max_wall_clock_s`, `orch.repo` (absolute; only its basename is exposed, and it maps tagged workers to a project), `orch.plan_state` (`planning\|awaiting_approval\|approved\|rejected\|none`; `supplied` -> `planning`; unknown -> `none`), `orch.plan_awaiting_since_ms`, `orch.paused_reason`, `orch.resume_at`, `orch.started_ms`, `orch.budgets.{max_new_tokens,max_parallel,max_attempts}`, `orch.usage.{new_tokens,notional_usd}`, `orch.rules` (the rule-set snapshot summary the engine writes, optional: `{hash (12 chars), profile, legacy, layers[{layer,sha12}], loosenings[{rule_id,layer}], dropped[{rule_id,layer,reason}]}`; ids only, no rule values and no paths) |
| `tasks.json` (array, max 200) | tasks | `id`, `title`, `status` (`done\|failed\|cancelled\|needs_review\|running\|ready\|...`), `depends_on[]`, `attempts`, `max_attempts`, `orch.{phase,model_tier,branch,last_failure{kind,note},tokens.new}`, `orch.attempt_log[{n,tier,outcome,started_at,ended_at,new_tokens,notional_usd,checks_ok,counted,anticheat?,self_checks?{runs},claude_version?,stderr_tail?}]` |
| `events.ndjson` | last 25 lines (tail read of 256 KB; partial/bad lines dropped) | `type`, `ts`, `task_id`, `data.{reason,error,msg,title,status,plan_state,tier,attempt,outcome,rule,label,tool,exit_code,kind,cause,ok}` (first 4 scalar values become `text`). `data.rule` is the id of the rule that decided: engine events use unqualified ids (`retry.ladder`, `retry.same_tier_retries`, `retry.max_attempts`, `budgets.max_usd`, `governor.reserve_5h`, `merge.on_conflict`, `plan.approval`, ...), policy decisions use `<layer>:<id>` (`floor:dangerous`, `default:outside_scope`). New event types the monitor shows by `type` only: `orch.rules.snapshotted`, `orch.rules.refused`, `orch.rules.changed`, `orch.rules.tampered`, `orch.rules.deprecated`, `orch.rules.repo_layer`, `orch.criterion.confirmed`. `goal.created` may carry `data.drafted: true` and `data.draft_tier` (the goal came from `aos-orch draft` / the draft endpoint) |
| `approvals/A-<n>.json` | pending approvals | `status === 'pending'`, `task_id`, `requested_at` (else file mtime). The engine also writes `rule` and `rule_id` (`<layer>:<id>`); the monitor does not read them |

Free text is scrubbed (absolute paths and token-like strings removed) and length-capped before leaving the process.

## Guard verdicts (`<root>/verdicts/<id>.json`)

Written by `aos-orch verify`. `id` matches `^v-\d{8}-\d{6}-[0-9a-f]{6}$` and equals the file name. Fields read: `schema` (must be `aos.verdict/1`), `id`, `created_at`, `repo` (absolute; basename only exposed; also the per-repo key), `repo_name` (fallback), `base` (sha, shortened to 12), `base_ref` (null when the base was given as a sha), `tree` (`working` or a sha), `accepted`, `integrity` (both booleans, else the record is skipped), `rejections[{kind, detail}]`, `warnings[]`, `failing_tests[]`, `checks[{argv, ok, exit_code, duration_ms}]`, `duration_ms`, `source` (`cli|hook|eval`), `session_id` (matched only, never exposed), `tool_version`. Verdict = `verified` if accepted, else `integrity` if `integrity` is true, else `capability`. Mapping and limits: [dashboard.md, Guard view](dashboard.md#guard-view).

## Worker env tags (set by the engine, read by `hooks/aos-hook.mjs`)

`AOS_GOAL_ID`, `AOS_TASK_ID`, `AOS_ATTEMPT`, `AOS_WORKTREE` are set in each worker's environment. The hook records only
`AOS_GOAL_ID` -> `gid` and `AOS_TASK_ID` -> `tid` into `hook-events.ndjson`, and only if they match `^[A-Za-z0-9._-]{1,64}$`;
no other env value is read. The monitor uses `gid`/`tid` to tag agents (`goal_id`, `task_id`, `goal_title`), group them under
the goal's repo (`orch.repo` basename) instead of the worktree, and count `workers` (running tagged agents) per goal.
`AOS_ATTEMPT` and `AOS_WORKTREE` are consumed by the orchestrator's own policy hook, not by the dashboard.

## Ports, CORS, login

- Monitor `127.0.0.1:4318` (override `PORT`): read-only. `Host` and any `Origin` must be `127.0.0.1` or `localhost` (any port), else 403.
  Non-GET/HEAD -> 405. No CORS headers are sent. Responses carry `nosniff`, `no-store`, `no-referrer`, `X-Frame-Options: DENY`.
- Control server `127.0.0.1:4319` (orchestrator-owned, not required by the monitor): browser login is `aos-orch login-link`, which prints
  `/auth/login?code=<one-time code>` (code valid 2 min, stored hashed, consumed once). The login page POSTs the code to `/auth/exchange`
  and receives a session token; every later call sends `Authorization: Bearer <session token>` (CLI uses a token file instead). Session
  tokens live in server memory only, last 12 h, and at most 50 are kept (oldest evicted). No cookies and no CSRF header. CORS answers only
  dashboard origins and allows only the `Authorization` and `Content-Type` request headers. The UI (`ui/orch.js`) calls it directly with
  `mode: cors`; override with `<html data-aos-control-url>`. The monitor only links to it and the token never goes to 4318.

## HTTP shapes

- `GET /api/goals` -> `{ "goals": [GoalSummary] }` (max 50, newest `updated_at` first; each includes `workers`).
- `GET /api/goals/<gid>` -> `{ "goal": GoalDetail }` (wrapper key is `goal`; the UI reads `j.goal`). 404 for unknown/invalid id, 400 for bad URL encoding.
- `GET /api/state` also carries `goals` (max 20 summaries); replay (`?at=`) omits `goals`.
- GoalSummary: `id, title, status, repo_name, created_at, updated_at, plan_state, paused_reason, resume_at, blocked_reason,
  budget{max_new_tokens,used_new_tokens,max_wall_s,used_wall_s,max_parallel,running,max_attempts}, tasks_total, tasks_done,
  tasks_failed, approvals_pending, limit_paused, rerun_count, out_of_scope_count, workers, outcome{merged,discarded,tokens_per_accepted,cost_usd,waiting_s,waiting_on}, rules`. `rules` is `null` for a goal without `orch.rules` (older engine), else `{hash, profile, legacy, loosenings: n, dropped: n}`.
- GoalDetail = summary + `description, criteria[{id,text,met,verify?,needs_confirmation?}], rules` (the summary's `rules` plus `layers[{layer,sha12}]`, `loosening_ids[{rule_id,layer}]`, `dropped_ids[{rule_id,layer,reason}]`; the 32-hex content binding at the end of a rule id is shortened to 8 characters), last_events[{type,ts,task_id,text}], tasks[{id,title,status,phase,
  tier,depends_on,attempts,max_attempts,branch,ran_s,new_tokens,check_summary,outcome,retries,tier_path,cost_usd,waiting_s,
  waiting_for_human,rerun,out_of_scope,scope_violations,error?}]`. `out_of_scope` = the task has at least one `attempt_log` entry with `outcome: scope_violation` (the engine's snapshot check found changed files outside the task's `path_scope`; the attempt fails and escalates; also logged as event `orch.check.failed` with `reason: scope_violation`); `scope_violations` counts those entries; `out_of_scope_count` counts such tasks per goal. Tagged workers (agents with `goal_id`+`task_id`) of such a task carry `out_of_scope: true` in `/api/state`. Ordinary sessions have no declared scope and never get the flag. `limit_paused` = `paused_reason` is a plan-limit pause (`plan limit...` / `...utilisation...`); `rerun` = task not done/failed/cancelled whose newest `attempt_log` entry has `outcome: rate_limited` (uncounted, requeued by the engine); `rerun_count` counts them. No absolute path appears in any response.

## Anti-cheat and integrity fields (additive, optional; the orchestrator's contract is the source of truth)

All optional: goals written before they existed render as `integrity: clean` with `checked: false` and no badges; wrong-typed values are ignored, never an error.

| Engine field | Dashboard field |
|---|---|
| `attempt_log[].anticheat {status pass\|warn\|fail, failed, findings[{kind,severity}]}` | `tasks[].attempt_log[].integrity {status clean\|warning\|failed, reasons[kind]}`; kinds (`tests_weakened`, `harness_tamper`, `vacuous_pass`, ...) pass through only if `^[a-z_]{1,40}$` |
| `attempt_log[].outcome === 'worktree_mutated_during_checks'` | that attempt is `failed`, reason `worktree_mutated_during_checks` |
| `attempt_log[].self_checks.runs` | `attempt_log[].self_checks`; `tasks[].self_checks` = sum (events `orch.check.self_run`/`self_capped`/`self_flooded` appear in `last_events` by type; `data.run` is shown in `text`) |
| `attempt_log[].claude_version` vs `goal.orch.claude_version_start` | `attempt_log[].version_mismatch`, `tasks[].version_mismatch`, `GoalDetail.claude_version_start` |
| `attempt_log[].stderr_tail` | `attempt_log[].stderr_tail`: newest 20 lines, each scrubbed (paths reduced to basenames, tokens redacted), max 1500 chars; the UI shows it as text only |
| `goal.orch.protected_result {ok,files,not_executed[],kind?,output?}` | `GoalDetail.protected_tests {ok,files,not_executed (count),kind,output (failed only)}`; `ok: false` also makes the goal `integrity.status` `failed` (so does `orch.anticheat.acceptance_result.ok === false`) |
| `goal.orch.review {tier,text,error}` (advisory, model-written) | `GoalDetail.review {tier,text,error}`, shown collapsed and labelled unverified |
| (derived) | `GoalSummary.integrity {status, failed_attempts, warning_attempts, kinds{kind:n}, checked}`, `tasks[].integrity {status,reasons}` (worst attempt) |

The `attempt_log` list per task is capped at the newest 10 attempts. The MCP tool `aos_goals` prints an `integrity:` line per goal.

## Tests

`tests-monitor/` runs against golden goal dirs in `tests-monitor/fixtures/` and has no orchestrator import. To regenerate them
(needs the engine checked out), see `tests-monitor/fixtures/README.md`.

## Coupling note

`goalOutcome` in `monitor.mjs` counts plan waiting time (`waiting_on: plan`) only while the goal `status` is `draft`. This is coupled to the engine: an orchestrator that leaves `plan_state: awaiting_approval` set after the goal leaves `draft` will not show that wait.
