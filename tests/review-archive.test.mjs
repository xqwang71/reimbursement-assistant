import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { requestRoute } from './request-fixture.mjs';

const exec = promisify(execFile);
const importer = fileURLToPath(new URL('../scripts/import-review-archive.mjs', import.meta.url));

test('legacy review import preserves a WAL database and exposes read-only records only in live mode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), '报销审核档案-'));
  const source = join(root, '旧审核.sqlite');
  const data = join(root, '用户资料');
  const destination = join(data, '.runtime', 'legacy-reviews.sqlite');
  const env = { ...process.env, REIMBURSEMENT_RUNNER_DATA_DIR: data, REIMBURSEMENT_SOURCE_ROOT: '' };
  const db = new DatabaseSync(source);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE batches (id TEXT PRIMARY KEY, year INTEGER, title TEXT, folder_name TEXT,
      folder_path TEXT, expense_subject TEXT, material_status TEXT, deleted_at TEXT);
    CREATE TABLE review_runs (id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id), trigger TEXT,
      status TEXT, summary TEXT, completed_at TEXT, error_message TEXT, structured_result_json TEXT);
    CREATE TABLE review_questions (id TEXT PRIMARY KEY, batch_id TEXT REFERENCES batches(id),
      question TEXT, reason TEXT, status TEXT, created_at TEXT, priority INTEGER);
    CREATE TABLE review_answers (id TEXT PRIMARY KEY, question_id TEXT REFERENCES review_questions(id),
      answer_text TEXT, answer_value TEXT, answered_at TEXT);
    CREATE TABLE evidence_fixture (detail TEXT);
    INSERT INTO batches VALUES ('old-a', 2099, '虚构审核批次', '样例', '样例/办公', '办公费', 'incomplete', '2099-04-04');
    INSERT INTO batches VALUES ('old-b', 2099, '', '尚未审核的虚构批次', '样例/资料', '资料费', 'needs_review', NULL);
    INSERT INTO review_runs VALUES ('earlier', 'old-a', 'scan', 'needs_review', '第一次核对', '2099-04-01T08:00:00Z', '', '{}');
    INSERT INTO review_runs VALUES ('later', 'old-a', 'human_review', 'incomplete', '仍需补付款材料', '2099-04-02T08:00:00Z', '', '{"missing":["虚构付款记录"]}');
    INSERT INTO review_questions VALUES ('q', 'old-a', '是否有付款记录？', '需核对实付', 'answered', '2099-04-02', 1);
    INSERT INTO review_answers VALUES ('a', 'q', '', '待补材料', '2099-04-03');
    INSERT INTO evidence_fixture VALUES ('数据库其余表也保留');
  `);
  const previous = await readFile(source);
  const previousWal = await readFile(source + '-wal');
  assert.ok(previousWal.length > 0);
  const { stdout } = await exec(process.execPath, [importer, source], { env, timeout: 10000 });
  assert.match(stdout, /2 个批次、2 次审核、1 条核对问题和 1 条回答/);
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(source), previous);
  assert.deepEqual(await readFile(source + '-wal'), previousWal);

  const snapshot = await readFile(destination);
  await assert.rejects(exec(process.execPath, [importer, source], { env, timeout: 10000 }), /已有审核档案/);
  const full = new DatabaseSync(destination, { readOnly: true });
  try { assert.equal(full.prepare('SELECT detail FROM evidence_fixture').get().detail, '数据库其余表也保留'); }
  finally { full.close(); }

  process.env.REIMBURSEMENT_RUNNER_DATA_DIR = data;
  delete process.env.REIMBURSEMENT_SOURCE_ROOT;
  const { handleRequest } = await import('../server.mjs');
  const request = (...args) => requestRoute(handleRequest, ...args);
  const archivePath = '/api/review-archive';
  assert.equal((await request('/api/config')).body.reviewArchiveAvailable, false);
  assert.equal((await request(archivePath)).status, 409);
  const receipts = join(root, '票据');
  await mkdir(receipts);
  assert.equal((await request('/api/config', { sourceRoot: receipts })).body.reviewArchiveAvailable, true);
  const list = await request(archivePath);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal(list.body.reviewCount, 2);
  assert.deepEqual(list.body.batches.map((batch) => [batch.id, batch.reviewCount]), [['old-a', 2], ['old-b', 0]]);
  const detail = await request(archivePath + '?batch=old-a');
  assert.equal(detail.body.batch.archived, 1);
  assert.deepEqual(detail.body.reviews.map(({ id }) => id), ['later', 'earlier']);
  assert.deepEqual(detail.body.reviews[0].result.missing, ['虚构付款记录']);
  assert.equal(detail.body.questions[0].question, '是否有付款记录？');
  assert.equal(detail.body.answers[0].text, '待补材料');
  assert.equal((await request(archivePath + '?batch=unknown')).status, 404);
  assert.equal((await request(archivePath + '?batch=')).status, 400);
  assert.equal((await request(archivePath, undefined, 'GET', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(archivePath, {}, 'POST')).status, 405);
  assert.deepEqual((await request('/api/runs')).body.runs, []);
  assert.deepEqual((await request('/api/batches')).body.batches, []);
  assert.deepEqual(await readFile(destination), snapshot);
});
