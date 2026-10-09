import * as fs from 'fs';
import * as path from 'path';
import { CODE_LANGUAGES, detectLanguage, isTestFile } from './languages';
import { looksBinary, walkRepository } from './scanner';
import { parseSource } from './parsers';
import { detectManifests } from './detectors';
import { resolveReferences } from './resolver';
import { DependencyGraph, buildModules } from './graph';
import { EntryPoint, FileInfo, LanguageId, RepoIndex, ScanOptions } from './types';

const CONVENTIONAL_ENTRIES: [RegExp, string][] = [
  [/^(src\/)?(index|main|app|server|cli)\.(ts|js|mjs|cjs|tsx|jsx)$/, 'Conventional application entry file'],
  [/^(src\/)?(main|app|__main__|wsgi|asgi|cli)\.py$/, 'Conventional Python entry file'],
  [/(^|\/)__main__\.py$/, 'Package runnable with python -m'],
  [/(^|\/)Program\.cs$/, '.NET Program.cs'],
  [/(^|\/)cmd\/[^/]+\/main\.go$/, 'Go command (cmd/*/main.go)'],
  [/^main\.go$/, 'Go main package']
];

const yieldToLoop = () => new Promise<void>(r => setImmediate(r));

/** Scan and index a repository. Pure Node — no VS Code dependency, so every extension (and CLI/MCP) can reuse it. */
export async function indexRepository(root: string, opts: ScanOptions = {}): Promise<RepoIndex> {
  const started = Date.now();
  const maxBytes = opts.maxFileBytes ?? 1_000_000;
  const walk = walkRepository(root, opts);
  const files: FileInfo[] = [];

  let n = 0;
  for (const w of walk.files) {
    if (opts.isCancelled?.()) break;
    if (++n % 200 === 0) { opts.onProgress?.(n, w.rel); await yieldToLoop(); }
    const language = detectLanguage(w.rel);
    const info: FileInfo = { path: w.rel, language, size: w.size, lines: 0, symbols: [], references: [], isTest: isTestFile(w.rel) };
    if (w.size <= maxBytes && (CODE_LANGUAGES.has(language) || language === 'other' || language === 'markdown' || language === 'json' || language === 'yaml' || language === 'html' || language === 'css' || language === 'xml' || language === 'shell')) {
      let buf: Buffer | undefined;
      try { buf = fs.readFileSync(w.abs); } catch { /* unreadable */ }
      if (buf && !looksBinary(buf)) {
        const text = buf.toString('utf8');
        info.lines = text.length ? text.split('\n').length : 0;
        if (CODE_LANGUAGES.has(language)) {
          try {
            const parsed = parseSource(language, text, w.rel);
            info.symbols = parsed.symbols;
            info.references = parsed.references;
            info.selfEntry = parsed.selfEntry;
          } catch { /* a parser must never break the scan */ }
        }
      } else if (buf && language === 'other') {
        continue; // skip binaries we don't recognise (images, jars, ...)
      }
    }
    files.push(info);
  }

  const manifests = detectManifests(root, files);

  // npm workspaces: package name -> entry file, so `import '@scope/pkg'` resolves inside monorepos
  const workspacePackages = new Map<string, string>();
  for (const f of files.filter(x => x.path.endsWith('package.json') && x.path !== 'package.json')) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, f.path), 'utf8'));
      const dir = f.path.slice(0, -'package.json'.length - 1);
      const candidates = [`${dir}/src/index.ts`, `${dir}/src/index.js`, `${dir}/index.ts`, `${dir}/index.js`, `${dir}/src/extension.ts`];
      const entry = candidates.find(c => files.some(x => x.path === c));
      if (j.name && entry) workspacePackages.set(j.name, entry);
    } catch { /* ignore */ }
  }

  const { edges, unresolved } = resolveReferences(files, {
    pythonRoots: manifests.pythonRoots,
    goModule: manifests.goModule,
    workspacePackages
  });
  const graph = new DependencyGraph(files.map(f => f.path), edges);

  // ---------- entry points ----------
  const entries = new Map<string, EntryPoint>();
  const addEntry = (e: EntryPoint) => { if (!entries.has(e.file) && files.some(f => f.path === e.file)) entries.set(e.file, e); };
  for (const d of manifests.declaredEntries) addEntry(d);
  for (const f of files) if (f.selfEntry && !f.isTest) addEntry({ file: f.path, reason: f.selfEntry.note ?? 'Entry point', evidence: f.selfEntry });
  for (const f of files) {
    if (f.isTest) continue;
    for (const [re, reason] of CONVENTIONAL_ENTRIES) if (re.test(f.path)) addEntry({ file: f.path, reason, evidence: { file: f.path, line: 1 } });
  }
  // IBM i: programs that nothing in the repo calls, but that do call/use something -> top-level jobs/menus.
  const ibmiPrograms = files.filter(f => ['rpgle', 'sqlrpgle', 'rpg', 'cl', 'cobol'].includes(f.language) && !f.isTest && !/inc$|cpy$/i.test(f.path));
  const includedOnly = new Set(edges.filter(e => e.kind === 'include').map(e => e.to));
  const topPrograms = ibmiPrograms
    .filter(f => !includedOnly.has(f.path))
    .filter(f => !graph.dependentsOf(f.path).some(e => e.kind === 'call'))
    .map(f => ({ f, out: graph.dependenciesOf(f.path).length }))
    .filter(x => x.out > 0)
    .sort((a, b) => (a.f.language === 'cl' ? -1 : 0) - (b.f.language === 'cl' ? -1 : 0) || b.out - a.out)
    .slice(0, 20);
  for (const { f, out } of topPrograms) {
    addEntry({ file: f.path, reason: `Top-level IBM i ${f.language === 'cl' ? 'CL ' : ''}program (not called by other repo programs; uses ${out} objects)`, evidence: { file: f.path, line: 1 } });
  }

  // ---------- stats ----------
  const langStats = new Map<LanguageId, { files: number; lines: number }>();
  for (const f of files) {
    const s = langStats.get(f.language) ?? { files: 0, lines: 0 };
    s.files++; s.lines += f.lines;
    langStats.set(f.language, s);
  }
  const languages = [...langStats.entries()]
    .map(([language, s]) => ({ language, ...s }))
    .sort((a, b) => {
      const code = (l: LanguageId) => (CODE_LANGUAGES.has(l) ? 1 : 0);
      return code(b.language) - code(a.language) || b.lines - a.lines;
    });

  const hotspots = files
    .map(f => ({ file: f.path, dependents: new Set(graph.dependentsOf(f.path).map(e => e.from)).size }))
    .filter(h => h.dependents > 1)
    .sort((a, b) => b.dependents - a.dependents)
    .slice(0, 25);

  const readme = files.find(f => /^readme(\.(md|txt|rst))?$/i.test(f.path))?.path;

  return {
    root,
    name: path.basename(root),
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    truncated: walk.truncated,
    files,
    languages,
    frameworks: manifests.frameworks,
    buildSystems: manifests.buildSystems,
    buildCommands: manifests.buildCommands,
    entryPoints: [...entries.values()],
    externalDependencies: manifests.externalDependencies,
    edges,
    unresolved,
    modules: buildModules(files, edges),
    hotspots,
    // Runtime cycles only: ignore type-only imports and prototype->implementation links from copybooks.
    cycles: graph.cycles(25, e => !e.typeOnly && !(e.kind === 'call' && includedOnly.has(e.from))),
    readme,
    testFiles: files.filter(f => f.isTest).length
  };
}

export function graphOf(index: RepoIndex): DependencyGraph {
  return new DependencyGraph(index.files.map(f => f.path), index.edges);
}
