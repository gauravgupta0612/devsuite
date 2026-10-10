# DevImpact — Change Impact Analyzer

**Before you change code, see what depends on it, what could break and which tests to run.**

DevImpact reads your repository locally, builds a dependency graph and combines it with `git diff`. It answers three questions for any change:

1. **What depends on this?** Files that use the changed functions directly, with the symbols they reference, plus everything reachable 2, 3… hops away.
2. **How risky is it?** An impact score (low / medium / high) based on blast radius, core files and test coverage.
3. **Which tests should I run?** Tests that import the changed code (directly or transitively) and tests named after it, with a ready-to-run command for Jest, Vitest, Mocha, pytest, Maven, Gradle, Go or RPGUnit.

## How to use it

| Where | What |
|---|---|
| **Source Control → Change Impact** view | Updates automatically for your uncommitted changes. ▶ runs the recommended tests. |
| **Right-click a function** → *What Does Changing This Function Affect?* | Impact of one function or class, even before you edit it. |
| **Right-click a file** → *What Does Changing This File Affect?* | Impact of a whole file. |
| **CodeLens** above functions | “⚡ 4 files use this”. Click it for the full analysis. |
| `DevImpact: Analyse Branch vs Base…` | Everything your branch changes compared with `origin/main`. |
| `DevImpact: Copy Impact Report` | Markdown summary for your pull-request description. |
| Copilot agent mode: `#changeImpact` | Lets the AI check impact before it edits code. |

## Languages

TypeScript/JavaScript, Python, Java/Kotlin, Go, C# (symbols) and **IBM i**: RPGLE/SQLRPGLE copybooks, programs, procedures and files, CL calls, DDS and SQL tables. On IBM i, changing a physical file shows every program that uses it.

## Settings

| Setting | Default | |
|---|---|---|
| `devimpact.codeLens` | `true` | Show “N files use this” above functions |
| `devimpact.autoRefresh` | `true` | Re-run the last analysis on save |
| `devimpact.maxDepth` | `6` | Dependency hops to follow |
| `devimpact.baseRef` | auto | Base branch for branch analysis |

Everything runs locally; no code leaves your machine.

Part of **[DevSuite](https://github.com/gauravgupta0612/devsuite)**: RepoPilot · DevImpact · CodeGuard · TraceLens · BugTrail.
