import * as path from 'path';
import * as vscode from 'vscode';
import { DependencyGraph, RepoIndex, graphOf, indexRepository } from '@devsuite/core';

/** Owns the current repository index and keeps it fresh. */
export class IndexService implements vscode.Disposable {
  private _index: RepoIndex | undefined;
  private _graph: DependencyGraph | undefined;
  private _folder: vscode.WorkspaceFolder | undefined;
  private scanning: Promise<RepoIndex | undefined> | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<RepoIndex | undefined>();
  readonly onDidChange = this.emitter.event;
  private readonly status: vscode.StatusBarItem;

  constructor(private readonly output: vscode.OutputChannel) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'repopilot.openGuide';
    this.disposables.push(this.status, this.emitter);

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onFsChange = (uri: vscode.Uri) => {
      if (/[\\/](node_modules|\.git|dist|out|build|target|\.repopilot)[\\/]/.test(uri.fsPath)) return;
      this.scheduleRescan();
    };
    watcher.onDidCreate(onFsChange);
    watcher.onDidDelete(onFsChange);
    this.disposables.push(watcher, vscode.workspace.onDidSaveTextDocument(d => onFsChange(d.uri)));
  }

  get index(): RepoIndex | undefined { return this._index; }
  get graph(): DependencyGraph | undefined { return this._graph; }
  get folder(): vscode.WorkspaceFolder | undefined { return this._folder; }

  /** Return the index, scanning first if needed. */
  async ensureIndex(): Promise<RepoIndex | undefined> {
    return this._index ?? this.scan();
  }

  async pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) return folders[0];
    const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    if (active) return active;
    return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which folder should RepoPilot analyse?' });
  }

  scan(folder?: vscode.WorkspaceFolder, silent = false): Promise<RepoIndex | undefined> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan(folder, silent).finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  private async doScan(folder: vscode.WorkspaceFolder | undefined, silent: boolean): Promise<RepoIndex | undefined> {
    folder ??= this._folder ?? (await this.pickFolder());
    if (!folder) {
      if (!silent) vscode.window.showInformationMessage('RepoPilot: open a folder to scan.');
      return undefined;
    }
    if (folder.uri.scheme !== 'file') {
      vscode.window.showWarningMessage('RepoPilot currently analyses local folders only.');
      return undefined;
    }
    const cfg = vscode.workspace.getConfiguration('repopilot');
    this.status.text = '$(sync~spin) RepoPilot: scanning…';
    this.status.show();

    const run = async (progress?: vscode.Progress<{ message?: string }>, token?: vscode.CancellationToken) => {
      const idx = await indexRepository(folder!.uri.fsPath, {
        exclude: cfg.get<string[]>('exclude', []),
        maxFiles: cfg.get<number>('maxFiles', 20000),
        onProgress: (n, cur) => progress?.report({ message: `${n} files — ${cur}` }),
        isCancelled: () => !!token?.isCancellationRequested
      });
      return idx;
    };

    try {
      const idx = silent
        ? await run()
        : await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `RepoPilot: indexing ${folder.name}`, cancellable: true },
            (p, t) => run(p, t)
          );
      this._index = idx;
      this._graph = graphOf(idx);
      this._folder = folder;
      const lines = idx.files.reduce((s, f) => s + f.lines, 0);
      this.output.appendLine(`[${new Date().toLocaleTimeString()}] Indexed ${idx.files.length} files, ${lines} lines, ${idx.edges.length} dependencies in ${idx.durationMs} ms (${folder.uri.fsPath})`);
      this.status.text = `$(compass) ${idx.files.length.toLocaleString()} files · ${idx.edges.length.toLocaleString()} deps`;
      this.status.tooltip = `RepoPilot: ${idx.name}\nClick to open the onboarding guide`;
      this.emitter.fire(idx);
      return idx;
    } catch (e: any) {
      this.output.appendLine(`Scan failed: ${e?.stack ?? e}`);
      this.status.text = '$(error) RepoPilot';
      vscode.window.showErrorMessage(`RepoPilot scan failed: ${e?.message ?? e}`);
      return undefined;
    }
  }

  private scheduleRescan(): void {
    if (!this._index || !vscode.workspace.getConfiguration('repopilot').get<boolean>('autoRescan', true)) return;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => void this.scan(this._folder, true), 4000);
  }

  /** Workspace-relative path (forward slashes) of a URI inside the indexed folder. */
  relativePath(uri: vscode.Uri): string | undefined {
    if (!this._folder) return undefined;
    const base = path.normalize(this._folder.uri.fsPath).replace(/[\\/]+$/, '');
    const full = path.normalize(uri.fsPath);
    if (!full.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return undefined;
    return full.slice(base.length + 1).split(path.sep).join('/');
  }

  uriOf(rel: string): vscode.Uri | undefined {
    return this._folder ? vscode.Uri.joinPath(this._folder.uri, ...rel.split('/')) : undefined;
  }

  dispose(): void {
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.disposables.forEach(d => d.dispose());
  }
}
