# Live agent swarm acceptance

From a built source checkout, this optional check launches three real Claude Haiku workers: library, CLI, and QA. They implement a disposable Python JSONL reporter, exchange contracts and source through Mors, hand off for review, and wait for coordinator release. It is separate from `npm test`; npm packages do not include `scripts/`.

Prerequisites: Python 3.9+, Node, installed dependencies, `npm run build`, Bubblewrap on Linux, and an authenticated `claude` CLI supporting `--include-hook-events`, `--effort`, and `--max-budget-usd`.

```bash
python scripts/agent-swarm-acceptance.py --self-check
python scripts/agent-swarm-acceptance.py --probe
python scripts/agent-swarm-acceptance.py --run --budget 0.50 --timeout 360
```

`--self-check` checks the acceptance validator. The free `--probe` exercises isolation, the generated hook command, and isolated Claude authentication without requesting a model response. The live run requests a $0.50 Claude budget per worker ($1.50 total), with a 360-second work deadline and 45-second shutdown grace. On machines with a command queue, queue the entire command; workers must not acquire that queue again.

Workers have private `/tmp` directories and separate writable workspaces. The checkout and sibling workspaces are hidden, the remaining host filesystem and copied Mors runtime are read-only, and the disposable Mors hub is shared. Each worker gets a disposable `CLAUDE_CONFIG_DIR`, a private account-settings mount, and a read-only credential mount. Only project/local settings and the installed Mors skill/hooks are loaded; MCP servers are disabled. Claude API networking remains available. Independent artifact checks run in the sandbox with networking disabled.

Acceptance requires the three dependency questions answered on their original threads, source handoffs matching the final files (allowing one optional final newline), 20 independent reporter contract cases, and the QA worker's own checks. The real Claude traces must show successful `SessionStart` and `PostToolUse` Mors context and native Mors skill invocation. A failed artifact review allows one repair round within the same deadline; both rounds retain their diagnostics. Release follows passing checks; success also requires acknowledged release messages, zero pending mail, successful runtime exits, offline workers, and unchanged reviewed artifacts. Early worker exit is a failure. Started processes are stopped on success or failure, and cleanup does not turn failed acceptance into a pass.

Evidence is retained under `~/.cache/agent-proof/mors/agent-swarm-*`, or a new directory supplied with `--output`. Inspect `summary.json`, `transcript.json`, `logs/*.jsonl`, and the independent/QA check logs. The copied runtime and final artifact are retained for diagnosis. Failed runs exit nonzero and retain their observed failures; fix the reported cause and start a new run.
