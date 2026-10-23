# AOS terminal dashboard

Zero-dependency (Node 18+) terminal version of the live dashboard. Reads `http://127.0.0.1:${AOS_PORT:-4318}/api/state` only.

    node cli/dash.mjs            live full-screen (alternate screen, q quits)
    node cli/dash.mjs --once     print one frame and exit (also when stdout is not a TTY)
    node cli/dash.mjs --json     print a compact JSON snapshot and exit
    node cli/dash.mjs --list     compact list view
    options: --json, --port N, --no-color (or NO_COLOR), --size WxH (with --once)

`--json` prints one line of JSON: `{agents:[{id,role,status,model_label}], tasks (omitted if none), totals:{agents,tokens_total}}`. If the monitor can't be reached it prints `{"error":"monitor unreachable"}` and exits 1.

Keys: q quit, space pause, l view (auto -> forced list -> forced ring -> auto), ? help. The ring is a project graph: a heart (all Claude Code sessions) -> one hub per project -> that project's agents on an outward arc; cells stay put as agents arrive. On terminals larger than 100x30 the ring scales with the area (distances only, label sizes never grow; the composition fills ~85-92% of the usable width and height, hubs spread wider with several projects); at 100x30 and below the layout is the compact one. The list groups agents under project header rows. Without `state.projects` (older monitor) it draws the flat ring. Auto uses the ring when all labels fit the terminal without overlap, otherwise the list (and always the list below 80x24).
Colour: truecolor (COLORTERM=truecolor), 256, else 16 colours. Headline tokens are new tokens (input + output + cache write); cache reads are shown separately.
Tests: `node cli/test.mjs` (no network).
