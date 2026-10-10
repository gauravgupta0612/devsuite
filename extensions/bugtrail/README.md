# BugTrail — Debugging Memory

**Your personal, searchable history of the bugs you hit and how you fixed them, across all your projects.**

BugTrail runs quietly in the background and records:

- **Errors**: from failed terminal commands, debugger exceptions and stderr, and failed tasks.
- **Attempts**: the files you edit while a bug is open.
- **Fixes**: when the same command, task or debug configuration succeeds again, the bug is marked fixed automatically and the files you changed are remembered. Add a one-line note for your future self.

When an error you have fixed before shows up again, in this project or any other, BugTrail tells you straight away: *“This bug is back. Fixed 3 days ago: user.profile can be null for SSO users.”*

## Features

- **Run and Debug → BugTrail** view: Open, Fixed and Recurring bugs, with the files changed, where the error was thrown and your notes.
- **Search Debugging History**: fuzzy search by error text, error type, file or note.
- **Record Error from Selection**: select an error in the editor or terminal and record it by hand.
- **Error signatures**: paths, line numbers, ids and numbers are normalised, so the same bug matches across machines and projects.
- Understands JavaScript/TypeScript, Python tracebacks, Java and .NET exceptions, Go panics, TypeScript compiler errors and **IBM i message IDs** (CPF, CPD, MCH, RNX, RNQ, SQL, CEE).
- **Export as Markdown** to share with the team or attach to a ticket.
- Copilot agent mode: `#bugHistory` lets the AI check whether you have solved an error before.

History is stored locally in VS Code's global storage. Nothing is uploaded.

## Settings

`bugtrail.captureTerminal`, `bugtrail.captureDebug`, `bugtrail.captureTasks`, `bugtrail.autoResolve`, `bugtrail.notifyRecurring`, `bugtrail.ignorePatterns`.

Terminal capture uses VS Code's shell integration, which is on by default for bash, zsh, fish and PowerShell.

Part of **[DevSuite](https://github.com/gauravgupta0612/devsuite)**: RepoPilot · DevImpact · CodeGuard · TraceLens · BugTrail.
