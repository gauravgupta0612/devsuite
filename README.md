# DevSuite — shared engine + focused VS Code extensions

[![CI](https://github.com/gauravgupta0612/devsuite/actions/workflows/ci.yml/badge.svg)](https://github.com/gauravgupta0612/devsuite/actions/workflows/ci.yml)
[![Release RepoPilot](https://github.com/gauravgupta0612/devsuite/actions/workflows/release-repopilot.yml/badge.svg)](https://github.com/gauravgupta0612/devsuite/actions/workflows/release-repopilot.yml)

One repository, one analysis engine, several focused VS Code extensions published separately under the
Marketplace publisher **gauravgupta0612**.

```
devsuite/
├── .github/workflows/       ci.yml · release-repopilot.yml (one release workflow per extension)
├── packages/
│   └── core/                 @devsuite/core — the shared analysis engine (no VS Code dependency)
│       ├── src/scanner.ts      repository walk, excludes, .gitignore
│       ├── src/languages.ts    language detection (incl. IBM i source-file folders)
│       ├── src/parsers/        JS/TS · Python · Java/Kotlin · Go · C# · RPG/CL/DDS/SQL/COBOL
│       ├── src/resolver.ts     turns references into file → file edges
│       ├── src/graph.ts        dependency graph, transitive dependents, cycles, modules
│       ├── src/detectors.ts    frameworks, build systems, commands, external deps
│       ├── src/indexer.ts      indexRepository() — puts it all together
│       ├── src/guide.ts        onboarding-guide generator (evidence-linked Markdown)
│       ├── src/search.ts       local relevance ranking for questions
│       └── test/               node:test suites (TS, Python, Java, IBM i fixtures)
└── extensions/
    └── repopilot/            Extension #1 — Project Understanding Assistant
```

## Build order (roadmap)

| # | Extension | Status | Reuses from core |
|---|---|---|---|
| 1 | **RepoPilot** — project understanding | ✅ v0.1.0 | everything |
| 2 | **DevImpact** — change impact analysis | next | `DependencyGraph.transitiveDependents`, symbols, git diff |
| 3 | **CodeGuard** — pre-commit risk report | planned | DevImpact + hotspots + test mapping |
| 4 | **TraceLens** — API flow explorer | planned | framework detectors + route/controller parsers |
| 5 | **BugTrail** — debugging memory | planned | separate workflow (debug-session events) |

## Develop

```bash
npm install                 # installs all workspaces
npm test                    # builds and tests @devsuite/core
npm run build               # builds core + RepoPilot
```

Open this `devsuite` folder in VS Code and press **F5** ("Run RepoPilot") to launch an Extension Development Host.

## Package locally

```bash
npm run package:repopilot   # -> extensions/repopilot/repopilot-<version>.vsix
code --install-extension extensions/repopilot/repopilot-<version>.vsix
```

## Automatic releases

- **CI** (`ci.yml`) builds and tests every push and pull request on Linux and Windows and uploads the `.vsix`.
- **Release RepoPilot** (`release-repopilot.yml`) runs on pushes to `main` that touch `extensions/repopilot/` or
  `packages/core/`. If the version in `extensions/repopilot/package.json` has no `repopilot-v<version>` tag yet, it
  tests, packages, tags, creates a GitHub Release with the `.vsix` attached and publishes to the VS Code Marketplace.
- To bump and release in one click: **Actions → Release RepoPilot → Run workflow → patch / minor / major**. The
  version-bump commit is authored as `gauravgupta0612`.
- Tags are per extension (`repopilot-v0.1.0`, later `devimpact-v0.1.0`, …) so each extension releases independently.

Repository secrets: `VSCE_PAT` (required for Marketplace publishing — Azure DevOps token, *Marketplace → Manage*
scope) and optionally `OVSX_PAT` for Open VSX.
