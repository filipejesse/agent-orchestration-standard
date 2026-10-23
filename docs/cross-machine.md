# Cross-machine view

One dashboard, usage aggregated across machines. Opt-in, read-only, and it opens **no new network listener or port** anywhere: the monitor on the machine you look at runs `ssh` to each remote, and the remote answers from its own loopback dashboard.

```
laptop (you look here)                      laptop2 (remote)
 monitor ── ssh -o BatchMode=yes … ───────▶ curl http://127.0.0.1:4318/api/state?local=1
        ◀── same read-only JSON as its own dashboard ──
```

## Setup

1. **SSH key auth** from this machine to each remote, working non-interactively: `ssh -o BatchMode=yes user@host true` must succeed (keys in your agent or `~/.ssh/config`; passwords and prompts are not supported). An `~/.ssh/config` alias works as the target.
2. **The remote must have the dashboard installed and running** (`make install` or the plugin; the monitor listens on its own `127.0.0.1:4318`) and `curl` available.
3. Add the remotes to the monitor config, `config.json` in the monitor's data dir (`~/.claude/plugins/data/aos-dashboard-aos-local/live/config.json` for the plugin; `live/config.json` in a repo checkout):

```json
{ "remotes": [ { "name": "laptop2", "ssh": "user@host", "port": 4318 } ] }
```

`name` is a label (letters, digits, `. _ -`, up to 32, not `local`); `port` is the remote dashboard's port (default 4318). For testing, `AOS_REMOTES='[{"name":"laptop2","ssh":"user@host"}]'` overrides the file. Config changes are picked up without a restart. Empty or absent means the feature is off.

## What you get

- `/api/state` gains `machines` (`name`, `ok`, `last_seen`, `error`, `totals`), a `totals` block, and `cost.by_machine`. Every agent, task, project, alert, collision, event and goal carries `machine`; remote ids are namespaced `<name>:<id>`, remote project names read `proj @name`. Local stays `machine: "local"` with unchanged ids. `?local=1` returns the machine's own state without remotes (this is what remotes poll, so two machines can list each other without loops).
- **Web UI:** a chip row (All / local / each remote, with a status dot) filters the whole view; hovering a chip or reading the line under it shows that machine's agents, tokens and cost. An unreachable machine shows a red dot and the error; its rows disappear after about 20 s without a successful poll.
- **Terminal:** `aos-dash --machine laptop2` filters; the header shows a `machines:` summary line.
- **MCP:** `aos_status` includes a `machines:` line and takes an optional `machine` filter.

Polling is every 5 s per remote, with exponential backoff (up to 60 s) while a remote is failing.

## Security notes

- **What is sent:** the remote's normal `/api/state` (agent names and roles, status, models, token and cost counts, touched file names, alerts), the same data its own local dashboard shows. Nothing is written to the remote and nothing is pushed anywhere.
- **No shell on this side:** `ssh` is started with `execFile` and an argument array. The `ssh` target and port are validated strictly (`[user@]host` of letters, digits, `. _ -`, no leading dash, no spaces or shell characters; integer port); invalid remotes are ignored with a log line. The target follows `--` so it cannot be read as an option. The only remote command is a fixed `curl` string with the numeric port substituted.
- **Remote data is untrusted:** responses are capped at 8 MB, parsed as JSON, shape-checked and size-limited per list, and rendered with `textContent` only. A compromised remote can show misleading agents, nothing more.
- **MCP and the model:** the MCP tools (`aos_status`, `aos_agent`, ...) now pass remote-controlled text (agent ids, project names, alerts, file names) to the model. Treat all of it as untrusted input: it can be crafted to look like instructions. Remote ids are always namespaced `<name>:<id>`, strings are capped at 512 characters and nested lists at 64 entries, but the content itself is not otherwise filtered.
- **Trust:** SSH accounts you list can already run commands on those hosts; this feature adds no access. Use a restricted key (for example `command=`-limited in `authorized_keys`) if you want the key usable for this alone. Host keys are checked by your normal `known_hosts` policy; `BatchMode` means an unknown or changed key fails rather than prompting.

## Limits

Remote history/replay (`?at=`) and goals' control actions are not aggregated; goals from remotes are listed read-only. A remote only needs a dashboard that serves `/api/state`.
