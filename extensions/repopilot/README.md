# RepoPilot — Project Understanding Assistant

Open an unfamiliar repository and get its **architecture, entry points, build commands, important modules and dependency map** in seconds — with an evidence link behind every claim.

RepoPilot runs **entirely locally**. Your code leaves the machine only when you ask a question and choose to use a VS Code language model (for example GitHub Copilot).

## Features

| | |
|---|---|
| **Project Overview** view | Languages, frameworks, build systems, entry points, build/run commands (▶ to run), modules, core files, circular dependencies, unresolved references. Click anything to jump to its evidence. |
| **Onboarding Guide** | `RepoPilot: Open Onboarding Guide` writes `.repopilot/ONBOARDING.md` — a project-specific guide where every statement links to the file and line it came from. |
| **Dependency Map** | Interactive module ↔ file graph. Filter, zoom, drag, click a node to see what it uses and what uses it, double-click to open or drill into a module. |
| **Who uses this file?** | Right-click any file → direct dependents, transitive dependents (with distance) and the tests that exercise it. The foundation for change-impact analysis. |
| **Ask** | `RepoPilot: Ask About This Codebase` ranks the relevant files locally; with a language model available it answers with citations, otherwise it shows the ranked evidence. |
| **@repopilot** in Chat | `/overview`, `/build`, `/uses` (impact of the active file) or any free question. |
| **Agent tools** | `#repoOverview`, `#repoDependents`, `#repoSearch` — Copilot agent mode can call RepoPilot's index directly. |

## Language support

| Language | Dependencies detected |
|---|---|
| TypeScript / JavaScript | `import`, `export … from`, `require()`, dynamic `import()`, npm workspaces, `@/` alias, `.js`→`.ts` mapping |
| Python | `import`, `from … import`, relative imports, `src/` layouts, `TYPE_CHECKING` blocks treated as type-only |
| Java / Kotlin | imports, wildcard imports, same-package type usage |
| Go | module-local imports via `go.mod` |
| C# | symbols and entry points |
| **IBM i** RPGLE / SQLRPGLE / RPG | `/COPY`, `/INCLUDE`, `DCL-F` and F-specs, `EXTPGM`, `EXTPROC`, `CALL`, `CALLP`, prototypes, embedded SQL tables |
| **IBM i** CL | `CALL PGM()`, `SBMJOB CMD(CALL …)`, `CALLPRC`, `DCLF`, `OVRDBF TOFILE()` |
| **IBM i** DDS / SQL / COBOL | `PFILE`, `JFILE`, `REF`/`REFFLD`; `CREATE TABLE/VIEW/INDEX/PROCEDURE`, `FROM`/`JOIN`; `COPY`, `CALL` |

Frameworks and build systems recognised include npm/yarn/pnpm, tsc, Vite, webpack, Maven, Gradle, pip, Poetry, Make, Docker, GitHub Actions, GitLab CI, Express, NestJS, React, Angular, Vue, Next.js, Django, Flask, FastAPI, Spring Boot, Quarkus, and IBM i tooling (`iproj.json`, Bob `Rules.mk`, Code for IBM i actions).

## Settings

| Setting | Default | |
|---|---|---|
| `repopilot.scanOnStartup` | `true` | Index the workspace when VS Code starts |
| `repopilot.autoRescan` | `true` | Re-index (debounced) after saves, creates and deletes |
| `repopilot.exclude` | `[]` | Extra glob patterns to skip (`node_modules`, `.git`, `dist`, `build`, `target`, … and `.gitignore` are always skipped) |
| `repopilot.maxFiles` | `20000` | Upper bound on indexed files |
| `repopilot.useLanguageModel` | `true` | Use an available language model for **Ask** |
| `repopilot.guideLocation` | `workspace` | Save the guide to `.repopilot/` or open it unsaved |

## How it works

RepoPilot is built on **`@devsuite/core`**, a VS Code–independent engine (scanner → language parsers → resolver → dependency graph → detectors). The same engine will power the companion extensions DevImpact, CodeGuard and TraceLens.

## Limitations (v0.1)

- Analysis is lexical (fast regular-expression parsers), not a full compiler front-end. Dynamic imports built from variables, reflection and runtime dependency injection are not followed.
- IBM i: programs are matched to source members by name; objects that exist only on the system (not in the repo) appear under *Unresolved References*.
- C# namespace usage is not yet resolved to files.
