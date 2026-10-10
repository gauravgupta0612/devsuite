#!/usr/bin/env node
/**
 * CodeGuard command-line scanner — used by the git pre-commit hook and usable in CI:
 *
 *   node codeguard-cli.js [--staged|--working|--base <ref>] [--fail-on critical|high|medium|never] [--json] [--no-index]
 */
import { DiffBase, assessRisk, getChanges, getChurn, graphOf, indexRepository, Severity } from '@devsuite/core';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

async function main(): Promise<number> {
  const cwd = opt('--cwd') ?? process.cwd();
  const base: DiffBase = opt('--base') ? { kind: 'ref', ref: opt('--base')! } : flag('--working') ? { kind: 'working' } : { kind: 'staged' };
  const failOn = (opt('--fail-on') ?? 'critical') as 'critical' | 'high' | 'medium' | 'never';
  const disabled = (opt('--disable') ?? '').split(',').filter(Boolean);
  const changes = await getChanges(cwd, base);
  if (!changes.length) { if (!flag('--json')) console.log('CodeGuard: no changes to scan.'); return 0; }

  let index, graph, churn;
  if (!flag('--no-index')) {
    index = await indexRepository(cwd, { maxFiles: 20000 });
    graph = graphOf(index);
    churn = await getChurn(cwd).catch(() => undefined);
  }
  const r = assessRisk(changes, { index, graph, churn, disabledRules: disabled });
  if (flag('--json')) { console.log(JSON.stringify(r, null, 2)); }
  else {
    const tty = process.stdout.isTTY;
    const c = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
    const col: Record<Severity, number> = { critical: 41, high: 31, medium: 33, low: 36, info: 90 };
    console.log(c(1, `\nCodeGuard — risk ${r.level.toUpperCase()} (${r.score}/100)`) + `  ${r.summary}`);
    for (const f of r.findings.filter(x => x.severity !== 'info')) {
      console.log(`  ${c(col[f.severity], f.severity.toUpperCase().padEnd(8))} ${f.title}${f.file ? `  ${c(2, f.file + (f.line ? ':' + f.line : ''))}` : ''}`);
    }
    const info = r.findings.filter(x => x.severity === 'info').length;
    if (info) console.log(c(2, `  (+${info} informational)`));
  }
  const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  const threshold = failOn === 'never' ? 99 : rank[failOn];
  if (rank[r.level] >= threshold) {
    if (!flag('--json')) console.log(c2(`\nCommit blocked by CodeGuard (fail-on: ${failOn}). Fix the findings above, or bypass once with: git commit --no-verify\n`));
    return 1;
  }
  return 0;
}
const c2 = (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);

main().then(code => process.exit(code), e => { console.error(`CodeGuard: ${e?.message ?? e}`); process.exit(0); /* never block a commit because the scanner itself failed */ });
