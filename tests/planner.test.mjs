import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlan, fingerprintFolder, validatePlanForExecution } from '../lib/planner.mjs';
import { confirmClaimPurpose } from '../lib/claim-purpose.mjs';
import { cachedFixture, concretePurpose } from './fixtures.mjs';

process.env.DEEPSEEK_API_KEY = '';

async function addSource(t, input, options) {
  const second = await cachedFixture(t, options);
  await cp(second.batchDir, join(input.sourceRoot, second.folder), { recursive: true });
  await cp(join(second.appDir, '.runtime/cache', encodeURIComponent(second.folder)), join(input.appDir, '.runtime/cache', encodeURIComponent(second.folder)), { recursive: true });
  return second.folder;
}

test('one grouped plan reconciles all sources and preserves same-named attachment provenance', async (t) => {
  const input = await cachedFixture(t);
  const other = await addSource(t, input, { folder: 'second', invoiceNumber: '12345678901234567891', orderNumber: '2234567890123456', paymentId: 'PAY-0002', invoice: 20000, order: 20000, payment: 20000 });
  const plan = confirmClaimPurpose(await createPlan({ ...input, folder: '@事项/fixture', groupId: 'fixture', sourceFolders: [other, input.folder] }), concretePurpose);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.blockers));
  assert.equal(plan.totalCny, 29000);
  assert.equal(plan.rows.length, 2);
  assert.equal(new Set(plan.uploadFiles.map((file) => file.name)).size, 6);
  assert.ok(plan.uploadFiles.every((file) => plan.fileSources[file.name].name === file.sourceName));
  assert.deepEqual(plan.sourceFolders, [input.folder, other]);
  await validatePlanForExecution({ plan, sourceRoot: input.sourceRoot });
  await writeFile(join(input.sourceRoot, other, '支付.png'), 'changed second-source payment');
  await assert.rejects(validatePlanForExecution({ plan, sourceRoot: input.sourceRoot }), /附件已变化/);
});

test('invoice and payment evidence can be in different folders of the same matter', async (t) => {
  const input = await cachedFixture(t, { payment: null });
  const other = await addSource(t, input, { folder: 'payment-only', omitInvoice: true, order: null, payment: 10000, paymentNote: '订单编号：1234567890123456' });
  const plan = confirmClaimPurpose(await createPlan({ ...input, folder: '@事项/cross-folder', sourceFolders: [input.folder, other] }), concretePurpose);
  assert.equal(plan.status, 'ready', JSON.stringify(plan.blockers));
  assert.equal(plan.totalCny, 10000);
  assert.equal(plan.fileSources[plan.rows[0].paymentFiles[0]].folder, other);
});

test('a complete invoice still needs a saved reimbursement purpose', async (t) => {
  const plan = await createPlan(await cachedFixture(t));
  assert.equal(plan.status, 'blocked');
  assert.match(plan.blockers.join(' '), /报销事项|实际用途/);
});

test('generic office and AI purposes raise a reminder and saved wording is used verbatim', async (t) => {
  const input = await cachedFixture(t);
  const plan = await createPlan(input);
  for (const use of ['打印装订', '办公用品', '教学使用AI服务', '用于课程建设相关工作', '2026年11月AI服务', '第3批办公用品', concretePurpose.matter]) {
    const generic = confirmClaimPurpose(plan, { ...concretePurpose, use });
    assert.equal(generic.status, 'ready');
    assert.match(generic.warnings.join(' '), /具体环节/);
  }
  assert.throws(() => confirmClaimPurpose(plan, { ...concretePurpose, confirmed: false }), /同一事项/);
  const confirmed = confirmClaimPurpose(plan, concretePurpose);
  assert.equal(confirmed.reason, `${concretePurpose.matter}：${concretePurpose.use}`);
  await assert.rejects(validatePlanForExecution({ plan: { ...confirmed, reason: '打印装订' }, sourceRoot: input.sourceRoot }), /事由与本笔/);
});

test('natural sentences can identify the concrete use without requiring a colon', async (t) => {
  const plan = await createPlan(await cachedFixture(t));
  for (const reason of ['课程录音所需设备', '课程资料备份所需硬件', '自建课程平台所需云服务', '硬盘用于金融实训数据备份']) {
    const saved = confirmClaimPurpose(plan, { reason, confirmed: true });
    assert.equal(saved.reason, reason);
    assert.ok(!saved.warnings.some((warning) => /具体用途/.test(warning)));
  }
  for (const reason of ['办公用品', '教学所需办公用品', '科研课题所需资料', '用于课程建设相关工作']) {
    const saved = confirmClaimPurpose(plan, { reason, confirmed: true });
    assert.equal(saved.reason, reason);
    assert.match(saved.warnings.join(' '), /具体/);
  }
});

test('changing the funding project invalidates a previously confirmed purpose', async (t) => {
  const input = await cachedFixture(t);
  const confirmed = confirmClaimPurpose(await createPlan(input), concretePurpose);
  const project = { projectNo: 'TEST-OTHER', projectName: '实验案例建设' };
  const rechecked = await createPlan({ ...input, project, purpose: confirmed.purpose });
  assert.equal(rechecked.purpose, null);
  assert.equal(rechecked.status, 'blocked');
});

test('meal restrictions remain visible on the plan regardless of its expense category', async (t) => {
  const input = await cachedFixture(t, { invoiceItem: '*餐饮服务*误餐费' });
  for (const projectName of ['内涵建设经费—金融学专业建设', '地方高校服务贡献能力跃升计划']) {
    const plan = await createPlan({ ...input, project: { projectNo: 'TEST-MEAL', projectName } });
    const confirmed = confirmClaimPurpose(plan, concretePurpose);
    assert.equal(confirmed.status, 'ready');
    assert.match(confirmed.warnings.join(' '), /不得支出误餐费/);
    await validatePlanForExecution({ plan: confirmed, sourceRoot: input.sourceRoot });
  }
});

test('a successful payment, including a visible discount, determines the claimed cents', async (t) => {
  const input = await cachedFixture(t);
  const plan = await createPlan(input);
  assert.equal(plan.paidTotalCny, 9000);
  assert.equal(plan.totalCny, 9000);
  assert.equal(plan.rows[0].reimbursementAmountCny, 9000);
});

test('cached invoice text normalizes spaces within the label, number, amount and date', async (t) => {
  const input = await cachedFixture(t, { order: null });
  const cachePath = join(input.appDir, '.runtime', 'cache', encodeURIComponent(input.folder), `${input.fingerprint}.json`);
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  const invoice = cache.documents.find((item) => item.kind === 'invoice');
  const number = invoice.invoiceNumber;
  invoice.text = [
    '打印日期：2025年1月2日',
    `发 票\t号　码 ：${number.match(/.{4}/g).join(' ')}`,
    `订单编号：${invoice.orderNumber}       12345`,
    '价 税 合 计 （ 小 写 ） ￥ 1 0 0 . 0 0',
    '开 票 日 期 ：2 0 2 6 年 1 1 月 0 1 日',
  ].join('\n');
  invoice.invoiceNumber = null;
  invoice.invoiceAmountCny = null;
  await writeFile(cachePath, JSON.stringify(cache));

  const plan = await createPlan(input);
  assert.equal(plan.cacheState, 'cached');
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].invoiceNumber, number);
  assert.equal(plan.rows[0].orderNumber, invoice.orderNumber);
  assert.equal(plan.rows[0].date, '2026-11-01');
  assert.equal(plan.invoiceTotalCny, 10000);
  assert.equal(plan.totalCny, 9000);
});

test('refresh reuses unchanged document text and recalculates a replaced payment', async (t) => {
  const input = await cachedFixture(t, { payment: null });
  const cacheFile = join(input.appDir, '.runtime/cache', encodeURIComponent(input.folder), `${input.fingerprint}.json`);
  const initial = await fingerprintFolder(input.sourceRoot, input.folder);
  const raw = JSON.parse(await readFile(cacheFile, 'utf8'));
  for (const doc of raw.documents) doc.file = initial.files.find((file) => file.name === doc.file.name);
  await writeFile(cacheFile, JSON.stringify(raw));
  // Reuse the same public OCR entry point with a synthetic reader for text fixtures.
  const program = new URL('../', import.meta.url);
  const code = join(input.appDir, 'code');
  for (const directory of ['lib', 'public', 'scripts']) await cp(new URL(directory, program), join(code, directory), { recursive: true });
  await writeFile(join(code, 'package.json'), '{"type":"module"}');
  await writeFile(join(code, 'scripts', 'rapid_ocr.py'), `from pathlib import Path\nimport json, sys\nitems=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))['files']\nassert all(item['name'] == 'payment.txt' for item in items)\nPath(sys.argv[2]).write_text(json.dumps({'files':[{'name':item['name'],'pages':[Path(item['path']).read_text(encoding='utf-8')]} for item in items]}), encoding='utf-8')\n`);
  const { createPlan: planFromFixtures } = await import(pathToFileURL(join(code, 'lib', 'planner.mjs')));
  const payment = join(input.batchDir, 'payment.txt');
  const evidence = '交易成功\n交易金额：75.25\n订单编号：1234567890123456';
  await writeFile(payment, evidence);
  const checked = await planFromFixtures(input);
  assert.equal(checked.cacheState, 'new');
  assert.equal(checked.totalCny, 7525);
  await writeFile(payment, evidence.replace('75.25', '89.50'));
  const updated = await planFromFixtures(input);
  assert.notEqual(updated.fingerprint, checked.fingerprint);
  assert.equal(updated.invoiceTotalCny, 10000);
  assert.equal(updated.totalCny, 8950);
  assert.equal((await planFromFixtures(input)).cacheState, 'cached');
});

test('a payment can establish the amount when the invoice has no matching order', async (t) => {
  const input = await cachedFixture(t, { order: null });
  const plan = await createPlan(input);
  assert.equal(plan.paidTotalCny, 9000);
  assert.equal(plan.totalCny, 9000);
});

test('missing payment is unresolved and blocks execution instead of becoming the invoice amount', async (t) => {
  const plan = await createPlan(await cachedFixture(t, { payment: null }));
  assert.equal(plan.paidTotalCny, null);
  assert.equal(plan.totalCny, null);
  assert.ok(plan.blockers.some((message) => /支付|付款/.test(message)));
});

test('identical copies of an invoice contribute once to money and uploaded invoices', async (t) => {
  const plan = await createPlan(await cachedFixture(t, { payment: 10000, duplicate: true }));
  assert.equal(plan.rows.length, 1);
  assert.equal(plan.totalCny, 10000);
  assert.equal(plan.uploadFiles.filter((file) => /发票/.test(file.name)).length, 1);
});

test('pending-signature receipts are reminders and are excluded from upload', async (t) => {
  const input = await cachedFixture(t, { payment: 10000, subject: '办公用品', extra: [{ name: '签收单-待签字.xlsx', kind: 'receipt', text: '签收单 编号 项目 数量 放置位置 签字' }] });
  const plan = confirmClaimPurpose(await createPlan(input), concretePurpose);
  assert.equal(plan.status, 'ready');
  assert.ok(plan.warnings.some((message) => /缺少已核对签字的签收单/.test(message)));
  assert.ok(plan.uploadFiles.every((file) => !/待签字/.test(file.name)));
  await validatePlanForExecution({ plan, sourceRoot: input.sourceRoot });
});


test('ready plans reject file changes, including same-length replacement bytes', async (t) => {
  const input = await cachedFixture(t);
  const plan = confirmClaimPurpose(await createPlan(input), concretePurpose);
  assert.equal(plan.status, 'ready');
  await validatePlanForExecution({ plan, sourceRoot: input.sourceRoot });
  await writeFile(join(input.batchDir, '支付.png'), input.records.find((record) => record.kind === 'payment').text.replace('90.00', '80.00'));
  await assert.rejects(validatePlanForExecution({ plan, sourceRoot: input.sourceRoot }), /附件已变化/);
});

test('execution checks new submission history even when attachments are unchanged', async (t) => {
  const input = await cachedFixture(t);
  const plan = confirmClaimPurpose(await createPlan(input), concretePurpose);
  await assert.rejects(validatePlanForExecution({ plan, sourceRoot: input.sourceRoot, historyInvoiceNumbers: [plan.rows[0].invoiceNumber] }), /重复|已在/);
  assert.ok(plan.paymentKeys.length > 0);
  await assert.rejects(validatePlanForExecution({ plan, sourceRoot: input.sourceRoot, historyPaymentKeys: plan.paymentKeys }), /付款已记入另一报销单/);
});

test('old policy versions and blocked plans cannot execute through the server boundary', async (t) => {
  const input = await cachedFixture(t);
  const plan = confirmClaimPurpose(await createPlan(input), concretePurpose);
  await assert.rejects(validatePlanForExecution({ plan: { ...plan, version: 1 }, sourceRoot: input.sourceRoot }), /规则已更新/);
  await assert.rejects(validatePlanForExecution({ plan: { ...plan, status: 'blocked', blockers: ['缺少实付金额'] }, sourceRoot: input.sourceRoot }), /缺少实付金额/);
});
