import test from 'node:test';
import assert from 'node:assert/strict';
import { ReimbursementExecutor } from '../lib/executor.mjs';
import { didiInvoiceWindow } from '../lib/didi-invoices.mjs';

const executor = (options = {}) => new ReimbursementExecutor({ plan: {}, appDir: '/private/tmp', onEvent() {}, ask: async () => '', ...options });

test('stage detection gives a visible signer dialog priority over its underlying payment form', async () => {
  const instance = executor();
  instance.bodyText = async () => '单据填报-日常报销\n报销支出费用明细\n请选择线上审批加签人';
  assert.equal(await instance.detectStage(), 'signer');
});

test('body observation uses the same work context as actions, excluding unrelated frames', async () => {
  const frame = (text) => ({ locator: () => ({ innerText: async () => text }) });
  const active = frame('经费预算信息');
  const unrelated = frame('确认提交报销单 提交成功');
  const instance = executor();
  instance.page = { frames: () => [active, unrelated] };
  instance.work = async () => active;
  assert.equal(await instance.bodyText(), '经费预算信息');
});

test('expense type dialogs are resolved inside the owned work frame only', async () => {
  const activeDialog = { filter() { return this; }, last() { return this; }, count: async () => 1 };
  const instance = executor();
  instance.work = async () => ({ locator: () => activeDialog });
  instance.page = { frames: () => { throw new Error('unrelated frames must not be inspected'); } };
  assert.equal(await instance.expenseDialogRoot(), activeDialog);
});

test('a recorded ambiguous submission never clicks the submit button on resume', async () => {
  const instance = executor({ control: { progress: { submission: { state: 'attempted' } } } });
  let opened = 0;
  instance.openPlatform = async () => { opened += 1; };
  instance.run = ReimbursementExecutor.prototype.run.bind(instance);
  assert.equal(await instance.run(), 'verification_required');
  assert.equal(opened, 0);
});

test('Didi checks the invoice year before resuming a draft or submitting for pre-review', async () => {
  const { firstYear } = didiInvoiceWindow();
  const instance = executor({ plan: { didi: { budgetCny: 10000 }, rows: [{ date: `${firstYear - 1}-12-31` }] }, resumeStages: true });
  instance.openPlatform = async () => {};
  instance.detectStage = async () => assert.fail('an expired invoice must be stopped before filling');
  await assert.rejects(instance.run(), /滴滴发票开票日期.*超出报销年度/);
  await assert.rejects(instance.submitPreReview(), /滴滴发票开票日期.*超出报销年度/);
  assert.equal(instance.progress.submission.state, 'not_started');
});

test('discounted invoice verification reads the live input rather than its invoice limit suffix', async () => {
  let questions = 0;
  const instance = executor({ plan: { totalCny: 9000, rows: [{ invoiceNumber: '12345678901234567890', reimbursementAmountCny: 9000 }] }, ask: async () => { questions += 1; return '继续'; } });
  instance.bodyText = async () => '报销支出费用明细\n金额\n100.00/100.00\n待分配金额：0.00';
  instance.detailAmountSnapshot = async () => ({ rows: [{ invoiceNumber: '12345678901234567890', amountCny: 9000 }], remainingCny: 0 });
  await instance.verifyDetailAmounts();
  assert.equal(questions, 0);
  assert.equal(instance.progress.detailVerified, true);
});

test('equal grand totals do not excuse wrong per-invoice reimbursement amounts', async () => {
  const instance = executor({ plan: { totalCny: 19000, rows: [{ invoiceNumber: '12345678901234567890', reimbursementAmountCny: 9000 }, { invoiceNumber: '12345678901234567891', reimbursementAmountCny: 10000 }] } });
  instance.bodyText = async () => '金额\n80.00/80.00\n金额\n110.00/110.00\n待分配金额：0.00';
  instance.detailAmountSnapshot = async () => ({ rows: [{ invoiceNumber: '12345678901234567890', amountCny: 8000 }, { invoiceNumber: '12345678901234567891', amountCny: 11000 }], remainingCny: 0 });
  await assert.rejects(instance.verifyDetailAmounts(), /金额|逐张/);
  assert.notEqual(instance.progress.detailVerified, true);
});

test('rechecking a wrong invoice breakdown keeps the run waiting until the breakdown matches', async () => {
  const rows = [
    { invoiceNumber: '12345678901234567890', reimbursementAmountCny: 9000 },
    { invoiceNumber: '12345678901234567891', reimbursementAmountCny: 10000 },
  ];
  const replies = [];
  const instance = executor({ plan: { totalCny: 19000, rows }, ask: async (question, metadata) => {
    assert.equal(metadata.kind, 'amount_review');
    replies.push(question);
    return '继续';
  } });
  let reads = 0;
  instance.detailAmountSnapshot = async () => {
    const shown = ++reads <= 2 ? [8000, 11000] : [9000, 10000];
    return { rows: rows.map(({ invoiceNumber }, index) => ({ invoiceNumber, amountCny: shown[index] })), remainingCny: 0 };
  };
  instance.bodyText = async () => rows.map(({ invoiceNumber }) => invoiceNumber).join('\n');
  await instance.verifyDetailAmounts();
  assert.equal(replies.length, 2);
  assert.match(replies[0], /第 1 张应报 90.00 元，学校显示 80.00 元/);
  assert.equal(instance.progress.detailVerified, true);
});

test('an existing draft stops immediately without reloading it', async () => {
  let reloads = 0;
  const instance = executor();
  instance.bodyText = async () => '单据填报-日常报销';
  instance.page = { reload: async () => { reloads += 1; }, waitForTimeout: async () => {} };
  await assert.rejects(instance.openClaim(), /草稿|覆盖/);
  assert.equal(reloads, 0);
});

test('cached invoice numbers alone cannot identify the currently displayed draft', async () => {
  const instance = executor({ plan: { reason: '教学使用测试', totalCny: 9000, project: { projectNo: 'A3A-TEST' }, signer: { name: '测试人', employeeNo: '980001' }, rows: [{ invoiceNumber: '12345678901234567890' }] }, control: { progress: { verifiedInvoiceNumbers: ['12345678901234567890'], paymentVerified: true, detailVerified: true } } });
  instance.bodyText = async () => '确认提交报销单\n教学使用测试 A3A-TEST 测试人 980001\n报销金额：90.00';
  await assert.rejects(instance.verifyConfirmation(), /身份|单据|发票/);
});

test('a bound stable document id permits continuity when final pages omit invoice numbers', async () => {
  const instance = executor({ plan: { rows: [{ invoiceNumber: '12345678901234567890' }] }, control: { progress: { documentId: 'DOC-000001' } } });
  assert.deepEqual(await instance.assertDocumentIdentity('报销单号：DOC-000001\n确认提交报销单'), { currentId: 'DOC-000001', invoicesVisible: false });
  await assert.rejects(instance.assertDocumentIdentity('报销单号：DOC-000002\n12345678901234567890'), /编号已变化/);
});

test('a new failure toast saying 未提交成功 cannot become a submission receipt', async () => {
  let clicks = 0;
  const instance = executor({ plan: { reason: '教学使用测试', totalCny: 9000, fingerprint: 'fixture', project: { projectNo: 'A3A-TEST' }, signer: { name: '测试人' }, rows: [{ invoiceNumber: '12345678901234567890' }], uploadFiles: [] }, ask: async () => '确认提交' });
  const chain = { filter() { return this; }, last() { return this; }, count: async () => 0, evaluateAll: async (read) => read([]) };
  const scope = {
    url: () => 'http://127.0.0.1/claim',
    locator(selector) {
      if (selector === 'body') return { innerText: async () => '未提交成功，请稍后重试' };
      if (selector.includes('data-rbx-prior-notice')) return { allInnerTexts: async () => ['未提交成功，请稍后重试'] };
      if (selector.includes('.el-message,')) return { evaluateAll: async () => {} };
      return chain;
    },
    getByRole() { return { click: async () => { clicks += 1; } }; },
  };
  instance.work = async () => scope;
  instance.waitText = async () => {};
  instance.verifyConfirmation = async () => '确认提交报销单 教学使用测试 报销金额：90.00';
  instance.page = { waitForTimeout: async () => {} };
  instance.submissionTimeoutMs = 10;
  assert.equal(await instance.confirmAndFinish(), 'verification_required');
  assert.equal(clicks, 1);
  assert.equal(instance.progress.submission.state, 'verification_required');
});

test('cancelling while the submission intent is being saved prevents the click and preserves its latch', async () => {
  let clicks = 0;
  const control = {};
  const instance = executor({ plan: { reason: '教学使用测试', totalCny: 9000, fingerprint: 'fixture', project: { projectNo: 'A3A-TEST' }, signer: { name: '测试人' }, rows: [], uploadFiles: [] }, control, ask: async () => '确认提交', onProgress: async (progress) => { if (progress.submission.state === 'attempted') control.cancelled = true; } });
  instance.work = async () => ({ url: () => 'http://127.0.0.1/claim', locator: () => ({ evaluateAll: async () => {}, filter() { return this; }, last() { return this; }, count: async () => 0 }), getByRole: () => ({ click: async () => { clicks += 1; } }) });
  instance.waitText = async () => {};
  instance.verifyConfirmation = async () => '确认提交报销单 教学使用测试 报销金额：90.00';
  instance.page = { waitForTimeout: async () => {} };
  assert.equal(await instance.confirmAndFinish(), 'verification_required');
  assert.equal(clicks, 0);
  assert.notEqual(instance.progress.submission.state, 'not_started');
});
