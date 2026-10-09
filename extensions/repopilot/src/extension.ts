import * as vscode from 'vscode';
import { BuildCommand, Evidence, generateOnboardingGuide } from '@devsuite/core';
import { IndexService } from './indexService';
import { OverviewTree } from './treeView';
import { MapPanel } from './mapPanel';
import { askCommand, registerChat, registerTools } from './ai';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('RepoPilot');
  const service = new IndexService(output);
  const tree = new OverviewTree(service);
  context.subscriptions.push(output, service, vscode.window.registerTreeDataProvider('repopilot.overview', tree));

  const cmd = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('repopilot.scan', async () => {
    const idx = await service.scan(await service.pickFolder());
    if (idx) {
      const choice = await vscode.window.showInformationMessage(
        `RepoPilot indexed ${idx.files.length.toLocaleString()} files: ${idx.entryPoints.length} entry points, ${idx.modules.length} modules, ${idx.edges.length.toLocaleString()} dependencies.`,
        'Open Guide', 'Show Map'
      );
      if (choice === 'Open Guide') vscode.commands.executeCommand('repopilot.openGuide');
      if (choice === 'Show Map') vscode.commands.executeCommand('repopilot.showMap');
    }
  });

  cmd('repopilot.openEvidence', async (e: Evidence) => {
    const uri = e && service.uriOf(e.file);
    if (!uri) return;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = Math.max(0, (e.line ?? 1) - 1);
      const range = new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(doc, { selection: range, preview: true });
    } catch {
      vscode.commands.executeCommand('vscode.open', uri);
    }
  });

  cmd('repopilot.openGuide', async () => {
    const idx = await service.ensureIndex();
    if (!idx || !service.folder) return;
    const where = vscode.workspace.getConfiguration('repopilot').get<string>('guideLocation', 'workspace');
    if (where === 'untitled') {
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: generateOnboardingGuide(idx) });
      await vscode.window.showTextDocument(doc);
      return;
    }
    const dir = vscode.Uri.joinPath(service.folder.uri, '.repopilot');
    const file = vscode.Uri.joinPath(dir, 'ONBOARDING.md');
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(file, Buffer.from(generateOnboardingGuide(idx, { linkPrefix: '../' }), 'utf8'));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, '.gitignore'), Buffer.from('*\n', 'utf8'));
    await vscode.commands.executeCommand('markdown.showPreview', file);
  });

  cmd('repopilot.showMap', async (uri?: vscode.Uri) => {
    const idx = await service.ensureIndex();
    if (!idx) return;
    MapPanel.show(context, service, uri ? service.relativePath(uri) : undefined);
  });

  cmd('repopilot.ask', () => askCommand(service));

  const relOf = async (uri?: vscode.Uri) => {
    await service.ensureIndex();
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    const rel = target && service.relativePath(target);
    if (!rel || !service.index?.files.some(f => f.path === rel)) {
      vscode.window.showWarningMessage('RepoPilot: open a file that belongs to the indexed workspace.');
      return undefined;
    }
    return rel;
  };

  cmd('repopilot.showDependents', async (uri?: vscode.Uri) => {
    const rel = await relOf(uri);
    if (!rel) return;
    const g = service.graph!;
    const idx = service.index!;
    const all = g.transitiveDependents(rel);
    const direct = g.dependentsOf(rel);
    type Item = vscode.QuickPickItem & { ev?: Evidence };
    const items: Item[] = [];
    items.push({ label: 'Direct dependents', kind: vscode.QuickPickItemKind.Separator });
    for (const e of direct) items.push({ label: `$(arrow-left) ${e.from}`, description: `${e.kind} · line ${e.line}`, detail: e.specifier, ev: { file: e.from, line: e.line } });
    const indirect = [...all.entries()].filter(([, d]) => d > 1).sort((a, b) => a[1] - b[1]);
    if (indirect.length) {
      items.push({ label: 'Indirect dependents', kind: vscode.QuickPickItemKind.Separator });
      for (const [f, d] of indirect.slice(0, 500)) items.push({ label: `$(debug-step-back) ${f}`, description: `distance ${d}`, ev: { file: f } });
    }
    const tests = [...all.keys()].filter(f => idx.files.find(x => x.path === f)?.isTest);
    if (tests.length) {
      items.push({ label: 'Tests to run', kind: vscode.QuickPickItemKind.Separator });
      for (const t of tests) items.push({ label: `$(beaker) ${t}`, ev: { file: t } });
    }
    if (!direct.length) items.push({ label: '$(info) Nothing in this repository depends on this file', description: 'It may be an entry point, unused, or referenced dynamically' });
    const pick = await vscode.window.showQuickPick(items, {
      title: `Who uses ${rel}? — ${direct.length} direct, ${all.size} total${tests.length ? `, ${tests.length} tests` : ''}`,
      matchOnDescription: true
    });
    if (pick?.ev) vscode.commands.executeCommand('repopilot.openEvidence', pick.ev);
  });

  cmd('repopilot.showDependencies', async (uri?: vscode.Uri) => {
    const rel = await relOf(uri);
    if (!rel) return;
    const deps = service.graph!.dependenciesOf(rel);
    const pick = await vscode.window.showQuickPick(
      deps.map(e => ({ label: e.to, description: `${e.kind} · line ${e.line}`, detail: e.specifier, ev: { file: e.to } as Evidence })),
      { title: `${rel} uses ${deps.length} internal files`, placeHolder: deps.length ? undefined : 'No internal dependencies' }
    );
    if (pick) vscode.commands.executeCommand('repopilot.openEvidence', pick.ev);
  });

  cmd('repopilot.runBuildCommand', async (item: { buildCommand?: BuildCommand } | BuildCommand) => {
    const c: BuildCommand | undefined = (item as any)?.buildCommand ?? (item as BuildCommand);
    if (!c?.command || !service.folder) return;
    const ok = await vscode.window.showWarningMessage(`Run "${c.command}" in ${c.cwd || 'the workspace root'}?`, { modal: true }, 'Run');
    if (ok !== 'Run') return;
    const term = vscode.window.createTerminal({ name: `RepoPilot: ${c.command}`, cwd: service.uriOf(c.cwd || '.')?.fsPath ?? service.folder.uri.fsPath });
    term.show();
    term.sendText(c.command);
  });

  cmd('repopilot.exportIndex', async () => {
    const idx = await service.ensureIndex();
    if (!idx || !service.folder) return;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(service.folder.uri, '.repopilot', 'index.json'),
      filters: { JSON: ['json'] }
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(idx, null, 2), 'utf8'));
    vscode.window.showInformationMessage(`RepoPilot index exported to ${vscode.workspace.asRelativePath(target)}`);
  });

  registerChat(context, service);
  registerTools(context, service);

  if (vscode.workspace.workspaceFolders?.length && vscode.workspace.getConfiguration('repopilot').get<boolean>('scanOnStartup', true)) {
    void service.scan(vscode.workspace.workspaceFolders[0], true);
  }
}

export function deactivate(): void { /* disposables handle cleanup */ }
