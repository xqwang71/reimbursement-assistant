import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSchoolRegister } from '../lib/school-report-files.mjs';
import { readFundingExports } from '../lib/funding-summary.mjs';
import { pythonExecutable } from '../lib/platform.mjs';

function makeRegister(file, ids) {
  const script = `
import sys
from openpyxl import Workbook
w=Workbook()
s=w.active
s.append(['报销单号','状态','经费项目','支付金额','预约时间'])
for id in sys.argv[2:]:
    s.append([id, '已制单', 'A1A-TEST-01', 25.60, '2026-10-10'])
w.save(sys.argv[1])
`;
  execFileSync(pythonExecutable(), ['-X', 'utf8', '-c', script, file, ...ids]);
}

test('school export updates only after checking row count and prior receipt coverage', async (t) => {
  try { execFileSync(pythonExecutable(), ['-c', 'import openpyxl'], { stdio: 'ignore' }); }
  catch { t.skip('requires the existing Excel reader'); return; }
  const root = await mkdtemp(join(tmpdir(), 'suibe-school-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, '2026');
  const runtimeDir = join(root, 'runtime');
  await mkdir(sourceRoot);
  const current = join(sourceRoot, '报销单统计.xlsx');
  const before = join(root, 'incomplete');
  const next = join(root, 'complete');
  makeRegister(current, ['PAST']);
  makeRegister(before, ['NEW']);
  makeRegister(next, ['PAST', 'NEW']);
  const old = await readFile(current);
  const args = { sourceRoot, runtimeDir, year: '2026', kind: 'smart', guard() {} };
  await assert.rejects(installSchoolRegister({ ...args, downloadPath: before, expectedCount: 1 }), /少了 1 条现有记录/);
  assert.deepEqual(await readFile(current), old);
  const result = await installSchoolRegister({ ...args, downloadPath: next, expectedCount: 2 });
  assert.equal(result.rowCount, 2);
  assert.equal(result.updated, true);
  const saved = await readdir(join(runtimeDir, 'school-export-backups', '2026', 'smart'));
  assert.equal(saved.length, 1);
  assert.deepEqual(await readFile(join(runtimeDir, 'school-export-backups', '2026', 'smart', saved[0])), old);
  assert.deepEqual((await readFundingExports(sourceRoot)).records.map(({ financeId }) => financeId), ['PAST', 'NEW']);
});

test('the funding report reads confirmed and dashboard-only budgets from the annual ledger', async (t) => {
  try { execFileSync(pythonExecutable(), ['-c', 'import openpyxl'], { stdio: 'ignore' }); }
  catch { t.skip('requires the existing Excel reader'); return; }
  const root = await mkdtemp(join(tmpdir(), 'suibe-budget-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workbook = join(root, '2026年度进账与报销台账.xlsx');
  execFileSync(pythonExecutable(), ['-X', 'utf8', '-c', `
import sys
from openpyxl import Workbook
book = Workbook()
sheet = book.active
sheet.title = '项目清单'
sheet.append(['台账编号', '项目名称', '项目金额', '进账状态', '学校项目编号', '报销归属', '关联人员', '规则摘要'])
notes = {1: '示例代办人代办，已完成报销', 2: '尚未完成报销', 4: '按进度与余额推算。'}
for i, state in enumerate(['已到账', '已确认额度', '已授权额度', '仅登记预算', '预计进账'], 1):
    sheet.append([f'P2026-{i:03}', f'项目{i}', 100 * i, state, f'A1A-TEST-{i}', '托人报销', '示例代办人', notes.get(i, '')])
book.save(sys.argv[1])
`, workbook]);
  const { budgets } = await readFundingExports(root);
  assert.deepEqual(budgets.map(({ projectNo, budgetCny }) => [projectNo, budgetCny]),
    [['A1A-TEST-1', 10000], ['A1A-TEST-2', 20000], ['A1A-TEST-3', 30000], ['A1A-TEST-4', 40000]]);
  assert.equal(budgets[0].handlingMode, '托人报销');
  assert.equal(budgets[0].handlingPerson, '示例代办人');
  assert.equal(budgets[0].handlingStatus, '已完成');
  assert.equal(budgets[1].handlingStatus, '');
  assert.equal(budgets[3].budgetNote, '按进度与余额推算。');
});
