import { LanguageId } from './types';

const EXT: Record<string, LanguageId> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.vue': 'javascript', '.svelte': 'javascript',
  '.py': 'python', '.pyw': 'python',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.cs': 'csharp', '.go': 'go',
  // IBM i
  '.rpgle': 'rpgle', '.rpgleinc': 'rpgle', '.rpginc': 'rpgle', '.sqlrpgle': 'sqlrpgle',
  '.rpg': 'rpg', '.rpg38': 'rpg', '.sqlrpg': 'rpg',
  '.clle': 'cl', '.clp': 'cl', '.cl': 'cl', '.cllemod': 'cl',
  '.pf': 'dds', '.lf': 'dds', '.dspf': 'dds', '.prtf': 'dds', '.icff': 'dds',
  '.sql': 'sql', '.sqlprc': 'sql', '.sqludf': 'sql', '.table': 'sql', '.view': 'sql', '.index': 'sql',
  '.cbl': 'cobol', '.cblle': 'cobol', '.sqlcblle': 'cobol', '.cob': 'cobol',
  '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'css', '.less': 'css',
  '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.xml': 'xml',
  '.md': 'markdown', '.sh': 'shell', '.bash': 'shell', '.ps1': 'shell', '.bat': 'shell'
};

/** Languages whose source we parse for symbols and references. */
export const CODE_LANGUAGES: ReadonlySet<LanguageId> = new Set<LanguageId>([
  'typescript', 'javascript', 'python', 'java', 'kotlin', 'csharp', 'go',
  'rpgle', 'sqlrpgle', 'rpg', 'cl', 'dds', 'cmd', 'sql', 'cobol'
]);

export const IBMI_LANGUAGES: ReadonlySet<LanguageId> = new Set<LanguageId>([
  'rpgle', 'sqlrpgle', 'rpg', 'cl', 'dds', 'cmd', 'cobol'
]);

export function detectLanguage(filePath: string): LanguageId {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const parts0 = lower.split('/');
  const parentDir = parts0.length > 1 ? parts0[parts0.length - 2] : '';
  if (lower.endsWith('.cmd')) return /^q.*src$/.test(parentDir) || parentDir === 'qcmdsrc' ? 'cmd' : 'shell';
  if (dot >= 0) {
    const lang = EXT[lower.slice(dot)];
    if (lang) return lang;
  }
  // IBM i source physical-file style folders: qrpglesrc/MEMBER, qclsrc/MEMBER ...
  const parts = lower.split('/');
  const parent = parts.length > 1 ? parts[parts.length - 2] : '';
  if (parent === 'qrpglesrc') return 'rpgle';
  if (parent === 'qrpgsrc') return 'rpg';
  if (parent === 'qclsrc' || parent === 'qcllesrc') return 'cl';
  if (parent === 'qddssrc' || parent === 'qdspsrc') return 'dds';
  if (parent === 'qcmdsrc') return 'cmd';
  if (parent === 'qsqlsrc') return 'sql';
  return 'other';
}

const TEST_PATTERNS = [
  /(^|\/)(__tests__|tests?|spec|specs|testing|qtestsrc)\//i,
  /\.(test|spec)\.[a-z]+$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(py|go)$/i,
  /Tests?\.(java|kt|cs)$/,
  /(^|\/)src\/test\//i
];

export function isTestFile(p: string): boolean {
  return TEST_PATTERNS.some(r => r.test(p));
}

export function languageLabel(l: LanguageId): string {
  const map: Partial<Record<LanguageId, string>> = {
    typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', java: 'Java', kotlin: 'Kotlin',
    csharp: 'C#', go: 'Go', rpgle: 'RPGLE', sqlrpgle: 'SQLRPGLE', rpg: 'RPG III', cl: 'CL', dds: 'DDS',
    cmd: 'Command (CMD)', sql: 'SQL', cobol: 'COBOL', html: 'HTML', css: 'CSS', json: 'JSON', yaml: 'YAML',
    xml: 'XML', markdown: 'Markdown', shell: 'Shell', other: 'Other'
  };
  return map[l] ?? l;
}
