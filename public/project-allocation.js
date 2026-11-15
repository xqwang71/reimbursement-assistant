export function projectNumberKey(projectNo) {
  return String(projectNo ?? '').normalize('NFKC').trim().toUpperCase();
}

export function matchProjects(match) {
  if (!match) return [];
  if (Array.isArray(match.allocations)) return match.allocations;
  return match.projectNo && match.projectName ? [{ projectNo: match.projectNo, projectName: match.projectName }] : [];
}

export function allocateProjects(projects, totalCny) {
  if (!Number.isSafeInteger(totalCny) || totalCny <= 0) return { error: '核定报销额确定后才能分配经费' };
  if (!projects.length) return { error: '请选择经费项目' };
  if (projects.some(({ projectNo, projectName }) => !projectNo || !projectName) || new Set(projects.map(({ projectNo }) => projectNo)).size !== projects.length) {
    return { error: '经费项目不完整或重复，请重新选择' };
  }
  const fixed = projects.slice(0, -1);
  if (fixed.some(({ amountCny }) => !Number.isSafeInteger(amountCny) || amountCny <= 0)) return { error: '请填写每个手动分配项目的金额，精确到分且大于零' };
  const remainderCny = fixed.reduce((left, project) => left - project.amountCny, totalCny);
  if (remainderCny <= 0) return { error: '请为最后一个项目留出大于零的金额' };
  const last = projects.at(-1);
  return { allocations: [...fixed, { ...last, amountCny: remainderCny }] };
}

export function planProjects(plan) {
  return plan.projectAllocationDraft
    ? allocateProjects(plan.projectAllocationDraft, plan.totalCny).allocations || []
    : plan.project?.projectNo ? [{ ...plan.project, amountCny: plan.totalCny }] : [];
}
