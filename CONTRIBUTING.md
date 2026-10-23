# Contributing

- Run the tests: `make test` (needs Node 18+ only, on Linux or macOS: some suites do not run on Windows yet).
- Zero-dependency rule: no npm packages, no build step beyond what is in the repo. Use Node built-ins.
- Keep changes small and add a test that fails before the change.
- Never edit the copies under `plugin/` by hand. Edit the sources (monitor, hooks, ui, cli) and run `make build` to regenerate them.
- The notifier tests are macOS-only and are skipped on other platforms.
