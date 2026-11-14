import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { planProjects } from '../public/project-allocation.js';
import { pythonExecutable } from './platform.mjs';

const readExcel = fileURLToPath(new URL('../scripts/read_funding_exports.py', import.meta.url));
const execute = promisify(execFile);
const CATEGORIES = { labor: '劳务费', transport: '市内交通费', other: '其他费用' };
const LOCAL_TRANSPORT = /市内(?:交通|差旅|出行|用车)|贸大出行|公交|地铁|出租车|打车/;
const SUBMITTED_STATUS = /^已提交|^(?:提交(?:成功)?|(?:财务|部门)?(?:预审|审批|审核)(?:中|通过|完成|成功)|待(?:预审|审批|审核|制单|支付|付款|接单|受理)|(?:财务|部门)?已(?:预审|审核|审批|接单|受理|预约|投递|收单|处理完成)|(?:支付|受理|处理)中|处理完成)$/;
const projectNumber = (value) => String(value || '').trim().toUpperCase();
export const documentNumber = (value) => String(value || '').trim().replace(/^(\d+)\.0+$/, '$1');
const amountsByCategory = () => ({ labor: 0, transport: 0, other: 0 });

async function readExcelJson(args, env = process.env) {
  const { stdout } = await execute(pythonExecutable(), ['-X', 'utf8', readExcel, ...args], { timeout: 30000, maxBuffer: 16 * 1024 * 1024, env })
    .catch(() => { throw new Error('无法读取年度执行表，请确认票据目录和本机的 Excel 读取组件。'); });
  return JSON.parse(stdout);
}

export const readFundingExports = (sourceRoot, year) => readExcelJson(year ? [sourceRoot, year] : [sourceRoot]);
export const readPayrollPeople = (sourceRoot, category, key) => readExcelJson(
  ['--payroll-people', sourceRoot, category], { ...process.env, REIMBURSEMENT_PAYROLL_KEY: key },
);
export const readDownloadedRegister = (file, kind) => readExcelJson([kind === 'labor' ? '--labor' : '--register', file]);

function expenseCategory(record) {
  const item = record.kind === 'labor' ? record.reason : `${record.item || ''} ${record.business || ''}`;
  if (LOCAL_TRANSPORT.test(item)) return 'transport';
  return record.kind === 'labor' || /劳务费/.test(item) ? 'labor' : 'other';
}

function isSubmitted(record) {
  if (record.state !== 'pending') return false;
  const status = String(record.status || '').normalize('NFKC').replace(/\s/g, '');
  if (/未提交|待提交|草稿|驳回|退回|撤回|撤销|作废|取消|删除|终止|失败|未成功|不通过/.test(status)) return false;
  return record.kind === 'runner' || (record.kind === 'labor' && ['待发放', '待部门审核', '待财务审核', '已审核'].includes(status)) || SUBMITTED_STATUS.test(status);
}

function projectNumbers(record) {
  if (record.projectNo) return [projectNumber(record.projectNo)];
  const value = projectNumber(record.projectText);
  const matches = value.matchAll(/(?<![A-Z0-9])[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+/g);
  return [...new Set(Array.from(matches, ({ 0: code, index }) => value[index + code.length] === '年' ? code.replace(/-20\d{2}$/, '') : code))];
}

function acceptedReceipts(runs, sourceRoot, year) {
  const receipts = new Map();
  for (const run of runs) {
    const proof = run.control?.progress?.submission;
    if (run.sourceRoot !== sourceRoot || proof?.state !== 'verified' || !run.bookkeeping?.historyRecorded) continue;
    const id = documentNumber(proof.financeFormId || proof.documentId);
    const date = proof.verifiedAt ? new Date(proof.verifiedAt) : null;
    const localDate = date && !Number.isNaN(+date) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(date) : '';
    if (!id || year && localDate && !localDate.startsWith(year)) continue;
    const allocations = planProjects(run.plan).map((project) => ({ ...project, projectNo: projectNumber(project.projectNo) }));
    const payroll = Boolean(run.plan.payrollRevision);
    const school = payroll && run.schoolPayrollStatus?.financeFormId === id ? run.schoolPayrollStatus : null;
    receipts.set(id, {
      financeId: id, allocations, amountCny: run.plan.totalCny, date: localDate, kind: 'runner',
      file: '执行助手回执', reason: run.plan.reason, category: expenseCategory({ item: run.plan.subject, business: run.plan.expenseType }),
      state: school?.state || 'pending', status: school?.label || '已收学校回执', payroll, school,
    });
  }
  return receipts;
}

function reference(record) {
  return { file: record.file, sheet: record.sheet, row: record.row };
}

function partitionReceipt(record, local) {
  if (record.projects.length === 1) {
    const projectNo = record.projects[0];
    return [{ projectNo, amountCny: record.amountCny, projectName: local?.allocations.find((project) => project.projectNo === projectNo)?.projectName }];
  }
  const allocations = local?.allocations || [];
  const exact = allocations.length > 0 && new Set(allocations.map(({ projectNo }) => projectNo)).size === allocations.length &&
    allocations.every(({ projectNo, amountCny }) => projectNo && Number.isSafeInteger(amountCny) && amountCny > 0) &&
    allocations.reduce((sum, item) => sum + item.amountCny, 0) === record.amountCny &&
    (record.kind === 'runner' || allocations.length === record.projects.length && allocations.every(({ projectNo }) => record.projects.includes(projectNo)));
  if (exact) return allocations;
  return [{ projectNo: '', amountCny: record.amountCny }];
}

function mergeRecords(records, receipts, issues, reconciliation, withdrawals, restorable) {
  const byReceipt = new Map();
  const payrollRows = new Map();
  for (const record of records) {
    const id = documentNumber(record.financeId);
    const payroll = record.kind === 'labor' ? receipts.get(id) : null;
    if (payroll?.school?.state === 'excluded') continue;
    const key = record.kind === 'labor' ? `labor:${record.laborKey}` : `receipt:${id}`;
    if (!byReceipt.has(key)) byReceipt.set(key, []);
    const current = payroll?.school && record.state !== 'excluded' && (payroll.state === 'booked' || record.state === 'pending') ?
      { state: payroll.state, status: payroll.status } : {};
    byReceipt.get(key).push({ ...record, ...current, financeId: id, projects: projectNumbers(record), category: expenseCategory(record) });
    if (payroll?.payroll && !payrollRows.has(id)) payrollRows.set(id, { entries: [], source: reference(record) });
  }
  for (const [id, receipt] of receipts) {
    const key = `receipt:${id}`;
    if (receipt.state !== 'excluded' && !byReceipt.has(key) && !payrollRows.has(id)) {
      byReceipt.set(key, [{ ...receipt, projects: receipt.allocations.map(({ projectNo }) => projectNo) }]);
    }
  }
  const entries = [];
  for (const [key, group] of byReceipt) {
    const refs = group.map(reference);
    const receipt = group[0].financeId;
    const local = key.startsWith('receipt:') ? receipts.get(receipt) : null;
    const withdrawal = key.startsWith('receipt:') && withdrawals.has(receipt);
    const noteSchool = (state, record) => {
      if (!local || local.payroll || record.kind === 'runner') return;
      const schoolAmountCny = Number.isSafeInteger(record.amountCny) ? record.amountCny : null;
      reconciliation.set(receipt, { financeId: receipt, date: local.date, amountCny: local.amountCny,
        state, status: record.status, schoolAmountCny, source: reference(record),
        amountMismatch: schoolAmountCny !== null && local.amountCny !== schoolAmountCny });
    };
    const active = group.filter(({ state }) => state !== 'excluded');
    if (!active.length) { noteSchool('excluded', group[0]); continue; }
    const booked = active.filter(({ state }) => state === 'booked');
    if (withdrawal && booked.length) {
      issues.push({ receipt, message: '本机曾登记撤回，但新版学校表有已入账记录，已按学校入账计算，请核对', sources: refs });
    }
    const preferred = booked.length ? booked : active;
    const valid = preferred.filter(({ amountCny }) => Number.isSafeInteger(amountCny));
    if (!valid.length) {
      noteSchool('conflict', preferred[0]);
      issues.push({ receipt, message: '金额为空或无法读取', sources: refs });
      continue;
    }
    const signatures = new Set(valid.map(({ amountCny, category, projects }) => JSON.stringify([amountCny, category, [...projects].sort()])));
    if (signatures.size > 1 || active.length !== group.length) {
      noteSchool('conflict', valid[0]);
      issues.push({ receipt, message: '同一单据的项目、金额、科目或状态有冲突', sources: refs });
      continue;
    }
    const record = valid.find(isSubmitted) ?? valid[0];
    noteSchool(record.state, record);
    const localWithdrawal = withdrawal && record.state === 'pending' && ['smart', 'legacy'].includes(record.kind);
    const countsTowardProgress = !localWithdrawal && (record.state === 'booked' || isSubmitted(record));
    const parts = partitionReceipt(record, local);
    const rowEntries = parts.map((part) => ({
      key: `${key}:${part.projectNo}`, financeId: receipt, projectNo: part.projectNo, projectName: part.projectName || record.projectName || '',
      amountCny: part.amountCny, date: record.date, reason: record.reason, category: record.category,
      state: localWithdrawal ? 'withdrawn' : record.state, status: localWithdrawal ? '本机已登记撤回' : record.status, countsTowardProgress,
      kind: record.kind, source: reference(record),
      ...(localWithdrawal ? { originalStatus: record.status, restorable: restorable.has(receipt) } : {}),
      ...(parts.length > 1 && record.kind !== 'runner' ? { allocationSource: '执行助手核对的分配金额' } : {}),
      ...(part.projectNo ? {} : { projectText: record.projectText || record.projects.join('、') }),
    }));
    entries.push(...rowEntries);
    if (record.kind === 'labor') payrollRows.get(receipt)?.entries.push(...rowEntries);
  }
  for (const [id, school] of payrollRows) {
    const local = receipts.get(id);
    const schoolAmountCny = school.entries.length ? school.entries.reduce((sum, row) => sum + row.amountCny, 0) : null;
    const sameProject = school.entries.every((row) => row.projectNo === local.allocations[0]?.projectNo);
    const state = !school.entries.length || !sameProject ? 'conflict' : school.entries.every((row) => row.state === 'booked') ? 'booked' : 'pending';
    reconciliation.set(id, {
      financeId: id, date: local.date, amountCny: local.amountCny, schoolAmountCny, state, source: school.source,
      status: local.school && state === local.state ? local.status :
        state === 'booked' ? '学校执行表已登记' : state === 'pending' ? '学校执行表待发放' : '学校薪酬明细待核对',
      amountMismatch: schoolAmountCny !== null && schoolAmountCny !== local.amountCny,
    });
  }
  return entries.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.financeId.localeCompare(b.financeId));
}

function projectTotals(records) {
  const categories = amountsByCategory();
  const progressCategories = amountsByCategory();
  let pendingCny = 0;
  let submittedCny = 0;
  for (const record of records) {
    if (record.state === 'booked') categories[record.category] += record.amountCny;
    else if (record.state === 'pending') {
      pendingCny += record.amountCny;
      if (record.countsTowardProgress) submittedCny += record.amountCny;
    }
    if (record.countsTowardProgress) progressCategories[record.category] += record.amountCny;
  }
  const bookedCny = Object.values(categories).reduce((sum, amount) => sum + amount, 0);
  return { categories, bookedCny, pendingCny, submittedCny, progressCategories, progressCny: bookedCny + submittedCny };
}

export function summarizeFunding({ exports, sourceRoot, projects = [], runs = [], attributions = new Map(), withdrawals = new Set(), restorable = withdrawals }) {
  const { year, budgets, records, sources } = exports;
  const catalog = new Map(projects.map((project) => [projectNumber(project.projectNo), project]));
  const receipts = acceptedReceipts(runs, sourceRoot, year);
  const issues = [];
  const reconciliation = new Map([...receipts].map(([financeId, { date, amountCny, school }]) => [financeId, {
    financeId, date, amountCny, state: school?.state || 'missing',
    ...(school ? { status: school.label, source: { file: '学校薪酬申报' } } : {}),
  }]));
  const entries = mergeRecords(records, receipts, issues, reconciliation, withdrawals, restorable);
  const ledger = new Map();
  for (const budget of budgets) {
    const row = { ...budget, projectNo: projectNumber(budget.projectNo) };
    const previous = ledger.get(row.ledgerNo);
    if (previous && (previous.budgetCny !== row.budgetCny || previous.projectNo !== row.projectNo || previous.name !== row.name)) {
      ledger.set(row.ledgerNo, { ...previous, budgetCny: null });
      issues.push({ receipt: row.ledgerNo, message: '台账编号重复且预算或项目不一致', sources: [reference(previous), reference(row)] });
    } else if (!previous) {
      ledger.set(row.ledgerNo, row);
      if (!Number.isSafeInteger(row.budgetCny) || row.budgetCny < 0) issues.push({ receipt: row.ledgerNo, message: '台账预算为空或无法读取', sources: [reference(row)] });
    }
  }
  const grouped = new Map();
  function groupFor(key, projectNo) {
    if (!grouped.has(key)) grouped.set(key, { key, projectNo, lines: [], records: [] });
    return grouped.get(key);
  }
  for (const line of ledger.values()) groupFor(line.projectNo || `ledger:${line.ledgerNo}`, line.projectNo).lines.push(line);
  const unassigned = [];
  for (const record of entries) {
    if (record.projectNo) groupFor(record.projectNo, record.projectNo).records.push(record);
    else unassigned.push(record);
  }
  const schoolNames = new Map();
  for (const record of records) {
    const [no, ...more] = projectNumbers(record);
    if (!no || more.length || schoolNames.has(no)) continue;
    const label = record.projectName || record.projectText?.trim().slice(no.length).replace(/^[\s\-—：:]+/, '');
    if (label) schoolNames.set(no, label);
  }
  const summaries = [...grouped.values()].map(({ lines, records: projectRecords, projectNo, ...project }) => {
    const official = catalog.get(projectNo);
    const ledgerTotal = lines.length && lines.every(({ budgetCny }) => Number.isSafeInteger(budgetCny) && budgetCny >= 0)
      ? lines.reduce((sum, line) => sum + line.budgetCny, 0) : null;
    const schoolTotal = official?.totalCny;
    const budgetCny = ledgerTotal ?? (Number.isSafeInteger(schoolTotal) && schoolTotal > 0 ? schoolTotal : null);
    const budgetSource = ledgerTotal !== null ? '年度台账' : budgetCny !== null ? '学校项目同步' : '';
    const name = (lines.length === 1 ? lines[0].name : '') || schoolNames.get(projectNo) || official?.projectName || projectRecords.find((record) => record.projectName)?.projectName || projectNo;
    const mapped = projectRecords.map((record) => {
      const key = `${sourceRoot}\0${record.key}`;
      const ledgerNo = lines.length === 1 ? lines[0].ledgerNo : attributions.get(key);
      const line = lines.find((item) => item.ledgerNo === ledgerNo);
      return { ...record, ledgerNo: line?.ledgerNo || '', ledgerName: line?.name || '' };
    });
    const totals = projectTotals(mapped);
    const unattributed = projectTotals(mapped.filter(({ ledgerNo }) => !ledgerNo));
    const rate = projectNo && budgetCny > 0 ? totals.progressCny / budgetCny : null;
    return { ...project, projectNo, name, budgetCny, budgetSource, rate, ...totals, records: mapped,
      lines: lines.map((line) => ({ ...line, ...projectTotals(mapped.filter(({ ledgerNo }) => ledgerNo === line.ledgerNo)) })),
      unassignedCny: unattributed.bookedCny, unassignedProgressCny: unattributed.progressCny,
    };
  }).sort((a, b) => b.progressCny - a.progressCny || a.name.localeCompare(b.name, 'zh-CN'));
  const covered = summaries.filter(({ rate }) => rate !== null);
  const budgetCny = covered.reduce((sum, project) => sum + project.budgetCny, 0);
  const coveredCny = covered.reduce((sum, project) => sum + project.progressCny, 0);
  const actual = projectTotals(entries);
  const hasSchoolData = sources.some(({ kind, state }) => kind !== 'budget' && state === 'read') ||
    [...receipts.values()].some(({ school }) => school?.state === 'booked');
  const verifiedReceipts = entries.filter(({ kind }) => kind === 'runner');
  return {
    year, sourceRoot, categories: CATEGORIES, projects: summaries, unassigned, issues, receipts: [...reconciliation.values()].sort((a, b) => b.date.localeCompare(a.date) || a.financeId.localeCompare(b.financeId)),
    sources: [...sources, { kind: 'runner', file: '执行助手回执', state: 'read', rowCount: new Set(verifiedReceipts.map(({ financeId }) => financeId)).size,
      lastDate: verifiedReceipts.map(({ date }) => date).sort().at(-1) || '' }],
    totals: { ...actual, budgetCny, coveredCny, rate: budgetCny > 0 ? coveredCny / budgetCny : null, unassignedCny: projectTotals(unassigned).bookedCny,
      localPendingCny: verifiedReceipts.filter(({ state }) => state === 'pending').reduce((sum, record) => sum + record.amountCny, 0),
      hasSchoolData, hasProgressData: hasSchoolData || entries.some(({ countsTowardProgress }) => countsTowardProgress),
    },
  };
}

export function fundingSummaryCsv(summary, details) {
  const yuan = (cents) => Number.isSafeInteger(cents) ? cents / 100 : '';
  const pct = (rate) => rate === null || !summary.totals.hasProgressData ? '' : `${(rate * 100).toFixed(2)}%`;
  const source = ({ file, sheet, row }) => [file, sheet, row ? `第 ${row} 行` : ''].filter(Boolean).join(' / ');
  const amounts = (item) => [item.categories.labor, item.categories.transport, item.categories.other, item.bookedCny, item.pendingCny].map(yuan);
  const booked = (item) => {
    if (item.projectNo === '') return ['', '', '', '', ''];
    return summary.totals.hasSchoolData ? amounts(item) : ['', '', '', '', yuan(item.pendingCny)];
  };
  const progress = (item) => summary.totals.hasProgressData && item.projectNo !== '' ? [item.submittedCny, item.progressCny].map(yuan) : ['', ''];
  const csv = (value) => {
    if (typeof value === 'number') return value.toFixed(2);
    const text = String(value ?? '');
    const safe = /^[\t\r\n]|^\s*[=+\-@＝＋－＠]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const totals = summary.totals;
  const unassigned = projectTotals(summary.unassigned);
  const rows = details ? [
    ['年度', '学校项目编号', '学校项目', '台账编号', '台账名目', '报销单号', '日期', '类别', '状态', '计入已报销', '金额（元）', '事由', '来源', '分配依据', '计入进度'],
    ...summary.projects.flatMap((project) => project.records.map((record) => recordRow(project, record))),
    ...summary.unassigned.map((record) => recordRow({ name: '待确认学校项目' }, record)),
  ] : [
    ['年度', '层级', '学校项目编号', '项目或台账名目', '台账编号', '预算（元）', '劳务费（元）', '市内交通费（元）', '其他费用（元）', '已报销（元）', '未入账参考（元）', '执行率', '预算来源', '已提交待入账（元）', '计入进度（元）'],
    [summary.year, '合计', '', '已关联预算项目执行率', '', yuan(totals.budgetCny), ...booked(totals), pct(totals.rate), '年度台账及学校项目同步', ...progress(totals)],
    ...summary.projects.flatMap((project) => [
      [summary.year, project.projectNo ? '学校项目' : '台账名目', project.projectNo, project.name,
        project.projectNo ? '' : project.lines[0].ledgerNo, yuan(project.budgetCny), ...booked(project), pct(project.rate), project.budgetSource, ...progress(project)],
      ...(project.lines.length > 1 ? project.lines.map((line) => [summary.year, '台账名目', project.projectNo, line.name, line.ledgerNo, yuan(line.budgetCny), ...booked(line), '', source(line), ...progress(line)]) : []),
    ]),
    ...(summary.unassigned.length ? [[summary.year, '待确认学校项目', '', '', '', '', ...booked(unassigned), '', '', ...progress(unassigned)]] : []),
  ];
  return `\uFEFF${rows.map((row) => row.map(csv).join(',')).join('\r\n')}\r\n`;

  function recordRow(project, record) {
    return [summary.year, record.projectNo, project.name, record.ledgerNo, record.ledgerName, record.financeId, record.date,
      CATEGORIES[record.category], record.status, record.state === 'withdrawn' ? '否' : record.state === 'booked' ? '是' : '待入账',
      yuan(record.amountCny), record.reason, source(record.source), record.allocationSource,
      record.state === 'withdrawn' ? '否' : record.countsTowardProgress ? '是' : '待核对'];
  }
}
