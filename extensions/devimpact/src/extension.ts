import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  AffectedFile, ChangedFile, DiffBase, ImpactChange, ImpactResult, SymbolInfo,
  analyzeImpact, defaultBaseRef, getChanges, impactReportMarkdown, isGitRepository, symbolsAtLines
} from '@devsuite/core';
import { IndexService, fileLinker, openEvidence, runInTerminal, showMarkdown } from '@devsuite/vscode-common';

interface Scope { label: string; compute: () => Promise<ImpactChange[] | undefined> }

let service: IndexService;
let lastScope: Scope | undefined;
let lastResult: ImpactResult | undefined;
let tree: ImpactTree;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('DevImpact');
  service = new IndexService('DevImpact', 'devimpact', output);
  tree = new ImpactTree();
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  status.command = 'devimpact.openReport';
  const view = vscode.window.createTreeView('devimpact.impact', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(output, service, status, view);

  const cmd = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  const diffScope = (label: string, base: () => Promise<DiffBase | undefined>): Scope => ({
    label,
    compute: async () => {
      const idx = await service.ensureIndex();
      if (!idx) return undefined;
      if (!(await isGitRepository(idx.root))) { vscode.window.showWarningMessage('DevImpact: this folder is not a git repository. Use "What Does Changing This File Affect?" instead.'); return undefined; }
      const b = await base();
      if (!b) return undefined;
      const changes = await getChanges(idx.root, b);
      return changes.map(toImpactChange);
    }
  });

  cmd('devimpact.analyzeChanges', () => run(diffScope('Uncommitted changes', async () => ({ kind: 'working' }))));
  cmd('devimpact.analyzeStaged', () => run(diffScope('Staged changes', async () => ({ kind: 'staged' }))));
  cmd('devimpact.analyzeBranch', async () => {
    const idx = await service.ensureIndex();
    if (!idx) return;
    const configured = vscode.workspace.getConfiguration('devimpact').get<string>('baseRef', '');
    const detected = configured || (await defaultBaseRef(idx.root)) || 'main';
    const ref = await vscode.window.showInputBox({ prompt: 'Compare the current branch (and uncommitted work) against…', value: detected });
    if (!ref) return;
    await run(diffScope(`Branch vs ${ref}`, async () => ({ kind: 'ref', ref })));
  });
  cmd('devimpact.analyzeFile', async (uri?: vscode.Uri) => {
    await service.ensureIndex();
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    const rel = target && service.relativePath(target);
    if (!rel) { vscode.window.showWarningMessage('DevImpact: open a file from the workspace.'); return; }
    await run({ label: `File ${rel}`, compute: async () => [{ file: rel }] });
  });
  cmd('devimpact.analyzeSymbol', async (arg?: { file: string; symbol: string }) => {
    const idx = await service.ensureIndex();
    if (!idx) return;
    let file = arg?.file, symbol = arg?.symbol;
    if (!file) {
      const ed = vscode.window.activeTextEditor;
      file = ed && service.relativePath(ed.document.uri);
      const info = file ? idx.files.find(f => f.path === file) : undefined;
      if (!ed || !info) { vscode.window.showWarningMessage('DevImpact: put the cursor inside a function in a workspace file.'); return; }
      const s = symbolsAtLines(info, [ed.selection.active.line + 1])[0];
      if (!s) { return vscode.commands.executeCommand('devimpact.analyzeFile', ed.document.uri); }
      symbol = s.name;
    }
    await run({ label: `${symbol}() in ${file}`, compute: async () => [{ file: file!, symbols: [symbol!] }] });
  });
  cmd('devimpact.refresh', () => (lastScope ? run(lastScope) : vscode.commands.executeCommand('devimpact.analyzeChanges')));
  cmd('devimpact.openEvidence', (e: { file: string; line?: number }) => openEvidence(service, e));
  cmd('devimpact.openReport', async () => {
    if (!lastResult) { await vscode.commands.executeCommand('devimpact.analyzeChanges'); }
    if (lastResult) await showMarkdown(impactReportMarkdown(lastResult, `DevImpact — ${lastScope?.label ?? ''}`, fileLinker(service)));
  });
  cmd('devimpact.copyReport', async () => {
    if (!lastResult) return;
    await vscode.env.clipboard.writeText(impactReportMarkdown(lastResult, `Impact of ${lastScope?.label ?? 'changes'}`));
    vscode.window.showInformationMessage('DevImpact report copied — paste it into your pull request.');
  });
  cmd('devimpact.runTests', async () => {
    if (!lastResult) await vscode.commands.executeCommand('devimpact.analyzeChanges');
    const cmds = lastResult?.testCommands ?? [];
    if (!cmds.length) { vscode.window.showInformationMessage('DevImpact found no tests related to these changes.'); return; }
    const pick = cmds.length === 1 ? cmds[0] : (await vscode.window.showQuickPick(cmds.map(c => ({ label: c.label, detail: c.command, c })), { title: 'Run which tests?' }))?.c;
    if (pick) await runInTerminal('DevImpact tests', pick.command, service.folder?.uri.fsPath);
  });
  cmd('devimpact.runTestCommand', async (item: { testCommand?: { command: string } }) => {
    if (item?.testCommand) await runInTerminal('DevImpact tests', item.testCommand.command, service.folder?.uri.fsPath);
  });

  // CodeLens: "N files use this"
  const lens = new DependentsLens();
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lens));
  service.onDidChange(() => lens.refresh());

  // Re-run on save
  let t: NodeJS.Timeout | undefined;
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => {
    if (!lastScope || !vscode.workspace.getConfiguration('devimpact').get<boolean>('autoRefresh', true)) return;
    if (t) clearTimeout(t);
    t = setTimeout(() => void run(lastScope!, true), 4500);
  }));

  registerTool(context);

  if (vscode.workspace.workspaceFolders?.length) {
    void service.scan(vscode.workspace.workspaceFolders[0], true).then(async idx => {
      if (idx && (await isGitRepository(idx.root))) {
        lastScope = diffScope('Uncommitted changes', async () => ({ kind: 'working' }));
        await run(lastScope, true);
      }
    });
  }
}

function toImpactChange(c: ChangedFile): ImpactChange {
  const lines = c.status === 'deleted' ? undefined : [...c.addedLines.map(l => l.line), ...c.hunks.filter(h => h.newLines === 0).map(h => Math.max(1, h.newStart))];
  return { file: c.status === 'renamed' && c.oldPath ? c.oldPath : c.path, lines, status: c.status };
}

async function run(scope: Scope, silent = false): Promise<ImpactResult | undefined> {
  lastScope = scope;
  try {
    const changes = await scope.compute();
    if (!changes) return undefined;
    const idx = service.index!, graph = service.graph!;
    // ignore files the index doesn't know (binary, excluded) except deletions
    const known = changes.filter(c => c.status === 'deleted' || idx.files.some(f => f.path === c.file));
    lastResult = analyzeImpact(idx, graph, known, { maxDepth: vscode.workspace.getConfiguration('devimpact').get<number>('maxDepth', 6) });
    tree.set(scope.label, lastResult);
    const nonTest = lastResult.affected.filter(a => !a.isTest).length;
    status.text = `$(pulse) Impact: ${nonTest} file${nonTest === 1 ? '' : 's'}`;
    status.tooltip = `DevImpact — ${scope.label}\n${lastResult.summary}\nClick for the full report`;
    status.backgroundColor = lastResult.level === 'high' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (known.length) status.show(); else status.hide();
    if (!silent && !known.length) vscode.window.showInformationMessage(`DevImpact: no analysable changes in ${scope.label.toLowerCase()}.`);
    if (!silent && known.length) await vscode.commands.executeCommand('devimpact.impact.focus');
    return lastResult;
  } catch (e: any) {
    output.appendLine(`Analysis failed: ${e?.stack ?? e}`);
    if (!silent) vscode.window.showErrorMessage(`DevImpact: ${e?.message ?? e}`);
    return undefined;
  }
}

// -------------------------------------------------------------------------------------------------
type Node = { label: string; description?: string; tooltip?: string; icon?: vscode.ThemeIcon; children?: Node[]; open?: { file: string; line?: number }; testCommand?: { command: string }; expanded?: boolean; resource?: string };

class ImpactTree implements vscode.TreeDataProvider<Node> {
  private roots: Node[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  set(label: string, r: ImpactResult) {
    const conf = (a: AffectedFile) => a.confidence === 'high' ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'))
      : a.confidence === 'medium' ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.orange')) : new vscode.ThemeIcon('circle-outline');
    const levelColor = r.level === 'high' ? 'charts.red' : r.level === 'medium' ? 'charts.orange' : 'charts.green';
    const direct = r.affected.filter(a => a.distance === 1 && !a.isTest);
    const indirect = r.affected.filter(a => a.distance > 1 && !a.isTest);
    const byDist = new Map<number, AffectedFile[]>();
    for (const a of indirect) (byDist.get(a.distance) ?? byDist.set(a.distance, []).get(a.distance)!).push(a);
    const base = (f: string) => f.split('/').pop()!;
    const dir = (f: string) => f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';

    this.roots = [
      { label: `Impact ${r.level.toUpperCase()} · ${r.score}/100`, description: label, tooltip: r.summary, icon: new vscode.ThemeIcon('pulse', new vscode.ThemeColor(levelColor)) },
      {
        label: 'Changed', description: `${r.changes.length}`, icon: new vscode.ThemeIcon('diff'), expanded: r.changes.length <= 10,
        children: r.changes.map(c => ({
          label: base(c.file), description: `${dir(c.file)}${c.isHotspot ? ' · 🔥 core' : ''} · ${c.dependents} dependents`, resource: c.file,
          tooltip: `${c.file} (${c.status})${c.changedSymbols.length ? '\nChanged: ' + c.changedSymbols.map(s => s.name).join(', ') : ''}`,
          open: { file: c.file }, icon: new vscode.ThemeIcon(c.status === 'deleted' ? 'diff-removed' : c.status === 'added' ? 'diff-added' : 'diff-modified'),
          children: c.changedSymbols.length ? c.changedSymbols.map(s => ({ label: `${s.name}`, description: s.kind, icon: new vscode.ThemeIcon(symIcon(s)), open: { file: c.file, line: s.line } })) : undefined
        }))
      },
      {
        label: 'Directly affected', description: `${direct.length}`, icon: new vscode.ThemeIcon('arrow-left'), expanded: true,
        children: direct.map(a => ({
          label: base(a.file), description: a.usesSymbols.length ? `uses ${a.usesSymbols.join(', ')}` : `imports ${base(a.via)}`, resource: a.file,
          tooltip: `${a.file}\n${a.confidence} confidence — ${a.usesSymbols.length ? 'references ' + a.usesSymbols.join(', ') : 'imports ' + a.via}`,
          icon: conf(a), open: { file: a.file, line: a.line }
        }))
      },
      {
        label: 'Indirectly affected', description: `${indirect.length}`, icon: new vscode.ThemeIcon('type-hierarchy-sub'),
        children: [...byDist.entries()].sort((a, b) => a[0] - b[0]).map(([d, list]) => ({
          label: `${d} hops away`, description: `${list.length}`, icon: new vscode.ThemeIcon('debug-step-out'),
          children: list.map(a => ({ label: base(a.file), description: dir(a.file), tooltip: `${a.file}\nreached from ${a.via}`, open: { file: a.file }, resource: a.file }))
        }))
      },
      {
        label: 'Tests to run', description: `${r.tests.length}`, icon: new vscode.ThemeIcon('beaker'), expanded: true,
        children: [
          ...r.testCommands.map(c => ({ label: c.label, description: 'run ▶', tooltip: c.command, icon: new vscode.ThemeIcon('terminal'), testCommand: { command: c.command } })),
          ...r.tests.map(t => ({ label: base(t.file), description: t.reason, tooltip: t.file, open: { file: t.file }, icon: new vscode.ThemeIcon('beaker') })),
          ...(r.tests.length ? [] : [{ label: 'No related tests found', description: 'consider adding one', icon: new vscode.ThemeIcon('warning') }])
        ]
      }
    ];
    this.emitter.fire();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, n.children?.length ? (n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    item.description = n.description;
    item.tooltip = n.tooltip;
    item.iconPath = n.icon;
    if (n.resource && !n.icon) item.resourceUri = service.uriOf(n.resource);
    if (n.open) item.command = { command: 'devimpact.openEvidence', title: 'Open', arguments: [n.open] };
    if (n.testCommand) { item.contextValue = 'testCommand'; (item as any).testCommand = n.testCommand; item.command = { command: 'devimpact.runTestCommand', title: 'Run', arguments: [n] }; }
    return item;
  }
  getChildren(n?: Node): Node[] { return n ? n.children ?? [] : this.roots; }
}

function symIcon(s: SymbolInfo) {
  return s.kind === 'class' ? 'symbol-class' : s.kind === 'interface' ? 'symbol-interface' : s.kind === 'method' ? 'symbol-method' : 'symbol-function';
}

// -------------------------------------------------------------------------------------------------
class DependentsLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private cache = new Map<string, Map<string, number>>();
  refresh() { this.cache.clear(); this.emitter.fire(); }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('devimpact').get<boolean>('codeLens', true)) return [];
    const idx = service.index, graph = service.graph;
    const rel = service.relativePath(doc.uri);
    const info = rel && idx?.files.find(f => f.path === rel);
    if (!info || !graph) return [];
    const deps = [...new Set(graph.dependentsOf(info.path).map(e => e.from))];
    if (!deps.length) return [];
    let counts = this.cache.get(info.path);
    if (!counts) {
      counts = new Map();
      const texts = deps.map(d => { try { return fs.readFileSync(path.join(idx!.root, d), 'utf8'); } catch { return ''; } });
      for (const s of info.symbols) {
        if (!['function', 'class', 'method', 'procedure', 'interface'].includes(s.kind) || s.name.length < 3) continue;
        const re = new RegExp(`\\b${s.name.replace(/\$/g, '\\$')}\\b`, info.language.startsWith('rpg') || info.language === 'cl' ? 'i' : '');
        counts.set(`${s.name}@${s.line}`, texts.filter(t => re.test(t)).length);
      }
      this.cache.set(info.path, counts);
    }
    const lenses: vscode.CodeLens[] = [];
    for (const s of info.symbols) {
      const n = counts.get(`${s.name}@${s.line}`);
      if (!n || s.line > doc.lineCount) continue;
      const range = new vscode.Range(s.line - 1, 0, s.line - 1, 0);
      lenses.push(new vscode.CodeLens(range, { title: `$(pulse) ${n} ${n === 1 ? "file uses" : "files use"} this`, command: 'devimpact.analyzeSymbol', arguments: [{ file: info.path, symbol: s.name }], tooltip: 'DevImpact: show what changing this affects' }));
    }
    return lenses;
  }
}

// -------------------------------------------------------------------------------------------------
function registerTool(context: vscode.ExtensionContext) {
  if (!(vscode as any).lm?.registerTool) return;
  context.subscriptions.push(vscode.lm.registerTool<{ scope?: string; file?: string; symbol?: string }>('devimpact_analyzeChanges', {
    prepareInvocation: o => ({ invocationMessage: `DevImpact: analysing ${o.input.scope ?? 'working'} changes${o.input.file ? ' in ' + o.input.file : ''}` }),
    async invoke(o) {
      const idx = await service.ensureIndex();
      const txt = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
      if (!idx) return txt('No workspace folder is open.');
      let changes: ImpactChange[];
      const scope = o.input.scope ?? 'working';
      if (scope === 'file') {
        if (!o.input.file) return txt('Provide "file" when scope is "file".');
        changes = [{ file: o.input.file.replace(/\\/g, '/').replace(/^\.?\//, ''), symbols: o.input.symbol ? [o.input.symbol] : undefined }];
      } else {
        if (!(await isGitRepository(idx.root))) return txt('The workspace is not a git repository; use scope "file".');
        const base: DiffBase = scope === 'staged' ? { kind: 'staged' } : scope === 'branch' ? { kind: 'ref', ref: vscode.workspace.getConfiguration('devimpact').get<string>('baseRef', '') || (await defaultBaseRef(idx.root)) || 'main' } : { kind: 'working' };
        changes = (await getChanges(idx.root, base)).map(toImpactChange);
      }
      const r = analyzeImpact(idx, service.graph!, changes);
      return txt(impactReportMarkdown(r, `Impact of ${scope} changes`));
    }
  }));
}

export function deactivate(): void { /* disposables handle cleanup */ }
