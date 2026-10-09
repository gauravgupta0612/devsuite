import { RawReference, SymbolInfo } from '../types';
import { ParseResult, dedupeRefs, eachMatch, lineIndex, stripCComments } from './common';

/** Java / Kotlin parser. Same-package type usage is emitted as `samepkg:Type` references. */
export function parseJvm(src: string, filePath: string): ParseResult {
  const code = stripCComments(src);
  const ln = lineIndex(code);
  const refs: RawReference[] = [];
  const symbols: SymbolInfo[] = [];

  const pkg = /^\s*package\s+([\w.]+)/m.exec(code);
  eachMatch(/^\s*import\s+(?:static\s+)?(\w+(?:\.\w+)*(?:\.\*)?)\s*;?/m, code, m =>
    refs.push({ specifier: m[1], kind: 'import', line: ln(m.index) }));

  eachMatch(/^[ \t]*(?:@\w+(?:\([^)]*\))?\s*)*((?:public|protected|private|abstract|final|static|sealed|open|data|internal|enum|annotation|inner)\s+)*(class|interface|enum|record|object)\s+([A-Z]\w*)/m,
    code, m => symbols.push({ name: m[3], kind: m[2] === 'interface' ? 'interface' : 'class', line: ln(m.index), exported: !/private/.test(m[1] ?? '') }));
  // Java methods
  eachMatch(/^[ \t]+((?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)+(?:<[^>]+>\s+)?[\w<>\[\],.? ]+\s+([a-z]\w*)\s*\(/m,
    code, m => symbols.push({ name: m[2], kind: 'method', line: ln(m.index), exported: /public|protected/.test(m[1]) }));
  // Kotlin functions
  eachMatch(/^[ \t]*(?:(?:public|private|internal|protected|override|suspend|inline|open)\s+)*fun\s+(?:<[^>]+>\s+)?(?:[\w.]+\.)?([a-zA-Z_]\w*)\s*\(/m,
    code, m => symbols.push({ name: m[1], kind: 'function', line: ln(m.index), exported: true }));

  if (pkg) {
    const own = new Set(symbols.filter(s => s.kind === 'class' || s.kind === 'interface').map(s => s.name));
    const used = new Set<string>();
    eachMatch(/\b([A-Z][A-Za-z0-9_]+)\b/, code.replace(/"(?:\\.|[^"\\])*"/g, '""'), m => {
      if (!own.has(m[1])) used.add(m[1]);
    });
    for (const t of used) refs.push({ specifier: `samepkg:${pkg[1]}:${t}`, kind: 'import', line: 0 });
  }

  let selfEntry: ParseResult['selfEntry'];
  const main = /public\s+static\s+void\s+main\s*\(|^\s*fun\s+main\s*\(/m.exec(code);
  const boot = /@SpringBootApplication\b/.exec(code);
  if (boot) selfEntry = { file: filePath, line: ln(boot.index), note: '@SpringBootApplication' };
  else if (main) selfEntry = { file: filePath, line: ln(main.index), note: 'main() method' };
  return { symbols, references: dedupeRefs(refs), selfEntry };
}

export function parseCSharp(src: string, filePath: string): ParseResult {
  const code = stripCComments(src);
  const ln = lineIndex(code);
  const symbols: SymbolInfo[] = [];
  eachMatch(/^[ \t]*((?:public|internal|private|protected|static|abstract|sealed|partial)\s+)*(class|interface|record|struct|enum)\s+([A-Z]\w*)/m, code,
    m => symbols.push({ name: m[3], kind: m[2] === 'interface' ? 'interface' : 'class', line: ln(m.index), exported: /public/.test(m[1] ?? '') }));
  const main = /static\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/.exec(code);
  return { symbols, references: [], selfEntry: main ? { file: filePath, line: ln(main.index), note: 'Main() method' } : undefined };
}

export function parseGo(src: string, filePath: string): ParseResult {
  const code = stripCComments(src);
  const ln = lineIndex(code);
  const refs: RawReference[] = [];
  const symbols: SymbolInfo[] = [];
  eachMatch(/^import\s+(?:\w+\s+)?"([^"]+)"/m, code, m => refs.push({ specifier: m[1], kind: 'import', line: ln(m.index) }));
  eachMatch(/^import\s*\(([\s\S]*?)\)/m, code, m => {
    eachMatch(/"([^"]+)"/, m[1], mm => refs.push({ specifier: mm[1], kind: 'import', line: ln(m.index + mm.index) }));
  });
  eachMatch(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/m, code,
    m => symbols.push({ name: m[1], kind: 'function', line: ln(m.index), exported: /^[A-Z]/.test(m[1]) }));
  eachMatch(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)/m, code,
    m => symbols.push({ name: m[1], kind: m[2] === 'interface' ? 'interface' : 'class', line: ln(m.index), exported: /^[A-Z]/.test(m[1]) }));
  const isMain = /^package\s+main\b/m.test(code) && /^func\s+main\s*\(/m.exec(code);
  return { symbols, references: dedupeRefs(refs), selfEntry: isMain ? { file: filePath, line: ln(isMain.index), note: 'package main / func main()' } : undefined };
}
