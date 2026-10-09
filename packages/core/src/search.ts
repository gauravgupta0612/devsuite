import * as fs from 'fs';
import * as path from 'path';
import { RepoIndex } from './types';
import { graphOf } from './indexer';

export interface SearchHit {
  file: string;
  score: number;
  reasons: string[];
  line?: number;
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'how', 'what', 'where', 'which', 'who', 'does', 'do', 'in', 'of', 'to',
  'for', 'and', 'or', 'this', 'that', 'it', 'be', 'on', 'with', 'by', 'from', 'can', 'i', 'we', 'you', 'my', 'our',
  'code', 'file', 'files', 'project', 'repo', 'repository', 'work', 'works', 'used', 'use', 'handled', 'handle']);

export function tokenize(q: string): string[] {
  return q
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_#@$]+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

/**
 * Rank repository files for a natural-language question using paths, symbols and (bounded) content.
 * Deterministic and local — used to pick evidence for an LLM answer or to answer directly without one.
 */
export function searchIndex(index: RepoIndex, question: string, limit = 12): SearchHit[] {
  const terms = tokenize(question);
  if (!terms.length) return [];
  const graph = graphOf(index);
  const hits: SearchHit[] = [];

  for (const f of index.files) {
    if (f.language === 'other' && f.size > 200_000) continue;
    let score = 0;
    const reasons: string[] = [];
    let bestLine: number | undefined;
    const lowerPath = f.path.toLowerCase();
    for (const t of terms) {
      if (lowerPath.includes(t)) { score += 6; reasons.push(`path matches "${t}"`); }
      for (const s of f.symbols) {
        const sn = s.name.toLowerCase();
        if (sn === t) { score += 10; reasons.push(`defines ${s.kind} ${s.name}`); bestLine ??= s.line; }
        else if (sn.includes(t)) { score += 4; reasons.push(`${s.kind} ${s.name}`); bestLine ??= s.line; }
      }
    }
    if (score > 0 || (f.size < 300_000 && f.language !== 'other')) {
      try {
        const text = fs.readFileSync(path.join(index.root, f.path), 'utf8').toLowerCase();
        for (const t of terms) {
          let c = 0, pos = text.indexOf(t);
          while (pos >= 0 && c < 20) { c++; pos = text.indexOf(t, pos + t.length); }
          if (c) {
            score += Math.min(6, Math.log2(1 + c) * 2);
            if (bestLine === undefined) bestLine = text.slice(0, text.indexOf(t)).split('\n').length;
          }
        }
      } catch { /* ignore */ }
    }
    if (score > 0) {
      score += Math.min(3, graph.dependentsOf(f.path).length * 0.3); // central files are more explanatory
      if (f.isTest) score *= 0.6;
      hits.push({ file: f.path, score, reasons: [...new Set(reasons)].slice(0, 4), line: bestLine });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Read a window of a file around a line for use as LLM context. */
export function snippet(root: string, file: string, line = 1, radius = 40, maxChars = 6000): string {
  try {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
    const start = Math.max(0, line - 1 - Math.floor(radius / 4));
    const end = Math.min(lines.length, start + radius);
    const body = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
    return body.length > maxChars ? body.slice(0, maxChars) + '\n…' : body;
  } catch {
    return '';
  }
}
