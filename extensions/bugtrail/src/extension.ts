import * as vscode from 'vscode';
import * as path from 'path';
import { ExtractedError, extractErrors } from '@devsuite/core';
import { BugEntry, BugStore, RecordResult, Source } from './store';

let store: BugStore;
let tree: Timeline;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;

const cfg = () => vscode.workspace.getConfiguration('bugtrail');
const wsName = (uri?: vscode.Uri) => (uri && vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(no folder)';
const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)} min ago` : d < 86400 ? `${Math.floor(d / 3600)} h ago` : `${Math.floor(d / 86400)} d ago`;
};

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('BugTrail');
  store = new BugStore(path.join(context.globalStorageUri.fsPath, 'bugtrail.json'));
  tree = new Timeline();
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 47);
  status.command = 'bugtrail.timeline.focus';
  context.subscriptions.push(output, status, vscode.window.createTreeView('bugtrail.timeline', { treeDataProvider: tree, showCollapseAll: true }));
  const cmd = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ---------------------------------------------------------------- capture: terminal
  const buffers = new WeakMap<object, string>();
  const win = vscode.window as any;
  if (win.onDidStartTerminalShellExecution && win.onDidEndTerminalShellExecution) {
    context.subscriptions.push(win.onDidStartTerminalShellExecution(async (e: any) => {
      if (!cfg().get<boolean>('captureTerminal', true)) return;
      buffers.set(e.execution, '');
      try {
        for await (const chunk of e.execution.read()) {
          const prev = buffers.get(e.execution) ?? '';
          const next = prev + chunk;
          buffers.set(e.execution, next.length > 200_000 ? next.slice(-150_000) : next);
        }
      } catch { /* stream closed */ }
    }));
    context.subscriptions.push(win.onDidEndTerminalShellExecution((e: any) => {
      if (!cfg().get<boolean>('captureTerminal', true)) return;
      const command: string = e.execution?.commandLine?.value ?? '';
      const ws = e.execution?.cwd ? wsName(e.execution.cwd) : wsName();
      // give the read() loop a moment to drain
      setTimeout(() => {
        const out = buffers.get(e.execution) ?? '';
        if (e.exitCode === 0) { autoResolve(ws, 'terminal', command); return; }
        if (e.exitCode === undefined) return;
        capture(out, { source: 'terminal', workspace: ws, command }, `\`${command}\` exited with ${e.exitCode}`);
      }, 300);
    }));
  }

  // ---------------------------------------------------------------- capture: debug
  const sessionOut = new Map<string, string>();
  const sessionErrored = new Set<string>();
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session) {
      if (!cfg().get<boolean>('captureDebug', true)) return undefined;
      sessionOut.set(session.id, '');
      return {
        onDidSendMessage: async (m: any) => {
          if (m?.type !== 'event') return;
          if (m.event === 'output' && ['stderr', 'important', 'console', 'stdout'].includes(m.body?.category ?? 'console')) {
            const t = (sessionOut.get(session.id) ?? '') + (m.body?.output ?? '');
            sessionOut.set(session.id, t.length > 200_000 ? t.slice(-150_000) : t);
          }
          if (m.event === 'stopped' && m.body?.reason === 'exception') {
            let text = m.body?.text ?? m.body?.description ?? '';
            try {
              const info: any = await session.customRequest('exceptionInfo', { threadId: m.body.threadId });
              text = [`${info?.exceptionId ?? ''}: ${info?.description ?? ''}`, info?.details?.stackTrace ?? ''].join('\n');
            } catch { /* adapter doesn't support exceptionInfo */ }
            sessionErrored.add(session.id);
            capture(text || 'Exception: (no description)', { source: 'debug', workspace: wsName(session.workspaceFolder?.uri), command: session.name }, `Exception in debug session "${session.name}"`);
          }
        }
      };
    }
  }));
  context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
    const out = sessionOut.get(session.id) ?? '';
    sessionOut.delete(session.id);
    const ws = wsName(session.workspaceFolder?.uri);
    const found = extractErrors(out, 2);
    if (found.length) { sessionErrored.add(session.id); capture(out, { source: 'debug', workspace: ws, command: session.name }); }
    if (!sessionErrored.has(session.id)) autoResolve(ws, 'debug', session.name);
    sessionErrored.delete(session.id);
  }));

  // ---------------------------------------------------------------- capture: tasks
  context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(e => {
    if (!cfg().get<boolean>('captureTasks', true)) return;
    const t = e.execution.task;
    const ws = typeof t.scope === 'object' ? wsName((t.scope as vscode.WorkspaceFolder).uri) : wsName();
    const name = `${t.source}: ${t.name}`;
    if (e.exitCode === 0) { autoResolve(ws, 'task', name); return; }
    if (e.exitCode === undefined) return;
    const err: ExtractedError = { type: 'TaskFailed', message: `Task "${t.name}" failed with exit code ${e.exitCode}`, signature: `taskfailed: task "${t.name.toLowerCase()}" failed`, raw: '' };
    handle(store.record(err, { at: new Date().toISOString(), source: 'task', workspace: ws, command: name }));
  }));

  // ---------------------------------------------------------------- attempts
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(doc => {
    if (doc.uri.scheme !== 'file') return;
    const ws = wsName(doc.uri);
    store.trackEdit(ws, path.relative(ws, doc.uri.fsPath).split(path.sep).join('/'));
    tree.refresh();
  }));

  // ---------------------------------------------------------------- commands
  cmd('bugtrail.refresh', () => { store.load(); tree.refresh(); });
  cmd('bugtrail.showDetails', async (e: BugEntry | { entry: BugEntry }) => {
    const entry = (e as any)?.entry ?? e;
    if (!entry?.id) return;
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: store.toMarkdown(entry) });
    await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  });
  cmd('bugtrail.openEvidence', async (o: { workspace: string; file: string; line?: number }) => {
    const uri = path.isAbsolute(o.file) ? vscode.Uri.file(o.file) : vscode.Uri.file(path.join(o.workspace, o.file));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const l = Math.max(0, (o.line ?? 1) - 1);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(l, 0, l, 0) });
    } catch { vscode.window.showWarningMessage(`BugTrail: ${o.file} is not available on this machine.`); }
  });
  cmd('bugtrail.search', async () => {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { entry?: BugEntry }>();
    qp.title = 'Search your debugging history';
    qp.placeholder = 'Error text, type (TypeError, CPF4131…), file or note';
    qp.matchOnDescription = true; qp.matchOnDetail = true;
    const update = () => {
      qp.items = store.search(qp.value).map(({ entry }) => ({
        label: `${entry.status === 'open' ? '$(circle-filled)' : '$(pass-filled)'} ${entry.type}: ${entry.message.slice(0, 90)}`,
        description: `${entry.count}× · ${ago(entry.lastSeen)}`,
        detail: entry.resolution ? `Fixed ${ago(entry.resolution.at)}${entry.resolution.note ? ' — ' + entry.resolution.note : ''}${entry.resolution.files.length ? ' · ' + entry.resolution.files.slice(0, 4).join(', ') : ''}` : entry.notes.at(-1)?.text ?? path.basename(entry.workspaces[0] ?? ''),
        entry
      }));
    };
    qp.onDidChangeValue(update);
    qp.onDidAccept(() => { const e = qp.selectedItems[0]?.entry; qp.hide(); if (e) vscode.commands.executeCommand('bugtrail.showDetails', e); });
    update(); qp.show();
  });
  const pickEntry = async (arg: any, filter: (e: BugEntry) => boolean, title: string): Promise<BugEntry | undefined> => {
    const given = arg?.entry ?? (arg?.id ? arg : undefined);
    if (given) return given;
    const list = store.entries.filter(filter).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    if (!list.length) { vscode.window.showInformationMessage('BugTrail: nothing to pick.'); return undefined; }
    return (await vscode.window.showQuickPick(list.map(e => ({ label: `${e.type}: ${e.message.slice(0, 90)}`, description: ago(e.lastSeen), e })), { title }))?.e;
  };
  cmd('bugtrail.markResolved', async (arg?: any) => {
    const e = await pickEntry(arg, x => x.status === 'open', 'Which bug did you fix?');
    if (!e) return;
    const files = [...new Set(e.attempts.flatMap(a => a.files))];
    const note = await vscode.window.showInputBox({ title: 'How did you fix it? (optional, helps next time)', prompt: files.length ? `Files you edited: ${files.slice(0, 5).join(', ')}` : undefined });
    if (note === undefined) return;
    store.resolve(e.id, 'manual', note || undefined);
    tree.refresh();
  });
  cmd('bugtrail.addNote', async (arg?: any) => {
    const e = await pickEntry(arg, () => true, 'Add a note to which bug?');
    if (!e) return;
    const text = await vscode.window.showInputBox({ title: `Note for ${e.type}`, placeHolder: 'Root cause, workaround, link to ticket…' });
    if (text) { store.addNote(e.id, text); tree.refresh(); }
  });
  cmd('bugtrail.delete', async (arg?: any) => {
    const e = arg?.entry ?? arg;
    if (e?.id) { store.remove(e.id); tree.refresh(); }
  });
  cmd('bugtrail.clearAll', async () => {
    const ok = await vscode.window.showWarningMessage(`Delete all ${store.entries.length} BugTrail entries? This cannot be undone.`, { modal: true }, 'Delete all');
    if (ok) { store.clear(); tree.refresh(); }
  });
  cmd('bugtrail.recordSelection', async () => {
    let text = '';
    const ed = vscode.window.activeTextEditor;
    if (ed && !ed.selection.isEmpty) text = ed.document.getText(ed.selection);
    if (!text && vscode.window.activeTerminal) {
      const before = await vscode.env.clipboard.readText();
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
      text = await vscode.env.clipboard.readText();
      if (text === before) text = '';
      await vscode.env.clipboard.writeText(before);
    }
    if (!text) text = (await vscode.window.showInputBox({ title: 'Paste the error message or stack trace' })) ?? '';
    if (!text.trim()) return;
    const n = capture(text, { source: 'manual', workspace: wsName(ed?.document.uri) }, text.split('\n')[0].slice(0, 200), true);
    if (n) vscode.window.showInformationMessage('BugTrail: error recorded.');
  });
  cmd('bugtrail.exportMarkdown', async () => {
    const md = ['# Debugging history', '', `_Exported ${new Date().toLocaleString()} — ${store.entries.length} bugs_`, '', ...store.entries.slice().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).map(e => store.toMarkdown(e).replace(/^# /, '## ') + '\n\n---\n')].join('\n');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc);
  });

  registerTool(context);
  tree.refresh();
}

// -------------------------------------------------------------------------------------------------
function capture(text: string, occ: { source: Source; workspace: string; command?: string }, fallbackMessage?: string, force = false): number {
  const ignore = cfg().get<string[]>('ignorePatterns', []).map(p => { try { return new RegExp(p, 'i'); } catch { return undefined; } }).filter(Boolean) as RegExp[];
  let errs = extractErrors(text, 2).filter(e => !ignore.some(r => r.test(e.raw) || r.test(e.message)));
  if (!errs.length && fallbackMessage && (force || occ.source !== 'terminal' || text.trim())) {
    // Unknown error format: still remember that this command failed (generic signature per command).
    const lastLine = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map(l => l.trim()).filter(Boolean).slice(-3).join(' ').slice(0, 200);
    errs = [{ type: occ.source === 'terminal' ? 'CommandFailed' : 'Error', message: force ? fallbackMessage : `${fallbackMessage}${lastLine ? ' — ' + lastLine : ''}`, signature: `${occ.source}failed: ${(occ.command ?? fallbackMessage).toLowerCase().slice(0, 120)}`, raw: text.slice(-1500) }];
  }
  for (const e of errs) handle(store.record(e, { at: new Date().toISOString(), ...occ }));
  return errs.length;
}

function handle(r: RecordResult) {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${r.isNew ? 'new' : r.recurred ? 'RECURRED' : 'seen again'}: ${r.entry.type}: ${r.entry.message}`);
  tree.refresh();
  if (!cfg().get<boolean>('notifyRecurring', true)) return;
  const prior = r.recurred ? r.entry.history[r.entry.history.length - 1] : r.similarResolved?.resolution ?? r.similarResolved?.history.at(-1);
  if (!prior) return;
  const where = r.recurred ? 'This bug is back' : `A similar bug (${r.similarResolved!.type}) was fixed before`;
  const how = prior.note ? `: "${prior.note}"` : prior.files.length ? ` by editing ${prior.files.slice(0, 3).join(', ')}` : '';
  vscode.window.showInformationMessage(`BugTrail: ${where} — fixed ${ago(prior.at)}${how}.`, 'Show History').then(c => {
    if (c) vscode.commands.executeCommand('bugtrail.showDetails', r.recurred ? r.entry : r.similarResolved);
  });
}

function autoResolve(workspace: string, source: Source, command: string) {
  if (!cfg().get<boolean>('autoResolve', true) || !command) return;
  const fixed = store.resolveBySuccess(workspace, source, command);
  if (!fixed.length) return;
  tree.refresh();
  for (const e of fixed) {
    vscode.window.showInformationMessage(`BugTrail: "${e.type}: ${e.message.slice(0, 60)}" looks fixed (${source} succeeded). Add a note for next time?`, 'Add Note').then(c => {
      if (c) vscode.commands.executeCommand('bugtrail.addNote', e);
    });
  }
}

// -------------------------------------------------------------------------------------------------
type Node = { kind: 'group' | 'bug' | 'info'; label: string; description?: string; tooltip?: string | vscode.MarkdownString; icon?: vscode.ThemeIcon; entry?: BugEntry; children?: () => Node[]; open?: { workspace: string; file: string; line?: number }; expanded?: boolean };

class Timeline implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh() {
    this.emitter.fire();
    const open = store.open().length;
    status.text = `$(bug) ${open} open`;
    status.tooltip = `BugTrail — ${open} open, ${store.entries.length - open} fixed bugs remembered`;
    if (open) status.show(); else status.hide();
  }

  getChildren(n?: Node): Node[] {
    if (n) return n.children?.() ?? [];
    const sorted = store.entries.slice().sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    const open = sorted.filter(e => e.status === 'open');
    const fixed = sorted.filter(e => e.status === 'resolved');
    if (!sorted.length) return [];
    const recurring = sorted.filter(e => e.history.length || e.count >= 3);
    const groups: Node[] = [
      { kind: 'group', label: 'Open', description: `${open.length}`, icon: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red')), expanded: true, children: () => open.map(bugNode) },
      { kind: 'group', label: 'Fixed', description: `${fixed.length}`, icon: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')), expanded: open.length === 0, children: () => fixed.slice(0, 200).map(bugNode) }
    ];
    if (recurring.length) groups.push({ kind: 'group', label: 'Recurring', description: `${recurring.length}`, icon: new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange')), children: () => recurring.map(bugNode) });
    return groups;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, n.children ? (n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    item.description = n.description; item.tooltip = n.tooltip; item.iconPath = n.icon;
    if (n.kind === 'bug' && n.entry) { item.contextValue = `bug.${n.entry.status}`; (item as any).entry = n.entry; }
    if (n.open) item.command = { command: 'bugtrail.openEvidence', title: 'Open', arguments: [n.open] };
    else if (n.kind === 'bug') item.command = { command: 'bugtrail.showDetails', title: 'Details', arguments: [n.entry] };
    return item;
  }
}

function bugNode(e: BugEntry): Node {
  const md = new vscode.MarkdownString(`**${e.type}**: ${e.message}\n\nSeen ${e.count}× · last ${ago(e.lastSeen)}${e.resolution ? `\n\n✅ Fixed ${ago(e.resolution.at)}${e.resolution.note ? ` — ${e.resolution.note}` : ''}` : ''}`);
  const ws = e.workspaces[0] ?? '';
  return {
    kind: 'bug', entry: e, label: `${e.type}: ${e.message}`.slice(0, 120), tooltip: md,
    description: `${e.count > 1 ? e.count + '× · ' : ''}${ago(e.lastSeen)}${e.workspaces.length > 1 ? ` · ${e.workspaces.length} projects` : ws ? ` · ${path.basename(ws)}` : ''}`,
    icon: new vscode.ThemeIcon(e.status === 'open' ? 'bug' : 'pass', new vscode.ThemeColor(e.status === 'open' ? 'charts.red' : 'charts.green')),
    children: () => {
      const kids: Node[] = [];
      if (e.resolution) kids.push({ kind: 'info', label: e.resolution.note ? `Fix: ${e.resolution.note}` : `Fixed ${e.resolution.how === 'auto' ? 'when `' + (e.resolution.command ?? '') + '` succeeded' : 'manually'}`, description: ago(e.resolution.at), icon: new vscode.ThemeIcon('check') });
      const files = e.resolution?.files ?? [...new Set(e.attempts.flatMap(a => a.files))];
      for (const f of files.slice(0, 15)) kids.push({ kind: 'info', label: f.split('/').pop()!, description: e.resolution ? 'changed in fix' : 'edited while debugging', icon: new vscode.ThemeIcon('edit'), open: { workspace: ws, file: f } });
      const loc = [...e.occurrences].reverse().find(o => o.location)?.location;
      if (loc) kids.push({ kind: 'info', label: `${loc.file.split(/[\\/]/).pop()}${loc.line ? ':' + loc.line : ''}`, description: 'where it was thrown', icon: new vscode.ThemeIcon('debug-stackframe'), open: { workspace: ws, file: loc.file, line: loc.line } });
      const last = e.occurrences[e.occurrences.length - 1];
      if (last?.command) kids.push({ kind: 'info', label: last.command.slice(0, 80), description: last.source, icon: new vscode.ThemeIcon(last.source === 'debug' ? 'debug' : last.source === 'task' ? 'tools' : 'terminal') });
      for (const note of e.notes.slice(-3)) kids.push({ kind: 'info', label: note.text, description: ago(note.at), icon: new vscode.ThemeIcon('note') });
      return kids;
    }
  };
}

// -------------------------------------------------------------------------------------------------
function registerTool(context: vscode.ExtensionContext) {
  if (!(vscode as any).lm?.registerTool) return;
  context.subscriptions.push(vscode.lm.registerTool<{ query: string }>('bugtrail_searchHistory', {
    prepareInvocation: o => ({ invocationMessage: `BugTrail: searching history for "${o.input.query.slice(0, 60)}"` }),
    async invoke(o) {
      const hits = store.search(o.input.query, 8);
      const text = hits.length ? hits.map(({ entry: e }) => [
        `- ${e.type}: ${e.message} — seen ${e.count}×, last ${new Date(e.lastSeen).toLocaleDateString()}, ${e.status}`,
        ...[e.resolution, ...e.history.slice().reverse()].filter(Boolean).slice(0, 3).map(fx => `  ${fx === e.resolution ? 'fixed' : 'previously fixed'} ${new Date(fx!.at).toLocaleDateString()}${fx!.note ? `: ${fx!.note}` : ''}${fx!.files.length ? `; files: ${fx!.files.join(', ')}` : ''}${fx!.command ? `; verified by \`${fx!.command}\`` : ''}`),
        ...e.notes.map(n => `  note: ${n.text}`)
      ].filter(Boolean).join('\n')).join('\n') : 'No matching bugs in the debugging history.';
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    }
  }));
}

export function deactivate(): void { /* disposables handle cleanup */ }
