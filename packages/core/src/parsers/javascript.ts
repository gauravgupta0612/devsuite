import { RawReference, SymbolInfo } from '../types';
import { ParseResult, dedupeRefs, eachMatch, lineIndex, stripCComments } from './common';

export function parseJavaScript(src: string, filePath: string): ParseResult {
  const code = stripCComments(src);
  const ln = lineIndex(code);
  const refs: RawReference[] = [];
  const symbols: SymbolInfo[] = [];

  const add = (spec: string, off: number, typeOnly = false) => refs.push({ specifier: spec, kind: 'import', line: ln(off), ...(typeOnly ? { typeOnly } : {}) });
  eachMatch(/\bimport\s+(type\s+)?[\w*{}\s,$]+?\s+from\s+['"]([^'"]+)['"]/, code, m => add(m[2], m.index, !!m[1]));
  eachMatch(/\bimport\s+['"]([^'"]+)['"]/, code, m => add(m[1], m.index));
  eachMatch(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/, code, m => add(m[1], m.index));
  eachMatch(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/, code, m => add(m[1], m.index));
  eachMatch(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/, code, m => add(m[1], m.index));

  const sym = (name: string, kind: SymbolInfo['kind'], off: number, exported: boolean) =>
    symbols.push({ name, kind, line: ln(off), exported });
  eachMatch(/^[ \t]*(export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/m, code,
    m => sym(m[2], 'function', m.index, !!m[1]));
  eachMatch(/^[ \t]*(export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/m, code,
    m => sym(m[2], 'class', m.index, !!m[1]));
  eachMatch(/^[ \t]*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/m, code,
    m => sym(m[2], 'interface', m.index, !!m[1]));
  eachMatch(/^[ \t]*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/m, code,
    m => sym(m[2], 'function', m.index, !!m[1]));

  // class methods (indented, not control-flow keywords)
  eachMatch(/^[ \t]+((?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*)\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^()]|\([^()]*\))*\)\s*(?::\s*[^={;]+)?\{/m, code, m => {
    if (/^(if|for|while|switch|catch|function|return|with|else|do|try|constructor|super|new|typeof|await)$/.test(m[2])) return;
    symbols.push({ name: m[2], kind: 'method', line: ln(m.index), exported: !/private/.test(m[1]) });
  });

  let selfEntry: ParseResult['selfEntry'];
  if (src.startsWith('#!')) selfEntry = { file: filePath, line: 1, note: 'Executable script (shebang)' };
  else {
    const listen = /\b(?:app|server)\.listen\s*\(|\bcreateServer\s*\(|\bNestFactory\.create\s*\(/.exec(code);
    if (listen) selfEntry = { file: filePath, line: ln(listen.index), note: 'Starts an HTTP server' };
    const activate = /\bexport\s+(?:async\s+)?function\s+activate\s*\(|exports\.activate\s*=/.exec(code);
    if (activate) selfEntry = { file: filePath, line: ln(activate.index), note: 'VS Code extension activate()' };
    const render = /\b(?:ReactDOM\.render|createRoot\s*\([^)]*\)\.render|createApp\s*\([^)]*\)\.mount|bootstrapApplication|platformBrowserDynamic\s*\(\)\.bootstrapModule)\b/.exec(code);
    if (render && !selfEntry) selfEntry = { file: filePath, line: ln(render.index), note: 'Mounts the front-end application' };
  }
  return { symbols, references: dedupeRefs(refs), selfEntry };
}
