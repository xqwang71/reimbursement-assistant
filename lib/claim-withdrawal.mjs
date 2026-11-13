const ARCHIVE_SUFFIX = '-已报销';

export function reimbursementSourceFolders(plan) {
  if (plan.sourceFolders) return plan.sourceFolders;
  return [plan.folder.endsWith(ARCHIVE_SUFFIX) ? plan.folder.slice(0, -ARCHIVE_SUFFIX.length) : plan.folder];
}

export function claimWithdrawalFor(history, runId) {
  return history.withdrawals?.find((record) => record.runId === runId);
}

function claimReferences(plan) {
  return {
    invoiceNumbers: [...new Set(plan.rows.map((row) => row.invoiceNumber).filter(Boolean))],
    paymentKeys: [...new Set(plan.paymentKeys || [])],
  };
}

export function markClaimWithdrawn(history, run, otherRecordedRuns) {
  if (claimWithdrawalFor(history, run.id)) return history;
  const { invoiceNumbers, paymentKeys } = claimReferences(run.plan);
  const otherInvoices = new Set();
  const otherPayments = new Set();
  for (const other of otherRecordedRuns) {
    if (other.id === run.id || claimWithdrawalFor(history, other.id)) continue;
    const references = claimReferences(other.plan);
    for (const invoice of references.invoiceNumbers) otherInvoices.add(invoice);
    for (const payment of references.paymentKeys) otherPayments.add(payment);
  }
  const original = run.control?.progress?.submission;
  const withdrawal = {
    runId: run.id,
    sourceRoot: run.sourceRoot,
    folder: run.plan.groupId ? run.plan.folder : reimbursementSourceFolders(run.plan)[0],
    invoiceNumbers,
    paymentKeys,
    financeFormId: original?.financeFormId || original?.documentId,
    submittedAt: original?.verifiedAt || run.updatedAt,
    withdrawnAt: new Date().toISOString(),
  };
  return {
    ...history,
    submittedInvoiceNumbers: history.submittedInvoiceNumbers.filter((invoice) => !invoiceNumbers.includes(invoice) || otherInvoices.has(invoice)),
    submittedPaymentKeys: history.submittedPaymentKeys.filter((payment) => !paymentKeys.includes(payment) || otherPayments.has(payment)),
    withdrawals: [...(history.withdrawals || []), withdrawal],
  };
}
