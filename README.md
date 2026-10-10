# DevSuite — shared engine + focused VS Code extensions

[![CI](https://github.com/gauravgupta0612/devsuite/actions/workflows/ci.yml/badge.svg)](https://github.com/gauravgupta0612/devsuite/actions/workflows/ci.yml)
[![Release RepoPilot](https://github.com/gauravgupta0612/devsuite/actions/workflows/release-repopilot.yml/badge.svg)](https://github.com/gauravgupta0612/devsuite/actions/workflows/release-repopilot.yml)

One repository, one analysis engine, several focused VS Code extensions published separately under the
Marketplace publisher **gauravgupta0612**.

```
devsuite/
├── .github/workflows/        ci.yml + one release-<extension>.yml per extension
├── packages/
│   ├── core/                 @devsuite/core — shared analysis engine (no VS Code dependency)
│   │   ├── scanner, languages, parsers/   indexing (JS/TS, Python, Java/Kotlin, Go, C#, IBM i RPG/CL/DDS/SQL/COBOL)
│   │   ├── resolver, graph, detectors     dependency graph, modules, frameworks, build commands
│   │   ├── git, impact                    git diff parsing + change-impact analysis       (DevImpact)
│   │   ├── risk                           risk rules + scoring                            (CodeGuard)
│   │   ├── routes                         endpoint discovery + request-flow tracing       (TraceLens)
│   │   ├── errors                         error extraction + signatures                   (BugTrail)
│   │   └── guide, search                  onboarding guide + local search                 (RepoPilot)
│   └── vscode-common/        shared VS Code plumbing (index service, navigation)
├── extensions/
│   ├── repopilot/            Project understanding
│   ├── devimpact/            Change impact analysis
│   ├── codeguard/            Pre-commit risk scanner (+ standalone CLI / git hook)
│   ├── tracelens/            API flow explorer
│   └── bugtrail/             Debugging memory
└── scripts/esbuild-extension.js   one bundler config for every extension
```

## Extensions

| Extension | What it does | Marketplace ID |
|---|---|---|
| **RepoPilot** | Architecture, entry points, build commands, modules, dependency map, onboarding guide | `gauravgupta0612.repopilot` |
| **DevImpact** | What a change affects, impact score, which tests to run | `gauravgupta0612.devimpact` |
| **CodeGuard** | Prioritised risk report for changes (secrets, security, regressions, tests, config, IBM i); pre-commit hook | `gauravgupta0612.devsuite-codeguard` |
| **TraceLens** | All API endpoints; trace a request to database and external calls | `gauravgupta0612.devsuite-tracelens` |
| **BugTrail** | Searchable history of errors, attempts and fixes; warns when a fixed bug returns | `gauravgupta0612.bugtrail` |

## Develop

```bash
npm install                 # installs all workspaces
npm test                    # engine + BugTrail store tests
npm run build               # builds core + all extensions
npm run package:all         # one .vsix per extension
```

Open this `devsuite` folder in VS Code and press **F5** and pick "Run <Extension>" or "Run all DevSuite extensions" to launch an Extension Development Host.

## Package locally

```bash
npm run package:repopilot   # -> extensions/repopilot/repopilot-<version>.vsix
code --install-extension extensions/repopilot/repopilot-<version>.vsix
```

## Automatic releases

- **CI** (`ci.yml`) builds and tests every push and pull request on Linux and Windows and uploads the `.vsix`.
- **Release <Extension>** (`release-<extension>.yml`, one per extension) runs on pushes to `main` that touch that extension or the shared
  packages. If the extension's version has no `<extension>-v<version>` tag yet, it
  tests, packages, tags, creates a GitHub Release with the `.vsix` attached and publishes to the VS Code Marketplace.
- To bump and release in one click: **Actions → Release <Extension> → Run workflow → patch / minor / major**. The
  version-bump commit is authored as `gauravgupta0612`.
- Tags are per extension (`repopilot-v0.1.0`, later `devimpact-v0.1.0`, …) so each extension releases independently.

Repository secrets: `VSCE_PAT` (required for Marketplace publishing — Azure DevOps token, *Marketplace → Manage*
scope) and optionally `OVSX_PAT` for Open VSX.
