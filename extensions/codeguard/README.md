# CodeGuard — Pre-Commit Risk Scanner

**A prioritised risk report for your changes before you commit, not another wall of lint warnings.**

CodeGuard looks only at what you changed (staged, uncommitted or a whole branch), weighs it against the rest of the repository and tells you what is risky, in order of severity.

## What it catches

| Category | Examples |
|---|---|
| 🛑 **Secrets** | AWS keys, private keys, GitHub/Slack/OpenAI tokens, hard-coded passwords, credentials in connection strings, committed `.env` / key files |
| 🔴 **Security** | SQL built by string concatenation, shell commands built from variables, `eval`, disabled TLS verification, unsafe deserialisation, XSS sinks, weak hashes, CORS `*` |
| 🔴 **Regressions** | Deleted or renamed files that are still imported, removed public functions that other files use, changes to files with a wide blast radius, frequently changed hotspots |
| 🟠 **Testing** | Code changed without any test change, `.only` left in tests, disabled tests |
| 🟠 **Config** | Dependency/build changes, CI and Docker changes, database migrations |
| 🟠 **IBM i** | DDS physical/logical file changes (level check, so dependent programs must be recompiled), hard-coded libraries, `MONMSG CPF0000` without action, `QCMDEXC` built from variables, `SELECT *` into data structures |
| 🟡 **Quality** | Debugger statements, debug logging, swallowed errors, lint suppressions, very large diffs |

## How to use it

- **Source Control → CodeGuard Risk** view. It re-scans when you stage files.
- Findings appear in the **Problems** panel and as squiggles on the changed lines.
- The status bar shows the risk level. Click it for the full Markdown report.
- **Install Git Pre-Commit Hook** blocks commits at the level you choose (`codeguard.hookFailOn`, default `critical`). Bypass once with `git commit --no-verify`.
- Ignore one line with a `codeguard-ignore` comment, or a whole rule with `codeguard.disabledRules`.
- Copilot agent mode: `#riskReview`.

### In CI

The hook script is a standalone Node program. Run `node .git/hooks/codeguard-cli.js --base origin/main --fail-on high` (or `--json`) in any pipeline.

Everything runs locally; no code leaves your machine.

Part of **[DevSuite](https://github.com/gauravgupta0612/devsuite)**: RepoPilot · DevImpact · CodeGuard · TraceLens · BugTrail.
