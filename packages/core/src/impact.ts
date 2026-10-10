import * as fs from 'fs';
import * as path from 'path';
import { DependencyGraph } from './graph';
import { FileInfo, RepoIndex, SymbolInfo } from './types';

export interface ImpactChange {
  file: string;
  /** Changed line numbers (new-file numbering). Omit to treat the whole file as changed. */
  lines?: number[];
  /** Explicit symbols to analyse (e.g. the function under the cursor). */
  symbols?: string[];
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface AffectedFile {
  file: string;
  distance: number;
  /** The changed file this one is (transitively) reached from. */
  via: string;
  /** Direct dependents only: which changed symbols this file actually mentions. */
  usesSymbols: string[];
  confidence: 'high' | 'medium' | 'low';
  isTest: boolean;
  line?: number;
}

export interface TestRecommendation { file: string; reason: string }
export interface TestCommand { label: string; command: string; cwd: string }

export interface ImpactResult {
  changes: { file: string; status: string; changedSymbols: SymbolInfo[]; dependents: number; isHotspot: boolean }[];
  affected: AffectedFile[];
  tests: TestRecommendation[];
  testCommands: TestCommand[];
  score: number;
  level: 'low' | 'medium' | 'high';
  summary: string;
}

const CALLABLE = new Set(['function', 'method', 'procedure', 'class', 'interface', 'program']);

/** Symbols whose body contains any of the given lines (nearest preceding definition). */
export function symbolsAtLines(file: FileInfo, lines: number[]): SymbolInfo[] {
  const syms = file.symbols.filter(s => CALLABLE.has(s.kind)).sort((a, b) => a.line - b.line);
  if (!syms.length || !lines.length) return [];
  const out = new Map<string, SymbolInfo>();
  for (const l of lines) {
    let best: SymbolInfo | undefined;
    for (const s of syms) { if (s.line <= l) best = s; else break; }
    if (best) out.set(`${best.name}@${best.line}`, best);
  }
  return [...out.values()];
}

function readSafe(root: string, rel: string): string {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

const stem = (p: string) => p.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/\.(test|spec|pgm|module)$/i, '').toLowerCase();

/** Tests that look like they target `file` by naming convention. */
function conventionTests(index: RepoIndex, file: string): string[] {
  const s = stem(file);
  if (s.length < 3 || ['index', 'main', 'init', '__init__', 'utils', 'util', 'types'].includes(s)) return [];
  return index.files.filter(f => f.isTest && f.path !== file && (() => {
    const t = stem(f.path).replace(/^test_?|_?test$|tests?$/i, '').replace(/[-_]/g, '');
    return t === s.replace(/[-_]/g, '');
  })()).map(f => f.path);
}

export function testCommandsFor(index: RepoIndex, tests: string[]): TestCommand[] {
  if (!tests.length) return [];
  const fw = new Set(index.frameworks.map(f => f.name));
  const cmds: TestCommand[] = [];
  const by = (pred: (p: string) => boolean) => tests.filter(pred);
  const js = by(p => /\.(c|m)?[jt]sx?$/.test(p));
  const py = by(p => p.endsWith('.py'));
  const jvm = by(p => /\.(java|kt)$/.test(p));
  const go = by(p => p.endsWith('.go'));
  const ibmi = by(p => /\.(sqlrpgle|rpgle|clle)$/i.test(p));
  const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
  if (js.length) {
    const runner = fw.has('Vitest') ? 'npx vitest run' : fw.has('Jest') ? 'npx jest' : fw.has('Mocha') ? 'npx mocha' : fw.has('Playwright') ? 'npx playwright test' : 'npx jest';
    cmds.push({ label: `${runner.split(' ')[1]} (${js.length} files)`, command: `${runner} ${js.map(q).join(' ')}`, cwd: '' });
  }
  if (py.length) cmds.push({ label: `pytest (${py.length} files)`, command: `python -m pytest ${py.map(q).join(' ')}`, cwd: '' });
  if (jvm.length) {
    const classes = jvm.map(p => p.split('/').pop()!.replace(/\.(java|kt)$/, ''));
    if (index.buildSystems.some(b => b.name === 'Maven')) cmds.push({ label: `Maven (${classes.length} test classes)`, command: `mvn test -Dtest=${classes.join(',')}`, cwd: '' });
    else cmds.push({ label: `Gradle (${classes.length} test classes)`, command: `gradle test ${classes.map(c => `--tests ${c}`).join(' ')}`, cwd: '' });
  }
  if (go.length) {
    const dirs = [...new Set(go.map(p => './' + (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')))];
    cmds.push({ label: `go test (${dirs.length} packages)`, command: `go test ${dirs.join(' ')}`, cwd: '' });
  }
  if (ibmi.length) {
    const names = ibmi.map(p => p.split('/').pop()!.split('.')[0].toUpperCase());
    cmds.push({ label: `RPGUnit (${names.length} test programs)`, command: names.map(n => `RUCALLTST TSTPGM(*LIBL/${n})`).join(' ; '), cwd: '' });
  }
  return cmds;
}

/**
 * Change-impact analysis: what depends on the changed code, how far away, and which tests to run.
 * Uses the dependency graph for reachability and text evidence to confirm direct symbol usage.
 */
export function analyzeImpact(index: RepoIndex, graph: DependencyGraph, changes: ImpactChange[], opts: { maxDepth?: number } = {}): ImpactResult {
  const maxDepth = opts.maxDepth ?? 6;
  const byPath = new Map(index.files.map(f => [f.path, f]));
  const hot = new Set(index.hotspots.slice(0, 10).map(h => h.file));
  const changedSet = new Set(changes.map(c => c.file));
  const affected = new Map<string, AffectedFile>();
  const outChanges: ImpactResult['changes'] = [];

  for (const c of changes) {
    const info = byPath.get(c.file);
    let changedSymbols: SymbolInfo[] = [];
    if (info) {
      if (c.symbols?.length) changedSymbols = info.symbols.filter(s => c.symbols!.includes(s.name));
      else if (c.lines?.length) changedSymbols = symbolsAtLines(info, c.lines);
    }
    const direct = graph.dependentsOf(c.file);
    outChanges.push({ file: c.file, status: c.status ?? 'modified', changedSymbols, dependents: new Set(direct.map(e => e.from)).size, isHotspot: hot.has(c.file) });

    // Direct dependents, confirmed by text where we know the symbols.
    const names = changedSymbols.map(s => s.name).filter(n => n.length > 2);
    for (const e of direct) {
      if (changedSet.has(e.from)) continue;
      const text = names.length ? readSafe(index.root, e.from) : '';
      const uses = names.filter(n => new RegExp(`\\b${n.replace(/[$]/g, '\\$')}\\b`, 'i').test(text));
      const confidence: AffectedFile['confidence'] = !names.length ? 'medium' : uses.length ? 'high' : (c.status === 'deleted' ? 'high' : 'low');
      const prev = affected.get(e.from);
      if (!prev || prev.distance > 1 || (prev.confidence !== 'high' && confidence === 'high')) {
        affected.set(e.from, { file: e.from, distance: 1, via: c.file, usesSymbols: uses, confidence, isTest: !!byPath.get(e.from)?.isTest, line: e.line });
      }
    }
    // Transitive dependents (only through files that were really affected, i.e. not "low").
    for (const [f, d] of graph.transitiveDependents(c.file, maxDepth)) {
      if (d < 2 || changedSet.has(f) || affected.has(f)) continue;
      affected.set(f, { file: f, distance: d, via: c.file, usesSymbols: [], confidence: d === 2 ? 'medium' : 'low', isTest: !!byPath.get(f)?.isTest });
    }
  }

  // Drop transitive results that only come through "low" direct links when we have symbol evidence.
  const affectedList = [...affected.values()].sort((a, b) => a.distance - b.distance || (a.confidence === 'high' ? -1 : 1) || a.file.localeCompare(b.file));

  const tests = new Map<string, string>();
  for (const a of affectedList) if (a.isTest) tests.set(a.file, a.distance === 1 ? `imports ${a.via}` : `depends on ${a.via} (distance ${a.distance})`);
  for (const c of changes) {
    if (byPath.get(c.file)?.isTest) tests.set(c.file, 'test file was changed');
    for (const t of conventionTests(index, c.file)) if (!tests.has(t)) tests.set(t, `named after ${c.file.split('/').pop()}`);
  }
  const testList = [...tests.entries()].map(([file, reason]) => ({ file, reason }));

  const nonTest = affectedList.filter(a => !a.isTest);
  const direct = nonTest.filter(a => a.distance === 1).length;
  let score = Math.min(40, direct * 4) + Math.min(25, (nonTest.length - direct) * 1.5);
  if (outChanges.some(c => c.isHotspot)) score += 15;
  if (outChanges.some(c => c.status === 'deleted' && c.dependents > 0)) score += 25;
  if (!testList.length && nonTest.length) score += 15;
  score = Math.round(Math.min(100, score));
  const level = score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low';
  const summary = `${changes.length} changed file(s) affect ${nonTest.length} file(s) (${direct} directly)` +
    (testList.length ? `; ${testList.length} test file(s) to run.` : '; no related tests found.');

  return { changes: outChanges, affected: affectedList, tests: testList, testCommands: testCommandsFor(index, testList.map(t => t.file)), score, level, summary };
}

export function impactReportMarkdown(r: ImpactResult, title = 'DevImpact report', link: (file: string, line?: number) => string = (f, l) => `\`${f}${l ? ':' + l : ''}\``): string {
  const L = [`# ${title}`, '', `**Impact: ${r.level.toUpperCase()} (${r.score}/100)** — ${r.summary}`, ''];
  L.push('## Changed', '');
  for (const c of r.changes) L.push(`- ${link(c.file)} (${c.status})${c.changedSymbols.length ? ` — ${c.changedSymbols.map(s => `\`${s.name}\``).join(', ')}` : ''}${c.isHotspot ? ' 🔥 core file' : ''}`);
  const direct = r.affected.filter(a => a.distance === 1 && !a.isTest);
  const indirect = r.affected.filter(a => a.distance > 1 && !a.isTest);
  L.push('', `## Directly affected (${direct.length})`, '');
  for (const a of direct) L.push(`- ${link(a.file, a.line)} — ${a.usesSymbols.length ? `uses ${a.usesSymbols.map(s => `\`${s}\``).join(', ')}` : `imports ${a.via}`} (${a.confidence} confidence)`);
  if (!direct.length) L.push('_Nothing in the repository depends on the changed code directly._');
  L.push('', `## Indirectly affected (${indirect.length})`, '');
  for (const a of indirect.slice(0, 60)) L.push(`- ${link(a.file)} — distance ${a.distance} via \`${a.via}\``);
  if (indirect.length > 60) L.push(`- … and ${indirect.length - 60} more`);
  L.push('', `## Tests to run (${r.tests.length})`, '');
  for (const t of r.tests) L.push(`- ${link(t.file)} — ${t.reason}`);
  if (!r.tests.length) L.push('⚠️ No tests cover these changes. Consider adding one.');
  if (r.testCommands.length) { L.push('', '```bash'); for (const c of r.testCommands) L.push(c.command); L.push('```'); }
  return L.join('\n') + '\n';
}
