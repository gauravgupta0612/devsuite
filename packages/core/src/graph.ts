import { Edge, FileInfo, ModuleInfo } from './types';

/** In-memory dependency graph with fast dependents/dependencies lookups (shared by all extensions). */
export class DependencyGraph {
  readonly out = new Map<string, Edge[]>();
  readonly in = new Map<string, Edge[]>();

  constructor(readonly nodes: string[], readonly edges: Edge[]) {
    for (const n of nodes) { this.out.set(n, []); this.in.set(n, []); }
    for (const e of edges) {
      this.out.get(e.from)?.push(e);
      this.in.get(e.to)?.push(e);
    }
  }

  dependenciesOf(file: string): Edge[] { return this.out.get(file) ?? []; }
  dependentsOf(file: string): Edge[] { return this.in.get(file) ?? []; }

  /** Breadth-first transitive dependents with their distance (1 = direct). Basis for DevImpact. */
  transitiveDependents(file: string, maxDepth = 10): Map<string, number> {
    const dist = new Map<string, number>();
    let frontier = [file];
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const e of this.dependentsOf(f)) {
          if (e.from !== file && !dist.has(e.from)) { dist.set(e.from, d); next.push(e.from); }
        }
      }
      frontier = next;
    }
    return dist;
  }

  /** Strongly connected components with more than one node (Tarjan, iterative). */
  cycles(limit = 25, include: (e: Edge) => boolean = () => true): string[][] {
    let index = 0;
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const result: string[][] = [];

    for (const start of this.nodes) {
      if (idx.has(start)) continue;
      const work: { node: string; i: number }[] = [{ node: start, i: 0 }];
      idx.set(start, index); low.set(start, index); index++;
      stack.push(start); onStack.add(start);
      while (work.length) {
        const top = work[work.length - 1];
        const outs = (this.out.get(top.node) ?? []).filter(include);
        if (top.i < outs.length) {
          const w = outs[top.i++].to;
          if (!idx.has(w)) {
            idx.set(w, index); low.set(w, index); index++;
            stack.push(w); onStack.add(w);
            work.push({ node: w, i: 0 });
          } else if (onStack.has(w)) {
            low.set(top.node, Math.min(low.get(top.node)!, idx.get(w)!));
          }
        } else {
          work.pop();
          if (work.length) {
            const parent = work[work.length - 1].node;
            low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
          }
          if (low.get(top.node) === idx.get(top.node)) {
            const comp: string[] = [];
            let w: string;
            do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== top.node);
            if (comp.length > 1) result.push(comp.sort());
          }
        }
      }
    }
    return result.sort((a, b) => b.length - a.length).slice(0, limit);
  }
}

const GROUPING_DIRS = new Set(['src', 'lib', 'packages', 'apps', 'extensions', 'services', 'modules', 'app', 'main', 'java', 'kotlin', 'python']);

/** Map a file to a logical module name (a top-level folder, or one level deeper for src/, packages/, ...). */
export function moduleOf(file: string): string {
  const parts = file.split('/');
  if (parts.length === 1) return '(root)';
  // Java/Kotlin convention: src/main/java/com/acme/feature/X.java -> com.acme.feature
  const j = parts.findIndex((p, i) => (p === 'java' || p === 'kotlin') && parts[i - 1] === 'main' || p === 'java' && parts[i - 1] === 'test');
  if (j >= 0 && parts.length - j > 2) return parts.slice(j + 1, parts.length - 1).join('.');
  let depth = 1;
  while (depth < parts.length - 1 && GROUPING_DIRS.has(parts[depth - 1].toLowerCase()) && depth < 3) depth++;
  return parts.slice(0, depth).join('/');
}

export function buildModules(files: FileInfo[], edges: Edge[]): ModuleInfo[] {
  const mods = new Map<string, { files: number; lines: number; langs: Map<string, number>; deps: Map<string, number> }>();
  const modOf = new Map<string, string>();
  for (const f of files) {
    const m = moduleOf(f.path);
    modOf.set(f.path, m);
    const e = mods.get(m) ?? { files: 0, lines: 0, langs: new Map(), deps: new Map() };
    e.files++; e.lines += f.lines;
    e.langs.set(f.language, (e.langs.get(f.language) ?? 0) + 1);
    mods.set(m, e);
  }
  for (const e of edges) {
    const a = modOf.get(e.from), b = modOf.get(e.to);
    if (a && b && a !== b) mods.get(a)!.deps.set(b, (mods.get(a)!.deps.get(b) ?? 0) + 1);
  }
  return [...mods.entries()]
    .map(([name, v]) => ({
      name,
      files: v.files,
      lines: v.lines,
      languages: [...v.langs.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l).filter(l => l !== 'other').slice(0, 3),
      dependsOn: [...v.deps.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n)
    }))
    .sort((a, b) => b.lines - a.lines);
}
