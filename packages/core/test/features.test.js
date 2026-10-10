const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../dist');

function makeRepo(files, { git = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsuite-'));
  write(root, files);
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
  }
  return root;
}
function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (content === null) { fs.rmSync(abs); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

const APP = {
  'package.json': JSON.stringify({ name: 'shop', devDependencies: { jest: '^29' }, dependencies: { express: '^4' } }),
  'src/server.ts': "import express from 'express';\nimport usersRouter from './routes/users';\nconst app = express();\napp.use('/api/users', usersRouter);\napp.get('/health', (req, res) => res.json({ ok: true }));\napp.listen(3000);\n",
  'src/routes/users.ts': "import { Router } from 'express';\nimport { listUsers, getUser } from '../controllers/userController';\nconst router = Router();\nrouter.get('/', listUsers);\nrouter.get('/:id', getUser);\nexport default router;\n",
  'src/controllers/userController.ts': "import { findUsers, findUser } from '../services/userService';\nexport async function listUsers(req, res) {\n  const users = await findUsers();\n  res.json(users);\n}\nexport async function getUser(req, res) {\n  const u = await findUser(req.params.id);\n  res.json(u);\n}\n",
  'src/services/userService.ts': "import { db } from '../db';\nimport axios from 'axios';\nexport async function findUsers() {\n  return db.query('SELECT * FROM users');\n}\nexport async function findUser(id: string) {\n  const profile = await axios.get('https://profiles.example.com/u/' + id);\n  return db.findOne({ id });\n}\nexport function formatName(n: string) { return n.trim(); }\n",
  'src/db.ts': "export const db = { query: (s: string) => [], findOne: (q: any) => null };\n",
  'test/userService.test.ts': "import { findUsers } from '../src/services/userService';\ntest('x', () => {});\n"
};

test('git diff parsing + impact analysis', async () => {
  const root = makeRepo(APP, { git: true });
  write(root, {
    'src/services/userService.ts': APP['src/services/userService.ts'].replace("return db.query('SELECT * FROM users');", "return db.query('SELECT id, name FROM users');")
  });
  const changes = await core.getChanges(root, { kind: 'working' });
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].path, 'src/services/userService.ts');
  assert.strictEqual(changes[0].added, 1);
  assert.deepStrictEqual(changes[0].addedLines.map(l => l.line), [4]);

  const idx = await core.indexRepository(root);
  const graph = core.graphOf(idx);
  const res = core.analyzeImpact(idx, graph, changes.map(c => ({ file: c.path, lines: c.addedLines.map(l => l.line), status: c.status })));
  assert.deepStrictEqual(res.changes[0].changedSymbols.map(s => s.name), ['findUsers']);
  const ctrl = res.affected.find(a => a.file === 'src/controllers/userController.ts');
  assert.ok(ctrl && ctrl.distance === 1 && ctrl.confidence === 'high' && ctrl.usesSymbols.includes('findUsers'));
  assert.ok(res.affected.some(a => a.file === 'src/routes/users.ts' && a.distance === 2));
  assert.ok(res.affected.some(a => a.file === 'src/server.ts' && a.distance === 3));
  assert.ok(res.tests.some(t => t.file === 'test/userService.test.ts'));
  assert.ok(res.testCommands[0].command.startsWith('npx jest'));

  // untracked + deleted + staged
  write(root, { 'src/new.ts': "export const x = 1;\n", 'src/db.ts': null });
  const all = await core.getChanges(root, { kind: 'working' });
  assert.ok(all.some(c => c.path === 'src/new.ts' && c.status === 'added'));
  assert.ok(all.some(c => c.path === 'src/db.ts' && c.status === 'deleted'));
  const staged = await core.getChanges(root, { kind: 'staged' });
  assert.strictEqual(staged.length, 0);
});

test('risk assessment', async () => {
  const root = makeRepo(APP, { git: true });
  const idx = await core.indexRepository(root);
  const graph = core.graphOf(idx);
  const diff = core.parseUnifiedDiff([
    'diff --git a/src/services/userService.ts b/src/services/userService.ts',
    '--- a/src/services/userService.ts', '+++ b/src/services/userService.ts',
    '@@ -10 +10,4 @@',
    '-export function formatName(n: string) { return n.trim(); }',
    "+const apiKey = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD';",
    "+const q = 'SELECT * FROM users WHERE id = ' + id;",
    '+console.log(q);',
    '+// TODO remove',
    'diff --git a/src/db.ts b/src/db.ts', 'deleted file mode 100644', '--- a/src/db.ts', '+++ /dev/null',
    '@@ -1 +0,0 @@', '-export const db = {};',
    'diff --git a/.env b/.env', 'new file mode 100644', '--- /dev/null', '+++ b/.env', '@@ -0,0 +1 @@', '+DB_PASSWORD=hunter2hunter2',
    'diff --git a/qclsrc/job.clle b/qclsrc/job.clle', '--- a/qclsrc/job.clle', '+++ b/qclsrc/job.clle', '@@ -3,0 +4,2 @@',
    '+             CALL       PGM(PRODLIB/ORDPGM)', '+             MONMSG     MSGID(CPF0000)'
  ].join('\n'));
  assert.strictEqual(diff.length, 4);
  const r = core.assessRisk(diff, { index: idx, graph });
  const ids = r.findings.map(f => f.id);
  for (const id of ['secret-token', 'sec-sql-concat', 'q-console', 'q-todo', 'reg-broken-import', 'reg-removed-export', 'config', 'test-missing', 'ibmi-hardcoded-lib', 'ibmi-monmsg-all']) {
    assert.ok(ids.includes(id), `expected finding ${id}; got ${ids.join(',')}`);
  }
  assert.strictEqual(r.level, 'critical');
  assert.ok(r.findings[0].severity === 'critical');
  const secret = r.findings.find(f => f.id === 'secret-token');
  assert.ok(!secret.evidence.includes('abcdefghijklmnop'), 'secret is masked in evidence');
  const md = core.riskReportMarkdown(r);
  assert.match(md, /Risk: CRITICAL/);
  const clean = core.assessRisk(core.parseUnifiedDiff('diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n'));
  assert.strictEqual(clean.level, 'low');
  assert.strictEqual(clean.findings.length, 0);
  const one = core.assessRisk(core.parseUnifiedDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+eval(userInput)\n'));
  assert.strictEqual(one.level, 'high', 'a single high finding makes the level high');
});

test('endpoint discovery and flow tracing across frameworks', async () => {
  const root = makeRepo({
    ...APP,
    'nest/cats.controller.ts': "import { CatsService } from './cats.service';\n@Controller('cats')\nexport class CatsController {\n  constructor(private catsService: CatsService) {}\n  @Get(':id')\n  findOne(id: string) {\n    return this.catsService.findOne(id);\n  }\n  @Post()\n  async create(dto) { return this.catsService.create(dto); }\n}\n",
    'nest/cats.service.ts': "export class CatsService {\n  constructor(private catRepository) {}\n  findOne(id: string) {\n    return this.catRepository.findOneBy({ id });\n  }\n  create(dto) { return null; }\n}\n",
    'py/app.py': "from flask import Flask, Blueprint\nfrom py.store import load_items\napp = Flask(__name__)\nbp = Blueprint('items', __name__, url_prefix='/items')\n\n@bp.route('/<int:item_id>', methods=['GET', 'DELETE'])\ndef item(item_id):\n    return load_items(item_id)\n",
    'py/store.py': "import requests\ndef load_items(i):\n    cursor.execute(\"SELECT * FROM items WHERE id=%s\", (i,))\n    return requests.get('https://api.example.com/x')\n",
    'py/fast.py': "from fastapi import APIRouter\nrouter = APIRouter(prefix='/v2')\n@router.post('/orders')\nasync def create_order(o):\n    return o\n",
    'java/src/main/java/com/acme/web/OrderController.java': "package com.acme.web;\n@RestController\n@RequestMapping(\"/api/orders\")\npublic class OrderController {\n  @GetMapping(\"/{id}\")\n  public Order get(@PathVariable long id) {\n    return repo.findById(id);\n  }\n  @PostMapping\n  public Order create(@RequestBody Order o) { return o; }\n}\n"
  });
  const idx = await core.indexRepository(root);
  const graph = core.graphOf(idx);
  const eps = core.findEndpoints(idx, graph);
  const has = (m, p) => eps.find(e => e.method === m && e.path === p);
  assert.ok(has('GET', '/health'), 'inline express');
  assert.ok(has('GET', '/api/users'), 'mounted router prefix');
  assert.ok(has('GET', '/api/users/:id'));
  assert.ok(has('GET', '/cats/:id') && has('POST', '/cats'), 'nest');
  assert.ok(has('GET', '/items/<int:item_id>') && has('DELETE', '/items/<int:item_id>'), 'flask blueprint');
  assert.ok(has('POST', '/v2/orders'), 'fastapi router prefix');
  assert.ok(has('GET', '/api/orders/{id}') && has('POST', '/api/orders'), 'spring');

  const flow = core.traceEndpoint(idx, graph, has('GET', '/api/users/:id'));
  const flat = []; const walk = n => { flat.push(n); n.children.forEach(walk); }; walk(flow);
  assert.ok(flat.some(n => n.name === 'getUser()' && n.file === 'src/controllers/userController.ts'), 'handler');
  assert.ok(flat.some(n => n.name === 'findUser()' && n.kind === 'service'), 'service');
  assert.ok(flat.some(n => n.kind === 'database' && /db\.findOne/.test(n.name)), 'db call');
  assert.ok(flat.some(n => n.kind === 'external'), 'external http');

  const pyFlow = core.traceEndpoint(idx, graph, has('GET', '/items/<int:item_id>'));
  const pf = []; const w2 = n => { pf.push(n); n.children.forEach(w2); }; w2(pyFlow);
  assert.ok(pf.some(n => n.name === 'load_items()'));
  assert.ok(pf.some(n => n.kind === 'database'));
  assert.ok(pf.some(n => n.kind === 'external'));

  const nestFlow = core.traceEndpoint(idx, graph, has('GET', '/cats/:id'));
  const nf = []; const w3 = n => { nf.push(n); n.children.forEach(w3); }; w3(nestFlow);
  assert.ok(nf.some(n => n.file === 'nest/cats.service.ts'), 'this.service.method resolved');
  assert.match(core.flowToMermaid(flow), /flowchart TD/);
});

test('error extraction and signatures', () => {
  const node = "Server started\nTypeError: Cannot read properties of undefined (reading 'name')\n    at getUser (/home/a/proj/src/user.ts:42:13)\n    at node:internal/process:1:1";
  const e = core.extractErrors(node)[0];
  assert.strictEqual(e.type, 'TypeError');
  assert.deepStrictEqual(e.location, { file: '/home/a/proj/src/user.ts', line: 42 });
  const e2 = core.extractErrors(node.replace('42:13', '57:2').replace('/home/a/', 'C:\\Users\\b\\'))[0];
  assert.strictEqual(e.signature, e2.signature, 'same bug, different machine -> same signature');

  const py = 'Traceback (most recent call last):\n  File "app.py", line 8, in <module>\n    main()\nKeyError: \'user_id\'';
  assert.strictEqual(core.extractErrors(py)[0].type, 'KeyError');
  const ibmi = 'Message ID . . . . . . :   CPF4131\nCPF4131 Level check on file ORDHDR in library MYLIB with member ORDHDR.';
  assert.strictEqual(core.extractErrors(ibmi)[0].type, 'CPF4131');
  const java = 'Exception in thread "main" java.lang.NullPointerException: Cannot invoke "String.length()"\n\tat com.acme.App.run(App.java:12)';
  const j = core.extractErrors(java)[0];
  assert.strictEqual(j.type, 'NullPointerException');
  assert.deepStrictEqual(j.location, { file: 'App.java', line: 12 });
  assert.ok(core.signatureSimilarity(e.signature, e2.signature) === 1);
  assert.ok(core.signatureSimilarity(e.signature, j.signature) < 0.5);
  assert.strictEqual(core.extractErrors('all good\nDone in 2s').length, 0);
});
