import * as vscode from 'vscode';
import { Endpoint, FlowNode, findEndpoints, flowToMermaid, traceEndpoint } from '@devsuite/core';
import { IndexService, openEvidence } from '@devsuite/vscode-common';

let service: IndexService;
let endpoints: Endpoint[] = [];
let tree: EndpointTree;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('TraceLens');
  service = new IndexService('TraceLens', 'tracelens', output);
  tree = new EndpointTree();
  const view = vscode.window.createTreeView('tracelens.endpoints', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(output, service, view);
  const cmd = (id: string, fn: (...a: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  const refresh = () => {
    const idx = service.index;
    if (!idx) return;
    endpoints = findEndpoints(idx, service.graph);
    tree.refresh();
    view.description = `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}`;
    lens.refresh();
    output.appendLine(`Found ${endpoints.length} endpoints`);
  };
  service.onDidChange(refresh);

  cmd('tracelens.refresh', async () => { await service.scan(undefined, false); });
  cmd('tracelens.openEvidence', (e: { file: string; line?: number }) => openEvidence(service, e));
  cmd('tracelens.trace', (arg: Endpoint | { endpoint: Endpoint }) => {
    const ep = (arg as any)?.endpoint ?? arg;
    if (ep?.path) FlowPanel.show(context, ep);
  });
  cmd('tracelens.traceEndpoint', async () => {
    if (!service.index) await service.ensureIndex();
    if (!endpoints.length) { vscode.window.showInformationMessage('TraceLens found no API endpoints in this workspace.'); return; }
    const pick = await vscode.window.showQuickPick(endpoints.map(e => ({ label: `${e.method} ${e.path}`, description: e.framework, detail: `${e.handler} — ${e.file}:${e.line}`, e })), { title: 'Trace which endpoint?', matchOnDetail: true });
    if (pick) FlowPanel.show(context, pick.e);
  });
  cmd('tracelens.copyMermaid', async () => {
    const ep = FlowPanel.current?.endpoint;
    if (!ep || !service.index) return;
    await vscode.env.clipboard.writeText('```mermaid\n' + flowToMermaid(traceEndpoint(service.index, service.graph!, ep, depth())) + '\n```');
    vscode.window.showInformationMessage('Flow copied as a Mermaid diagram (paste into GitHub, Confluence or a README).');
  });
  cmd('tracelens.groupBy', async () => {
    const pick = await vscode.window.showQuickPick(['path', 'file', 'method'], { title: 'Group endpoints by' });
    if (pick) { await vscode.workspace.getConfiguration('tracelens').update('groupBy', pick, vscode.ConfigurationTarget.Workspace); tree.refresh(); }
  });

  const lens = new RouteLens();
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lens));
  registerTools(context);
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('tracelens')) { tree.refresh(); lens.refresh(); } }));

  if (vscode.workspace.workspaceFolders?.length) void service.scan(vscode.workspace.workspaceFolders[0], true);
}

const depth = () => vscode.workspace.getConfiguration('tracelens').get<number>('maxDepth', 5);

// -------------------------------------------------------------------------------------------------
type Node = { label: string; description?: string; tooltip?: string; children?: Node[]; endpoint?: Endpoint };
const METHOD_COLOR: Record<string, string> = { GET: 'charts.blue', POST: 'charts.green', PUT: 'charts.orange', PATCH: 'charts.yellow', DELETE: 'charts.red' };

class EndpointTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  refresh() { this.emitter.fire(); }

  getChildren(n?: Node): Node[] {
    if (n) return n.children ?? [];
    const by = vscode.workspace.getConfiguration('tracelens').get<string>('groupBy', 'path');
    const leaf = (e: Endpoint, labelPath = true): Node => ({ label: labelPath ? `${e.method} ${e.path}` : e.path, description: `${e.handler === '(inline)' ? 'inline' : e.handler} · ${e.file.split('/').pop()}:${e.line}`, tooltip: `${e.framework}\n${e.file}:${e.line}\nhandler: ${e.handler}`, endpoint: e });
    const groups = new Map<string, Endpoint[]>();
    const pathKey = (p: string) => { const segs = p.split('/').filter(Boolean); const n = /^(api|rest|v\d+)$/i.test(segs[0] ?? '') ? 2 : 1; return '/' + segs.slice(0, n).join('/'); };
    const key = (e: Endpoint) => by === 'file' ? e.file : by === 'method' ? e.method : pathKey(e.path);
    for (const e of endpoints) (groups.get(key(e)) ?? groups.set(key(e), []).get(key(e))!).push(e);
    if (groups.size <= 1) return endpoints.map(e => leaf(e));
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, list]) => ({ label: k, description: `${list.length}`, children: list.map(e => leaf(e)) }));
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, n.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.description = n.description; item.tooltip = n.tooltip;
    if (n.endpoint) {
      item.iconPath = new vscode.ThemeIcon('symbol-event', new vscode.ThemeColor(METHOD_COLOR[n.endpoint.method] ?? 'charts.purple'));
      item.contextValue = 'endpoint';
      item.command = { command: 'tracelens.trace', title: 'Trace', arguments: [n.endpoint] };
    } else item.iconPath = new vscode.ThemeIcon(n.children ? 'folder' : 'globe');
    return item;
  }
}

class RouteLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  refresh() { this.emitter.fire(); }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('tracelens').get<boolean>('codeLens', true)) return [];
    const rel = service.relativePath(doc.uri);
    if (!rel) return [];
    return endpoints.filter(e => e.file === rel && e.line <= doc.lineCount).map(e => new vscode.CodeLens(new vscode.Range(e.line - 1, 0, e.line - 1, 0), {
      title: `$(type-hierarchy-sub) Trace ${e.method} ${e.path}`, command: 'tracelens.trace', arguments: [e], tooltip: 'TraceLens: follow this request through the code'
    }));
  }
}

// -------------------------------------------------------------------------------------------------
class FlowPanel {
  static current: FlowPanel | undefined;
  endpoint: Endpoint;

  static show(context: vscode.ExtensionContext, ep: Endpoint) {
    if (FlowPanel.current) { FlowPanel.current.endpoint = ep; FlowPanel.current.render(); FlowPanel.current.panel.reveal(vscode.ViewColumn.Beside); return; }
    const panel = vscode.window.createWebviewPanel('tracelens.flow', 'Request Flow', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
    FlowPanel.current = new FlowPanel(panel, context, ep);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, context: vscode.ExtensionContext, ep: Endpoint) {
    this.endpoint = ep;
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity.svg');
    panel.onDidDispose(() => { FlowPanel.current = undefined; });
    panel.webview.onDidReceiveMessage(m => {
      if (m?.type === 'open') vscode.commands.executeCommand('tracelens.openEvidence', { file: m.file, line: m.line });
      if (m?.type === 'mermaid') vscode.commands.executeCommand('tracelens.copyMermaid');
      if (m?.type === 'retrace') this.render();
    });
    service.onDidChange(() => this.render());
    this.render();
  }

  render() {
    const idx = service.index;
    if (!idx) return;
    const ep = endpoints.find(e => e.id === this.endpoint.id) ?? this.endpoint;
    const root = traceEndpoint(idx, service.graph!, ep, depth());
    this.panel.title = `${ep.method} ${ep.path}`;
    this.panel.webview.html = html(this.panel.webview, root, ep);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const KIND_LABEL: Record<string, string> = { endpoint: 'Endpoint', controller: 'Handler', service: 'Service', repository: 'Repository', function: 'Function', database: 'Database', external: 'External call', unresolved: 'Not found' };

function html(webview: vscode.Webview, root: FlowNode, ep: Endpoint): string {
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const counts: Record<string, number> = {};
  const walkCount = (n: FlowNode) => { counts[n.kind] = (counts[n.kind] ?? 0) + 1; n.children.forEach(walkCount); };
  walkCount(root);
  const node = (n: FlowNode): string => {
    const loc = n.file ? `<span class="loc">${esc(n.file)}${n.line ? ':' + n.line : ''}</span>` : '';
    const open = n.file ? ` data-file="${esc(n.file)}" data-line="${n.line ?? 1}" tabindex="0" role="button"` : '';
    const kids = n.children.length ? `<ul>${n.children.map(c => `<li>${node(c)}</li>`).join('')}</ul>` : '';
    const toggle = n.children.length ? `<button class="tg" aria-label="Collapse">▾</button>` : '<span class="tg-sp"></span>';
    return `<div class="row">${toggle}<div class="card k-${n.kind}"${open}><span class="badge">${KIND_LABEL[n.kind] ?? n.kind}</span><span class="name">${esc(n.name)}</span>${loc}${n.detail ? `<span class="detail">${esc(n.detail)}</span>` : ''}</div></div>${kids}`;
  };
  const summary = ['controller', 'service', 'repository', 'function', 'database', 'external'].filter(k => counts[k]).map(k => `<span class="chip k-${k}">${counts[k]} ${KIND_LABEL[k].toLowerCase()}${counts[k] > 1 && !k.endsWith('e') ? 's' : counts[k] > 1 ? 's' : ''}</span>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Request Flow</title>
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);padding:12px 18px;margin:0}
header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
h1{font-size:16px;margin:0;font-family:var(--vscode-editor-font-family)}
.m{font-weight:700;padding:2px 8px;border-radius:3px;color:#fff;background:#4E79A7}.m.POST{background:#59A14F}.m.PUT{background:#F28E2B}.m.PATCH{background:#B07AA1}.m.DELETE{background:#E15759}
.fw{color:var(--vscode-descriptionForeground)}
.actions{margin-left:auto;display:flex;gap:6px}
button.b{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:0;padding:4px 10px;border-radius:2px;cursor:pointer;font:inherit}
button.b:hover{background:var(--vscode-button-secondaryHoverBackground)}
.summary{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 14px}
.chip{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--vscode-panel-border,#8884)}
ul{list-style:none;margin:0;padding-left:26px;border-left:1px dashed var(--vscode-panel-border,#8886);margin-left:9px}
li{margin:6px 0;position:relative}
li::before{content:'';position:absolute;left:-26px;top:16px;width:22px;border-top:1px dashed var(--vscode-panel-border,#8886)}
.row{display:flex;align-items:flex-start;gap:4px}
.tg{background:none;border:0;color:var(--vscode-descriptionForeground);cursor:pointer;width:18px;padding:6px 0 0;font-size:12px}.tg-sp{width:18px;display:inline-block}
.collapsed + ul{display:none}
.card{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:6px 10px;border-radius:4px;border:1px solid var(--vscode-panel-border,#8884);border-left:4px solid #888;background:var(--vscode-editorWidget-background);max-width:900px}
.card[data-file]{cursor:pointer}.card[data-file]:hover,.card[data-file]:focus{outline:1px solid var(--vscode-focusBorder)}
.badge{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--vscode-descriptionForeground);min-width:72px}
.name{font-family:var(--vscode-editor-font-family);font-weight:600;word-break:break-all}
.loc{font-size:11px;color:var(--vscode-textLink-foreground)}
.detail{font-size:11px;color:var(--vscode-descriptionForeground);flex-basis:100%;padding-left:82px}
.k-endpoint{border-left-color:#4E79A7}.k-controller{border-left-color:#76B7B2}.k-service{border-left-color:#59A14F}.k-repository{border-left-color:#B07AA1}
.k-function{border-left-color:#9C755F}.k-database{border-left-color:#F28E2B}.k-external{border-left-color:#E15759}.k-unresolved{border-left-color:#888;opacity:.75}
.chip.k-database{border-color:#F28E2B}.chip.k-external{border-color:#E15759}.chip.k-service{border-color:#59A14F}.chip.k-repository{border-color:#B07AA1}
.legend{margin-top:18px;font-size:11px;color:var(--vscode-descriptionForeground)}
</style></head><body>
<header><span class="m ${esc(ep.method)}">${esc(ep.method)}</span><h1>${esc(ep.path)}</h1><span class="fw">${esc(ep.framework)}</span>
<div class="actions"><button class="b" id="expand">Expand all</button><button class="b" id="collapse">Collapse all</button><button class="b" id="mermaid">Copy as Mermaid</button><button class="b" id="retrace">Re-trace</button></div></header>
<div class="summary">${summary || '<span class="chip">No downstream calls detected</span>'}</div>
<ul style="border:0;padding:0;margin:0"><li style="margin:0">${node(root)}</li></ul>
<p class="legend">Static trace from source code: follows direct calls through imported files. Dynamic dispatch, dependency injection by string, and framework internals are not followed. Click any step to open it.</p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener('click', e => {
  const t = e.target.closest('.tg'); if (t) { t.parentElement.classList.toggle('collapsed'); t.textContent = t.parentElement.classList.contains('collapsed') ? '▸' : '▾'; return; }
  const c = e.target.closest('.card[data-file]'); if (c) vscode.postMessage({ type: 'open', file: c.dataset.file, line: +c.dataset.line });
});
document.addEventListener('keydown', e => { const c = e.target.closest && e.target.closest('.card[data-file]'); if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); c.click(); } });
document.getElementById('mermaid').onclick = () => vscode.postMessage({ type: 'mermaid' });
document.getElementById('retrace').onclick = () => vscode.postMessage({ type: 'retrace' });
document.getElementById('expand').onclick = () => document.querySelectorAll('.row').forEach(r => { r.classList.remove('collapsed'); const t = r.querySelector('.tg'); if (t) t.textContent = '▾'; });
document.getElementById('collapse').onclick = () => document.querySelectorAll('li li .row').forEach(r => { if (r.querySelector('.tg')) { r.classList.add('collapsed'); r.querySelector('.tg').textContent = '▸'; } });
</script></body></html>`;
}

// -------------------------------------------------------------------------------------------------
function registerTools(context: vscode.ExtensionContext) {
  if (!(vscode as any).lm?.registerTool) return;
  const txt = (s: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
  context.subscriptions.push(
    vscode.lm.registerTool<{ filter?: string }>('tracelens_listEndpoints', {
      async invoke(o) {
        await service.ensureIndex();
        const f = (o.input.filter ?? '').toLowerCase();
        const list = endpoints.filter(e => !f || e.path.toLowerCase().includes(f));
        return txt(list.map(e => `${e.method} ${e.path} — ${e.framework}, handler ${e.handler} (${e.file}:${e.line})`).join('\n') || 'No endpoints found.');
      }
    }),
    vscode.lm.registerTool<{ method?: string; path: string }>('tracelens_traceEndpoint', {
      prepareInvocation: o => ({ invocationMessage: `TraceLens: tracing ${o.input.method ?? ''} ${o.input.path}` }),
      async invoke(o) {
        const idx = await service.ensureIndex();
        if (!idx) return txt('No workspace folder is open.');
        const ep = endpoints.find(e => e.path === o.input.path && (!o.input.method || e.method === o.input.method.toUpperCase()))
          ?? endpoints.find(e => e.path.endsWith(o.input.path));
        if (!ep) return txt(`Endpoint ${o.input.path} not found. Call tracelens_listEndpoints first.`);
        const lines: string[] = [];
        const walk = (n: FlowNode, d: number) => { lines.push(`${'  '.repeat(d)}- [${n.kind}] ${n.name}${n.file ? ` (${n.file}${n.line ? ':' + n.line : ''})` : ''}${n.detail ? ' — ' + n.detail : ''}`); n.children.forEach(c => walk(c, d + 1)); };
        walk(traceEndpoint(idx, service.graph!, ep, depth()), 0);
        return txt(lines.join('\n'));
      }
    })
  );
}

export function deactivate(): void { /* disposables handle cleanup */ }
