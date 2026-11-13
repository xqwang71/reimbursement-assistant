import { createHash } from 'node:crypto';
import { allocatePayments, reconcileClaim } from './claim-policy.mjs';
import { bankCurrencyName, displayForeignMoney, exchangeToCny, isDollarCurrency, parseRmbSettlement } from './foreign-money.mjs';

const sum = (values) => values.reduce((total, value) => total + value, 0);
const daysBetween = (left, right) => left && right ? Math.abs(Date.parse(left) - Date.parse(right)) / 86400000 : Infinity;
const sameMoney = (left, right) => left?.currency === right?.currency && left?.minor === right?.minor;
const validNative = (money) => money && money.currency !== '$' && money.currency !== 'CNY';
const payDate = (document) => document.foreign.date;
const merchant = ({ text }) => text.match(/(?:交易场所|收款方全称|商户名称)\s*[:：]?\s*([^\r\n]+)/)?.[1]?.trim().replace(/^(?:支付宝|微信支付|网银在线)[-－—]/, '').toLowerCase();

function paymentTime({ text }) {
  const time = text.match(/(?:交易时间|支付时间|付款时间|记账时间|入账时间)\s*[:：]?\s*(20\d\d)[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*(\d{2}):(\d{2}):(\d{2})/);
  return time ? Date.UTC(Number(time[1]), Number(time[2]) - 1, Number(time[3]), Number(time[4]), Number(time[5]), Number(time[6])) : null;
}

function sameTransaction(left, right) {
  if (left.transactionId && right.transactionId && left.transactionId.toUpperCase() === right.transactionId.toUpperCase()) return true;
  const payee = merchant(left);
  const leftTime = paymentTime(left);
  const rightTime = paymentTime(right);
  return Boolean(payee && payee === merchant(right) && leftTime !== null && rightTime !== null && Math.abs(leftTime - rightTime) <= 2000);
}

function addRmbEvidence(payment, evidence, file) {
  payment.rmbDebitExpected ||= evidence.rmbDebitExpected || Boolean(evidence.debitCny);
  payment.rmbConflict ||= evidence.debitConflict || Boolean(payment.debitCny && evidence.debitCny && payment.debitCny !== evidence.debitCny);
  if (!payment.debitCny && evidence.debitCny) {
    payment.debitCny = evidence.debitCny;
    payment.settlementFile = file;
  }
}

function matchingRows(document, rows, selection) {
  const { foreign, file, orderNumbers = [] } = document;
  if (foreign.invoiceNumber) return rows.filter((row) => row.invoiceNumber === foreign.invoiceNumber);
  const identified = rows.filter((row) => row.document.orderNumbers?.some((order) => orderNumbers.includes(order)));
  if (identified.length) return identified;
  const suggested = rows.filter((row) => selection.matches?.[row.invoiceFile]?.payment?.includes(file.name));
  if (suggested.length) return suggested;
  const same = rows.filter((row) => sameMoney(row.foreignMoney, foreign.money));
  const dated = same.filter((row) => daysBetween(row.date, foreign.date) <= 1);
  if (dated.length === 1) return dated;
  return same.length === 1 && (!same[0].date || !foreign.date) ? same : [];
}

function groupPayments(rows, payments) {
  const groups = [];
  const remaining = new Set(rows);
  while (remaining.size) {
    const group = new Set([remaining.values().next().value]);
    let linked;
    for (;;) {
      linked = payments.filter((payment) => payment.rows.some((row) => group.has(row)));
      const count = group.size;
      for (const payment of linked) for (const row of payment.rows) group.add(row);
      if (group.size === count) break;
    }
    for (const row of group) remaining.delete(row);
    groups.push({ rows: [...group], payments: linked });
  }
  return groups;
}

export async function reconcileForeignClaim(input, readQuote) {
  const { documents, files, selection, historyInvoiceNumbers = [] } = input;
  const foreignDocs = documents.filter((document) => document.foreign && !/待签字/.test(document.file.name));
  const foreignNames = new Set(foreignDocs.map((document) => document.file.name));
  const domesticDocs = documents.filter((document) => !foreignNames.has(document.file.name));
  const domesticInvoices = domesticDocs.filter((document) => document.invoiceNumber);
  const byName = new Map(documents.map((document) => [document.file.name, document]));
  const blockers = [];
  const upload = new Set();
  const byNumber = new Map();
  for (const document of foreignDocs.filter((item) => item.foreign.kind === 'invoice')) {
    const { number, money, date } = document.foreign;
    const { name } = document.file;
    if (number && historyInvoiceNumbers.includes(number)) continue;
    if (!number || !validNative(money)) blockers.push(`外币发票号码、币种或原币金额未能确认：${name}`);
    if (number && byNumber.has(number)) {
      if (!sameMoney(byNumber.get(number).foreignMoney, money) || byNumber.get(number).date !== date) blockers.push(`同一外币发票号码的内容不一致：${name}`);
      continue;
    }
    byNumber.set(number || name, { document, invoiceNumber: number, foreignMoney: money, date, invoiceFile: name,
      invoiceAmountCny: null, paidAmountCny: null, reimbursementAmountCny: null, paymentFiles: [], amountBasis: '' });
    upload.add(name);
  }
  const rows = [...byNumber.values()];
  const identity = new Map();
  for (const document of foreignDocs.filter((item) => item.foreign.kind === 'payment')) {
    const { foreign, file } = document;
    const linked = matchingRows(document, rows, selection);
    if (foreign.invoiceNumber && historyInvoiceNumbers.includes(foreign.invoiceNumber)) continue;
    if (!foreign.completed) { blockers.push(`外币支付未确认成功或已经退款：${file.name}`); continue; }
    const currencies = new Set(linked.map((row) => row.foreignMoney?.currency));
    let money = foreign.money;
    const [linkedCurrency] = currencies;
    if (money?.currency === '$' && currencies.size === 1 && isDollarCurrency(linkedCurrency) && foreign.invoiceNumber) money = { ...money, currency: linkedCurrency };
    if (!validNative(money)) { blockers.push(`付款凭证的原币金额未能确认：${file.name}`); continue; }
    if (!linked.length) { blockers.push(`外币付款缺少对应发票：${file.name}`); continue; }
    if (linked.some((row) => row.foreignMoney?.currency !== money.currency)) { blockers.push(`外币发票与付款币种不一致：${file.name}`); continue; }
    const key = document.transactionId || file.sha256 || file.name;
    const previous = identity.get(key);
    if (previous) {
      if (!sameMoney(previous.money, money)) blockers.push(`同一笔付款的原币金额记录不一致：${file.name}`);
      addRmbEvidence(previous, foreign, file.name);
      if (!file.sha256 || file.sha256 !== previous.document.file.sha256) previous.names.push(file.name);
      continue;
    }
    const payment = { document, money, amount: money.minor, rows: linked, names: [file.name] };
    addRmbEvidence(payment, foreign, file.name);
    identity.set(key, payment);
  }
  let payments = [...identity.values()];
  const receipts = payments.filter(({ document }) => document.foreign.namedReceipt);
  const bank = payments.filter(({ document }) => !document.foreign.namedReceipt);
  const isSamePayment = (receipt, paid) => sameMoney(receipt.money, paid.money) && daysBetween(payDate(receipt.document), payDate(paid.document)) <= 1 &&
    receipt.rows.length === 1 && paid.rows.length === 1 && receipt.rows[0] === paid.rows[0];
  const duplicates = new Set();
  for (const receipt of receipts) {
    const possible = bank.filter((paid) => isSamePayment(receipt, paid));
    if (possible.length !== 1 || receipts.filter((other) => isSamePayment(other, possible[0])).length !== 1) continue;
    addRmbEvidence(possible[0], { ...receipt, debitConflict: receipt.rmbConflict }, receipt.settlementFile);
    possible[0].names.push(...receipt.names);
    duplicates.add(receipt);
  }
  payments = payments.filter((payment) => !duplicates.has(payment));

  for (const document of domesticDocs.filter((item) => !item.invoiceNumber && !/待签字/.test(item.file.name))) {
    const settlement = parseRmbSettlement(document.text);
    const amount = settlement?.debitCny || document.paymentAmountCny;
    if (!settlement && !(amount > 0)) continue;
    if (domesticInvoices.some((invoice) => selection.matches?.[invoice.file.name]?.payment?.includes(document.file.name))) continue;
    const referenced = settlement ? payments.filter((payment) => payment.names.some((name) => sameTransaction(document, byName.get(name)))) : [];
    const payee = merchant(document);
    const sameDebit = referenced.length ? [] : payments.filter((payment) => payment.debitCny === amount && payDate(payment.document) === document.date &&
      payee && merchant(payment.document) === payee && (paymentTime(document) === null || paymentTime(payment.document) === null));
    const linked = referenced.length ? referenced : sameDebit;
    if (linked.length === 1 && (settlement || /收支详情|银行|记账金额/.test(document.text))) {
      if (settlement) addRmbEvidence(linked[0], settlement, document.file.name);
      linked[0].names.push(document.file.name);
      foreignNames.add(document.file.name);
      continue;
    }
    if (referenced.length > 1) {
      for (const payment of referenced) payment.rmbDebitExpected = true;
      blockers.push(`人民币实扣对应多笔付款，请核对：${document.file.name}`);
    } else if (!domesticInvoices.length) {
      const value = amount > 0 ? `（${(amount / 100).toFixed(2)} 元）` : '';
      blockers.push(`人民币付款${value}缺少可对应的发票或原币交易记录：${document.file.name}`);
    }
  }

  const fxQuotes = new Map();
  const fxNeeded = new Map();
  const paymentKeys = [];
  for (const payment of payments) {
    for (const name of payment.names) upload.add(name);
    for (const document of payment.names.map((name) => byName.get(name))) {
      if (document.file.sha256) paymentKeys.push(`file:${document.file.sha256}`);
      if (document.transactionId) paymentKeys.push(`transaction:${createHash('sha256').update(document.transactionId.toUpperCase()).digest('hex')}`);
    }
  }
  const paymentByName = new Map(payments.flatMap((payment) => payment.names.map((name) => [name, payment])));
  for (const row of rows) row.paymentFiles = payments.filter((payment) => payment.rows.includes(row)).map((payment) => payment.document.file.name);
  for (const group of groupPayments(rows, payments)) {
    const labels = group.rows.map((row) => row.invoiceFile).join('、');
    if (!group.payments.length) { blockers.push(`外币发票缺少对应的有效付款凭证：${labels}`); continue; }
    const nativeAmounts = group.rows.map((row) => row.foreignMoney?.minor);
    if (!nativeAmounts.every(Number.isSafeInteger) || sum(nativeAmounts) !== sum(group.payments.map((payment) => payment.amount))) {
      const currency = group.payments[0].money;
      const invoice = displayForeignMoney({ ...currency, minor: sum(nativeAmounts.filter(Number.isSafeInteger)) });
      const paid = displayForeignMoney({ ...currency, minor: sum(group.payments.map((payment) => payment.amount)) });
      blockers.push(`原币发票与付款金额不一致：${labels}。发票 ${invoice}，付款 ${paid}`);
      continue;
    }
    const shares = allocatePayments(group.rows, nativeAmounts, group.payments, paymentByName);
    if (!shares) { blockers.push(`外币发票与付款无法按当前关联分配：${labels}`); continue; }
    for (const payment of group.payments) {
      if (payment.rmbConflict) { blockers.push(`同一笔付款的人民币实扣记录不一致：${payment.document.file.name}`); continue; }
      if (payment.debitCny) { payment.cny = payment.debitCny; continue; }
      if (payment.rmbDebitExpected) { blockers.push(`付款已显示人民币结算，请核对实际扣款金额：${payment.document.file.name}`); continue; }
      const date = payDate(payment.document);
      const { currency } = payment.money;
      if (!date || !bankCurrencyName(currency)) { blockers.push(`缺少付款日期或中国银行未提供该币种牌价：${payment.document.file.name}`); continue; }
      const key = `${date}-${currency}`;
      const quote = fxQuotes.get(key) || await readQuote(date, currency);
      if (!quote) {
        fxNeeded.set(key, { date, currency });
        blockers.push(`缺少 ${date} ${currency} 的中国银行折算价截图`);
        continue;
      }
      fxQuotes.set(key, quote);
      payment.quoteKey = key;
      payment.cny = exchangeToCny(payment.money, quote.ratePer100);
      if (!payment.cny) blockers.push(`中行折算金额无效，请核对：${payment.document.file.name}`);
    }
    if (!group.payments.every((payment) => Number.isSafeInteger(payment.cny))) continue;
    const allocated = new Map();
    group.rows.forEach((row, index) => {
      row.fx = shares[index].map(({ payment, amount }) => {
        const previous = allocated.get(payment) || 0;
        const next = previous + amount;
        allocated.set(payment, next);
        const prorate = (part) => Number((2n * BigInt(part) * BigInt(payment.cny) + BigInt(payment.amount)) / (2n * BigInt(payment.amount)));
        return { paymentFile: payment.settlementFile || payment.document.file.name, native: { ...payment.money, minor: amount }, date: payDate(payment.document), quoteKey: payment.quoteKey, cny: prorate(next) - prorate(previous) };
      });
      row.invoiceAmountCny = row.paidAmountCny = row.reimbursementAmountCny = sum(row.fx.map((part) => part.cny));
      row.amountBasis = row.fx.some((part) => part.quoteKey) ? '按付款日中行折算价' : '人民币实际扣款';
    });
  }

  const eligibleFiles = new Set(files.filter((file) => !/待签字/.test(file.name)).map((file) => file.name));
  const domestic = domesticInvoices.length ? reconcileClaim({ ...input, documents: domesticDocs.filter((item) => !foreignNames.has(item.file.name)), files: files.filter((file) => !foreignNames.has(file.name)) }) : null;
  const settlements = new Set(payments.map(({ debitCny, rmbConflict, rmbDebitExpected }) => {
    if (rmbConflict || (!debitCny && rmbDebitExpected)) return 'unconfirmed';
    return debitCny ? 'cny' : 'foreign';
  }));
  if (domestic?.rows.length) settlements.add('cny');
  let reimbursementRoute = 'review';
  if (settlements.has('foreign') && settlements.has('cny')) reimbursementRoute = 'split';
  else if (!settlements.has('unconfirmed')) {
    if (settlements.has('foreign')) reimbursementRoute = 'legacy';
    else if (settlements.has('cny')) reimbursementRoute = 'smart';
  }
  for (const name of selection.upload || []) if (eligibleFiles.has(name) && (!foreignNames.has(name) || upload.has(name))) upload.add(name);
  const allRows = [...(domestic?.rows || []), ...rows].map(({ document, ...row }) => row);
  if (!rows.length && !domestic?.rows.length) blockers.push('未识别到可核对的外币发票');
  const known = allRows.length && !blockers.length && !domestic?.blockers.length && allRows.every((row) => Number.isSafeInteger(row.reimbursementAmountCny));
  return {
    reimbursementRoute, rows: allRows, blockers: [...(domestic?.blockers || []), ...new Set(blockers)], warnings: domestic?.warnings || [],
    invoiceTotalCny: allRows.length && allRows.every((row) => Number.isSafeInteger(row.invoiceAmountCny)) ? sum(allRows.map((row) => row.invoiceAmountCny)) : null,
    paidTotalCny: known ? sum(allRows.map((row) => row.paidAmountCny)) : null,
    totalCny: known ? sum(allRows.map((row) => row.reimbursementAmountCny)) : null,
    uploadNames: [...new Set([...(domestic?.uploadNames || []), ...upload])], materials: domestic?.materials || [],
    paymentKeys: [...new Set([...(domestic?.paymentKeys || []), ...paymentKeys])], fxQuotes: [...fxQuotes.values()], fxNeeded: [...fxNeeded.values()],
  };
}
