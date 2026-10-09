import * as vscode from 'vscode';
import { BuildCommand, Evidence, RepoIndex, languageLabel, moduleOf } from '@devsuite/core';
import { IndexService } from './indexService';

type Node = {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  children?: () => Node[];
  evidence?: Evidence;
  build?: BuildCommand;
  expanded?: boolean;
};

const ev = (file: string, line?: number): Evidence => ({ file, line });

export class OverviewTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly service: IndexService) {
    service.onDidChange(() => this.emitter.fire(undefined));
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const state = n.children
      ? (n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(n.label, state);
    item.description = n.description;
    item.tooltip = n.tooltip;
    if (n.icon) item.iconPath = new vscode.ThemeIcon(n.icon);
    if (n.evidence) {
      item.command = { command: 'repopilot.openEvidence', title: 'Open', arguments: [n.evidence] };
      if (!n.icon) item.resourceUri = this.service.uriOf(n.evidence.file);
    }
    if (n.build) {
      item.contextValue = 'buildCommand';
      (item as any).buildCommand = n.build;
    }
    return item;
  }

  getChildren(n?: Node): Node[] {
    const idx = this.service.index;
    if (!idx) return [];
    if (n) return n.children?.() ?? [];
    return this.roots(idx);
  }

  private roots(idx: RepoIndex): Node[] {
    const totalLines = idx.files.reduce((s, f) => s + f.lines, 0);
    const graph = this.service.graph!;
    const nodes: Node[] = [
      {
        label: idx.name,
        description: `${idx.files.length.toLocaleString()} files · ${totalLines.toLocaleString()} lines`,
        icon: 'repo',
        tooltip: `Scanned ${new Date(idx.scannedAt).toLocaleString()} in ${idx.durationMs} ms`,
        expanded: true,
        children: () => [
          {
            label: 'Languages', icon: 'symbol-namespace', description: `${idx.languages.length}`,
            children: () => idx.languages.slice(0, 20).map(l => ({ label: languageLabel(l.language), description: `${l.files} files · ${l.lines.toLocaleString()} lines`, icon: 'file-code' }))
          },
          {
            label: 'Frameworks & platforms', icon: 'extensions', description: `${idx.frameworks.length}`,
            children: () => idx.frameworks.map(f => ({ label: f.name, description: f.evidence[0]?.file, icon: 'package', evidence: f.evidence[0], tooltip: f.evidence.map(e => `${e.file}${e.line ? ':' + e.line : ''}`).join('\n') }))
          },
          {
            label: 'Build systems', icon: 'tools', description: `${idx.buildSystems.length}`,
            children: () => idx.buildSystems.map(b => ({ label: b.name, description: b.evidence[0]?.file, icon: 'gear', evidence: b.evidence[0] }))
          }
        ]
      },
      {
        label: 'Entry Points', icon: 'debug-start', description: `${idx.entryPoints.length}`, expanded: idx.entryPoints.length <= 8,
        children: () => idx.entryPoints.map(e => ({ label: e.file.split('/').pop()!, description: e.reason, tooltip: `${e.file}\n${e.reason}`, evidence: e.evidence.file === e.file ? e.evidence : ev(e.file) }))
      },
      {
        label: 'Build & Run Commands', icon: 'terminal', description: `${idx.buildCommands.length}`,
        children: () => idx.buildCommands.map(c => ({ label: c.command, description: c.cwd || '.', tooltip: `${c.evidence.note ?? ''}\nDefined in ${c.evidence.file}\nUse ▶ to run in a terminal`, icon: 'terminal-cmd', evidence: c.evidence, build: c }))
      },
      {
        label: 'Modules', icon: 'folder-library', description: `${idx.modules.length}`,
        children: () => idx.modules.map(m => ({
          label: m.name,
          description: `${m.files} files · ${m.lines.toLocaleString()} lines`,
          icon: 'folder',
          tooltip: m.dependsOn.length ? `Depends on: ${m.dependsOn.join(', ')}` : 'No dependencies on other modules',
          children: () => {
            const files = idx.files.filter(f => moduleOf(f.path) === m.name)
              .sort((a, b) => graph.dependentsOf(b.path).length - graph.dependentsOf(a.path).length)
              .slice(0, 200);
            const deps: Node[] = m.dependsOn.length
              ? [{ label: 'Depends on', icon: 'arrow-right', description: `${m.dependsOn.length}`, children: () => m.dependsOn.map(d => ({ label: d, icon: 'folder' })) }]
              : [];
            return [...deps, ...files.map(f => ({ label: f.path.split('/').pop()!, description: `${graph.dependentsOf(f.path).length} dependents`, tooltip: f.path, evidence: ev(f.path) }))];
          }
        }))
      },
      {
        label: 'Core Files', icon: 'flame', description: 'most depended upon',
        children: () => idx.hotspots.map(h => ({ label: h.file.split('/').pop()!, description: `${h.dependents} dependents · ${h.file}`, tooltip: h.file, evidence: ev(h.file) }))
      }
    ];
    if (idx.cycles.length) {
      nodes.push({
        label: 'Circular Dependencies', icon: 'warning', description: `${idx.cycles.length}`,
        children: () => idx.cycles.map((c, i) => ({
          label: `Cycle ${i + 1}`, description: `${c.length} files`, icon: 'sync',
          children: () => c.map(f => ({ label: f.split('/').pop()!, description: f, evidence: ev(f) }))
        }))
      });
    }
    if (idx.unresolved.length) {
      nodes.push({
        label: 'Unresolved References', icon: 'question', description: `${idx.unresolved.length}`,
        children: () => idx.unresolved.slice(0, 300).map(u => ({ label: u.specifier, description: `${u.from}:${u.line}`, icon: 'debug-disconnect', evidence: ev(u.from, u.line) }))
      });
    }
    return nodes;
  }

}
