import * as fs from 'fs';
import * as path from 'path';
import { BuildCommand, Detection, Evidence, ExternalDependency, FileInfo } from './types';

export interface ManifestFindings {
  frameworks: Detection[];
  buildSystems: Detection[];
  buildCommands: BuildCommand[];
  externalDependencies: ExternalDependency[];
  /** package.json "main"/"bin"/VS Code "main", pyproject scripts, etc. */
  declaredEntries: { file: string; reason: string; evidence: Evidence }[];
  goModule?: { dir: string; module: string };
  pythonRoots: string[];
}

function read(root: string, rel: string): string | undefined {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return undefined; }
}

function lineOf(text: string, needle: string | RegExp): number | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (typeof needle === 'string' ? lines[i].includes(needle) : needle.test(lines[i])) return i + 1;
  }
  return undefined;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (dir: string, f: string) => (dir ? `${dir}/${f}` : f).replace(/\/\.\//g, '/').replace(/^\.\//, '');

const NPM_FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['react', 'React'], ['vue', 'Vue'], ['@angular/core', 'Angular'],
  ['svelte', 'Svelte'], ['@sveltejs/kit', 'SvelteKit'], ['express', 'Express'], ['fastify', 'Fastify'],
  ['koa', 'Koa'], ['@nestjs/core', 'NestJS'], ['@hapi/hapi', 'hapi'], ['electron', 'Electron'],
  ['react-native', 'React Native'], ['vite', 'Vite'], ['webpack', 'webpack'], ['jest', 'Jest'],
  ['vitest', 'Vitest'], ['mocha', 'Mocha'], ['@playwright/test', 'Playwright'], ['cypress', 'Cypress'],
  ['prisma', 'Prisma'], ['typeorm', 'TypeORM'], ['sequelize', 'Sequelize'], ['mongoose', 'Mongoose'],
  ['graphql', 'GraphQL'], ['@modelcontextprotocol/sdk', 'MCP SDK'], ['@ibm/mapepire-js', 'Mapepire (IBM i)'],
  ['itoolkit', 'itoolkit (IBM i)'], ['idb-connector', 'idb-connector (IBM i)'], ['odbc', 'ODBC']
];
const PY_FRAMEWORKS: [RegExp, string][] = [
  [/^django\b/i, 'Django'], [/^flask\b/i, 'Flask'], [/^fastapi\b/i, 'FastAPI'], [/^starlette\b/i, 'Starlette'],
  [/^pytest\b/i, 'pytest'], [/^sqlalchemy\b/i, 'SQLAlchemy'], [/^celery\b/i, 'Celery'], [/^pandas\b/i, 'pandas'],
  [/^numpy\b/i, 'NumPy'], [/^torch\b/i, 'PyTorch'], [/^tensorflow\b/i, 'TensorFlow'], [/^streamlit\b/i, 'Streamlit'],
  [/^pydantic\b/i, 'Pydantic'], [/^mcp\b/i, 'MCP SDK'], [/^pyodbc\b/i, 'pyodbc'], [/^itoolkit\b/i, 'itoolkit (IBM i)']
];
const JVM_FRAMEWORKS: [RegExp, string][] = [
  [/spring-boot/, 'Spring Boot'], [/spring-(core|context|webmvc)/, 'Spring'], [/quarkus/, 'Quarkus'],
  [/micronaut/, 'Micronaut'], [/junit/, 'JUnit'], [/hibernate/, 'Hibernate'], [/jakarta\.|javax\.servlet/, 'Jakarta EE'],
  [/jt400|jtopen/, 'JTOpen (IBM i)'], [/ktor/, 'Ktor'], [/android/, 'Android']
];

export function detectManifests(root: string, files: FileInfo[]): ManifestFindings {
  const frameworks = new Map<string, Detection>();
  const buildSystems = new Map<string, Detection>();
  const buildCommands: BuildCommand[] = [];
  const externalDependencies: ExternalDependency[] = [];
  const declaredEntries: ManifestFindings['declaredEntries'] = [];
  const pythonRoots = new Set<string>(['']);
  let goModule: ManifestFindings['goModule'];
  const paths = new Set(files.map(f => f.path));

  const addDet = (map: Map<string, Detection>, name: string, ev: Evidence, confidence: Detection['confidence'] = 'high') => {
    const d = map.get(name);
    if (d) { if (d.evidence.length < 5) d.evidence.push(ev); }
    else map.set(name, { name, confidence, evidence: [ev] });
  };
  const allPaths = [...paths];
  const named = (base: string) => allPaths.filter(p => p === base || p.endsWith('/' + base));

  // ---------- npm / Node ----------
  for (const pj of named('package.json')) {
    const text = read(root, pj);
    if (!text) continue;
    let json: any;
    try { json = JSON.parse(text); } catch { continue; }
    const dir = dirOf(pj);
    const pm = paths.has(join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : paths.has(join(dir, 'yarn.lock')) ? 'yarn'
      : paths.has(join(dir, 'bun.lockb')) ? 'bun' : 'npm';
    addDet(buildSystems, pm === 'npm' ? 'npm' : pm, { file: pj, note: 'package.json' });
    const scripts = json.scripts ?? {};
    for (const [name, cmd] of Object.entries<string>(scripts)) {
      buildCommands.push({
        label: `${dir || '.'}: ${name}`,
        command: pm === 'npm' ? (name === 'start' || name === 'test' ? `npm ${name}` : `npm run ${name}`) : `${pm} ${name}`,
        cwd: dir, tool: pm, evidence: { file: pj, line: lineOf(text, `"${name}"`), note: String(cmd) }
      });
    }
    const deps = { ...(json.dependencies ?? {}) };
    const dev = { ...(json.devDependencies ?? {}), ...(json.peerDependencies ?? {}) };
    for (const [n, v] of Object.entries<string>(deps)) externalDependencies.push({ name: n, version: v, ecosystem: 'npm', evidence: { file: pj, line: lineOf(text, `"${n}"`) } });
    for (const [n, v] of Object.entries<string>(dev)) externalDependencies.push({ name: n, version: v, ecosystem: 'npm', dev: true, evidence: { file: pj, line: lineOf(text, `"${n}"`) } });
    for (const [dep, label] of NPM_FRAMEWORKS) {
      if (dep in deps || dep in dev) addDet(frameworks, label, { file: pj, line: lineOf(text, `"${dep}"`) });
    }
    if (json.engines?.vscode) addDet(frameworks, 'VS Code Extension API', { file: pj, line: lineOf(text, '"vscode"') });
    if ('typescript' in deps || 'typescript' in dev) addDet(buildSystems, 'TypeScript compiler (tsc)', { file: pj, line: lineOf(text, '"typescript"') });
    const resolveMain = (m: string) => {
      const c = join(dir, m.replace(/^\.\//, ''));
      const candidates = [c, c + '.js', c + '.ts', c.replace(/^(.*\/)?(dist|out|lib|build)\//, '$1src/').replace(/\.js$/, '.ts')];
      return candidates.find(x => paths.has(x)) ?? c;
    };
    if (typeof json.main !== 'string' && paths.has(join(dir, 'index.js'))) declaredEntries.push({ file: join(dir, 'index.js'), reason: 'package.json default entry (index.js)', evidence: { file: pj } });
    if (typeof json.main === 'string') declaredEntries.push({ file: resolveMain(json.main), reason: 'package.json "main"', evidence: { file: pj, line: lineOf(text, '"main"') } });
    const bins = typeof json.bin === 'string' ? { [json.name ?? 'bin']: json.bin } : json.bin ?? {};
    for (const [n, b] of Object.entries<string>(bins)) declaredEntries.push({ file: resolveMain(b), reason: `CLI command "${n}" (package.json "bin")`, evidence: { file: pj, line: lineOf(text, '"bin"') } });
  }
  for (const f of named('tsconfig.json')) addDet(buildSystems, 'TypeScript compiler (tsc)', { file: f });
  for (const f of allPaths.filter(p => /(^|\/)(vite|webpack|rollup|esbuild)\.config\.[cm]?[jt]s$/.test(p))) {
    addDet(buildSystems, /vite/.test(f) ? 'Vite' : /webpack/.test(f) ? 'webpack' : /rollup/.test(f) ? 'Rollup' : 'esbuild', { file: f });
  }

  // ---------- Python ----------
  const pyDep = (line: string, file: string, lineNo: number, devDep = false) => {
    const name = line.trim().split(/[<>=!~\[;\s]/)[0];
    if (!name || name.startsWith('-') || name.startsWith('#')) return;
    externalDependencies.push({ name, version: line.trim().slice(name.length).trim() || undefined, ecosystem: 'pypi', dev: devDep, evidence: { file, line: lineNo } });
    for (const [re, label] of PY_FRAMEWORKS) if (re.test(name)) addDet(frameworks, label, { file, line: lineNo });
  };
  for (const req of allPaths.filter(p => /(^|\/)requirements[^/]*\.txt$/.test(p))) {
    const text = read(root, req) ?? '';
    addDet(buildSystems, 'pip', { file: req });
    text.split(/\r?\n/).forEach((l, i) => pyDep(l, req, i + 1, /dev|test/.test(req)));
  }
  for (const pp of named('pyproject.toml')) {
    const text = read(root, pp) ?? '';
    const tool = /\[tool\.poetry\]/.test(text) ? 'Poetry' : /\[tool\.hatch/.test(text) ? 'Hatch' : /\[tool\.pdm/.test(text) ? 'PDM' : 'pip (pyproject)';
    addDet(buildSystems, tool, { file: pp, line: lineOf(text, /\[tool\.|\[project\]/) });
    const depBlock = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text);
    if (depBlock) {
      const startLine = lineOf(text, /dependencies\s*=\s*\[/) ?? 1;
      depBlock[1].split(/\n/).forEach((l, i) => { const s = /["']([^"']+)["']/.exec(l); if (s) pyDep(s[1], pp, startLine + i); });
    }
    const poetryDeps = /\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/.exec(text);
    if (poetryDeps) poetryDeps[1].split(/\n/).forEach(l => { const s = /^\s*([\w.-]+)\s*=/.exec(l); if (s && s[1] !== 'python') pyDep(s[1], pp, lineOf(text, l) ?? 1); });
    const scripts = /\[project\.scripts\]([\s\S]*?)(\n\[|$)/.exec(text) ?? /\[tool\.poetry\.scripts\]([\s\S]*?)(\n\[|$)/.exec(text);
    if (scripts) scripts[1].split(/\n/).forEach(l => {
      const s = /^\s*([\w.-]+)\s*=\s*["']([\w.]+):/.exec(l);
      if (s) {
        const mod = s[2].replace(/\./g, '/');
        const file = [join(dirOf(pp), mod + '.py'), join(dirOf(pp), `src/${mod}.py`), join(dirOf(pp), mod + '/__init__.py')].find(x => paths.has(x));
        if (file) declaredEntries.push({ file, reason: `Console script "${s[1]}"`, evidence: { file: pp, line: lineOf(text, l) } });
      }
    });
    buildCommands.push({ label: `${dirOf(pp) || '.'}: install`, command: tool === 'Poetry' ? 'poetry install' : 'pip install -e .', cwd: dirOf(pp), tool, evidence: { file: pp } });
  }
  for (const f of named('setup.py')) addDet(buildSystems, 'setuptools', { file: f });
  for (const f of named('manage.py')) {
    addDet(frameworks, 'Django', { file: f });
    declaredEntries.push({ file: f, reason: 'Django management entry point', evidence: { file: f } });
    buildCommands.push({ label: `${dirOf(f) || '.'}: runserver`, command: 'python manage.py runserver', cwd: dirOf(f), tool: 'Django', evidence: { file: f } });
  }
  for (const f of files) {
    if (f.language === 'python' && f.path.endsWith('/__init__.py')) {
      // the parent of a top-most package is a python source root
      let dir = dirOf(f.path);
      while (paths.has(join(dirOf(dir), '__init__.py')) && dirOf(dir) !== dir) dir = dirOf(dir);
      pythonRoots.add(dirOf(dir));
    }
    if (f.language === 'python' && f.path.startsWith('src/')) pythonRoots.add('src');
  }
  for (const f of files) {
    if (f.language === 'python' && /(^|\/)test_[^/]*\.py$|_test\.py$/.test(f.path)) { addDet(frameworks, 'pytest', { file: f.path }, 'medium'); break; }
  }

  // ---------- JVM ----------
  for (const pom of named('pom.xml')) {
    const text = read(root, pom) ?? '';
    addDet(buildSystems, 'Maven', { file: pom });
    const dir = dirOf(pom);
    const mvn = paths.has(join(dir, 'mvnw')) ? './mvnw' : 'mvn';
    buildCommands.push({ label: `${dir || '.'}: package`, command: `${mvn} package`, cwd: dir, tool: 'Maven', evidence: { file: pom } });
    buildCommands.push({ label: `${dir || '.'}: test`, command: `${mvn} test`, cwd: dir, tool: 'Maven', evidence: { file: pom } });
    const depRe = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g;
    let m: RegExpExecArray | null;
    while ((m = depRe.exec(text))) {
      const name = `${m[1]}:${m[2]}`;
      const line = lineOf(text, `<artifactId>${m[2]}</artifactId>`);
      externalDependencies.push({ name, version: m[3], ecosystem: 'maven', evidence: { file: pom, line } });
      for (const [re, label] of JVM_FRAMEWORKS) if (re.test(name)) addDet(frameworks, label, { file: pom, line });
    }
    if (/spring-boot-starter-parent/.test(text)) addDet(frameworks, 'Spring Boot', { file: pom, line: lineOf(text, 'spring-boot-starter-parent') });
  }
  for (const g of allPaths.filter(p => /(^|\/)build\.gradle(\.kts)?$/.test(p))) {
    const text = read(root, g) ?? '';
    addDet(buildSystems, 'Gradle', { file: g });
    const dir = dirOf(g);
    const gw = paths.has(join(dir, 'gradlew')) ? './gradlew' : 'gradle';
    buildCommands.push({ label: `${dir || '.'}: build`, command: `${gw} build`, cwd: dir, tool: 'Gradle', evidence: { file: g } });
    const depRe = /(implementation|api|compileOnly|runtimeOnly|testImplementation)\s*\(?\s*["']([^"':]+):([^"':]+)(?::([^"']+))?["']/g;
    let m: RegExpExecArray | null;
    while ((m = depRe.exec(text))) {
      const name = `${m[2]}:${m[3]}`;
      const line = lineOf(text, m[0]);
      externalDependencies.push({ name, version: m[4], ecosystem: 'gradle', dev: m[1].startsWith('test'), evidence: { file: g, line } });
      for (const [re, label] of JVM_FRAMEWORKS) if (re.test(name)) addDet(frameworks, label, { file: g, line });
    }
    if (/org\.springframework\.boot/.test(text)) addDet(frameworks, 'Spring Boot', { file: g, line: lineOf(text, 'org.springframework.boot') });
  }

  // ---------- .NET / Go ----------
  for (const cs of allPaths.filter(p => /\.(csproj|sln)$/.test(p))) {
    addDet(buildSystems, '.NET (dotnet)', { file: cs });
    if (cs.endsWith('.csproj')) buildCommands.push({ label: `${dirOf(cs) || '.'}: build`, command: 'dotnet build', cwd: dirOf(cs), tool: 'dotnet', evidence: { file: cs } });
  }
  for (const gm of named('go.mod')) {
    const text = read(root, gm) ?? '';
    addDet(buildSystems, 'Go modules', { file: gm });
    const mod = /^module\s+(\S+)/m.exec(text);
    if (mod && !goModule) goModule = { dir: dirOf(gm), module: mod[1] };
    buildCommands.push({ label: `${dirOf(gm) || '.'}: build`, command: 'go build ./...', cwd: dirOf(gm), tool: 'Go', evidence: { file: gm } });
    buildCommands.push({ label: `${dirOf(gm) || '.'}: test`, command: 'go test ./...', cwd: dirOf(gm), tool: 'Go', evidence: { file: gm } });
  }

  // ---------- Generic ----------
  for (const mk of allPaths.filter(p => /(^|\/)(GNU)?[Mm]akefile$/.test(p))) {
    const text = read(root, mk) ?? '';
    addDet(buildSystems, 'Make', { file: mk });
    text.split(/\r?\n/).forEach((l, i) => {
      const t = /^([A-Za-z][\w.-]*)\s*:(?!=)/.exec(l);
      if (t && !t[1].startsWith('.') && buildCommands.filter(b => b.evidence.file === mk).length < 12) {
        buildCommands.push({ label: `${dirOf(mk) || '.'}: make ${t[1]}`, command: `make ${t[1]}`, cwd: dirOf(mk), tool: 'Make', evidence: { file: mk, line: i + 1 } });
      }
    });
  }
  for (const d of allPaths.filter(p => /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(p))) addDet(buildSystems, 'Docker', { file: d });
  for (const c of allPaths.filter(p => p.startsWith('.github/workflows/'))) addDet(buildSystems, 'GitHub Actions (CI)', { file: c });
  for (const c of named('.gitlab-ci.yml')) addDet(buildSystems, 'GitLab CI', { file: c });
  for (const c of named('Jenkinsfile')) addDet(buildSystems, 'Jenkins', { file: c });

  // ---------- IBM i ----------
  for (const f of named('iproj.json')) {
    addDet(frameworks, 'IBM i project (iproj.json)', { file: f });
    const text = read(root, f) ?? '';
    try {
      const j = JSON.parse(text);
      if (j.buildCommand) buildCommands.push({ label: `${dirOf(f) || '.'}: IBM i build`, command: j.buildCommand, cwd: dirOf(f), tool: 'iproj', evidence: { file: f, line: lineOf(text, 'buildCommand') } });
    } catch { /* ignore */ }
  }
  for (const f of allPaths.filter(p => /(^|\/)Rules\.mk$/.test(p))) {
    addDet(buildSystems, 'Bob (Better Object Builder)', { file: f });
  }
  if (allPaths.some(p => /(^|\/)Rules\.mk$/.test(p))) {
    buildCommands.push({ label: '.: makei build', command: 'makei build', cwd: '', tool: 'Bob', evidence: { file: allPaths.find(p => /Rules\.mk$/.test(p))! } });
  }
  for (const f of named('.ibmi.json')) addDet(frameworks, 'Code for IBM i settings (.ibmi.json)', { file: f });
  for (const f of allPaths.filter(p => /(^|\/)actions\.json$/.test(p) && p.includes('.vscode'))) addDet(buildSystems, 'Code for IBM i Actions', { file: f });
  const ibmiFiles = files.filter(f => ['rpgle', 'sqlrpgle', 'rpg', 'cl', 'dds', 'cobol', 'cmd'].includes(f.language));
  if (ibmiFiles.length) addDet(frameworks, 'IBM i (ILE) application', { file: ibmiFiles[0].path, note: `${ibmiFiles.length} IBM i source members` }, 'high');
  if (files.some(f => f.language === 'sqlrpgle')) addDet(frameworks, 'Embedded SQL (SQLRPGLE)', { file: files.find(f => f.language === 'sqlrpgle')!.path });

  const seenCmd = new Set<string>();
  const uniqueCommands = buildCommands.filter(c => { const k = `${c.cwd}|${c.command}`; if (seenCmd.has(k)) return false; seenCmd.add(k); return true; });
  return {
    frameworks: [...frameworks.values()],
    buildSystems: [...buildSystems.values()],
    buildCommands: uniqueCommands,
    externalDependencies,
    declaredEntries,
    goModule,
    pythonRoots: [...pythonRoots]
  };
}
