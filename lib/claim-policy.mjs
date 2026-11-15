import { createHash } from 'node:crypto';
import { matchTravelPayments } from './travel-evidence.mjs';

const cents = (value) => Number.isSafeInteger(value) && value >= 0;
const positiveCents = (value) => cents(value) && value > 0;
const unique = (values) => [...new Set(values)];
const sum = (values) => values.reduce((total, value) => total + value, 0);
const yuan = (value) => (value / 100).toFixed(2);
const orderNumbersOf = (document) => document?.orderNumbers ?? (document?.orderNumber ? [document.orderNumber] : []);

function discrepancy(invoiceCny, paidCny, label) {
  const gap = Math.abs(invoiceCny - paidCny);
  if (gap < 2000 || gap < Math.ceil(invoiceCny / 10)) return '';
  return `发票与付款金额差额过大（${label}）。发票 ${yuan(invoiceCny)} 元，实付 ${yuan(paidCny)} 元，相差 ${yuan(gap)} 元`;
}

export function allocatePayments(rows, amounts, payments, paymentByName) {
  const firstInvoice = payments.length + 1;
  const sink = firstInvoice + rows.length;
  const remainingCapacity = Array.from({ length: sink + 1 }, () => new Map());
  const connect = (from, to, capacity) => {
    remainingCapacity[from].set(to, capacity);
    remainingCapacity[to].set(from, 0);
  };
  const paymentNodes = new Map(payments.map((payment, index) => [payment, index + 1]));
  for (const [payment, node] of paymentNodes) connect(0, node, payment.amount);
  rows.forEach((row, index) => {
    const invoiceNode = firstInvoice + index;
    for (const payment of new Set(row.paymentFiles.map((name) => paymentByName.get(name)))) {
      connect(paymentNodes.get(payment), invoiceNode, payment.amount);
    }
    connect(invoiceNode, sink, amounts[index]);
  });
  // Reverse capacity lets an invoice release part of a shared payment for another invoice.
  let unpaid = sum(amounts);
  while (unpaid > 0) {
    const previous = Array(sink + 1).fill(-1);
    previous[0] = 0;
    const queue = [0];
    for (let index = 0; index < queue.length && previous[sink] === -1; index += 1) {
      const from = queue[index];
      for (const [to, capacity] of remainingCapacity[from]) {
        if (capacity <= 0 || previous[to] !== -1) continue;
        previous[to] = from;
        queue.push(to);
      }
    }
    if (previous[sink] === -1) return null;
    let allocated = unpaid;
    for (let node = sink; node !== 0; node = previous[node]) allocated = Math.min(allocated, remainingCapacity[previous[node]].get(node));
    for (let node = sink; node !== 0; node = previous[node]) {
      const from = previous[node];
      remainingCapacity[from].set(node, remainingCapacity[from].get(node) - allocated);
      remainingCapacity[node].set(from, remainingCapacity[node].get(from) + allocated);
    }
    unpaid -= allocated;
  }
  return rows.map((_, index) => payments.flatMap((payment) => {
    const amount = remainingCapacity[firstInvoice + index].get(paymentNodes.get(payment));
    return amount > 0 ? [{ payment, amount }] : [];
  }));
}

function bankConsumptionProof(document, text) {
  if (!/(?:收支|明细)详情/.test(text) || !/记账币种[:：]?人民币/.test(text) ||
      !/(?:^|\n)[ \t]*业务摘要[ \t]*[:：]?\s*消费[ \t]*(?=\r?\n|$)/.test(document.text || '')) return null;
  const matchesAmount = (value) => value && Math.round(Number(value.replaceAll(',', '')) * 100) === document.paymentAmountCny;
  const postedAmount = text.match(/记账金额[:：]?[¥￥]?([\d,]+\.\d{2})/)?.[1];
  if (postedAmount && !matchesAmount(postedAmount)) return null;
  const postedTime = text.match(/记账时间[:：]?(20\d{2}-\d{2}-\d{2}\d{2}:\d{2}:\d{2})/)?.[1];
  if (postedAmount && postedTime) return { postedTime };

  // OCR can read navigation icons as short symbol or kana lines before the debit.
  const debit = document.text.match(
    /^[ \t]*(?:收支|明细)详情\s*(?:[\p{P}\p{S}\p{Script=Hiragana}\p{Script=Katakana}]{1,2}[ \t]*\r?\n\s*){0,2}[-−–—][ \t]*[¥￥]?[ \t]*([\d,]+\.\d{2})[ \t]*(?:元)?[ \t]*$/mu,
  )?.[1];
  const transactionAmount = text.match(/交易金额[:：]?[¥￥]?([\d,]+\.\d{2})/)?.[1];
  const dated = /交易(?:时间|日期)[:：]?20\d{2}[-年/.]\d{1,2}[-月/.]\d{1,2}/.test(text);
  return dated && matchesAmount(debit) && matchesAmount(transactionAmount) ? { postedTime: null } : null;
}

function jdPaymentProof(text, bankTime, amount) {
  if (bankTime && !/网银在线[-－—].{0,80}京东/.test(text)) return null;
  if (!bankTime && !(text.includes('京东钱包') && text.includes('账单详情'))) return null;
  const time = bankTime || text.match(/创建时间[:：]?(20\d{2}-\d{2}-\d{2}\d{2}:\d{2}:\d{2})/)?.[1];
  const cardTail = text.match(bankTime
    ? /交易卡号[:：]?\d{4,8}\*{2,}(\d{4})(?!\d)/
    : /支付方式[:：]?[\p{Script=Han}]+信用卡[（(](\d{4})[）)]/u)?.[1];
  return time && cardTail ? { key: `${time}/${cardTail}/${amount}`, bank: Boolean(bankTime) } : null;
}

export function reconcileClaim({ documents, files, selection = {}, subject, historyInvoiceNumbers = [], confirmations = {}, paymentCardLast4 = '' }) {
  const blockers = [];
  const warnings = [];
  const materials = [];
  const removed = new Set();
  const byName = new Map(documents.map((document) => [document.file.name, document]));
  const fileByName = new Map(files.map((file) => [file.name, file]));
  const invoices = new Map();
  for (const document of documents.filter((item) => item.invoiceNumber)) {
    if (!/^\d{20}$/.test(document.invoiceNumber)) {
      blockers.push(`发票号码暂不支持自动核对：${document.file.name}。当前仅支持完整20位电子发票号码；其他票据须结合发票代码人工核对`);
      continue;
    }
    const previous = invoices.get(document.invoiceNumber);
    if (previous) {
      if (previous.invoiceAmountCny !== document.invoiceAmountCny) blockers.push(`同一发票号码出现不同金额，需核对：${previous.file.name}、${document.file.name}`);
      removed.add(document.file.name);
      warnings.push(`同一发票的副本只计一次：${document.file.name}`);
    } else invoices.set(document.invoiceNumber, document);
  }
  const linksForInvoice = (invoice) => {
    const links = documents.filter((document) => document.invoiceNumber === invoice.invoiceNumber).map((document) => selection.matches?.[document.file.name] || {});
    const manual = confirmations.paymentLinks?.[invoice.invoiceNumber];
    return {
      detail: unique(links.flatMap((link) => link.detail || [])).filter((name) => fileByName.has(name)),
      payment: unique(manual || links.flatMap((link) => link.payment || [])).filter((name) => fileByName.has(name)),
      ...(manual ? { manual: true } : {}),
    };
  };
  const historical = new Set(historyInvoiceNumbers);
  const excluded = [...invoices.values()].filter((invoice) => historical.has(invoice.invoiceNumber));
  for (const invoice of excluded) {
    invoices.delete(invoice.invoiceNumber);
    removed.add(invoice.file.name);
    warnings.push(`已剔除历史报销发票：${invoice.file.name}`);
  }
  const orders = documents.filter((item) => !item.invoiceNumber && item.orderNumber && cents(item.orderAmountCny));
  const paymentByIdentity = new Map();
  const paymentByName = new Map();
  for (const document of documents.filter((item) => !item.invoiceNumber && cents(item.paymentAmountCny))) {
    const paymentText = (document.text || '').replace(/\s/g, '');
    if (/交易(?:失败|取消|处理中|待处理)|支付(?:失败|取消|处理中)|付款(?:失败|处理中)|记账(?:失败|处理中)|退款(?:成功|中|完成)|已退款|已退回|已撤销|已关闭|已取消|未(?:支付|付款|扣款|入账|记账)|待(?:支付|付款|扣款|入账|记账)|等待(?:支付|付款)|尚未(?:支付|付款)/.test(paymentText)) {
      warnings.push(`付款凭证显示交易未完成、取消或退款，请核对：${document.file.name}`);
      continue;
    }
    const bankProof = bankConsumptionProof(document, paymentText);
    const completed = /交易成功|支付成功|付款成功|交易完成|支付完成|已支付|已付款|已扣款|已入账|入账成功|交易状态[:：]?(?:成功|完成|已完成)|(?:入账|记账)日期[:：]?20\d{2}[-年/]\d{1,2}[-月/]\d{1,2}/.test(paymentText);
    if (document.paymentAmountCny <= 0 || !(completed || bankProof)) {
      warnings.push(`暂未识别到已付款的凭证，请核对支付状态或银行消费明细：${document.file.name}`);
      continue;
    }
    const identity = document.transactionId || document.file.sha256 || document.text?.replace(/\s/g, '') || document.file.name;
    let payment = paymentByIdentity.get(identity);
    if (payment && payment.amount !== document.paymentAmountCny) {
      blockers.push(`同一支付记录出现不同金额：${document.file.name}`);
    } else if (!payment) {
      payment = { identity, amount: document.paymentAmountCny, document, names: [], jdProof: jdPaymentProof(paymentText, bankProof?.postedTime, document.paymentAmountCny) };
      paymentByIdentity.set(identity, payment);
    } else {
      removed.add(document.file.name);
      warnings.push(`重复付款记录只计一次：${document.file.name}`);
    }
    payment.names.push(document.file.name);
    paymentByName.set(document.file.name, payment);
  }
  const jdProofs = [...paymentByIdentity.values()].filter((payment) => payment.jdProof);
  for (const pair of Map.groupBy(jdProofs, (payment) => payment.jdProof.key).values()) {
    if (pair.length !== 2) continue;
    const bank = pair.find((payment) => payment.jdProof.bank);
    const wallet = pair.find((payment) => !payment.jdProof.bank);
    if (!bank || !wallet) continue;
    paymentByIdentity.delete(bank.identity);
    for (const name of bank.names) {
      removed.add(name);
      wallet.names.push(name);
      paymentByName.set(name, wallet);
    }
    warnings.push(`银行明细与京东账单对应同一笔付款，只计一次：${bank.document.file.name}`);
  }
  let payments = [...paymentByIdentity.values()];
  const matchesOrder = (payment, orderNumbers) => payment.names.some((name) => orderNumbersOf(byName.get(name)).some((number) => orderNumbers.has(number)));
  const travelLinks = subject === '差旅'
    ? matchTravelPayments([...invoices.values(), ...excluded], payments, linksForInvoice, matchesOrder)
    : new Map();
  const historicalPayments = new Set();
  const historicalDetails = new Set();
  for (const invoice of excluded) {
    const link = linksForInvoice(invoice);
    const orderNumbers = new Set([...orderNumbersOf(invoice), ...link.detail.flatMap((name) => orderNumbersOf(byName.get(name)))]);
    for (const name of link.detail) historicalDetails.add(name);
    for (const order of orders) if (orderNumbers.has(order.orderNumber)) historicalDetails.add(order.file.name);
    for (const name of link.payment) if (paymentByName.has(name)) historicalPayments.add(paymentByName.get(name));
    for (const payment of payments) if (matchesOrder(payment, orderNumbers)) historicalPayments.add(payment);
    const travelPayment = travelLinks.get(invoice.invoiceNumber);
    if (travelPayment) historicalPayments.add(travelPayment);
  }
  const rows = [...invoices.values()].map((invoice) => {
    const link = linksForInvoice(invoice);
    const directOrder = orders.find((order) => orderNumbersOf(invoice).includes(order.orderNumber));
    const linkedOrder = (link.detail || []).map((name) => byName.get(name)).find((item) => item && cents(item.orderAmountCny));
    const order = directOrder || linkedOrder;
    const orderNumbers = new Set([...orderNumbersOf(invoice), ...orderNumbersOf(order), ...link.detail.flatMap((name) => orderNumbersOf(byName.get(name)))]);
    const paymentNames = unique([
      ...(link.payment || []),
      ...(!link.manual ? (travelLinks.get(invoice.invoiceNumber)?.names || []) : []),
      ...(!link.manual ? payments.filter((payment) => matchesOrder(payment, orderNumbers)).map((payment) => payment.document.file.name) : []),
    ]).filter((name) => paymentByName.has(name)).map((name) => paymentByName.get(name).document.file.name);
    if (!cents(invoice.invoiceAmountCny)) blockers.push(`发票金额未能确认：${invoice.file.name}`);
    return {
      invoiceNumber: invoice.invoiceNumber, orderNumber: invoice.orderNumber || order?.orderNumber || null,
      invoiceAmountCny: invoice.invoiceAmountCny, paidAmountCny: null, reimbursementAmountCny: null,
      invoiceFile: invoice.file.name, orderFile: order?.file.name || (link.detail || []).find((name) => fileByName.has(name)) || null,
      paymentFiles: unique(paymentNames), date: order?.date || invoice.date, amountBasis: '',
    };
  });
  if (!rows.length) blockers.push('未识别到未报销的有效发票');

  const currentPayments = new Set(rows.flatMap((row) => row.paymentFiles.map((name) => paymentByName.get(name))));
  payments = payments.filter((payment) => {
    if (!historicalPayments.has(payment) || currentPayments.has(payment)) return true;
    for (const name of payment.names) removed.add(name);
    return false;
  });
  const paymentCandidates = payments.map(({ document, amount }) => ({ name: document.file.name, amountCny: amount, date: document.date }));
  const currentDetails = new Set([...invoices.values()].flatMap((invoice) => linksForInvoice(invoice).detail));
  for (const row of rows) if (row.orderFile) currentDetails.add(row.orderFile);
  for (const name of historicalDetails) if (!currentDetails.has(name)) removed.add(name);
  for (const payment of payments) {
    if (!currentPayments.has(payment)) {
      const action = rows.length ? `已识别付款 ${yuan(payment.amount)} 元，请确认对应发票` : '付款缺少对应发票，请核对归属';
      blockers.push(`${action}：${payment.document.file.name}`);
    }
  }
  const remaining = new Set(rows);
  const consumed = new Set();
  while (remaining.size) {
    const component = new Set([remaining.values().next().value]);
    const linkedPayments = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of component) for (const name of row.paymentFiles) linkedPayments.add(paymentByName.get(name));
      for (const row of remaining) {
        if (!component.has(row) && row.paymentFiles.some((name) => linkedPayments.has(paymentByName.get(name)))) { component.add(row); changed = true; }
      }
    }
    const group = [...component];
    for (const row of group) remaining.delete(row);
    linkedPayments.delete(undefined);
    if ([...linkedPayments].some((payment) => historicalPayments.has(payment))) {
      blockers.push('合并付款同时涉及历史已报销发票，当前发票的实付份额尚未单独确认，不能重复使用整笔付款');
      continue;
    }
    if (!linkedPayments.size) {
      const action = payments.length ? '发票尚未关联有效付款凭证' : '发票缺少对应的有效付款凭证';
      blockers.push(`${action}：${group[0].invoiceFile}`);
      continue;
    }
    const groupPayments = [...linkedPayments];
    const paid = sum(groupPayments.map((payment) => payment.amount));
    const invoiceAmounts = group.map((row) => row.invoiceAmountCny);
    const invoiceFiles = group.map((row) => row.invoiceFile).join('、');
    const groupDifference = invoiceAmounts.every(cents) ? discrepancy(sum(invoiceAmounts), paid, invoiceFiles) : '';
    if (groupDifference) blockers.push(groupDifference);
    let amounts;
    let amountBasis;
    if (group.length === 1) {
      amounts = [paid];
      amountBasis = '付款凭证';
    } else {
      const orderFiles = group.map((row) => row.orderFile);
      const orderNumbers = group.map((row) => byName.get(row.orderFile)?.orderNumber);
      const orderAmounts = group.map((row) => byName.get(row.orderFile)?.orderAmountCny);
      const enteredAmounts = group.map((row) => confirmations.paidAmountsCny?.[row.invoiceNumber]);
      if (orderFiles.every(Boolean) && unique(orderFiles).length === group.length && orderNumbers.every(Boolean) &&
          unique(orderNumbers).length === group.length && orderAmounts.every(cents) && sum(orderAmounts) === paid) {
        amounts = orderAmounts;
        amountBasis = '各订单实付之和与合并付款一致';
      } else if (enteredAmounts.every(positiveCents) && sum(enteredAmounts) === paid) {
        amounts = enteredAmounts;
        amountBasis = '手填实付金额';
        warnings.push('合并付款按你逐张填写的实付金额分配，合计与付款凭证一致');
      } else if (orderAmounts.every((amount) => !cents(amount)) && invoiceAmounts.every(positiveCents) && sum(invoiceAmounts) === paid) {
        amounts = invoiceAmounts;
        amountBasis = '合并实付与发票合计一致';
        warnings.push('合并付款实付等于发票合计，按各张发票金额填报');
      } else {
        if (!groupDifference) {
          for (const row of group) row.needsAllocation = true;
          blockers.push(`合并付款需在详情逐张填写实付金额，合计须等于 ${yuan(paid)} 元`);
        }
        continue;
      }
    }
    if (group.length > 1 && groupPayments.length > 1 && !allocatePayments(group, amounts, groupPayments, paymentByName)) {
      if (amountBasis === '手填实付金额') {
        for (const row of group) row.needsAllocation = true;
      }
      blockers.push(`发票与付款无法按当前关联分配，请核对各笔付款的对应发票：${invoiceFiles}`);
      continue;
    }
    for (const payment of linkedPayments) consumed.add(payment);
    group.forEach((row, index) => {
      row.paidAmountCny = amounts[index];
      row.amountBasis = amountBasis;
      if (cents(row.invoiceAmountCny)) {
        row.reimbursementAmountCny = Math.min(row.invoiceAmountCny, row.paidAmountCny);
        if (group.length > 1 && !groupDifference) {
          const rowDifference = discrepancy(row.invoiceAmountCny, row.paidAmountCny, row.invoiceFile);
          if (rowDifference) blockers.push(rowDifference);
        }
      }
    });
  }

  const names = files.map((file) => file.name).filter((name) => !removed.has(name) && !/待签字/.test(name));
  const kind = (name) => selection.types?.[name] || byName.get(name)?.kind || (
    byName.get(name)?.invoiceNumber ? 'invoice' :
    cents(byName.get(name)?.paymentAmountCny) ? 'payment' :
    /签收|验收/.test(name) ? 'receipt' : /资产卡/.test(name) ? 'asset' :
    /订单|明细|清单|官网|订阅|套餐/.test(name) ? 'detail' : null
  );
  const details = names.filter((name) => kind(name) === 'detail');
  const validVisualFile = (name) => names.includes(name) && /\.(pdf|png|jpe?g|webp)$/i.test(name);
  const required = new Set(rows.map((row) => row.invoiceFile));
  for (const row of rows) {
    if (row.orderFile) required.add(row.orderFile);
    for (const name of row.paymentFiles) required.add(paymentByName.get(name)?.document.file.name || name);
  }
  const checkMaterial = (requirement, evidence, message) => {
    materials.push({ requirement, state: evidence.length ? 'verified' : 'missing', evidence });
    if (!evidence.length) warnings.push(message);
    for (const name of evidence) required.add(name);
  };
  if (subject !== '差旅') checkMaterial('订单或服务明细', details, '缺少可核对商品或服务内容的订单/明细');
  if (subject === 'AI服务') {
    const website = details.filter((name) => /网站|官网|订单详情|订阅|套餐|https?:|www\./i.test(`${name}\n${byName.get(name)?.text || ''}`));
    const seal = validVisualFile(confirmations.sealedDetailFile) ? [confirmations.sealedDetailFile] : [];
    checkMaterial('网站清单或公司盖章的服务清单', website.length ? website : seal, '请核对网站清单或公司盖章的服务清单');
  }
  if (subject === '电脑配件' && confirmations.governmentProcurement === true) {
    checkMaterial('政府采购设备的资产入账凭证', validVisualFile(confirmations.assetFile) ? [confirmations.assetFile] : [], '政府采购设备需在详情中确认资产入账凭证');
  } else if (subject === '办公用品' || subject === '电脑配件') {
    checkMaterial('签字后的签收单', validVisualFile(confirmations.receiptFile) ? [confirmations.receiptFile] : [], '缺少已核对签字的签收单');
  }
  if (payments.length && subject !== '境外软件订阅' && !confirmations.paymentCardConfirmed) {
    if (!paymentCardLast4 || payments.some((payment) => !(payment.document.text || '').includes(paymentCardLast4))) warnings.push('付款记录尚不能确认属于公务卡，请核对公务卡尾号或在详情中确认');
  }
  if (subject === '其他') warnings.push('报销科目暂为“其他”，请核对具体费用类型和材料');
  for (const name of names.filter((name) => kind(name) === 'receipt' || kind(name) === 'asset')) required.add(name);
  for (const name of selection.upload || []) if (names.includes(name)) required.add(name);
  for (const name of [...required]) if (!names.includes(name)) required.delete(name);
  const known = rows.length > 0 && rows.every((row) => cents(row.paidAmountCny) && cents(row.reimbursementAmountCny));
  const totalCny = known ? sum(rows.map((row) => row.reimbursementAmountCny)) : null;
  if (totalCny === 0) blockers.push('本批没有可填报的正数金额');
  const uniqueBlockers = unique(blockers);
  const proofNames = new Set([...consumed].flatMap((payment) => payment.names));
  for (const name of required) if (kind(name) === 'payment' && !byName.get(name)?.invoiceNumber) proofNames.add(name);
  const paymentKeys = [];
  for (const name of proofNames) {
    const file = fileByName.get(name);
    const document = byName.get(name);
    if (file?.sha256) paymentKeys.push(`file:${file.sha256}`);
    if (document?.transactionId) {
      const key = createHash('sha256').update(document.transactionId.toUpperCase()).digest('hex');
      paymentKeys.push(`transaction:${key}`);
    }
  }
  return {
    status: uniqueBlockers.length ? 'blocked' : 'ready', blockers: uniqueBlockers, materials, warnings,
    rows, paymentCandidates, invoiceTotalCny: sum(rows.map((row) => cents(row.invoiceAmountCny) ? row.invoiceAmountCny : 0)),
    paidTotalCny: known ? sum(rows.map((row) => row.paidAmountCny)) : null,
    totalCny,
    uploadNames: [...required], removedNames: [...removed], paymentKeys: unique(paymentKeys),
  };
}
