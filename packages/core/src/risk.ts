import { ChangedFile } from './git';
import { DependencyGraph } from './graph';
import { detectLanguage, isTestFile } from './languages';
import { RepoIndex } from './types';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type RiskCategory = 'security' | 'secrets' | 'regression' | 'testing' | 'quality' | 'config' | 'ibmi';

export interface RiskFinding {
  id: string;
  severity: Severity;
  category: RiskCategory;
  title: string;
  detail: string;
  file?: string;
  line?: number;
  evidence?: string;
}

export interface FileRisk { file: string; status: string; added: number; deleted: number; dependents: number; churn: number; score: number }

export interface RiskReport {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  findings: RiskFinding[];
  files: FileRisk[];
  summary: string;
  counts: Record<Severity, number>;
}

interface LineRule {
  id: string;
  severity: Severity;
  category: RiskCategory;
  title: string;
  detail: string;
  re: RegExp;
  /** limit to these languages (detectLanguage ids); omitted = all text */
  langs?: string[];
  /** skip when the file is a test */
  notInTests?: boolean;
  /** skip when this also matches (false-positive filter) */
  unless?: RegExp;
}

const JS = ['typescript', 'javascript'];
const PY = ['python'];
const JVM = ['java', 'kotlin'];
const RPG = ['rpgle', 'sqlrpgle', 'rpg'];
const CL = ['cl'];

export const LINE_RULES: LineRule[] = [
  // ---- secrets
  { id: 'secret-aws', severity: 'critical', category: 'secrets', title: 'AWS access key added', detail: 'Committed cloud credentials are compromised as soon as they are pushed. Revoke the key and load it from the environment or a secret store.', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'secret-private-key', severity: 'critical', category: 'secrets', title: 'Private key added', detail: 'A private key must never be committed. Remove it, rotate it and use a secret store.', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'secret-token', severity: 'critical', category: 'secrets', title: 'Access token added', detail: 'Looks like a GitHub/Slack/Google/OpenAI-style token. Revoke it and read it from the environment instead.', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{32,}|sk-ant-[A-Za-z0-9_-]{20,})\b/ },
  { id: 'secret-assignment', severity: 'high', category: 'secrets', title: 'Hard-coded password or secret', detail: 'A credential-like value is assigned to a literal. Move it to configuration or a secret store.', re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*['"][^'"\s$%{}<>]{6,}['"]/i, unless: /(example|placeholder|changeme|dummy|test|xxxx|\*\*\*\*|<.*>|process\.env|os\.environ|getenv)/i, notInTests: true },
  { id: 'secret-conn-string', severity: 'high', category: 'secrets', title: 'Credentials inside a connection string', detail: 'User and password embedded in a URL. Use environment variables.', re: /[a-z][a-z0-9+.-]*:\/\/[^\s:/'"@]+:[^\s@'"]{3,}@[^\s'"]+/i, unless: /(user:pass|username:password|\$\{|<)/i },
  // ---- security
  { id: 'sec-eval', severity: 'high', category: 'security', title: 'Dynamic code execution', detail: 'eval / new Function / exec on dynamic input enables code injection.', re: /\b(eval\s*\(|new\s+Function\s*\(|exec\s*\(\s*(f['"]|[^'")]*\+))/, langs: [...JS, ...PY] },
  { id: 'sec-shell', severity: 'high', category: 'security', title: 'Shell command built from variables', detail: 'Command strings assembled with concatenation or interpolation are open to injection. Pass arguments as an array.', re: /(child_process|\bexecSync|\bexec)\s*\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)|subprocess\.\w+\([^)]*shell\s*=\s*True|os\.system\(\s*(f['"]|[^)]*\+)|Runtime\.getRuntime\(\)\.exec\(/ },
  { id: 'sec-sql-concat', severity: 'high', category: 'security', title: 'SQL built by string concatenation', detail: 'Use parameterised queries / bind variables instead of concatenating values into SQL.', re: /(['"`]\s*(SELECT|INSERT|UPDATE|DELETE)\b[^'"`]*['"`]\s*\+\s*\w)|(\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b[^'"`]*\$\{)|(f['"]\s*(SELECT|INSERT|UPDATE|DELETE)\b[^'"]*\{)/i },
  { id: 'sec-tls', severity: 'high', category: 'security', title: 'TLS certificate verification disabled', detail: 'Disabling certificate checks allows man-in-the-middle attacks.', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|TrustAllCerts|ALLOW_ALL_HOSTNAME_VERIFIER/ },
  { id: 'sec-xss', severity: 'medium', category: 'security', title: 'Raw HTML injection', detail: 'Setting innerHTML / dangerouslySetInnerHTML with dynamic data can cause XSS.', re: /\.innerHTML\s*=(?!\s*['"`]\s*['"`])|dangerouslySetInnerHTML|v-html=|\|\s*safe\b/, langs: [...JS, 'html', 'python'] },
  { id: 'sec-deserialize', severity: 'high', category: 'security', title: 'Unsafe deserialisation', detail: 'pickle / yaml.load / ObjectInputStream on untrusted data can execute code.', re: /pickle\.loads?\(|yaml\.load\((?![^)]*Loader)|new\s+ObjectInputStream\(/ },
  { id: 'sec-weak-hash', severity: 'medium', category: 'security', title: 'Weak hash algorithm', detail: 'MD5/SHA-1 are not safe for passwords or signatures.', re: /\b(createHash\(\s*['"](md5|sha1)['"]|hashlib\.(md5|sha1)\(|MessageDigest\.getInstance\(\s*"(MD5|SHA-?1)")/i },
  { id: 'sec-cors', severity: 'medium', category: 'security', title: 'CORS open to every origin', detail: 'A wildcard origin with credentials exposes the API to any site.', re: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*|origin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*['"]\*/ },
  // ---- quality / regression
  { id: 'q-focused-test', severity: 'high', category: 'testing', title: 'Focused test left in (.only)', detail: '`.only` makes the whole suite silently skip every other test in CI.', re: /\b(it|describe|test|context)\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(/, langs: JS },
  { id: 'q-skipped-test', severity: 'medium', category: 'testing', title: 'Test disabled', detail: 'A test was skipped or disabled; make sure that is intentional and tracked.', re: /\b(it|describe|test)\.skip\s*\(|\bxit\s*\(|@Disabled\b|@Ignore\b|@pytest\.mark\.skip|@unittest\.skip/ },
  { id: 'q-debugger', severity: 'medium', category: 'quality', title: 'Debugger statement', detail: 'Remove debugger / breakpoint calls before committing.', re: /^\s*debugger\s*;?\s*$|\bbreakpoint\(\)|\bpdb\.set_trace\(\)|binding\.pry/ },
  { id: 'q-console', severity: 'low', category: 'quality', title: 'Debug logging added', detail: 'console.log / print / System.out debugging output in production code.', re: /\bconsole\.(log|debug)\(|^\s*print\(|System\.(out|err)\.println\(|\bDSPLY\b/i, notInTests: true, unless: /logger|log\.(info|warn|error)/i },
  { id: 'q-suppress', severity: 'low', category: 'quality', title: 'Type/lint check suppressed', detail: 'Suppressions hide real problems; prefer fixing the underlying issue.', re: /@ts-ignore|@ts-nocheck|eslint-disable|# type:\s*ignore|# noqa|@SuppressWarnings\(/ },
  { id: 'q-todo', severity: 'info', category: 'quality', title: 'New TODO/FIXME', detail: 'Unfinished work is being committed.', re: /\b(TODO|FIXME|HACK|XXX)\b/ },
  { id: 'q-catch-all', severity: 'medium', category: 'quality', title: 'Error swallowed', detail: 'An empty catch / bare except hides failures and makes bugs hard to diagnose.', re: /catch\s*\([^)]*\)\s*\{\s*\}|except\s*:\s*(pass)?\s*$|except\s+Exception\s*:\s*pass/ },
  // ---- IBM i
  { id: 'ibmi-monmsg-all', severity: 'medium', category: 'ibmi', title: 'MONMSG CPF0000 without action', detail: 'Monitoring every CPF message without EXEC silently ignores all errors in the CL program.', re: /\bMONMSG\s+(MSGID\()?\s*CPF0000\s*\)?\s*$/i, langs: CL },
  { id: 'ibmi-hardcoded-lib', severity: 'medium', category: 'ibmi', title: 'Hard-coded library', detail: 'Qualified library names break promotion between environments; prefer *LIBL or a parameter.', re: /\b(PGM|FILE|TOFILE|CMD|SRCFILE)\(\s*(?!\*LIBL|\*CURLIB|QSYS|QGPL|QTEMP|&)[A-Z][A-Z0-9_#@$]{1,9}\//i, langs: [...CL, ...RPG, 'cmd'] },
  { id: 'ibmi-qcmdexc-concat', severity: 'high', category: 'ibmi', title: 'QCMDEXC command built from variables', detail: 'Commands assembled with + or %TRIM before QCMDEXC are an injection and quoting risk; validate inputs or use dedicated APIs.', re: /QCMDEXC|qcmdexc/, langs: RPG, unless: /^\s*dcl-pr\b|EXTPGM/i },
  { id: 'ibmi-select-star', severity: 'low', category: 'ibmi', title: 'SELECT * in embedded SQL', detail: 'SELECT * couples the program to the table layout; adding a column can break FETCH INTO data structures.', re: /\bSELECT\s+\*\s+(INTO|FROM)\b/i, langs: [...RPG, 'cobol'] },
  { id: 'ibmi-no-sqlcode', severity: 'info', category: 'ibmi', title: 'Embedded SQL without SQLSTATE check nearby', detail: 'Check SQLSTATE/SQLCODE after EXEC SQL to catch failures.', re: /\bEXEC\s+SQL\b(?!.*(SET\s+OPTION|INCLUDE|DECLARE))/i, langs: RPG }
];

const CONFIG_RULES: { re: RegExp; severity: Severity; title: string; detail: string }[] = [
  { re: /(^|\/)\.env(\.[\w-]+)?$/, severity: 'critical', title: '.env file committed', detail: 'Environment files usually contain secrets. Remove it from the commit and add it to .gitignore.' },
  { re: /\.(pem|key|p12|pfx|jks|keystore)$/i, severity: 'critical', title: 'Key / certificate file committed', detail: 'Key material should never be in source control.' },
  { re: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|go\.sum)$/, severity: 'info', title: 'Lock file changed', detail: 'Dependency versions change; review the diff for unexpected upgrades.' },
  { re: /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?|go\.mod|.*\.csproj)$/, severity: 'medium', title: 'Dependencies / build configuration changed', detail: 'Build or dependency changes can break every consumer; run the full build and test suite.' },
  { re: /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$|(^|\/)\.github\/workflows\/|\.gitlab-ci\.yml$|Jenkinsfile$|(^|\/)(k8s|helm|terraform|infra)\//, severity: 'medium', title: 'Deployment / CI configuration changed', detail: 'Infrastructure changes affect every build and release; get a second reviewer.' },
  { re: /(^|\/)(migrations?|db\/migrate|alembic\/versions|flyway|liquibase)\//i, severity: 'high', title: 'Database migration', detail: 'Schema migrations are hard to roll back. Check backward compatibility and run it against a copy of production data.' },
  { re: /\.(pf|lf)$/i, severity: 'high', title: 'IBM i physical/logical file (DDS) changed', detail: 'A record-format change changes the format level identifier: every program using this file must be recompiled (CPF4131 otherwise).' },
  { re: /(^|\/)qsqlsrc\/.*\.(table|sql)$|\.table$/i, severity: 'medium', title: 'SQL table definition changed', detail: 'Programs reading this table with fixed data structures or SELECT * may need recompiling.' }
];

const W: Record<Severity, number> = { critical: 40, high: 18, medium: 7, low: 2, info: 0 };
const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
const CODE_LANGS = new Set(['typescript', 'javascript', 'python', 'java', 'kotlin', 'csharp', 'go', 'rpgle', 'sqlrpgle', 'rpg', 'cl', 'cobol', 'sql']);

/** Prioritised risk report for a set of changed files (staged changes, a branch, a commit...). */
export function assessRisk(changes: ChangedFile[], ctx: { index?: RepoIndex; graph?: DependencyGraph; churn?: Map<string, number>; disabledRules?: string[] } = {}): RiskReport {
  const findings: RiskFinding[] = [];
  const disabled = new Set(ctx.disabledRules ?? []);
  const add = (f: RiskFinding) => { if (!disabled.has(f.id)) findings.push(f); };
  const files: FileRisk[] = [];
  const anyTestChanged = changes.some(c => isTestFile(c.path));
  const repoHasTests = (ctx.index?.testFiles ?? 0) > 0;

  for (const c of changes) {
    const lang = detectLanguage(c.path);
    const isTest = isTestFile(c.path);
    const dependents = ctx.graph ? new Set(ctx.graph.dependentsOf(c.path).map(e => e.from)).size : 0;
    const churn = ctx.churn?.get(c.path) ?? 0;
    const before = findings.length;

    // file-level config rules
    for (const r of CONFIG_RULES) {
      if (r.re.test(c.path) && !(c.status === 'deleted' && r.severity === 'critical')) {
        const extra = /DDS|SQL table/.test(r.title) && dependents ? ` ${dependents} file(s) in this repository use it.` : '';
        add({ id: 'config', severity: r.severity, category: /IBM i|SQL table/.test(r.title) ? 'ibmi' : 'config', title: r.title, detail: r.detail + extra, file: c.path });
      }
    }

    // line rules on added lines
    if (!c.binary) {
      const seen = new Set<string>();
      for (const al of c.addedLines) {
        if (al.text.length > 2000 || /codeguard-ignore/i.test(al.text)) continue;
        for (const r of LINE_RULES) {
          if (r.langs && !r.langs.includes(lang)) continue;
          if (r.notInTests && isTest) continue;
          if (!r.re.test(al.text) || (r.unless && r.unless.test(al.text))) continue;
          if (r.id === 'ibmi-qcmdexc-concat' && !/[+]|%TRIM|%CHAR|%SUBST/i.test(al.text)) continue;
          const key = `${r.id}`;
          const count = [...seen].filter(k => k === key).length;
          seen.add(key);
          if (count >= 1 && r.severity !== 'critical') continue; // one per rule per file, except secrets
          add({ id: r.id, severity: r.severity, category: r.category, title: r.title, detail: r.detail, file: c.path, line: al.line,
            evidence: r.category === 'secrets' ? al.text.trim().replace(/(['"`:=]\s*)[^'"`\s]{4}([^'"`\s]+)/g, '$1****') .slice(0, 160) : al.text.trim().slice(0, 160) });
        }
      }
    }

    // deleted / renamed files that others still depend on
    if ((c.status === 'deleted' || c.status === 'renamed') && ctx.graph) {
      const target = c.status === 'renamed' ? c.oldPath ?? c.path : c.path;
      const base = target.split('/').pop()!.replace(/\.[^.]+$/, '');
      const byPath = new Map(changes.map(x => [x.path, x]));
      // A changed dependent still counts unless its diff removed the reference and did not re-add it.
      const deps = ctx.graph.dependentsOf(target).filter(e => {
        const d = byPath.get(e.from);
        if (!d) return true;
        if (d.status === 'deleted') return false;
        const removedRef = d.removedLines.some(l => l.text.includes(base));
        const addedRef = d.addedLines.some(l => l.text.includes(base));
        return !(removedRef && !addedRef);
      });
      if (deps.length) add({ id: 'reg-broken-import', severity: 'critical', category: 'regression', title: c.status === 'deleted' ? 'Deleted file is still referenced' : 'Renamed file is still referenced by its old path', detail: `${deps.length} file(s) still import/use it: ${deps.slice(0, 5).map(d => d.from).join(', ')}${deps.length > 5 ? '…' : ''}`, file: target });
    }

    // removed exported symbols that dependents might use
    if (!c.binary && c.status !== 'deleted' && ctx.graph && dependents && CODE_LANGS.has(lang)) {
      const removedExports = new Set<string>();
      for (const rl of c.removedLines) {
        const m = /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_$][\w$]*)|^def\s+([A-Za-z]\w*)|public\s+(?:static\s+)?[\w<>\[\]]+\s+([a-z]\w*)\s*\(|dcl-proc\s+(\w+)\s+export/i.exec(rl.text);
        const n = m && (m[1] ?? m[2] ?? m[3] ?? m[4]);
        if (n) removedExports.add(n);
      }
      for (const al of c.addedLines) for (const n of [...removedExports]) if (new RegExp(`\\b${n}\\b`).test(al.text)) removedExports.delete(n);
      if (removedExports.size) add({ id: 'reg-removed-export', severity: 'high', category: 'regression', title: 'Public API removed or renamed', detail: `${[...removedExports].slice(0, 6).join(', ')} no longer exist(s) but ${dependents} file(s) depend on ${c.path}. Check every caller.`, file: c.path });
    }

    // blast radius
    if (!isTest && dependents >= 10) add({ id: 'reg-blast', severity: dependents >= 25 ? 'high' : 'medium', category: 'regression', title: 'Wide blast radius', detail: `${dependents} files depend directly on this file; a mistake here propagates widely.`, file: c.path });
    if (!isTest && churn >= 12) add({ id: 'reg-churn', severity: 'medium', category: 'regression', title: 'Frequently changed hotspot', detail: `Changed in ${churn} commits in the last 90 days — hotspots correlate with defects. Review carefully.`, file: c.path });

    const size = c.added + c.deleted;
    if (size > 500 && !/lock|\.min\.|generated|snapshot/i.test(c.path)) add({ id: 'q-large', severity: 'medium', category: 'quality', title: 'Very large change', detail: `${size} lines changed in one file; large diffs hide defects and are hard to review. Consider splitting.`, file: c.path });

    const fileScore = findings.slice(before).reduce((s, f) => s + W[f.severity], 0) + Math.min(10, dependents) + Math.min(5, Math.floor(churn / 4));
    files.push({ file: c.path, status: c.status, added: c.added, deleted: c.deleted, dependents, churn, score: Math.min(100, fileScore) });
  }

  // missing tests
  const sourceChanged = changes.filter(c => !isTestFile(c.path) && CODE_LANGS.has(detectLanguage(c.path)) && c.status !== 'deleted' && c.added + c.deleted > 3);
  if (sourceChanged.length && !anyTestChanged) {
    const important = sourceChanged.filter(c => (files.find(f => f.file === c.path)?.dependents ?? 0) >= 3);
    add({ id: 'test-missing', severity: important.length ? 'high' : repoHasTests ? 'medium' : 'low', category: 'testing',
      title: 'Code changed without test changes',
      detail: `${sourceChanged.length} source file(s) changed but no test file was added or updated` + (important.length ? `, including widely used ${important.slice(0, 3).map(c => c.path).join(', ')}.` : '.') + (repoHasTests ? '' : ' The repository has no detected tests.') });
  }

  findings.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || (a.file ?? '').localeCompare(b.file ?? ''));
  const counts = Object.fromEntries(ORDER.map(s => [s, findings.filter(f => f.severity === s).length])) as Record<Severity, number>;
  const raw = findings.reduce((s, f) => s + W[f.severity], 0);
  const score = Math.min(100, Math.round(raw));
  // The level is at least as severe as the worst finding; many smaller findings can raise it further.
  const level = counts.critical ? 'critical' : (counts.high || score >= 50) ? 'high' : (counts.medium || score >= 20) ? 'medium' : 'low';
  const summary = changes.length
    ? `${changes.length} file(s), +${changes.reduce((s, c) => s + c.added, 0)}/−${changes.reduce((s, c) => s + c.deleted, 0)} lines: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`
    : 'No changes to review.';
  files.sort((a, b) => b.score - a.score);
  return { score, level, findings, files, summary, counts };
}

export function riskReportMarkdown(r: RiskReport, title = 'CodeGuard risk report', link: (file: string, line?: number) => string = (f, l) => `\`${f}${l ? ':' + l : ''}\``): string {
  const icon: Record<Severity, string> = { critical: '🛑', high: '🔴', medium: '🟠', low: '🟡', info: 'ℹ️' };
  const L = [`# ${title}`, '', `**Risk: ${r.level.toUpperCase()} (${r.score}/100)** — ${r.summary}`, ''];
  if (!r.findings.length) L.push('✅ No risks detected in these changes.', '');
  for (const sev of ORDER) {
    const fs = r.findings.filter(f => f.severity === sev);
    if (!fs.length) continue;
    L.push(`## ${icon[sev]} ${sev[0].toUpperCase() + sev.slice(1)} (${fs.length})`, '');
    for (const f of fs) {
      L.push(`- **${f.title}**${f.file ? ` — ${link(f.file, f.line)}` : ''}  `);
      L.push(`  ${f.detail}${f.evidence ? `  \n  \`${f.evidence.replace(/`/g, "'")}\`` : ''}`);
    }
    L.push('');
  }
  if (r.files.length) {
    L.push('## Files by risk', '', '| File | Change | +/− | Dependents | Commits (90d) | Score |', '|---|---|---:|---:|---:|---:|');
    for (const f of r.files.slice(0, 40)) L.push(`| ${link(f.file)} | ${f.status} | +${f.added}/−${f.deleted} | ${f.dependents} | ${f.churn} | ${f.score} |`);
    L.push('');
  }
  return L.join('\n');
}
