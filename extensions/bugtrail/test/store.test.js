const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { BugStore } = require('../out-test/store.js');
const { extractErrors } = require('../out-test/store.js').__core;

test('records, recurs, auto-resolves and searches', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-')), 'bugtrail.json');
  const s = new BugStore(file);
  const ws = '/work/shop';
  const out1 = "TypeError: Cannot read properties of undefined (reading 'email')\n    at sendMail (/work/shop/src/mail.ts:14:9)";
  const [e1] = extractErrors(out1);
  const r1 = s.record(e1, { at: new Date().toISOString(), source: 'terminal', workspace: ws, command: 'npm test' });
  assert.ok(r1.isNew && !r1.recurred);
  s.trackEdit(ws, 'src/mail.ts');
  s.trackEdit(ws, 'src/user.ts');
  const fixed = s.resolveBySuccess(ws, 'terminal', 'npm test');
  assert.strictEqual(fixed.length, 1);
  assert.deepStrictEqual(fixed[0].resolution.files, ['src/mail.ts', 'src/user.ts']);
  s.addNote(fixed[0].id, 'user.profile can be null for SSO users');

  // Same bug on another machine/project: different path and line numbers -> recognised as the same bug
  const out2 = out1.replace('/work/shop', 'C:\\dev\\shop2').replace('14:9', '31:2');
  const r2 = s.record(extractErrors(out2)[0], { at: new Date().toISOString(), source: 'debug', workspace: 'C:\\dev\\shop2', command: 'Launch' });
  assert.ok(r2.recurred, 'recurrence detected');
  assert.strictEqual(r2.entry.count, 2);
  assert.strictEqual(r2.entry.history[0].note, 'user.profile can be null for SSO users');
  assert.strictEqual(r2.entry.workspaces.length, 2);

  // persisted
  const s2 = new BugStore(file);
  assert.strictEqual(s2.entries.length, 1);
  assert.strictEqual(s2.search('SSO')[0].entry.id, r2.entry.id);
  assert.strictEqual(s2.search('TypeError email')[0].entry.id, r2.entry.id);
  assert.match(s2.toMarkdown(s2.entries[0]), /Earlier fixes/);

  // IBM i message
  const r3 = s2.record(extractErrors('CPF4131 Level check on file ORDHDR in library MYLIB.')[0], { at: new Date().toISOString(), source: 'manual', workspace: ws });
  assert.ok(r3.isNew);
  assert.strictEqual(r3.entry.type, 'CPF4131');
});
