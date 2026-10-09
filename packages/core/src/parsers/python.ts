import { RawReference, SymbolInfo } from '../types';
import { ParseResult, dedupeRefs } from './common';

export function parsePython(src: string, filePath: string): ParseResult {
  const lines = src.split(/\r?\n/);
  const refs: RawReference[] = [];
  const symbols: SymbolInfo[] = [];
  let selfEntry: ParseResult['selfEntry'];
  let inTriple: string | null = null;
  let typeCheckIndent = -1;

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    let line = raw;
    // Skip docstrings / triple-quoted blocks (simple state machine).
    if (inTriple) {
      if (line.includes(inTriple)) inTriple = null;
      return;
    }
    const t = /^\s*[rbuRBU]?("""|''')/.exec(line);
    if (t && line.indexOf(t[1], t.index + t[0].length) < 0) { inTriple = t[1]; return; }
    const hash = line.indexOf('#');
    if (hash >= 0) line = line.slice(0, hash);
    if (line.trim()) {
      const indent = /^\s*/.exec(line)![0].length;
      if (typeCheckIndent >= 0 && indent <= typeCheckIndent) typeCheckIndent = -1;
      if (/^\s*if\s+(typing\.|t\.)?TYPE_CHECKING\s*:/.test(line)) { typeCheckIndent = indent; return; }
    }
    const typeOnly = typeCheckIndent >= 0 ? { typeOnly: true } : {};

    let m = /^\s*import\s+(.+)$/.exec(line);
    if (m) {
      for (const part of m[1].split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0].trim();
        if (mod) refs.push({ specifier: mod, kind: 'import', line: lineNo, ...typeOnly });
      }
    }
    m = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+)$/.exec(line);
    if (m) {
      const base = m[1];
      refs.push({ specifier: base, kind: 'import', line: lineNo, ...typeOnly });
      // `from . import x` / `from pkg import submodule` – a name may be a submodule.
      const names = m[2].replace(/[()\\]/g, '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const n of names) {
        if (n === '*') continue;
        const sep = base.endsWith('.') ? '' : '.';
        refs.push({ specifier: `?${base}${sep}${n}`, kind: 'import', line: lineNo, ...typeOnly });
      }
    }
    m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
    if (m) symbols.push({ name: m[2], kind: m[1].length ? 'method' : 'function', line: lineNo, exported: !m[2].startsWith('_') });
    m = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(line);
    if (m) symbols.push({ name: m[2], kind: 'class', line: lineNo, exported: !m[2].startsWith('_') });
    if (/^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(line)) {
      selfEntry = { file: filePath, line: lineNo, note: "Runs as a script (if __name__ == '__main__')" };
    }
    if (!selfEntry && /\b(?:uvicorn\.run|app\.run)\s*\(/.test(line)) {
      selfEntry = { file: filePath, line: lineNo, note: 'Starts a web server' };
    }
  });
  return { symbols, references: dedupeRefs(refs), selfEntry };
}
