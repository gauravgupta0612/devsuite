import { Evidence, RawReference, SymbolInfo } from '../types';

export interface ParseResult {
  symbols: SymbolInfo[];
  references: RawReference[];
  selfEntry?: Evidence;
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Build a fast offset→line lookup. */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Blank out // and /* *\/ comments for C-family languages while keeping string literals
 * and newlines intact, so offsets and line numbers remain valid.
 */
export function stripCComments(src: string, opts: { hashComments?: boolean } = {}): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n' && q !== '`') break;
        i++;
      }
      i++;
    } else if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
    } else if (opts.hashComments && c === '#') {
      while (i < n && src[i] !== '\n') out[i++] = ' ';
    } else i++;
  }
  return out.join('');
}

export function dedupeRefs(refs: RawReference[]): RawReference[] {
  const seen = new Map<string, RawReference>();
  return refs.filter(r => {
    const k = `${r.kind}|${r.specifier}`;
    const prev = seen.get(k);
    if (prev) { if (prev.typeOnly && !r.typeOnly) delete prev.typeOnly; return false; }
    seen.set(k, r);
    return true;
  });
}

export function eachMatch(re: RegExp, text: string, fn: (m: RegExpExecArray) => void): void {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    fn(m);
    if (m[0].length === 0) g.lastIndex++;
  }
}
