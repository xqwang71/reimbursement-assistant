import test from 'node:test';
import assert from 'node:assert/strict';
import { parseForeignDocument, exchangeToCny } from '../lib/foreign-money.mjs';
import { reconcileForeignClaim } from '../lib/foreign-claim.mjs';

const invoice = (number, amount = 'USD 20.00') => `Invoice\nInvoice number ${number}\nDate of issue April 17, 2099\nAmount due ${amount}`;
const payment = (amount, details = '') => `交易成功\n原交易金额：${amount}\n支付时间\n2099-04-1810:23:07\n${details}`;
const wallet = `账单详情\n-142.64\n自动扣款成功\n订单金额\n142.64元(20.00美元)\n汇率\n1.00美元 = 7.13200000人民币\n支付时间\n2099-04-1810:23:07\n收款方全称\nExample Payment Inc`;

function reconcile(entries, { matches = {}, readQuote = async () => null } = {}) {
  const documents = entries.map(([name, text, rest]) => ({ file: { name, sha256: name }, text, foreign: parseForeignDocument(text, name), ...rest }));
  return reconcileForeignClaim({ documents, files: documents.map(({ file }) => file), selection: { matches }, historyInvoiceNumbers: [] }, readQuote);
}

test('a dual-currency wallet debit uses actual RMB after checking the original invoice amount', async () => {
  const result = await reconcile([
    ['Invoice-A.pdf', invoice('DEMO-FX-A')],
    ['钱包账单.png', wallet],
    ['Receipt-A.pdf', 'Invoice number DEMO-FX-A\nReceipt number 1234-4321\nDate paid April 18, 2099\nAmount paid $20.00'],
    ['银行账单.png', '收支详情\n交易场所\n支付宝-Example Payment Inc\n记账金额 142.64\n记账币种 人民币', { paymentAmountCny: 14264, date: '2099-04-18' }],
  ], { readQuote: async () => assert.fail('a confirmed RMB debit does not need a rate') });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.reimbursementRoute, 'smart');
  assert.equal(result.totalCny, 14264);
  assert.equal(result.rows[0].foreignMoney.minor, 2000);
  assert.equal(result.rows[0].fx[0].paymentFile, '钱包账单.png');
  assert.deepEqual(result.fxNeeded, []);
  assert.equal(result.uploadNames.length, 4);
});

test('same numeric amount in different currencies cannot be reimbursed', async () => {
  const result = await reconcile([
    ['Invoice-A.pdf', invoice('DEMO-FX-A', 'EUR 20.00')],
    ['支付.png', wallet],
  ], { matches: { 'Invoice-A.pdf': { payment: ['支付.png'] } } });
  assert.match(result.blockers.join(' '), /币种不一致/);
  assert.equal(result.totalCny, null);
});

test('an RMB wallet discount uses the actual debit rather than the order equivalent', async () => {
  const discounted = '账单详情\n-85.13\n自动扣款成功\n订单金额\n85.36元(11.07美元)\n汇率\n1.00美元 = 7.71093000 人民币\n工商银行立减\n-0.23>\n支付时间\n2099-06-0809:41:08';
  const files = [
    ['Invoice-A.pdf', 'Invoice number DEMO-FX-A\nDate of issue June 8, 2099\nAmount due USD 11.07'],
    ['支付.png', discounted],
  ];
  const result = await reconcile(files, { readQuote: async () => assert.fail('RMB debit after discount takes priority') });
  assert.equal(result.totalCny, 8513);
  assert.deepEqual(result.fxNeeded, []);
  assert.deepEqual(result.blockers, []);
  files[1][1] = discounted.replace('-0.23>', '金额模糊');
  const unreadable = await reconcile(files, { readQuote: async () => assert.fail('unreadable RMB debit must not trigger a rate lookup') });
  assert.equal(unreadable.totalCny, null);
  assert.equal(unreadable.reimbursementRoute, 'review');
  assert.deepEqual(unreadable.fxNeeded, []);
  assert.match(unreadable.blockers.join(' '), /已显示人民币结算/);
});

test('an explicitly paid RMB amount or linked bank settlement takes priority for other currencies', async () => {
  const entries = [['Invoice-A.pdf', invoice('FX-A', 'EUR 20.00')]];
  const readQuote = async () => assert.fail('confirmed RMB settlement must take priority');
  const oneFile = await reconcile([...entries, ['支付.png', payment('EUR 20.00', '支付金额 人民币 151.18')]], { readQuote });
  assert.equal(oneFile.totalCny, 15118);
  const separate = await reconcile([
    ...entries,
    ['原币付款.png', payment('EUR 20.00', '收款方全称\nExample Payment Inc')],
    ['银行入账.png', '收支详情\n记账时间\n2099-04-18 10:23:08\n交易场所\n支付宝-Example Payment Inc\n记账金额\n151.27\n记账币种\n人民币'],
  ], { readQuote });
  assert.deepEqual(separate.blockers, []);
  assert.equal(separate.reimbursementRoute, 'smart');
  assert.equal(separate.totalCny, 15127);
  assert.equal(separate.rows[0].fx[0].paymentFile, '银行入账.png');
});

test('a different RMB payment remains unmatched instead of causing an exchange-rate lookup', async () => {
  const result = await reconcile([
    ['Invoice-A.pdf', invoice('FX-A')],
    ['支付.png', wallet],
    ['另一笔银行入账.png', '收支详情\n记账时间\n2099-04-18 18:31:00\n交易场所\n支付宝-Example Payment Inc\n记账金额\n142.64\n记账币种\n人民币'],
  ], { readQuote: async () => assert.fail('an unmatched RMB debit does not require an exchange rate') });
  assert.equal(result.rows[0].paidAmountCny, 14264);
  assert.equal(result.totalCny, null);
  assert.deepEqual(result.fxNeeded, []);
  assert.match(result.blockers.join(' '), /人民币付款（142.64 元）缺少可对应的发票/);
});

test('foreign-only payments require the payment-date quote and use the per-100 unit', async () => {
  const files = [['Invoice-A.pdf', invoice('DEMO-FX-A', 'JPY 2500')], ['支付.png', payment('JPY 2500', '实际扣款 ¥2500\n估计折合人民币：120元')]];
  const missing = await reconcile(files);
  assert.deepEqual(missing.fxNeeded, [{ date: '2099-04-18', currency: 'JPY' }]);
  assert.equal(missing.reimbursementRoute, 'legacy');
  assert.equal(missing.totalCny, null);
  const result = await reconcile(files, { readQuote: async (date, currency) => {
    assert.equal(date, '2099-04-18');
    assert.equal(currency, 'JPY');
    return { date, currency, ratePer100: '4.3215' };
  } });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.reimbursementRoute, 'legacy');
  assert.equal(result.totalCny, 10804);
  assert.equal(result.rows[0].fx[0].quoteKey, '2099-04-18-JPY');
  assert.equal(exchangeToCny({ minor: 1001, digits: 2 }, '718.125'), 7188);
});

test('split foreign payments preserve both invoice and payment totals', async () => {
  const result = await reconcile([
    ['Invoice-A.pdf', invoice('FX-A', 'EUR 15.00')],
    ['Invoice-B.pdf', invoice('FX-B', 'EUR 10.00')],
    ['支付1.png', payment('EUR 10.00', '人民币扣款：77.80')],
    ['支付2.png', payment('EUR 15.00')],
  ], { matches: { 'Invoice-A.pdf': { payment: ['支付1.png', '支付2.png'] }, 'Invoice-B.pdf': { payment: ['支付2.png'] } }, readQuote: async () => ({ ratePer100: '781.50' }) });
  assert.deepEqual(result.blockers, []);
  assert.equal(result.reimbursementRoute, 'split');
  assert.deepEqual(result.rows.map((row) => row.reimbursementAmountCny), [11688, 7815]);
  assert.equal(result.totalCny, 19503);
});

test('a mismatched amount or unknown payment date never falls back to invoice day', async () => {
  const badAmount = await reconcile([['Invoice-A.pdf', invoice('FX-A')], ['支付.png', payment('USD 19.99')]], { matches: { 'Invoice-A.pdf': { payment: ['支付.png'] } } });
  assert.match(badAmount.blockers.join(' '), /原币发票与付款金额不一致/);
  const missingDate = await reconcile([['Invoice-A.pdf', invoice('FX-A')], ['支付.png', '支付成功\n交易金额 USD 20.00']], { readQuote: async () => assert.fail('the invoice date cannot substitute for payment day') });
  assert.match(missingDate.blockers.join(' '), /缺少付款日期/);
  assert.equal(missingDate.totalCny, null);
});
