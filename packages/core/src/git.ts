import { execFile } from 'child_process';

/** What to compare the working tree against. */
export type DiffBase =
  | { kind: 'working' }          // everything not yet committed (staged + unstaged + untracked) vs HEAD
  | { kind: 'staged' }           // only what `git commit` would record
  | { kind: 'ref'; ref: string } // current branch (incl. working changes) vs merge-base with ref, e.g. origin/main
  | { kind: 'commit'; ref: string }; // a single commit vs its parent

export interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number }

export interface ChangedFile {
  /** Path relative to the analysed folder, forward slashes. */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  added: number;
  deleted: number;
  hunks: Hunk[];
  /** Added/modified lines with their new line number. */
  addedLines: { line: number; text: string }[];
  /** Removed lines with their old line number. */
  removedLines: { line: number; text: string }[];
  binary?: boolean;
}

function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try { return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; } catch { return false; }
}

/** Parse `git diff --unified=0` output. Paths are relative to the git root. */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let cur: ChangedFile | undefined;
  let oldLine = 0, newLine = 0;
  const unquote = (p: string) => p.replace(/^"|"$/g, '').replace(/^[ab]\//, '');

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      cur = { path: m ? m[2] : '', status: 'modified', added: 0, deleted: 0, hunks: [], addedLines: [], removedLines: [] };
      if (m && m[1] !== m[2]) { cur.oldPath = m[1]; }
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) cur.status = 'added';
    else if (line.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.oldPath = line.slice(12); }
    else if (line.startsWith('rename to ')) cur.path = line.slice(10);
    else if (line.startsWith('Binary files')) cur.binary = true;
    else if (line.startsWith('--- ')) { /* old path header */ }
    else if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p !== '/dev/null') cur.path = unquote(p);
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        const h: Hunk = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4] };
        cur.hunks.push(h);
        oldLine = h.oldStart; newLine = h.newStart;
      }
    } else if (line.startsWith('+')) {
      cur.added++; cur.addedLines.push({ line: newLine++, text: line.slice(1) });
    } else if (line.startsWith('-')) {
      cur.deleted++; cur.removedLines.push({ line: oldLine++, text: line.slice(1) });
    } else if (line.startsWith(' ')) { oldLine++; newLine++; }
  }
  if (cur && cur.status === 'renamed' && cur.oldPath === cur.path) delete cur.oldPath;
  return files.filter(f => f.path);
}

/** Return changed files relative to `cwd` (which may be a sub-folder of the repository; `--relative` scopes the diff to it). */
export async function getChanges(cwd: string, base: DiffBase = { kind: 'working' }): Promise<ChangedFile[]> {
  const common = ['-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--unified=0', '-M', '--relative'];
  let args: string[];
  switch (base.kind) {
    case 'staged': args = [...common, '--cached']; break;
    case 'ref': {
      const mb = (await git(cwd, ['merge-base', base.ref, 'HEAD'])).trim();
      args = [...common, mb];
      break;
    }
    case 'commit': args = [...common, `${base.ref}^`, base.ref]; break;
    default: {
      let hasHead = true;
      try { await git(cwd, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
      args = hasHead ? [...common, 'HEAD'] : [...common, '--cached'];
    }
  }
  const files = parseUnifiedDiff(await git(cwd, args));

  if (base.kind === 'working' || base.kind === 'ref') {
    // untracked files count as wholly added
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').map(s => s.trim()).filter(Boolean);
    const fs = await import('fs');
    const path = await import('path');
    for (const u of untracked) {
      if (files.some(f => f.path === u)) continue;
      let text = '';
      try {
        const buf = fs.readFileSync(path.join(cwd, u));
        if (buf.length > 2_000_000 || buf.subarray(0, 4096).includes(0)) { files.push({ path: u, status: 'added', added: 0, deleted: 0, hunks: [], addedLines: [], removedLines: [], binary: true }); continue; }
        text = buf.toString('utf8');
      } catch { continue; }
      const lines = text.split(/\r?\n/);
      files.push({
        path: u, status: 'added', added: lines.length, deleted: 0,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length }],
        addedLines: lines.map((t, i) => ({ line: i + 1, text: t })), removedLines: []
      });
    }
  }
  return files.map(f => ({ ...f, path: f.path.replace(/\\/g, '/') }));
}

/** Number of commits touching each path in the last `days` days (hotspot / churn signal). */
export async function getChurn(cwd: string, days = 90): Promise<Map<string, number>> {
  const out = await git(cwd, ['log', `--since=${days}.days`, '--no-merges', '--name-only', '--format=', '--relative']).catch(() => '');
  const counts = new Map<string, number>();
  for (const l of out.split('\n')) {
    const p = l.trim();
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  try { return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { return undefined; }
}

export async function defaultBaseRef(cwd: string): Promise<string | undefined> {
  for (const r of ['origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop']) {
    try { await git(cwd, ['rev-parse', '--verify', '--quiet', r]); return r; } catch { /* try next */ }
  }
  return undefined;
}
