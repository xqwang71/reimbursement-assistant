import { schoolMoneyCny } from './funding-detail.mjs';

const invoiceNumberPattern = /^(?:\d{16}|\d{20})$/;
const positiveCents = (value) => Number.isSafeInteger(value) && value > 0;
const schoolDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });

export function didiInvoiceWindow(filingDate = schoolDay.format()) {
  const [year, month] = filingDate.split('-').map(Number);
  return { firstYear: month <= 3 ? year - 1 : year, lastYear: year };
}

function invoiceDateInWindow(value, { firstYear, lastYear }) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  const year = date.getUTCFullYear();
  return year >= firstYear && year <= lastYear && date.toISOString().slice(0, 10) === value;
}

export function validateDidiInvoiceDates(rows, window = didiInvoiceWindow()) {
  if (rows.every(({ date }) => invoiceDateInWindow(date, window))) return;
  const { firstYear, lastYear } = window;
  const years = firstYear === lastYear ? String(lastYear) : `${firstYear} 至 ${lastYear}`;
  throw new Error(`滴滴发票开票日期未能核实或超出报销年度。本次仅可使用 ${years} 年开具的发票，请核对原单票据。`);
}

export function didiBudgetCny(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = schoolMoneyCny(text);
  return positiveCents(amount) && amount <= 99999999999 ? amount : null;
}

export function selectDidiInvoices(tickets, limitCny, alreadySubmitted = [], window = didiInvoiceWindow()) {
  if (!positiveCents(limitCny)) return [];
  const used = new Set(alreadySubmitted);
  const unique = new Map();
  const conflicting = new Set();
  for (const ticket of tickets) {
    const { invoiceNumber, amountCny } = ticket;
    if (!invoiceNumberPattern.test(invoiceNumber) || !positiveCents(amountCny) || used.has(invoiceNumber)) continue;
    if (unique.has(invoiceNumber)) conflicting.add(invoiceNumber);
    unique.set(invoiceNumber, ticket);
  }
  const available = [...unique.values()].filter((ticket) =>
    !conflicting.has(ticket.invoiceNumber) && ticket.amountCny <= limitCny && invoiceDateInWindow(ticket.date, window));
  available.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.invoiceNumber.localeCompare(b.invoiceNumber));
  if (available.reduce((sum, ticket) => sum + ticket.amountCny, 0) <= limitCny) return available;

  const totals = new Map([[0, null]]);
  let best = 0;
  for (const ticket of available) {
    for (const [total, prior] of [...totals]) {
      const next = total + ticket.amountCny;
      if (next > limitCny || totals.has(next)) continue;
      totals.set(next, { ticket, prior });
      if (next > best) best = next;
      if (best === limitCny) break;
      if (totals.size > 300000) throw new Error('滴滴票据组合较多，请缩小预算后重试');
    }
    if (best === limitCny) break;
  }
  const selection = [];
  for (let entry = totals.get(best); entry; entry = entry.prior) selection.push(entry.ticket);
  return selection.reverse();
}

export function validateDidiSelection(plan, alreadySubmitted = []) {
  const limit = plan.didi?.budgetCny;
  if (!positiveCents(limit) || !Array.isArray(plan.rows) || plan.uploadFiles.length || plan.batches.length || plan.projectAllocationDraft) {
    throw new Error('贸大出行预算或票据计划无效');
  }
  if (!plan.rows.length && plan.totalCny === null) return;
  const numbers = new Set();
  const used = new Set(alreadySubmitted);
  let total = 0;
  for (const row of plan.rows) {
    const { invoiceNumber, invoiceAmountCny } = row;
    if (!invoiceNumberPattern.test(invoiceNumber) || numbers.has(invoiceNumber) || used.has(invoiceNumber) ||
        !positiveCents(invoiceAmountCny) || row.reimbursementAmountCny !== invoiceAmountCny ||
        row.amountBasis !== '学校滴滴票夹') throw new Error('滴滴票据身份或金额不一致，或已登记报销');
    numbers.add(invoiceNumber);
    total += invoiceAmountCny;
  }
  if (!positiveCents(total) || total > limit || total !== plan.totalCny || total !== plan.invoiceTotalCny) {
    throw new Error('滴滴票据金额与本次预算或票据合计不一致');
  }
}
