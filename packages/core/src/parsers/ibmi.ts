import { RawReference, SymbolInfo } from '../types';
import { ParseResult, dedupeRefs } from './common';

/**
 * IBM i parsers: RPG (fixed, /free and fully-free), CL, DDS, SQL and COBOL.
 *
 * Reference specifiers are namespaced so the resolver knows what to look for:
 *   copy:MEMBER   /COPY or /INCLUDE member (or IFS path)
 *   pgm:NAME      a program call (CALL, EXTPGM, SBMJOB CMD(CALL ...))
 *   proc:NAME     a bound procedure call (CALLP, EXTPROC, CALLPRC, prototypes)
 *   file:NAME     a database / display / printer file (DCL-F, F-spec, DCLF, PFILE, SQL FROM)
 */

const NAME = '[A-Za-z#@$][A-Za-z0-9_#@$]{0,49}';

export function normaliseMember(spec: string): string {
  let s = spec.trim().replace(/^['"]|['"]$/g, '');
  if (s.includes(',')) s = s.split(',').pop()!;   // QRPGLESRC,MEMBER  or LIB/QRPGLESRC,MEMBER
  s = s.replace(/\\/g, '/');
  return s;
}

export function baseName(spec: string): string {
  const s = spec.split('/').pop()!;
  const dot = s.indexOf('.');
  return (dot > 0 ? s.slice(0, dot) : s).toUpperCase();
}

function isFixedComment(line: string): boolean {
  return line.length > 6 && line[6] === '*';
}

export function parseRpg(src: string, filePath: string): ParseResult {
  const lines = src.split(/\r?\n/);
  const refs: RawReference[] = [];
  const symbols: SymbolInfo[] = [];
  const fullyFree = /^\s*\*\*free/i.test(lines[0] ?? '');
  let currentPr: { name: string; line: number; ext: boolean } | null = null;

  const closePr = () => {
    if (currentPr && !currentPr.ext) refs.push({ specifier: `proc:${currentPr.name.toUpperCase()}`, kind: 'call', line: currentPr.line });
    currentPr = null;
  };

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (!fullyFree && isFixedComment(raw)) return;
    let line = raw;
    const sl = line.indexOf('//');
    if (sl >= 0 && !/'[^']*\/\/[^']*'/.test(line)) line = line.slice(0, sl);
    const upper = line.toUpperCase();

    // /COPY and /INCLUDE
    let m = /\/(?:COPY|INCLUDE)\s+((?:'[^']+')|(?:"[^"]+")|[^\s]+)/i.exec(line);
    if (m) {
      refs.push({ specifier: `copy:${normaliseMember(m[1])}`, kind: 'include', line: lineNo });
      return;
    }

    // Fixed-form F spec: column 6 = 'F', file name in columns 7-16.
    if (!fullyFree && /^.{5}F/i.test(line) && line.length > 7 && line[6] !== ' ') {
      const fname = line.slice(6, 16).trim();
      if (new RegExp(`^${NAME}$`).test(fname)) refs.push({ specifier: `file:${fname.toUpperCase()}`, kind: 'file', line: lineNo });
    }
    // Fixed-form P spec: begin procedure
    if (!fullyFree && /^.{5}P/i.test(line) && line.length > 24 && (line[23] === 'B' || line[23] === 'b')) {
      const pname = line.slice(6, 21).trim().replace(/\.\.\.$/, '');
      if (pname) symbols.push({ name: pname, kind: 'procedure', line: lineNo, exported: /\bEXPORT\b/.test(upper) });
    }
    // Fixed-form PR in D spec
    if (!fullyFree && /^.{5}D/i.test(line) && /^PR$/i.test(line.slice(23, 25).trim())) {
      closePr();
      const pname = line.slice(6, 21).trim();
      if (pname) currentPr = { name: pname, line: lineNo, ext: false };
    }

    // Free-form declarations
    m = new RegExp(`\\bDCL-F\\s+(${NAME})`, 'i').exec(line);
    if (m) refs.push({ specifier: `file:${m[1].toUpperCase()}`, kind: 'file', line: lineNo });
    m = new RegExp(`\\bDCL-PROC\\s+(${NAME})`, 'i').exec(line);
    if (m) symbols.push({ name: m[1], kind: 'procedure', line: lineNo, exported: /\bEXPORT\b/.test(upper) });
    m = new RegExp(`\\bDCL-PR\\s+(${NAME})`, 'i').exec(line);
    if (m) { closePr(); currentPr = { name: m[1], line: lineNo, ext: false }; }
    if (/\bEND-PR\b/i.test(line)) closePr();

    // EXTPGM('NAME') / EXTPROC('NAME')
    m = /\bEXTPGM\s*\(\s*'([^']+)'\s*\)/i.exec(line);
    if (m) {
      refs.push({ specifier: `pgm:${baseName(m[1])}`, kind: 'call', line: lineNo });
      if (currentPr) currentPr.ext = true;
    }
    m = /\bEXTPROC\s*\(\s*'([^']+)'\s*\)/i.exec(line);
    if (m) {
      refs.push({ specifier: `proc:${m[1].toUpperCase()}`, kind: 'call', line: lineNo });
      if (currentPr) currentPr.ext = true;
    }
    if (currentPr && /\bEXTPGM\b/i.test(line) && !/\bEXTPGM\s*\(\s*'/i.test(line)) {
      // EXTPGM without a literal (e.g. EXTPGM or EXTPGM(*DCLCASE)) -> program has the prototype's name.
      refs.push({ specifier: `pgm:${currentPr.name.toUpperCase()}`, kind: 'call', line: currentPr.line });
      currentPr.ext = true;
    }

    // CALL 'PGM' (fixed) / CALLP name / CALLB
    m = /\bCALL[B]?\s*(?:\(\w\))?\s+'([^']+)'/i.exec(line);
    if (m) refs.push({ specifier: `pgm:${baseName(m[1])}`, kind: 'call', line: lineNo });
    m = new RegExp(`\\bCALLP(?:\\(\\w+\\))?\\s+(${NAME})`, 'i').exec(line);
    if (m) refs.push({ specifier: `proc:${m[1].toUpperCase()}`, kind: 'call', line: lineNo });

    // Embedded SQL table references
    if (/\bEXEC\s+SQL\b/i.test(line) || /^\s*(SELECT|FROM|JOIN|INSERT|UPDATE|DELETE)\b/i.test(line)) {
      addSqlRefs(line, lineNo, refs);
    }
  });
  closePr();

  symbols.unshift({ name: baseName(filePath), kind: 'program', line: 1, exported: true });
  return { symbols, references: dedupeRefs(refs) };
}

function addSqlRefs(text: string, lineNo: number, refs: RawReference[]): void {
  const re = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+(?:${NAME}[./])?(${NAME})`, 'gi');
  let m: RegExpExecArray | null;
  const skip = new Set(['SELECT', 'TABLE', 'FINAL', 'NEW', 'OLD', 'LATERAL', 'SYSIBM', 'SYSDUMMY1', 'UNNEST', 'VALUES']);
  while ((m = re.exec(text))) {
    const n = m[1].toUpperCase();
    if (!skip.has(n) && !n.startsWith(':')) refs.push({ specifier: `file:${n}`, kind: 'file', line: lineNo });
  }
}

export function parseCl(src: string, filePath: string): ParseResult {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, s => s.replace(/[^\n]/g, ' '));
  const lines = code.split(/\r?\n/);
  const refs: RawReference[] = [];
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    let m: RegExpExecArray | null;
    const callRe = new RegExp(`\\bCALL\\s+(?:PGM\\()?\\s*(?:(?:${NAME}|\\*LIBL|\\*CURLIB)/)?(${NAME})`, 'gi');
    while ((m = callRe.exec(line))) refs.push({ specifier: `pgm:${m[1].toUpperCase()}`, kind: 'call', line: lineNo });
    const prcRe = new RegExp(`\\bCALLPRC\\s+(?:PRC\\()?\\s*'?(${NAME})`, 'gi');
    while ((m = prcRe.exec(line))) refs.push({ specifier: `proc:${m[1].toUpperCase()}`, kind: 'call', line: lineNo });
    const fileRe = new RegExp(`\\b(?:DCLF\\s+(?:FILE\\()?|TOFILE\\(|FILE\\()\\s*(?:(?:${NAME}|\\*LIBL|\\*CURLIB)/)?(${NAME})`, 'gi');
    while ((m = fileRe.exec(line))) refs.push({ specifier: `file:${m[1].toUpperCase()}`, kind: 'file', line: lineNo });
  });
  const symbols: SymbolInfo[] = [{ name: baseName(filePath), kind: 'program', line: 1, exported: true }];
  return { symbols, references: dedupeRefs(refs) };
}

export function parseDds(src: string, filePath: string): ParseResult {
  const refs: RawReference[] = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (isFixedComment(line)) return;
    let m: RegExpExecArray | null;
    const re = new RegExp(`\\b(?:PFILE|JFILE|REF|REFFLD)\\s*\\(([^)]*)\\)`, 'gi');
    while ((m = re.exec(line))) {
      const inner = m[1];
      const names = inner.split(/\s+/).filter(Boolean);
      const isReffld = /^REFFLD/i.test(m[0]);
      const candidates = isReffld ? names.slice(1) : names;
      for (const n of candidates) {
        const nm = n.replace(/^\*LIBL\//i, '').split('/').pop()!.toUpperCase();
        if (new RegExp(`^${NAME}$`).test(nm) && !nm.startsWith('*')) {
          refs.push({ specifier: `file:${nm}`, kind: 'file', line: i + 1 });
        }
      }
    }
  });
  return { symbols: [{ name: baseName(filePath), kind: 'class', line: 1, exported: true }], references: dedupeRefs(refs) };
}

export function parseSql(src: string, filePath: string): ParseResult {
  const code = src.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, s => s.replace(/[^\n]/g, ' '));
  const refs: RawReference[] = [];
  const symbols: SymbolInfo[] = [];
  const lines = code.split(/\n/);
  lines.forEach((line, i) => {
    const create = new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(TABLE|VIEW|INDEX|PROCEDURE|FUNCTION|TRIGGER|ALIAS|SEQUENCE)\\s+(?:${NAME}[./])?(${NAME})`, 'i').exec(line);
    if (create) {
      const kind = /PROCEDURE|FUNCTION|TRIGGER/i.test(create[1]) ? 'procedure' : 'class';
      symbols.push({ name: create[2].toUpperCase(), kind, line: i + 1, exported: true });
    }
    const idx = new RegExp(`\\bON\\s+(?:${NAME}[./])?(${NAME})\\s*\\(`, 'i').exec(line);
    if (idx) refs.push({ specifier: `file:${idx[1].toUpperCase()}`, kind: 'file', line: i + 1 });
    addSqlRefs(line, i + 1, refs);
    const call = new RegExp(`\\bCALL\\s+(?:${NAME}[./])?(${NAME})`, 'i').exec(line);
    if (call) refs.push({ specifier: `proc:${call[1].toUpperCase()}`, kind: 'call', line: i + 1 });
  });
  const own = new Set(symbols.map(s => s.name));
  if (!symbols.length) symbols.push({ name: baseName(filePath), kind: 'class', line: 1, exported: true });
  return { symbols, references: dedupeRefs(refs.filter(r => !own.has(r.specifier.slice(5)))) };
}

export function parseCobol(src: string, filePath: string): ParseResult {
  const refs: RawReference[] = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (isFixedComment(line)) return;
    let m = new RegExp(`\\bCOPY\\s+(?:"([^"]+)"|'([^']+)'|(${NAME}))`, 'i').exec(line);
    if (m) refs.push({ specifier: `copy:${normaliseMember(m[1] ?? m[2] ?? m[3])}`, kind: 'include', line: i + 1 });
    m = /\bCALL\s+['"]([^'"]+)['"]/i.exec(line);
    if (m) refs.push({ specifier: `pgm:${baseName(m[1])}`, kind: 'call', line: i + 1 });
  });
  return { symbols: [{ name: baseName(filePath), kind: 'program', line: 1, exported: true }], references: dedupeRefs(refs) };
}
