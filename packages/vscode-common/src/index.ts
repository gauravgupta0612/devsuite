import * as path from 'path';
import * as vscode from 'vscode';
import { DependencyGraph, Evidence, RepoIndex, graphOf, indexRepository } from '@devsuite/core';

/**
 * Owns a repository index for one extension and keeps it fresh (debounced rescans on save/create/delete).
 * Every DevSuite extension gets its own instance so they can be installed independently.
 */
export class IndexService implements vscode.Disposable {
  private _index: RepoIndex | undefined;
  private _graph: DependencyGraph | undefined;
  private _folder: vscode.WorkspaceFolder | undefined;
  private scanning: Promise<RepoIndex | undefined> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<RepoIndex>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly name: string, private readonly configSection: string, private readonly output: vscode.OutputChannel) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const touch = (uri: vscode.Uri) => {
      if (/[\\/](node_modules|\.git|dist|out|build|target|\.repopilot)[\\/]/.test(uri.fsPath)) return;
      if (!this._index) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.scan(this._folder, true), 3000);
    };
    watcher.onDidCreate(touch); watcher.onDidDelete(touch);
    this.disposables.push(watcher, this.emitter, vscode.workspace.onDidSaveTextDocument(d => touch(d.uri)));
  }

  get index() { return this._index; }
  get graph() { return this._graph; }
  get folder() { return this._folder; }

  async ensureIndex(): Promise<RepoIndex | undefined> { return this._index ?? this.scan(); }

  async pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) return folders[0];
    const ed = vscode.window.activeTextEditor;
    const active = ed && vscode.workspace.getWorkspaceFolder(ed.document.uri);
    return active ?? vscode.window.showWorkspaceFolderPick({ placeHolder: `Which folder should ${this.name} analyse?` });
  }

  scan(folder?: vscode.WorkspaceFolder, silent = false): Promise<RepoIndex | undefined> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan(folder, silent).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  private async doScan(folder: vscode.WorkspaceFolder | undefined, silent: boolean): Promise<RepoIndex | undefined> {
    folder ??= this._folder ?? (await this.pickFolder());
    if (!folder || folder.uri.scheme !== 'file') {
      if (!silent) vscode.window.showInformationMessage(`${this.name}: open a local folder first.`);
      return undefined;
    }
    const cfg = vscode.workspace.getConfiguration(this.configSection);
    const run = (p?: vscode.Progress<{ message?: string }>, t?: vscode.CancellationToken) => indexRepository(folder!.uri.fsPath, {
      exclude: cfg.get<string[]>('exclude', []),
      maxFiles: cfg.get<number>('maxFiles', 20000),
      onProgress: (n, cur) => p?.report({ message: `${n} files — ${cur}` }),
      isCancelled: () => !!t?.isCancellationRequested
    });
    try {
      const idx = silent ? await run() : await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `${this.name}: indexing`, cancellable: false }, p => run(p));
      this._index = idx; this._graph = graphOf(idx); this._folder = folder;
      this.output.appendLine(`[${new Date().toLocaleTimeString()}] Indexed ${idx.files.length} files, ${idx.edges.length} dependencies in ${idx.durationMs} ms`);
      this.emitter.fire(idx);
      return idx;
    } catch (e: any) {
      this.output.appendLine(`Index failed: ${e?.stack ?? e}`);
      if (!silent) vscode.window.showErrorMessage(`${this.name}: indexing failed — ${e?.message ?? e}`);
      return undefined;
    }
  }

  relativePath(uri: vscode.Uri): string | undefined {
    if (!this._folder) return undefined;
    const base = path.normalize(this._folder.uri.fsPath).replace(/[\\/]+$/, '');
    const full = path.normalize(uri.fsPath);
    if (!full.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return undefined;
    return full.slice(base.length + 1).split(path.sep).join('/');
  }

  uriOf(rel: string): vscode.Uri | undefined {
    return this._folder ? vscode.Uri.joinPath(this._folder.uri, ...rel.split('/').filter(Boolean)) : undefined;
  }

  dispose() { if (this.timer) clearTimeout(this.timer); this.disposables.forEach(d => d.dispose()); }
}

/** Open a repo-relative file at a 1-based line. */
export async function openEvidence(service: IndexService, e: Evidence | undefined): Promise<void> {
  const uri = e && service.uriOf(e.file);
  if (!uri) return;
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = Math.max(0, Math.min(doc.lineCount - 1, (e!.line ?? 1) - 1));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true });
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri);
  }
}

/** Show markdown in a preview tab (no file written). */
export async function showMarkdown(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
}

/** Markdown link to a workspace file that works from an untitled preview. */
export function fileLinker(service: IndexService) {
  return (file: string, line?: number) => {
    const uri = service.uriOf(file);
    return uri ? `[${file}${line ? ':' + line : ''}](${uri.toString()}${line ? `#L${line}` : ''})` : `\`${file}\``;
  };
}

/** Ask, then run a shell command in a named terminal. */
export async function runInTerminal(name: string, command: string, cwd: string | undefined, confirm = true): Promise<void> {
  if (confirm) {
    const ok = await vscode.window.showWarningMessage(`Run "${command.length > 120 ? command.slice(0, 117) + '…' : command}"?`, { modal: true }, 'Run');
    if (ok !== 'Run') return;
  }
  const t = vscode.window.terminals.find(x => x.name === name) ?? vscode.window.createTerminal({ name, cwd });
  t.show();
  t.sendText(command);
}

export function relativeTime(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
