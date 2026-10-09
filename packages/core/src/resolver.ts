import { Edge, FileInfo, LanguageId } from './types';
import { baseName } from './parsers/ibmi';

const JS_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.json'];
const PROGRAM_LANGS = new Set<LanguageId>(['rpgle', 'sqlrpgle', 'rpg', 'cl', 'cobol']);
const FILE_LANGS = new Set<LanguageId>(['dds', 'sql']);
const COPY_LANGS = new Set<LanguageId>(['rpgle', 'sqlrpgle', 'rpg', 'cobol', 'sql']);

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function normalisePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
}

export interface ResolveContext {
  pythonRoots: string[];
  goModule?: { dir: string; module: string };
  /** npm workspace package name -> entry file */
  workspacePackages: Map<string, string>;
}

export interface ResolveOutput {
  edges: Edge[];
  unresolved: { from: string; specifier: string; line: number }[];
}

/** Resolve every raw reference in the index to a repository file where possible. */
export function resolveReferences(files: FileInfo[], ctx: ResolveContext): ResolveOutput {
  const byPath = new Map(files.map(f => [f.path, f]));
  const lowerPaths = new Map(files.map(f => [f.path.toLowerCase(), f.path]));
  const byBase = new Map<string, FileInfo[]>();
  const byDir = new Map<string, FileInfo[]>();
  const procs = new Map<string, FileInfo[]>();
  const sqlObjects = new Map<string, FileInfo[]>();
  for (const f of files) {
    const b = baseName(f.path);
    (byBase.get(b) ?? byBase.set(b, []).get(b)!).push(f);
    const d = dirOf(f.path);
    (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(f);
    for (const s of f.symbols) {
      if (s.kind === 'procedure') {
        const k = s.name.toUpperCase();
        (procs.get(k) ?? procs.set(k, []).get(k)!).push(f);
      }
      if (f.language === 'sql' && s.kind === 'class') {
        const k = s.name.toUpperCase();
        (sqlObjects.get(k) ?? sqlObjects.set(k, []).get(k)!).push(f);
      }
    }
  }

  const edges: Edge[] = [];
  const unresolved: ResolveOutput['unresolved'] = [];
  const edgeAt = new Map<string, Edge>();
  const addEdge = (from: FileInfo, to: string, kind: Edge['kind'], line: number, specifier: string, typeOnly?: boolean) => {
    if (to === from.path) return;
    const key = `${from.path}->${to}`;
    const prev = edgeAt.get(key);
    if (prev) { if (prev.typeOnly && !typeOnly) prev.typeOnly = undefined; return; }
    const e: Edge = { from: from.path, to, kind, line, specifier, ...(typeOnly ? { typeOnly } : {}) };
    edgeAt.set(key, e);
    edges.push(e);
  };

  const tryFile = (p: string): string | undefined => {
    const n = normalisePath(p);
    if (byPath.has(n)) return n;
    return lowerPaths.get(n.toLowerCase());
  };
  const tryJs = (p: string): string | undefined => {
    const direct = tryFile(p);
    if (direct) return direct;
    const stripped = p.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const base of [p, stripped]) {
      for (const e of JS_EXTS) { const r = tryFile(base + e); if (r) return r; }
      for (const e of JS_EXTS) { const r = tryFile(`${base}/index${e}`); if (r) return r; }
    }
    return undefined;
  };
  const tryPython = (rel: string): string | undefined =>
    tryFile(rel + '.py') ?? tryFile(rel + '/__init__.py');

  for (const f of files) {
    const fdir = dirOf(f.path);
    for (const r of f.references) {
      const spec = r.specifier;
      let target: string | undefined;
      let reportMissing = false;

      switch (f.language) {
        case 'typescript':
        case 'javascript': {
          if (spec.startsWith('.')) {
            target = tryJs(`${fdir}/${spec}`);
            reportMissing = true;
          } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
            target = tryJs(`src/${spec.slice(2)}`);
            reportMissing = true;
          } else if (spec.startsWith('/')) {
            target = tryJs(spec.slice(1));
          } else {
            const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
            const ws = ctx.workspacePackages.get(pkg);
            if (ws) target = ws;
          }
          break;
        }
        case 'python': {
          const optional = spec.startsWith('?');
          const s = optional ? spec.slice(1) : spec;
          const dots = /^\.*/.exec(s)![0].length;
          const rest = s.slice(dots).replace(/\./g, '/');
          if (dots > 0) {
            let base = fdir;
            for (let i = 1; i < dots; i++) base = dirOf(base);
            target = rest ? tryPython(`${base}/${rest}`) : undefined;
            reportMissing = !optional && !!rest;
          } else {
            for (const root of ctx.pythonRoots) {
              target = tryPython(root ? `${root}/${rest}` : rest);
              if (target) break;
            }
            // sibling module import (implicit relative, common in scripts)
            if (!target && !rest.includes('/')) target = tryPython(`${fdir}/${rest}`);
          }
          break;
        }
        case 'java':
        case 'kotlin': {
          if (spec.startsWith('samepkg:')) {
            const type = spec.split(':')[2];
            target = tryFile(`${fdir}/${type}.java`) ?? tryFile(`${fdir}/${type}.kt`);
            break;
          }
          const p = spec.replace(/\.\*$/, '').replace(/\./g, '/');
          if (spec.endsWith('.*')) {
            const dirFiles = files.filter(x => (x.language === 'java' || x.language === 'kotlin') && dirOf(x.path).endsWith(p));
            for (const df of dirFiles) addEdge(f, df.path, 'import', r.line, spec);
            break;
          }
          const suffixes = [p, p.split('/').slice(0, -1).join('/')].filter(Boolean);
          for (const suf of suffixes) {
            const hit = files.find(x => x.path.endsWith(`${suf}.java`) || x.path.endsWith(`${suf}.kt`));
            if (hit) { target = hit.path; break; }
          }
          break;
        }
        case 'go': {
          if (ctx.goModule && spec.startsWith(ctx.goModule.module)) {
            const sub = spec.slice(ctx.goModule.module.length).replace(/^\//, '');
            const dir = normalisePath(`${ctx.goModule.dir}/${sub}`);
            for (const df of (byDir.get(dir) ?? []).filter(x => x.language === 'go' && !x.isTest)) {
              addEdge(f, df.path, 'import', r.line, spec);
            }
            if (!(byDir.get(dir) ?? []).length) unresolved.push({ from: f.path, specifier: spec, line: r.line });
          }
          break;
        }
        default: {
          // IBM i / SQL / COBOL namespaced specifiers
          const [ns, ...restParts] = spec.split(':');
          const name = restParts.join(':');
          if (ns === 'copy') {
            if (name.includes('/') || name.includes('.')) {
              const cand = tryFile(name) ?? tryFile(`${fdir}/${name}`)
                ?? files.find(x => x.path.toLowerCase().endsWith('/' + name.toLowerCase()))?.path;
              target = cand;
            }
            if (!target) {
              const hits = (byBase.get(baseName(name)) ?? []).filter(x => COPY_LANGS.has(x.language));
              target = (hits.find(x => /inc$/i.test(x.path) || /copy|cpy|inc|qprotosrc|qcpysrc/i.test(x.path)) ?? hits[0])?.path;
            }
            reportMissing = true;
          } else if (ns === 'pgm') {
            const hits = (byBase.get(name) ?? []).filter(x => PROGRAM_LANGS.has(x.language) && x.path !== f.path);
            target = hits[0]?.path;
            reportMissing = !/^Q[A-Z]/.test(name); // QCMDEXC, QSNDDTAQ ... are system programs
          } else if (ns === 'proc') {
            const hits = (procs.get(name) ?? []).filter(x => x.path !== f.path);
            target = (hits.find(x => x.symbols.some(s => s.kind === 'procedure' && s.exported && s.name.toUpperCase() === name)) ?? hits[0])?.path;
            if (!target) {
              const sql = (sqlObjects.get(name) ?? [])[0];
              target = sql?.path;
            }
          } else if (ns === 'file') {
            const hits = (byBase.get(name) ?? []).filter(x => FILE_LANGS.has(x.language) && x.path !== f.path);
            target = hits[0]?.path ?? (sqlObjects.get(name) ?? []).find(x => x.path !== f.path)?.path;
          }
        }
      }

      if (target) addEdge(f, target, r.kind, r.line, spec, r.typeOnly);
      else if (reportMissing) unresolved.push({ from: f.path, specifier: spec, line: r.line });
    }
  }
  return { edges, unresolved };
}
