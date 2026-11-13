import { getBrowserSession, savedPlatformUrl } from './browser-session.mjs';
import { claimBudgetSection, clickClaimEntry, clickSectionAdd } from './portal-navigation.mjs';

const DEFAULT_URL = 'http://znbx.suibe.edu.cn:8000/microportalweb/#/main';
const PROJECT_NO = /^[A-Z]\w*(?:-[A-Z0-9]+)+$/i;
const TOTAL_HEADER = /^(?:项目总额|预算总额|项目预算(?:总额|金额)?|预算金额)(?:[（(]元[）)])?$/;
const BALANCE_HEADER = /^(?:项目余额(?:[\/／]授权金额)?|项目可用余额|可用余额|可用金额|剩余(?:金额|余额|预算))(?:[（(]元[）)])?$/;
const BUDGET_TITLE = '经费预算信息';
const PICKER_TITLE = '请选择预算项目';
const LOGIN_MESSAGE = '请点击「检查校园网登录」，在报销专用 Chrome 完成学校认证后再同步';

function moneyCny(text) {
  const amount = String(text ?? '').normalize('NFKC').replace(/\s+/g, '').replace('−', '-');
  if (!/^-?¥?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?元?$/.test(amount)) return null;
  const cents = Math.round(Number(amount.replace(/[¥,元]/g, '')) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export async function projectRows(scope) {
  const tableRows = await scope.locator('tr:visible').evaluateAll((rows) => rows.flatMap((row) => {
    const cells = [...row.cells].map((cell) => cell.textContent.trim());
    const table = row.closest('.el-table') || row.closest('table');
    const headers = [...table.querySelectorAll('thead tr')].map((header) =>
      [...header.cells].map((cell) => cell.textContent.replace(/\s+/g, ''))
    ).find((header) => header.length === cells.length && header.some((label) => /^项目(?:编号|编码)$/.test(label)));
    return headers ? [{ cells, headers }] : [];
  }));
  return tableRows.flatMap(({ cells, headers }) => {
    const at = (pattern) => cells[headers.findIndex((header) => pattern.test(header))];
    const projectNo = at(/^项目(?:编号|编码)$/);
    if (!PROJECT_NO.test(projectNo || '')) return [];
    return [{
      projectNo,
      projectName: at(/^项目(?:名称|内容)$/) || '',
      department: at(/^(?:报销部门|归属部门|部门)$/) || '',
      totalCny: moneyCny(at(TOTAL_HEADER)),
      balanceCny: moneyCny(at(BALANCE_HEADER)),
    }];
  });
}

function atCampusLogin(page) {
  return new URL(page.url()).hostname === 'authserver.suibe.edu.cn';
}

async function visibleBudget(frame) {
  try {
    for (let current = frame; current.parentFrame(); current = current.parentFrame()) {
      if (!await (await current.frameElement()).isVisible()) return null;
    }
    return { frame, ...await claimBudgetSection(frame) };
  } catch (error) {
    if (error.code !== 'SECTION_NOT_READY' && !frame.isDetached()) throw error;
    return null;
  }
}

async function waitForBudget(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !atCampusLogin(page)) {
    const sections = (await Promise.all(page.frames().map(visibleBudget))).filter(Boolean);
    if (sections.length === 1) return sections[0];
    if (sections.length > 1) throw new Error('学校页面显示了多个经费预算区域，无法确定要读取的项目列表');
    await page.waitForTimeout(200);
  }
  throw new Error('学校的经费预算区域尚未加载，请稍后重试');
}

async function openProjectPicker(page, budget) {
  await page.bringToFront();
  await clickSectionAdd(budget.toolbar, BUDGET_TITLE);
  const title = budget.frame.getByText(PICKER_TITLE, { exact: true }).filter({ visible: true });
  const dialog = budget.frame.locator('.el-dialog:visible, [role="dialog"]:visible:not(:has(.el-dialog:visible))').filter({ has: title });
  await dialog.waitFor({ state: 'visible', timeout: 12000 });
  return dialog;
}

async function readPickerProjects(dialog) {
  const projects = new Map();
  const next = dialog.locator('.el-pagination button.btn-next:visible');
  const visited = new Set();
  let pageKey = '';
  while (true) {
    const deadline = Date.now() + 10000;
    let rows;
    let key;
    do {
      rows = await projectRows(dialog);
      key = rows.map(({ projectNo }) => projectNo).join('\n');
      if (key && key !== pageKey) break;
      await dialog.page().waitForTimeout(200);
    } while (Date.now() < deadline);
    if (!key || visited.has(key)) throw new Error('学校项目列表尚未加载完成，请稍后重试');
    visited.add(key);
    pageKey = key;
    for (const project of rows) projects.set(project.projectNo, project);
    if (!await next.count() || !await next.isEnabled()) return [...projects.values()];
    await next.click({ timeout: 5000 });
  }
}

async function readSelectedProject(budget, dialog, project) {
  const { projectNo } = project;
  const cell = dialog.getByRole('cell', { name: projectNo, exact: true });
  if (!await cell.count()) {
    const search = dialog.getByPlaceholder('请输入项目名称/编号', { exact: true });
    await search.fill(projectNo, { timeout: 4000 });
    await dialog.getByRole('button', { name: '查询', exact: true }).click({ timeout: 4000 });
  }
  await cell.waitFor({ state: 'visible', timeout: 10000 });
  const row = cell.locator('xpath=ancestor::tr[1]');
  const choice = row.locator('input[type="checkbox"], input[type="radio"]');
  const label = row.locator('label.el-checkbox:visible, label.el-radio:visible');
  if (!await choice.isChecked({ timeout: 4000 })) {
    if (await label.count() === 1) await label.click({ timeout: 4000 });
    else await choice.check({ timeout: 4000 });
  }
  if (!await choice.isChecked({ timeout: 4000 })) throw new Error(`学校页面未选中项目 ${projectNo}`);
  await dialog.getByRole('button', { name: /^确\s*认$/ }).click({ timeout: 4000 });
  const selectedCode = budget.table.getByRole('cell', { name: projectNo, exact: true }).filter({ visible: true });
  const insufficient = budget.frame.locator('.el-message-box:visible').filter({ hasText: /项目余额不足\s*[,，]\s*无法使用/ });
  await selectedCode.or(insufficient).first().waitFor({ state: 'visible', timeout: 10000 });
  if (await insufficient.count() === 1) {
    await insufficient.getByRole('button', { name: '确认', exact: true }).click({ timeout: 4000 });
    await dialog.waitFor({ state: 'hidden', timeout: 8000 });
    return { ...project, balanceCny: project.balanceCny > 0 ? null : project.balanceCny };
  }
  await dialog.waitFor({ state: 'hidden', timeout: 8000 });
  const selected = (await projectRows(budget.table)).find((entry) => entry.projectNo === projectNo);
  if (!selected) throw new Error(`学校经费预算表未返回项目 ${projectNo} 的数据`);
  return { ...project, balanceCny: selected.balanceCny ?? project.balanceCny, totalCny: selected.totalCny ?? project.totalCny };
}

export async function readWebProjectCatalog(page, portalUrl) {
  let step = '打开学校财务页面';
  try {
    await page.bringToFront();
    const response = await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (atCampusLogin(page)) throw new Error(LOGIN_MESSAGE);
    if (response && response.status() >= 400) throw new Error(`学校财务页面返回 ${response.status()}，请检查校园网连接和登录`);
    await clickClaimEntry(page);
    const budget = await waitForBudget(page);
    step = '打开经费项目列表';
    let dialog = await openProjectPicker(page, budget);
    step = '读取经费项目列表';
    const projects = await readPickerProjects(dialog);
    const catalog = [];
    for (const project of projects) {
      step = `读取项目 ${project.projectNo} 的余额`;
      dialog ??= await openProjectPicker(page, budget);
      catalog.push(await readSelectedProject(budget, dialog, project));
      dialog = null;
    }
    return catalog;
  } catch (error) {
    if (atCampusLogin(page)) throw new Error(LOGIN_MESSAGE, { cause: error });
    if (error.name === 'TimeoutError' || /^(?:page|locator|frame)\./.test(error.message)) {
      throw new Error(`学校页面未能${step}，请稍后重试`, { cause: error });
    }
    throw error;
  }
}

export async function listWebProjects(appDir) {
  const { page } = await getBrowserSession(appDir, { temporary: true });
  try {
    const portalUrl = process.env.SUIBE_REIMBURSEMENT_URL || await savedPlatformUrl(appDir) || DEFAULT_URL;
    return await readWebProjectCatalog(page, portalUrl);
  } finally {
    await page.close().catch(() => undefined);
  }
}
