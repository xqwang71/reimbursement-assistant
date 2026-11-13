import test from 'node:test';
import assert from 'node:assert/strict';
import { didiBudgetCny, selectDidiInvoices, validateDidiSelection } from '../lib/didi-invoices.mjs';

const invoice = (number, amountCny) => ({ invoiceNumber: String(1000000000000000 + number), amountCny, date: '2026-11-04' });

test('Didi amounts use decimal cents and reject invalid caps', () => {
  assert.equal(didiBudgetCny('125.09'), 12509);
  assert.equal(didiBudgetCny('0'), null);
  assert.equal(didiBudgetCny('12.999'), null);
  assert.equal(didiBudgetCny('1e5'), null);
});

test('Didi finds the closest full-ticket combination below the cap and excludes already submitted or ambiguous tickets', () => {
  const tickets = [invoice(1, 7000), invoice(2, 5900), invoice(3, 4000), invoice(4, 10000), invoice(5, 9999), invoice(5, 10000), invoice(6, 10001)];
  const picked = selectDidiInvoices(tickets, 10000, [tickets[3].invoiceNumber]);
  assert.deepEqual(picked, tickets.slice(1, 3));
  assert.deepEqual(selectDidiInvoices(tickets, 1), []);
});

test('a recorded Didi selection cannot be executed over budget or with a previously submitted ticket', () => {
  const ticket = invoice(1, 1250);
  const plan = {
    didi: { budgetCny: 1250 },
    rows: [{ invoiceNumber: ticket.invoiceNumber, invoiceAmountCny: 1250, reimbursementAmountCny: 1250, amountBasis: '学校滴滴票夹' }],
    totalCny: 1250, invoiceTotalCny: 1250, uploadFiles: [], batches: [],
  };
  assert.doesNotThrow(() => validateDidiSelection(plan));
  assert.throws(() => validateDidiSelection(plan, [ticket.invoiceNumber]), /已登记报销/);
  assert.throws(() => validateDidiSelection({ ...plan, didi: { budgetCny: 1249 } }), /预算/);
});
