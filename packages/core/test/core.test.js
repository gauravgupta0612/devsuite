const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { indexRepository, generateOnboardingGuide, searchIndex, graphOf } = require('../dist');

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repopilot-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const has = (idx, from, to) => idx.edges.some(e => e.from === from && e.to === to);

test('TypeScript / Node project', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'demo', main: 'dist/index.js', scripts: { build: 'tsc', test: 'jest' }, dependencies: { express: '^4' }, devDependencies: { typescript: '^5', jest: '^29' } }, null, 2),
    'tsconfig.json': '{}',
    'src/index.ts': "import { createApp } from './app';\nimport express from 'express';\ncreateApp().listen(3000);\n",
    'src/app.ts': "import { router } from './routes/index.js';\nimport * as util from './util';\nexport function createApp() { return router; }\n",
    'src/routes/index.ts': "import { getUser } from '../services/user';\nexport const router = {};\n",
    'src/services/user.ts': "import { db } from '../util';\n// import { nope } from './commented';\nexport async function getUser(id: string) { return db; }\nexport class UserService {}\n",
    'src/util.ts': "import './services/user';\nexport const db = {};\nexport const helper = (x: number) => x * 2;\n",
    'src/missing.ts': "import x from './does-not-exist';\n",
    'test/user.test.ts': "import { getUser } from '../src/services/user';\n",
    'node_modules/express/index.js': 'module.exports = {}',
    'logo.png': Buffer.from([0x89, 0x50, 0x00, 0x00])
  });
  const idx = await indexRepository(root);
  assert.ok(!idx.files.some(f => f.path.startsWith('node_modules')), 'node_modules excluded');
  assert.ok(has(idx, 'src/index.ts', 'src/app.ts'));
  assert.ok(has(idx, 'src/app.ts', 'src/routes/index.ts'), '.js extension maps to .ts');
  assert.ok(has(idx, 'src/routes/index.ts', 'src/services/user.ts'));
  assert.ok(!idx.edges.some(e => e.specifier === './commented'), 'comments ignored');
  assert.ok(idx.unresolved.some(u => u.specifier === './does-not-exist'));
  assert.ok(idx.frameworks.some(f => f.name === 'Express'));
  assert.ok(idx.frameworks.some(f => f.name === 'Jest'));
  assert.ok(idx.buildSystems.some(b => b.name === 'npm'));
  assert.ok(idx.buildCommands.some(c => c.command === 'npm run build'));
  assert.ok(idx.entryPoints.some(e => e.file === 'src/index.ts'), 'main dist/index.js -> src/index.ts');
  assert.ok(idx.cycles.some(c => c.includes('src/util.ts') && c.includes('src/services/user.ts')), 'cycle found');
  const user = idx.files.find(f => f.path === 'src/services/user.ts');
  assert.deepStrictEqual(user.symbols.map(s => s.name).sort(), ['UserService', 'getUser']);
  assert.ok(idx.files.find(f => f.path === 'src/util.ts').symbols.some(s => s.name === 'helper'));
  assert.strictEqual(idx.testFiles, 1);
  const g = graphOf(idx);
  const impact = g.transitiveDependents('src/util.ts');
  assert.ok(impact.has('src/app.ts') && impact.has('src/index.ts'));
  const md = generateOnboardingGuide(idx, { linkPrefix: '../' });
  assert.match(md, /Express/);
  assert.match(md, /\]\(\.\.\/src\/index\.ts/);
  const hits = searchIndex(idx, 'where is getUser defined?');
  assert.strictEqual(hits[0].file, 'src/services/user.ts');
});

test('Python project', async () => {
  const root = makeRepo({
    'pyproject.toml': '[project]\nname="shop"\ndependencies = [\n  "fastapi>=0.110",\n  "sqlalchemy"\n]\n[project.scripts]\nshop = "shop.cli:main"\n',
    'shop/__init__.py': '',
    'shop/cli.py': 'from shop.api import app\nimport uvicorn\n\ndef main():\n    uvicorn.run(app)\n\nif __name__ == "__main__":\n    main()\n',
    'shop/api.py': '"""API module.\nimport fake\n"""\nfrom .models import Order\nfrom . import db\nfrom fastapi import FastAPI\napp = FastAPI()\n\nclass Handler:\n    def get(self):\n        pass\n',
    'shop/models.py': 'from shop.db import Base\nclass Order(Base):\n    pass\n',
    'shop/db.py': 'Base = object\n',
    'tests/test_api.py': 'from shop.api import app\n'
  });
  const idx = await indexRepository(root);
  assert.ok(has(idx, 'shop/cli.py', 'shop/api.py'));
  assert.ok(has(idx, 'shop/api.py', 'shop/models.py'));
  assert.ok(has(idx, 'shop/api.py', 'shop/db.py'), 'from . import db');
  assert.ok(has(idx, 'shop/models.py', 'shop/db.py'));
  assert.ok(!idx.unresolved.some(u => u.specifier.includes('fake')), 'docstring ignored');
  assert.ok(idx.frameworks.some(f => f.name === 'FastAPI'));
  assert.ok(idx.entryPoints.some(e => e.file === 'shop/cli.py'));
  const api = idx.files.find(f => f.path === 'shop/api.py');
  assert.ok(api.symbols.some(s => s.name === 'Handler' && s.kind === 'class'));
  assert.ok(api.symbols.some(s => s.name === 'get' && s.kind === 'method'));
});

test('Java / Maven project', async () => {
  const root = makeRepo({
    'pom.xml': '<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
    'src/main/java/com/acme/App.java': 'package com.acme;\nimport com.acme.web.OrderController;\n@SpringBootApplication\npublic class App {\n  public static void main(String[] a) {}\n}\n',
    'src/main/java/com/acme/web/OrderController.java': 'package com.acme.web;\nimport com.acme.service.*;\npublic class OrderController {\n  private final OrderService svc;\n  public String list() { return Helper.x(); }\n}\n',
    'src/main/java/com/acme/web/Helper.java': 'package com.acme.web;\npublic class Helper { public static String x() { return ""; } }\n',
    'src/main/java/com/acme/service/OrderService.java': 'package com.acme.service;\npublic class OrderService {}\n',
    'src/test/java/com/acme/AppTest.java': 'package com.acme;\nclass AppTest {}\n'
  });
  const idx = await indexRepository(root);
  assert.ok(has(idx, 'src/main/java/com/acme/App.java', 'src/main/java/com/acme/web/OrderController.java'));
  assert.ok(has(idx, 'src/main/java/com/acme/web/OrderController.java', 'src/main/java/com/acme/service/OrderService.java'), 'wildcard import');
  assert.ok(has(idx, 'src/main/java/com/acme/web/OrderController.java', 'src/main/java/com/acme/web/Helper.java'), 'same package');
  assert.ok(idx.frameworks.some(f => f.name === 'Spring Boot'));
  assert.ok(idx.buildSystems.some(f => f.name === 'Maven'));
  assert.ok(idx.entryPoints.some(e => e.file === 'src/main/java/com/acme/App.java'));
  assert.ok(idx.modules.some(m => m.name === 'com.acme.web'));
});

test('IBM i RPGLE / CL / DDS / SQL project', async () => {
  const root = makeRepo({
    'iproj.json': JSON.stringify({ objlib: 'MYLIB', buildCommand: 'makei build' }),
    'qrpglesrc/Rules.mk': 'ORDENT.PGM: ordent.pgm.sqlrpgle\n',
    'qclsrc/ordjob.clle': "PGM\n  /* CALL PGM(IGNORED) */\n  DCLF FILE(*LIBL/ORDDSP)\n  CALL PGM(*LIBL/ORDENT)\n  SBMJOB CMD(CALL PGM(ORDPRT))\n  CALLPRC PRC('LOGMSG')\nENDPGM\n",
    'qrpglesrc/ordent.pgm.sqlrpgle': "**free\n/copy qprotosrc,ordprotos\ndcl-f ORDDSP workstn;\ndcl-f ORDHDR usage(*update) keyed;\ndcl-pr calcTax packed(9:2) extproc('CALCTAX');\n  amt packed(9:2);\nend-pr;\ndcl-pr Printer extpgm('ORDPRT');\nend-pr;\n// CALL 'IGNORED'\nexec sql select * into :x from ORDDTL where id = 1;\nPrinter();\ndcl-proc localProc;\nend-proc;\n",
    'qrpglesrc/ordprt.rpgle': "     H DFTACTGRP(*NO)\n     FORDHDR    IF   E           K DISK\n     C                   CALL      'QCMDEXC'\n     C                   CALL      'LOGPGM'\n      * C                   CALL      'COMMENTED'\n",
    'qrpglesrc/taxsrv.rpgle': "**free\nctl-opt nomain;\ndcl-proc CALCTAX export;\nend-proc;\n",
    'qprotosrc/ordprotos.rpgleinc': "**free\ndcl-pr LogMsg extproc('LOGMSG');\nend-pr;\n",
    'qrpglesrc/logsrv.rpgle': "**free\nctl-opt nomain;\ndcl-proc LOGMSG export;\nend-proc;\n",
    'qddssrc/ordhdr.pf': '     A          R ORDHDRR\n     A            ID             9P 0\n',
    'qddssrc/ordhdrl1.lf': '     A          R ORDHDRR                   PFILE(ORDHDR)\n',
    'qddssrc/orddsp.dspf': '     A          R SCREEN1\n',
    'qsqlsrc/orddtl.table': 'CREATE OR REPLACE TABLE MYLIB.ORDDTL (ID INT);\n',
    'qsqlsrc/ordview.view': 'CREATE VIEW ORDVIEW AS SELECT * FROM ORDDTL JOIN ORDHDR ON 1=1;\n'
  });
  const idx = await indexRepository(root);
  const E = (a, b) => assert.ok(has(idx, a, b), `${a} -> ${b}`);
  E('qclsrc/ordjob.clle', 'qrpglesrc/ordent.pgm.sqlrpgle');
  E('qclsrc/ordjob.clle', 'qrpglesrc/ordprt.rpgle');
  E('qclsrc/ordjob.clle', 'qddssrc/orddsp.dspf');
  E('qclsrc/ordjob.clle', 'qrpglesrc/logsrv.rpgle');
  E('qrpglesrc/ordent.pgm.sqlrpgle', 'qprotosrc/ordprotos.rpgleinc');
  E('qrpglesrc/ordent.pgm.sqlrpgle', 'qddssrc/orddsp.dspf');
  E('qrpglesrc/ordent.pgm.sqlrpgle', 'qddssrc/ordhdr.pf');
  E('qrpglesrc/ordent.pgm.sqlrpgle', 'qrpglesrc/taxsrv.rpgle');
  E('qrpglesrc/ordent.pgm.sqlrpgle', 'qrpglesrc/ordprt.rpgle');
  E('qrpglesrc/ordent.pgm.sqlrpgle', 'qsqlsrc/orddtl.table');
  E('qrpglesrc/ordprt.rpgle', 'qddssrc/ordhdr.pf');
  E('qprotosrc/ordprotos.rpgleinc', 'qrpglesrc/logsrv.rpgle');
  E('qddssrc/ordhdrl1.lf', 'qddssrc/ordhdr.pf');
  E('qsqlsrc/ordview.view', 'qsqlsrc/orddtl.table');
  E('qsqlsrc/ordview.view', 'qddssrc/ordhdr.pf');
  assert.ok(!idx.edges.some(e => /IGNORED|COMMENTED/.test(e.specifier)), 'comments skipped');
  assert.ok(idx.unresolved.some(u => u.specifier === 'pgm:LOGPGM'));
  assert.ok(!idx.unresolved.some(u => u.specifier === 'pgm:QCMDEXC'), 'system programs not reported');
  assert.ok(idx.frameworks.some(f => f.name === 'IBM i (ILE) application'));
  assert.ok(idx.buildSystems.some(b => b.name.startsWith('Bob')));
  assert.ok(idx.buildCommands.some(c => c.command === 'makei build'));
  assert.ok(idx.entryPoints.some(e => e.file === 'qclsrc/ordjob.clle'), 'CL job is top-level entry');
  assert.ok(!idx.entryPoints.some(e => e.file === 'qrpglesrc/ordprt.rpgle'), 'called program is not an entry');
  const impact = graphOf(idx).transitiveDependents('qddssrc/ordhdr.pf');
  assert.ok(impact.has('qclsrc/ordjob.clle'), 'PF change impacts CL job transitively');
  const md = generateOnboardingGuide(idx);
  assert.match(md, /IBM i/);
});
