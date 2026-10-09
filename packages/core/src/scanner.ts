import * as fs from 'fs';
import * as path from 'path';

export const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', 'bin', 'obj',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  '.gradle', '.idea', '.vscode-test', 'coverage', '.next', '.nuxt', '.cache',
  'vendor', '.repopilot', '.terraform', 'bower_components', '.angular', '.turbo'
];

/** Convert a simple glob (supports *, **, ?) into a RegExp tested against relative paths. */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/');
  if (g.endsWith('/')) g = g.slice(0, -1);
  const anchored = g.startsWith('/');
  if (anchored) g = g.slice(1);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  const prefix = anchored || g.includes('/') ? '^' : '(^|/)';
  return new RegExp(prefix + re + '($|/)');
}

function readGitignore(root: string): RegExp[] {
  try {
    return fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
      .map(globToRegExp);
  } catch {
    return [];
  }
}

export interface WalkResult {
  files: { rel: string; abs: string; size: number }[];
  truncated: boolean;
}

/** Walk the repository iteratively, honouring default excludes, user globs and the root .gitignore. */
export function walkRepository(
  root: string,
  opts: { exclude?: string[]; maxFiles?: number; isCancelled?: () => boolean } = {}
): WalkResult {
  const maxFiles = opts.maxFiles ?? 20000;
  const dirNames = new Set(DEFAULT_EXCLUDES);
  const patterns = [...readGitignore(root), ...(opts.exclude ?? []).map(globToRegExp)];
  const isIgnored = (rel: string) => patterns.some(p => p.test(rel));

  const files: WalkResult['files'] = [];
  const stack: string[] = [''];
  let truncated = false;

  while (stack.length) {
    if (opts.isCancelled?.()) break;
    const relDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (dirNames.has(e.name) || isIgnored(rel)) continue;
        stack.push(rel);
      } else if (e.isFile()) {
        if (isIgnored(rel)) continue;
        if (files.length >= maxFiles) { truncated = true; break; }
        const abs = path.join(root, rel);
        let size = 0;
        try { size = fs.statSync(abs).size; } catch { continue; }
        files.push({ rel, abs, size });
      }
    }
    if (truncated) break;
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, truncated };
}

/** Heuristic binary check on the first chunk of a buffer. */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
