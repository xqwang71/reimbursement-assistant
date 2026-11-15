import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { reconcileClaim } from '../lib/claim-policy.mjs';
import { createPlan, fingerprintFolder, SELECTION_VERSION } from '../lib/planner.mjs';
import { confirmClaimPurpose } from '../lib/claim-purpose.mjs';
import { concretePurpose } from './fixtures.mjs';

const invoiceNo = (index) => String(index).padStart(20, '2');
const document = (name, fields = {}) => ({
  file: { name, absolutePath: `/synthetic/${name}`, sha256: `sha-${name}` },
  text: '交易成功', invoiceNumber: null, invoiceAmountCny: null, orderNumber: null,
  orderAmountCny: null, paymentAmountCny: null, ...fields,
});
const invoice = (index, amount, fields = {}) => document(`发票${index}.pdf`, { invoiceNumber: invoiceNo(index), invoiceAmountCny: amount, ...fields });
const order = (index, amount, fields = {}) => document(`订单${index}.pdf`, { orderNumber: `order-${index}`, orderAmountCny: amount, ...fields });
const payment = (index, amount, fields = {}) => document(`支付${index}.png`, { paymentAmountCny: amount, transactionId: `payment-${index}`, ...fields });
const link = (orderFile, ...paymentFiles) => ({ detail: orderFile ? [orderFile] : [], payment: paymentFiles });
const bankReceipt = '收支详情\n-100.00\n交易卡号\n1234****1234\n交易时间\n2026-07-08\n记账时间\n2026-07-0810:03:15\n业务摘要\n消费\n交易场所\n网银在线-示例京东自营店\n交易金额\n100.00\n记账金额\n100.00\n记账币种\n人民币';
function assess(documents, extra = {}) {
  return reconcileClaim({ documents, files: documents.map((item) => item.file), subject: '书籍资料', confirmations: { paymentCardConfirmed: true }, ...extra });
}

test('invoice amount is capped by the actual successful payment', () => {
  const documents = [invoice(1, 10000), order(1, 10000), payment(1, 9000)];
  const result = assess(documents, { selection: { matches: { '发票1.pdf': link('订单1.pdf', '支付1.png') } } });
  assert.equal(result.status, 'ready');
  assert.equal(result.totalCny, 9000);
  assert.equal(result.paidTotalCny, 9000);
});

test('matching only by amount or folder is not a confirmed invoice-to-payment association', () => {
  const result = assess([invoice(1, 10000), order(1, 10000), payment(1, 9000)]);
  assert.equal(result.status, 'blocked');
  assert.equal(result.totalCny, null);
  assert.match(result.blockers.join(' '), /已识别付款 90\.00 元，请确认对应发票/);
  assert.match(result.blockers.join(' '), /发票尚未关联有效付款凭证/);
});

test('a single invoice can be paid by several settled payments and large differences are blocked', () => {
  const selection = { matches: { '发票1.pdf': link('订单1.pdf', '支付1.png', '支付2.png') } };
  const documents = [invoice(1, 10000), order(1, 10000), payment(1, 5000), payment(2, 4500)];
  const ready = assess(documents, { selection });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.totalCny, 9500);
  for (const amount of [3000, 7000]) {
    const mismatch = assess([...documents.slice(0, 3), payment(2, amount)], { selection });
    assert.equal(mismatch.status, 'blocked');
    assert.match(mismatch.blockers.join(' '), /金额差额过大/);
  }
});

test('manually linking split payments uses settled evidence and keeps amount checks', () => {
  const docs = [invoice(1, 12400), payment(1, 5200), payment(2, 7200)];
  const confirmations = { paymentLinks: { [invoiceNo(1)]: ['支付1.png', '支付2.png'] } };
  const result = assess(docs, { confirmations });
  assert.equal(result.status, 'ready');
  assert.equal(result.totalCny, 12400);
  assert.deepEqual(result.rows[0].paymentFiles, ['支付1.png', '支付2.png']);
  assert.equal(result.paymentKeys.filter((key) => key.startsWith('transaction:')).length, 2);

  const reversed = assess([...docs.slice(0, 2), { ...docs[2], text: '已退款' }], { confirmations });
  assert.equal(reversed.status, 'blocked');
  assert.equal(reversed.paymentCandidates.length, 1);
  assert.match(reversed.blockers.join(' '), /金额差额过大/);
});

test('one settled payment can cover several invoices referenced by their order numbers', () => {
  const documents = [
    invoice(1, 10000, { orderNumber: 'order-1' }), invoice(2, 6000, { orderNumber: 'order-2' }),
    payment(1, 16000, { orderNumber: 'order-1', orderNumbers: ['order-1', 'order-2'] }),
  ];
  const result = assess(documents);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.rows.map((row) => row.paidAmountCny), [10000, 6000]);
  assert.equal(result.totalCny, 16000);
  assert.deepEqual(result.paymentKeys.filter((key) => key.startsWith('file:')), ['file:sha-支付1.png']);
});

test('a settled travel agency payment matches both same-order flight invoices by seller and exact total', () => {
  const seller = '上海示例国际旅行社有限公司';
  const text = `销 名称：${seller}\n*运输服务*代订机票`;
  const documents = [
    invoice(1, 51200, { text, orderNumber: '1234567890123456', date: '2099-08-15' }),
    invoice(2, 63800, { text, orderNumber: '1234567890123456', date: '2099-08-15' }),
    payment(1, 115000, { text: `交易成功\n对方户名\n${seller}`, date: '2099-08-05' }),
  ];
  const result = assess(documents, { subject: '差旅' });
  assert.equal(result.status, 'ready', result.blockers.join('\n'));
  assert.deepEqual(result.rows.map((row) => row.paidAmountCny), [51200, 63800]);
  assert.equal(result.paymentKeys.filter((key) => key.startsWith('file:')).length, 1);
  const duplicate = assess(documents, { subject: '差旅', historyInvoiceNumbers: [invoiceNo(1)] });
  assert.equal(duplicate.status, 'blocked');
  const wrongSeller = [...documents.slice(0, 2), { ...documents[2], text: '交易成功\n对方户名\n上海另一家旅行社有限公司' }];
  assert.equal(assess(wrongSeller, { subject: '差旅' }).status, 'blocked');
  assert.equal(assess([...documents, payment(2, 115000, { text: documents[2].text, date: '2099-08-05' })], { subject: '差旅' }).status, 'blocked');
});

test('overlapping payment links must cover all invoice amounts within the group', () => {
  const documents = [invoice(1, 8000), invoice(2, 8000), invoice(3, 8000), payment(1, 12000), payment(2, 12000)];
  const matches = {
    '发票1.pdf': link(null, '支付1.png'),
    '发票2.pdf': link(null, '支付1.png'),
    '发票3.pdf': link(null, '支付1.png', '支付2.png'),
  };
  const impossible = assess(documents, { selection: { matches } });
  assert.equal(impossible.status, 'blocked');
  assert.match(impossible.blockers.join(' '), /无法按当前关联分配/);
  const feasible = assess(documents, { selection: { matches: { ...matches, '发票2.pdf': link(null, '支付1.png', '支付2.png') } } });
  assert.equal(feasible.status, 'ready');
  assert.equal(feasible.totalCny, 24000);
});

test('multiple unassociated payments are not absorbed by the only invoice', () => {
  const result = assess([invoice(1, 10000), order(1, 10000), payment(1, 9000), payment(2, 3000)]);
  assert.equal(result.status, 'blocked');
  assert.equal(result.totalCny, null);
  assert.equal(result.paidTotalCny, null);
});

test('historical and current invoices cannot share an unallocated payment', () => {
  const documents = [invoice(1, 10000), invoice(2, 10000), order(1, 10000), order(2, 9000), payment(1, 19000)];
  const result = assess(documents, { historyInvoiceNumbers: [invoiceNo(1)], selection: { matches: {
    '发票1.pdf': link('订单1.pdf', '支付1.png'), '发票2.pdf': link('订单2.pdf', '支付1.png'),
  } } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.totalCny, null);
  assert.match(result.blockers.join('；'), /历史/);
});

test('a fully associated historical payment is excluded with its historical invoice', () => {
  const documents = [invoice(1, 10000), invoice(2, 10000), order(1, 10000), order(2, 9000), payment(1, 10000), payment(2, 9000)];
  const result = assess(documents, { historyInvoiceNumbers: [invoiceNo(1)], selection: { matches: {
    '发票1.pdf': link('订单1.pdf', '支付1.png'), '发票2.pdf': link('订单2.pdf', '支付2.png'),
  } } });
  assert.equal(result.status, 'ready');
  assert.equal(result.totalCny, 9000);
  assert.ok(!result.uploadNames.includes('支付1.png'));
  assert.ok(!result.uploadNames.includes('订单1.pdf'));
});

for (const text of ['支付金额100.00 交易处理中', '支付金额100.00 待支付', '支付金额100.00', '支付金额100.00 退款成功 交易成功']) {
  test(`payment without settled success is blocked: ${text}`, () => {
    const documents = [invoice(1, 10000), order(1, 10000), payment(1, 10000, { text })];
    const result = assess(documents, { selection: { matches: { '发票1.pdf': link('订单1.pdf', '支付1.png') } } });
    assert.equal(result.status, 'blocked');
    assert.equal(result.totalCny, null);
  });
}

test('dated posted bank transactions are accepted as settled evidence', () => {
  const documents = [invoice(1, 10000), order(1, 10000), payment(1, 10000, { text: '入账日期：2026-11-05\n交易金额100.00' })];
  const result = assess(documents, { selection: { matches: { '发票1.pdf': link('订单1.pdf', '支付1.png') } } });
  assert.equal(result.status, 'ready');
});

test('a posted bank consumption detail proves payment without a success label', () => {
  const documents = [invoice(1, 10000), order(1, 10000), payment(1, 10000, { text: bankReceipt })];
  const selection = { matches: { '发票1.pdf': link('订单1.pdf', '支付1.png') } };
  for (const heading of ['收支详情', '明细详情']) {
    const result = assess([...documents.slice(0, 2), payment(1, 10000, { text: bankReceipt.replace('收支详情', heading) })], { selection });
    assert.equal(result.status, 'ready');
    assert.equal(result.paidTotalCny, 10000);
  }
  for (const text of [bankReceipt + '\n退款完成', bankReceipt.replace('消费', '预授权'), bankReceipt.replace('记账金额\n100.00', '记账金额\n90.00')]) {
    const unsafe = assess([documents[0], documents[1], payment(1, 10000, { text })], { selection });
    assert.equal(unsafe.status, 'blocked');
    assert.equal(unsafe.paidTotalCny, null);
  }
});

test('a matching bank consumption debit proves payment without separate posting fields', () => {
  const receipt = '收支详情\n-1,800.00\n交易时间\n2026-11-11\n业务摘要\n消费\n交易场所\n财付通-示例数据服务商\n交易金额\n1,800.00\n记账币种\n人民币';
  const selection = { matches: { '发票1.pdf': link(null, '支付1.png') } };
  const check = (text) => assess([invoice(1, 180000), payment(1, 180000, { text })], { selection });

  for (const heading of ['收支详情', '明细详情', '收支详情\nつ', '明细详情\n↓\nソ']) {
    const valid = check(receipt.replace('收支详情', heading));
    assert.deepEqual(valid.blockers, []);
    assert.equal(valid.totalCny, 180000);
    assert.deepEqual(valid.rows[0].paymentFiles, ['支付1.png']);
  }

  for (const text of [
    receipt.replace('-1,800.00\n', ''),
    receipt.replace('收支详情\n', '收支详情\n其他金额\n'),
    receipt.replace('-1,800.00', '-1,700.00'),
    receipt.replace('交易金额\n1,800.00', '交易金额\n1,700.00'),
    receipt + '\n交易处理中',
    receipt + '\n已退款',
  ]) {
    const invalid = check(text);
    assert.match(invalid.blockers.join(' '), /缺少对应的有效付款凭证/);
    assert.equal(invalid.totalCny, null);
  }
});

test('JD and bank receipts for the same card, amount and second count once', () => {
  const jd = payment(1, 10000, { text: '京东钱包\n账单详情\n-100.00\n交易成功\n支付方式\n工商银行信用卡(1234)\n创建时间\n2026-07-0810:03:15' });
  const bank = payment(2, 10000, { text: bankReceipt });
  const documents = [invoice(1, 10000), order(1, 10000), jd, bank];
  const selection = { matches: { '发票1.pdf': link('订单1.pdf', '支付1.png') } };
  const result = assess(documents, { selection });
  assert.equal(result.status, 'ready');
  assert.equal(result.paidTotalCny, 10000);
  assert.ok(!result.uploadNames.includes('支付2.png'));
  assert.ok(result.paymentKeys.includes('file:sha-支付2.png'));

  const unrelated = assess([...documents.slice(0, 3), payment(2, 10000, { text: bankReceipt.replace('10:03:15', '10:04:15') })], { selection });
  assert.equal(unrelated.status, 'blocked');
  assert.equal(unrelated.paidTotalCny, 10000);
  assert.match(unrelated.blockers.join(' '), /已识别付款 100\.00 元，请确认对应发票/);
});

test('per-invoice minimum survives an exactly reconciled combined payment', () => {
  const documents = [invoice(1, 8500), invoice(2, 9500), order(1, 9500), order(2, 8500), payment(1, 18000)];
  const result = assess(documents, { selection: { matches: {
    '发票1.pdf': link('订单1.pdf', '支付1.png'), '发票2.pdf': link('订单2.pdf', '支付1.png'),
  } } });
  assert.equal(result.status, 'ready');
  assert.equal(result.totalCny, 17000);
  assert.deepEqual(result.rows.map((row) => row.paidAmountCny), [9500, 8500]);
  const offsetting = assess([invoice(1, 7000), invoice(2, 11000), ...documents.slice(2)], { selection: { matches: {
    '发票1.pdf': link('订单1.pdf', '支付1.png'), '发票2.pdf': link('订单2.pdf', '支付1.png'),
  } } });
  assert.equal(offsetting.status, 'blocked');
  assert.match(offsetting.blockers.join(' '), /金额差额过大/);
});

test('a repeated order needs a manual allocation that matches the combined payment', () => {
  const documents = [invoice(1, 10000), invoice(2, 10000), order(1, 10000), payment(1, 20000)];
  const selection = { matches: {
    '发票1.pdf': link('订单1.pdf', '支付1.png'), '发票2.pdf': link('订单1.pdf', '支付1.png'),
  } };
  const result = assess(documents, { selection });
  assert.equal(result.status, 'blocked');
  assert.equal(result.totalCny, null);
  const paidAmountsCny = { [invoiceNo(1)]: 11000, [invoiceNo(2)]: 9000 };
  const allocated = assess(documents, { selection, confirmations: { paidAmountsCny, paymentCardConfirmed: true } });
  assert.equal(allocated.status, 'ready');
  assert.deepEqual(allocated.rows.map((row) => row.paidAmountCny), [11000, 9000]);
  assert.equal(allocated.totalCny, 19000);
  const inconsistent = assess(documents, { selection, confirmations: { paidAmountsCny: { ...paidAmountsCny, [invoiceNo(2)]: 7000 }, paymentCardConfirmed: true } });
  assert.equal(inconsistent.status, 'blocked');
});

test('only government procurement equipment gets an asset registration reminder', () => {
  const documents = [invoice(1, 120000), order(1, 120000), payment(1, 120000), document('签收单.jpg'), document('固定资产卡片.pdf')];
  const subject = '电脑配件';
  const selection = { matches: { '发票1.pdf': link('订单1.pdf', '支付1.png') } };
  const ordinary = { paymentCardConfirmed: true, receiptFile: '签收单.jpg' };
  const government = { ...ordinary, governmentProcurement: true };
  assert.equal(assess(documents, { subject, selection, confirmations: ordinary }).status, 'ready');
  const missingAsset = assess(documents, { subject, selection, confirmations: government });
  assert.equal(missingAsset.status, 'ready');
  assert.match(missingAsset.warnings.join(' '), /政府采购.*资产入账/);
  const reviewed = assess(documents, { subject, selection, confirmations: { ...government, assetFile: '固定资产卡片.pdf' } });
  assert.ok(!reviewed.warnings.some((warning) => /资产入账/.test(warning)));
});

for (const number of ['12345678', '1234567890123456789']) {
  test(`unsupported invoice identity is blocked: ${number.length} digits`, () => {
    const documents = [invoice(1, 10000, { invoiceNumber: number }), order(1, 10000), payment(1, 10000)];
    const result = assess(documents, { selection: { matches: { '发票1.pdf': link('订单1.pdf', '支付1.png') } } });
    assert.equal(result.status, 'blocked');
    assert.match(result.blockers.join('；'), /20|号码|代码/);
  });
}

function pdfBytes(text) {
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return output;
}

test('folder fingerprints use ordinal filenames, compatible with existing raw caches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-ordinal-'));
  try {
    await mkdir(join(root, 'batch'));
    for (const name of ['z.pdf', 'ä.pdf', '订单.pdf']) await writeFile(join(root, 'batch', name), name);
    const names = await readdir(join(root, 'batch'));
    const expected = createHash('sha256').update(JSON.stringify(await Promise.all(names.map(async (name) => ({ name, sha256: createHash('sha256').update(await readFile(join(root, 'batch', name))).digest('hex') }))))).digest('hex');
    const actual = await fingerprintFolder(root, 'batch');
    assert.equal(actual.fingerprint, expected);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('renaming a folder reuses raw extraction cache and reparses current document fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-cache-rename-'));
  try {
    const sourceRoot = join(root, 'source'); const appDir = join(root, 'app'); const folder = 'batch-已报销';
    await mkdir(join(sourceRoot, folder), { recursive: true });
    for (const name of ['invoice.pdf', 'order.pdf', 'payment.pdf']) await writeFile(join(sourceRoot, folder, name), pdfBytes('Native text avoids any OCR operation'));
    const snapshot = await fingerprintFolder(sourceRoot, folder);
    const rawDirectory = join(appDir, '.runtime/cache', encodeURIComponent('batch'));
    await mkdir(rawDirectory, { recursive: true });
    const texts = {
      'invoice.pdf': `发票号码：${invoiceNo(1)}\n（小写）¥100.00\n订单编号：1234567890123456`,
      'order.pdf': '订单编号：1234567890123456\n实付款：¥90.00',
      'payment.pdf': '订单号：1234567890123456\n交易金额：90.00\n交易成功\n公务卡1234',
    };
    await writeFile(join(rawDirectory, `${snapshot.fingerprint}.json`), JSON.stringify({ fingerprint: snapshot.fingerprint, documents: snapshot.files.map((file) => ({ file: { name: file.name, absolutePath: `/old/${file.name}` }, text: texts[file.name], invoiceAmountCny: 99999 })) }));
    const selectionDirectory = join(appDir, '.runtime/cache', encodeURIComponent(folder));
    await mkdir(selectionDirectory, { recursive: true });
    await writeFile(join(selectionDirectory, `selection-v${SELECTION_VERSION}-书籍资料-${snapshot.fingerprint}.json`), JSON.stringify({ version: SELECTION_VERSION, subject: '书籍资料', upload: ['invoice.pdf', 'order.pdf', 'payment.pdf'], types: { 'invoice.pdf': 'invoice', 'order.pdf': 'detail', 'payment.pdf': 'payment' }, matches: { 'invoice.pdf': link('order.pdf', 'payment.pdf') } }));
    const plan = await createPlan({ appDir, sourceRoot, folder, subject: '书籍资料', funding: '教学', project: { projectNo: 'TEST-2026-01', projectName: '模拟经费' }, allowReimbursed: true, paymentCardLast4: '1234' });
    assert.equal(plan.cacheState, 'cached');
    assert.equal(confirmClaimPurpose(plan, concretePurpose).status, 'ready');
    assert.equal(plan.invoiceTotalCny, 10000);
    assert.equal(plan.totalCny, 9000);
    assert.ok(plan.uploadFiles.every((file) => file.absolutePath.startsWith(join(sourceRoot, folder))));
  } finally { await rm(root, { recursive: true, force: true }); }
});
