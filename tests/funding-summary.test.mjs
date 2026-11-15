import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingSummaryCsv, summarizeFunding } from '../lib/funding-summary.mjs';
import { schoolPayrollStatus } from '../lib/school-payroll-status.mjs';

const sourceRoot = '/test/2026';
const a = 'DEMO-BUDGET-101';
const b = 'DEMO-BUDGET-102';
const sources = [{ kind: 'smart', file: '报销单统计.xlsx', state: 'read' }];
const budgets = [
  { ledgerNo: 'A-1', name: '课程', projectNo: a, budgetCny: 60000 },
  { ledgerNo: 'A-2', name: '案例', projectNo: a, budgetCny: 40000 },
  { ledgerNo: 'B-1', name: '项目 B', projectNo: b, budgetCny: 100000 },
];
const school = (financeId, fields = {}) => ({ financeId, amountCny: 10000, projectText: `${a}-2026年学院经费`, state: 'booked', status: '已制单', kind: 'smart',
  file: '报销单统计.xlsx', sheet: 'sheet1', row: 2, date: '2026-08-01', ...fields });
const receipt = (financeId, plan = {}) => ({ sourceRoot, bookkeeping: { historyRecorded: true },
  control: { progress: { submission: { financeFormId: financeId, state: 'verified', verifiedAt: '2026-11-10T06:30:00Z' } } },
  plan: { totalCny: 10000, project: { projectNo: a, projectName: '学院经费' }, reason: '课程费用', ...plan } });
const report = (records, options = {}) => summarizeFunding({ exports: { year: '2026', sources, budgets, records }, sourceRoot, ...options });

test('progress counts posted and submitted school records and verified receipts once', () => {
  const summary = report([
    school('100'), school('100', { kind: 'legacy', file: '报销单查询.xls' }),
    school('200', { business: '贸大出行', amountCny: 30000 }),
    school('300', { kind: 'labor', projectNo: b, laborKey: 'issued', reason: '项目劳务', amountCny: 40000 }),
    school('400', { state: 'pending', status: '提交', amountCny: 50000 }),
    school('400', { kind: 'legacy', state: 'pending', status: '财务已审核', amountCny: 50000 }),
    school('450', { state: 'pending', status: '待提交', amountCny: 7000 }),
    school('470', { kind: 'labor', projectNo: b, laborKey: 'submitted', state: 'pending', status: '待发放', amountCny: 20000 }),
    school('500', { state: 'excluded', status: '已撤回' }),
  ], { runs: [receipt('100'), receipt('400', { totalCny: 50000 }), receipt('500'), receipt('600')] });
  assert.deepEqual(summary.totals.categories, { labor: 40000, transport: 30000, other: 10000 });
  assert.deepEqual(summary.totals.progressCategories, { labor: 60000, transport: 30000, other: 70000 });
  assert.equal(summary.totals.bookedCny, 80000);
  assert.equal(summary.totals.budgetCny, 200000);
  assert.equal(summary.totals.rate, 0.8);
  assert.equal(summary.totals.pendingCny, 87000);
  assert.equal(summary.totals.submittedCny, 80000);
  assert.equal(summary.totals.progressCny, 160000);
  assert.equal(summary.totals.localPendingCny, 10000);
  assert.deepEqual(Object.fromEntries(summary.receipts.map(({ financeId, state }) => [financeId, state])), { 100: 'booked', 400: 'pending', 500: 'excluded', 600: 'missing' });
  assert.equal(summary.issues.length, 0);
  const project = summary.projects.find((project) => project.projectNo === a);
  assert.equal(project.rate, 1);
  assert.equal(project.unassignedCny, 40000);
  assert.equal(project.unassignedProgressCny, 100000);
  assert.equal(project.records.find(({ financeId }) => financeId === '100').source.row, 2);
  assert.equal(project.records.filter(({ financeId }) => financeId === '100').length, 1);
  assert.equal(project.records.filter(({ financeId }) => financeId === '400').length, 1);
  assert.equal(project.records.find(({ financeId }) => financeId === '450').countsTowardProgress, false);
  assert.equal(project.records.find(({ financeId }) => financeId === '500'), undefined);
  assert.match(fundingSummaryCsv(summary, false), /"已提交待入账（元）","计入进度（元）"\r\n/);
  assert.match(fundingSummaryCsv(summary, false), /"80.00%","年度台账及学校项目同步",800.00,1600.00/);
});

test('a verified receipt contributes to progress before school exports are available', () => {
  const unverified = receipt('800');
  unverified.control.progress.submission.state = 'verification_required';
  const summary = report([], {
    exports: { year: '2026', sources: [], budgets, records: [] },
    runs: [receipt('700'), unverified],
  });
  assert.equal(summary.totals.hasSchoolData, false);
  assert.equal(summary.totals.hasProgressData, true);
  assert.equal(summary.totals.bookedCny, 0);
  assert.equal(summary.totals.submittedCny, 10000);
  assert.equal(summary.totals.rate, 0.05);
});

test('a locally withdrawn import is visible and excluded from totals without affecting the replacement claim', () => {
  const pending = school('DEMO-OLD', { amountCny: 20000, state: 'pending', status: '提交' });
  const replacement = school('DEMO-NEW', { projectNo: b, amountCny: 20000 });
  const withdrawals = new Set(['DEMO-OLD']);
  const summary = report([pending, replacement], { withdrawals });
  const first = summary.projects.find(({ projectNo }) => projectNo === a);
  const second = summary.projects.find(({ projectNo }) => projectNo === b);
  assert.equal(first.progressCny, 0);
  assert.equal(first.pendingCny, 0);
  assert.deepEqual(first.records.map(({ state, originalStatus, restorable }) => ({ state, originalStatus, restorable })),
    [{ state: 'withdrawn', originalStatus: '提交', restorable: true }]);
  assert.equal(second.bookedCny, 20000);
  assert.match(fundingSummaryCsv(summary, true), /"本机已登记撤回","否",200\.00/);
  assert.equal(report([pending, replacement]).totals.submittedCny, 20000);
  const verified = report([{ ...pending, state: 'booked', status: '已记账' }, replacement], { withdrawals });
  assert.equal(verified.totals.bookedCny, 40000);
  assert.match(verified.issues[0].message, /已按学校入账计算/);
});

test('school payroll export replaces one verified receipt with its actual person rows', () => {
  const local = receipt('LABOR-TEST', { totalCny: 30000, subject: '劳务费', reimbursementRoute: 'labor', payrollRevision: 'v1' });
  const first = school('LABOR-TEST', { kind: 'labor', laborKey: 'person1', projectNo: a, amountCny: 10000 });
  const second = school('LABOR-TEST', { kind: 'labor', laborKey: 'person2', projectNo: a, amountCny: 20000, state: 'pending', status: '待发放' });
  const summary = report([first, { ...first, row: 3 }, second], { runs: [local] });
  assert.equal(summary.totals.progressCny, 30000);
  assert.equal(summary.totals.bookedCny, 10000);
  assert.equal(summary.totals.submittedCny, 20000);
  assert.equal(summary.receipts[0].schoolAmountCny, 30000);
  assert.equal(summary.receipts[0].state, 'pending');
  assert.equal(summary.receipts[0].amountMismatch, false);
});

test('school payroll status removes returned or voided claims and counts verified disbursement once', () => {
  const runs = [['DECLARED', 1], ['PAID', 4], ['RETURNED', 5], ['VOID', 7], ['DRAFT', 0]].map(([financeFormId, code]) => ({
    ...receipt(financeFormId, { subject: '劳务费', payrollRevision: 'v1' }),
    schoolPayrollStatus: { financeFormId, ...schoolPayrollStatus(code) },
  }));
  const records = runs.map(({ schoolPayrollStatus: { financeFormId } }) => school(financeFormId, {
    kind: 'labor', laborKey: financeFormId, projectNo: a, state: 'pending', status: '待发放',
  }));
  const summary = report(records, { runs });
  assert.equal(summary.totals.progressCny, 20000);
  assert.equal(summary.totals.bookedCny, 10000);
  assert.equal(summary.totals.submittedCny, 10000);
  assert.equal(summary.projects.find(({ projectNo }) => projectNo === a).records.length, 2);
  assert.deepEqual(Object.fromEntries(summary.receipts.map(({ financeId, state, status }) => [financeId, [state, status]])), {
    DECLARED: ['pending', '待部门审核'], PAID: ['booked', '已发放'],
    RETURNED: ['excluded', '部门审核驳回'], VOID: ['excluded', '作废'], DRAFT: ['excluded', '新建'],
  });
  assert.equal(report([], { runs }).totals.progressCny, 20000);
  assert.equal(report([], { runs }).totals.localPendingCny, 10000);
});

test('shared school projects keep explicit ledger attributions and exact verified allocations', () => {
  const runs = [receipt('700', { totalCny: 30000, projectAllocationDraft: [
    { projectNo: a, projectName: '学院经费', amountCny: 11000 }, { projectNo: b, projectName: '项目 B' },
  ] })];
  const attributions = new Map([[`${sourceRoot}\0receipt:700:${a}`, 'A-2']]);
  const summary = report([school('700', { projectText: `${a}、${b}`, amountCny: 30000, reason: '=fixture' }),
    school('800', { projectText: `${a}、${b}`, amountCny: 15000 }),
    school('900', { amountCny: 8000 }), school('900', { amountCny: 9000 }),
  ], { runs, attributions });
  assert.equal(summary.totals.rate, 0.15);
  assert.equal(summary.totals.bookedCny, 45000);
  assert.equal(summary.totals.unassignedCny, 15000);
  assert.equal(summary.issues.length, 1);
  const project = summary.projects.find(({ projectNo }) => projectNo === a);
  assert.equal(project.lines.find(({ ledgerNo }) => ledgerNo === 'A-2').bookedCny, 11000);
  assert.equal(project.records[0].allocationSource, '执行助手核对的分配金额');
  assert.match(fundingSummaryCsv(summary, true), /"'=fixture"/);
  assert.match(fundingSummaryCsv(summary, true), /报销单统计.xlsx \/ sheet1 \/ 第 2 行/);
});

test('ledger budgets without a school project stay separate with unknown execution', () => {
  const summary = report([], { exports: {
    year: '2026', sources, records: [school('100')], budgets: [
      budgets[0],
      { ...budgets[1], name: '系部经费', projectNo: '', handlingMode: '托人报销', handlingPerson: '示例代办人' },
      { ...budgets[2], name: '独立项目', projectNo: '' },
    ],
  } });
  assert.equal(summary.totals.budgetCny, 60000);
  assert.equal(summary.totals.coveredCny, 10000);
  assert.deepEqual(Object.fromEntries(summary.projects.map(({ key, budgetCny }) => [key, budgetCny])),
    { [a]: 60000, 'ledger:A-2': 40000, 'ledger:B-1': 100000 });
  const entrusted = summary.projects.find(({ key }) => key === 'ledger:A-2');
  assert.equal(entrusted.rate, null);
  assert.equal(entrusted.lines[0].handlingMode, '托人报销');
  const csv = fundingSummaryCsv(summary, false);
  assert.ok(csv.includes('"台账名目","","系部经费","A-2",400.00,"","","","","","","年度台账","",""'));
});
