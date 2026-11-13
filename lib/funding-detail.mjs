export function schoolMoneyCny(value) {
  const amount = String(value ?? '').replace(/[￥¥,\s]/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  const cents = Math.round(Number(amount) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function projectExpenseChoices(projects, rows) {
  const populated = rows.filter((row) => row.amountCny > 0);
  const subjects = new Set(rows.map((row) => row.subject).filter(Boolean));
  return [...subjects].filter((subject) =>
    populated.every((row) => row.subject === subject && row.editable !== false) &&
    projects.every(({ projectNo }) => rows.filter((row) => row.projectNo === projectNo && row.subject === subject && row.editable !== false).length === 1));
}

export function fundingDetailAmounts(projects, rows, totalCny, availableCny, expenseType) {
  const filled = new Map();
  for (const row of rows) {
    if (row.amountCny > 0) filled.set(row.category, (filled.get(row.category) || 0) + row.amountCny);
  }
  const eligible = new Set(rows.map((row) => row.category));
  const observed = [...filled.values()].reduce((sum, amount) => sum + amount, 0);
  let categoryAmounts;
  if (observed === availableCny && totalCny === availableCny) categoryAmounts = filled;
  else if (observed === availableCny && filled.size === 1) categoryAmounts = new Map([[filled.keys().next().value, totalCny]]);
  else if (eligible.size === 1) categoryAmounts = new Map([[eligible.values().next().value, totalCny]]);
  else if (expenseType && projectExpenseChoices(projects, rows).includes(expenseType)) {
    const amounts = new Map(projects.map(({ projectNo, amountCny }) => [projectNo, amountCny]));
    return rows.map(({ key, projectNo, subject, editable }) => ({
      key, projectNo, amountCny: subject === expenseType && editable !== false ? amounts.get(projectNo) ?? 0 : 0,
    }));
  } else {
    throw Object.assign(new Error('学校显示了多个费用科目，尚未确认本笔各科目的分配金额。'), { code: 'PROJECT_EXPENSE_TYPE_REQUIRED' });
  }

  // Preserve both the school's expense-category totals and the user's project totals.
  const edges = new Map();
  const addEdge = (from, to, capacity) => {
    const edge = { from, to, left: capacity };
    edge.reverse = { from: to, to: from, left: 0, reverse: edge };
    edges.set(from, [...(edges.get(from) || []), edge]);
    edges.set(to, [...(edges.get(to) || []), edge.reverse]);
    return edge;
  };
  const source = Symbol();
  const sink = Symbol();
  const assigned = new Map();
  const extraHeadroom = new Map();
  for (const project of projects) addEdge(project.projectNo, sink, project.amountCny);
  for (const [category, amount] of categoryAmounts) {
    const node = Symbol();
    addEdge(source, node, amount);
    for (const project of projects) {
      const candidates = rows.filter((row) => row.projectNo === project.projectNo && row.category === category);
      const prefilled = candidates.filter((row) => row.amountCny > 0);
      const hasRoom = candidates.filter((row) => row.limitCny > 0);
      const field = candidates.length === 1 ? candidates[0] : prefilled.length === 1 ? prefilled[0] : hasRoom.length === 1 ? hasRoom[0] : null;
      if (!field) continue;
      const limit = Math.min(Math.max(field.limitCny, field.amountCny), amount, project.amountCny);
      const certain = addEdge(node, project.projectNo, limit);
      // The displayed headroom can be zero until another project's amount is reduced.
      const shared = addEdge(node, project.projectNo, 0);
      if (limit < Math.min(amount, project.amountCny)) extraHeadroom.set(shared, Math.min(amount, project.amountCny) - limit);
      assigned.set(field.key, [certain, shared]);
    }
  }
  let unassigned = totalCny;
  while (unassigned > 0) {
    const parents = new Map([[source, null]]);
    const queue = [source];
    for (let index = 0; index < queue.length && !parents.has(sink); index += 1) {
      for (const edge of edges.get(queue[index]) || []) {
        if (edge.left <= 0 || parents.has(edge.to)) continue;
        parents.set(edge.to, edge);
        queue.push(edge.to);
      }
    }
    if (!parents.has(sink)) {
      if (!extraHeadroom.size) throw new Error('学校显示的费用科目或可用额度无法覆盖本次分配。请核对各项目的开支范围和额度。');
      for (const [edge, capacity] of extraHeadroom) edge.left = capacity;
      extraHeadroom.clear();
      continue;
    }
    const path = [];
    for (let edge = parents.get(sink); edge; edge = parents.get(edge.from)) path.push(edge);
    const amount = Math.min(unassigned, ...path.map((edge) => edge.left));
    for (const edge of path) {
      edge.left -= amount;
      edge.reverse.left += amount;
    }
    unassigned -= amount;
  }
  return rows.map(({ key, projectNo }) => ({ key, projectNo, amountCny: (assigned.get(key) || []).reduce((sum, edge) => sum + edge.reverse.left, 0) }));
}
