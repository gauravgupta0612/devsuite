import { LanguageId } from '../types';
import { ParseResult } from './common';
import { parseJavaScript } from './javascript';
import { parsePython } from './python';
import { parseCSharp, parseGo, parseJvm } from './jvm';
import { parseCl, parseCobol, parseDds, parseRpg, parseSql } from './ibmi';

export { ParseResult } from './common';

export function parseSource(language: LanguageId, src: string, filePath: string): ParseResult {
  switch (language) {
    case 'typescript':
    case 'javascript': return parseJavaScript(src, filePath);
    case 'python': return parsePython(src, filePath);
    case 'java':
    case 'kotlin': return parseJvm(src, filePath);
    case 'csharp': return parseCSharp(src, filePath);
    case 'go': return parseGo(src, filePath);
    case 'rpgle':
    case 'sqlrpgle':
    case 'rpg': return parseRpg(src, filePath);
    case 'cl': return parseCl(src, filePath);
    case 'dds': return parseDds(src, filePath);
    case 'sql': return parseSql(src, filePath);
    case 'cobol': return parseCobol(src, filePath);
    case 'cmd': return { symbols: [], references: [] };
    default: return { symbols: [], references: [] };
  }
}
