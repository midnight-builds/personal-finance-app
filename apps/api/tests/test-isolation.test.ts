import './setup/testDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Guards against tests ever touching a real database file (this once wiped
// production data). Keep these tests; extend them rather than relax them.

const testsDir = fileURLToPath(new URL('.', import.meta.url));

test('every test file imports the in-memory DB setup first', () => {
  const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.ts'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const firstStatement = fs
      .readFileSync(new URL(file, new URL('.', import.meta.url)), 'utf8')
      .split('\n')
      .find((line) => line.trim() !== '' && !line.trim().startsWith('//'));
    assert.equal(firstStatement, "import './setup/testDb.js';", file);
  }
});

test('db.ts refuses a file database when a test file is run directly without the setup', () => {
  const dir = fs.mkdtempSync(`${testsDir}/../.tmp-isolation-`);
  try {
    const probe = `${dir}/probe.test.ts`;
    fs.writeFileSync(probe, "await import('../src/db.ts');\n");
    const env = { ...process.env, NODE_OPTIONS: '--experimental-sqlite', DB_PATH: `${dir}/data/finance.db` };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--import', 'tsx', probe], { cwd: dir, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to open/);
    assert.equal(fs.existsSync(`${dir}/data`), false, 'no database directory may be created');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db.ts does not create a missing database unless asked to', () => {
  const dir = fs.mkdtempSync(`${testsDir}/../.tmp-isolation-`);
  try {
    const probe = `${dir}/probe.ts`;
    fs.writeFileSync(probe, "await import('../src/db.ts');\n");
    const env = { ...process.env, NODE_OPTIONS: '--experimental-sqlite', DB_PATH: `${dir}/typo/finance.db` };
    delete env.NODE_TEST_CONTEXT;
    delete env.DB_CREATE;
    const result = spawnSync(process.execPath, ['--import', 'tsx', probe], { cwd: dir, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not exist/);
    assert.equal(fs.existsSync(`${dir}/typo`), false, 'no database may be created');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('db.ts has no default path: without DB_PATH it opens nothing', () => {
  const dir = fs.mkdtempSync(`${testsDir}/../.tmp-isolation-`);
  try {
    const probe = `${dir}/probe.ts`;
    fs.writeFileSync(probe, "await import('../src/db.ts');\n");
    const env = { ...process.env, NODE_OPTIONS: '--experimental-sqlite' };
    delete env.DB_PATH;
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--import', 'tsx', probe], { cwd: dir, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DB_PATH is not set/);
    assert.equal(fs.existsSync(`${dir}/data`), false, 'no database directory may be created');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
