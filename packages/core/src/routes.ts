import * as fs from 'fs';
import * as path from 'path';
import { DependencyGraph } from './graph';
import { FileInfo, RepoIndex } from './types';
import { stripCComments } from './parsers/common';

export interface Endpoint {
  id: string;
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
  /** Handler reference as written, e.g. `listUsers`, `usersController.list`, or `(inline)`. */
  handler: string;
  /** For inline handlers / decorated methods: where the handler body starts. */
  handlerLine?: number;
}

export type FlowKind = 'endpoint' | 'controller' | 'service' | 'repository' | 'function' | 'database' | 'external' | 'unresolved';

export interface FlowNode {
  id: string;
  kind: FlowKind;
  name: string;
  file?: string;
  line?: number;
  detail?: string;
  children: FlowNode[];
}

const read = (root: string, rel: string) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
const joinPath = (...parts: string[]) => ('/' + parts.filter(Boolean).map(p => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')).replace(/\/+/g, '/');

const HTTP = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];

// ------------------------------------------------------------------------------------------------
// Endpoint discovery
// ------------------------------------------------------------------------------------------------

export function findEndpoints(index: RepoIndex, graph?: DependencyGraph): Endpoint[] {
  const out: Endpoint[] = [];
  const mounts: { prefix: string; ident: string; file: string }[] = [];
  const texts = new Map<string, string>();
  const text = (f: string) => texts.get(f) ?? (texts.set(f, read(index.root, f)), texts.get(f)!);

  for (const f of index.files) {
    if (f.isTest || f.size > 800_000) continue;
    const lang = f.language;
    if (lang === 'typescript' || lang === 'javascript') {
      const src = text(f.path);
      if (!/\.(get|post|put|patch|delete|all|route|use)\s*\(|@(Get|Post|Put|Patch|Delete|Controller)\b/.test(src)) continue;
      findExpress(f, stripCComments(src), out, mounts);
      findNest(f, src, out);
    } else if (lang === 'python') {
      const src = text(f.path);
      if (/@\w+\.(route|get|post|put|patch|delete)\(|urlpatterns|path\(/.test(src)) findPython(f, src, out);
    } else if (lang === 'java' || lang === 'kotlin') {
      const src = text(f.path);
      if (/@(Get|Post|Put|Patch|Delete|Request)Mapping|@Path\(/.test(src)) findSpring(f, src, out);
    } else if (lang === 'csharp') {
      const src = text(f.path);
      if (/\[Http(Get|Post|Put|Patch|Delete)|Map(Get|Post|Put|Delete)\(/.test(src)) findAspNet(f, src, out);
    } else if (lang === 'go') {
      const src = text(f.path);
      if (/\.(GET|POST|PUT|PATCH|DELETE|HandleFunc|Handle|Get|Post)\(/.test(src)) findGo(f, src, out);
    }
  }

  // Express / Koa router mounting: app.use('/api/users', usersRouter) -> prefix endpoints of the router's file.
  if (graph && mounts.length) {
    for (const m of mounts) {
      const routerFile = resolveIdentifierFile(index, graph, m.file, m.ident, text(m.file));
      if (!routerFile) continue;
      for (const e of out) if (e.file === routerFile && e.framework === 'Express' && !e.path.startsWith(joinPath(m.prefix))) e.path = joinPath(m.prefix, e.path);
    }
  }
  for (const e of out) e.id = `${e.method} ${e.path} @ ${e.file}:${e.line}`;
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function lineOf(src: string, idx: number) { let n = 1; for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++; return n; }

function findExpress(f: FileInfo, src: string, out: Endpoint[], mounts: { prefix: string; ident: string; file: string }[]) {
  const re = /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|head|options)\s*\(\s*(['"`])([^'"`]*)\3\s*,([^\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const obj = m[1];
    if (/^(axios|http|https|fetch|request|got|superagent|client|api|\$http|map|cache|params|headers|req|res|ctx|config|process|Object|Reflect|localStorage|sessionStorage)$/i.test(obj)) continue;
    if (!m[4].startsWith('/') && m[4] !== '*') continue;
    const rest = m[5].trim();
    const args = rest.split(/,(?![^(]*\))/).map(s => s.trim()).filter(Boolean);
    const last = (args[args.length - 1] ?? '').replace(/\)\s*;?\s*$/, '').trim();
    const inline = /^(async\s*)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(last) || last === '';
    const line = lineOf(src, m.index);
    out.push({ id: '', method: m[2].toUpperCase(), path: m[4], file: f.path, line, framework: 'Express', handler: inline ? '(inline)' : last.replace(/\.bind\(.*$/, ''), handlerLine: inline ? line : undefined });
  }
  const use = /\b[A-Za-z_$][\w$]*\.(?:use|register)\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*([A-Za-z_$][\w$.]*)/g;
  while ((m = use.exec(src))) mounts.push({ prefix: m[2], ident: m[3].split('.')[0], file: f.path });
}

function findNest(f: FileInfo, src: string, out: Endpoint[]) {
  const ctrl = /@Controller\(\s*(?:['"`]([^'"`]*)['"`]|\{[^}]*path\s*:\s*['"`]([^'"`]*)['"`][^}]*\})?\s*\)/.exec(src);
  if (!ctrl) return;
  const base = ctrl[1] ?? ctrl[2] ?? '';
  const re = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)[\s\S]*?\n\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const line = lineOf(src, m.index);
    const mline = lineOf(src, m.index + m[0].length);
    out.push({ id: '', method: m[1].toUpperCase(), path: joinPath(base, m[2] ?? ''), file: f.path, line, framework: 'NestJS', handler: m[3], handlerLine: mline });
  }
}

function findPython(f: FileInfo, src: string, out: Endpoint[]) {
  // blank out docstrings / triple-quoted strings so examples in documentation are not reported
  src = src.replace(/("""|''')[\s\S]*?\1/g, s => s.replace(/[^\n]/g, ' '));
  const lines = src.split(/\r?\n/);
  const prefixes = new Map<string, string>();
  for (const l of lines) {
    const bp = /(\w+)\s*=\s*(?:Blueprint|APIRouter)\(([^)]*)\)/.exec(l);
    if (bp) { const p = /(?:url_prefix|prefix)\s*=\s*['"]([^'"]*)['"]/.exec(bp[2]); prefixes.set(bp[1], p ? p[1] : ''); }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = /^\s*@(\w+)\.route\(\s*['"]([^'"]+)['"](.*)$/.exec(l);
    let methods: string[] = [];
    let route: string | undefined, obj: string | undefined, fw = 'Flask';
    if (m) {
      obj = m[1]; route = m[2];
      const mm = /methods\s*=\s*[\[(]([^\])]+)/.exec(m[3]);
      methods = mm ? mm[1].split(',').map(s => s.replace(/['"\s]/g, '').toUpperCase()).filter(Boolean) : ['GET'];
    } else if ((m = /^\s*@(\w+)\.(get|post|put|patch|delete|head|options|api_route)\(\s*['"]([^'"]*)['"]/.exec(l))) {
      obj = m[1]; route = m[3]; methods = [m[2] === 'api_route' ? 'ANY' : m[2].toUpperCase()]; fw = 'FastAPI';
    }
    if (route !== undefined && obj) {
      let j = i + 1;
      while (j < lines.length && !/^\s*(async\s+)?def\s+\w+/.test(lines[j])) j++;
      const h = /def\s+(\w+)/.exec(lines[j] ?? '');
      for (const meth of methods) out.push({ id: '', method: meth, path: joinPath(prefixes.get(obj) ?? '', route), file: f.path, line: i + 1, framework: fw, handler: h?.[1] ?? '?', handlerLine: j + 1 });
      continue;
    }
    const dj = /^\s*(?:re_)?path\(\s*r?['"]([^'"]*)['"]\s*,\s*([\w.]+)(?:\.as_view\(\))?/.exec(l);
    if (dj && /urlpatterns/.test(src)) {
      if (/^include$/.test(dj[2])) continue;
      out.push({ id: '', method: 'ANY', path: joinPath(dj[1].replace(/^\^|\$$/g, '')), file: f.path, line: i + 1, framework: 'Django', handler: dj[2] });
    }
  }
}

function findSpring(f: FileInfo, src: string, out: Endpoint[]) {
  const code = stripCComments(src);
  const cls = /@(?:RequestMapping|Path)\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?(?:abstract\s+)?(?:class|interface)\b/.exec(code);
  const base = cls ? cls[1] : '';
  const re = /@(Get|Post|Put|Patch|Delete|Request)Mapping(?:\(([^)]*)\))?(?:(?!@(?:Get|Post|Put|Patch|Delete|Request)Mapping)[\s\S])*?\n\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|protected|private)?\s*[\w<>\[\],.? ]+\s+(\w+)\s*\(/g;
  if (cls) re.lastIndex = cls.index + cls[0].length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const args = m[2] ?? '';
    const p = /(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)"/.exec(args)?.[1] ?? '';
    let method = m[1].toUpperCase();
    if (method === 'REQUEST') method = /RequestMethod\.(\w+)/.exec(args)?.[1] ?? 'ANY';
    if (m[1] === 'Request' && cls && m.index < cls.index + cls[0].length) continue;
    out.push({ id: '', method, path: joinPath(base, p), file: f.path, line: lineOf(code, m.index), framework: 'Spring', handler: m[3], handlerLine: lineOf(code, m.index + m[0].length) });
  }
}

function findAspNet(f: FileInfo, src: string, out: Endpoint[]) {
  const ctrlName = /class\s+(\w+?)Controller\b/.exec(src)?.[1]?.toLowerCase() ?? '';
  const route = /\[Route\(\s*"([^"]*)"\s*\)\][\s\S]*?class\s/.exec(src)?.[1]?.replace('[controller]', ctrlName) ?? '';
  const re = /\[Http(Get|Post|Put|Patch|Delete)(?:\(\s*"([^"]*)"\s*\))?\][\s\S]*?\n\s*public\s+[\w<>\[\],. ]+\s+(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ id: '', method: m[1].toUpperCase(), path: joinPath(route, m[2] ?? ''), file: f.path, line: lineOf(src, m.index), framework: 'ASP.NET', handler: m[3], handlerLine: lineOf(src, m.index + m[0].length) });
  const min = /\.Map(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"\s*,\s*([^\n]*)/g;
  while ((m = min.exec(src))) out.push({ id: '', method: m[1].toUpperCase(), path: joinPath(m[2]), file: f.path, line: lineOf(src, m.index), framework: 'ASP.NET', handler: /^\(|=>/.test(m[3]) ? '(inline)' : m[3].replace(/\).*$/, ''), handlerLine: lineOf(src, m.index) });
}

function findGo(f: FileInfo, src: string, out: Endpoint[]) {
  const re = /\b\w+\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|HandleFunc|Handle)\(\s*"([^"]+)"\s*,\s*([^\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (!m[2].startsWith('/')) continue;
    const method = /Handle/.test(m[1]) ? 'ANY' : m[1].toUpperCase();
    const h = m[3].replace(/\)\s*(\.Methods\(.*)?$/, '').trim();
    const mm = /\.Methods\(\s*"(\w+)"/.exec(m[3]);
    out.push({ id: '', method: mm ? mm[1] : method, path: m[2], file: f.path, line: lineOf(src, m.index), framework: 'Go', handler: /^func\b/.test(h) ? '(inline)' : h, handlerLine: /^func\b/.test(h) ? lineOf(src, m.index) : undefined });
  }
}

/** Which repo file does `ident` (imported in `file`) come from? */
function resolveIdentifierFile(index: RepoIndex, graph: DependencyGraph, file: string, ident: string, src: string): string | undefined {
  const re = new RegExp(`(?:import\\s+(?:\\*\\s+as\\s+)?\\{?[^}]*?\\b${ident}\\b[^}]*?\\}?\\s+from\\s+|\\b${ident}\\s*=\\s*require\\(\\s*)['"]([^'"]+)['"]`);
  const m = re.exec(src);
  if (!m) return undefined;
  const e = graph.dependenciesOf(file).find(d => d.specifier === m[1]);
  return e?.to;
}

// ------------------------------------------------------------------------------------------------
// Flow tracing
// ------------------------------------------------------------------------------------------------

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'await', 'async', 'super', 'this', 'print', 'len', 'str', 'int', 'dict', 'list', 'set', 'range', 'isinstance', 'super', 'require', 'import', 'Promise', 'Object', 'Array', 'JSON', 'String', 'Number', 'Boolean', 'Math', 'Date', 'Error', 'console', 'parseInt', 'parseFloat', 'setTimeout', 'next', 'res', 'send', 'json', 'status', 'then', 'catch', 'map', 'filter', 'reduce', 'forEach', 'push', 'join', 'split', 'trim', 'toString', 'includes', 'log', 'get', 'set', 'has', 'keys', 'values', 'entries', 'sizeof', 'elif', 'and', 'or', 'not', 'with', 'assert', 'Ok', 'ok', 'append', 'format', 'items', 'equals', 'valueOf', 'of', 'ResponseEntity', 'Optional', 'List', 'Map', 'HashMap', 'ArrayList', 'println', 'printf', 'Sprintf', 'Errorf', 'make', 'panic', 'jsonify', 'render_template', 'redirect', 'abort']);
const DB_RECEIVER = /^(db|database|prisma|knex|pool|client|conn|connection|sequelize|mongoose|model|repo|repository|session|cursor|em|entityManager|jdbcTemplate|jdbc|collection|query|sql|tx|trx|dataSource|\w*(Repository|Repo|Dao|DAO|Model|Mapper|Table|Collection))$/;
const DB_METHOD = /^(query|execute|executeQuery|executeUpdate|exec|raw|run|all|findOne|findMany|findAll|findById|findBy\w*|findUnique|findFirst|find|save|saveAll|insert\w*|update\w*|upsert|delete\w*|remove|destroy|create|createMany|count|aggregate|select|where|first|get_or_create|filter|fetchall|fetchone|commit|batchUpdate|queryForObject|queryForList)$/;
const EXTERNAL = /\b(fetch\s*\(|axios(\.\w+)?\s*\(|got(\.\w+)?\s*\(|superagent|https?\.request\s*\(|requests\.(get|post|put|patch|delete|request)\s*\(|httpx\.\w+\s*\(|aiohttp|urllib\.request|RestTemplate|WebClient|HttpClient|OkHttpClient|http\.(Get|Post|NewRequest)\s*\(|QSYS2\.HTTP_\w+|HTTPGETCLOB|HTTPPOSTCLOB)/;
const SQL_LITERAL = /['"`]\s*(SELECT\s+[\s\S]{1,200}?\s+FROM\s+[\w.$#@]+|INSERT\s+INTO\s+[\w.$#@]+|UPDATE\s+[\w.$#@]+\s+SET|DELETE\s+FROM\s+[\w.$#@]+)/i;

function kindForPath(p: string): FlowKind {
  if (/controller|routes?|handlers?|views?|resources?|endpoints?|api\//i.test(p)) return 'controller';
  if (/services?|usecases?|use-cases?|domain|logic|managers?/i.test(p)) return 'service';
  if (/repositor(y|ies)|dao|models?|entities|persistence|db|data|store/i.test(p)) return 'repository';
  return 'function';
}

/** Extract the body of a function starting at (1-based) line. */
export function extractBody(src: string, startLine: number, language: string): { text: string; startLine: number } {
  const lines = src.split(/\r?\n/);
  if (language === 'python') {
    const first = lines[startLine - 1] ?? '';
    const indent = /^\s*/.exec(first)![0].length;
    let end = startLine;
    while (end < lines.length && (lines[end].trim() === '' || /^\s*/.exec(lines[end])![0].length > indent || /^\s*\)/.test(lines[end]))) end++;
    return { text: lines.slice(startLine - 1, end).join('\n'), startLine };
  }
  const from = lines.slice(startLine - 1).join('\n');
  const open = from.indexOf('{');
  const arrowExpr = /=>\s*[^{\s]/.exec(from);
  if (open < 0 || (arrowExpr && arrowExpr.index < open)) return { text: lines.slice(startLine - 1, startLine + 3).join('\n'), startLine };
  let depth = 0, i = open, inStr: string | null = null;
  for (; i < from.length; i++) {
    const c = from[i];
    if (inStr) { if (c === '\\') i++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
    if (i - open > 60_000) break;
  }
  return { text: from.slice(0, i + 1), startLine };
}

/** Trace an endpoint through handlers, services, repositories down to database and external calls. */
export function traceEndpoint(index: RepoIndex, graph: DependencyGraph, ep: Endpoint, maxDepth = 5): FlowNode {
  const byPath = new Map(index.files.map(f => [f.path, f]));
  const texts = new Map<string, string>();
  const text = (f: string) => texts.get(f) ?? (texts.set(f, read(index.root, f)), texts.get(f)!);
  const visited = new Set<string>();
  let counter = 0;
  const nid = () => `n${++counter}`;

  const root: FlowNode = { id: nid(), kind: 'endpoint', name: `${ep.method} ${ep.path}`, file: ep.file, line: ep.line, detail: ep.framework, children: [] };

  const locateIn = (f: string, name: string) => {
    const s = byPath.get(f)?.symbols.find(x => x.name === name && ['function', 'method', 'procedure'].includes(x.kind));
    return s ? { file: f, line: s.line, name } : undefined;
  };

  // Locate handler
  const locate = (fromFile: string, ref: string, preferDeps = false): { file: string; line: number; name: string } | undefined => {
    const name = ref.split('.').pop()!.replace(/[^\w$]/g, '');
    if (!name) return undefined;
    const deps = graph.dependenciesOf(fromFile).map(e => e.to);
    // obj.method() on another object -> look in imported files first; bare call -> same file first
    // obj.method() with an unknown object: only trust matches in files this file imports
    const candidates = preferDeps ? [...deps] : [fromFile, ...deps];
    for (const second of graph.dependenciesOf(fromFile)) for (const e of graph.dependenciesOf(second.to)) candidates.push(e.to);
    for (const c of candidates) {
      const fi = byPath.get(c);
      const s = fi?.symbols.find(s => s.name === name && ['function', 'method', 'procedure'].includes(s.kind)) ?? fi?.symbols.find(s => s.name === name);
      if (fi && s) return { file: c, line: s.line, name };
    }
    if (preferDeps) return undefined;
    // repository-wide fallback (unique match only)
    const all = index.files.filter(f => !f.isTest && f.symbols.some(s => s.name === name && ['function', 'method', 'procedure'].includes(s.kind)));
    if (all.length === 1) { const s = all[0].symbols.find(s => s.name === name)!; return { file: all[0].path, line: s.line, name }; }
    return undefined;
  };

  /** Declared type of a field/parameter/variable named `recv` in `file` (Java/Kotlin/TS/C#). */
  const typeOf = (file: string, recv: string): string | undefined => {
    const src = text(file);
    const java = new RegExp(`\\b([A-Z][\\w]*)(?:<[^>]*>)?\\s+${recv}\\s*[;,=)]`).exec(src);
    const ts = new RegExp(`\\b${recv}\\s*[?!]?\\s*:\\s*([A-Z][\\w]*)`).exec(src);
    const py = new RegExp(`\\b(?:self\\.)?${recv}\\s*=\\s*([A-Z][\\w]*)\\(`).exec(src);
    return (java ?? ts ?? py)?.[1];
  };
  const classFile = (type: string): string | undefined =>
    index.files.find(f => !f.isTest && f.symbols.some(s => (s.kind === 'class' || s.kind === 'interface') && s.name === type))?.path;

  const expand = (node: FlowNode, file: string, line: number, depth: number) => {
    const fi = byPath.get(file);
    if (!fi) return;
    const key = `${file}:${line}`;
    if (visited.has(key)) { node.detail = (node.detail ? node.detail + ' · ' : '') + 'already shown above'; return; }
    visited.add(key);
    const { text: body } = extractBody(text(file), line, fi.language);
    const code = fi.language === 'python' ? body.replace(/#[^\n]*/g, '') : stripCComments(body);
    // Calls are searched after the signature: after the opening brace (or the python def line).
    const bodyStart = fi.language === 'python' ? code.indexOf('\n') + 1 : Math.max(0, code.indexOf('{') + 1);
    const firstLine = code.slice(0, bodyStart);
    const callsText = code.slice(bodyStart);

    // database (SQL literal)
    const sql = SQL_LITERAL.exec(code);
    if (sql) node.children.push({ id: nid(), kind: 'database', name: sql[1].replace(/\s+/g, ' ').slice(0, 70), file, line: line + code.slice(0, sql.index).split('\n').length - 1, detail: 'SQL', children: [] });
    // external HTTP
    const ext = EXTERNAL.exec(callsText);
    if (ext) {
      const url = /['"`](https?:\/\/[^'"`\s]+)/.exec(callsText.slice(ext.index, ext.index + 300));
      node.children.push({ id: nid(), kind: 'external', name: url ? url[1].slice(0, 70) : ext[1].replace(/\s*\($/, ''), file, line: line + firstLine.split('\n').length + callsText.slice(0, ext.index).split('\n').length - 2, detail: 'outgoing HTTP call', children: [] });
    }

    if (depth >= maxDepth) return;
    const seen = new Set<string>();
    const callRe = /(?:\b([A-Za-z_$][\w$]*)\s*\.\s*)?\b([A-Za-z_$][\w$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    let added = 0;
    while ((m = callRe.exec(callsText)) && added < 14) {
      const recv = m[1], meth = m[2];
      if (KEYWORDS.has(meth) || (recv && /^(console|JSON|Math|Object|Array|String|Promise|res|req|response|request|ctx|logger|log|self|os|sys|path|fs|util|np|pd|time|datetime|json|re|System|Collections|Arrays|Objects|Optional|strings|fmt|errors|http)$/.test(recv) && !DB_RECEIVER.test(recv))) continue;
      const callLine = line + firstLine.split('\n').length + callsText.slice(0, m.index).split('\n').length - 2;
      const sig = `${recv ?? ''}.${meth}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const rtype = recv && recv !== 'this' && recv !== 'self' ? typeOf(file, recv) : undefined;
      if (recv && (DB_RECEIVER.test(recv) || (rtype && DB_RECEIVER.test(rtype))) && DB_METHOD.test(meth)) {
        const tf = rtype ? classFile(rtype) : undefined;
        const custom = tf ? locateIn(tf, meth) : undefined;
        if (!custom) {
          node.children.push({ id: nid(), kind: 'database', name: `${recv}.${meth}()`, file: tf ?? file, line: tf ? byPath.get(tf)?.symbols.find(s => s.name === rtype)?.line : callLine, detail: rtype ? `data access via ${rtype}` : 'data access', children: [] });
          added++;
          continue;
        }
      }
      const typed = rtype ? classFile(rtype) : undefined;
      const target = (typed && locateIn(typed, meth)) || locate(file, meth, !!recv && recv !== 'this' && recv !== 'self');
      if (!target || (target.file === file && target.line === line)) continue;
      const child: FlowNode = { id: nid(), kind: kindForPath(target.file), name: `${recv && recv !== 'this' ? recv + '.' : ''}${meth}()`, file: target.file, line: target.line, detail: `called at ${file.split('/').pop()}:${callLine}`, children: [] };
      node.children.push(child);
      added++;
      expand(child, target.file, target.line, depth + 1);
    }
  };

  if (ep.handler === '(inline)' || (ep.handlerLine && byPath.get(ep.file)?.symbols.every(s => s.name !== ep.handler.split('.').pop()))) {
    const h: FlowNode = { id: nid(), kind: 'controller', name: ep.handler === '(inline)' ? 'inline handler' : ep.handler, file: ep.file, line: ep.handlerLine ?? ep.line, children: [] };
    root.children.push(h);
    expand(h, ep.file, ep.handlerLine ?? ep.line, 1);
  } else {
    const target = ep.handlerLine && byPath.get(ep.file)?.symbols.some(s => s.name === ep.handler && s.line === ep.handlerLine)
      ? { file: ep.file, line: ep.handlerLine, name: ep.handler }
      : locate(ep.file, ep.handler) ?? (ep.handlerLine ? { file: ep.file, line: ep.handlerLine, name: ep.handler } : undefined);
    if (target) {
      const h: FlowNode = { id: nid(), kind: 'controller', name: `${ep.handler}()`, file: target.file, line: target.line, children: [] };
      root.children.push(h);
      expand(h, target.file, target.line, 1);
    } else {
      root.children.push({ id: nid(), kind: 'unresolved', name: ep.handler, detail: 'handler not found in the repository', children: [] });
    }
  }
  return root;
}

export function flowToMermaid(root: FlowNode): string {
  const L = ['flowchart TD'];
  const label = (n: FlowNode) => `${n.name}${n.file ? `<br/><small>${n.file.split('/').pop()}${n.line ? ':' + n.line : ''}</small>` : ''}`.replace(/"/g, "'");
  const shape = (n: FlowNode) => n.kind === 'database' ? `[("${label(n)}")]` : n.kind === 'external' ? `>"${label(n)}"]` : n.kind === 'endpoint' ? `(["${label(n)}"])` : `["${label(n)}"]`;
  const walk = (n: FlowNode) => { L.push(`  ${n.id}${shape(n)}`); for (const c of n.children) { walk(c); L.push(`  ${n.id} --> ${c.id}`); } };
  walk(root);
  return L.join('\n');
}
