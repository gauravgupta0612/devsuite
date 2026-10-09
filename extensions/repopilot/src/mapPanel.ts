import * as vscode from 'vscode';
import { RepoIndex, moduleOf } from '@devsuite/core';
import { IndexService } from './indexService';

export interface MapData {
  modules: { nodes: MapNode[]; links: MapLink[] };
  files: { nodes: MapNode[]; links: MapLink[]; omitted: number };
}
interface MapNode { id: string; label: string; group: string; size: number; lang: string; inDeg: number; outDeg: number }
interface MapLink { source: string; target: string; weight: number; kind?: string }

const MAX_FILE_NODES = 400;

export function buildMapData(idx: RepoIndex): MapData {
  // Module level
  const mods = idx.modules;
  const modLinks: MapLink[] = [];
  const modWeights = new Map<string, number>();
  for (const e of idx.edges) {
    const a = moduleOf(e.from), b = moduleOf(e.to);
    if (a !== b) modWeights.set(`${a}\u0000${b}`, (modWeights.get(`${a}\u0000${b}`) ?? 0) + 1);
  }
  for (const [k, w] of modWeights) { const [s, t] = k.split('\u0000'); modLinks.push({ source: s, target: t, weight: w }); }
  const modIn = new Map<string, number>(), modOut = new Map<string, number>();
  for (const l of modLinks) { modIn.set(l.target, (modIn.get(l.target) ?? 0) + l.weight); modOut.set(l.source, (modOut.get(l.source) ?? 0) + l.weight); }
  const modNodes: MapNode[] = mods.map(m => ({
    id: m.name, label: m.name, group: m.name, size: m.files, lang: m.languages[0] ?? 'other',
    inDeg: modIn.get(m.name) ?? 0, outDeg: modOut.get(m.name) ?? 0
  }));

  // File level — keep the most connected files to stay readable
  const deg = new Map<string, { i: number; o: number }>();
  for (const e of idx.edges) {
    deg.set(e.from, { i: deg.get(e.from)?.i ?? 0, o: (deg.get(e.from)?.o ?? 0) + 1 });
    deg.set(e.to, { i: (deg.get(e.to)?.i ?? 0) + 1, o: deg.get(e.to)?.o ?? 0 });
  }
  const connected = idx.files.filter(f => deg.has(f.path));
  const kept = connected
    .sort((a, b) => (deg.get(b.path)!.i + deg.get(b.path)!.o) - (deg.get(a.path)!.i + deg.get(a.path)!.o))
    .slice(0, MAX_FILE_NODES);
  const keptSet = new Set(kept.map(f => f.path));
  const fileNodes: MapNode[] = kept.map(f => ({
    id: f.path, label: f.path.split('/').pop()!, group: moduleOf(f.path), size: Math.max(1, f.lines), lang: f.language,
    inDeg: deg.get(f.path)!.i, outDeg: deg.get(f.path)!.o
  }));
  const fileLinks = idx.edges.filter(e => keptSet.has(e.from) && keptSet.has(e.to)).map(e => ({ source: e.from, target: e.to, weight: 1, kind: e.kind }));
  return { modules: { nodes: modNodes, links: modLinks }, files: { nodes: fileNodes, links: fileLinks, omitted: connected.length - kept.length } };
}

export class MapPanel {
  static current: MapPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(context: vscode.ExtensionContext, service: IndexService, focusFile?: string): void {
    if (MapPanel.current) {
      MapPanel.current.panel.reveal(vscode.ViewColumn.Active);
      MapPanel.current.update(focusFile);
      return;
    }
    const panel = vscode.window.createWebviewPanel('repopilot.map', 'RepoPilot: Dependency Map', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    MapPanel.current = new MapPanel(panel, context, service, focusFile);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly service: IndexService,
    focusFile?: string
  ) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity.svg');
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(msg => {
      if (msg?.type === 'open' && typeof msg.file === 'string') {
        vscode.commands.executeCommand('repopilot.openEvidence', { file: msg.file });
      } else if (msg?.type === 'ready') {
        this.update(focusFile);
      } else if (msg?.type === 'dependents' && typeof msg.file === 'string') {
        vscode.commands.executeCommand('repopilot.showDependents', this.service.uriOf(msg.file));
      }
    }, null, this.disposables);
    service.onDidChange(() => this.update(), null, this.disposables);
  }

  update(focusFile?: string): void {
    const idx = this.service.index;
    if (!idx) return;
    this.panel.webview.postMessage({ type: 'data', name: idx.name, data: buildMapData(idx), focus: focusFile });
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const script = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'map.js'));
    const style = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'map.css'));
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Dependency Map</title>
</head><body>
<header>
  <div class="seg" role="tablist">
    <button id="modeModules" class="active" title="One node per module/folder">Modules</button>
    <button id="modeFiles" title="One node per file (most connected files)">Files</button>
  </div>
  <input id="search" type="search" placeholder="Filter… (name or path)" aria-label="Filter nodes">
  <label class="chk"><input id="hideIsolated" type="checkbox" checked> Hide isolated</label>
  <button id="fit" title="Fit to view">Fit</button>
  <span id="stats"></span>
</header>
<main><canvas id="graph"></canvas><div id="tip" hidden></div><div id="legend"></div><div id="details" hidden></div></main>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
  }

  dispose(): void {
    MapPanel.current = undefined;
    this.disposables.forEach(d => d.dispose());
  }
}
