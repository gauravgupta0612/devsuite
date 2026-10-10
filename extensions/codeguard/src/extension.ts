import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DiffBase, RiskFinding, RiskReport, Severity, assessRisk, defaultBaseRef, getChanges, getChurn, isGitRepository, riskReportMarkdown } from '@devsuite/core';
import { IndexService, fileLinker, openEvidence, showMarkdown } from '@devsuite/vscode-common';

let service: IndexService;
let output: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
let tree: RiskTree;
let last: { report: RiskReport; label: string; base: DiffBase } | undefined;

const HOOK_MARK = '# installed by CodeGuard';

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('CodeGuard');
  service = new IndexService('CodeGuard', 'codeguard', output);
  diagnostics = vscode.languages.createDiagnosticCollection('codeguard');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 48);
  status.command = 'codeguard.openReport';
  tree = new RiskTree();
  context.subscriptions.push(output, service, diagnostics, status, vscode.window.createTreeView('codeguard.report', { treeDataProvider: tree, showCollapseAll: true }));
  const cmd = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('codeguard.scanStaged', () => scan({ kind: 'staged' }, 'Staged changes'));
  cmd('codeguard.scanWorking', () => scan({ kind: 'working' }, 'Uncommitted changes'));
  cmd('codeguard.scanBranch', async () => {
    const idx = await service.ensureIndex();
    if (!idx) return;
    const ref = await vscode.window.showInputBox({ prompt: 'Compare the current branch against…', value: (await defaultBaseRef(idx.root)) ?? 'main' });
    if (ref) await scan({ kind: 'ref', ref }, `Branch vs ${ref}`);
  });
  cmd('codeguard.openEvidence', (e: { file: string; line?: number }) => openEvidence(service, e));
  cmd('codeguard.openReport', async () => {
    if (!last) await scan({ kind: 'staged' }, 'Staged changes');
    if (last) await showMarkdown(riskReportMarkdown(last.report, `CodeGuard — ${last.label}`, fileLinker(service)));
  });
  cmd('codeguard.copyReport', async () => {
    if (!last) return;
    await vscode.env.clipboard.writeText(riskReportMarkdown(last.report, `CodeGuard — ${last.label}`));
    vscode.window.showInformationMessage('CodeGuard report copied to the clipboard.');
  });
  cmd('codeguard.clear', () => { diagnostics.clear(); last = undefined; tree.set(undefined); status.hide(); });
  cmd('codeguard.installHook', () => installHook(context));
  cmd('codeguard.uninstallHook', () => uninstallHook());

  // Auto-scan when the git index changes (files staged/unstaged) or files are saved.
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (!vscode.workspace.getConfiguration('codeguard').get<boolean>('autoScan', true)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void scan(last?.base ?? { kind: 'staged' }, last?.label ?? 'Staged changes', true), 2500);
  };
  const gitIndex = vscode.workspace.createFileSystemWatcher('**/.git/index');
  gitIndex.onDidChange(schedule); gitIndex.onDidCreate(schedule);
  context.subscriptions.push(gitIndex, vscode.workspace.onDidSaveTextDocument(schedule));

  registerTool(context);
  if (vscode.workspace.workspaceFolders?.length) {
    void service.scan(vscode.workspace.workspaceFolders[0], true).then(async idx => {
      if (idx && (await isGitRepository(idx.root))) await scan({ kind: 'staged' }, 'Staged changes', true, true);
    });
  }
}

async function compute(base: DiffBase): Promise<RiskReport | undefined> {
  const idx = await service.ensureIndex();
  if (!idx) return undefined;
  if (!(await isGitRepository(idx.root))) throw new Error('this folder is not a git repository');
  const changes = await getChanges(idx.root, base);
  const churn = await getChurn(idx.root).catch(() => undefined);
  return assessRisk(changes, { index: idx, graph: service.graph, churn, disabledRules: vscode.workspace.getConfiguration('codeguard').get<string[]>('disabledRules', []) });
}

async function scan(base: DiffBase, label: string, silent = false, fallbackToWorking = false): Promise<void> {
  try {
    let report = await compute(base);
    if (!report) return;
    if (!report.files.length && base.kind === 'staged' && !silent) {
      const pick = await vscode.window.showInformationMessage('CodeGuard: nothing is staged. Scan all uncommitted changes instead?', 'Scan uncommitted changes');
      if (pick) return scan({ kind: 'working' }, 'Uncommitted changes');
    }
    if (!report.files.length && fallbackToWorking && base.kind === 'staged') {
      const w = await compute({ kind: 'working' });
      if (w?.files.length) { report = w; base = { kind: 'working' }; label = 'Uncommitted changes'; }
    }
    last = { report, label, base };
    tree.set(last);
    publishDiagnostics(report);
    updateStatus(report, label);
    if (!silent) {
      await vscode.commands.executeCommand('codeguard.report.focus');
      if (report.counts.critical) vscode.window.showErrorMessage(`CodeGuard: ${report.counts.critical} critical risk(s) in ${label.toLowerCase()} — ${report.findings[0].title}.`, 'Open Report').then(c => c && vscode.commands.executeCommand('codeguard.openReport'));
    }
  } catch (e: any) {
    output.appendLine(`Scan failed: ${e?.stack ?? e}`);
    if (!silent) vscode.window.showWarningMessage(`CodeGuard: ${e?.message ?? e}`);
  }
}

function updateStatus(r: RiskReport, label: string) {
  if (!r.files.length) { status.hide(); return; }
  const icon = r.level === 'critical' ? '$(error)' : r.level === 'high' ? '$(warning)' : '$(shield)';
  status.text = `${icon} Risk: ${r.level.toUpperCase()}`;
  status.tooltip = `CodeGuard — ${label}\n${r.summary}\nClick for the full report`;
  status.backgroundColor = r.level === 'critical' ? new vscode.ThemeColor('statusBarItem.errorBackground') : r.level === 'high' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  status.show();
}

function publishDiagnostics(r: RiskReport) {
  diagnostics.clear();
  if (!vscode.workspace.getConfiguration('codeguard').get<boolean>('showDiagnostics', true)) return;
  const sev: Record<Severity, vscode.DiagnosticSeverity> = {
    critical: vscode.DiagnosticSeverity.Error, high: vscode.DiagnosticSeverity.Warning, medium: vscode.DiagnosticSeverity.Warning,
    low: vscode.DiagnosticSeverity.Information, info: vscode.DiagnosticSeverity.Hint
  };
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const f of r.findings) {
    if (!f.file) continue;
    const line = Math.max(0, (f.line ?? 1) - 1);
    const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000), `${f.title}: ${f.detail}`, sev[f.severity]);
    d.source = 'CodeGuard'; d.code = f.id;
    (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(d);
  }
  for (const [file, list] of byFile) { const uri = service.uriOf(file); if (uri) diagnostics.set(uri, list); }
}

// -------------------------------------------------------------------------------------------------
type Node = { label: string; description?: string; tooltip?: string | vscode.MarkdownString; icon?: vscode.ThemeIcon; children?: Node[]; open?: { file: string; line?: number }; expanded?: boolean };
const SEV_ICON: Record<Severity, vscode.ThemeIcon> = {
  critical: new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground')),
  high: new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red')),
  medium: new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange')),
  low: new vscode.ThemeIcon('info', new vscode.ThemeColor('charts.yellow')),
  info: new vscode.ThemeIcon('lightbulb')
};

class RiskTree implements vscode.TreeDataProvider<Node> {
  private roots: Node[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  set(l: typeof last) {
    if (!l) { this.roots = []; this.emitter.fire(); return; }
    const r = l.report;
    const findingNode = (f: RiskFinding): Node => {
      const md = new vscode.MarkdownString(`**${f.title}**\n\n${f.detail}${f.evidence ? `\n\n\`${f.evidence.replace(/`/g, "'")}\`` : ''}`);
      return { label: f.title, description: f.file ? `${f.file.split('/').pop()}${f.line ? ':' + f.line : ''}` : '', tooltip: md, icon: SEV_ICON[f.severity], open: f.file ? { file: f.file, line: f.line } : undefined };
    };
    const levelIcon = r.level === 'critical' || r.level === 'high' ? SEV_ICON.high : r.level === 'medium' ? SEV_ICON.medium : new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    this.roots = [{ label: `Risk ${r.level.toUpperCase()} · ${r.score}/100`, description: l.label, tooltip: r.summary, icon: levelIcon }];
    if (!r.files.length) this.roots.push({ label: 'No changes to review', icon: new vscode.ThemeIcon('check') });
    else if (!r.findings.length) this.roots.push({ label: 'No risks found', description: 'looks good to commit', icon: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')) });
    for (const s of ['critical', 'high', 'medium', 'low', 'info'] as Severity[]) {
      const fs = r.findings.filter(f => f.severity === s);
      if (fs.length) this.roots.push({ label: s[0].toUpperCase() + s.slice(1), description: `${fs.length}`, icon: SEV_ICON[s], expanded: s !== 'info' && s !== 'low', children: fs.map(findingNode) });
    }
    if (r.files.length) this.roots.push({
      label: 'Files by risk', description: `${r.files.length}`, icon: new vscode.ThemeIcon('files'),
      children: r.files.map(f => ({ label: f.file.split('/').pop()!, description: `score ${f.score} · +${f.added}/−${f.deleted} · ${f.dependents} dependents`, tooltip: f.file, open: f.status === 'deleted' ? undefined : { file: f.file }, icon: new vscode.ThemeIcon(f.status === 'deleted' ? 'diff-removed' : f.status === 'added' ? 'diff-added' : 'diff-modified') }))
    });
    this.emitter.fire();
  }
  getTreeItem(n: Node) {
    const item = new vscode.TreeItem(n.label, n.children?.length ? (n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    item.description = n.description; item.tooltip = n.tooltip; item.iconPath = n.icon;
    if (n.open) item.command = { command: 'codeguard.openEvidence', title: 'Open', arguments: [n.open] };
    return item;
  }
  getChildren(n?: Node) { return n ? n.children ?? [] : this.roots; }
}

// -------------------------------------------------------------------------------------------------
async function gitDir(): Promise<string | undefined> {
  const idx = await service.ensureIndex();
  if (!idx) return undefined;
  let dir = idx.root;
  for (let i = 0; i < 20; i++) {
    const g = path.join(dir, '.git');
    if (fs.existsSync(g)) {
      if (fs.statSync(g).isDirectory()) return g;
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));  // worktrees / submodules
      if (m) return path.resolve(dir, m[1].trim());
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function installHook(context: vscode.ExtensionContext) {
  const g = await gitDir();
  if (!g) { vscode.window.showWarningMessage('CodeGuard: no .git folder found for this workspace.'); return; }
  const hooks = path.join(g, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  const hook = path.join(hooks, 'pre-commit');
  if (fs.existsSync(hook) && !fs.readFileSync(hook, 'utf8').includes(HOOK_MARK)) {
    const ok = await vscode.window.showWarningMessage('A pre-commit hook already exists (perhaps Husky or another tool). Add CodeGuard to the end of it?', { modal: true }, 'Append');
    if (ok !== 'Append') return;
  }
  const failOn = vscode.workspace.getConfiguration('codeguard').get<string>('hookFailOn', 'critical');
  const disabled = vscode.workspace.getConfiguration('codeguard').get<string[]>('disabledRules', []);
  const relRoot = path.relative(path.dirname(g), service.index!.root).split(path.sep).join('/') || '.';
  fs.copyFileSync(path.join(context.extensionPath, 'dist', 'cli.js'), path.join(hooks, 'codeguard-cli.js'));
  const block = [
    HOOK_MARK,
    `node "$(git rev-parse --git-path hooks)/codeguard-cli.js" --staged --cwd "${relRoot}" --fail-on ${failOn}${disabled.length ? ` --disable ${disabled.join(',')}` : ''} || exit 1`,
    '# end CodeGuard', ''
  ].join('\n');
  let content = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : '#!/bin/sh\n';
  content = content.replace(new RegExp(`${HOOK_MARK}[\\s\\S]*?# end CodeGuard\\n?`), '');
  if (!content.endsWith('\n')) content += '\n';
  fs.writeFileSync(hook, content + block, { mode: 0o755 });
  try { fs.chmodSync(hook, 0o755); } catch { /* windows */ }
  vscode.window.showInformationMessage(`CodeGuard pre-commit hook installed — commits are blocked at "${failOn}" risk. Bypass once with git commit --no-verify.`);
}

async function uninstallHook() {
  const g = await gitDir();
  const hook = g && path.join(g, 'hooks', 'pre-commit');
  if (!hook || !fs.existsSync(hook)) { vscode.window.showInformationMessage('CodeGuard: no pre-commit hook installed.'); return; }
  const content = fs.readFileSync(hook, 'utf8').replace(new RegExp(`${HOOK_MARK}[\\s\\S]*?# end CodeGuard\\n?`), '');
  if (content.trim() === '#!/bin/sh') fs.unlinkSync(hook); else fs.writeFileSync(hook, content);
  try { fs.unlinkSync(path.join(g!, 'hooks', 'codeguard-cli.js')); } catch { /* already gone */ }
  vscode.window.showInformationMessage('CodeGuard pre-commit hook removed.');
}

// -------------------------------------------------------------------------------------------------
function registerTool(context: vscode.ExtensionContext) {
  if (!(vscode as any).lm?.registerTool) return;
  context.subscriptions.push(vscode.lm.registerTool<{ scope?: string }>('codeguard_reviewChanges', {
    prepareInvocation: o => ({ invocationMessage: `CodeGuard: scanning ${o.input.scope ?? 'staged'} changes` }),
    async invoke(o) {
      const txt = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
      try {
        const idx = await service.ensureIndex();
        if (!idx) return txt('No workspace folder is open.');
        const scope = o.input.scope ?? 'staged';
        const base: DiffBase = scope === 'working' ? { kind: 'working' } : scope === 'branch' ? { kind: 'ref', ref: (await defaultBaseRef(idx.root)) ?? 'main' } : { kind: 'staged' };
        const r = await compute(base);
        return txt(r ? riskReportMarkdown(r, `CodeGuard — ${scope} changes`) : 'Nothing to scan.');
      } catch (e: any) { return txt(`CodeGuard could not scan: ${e?.message ?? e}`); }
    }
  }));
}

export function deactivate(): void { /* disposables handle cleanup */ }
