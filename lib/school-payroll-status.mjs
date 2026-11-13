const states = new Map([
  ['0', { state: 'excluded', label: '新建' }],
  ['1', { state: 'pending', label: '待部门审核' }],
  ['2', { state: 'pending', label: '待财务审核' }],
  ['3', { state: 'pending', label: '已审核' }],
  ['4', { state: 'booked', label: '已发放' }],
  ['5', { state: 'excluded', label: '部门审核驳回' }],
  ['6', { state: 'excluded', label: '财务处审核驳回' }],
  ['7', { state: 'excluded', label: '作废' }],
  ['8', { state: 'pending', label: '待发放' }],
]);

export function schoolPayrollStatus(value) {
  return states.get(String(value ?? '').trim()) ?? null;
}

export async function readSchoolPayrollStates(frame, receipts, signal) {
  if (!receipts.length) return [];
  const url = new URL(frame.url());
  if (url.protocol !== 'https:' || url.hostname !== 'cwc.suibe.edu.cn' || !url.pathname.startsWith('/SFP_SalarySelf/')) {
    throw new Error('学校薪酬查询页面未确认。');
  }
  const verified = [];
  for (let start = 0; start < receipts.length; start += 4) {
    signal.throwIfAborted();
    const results = await frame.evaluate((items) => Promise.all(items.map(async ({ runId, declareId, financeFormId, projectNo }) => {
      try {
        const response = await fetch('/SFP_SalarySelf/SalaryDeclare/GetSalaryDeclareEn', {
          method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(6500),
          body: new URLSearchParams({ p_DeclareID: declareId }),
        });
        if (!response.ok) return null;
        const data = await response.json();
        const clean = (value) => String(value ?? '').trim().normalize('NFKC');
        if (clean(data?.DeclareID).toLowerCase() !== declareId.toLowerCase() ||
            clean(data.DeclareBillNo) !== financeFormId || clean(data.ProjectCode).toUpperCase() !== projectNo.toUpperCase()) return null;
        return { runId, financeFormId, code: data.State };
      } catch { return null; }
    })), receipts.slice(start, start + 4));
    signal.throwIfAborted();
    for (const result of results) {
      const status = result && schoolPayrollStatus(result.code);
      if (status) verified.push({ ...result, ...status, checkedAt: new Date().toISOString() });
    }
  }
  return verified;
}
