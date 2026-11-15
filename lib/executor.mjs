import { browserTargetId, getBrowserSession, savePlatformSession, savedPlatformUrl } from './browser-session.mjs';
import { CAMPUS_LOGIN_REQUIRED, campusLoginError, claimBudgetSection, claimEntryError, claimSectionRoot, clickClaimEntry, clickSectionAdd, isCampusLogin } from './portal-navigation.mjs';
import { projectRows } from './projects.mjs';
import { planProjects } from '../public/project-allocation.js';
import { fundingDetailAmounts, projectExpenseChoices, schoolMoneyCny } from './funding-detail.mjs';
import { selectDidiInvoices, validateDidiInvoiceDates, validateDidiSelection } from './didi-invoices.mjs';
import { chooseDidiWalletCards, didiWallet, observedDidiImages, openDidiWallet, readDidiWallet } from './didi-wallet.mjs';
import { attachTravelApplication, fillDomesticTravel, linkedTravelApplication } from './school-travel.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const DEFAULT_URL = 'http://znbx.suibe.edu.cn:8000/microportalweb/#/main';
const PAYMENT_TIMEOUT_MS = 15000;
const REMAINING_PAYMENT = /待支付金额\s*[:：]?\s*[¥￥]?\s*(-?[\d,]+(?:\.\d+)?)/;
const PRE_REVIEW_CONFIRM_BUTTON = /^(确\s*[认定]|是|提交)$/;
const DOMESTIC_TRAVEL_PAGE = /\/TravelPCWeb\/travel-reimbursement(?:[?/#]|$)/;
const DOMESTIC_CLAIM_TYPE = /^(?:国内差旅(?:报销)?|差旅报销)$/;

function cny(cents) {
  return (cents / 100).toFixed(2);
}

function signerShown(text, { name, employeeNo }) {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ');
  const literal = (value) => String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const exactName = new RegExp('(?<![\\p{L}\\p{M}])' + literal(name) + '(?![\\p{L}\\p{M}])', 'u');
  const exactCode = employeeNo && new RegExp('(?<![A-Za-z0-9])' + literal(employeeNo) + '(?![A-Za-z0-9])');
  return exactName.test(normalized) && (!exactCode || exactCode.test(normalized));
}

export function readUploadReceipt(text) {
  const invoices = text.match(/(?:当前票据总张数|发票张数|发票数量|发票数)\s*[：:]\s*(\d+)/)?.[1];
  const attachments = text.match(/当前附件总张数\s*[：:]\s*(\d+)/)?.[1];
  const total = text.match(/(?:当前票据总金额|发票总额|发票金额合计|发票合计)\s*[：:]\s*[¥￥]?\s*([\d,]+\.\d{2})/)?.[1];
  return {
    invoiceCount: invoices === undefined ? null : Number(invoices),
    attachmentCount: attachments === undefined ? null : Number(attachments),
    invoiceTotalCny: total === undefined ? null : Math.round(Number(total.replaceAll(',', '')) * 100),
  };
}

function documentId(text) {
  return text.match(/(?:报销单号|报销单编号|单据编号|单据号)[：:\s]*([A-Za-z0-9-]{6,40})/)?.[1] || null;
}

function fillingId(url) {
  if (!URL.canParse(url)) return null;
  const current = new URL(url);
  if (!['/ClaimsPublicPCWeb/filling', '/ClaimsPublicPCWeb/reimburse', '/TravelPCWeb/travel-reimbursement'].includes(current.pathname)) return null;
  const id = current.searchParams.get('id');
  return /^[A-Za-z0-9_-]{1,80}$/.test(id || '') ? id : null;
}

function preReviewFinanceId(url) {
  if (!URL.canParse(url)) return null;
  const current = new URL(url);
  if (current.pathname !== '/ClaimsPublicPCWeb/preliminaryExamination') return null;
  const code = current.searchParams.get('code');
  return /^[A-Za-z0-9-]{6,40}$/.test(code || '') ? code : null;
}

function submissionFailed(text) {
  return /提交失败|预审失败|校验不通过|不能提交|无法提交|保存失败|(?:未|没有|尚未|未能|不能|无法).{0,8}(?:提交成功|预审成功|已提交预审)|(?:提交|预审).{0,8}未成功/.test(text);
}

function submissionSucceeded(text) {
  return !submissionFailed(text) && /提交成功|预审成功|已提交预审/.test(text);
}

function normalizeExpenseType(word) {
  if (/数据采集费/.test(word)) return '数据采集费';
  if (/设备/.test(word)) return '设备';
  if (/材料/.test(word)) return '其他材料费';
  if (/杂项/.test(word)) return '其他教学杂项费用';
  if (/办公/.test(word)) return '办公费';
  return null;
}

export function parseExpenseTypeAnswer(answer) {
  const rules = [];
  let defaultType = null;
  for (const clause of String(answer).split(/[，,；;。\n]+/)) {
    const text = clause.trim().replace(/^(?:(?:这笔|这一笔|本笔)的?)?(?:报销科目|科目|明细费用类型|费用类型)\s*(?:选择了?|选了?|用|为|是|[：:])\s*/, '');
    if (!text) continue;
    const pair = text.match(/^(.+?)(?:是|算|按|选|归为|属于|用)(.+)$/);
    if (pair) {
      const type = normalizeExpenseType(pair[2]);
      if (!type) continue;
      if (/^(其他|其它|其余|剩下|剩余|全部|所有|都)/.test(pair[1])) defaultType = type;
      else rules.push({ keyword: pair[1].trim().replace(/^["'“‘]|["'”’]$/g, ''), type });
    } else {
      const type = normalizeExpenseType(text);
      if (type) defaultType = type;
    }
  }
  return { defaultType, rules };
}

export class ReimbursementExecutor {
  constructor({ plan, appDir, onEvent, ask, control = null, onLearned = null, resumeStages = false, validate = async () => {}, onProgress = async () => {}, getSubmittedInvoices = () => [] }) {
    this.plan = plan;
    this.appDir = appDir;
    this.onEvent = onEvent;
    this.ask = ask;
    this.control = control || {};
    this.control.progress ||= { uploads: [], submission: { state: 'not_started' } };
    this.control.progress.uploads ||= [];
    this.control.progress.submission ||= { state: 'not_started' };
    this.progress = this.control.progress;
    this.validate = validate;
    this.onProgress = onProgress;
    this.workContext = null;
    this.onLearned = onLearned;
    this.getSubmittedInvoices = getSubmittedInvoices;
    this.resumeStages = resumeStages;
    this.browser = null;
    this.page = null;
  }

  log(step, status = 'running', detail = '') {
    this.onEvent({ type: 'step', step, status, detail, at: new Date().toISOString() });
  }

  async checkpoint() {
    if (this.control?.cancelled) throw new Error('用户取消任务');
    while (this.control?.paused) {
      this.log('等待继续指令', 'waiting');
      const answer = await this.ask('已按你的要求暂停。回复“继续”后从当前步骤续跑。', { kind: 'pause' });
      if (/继续|恢复/.test(answer)) this.control.paused = false;
    }
  }

  async saveProgress() {
    await this.onProgress(this.progress);
  }

  async guard() {
    await this.checkpoint();
    await this.validate();
  }

  async work({ bind = true } = {}) {
    if (this.workContext && this.workContext !== this.page) {
      try {
        if (!this.workContext.isDetached() && await (await this.workContext.frameElement()).isVisible()) return this.workContext;
      } catch {}
      throw new Error('当前报销页面已不可见或已被替换，需核实原草稿后再继续');
    }
    const visible = [];
    for (const frame of this.page.frames().filter((item) => item.parentFrame() && /ClaimsPublicPCWeb|\/TravelPCWeb\/travel-reimbursement/.test(item.url()))) {
      try { if (await (await frame.frameElement()).isVisible()) visible.push(frame); } catch {}
    }
    const filling = visible.filter((frame) => /ClaimsPublicPCWeb\/(filling|reimburse|fast-reimbursement)(?:[?/#]|$)|\/TravelPCWeb\/travel-reimbursement(?:[?/#]|$)/.test(frame.url()));
    const candidates = filling.length ? filling : visible;
    if (candidates.length > 1) throw new Error('存在多个可见报销页面，无法确认当前单据，请先保留一个填报页面');
    if (candidates.length === 1) {
      if (bind) this.workContext = candidates[0];
      return candidates[0];
    }
    if (this.workContext && this.workContext !== this.page) throw new Error('当前报销页面已不可见，请核实单据后再继续');
    return this.page;
  }

  async bodyText({ bind = true, timeout = 5000 } = {}) {
    return (await this.work({ bind })).locator('body').innerText({ timeout });
  }

  async sectionRoot(label) {
    return claimSectionRoot(await this.work(), label);
  }

  async budgetSection() {
    return claimBudgetSection(await this.work());
  }

  async assertDocumentIdentity(text = null, currentInvoiceNumbers = []) {
    text ??= await this.bodyText();
    const currentId = documentId(text);
    if (this.progress.documentId && currentId && currentId !== this.progress.documentId) throw new Error('当前单据编号已变化，不能把原任务的核验记录用于其他草稿');
    const currentFillingId = this.progress.fillingId ? fillingId((await this.work()).url()) : null;
    if (currentFillingId && currentFillingId !== this.progress.fillingId) throw new Error('当前填报页面的草稿已变化，请保留原单');
    const invoicesVisible = this.plan.rows.length > 0 && this.plan.rows.every((row) => text.includes(row.invoiceNumber) || currentInvoiceNumbers.includes(row.invoiceNumber));
    const sameDocument = (currentId && this.progress.documentId === currentId) ||
      (currentFillingId && await browserTargetId(this.page) === this.progress.uploadPageId);
    if (!invoicesVisible && !sameDocument) throw new Error('当前草稿的发票身份或稳定单据编号无法核对，不能直接续跑');
    if (invoicesVisible && currentId && !this.progress.documentId) {
      this.progress.documentId = currentId;
      await this.saveProgress();
    }
    return { currentId, invoicesVisible };
  }

  async clickText(text, options = {}) {
    const target = (await this.work()).getByText(text, { exact: options.exact ?? true }).first();
    await target.click({ timeout: options.timeout || 15000 });
  }

  async waitText(text, timeout = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const body = await this.bodyText();
      if (text instanceof RegExp ? text.test(body) : body.includes(text)) return body;
      await this.page.waitForTimeout(250);
    }
    throw new Error(`等待页面文字“${text}”超时（${timeout}ms）`);
  }

  async openPlatform() {
    this.log('连接报销专用 Chrome', 'running', '沿用批次的报销标签');
    const resumePageId = this.resumeStages && this.progress.uploadPageId;
    const preferredPageId = resumePageId || this.control.portalPageId;
    const session = await getBrowserSession(this.appDir, { existingOnly: Boolean(preferredPageId) });
    const portalUrl = process.env.SUIBE_REIMBURSEMENT_URL || await savedPlatformUrl(this.appDir) || DEFAULT_URL;
    const portalOrigin = this.portalOrigin = new URL(portalUrl).origin;
    let page = session.page;
    if (preferredPageId) {
      page = null;
      for (const candidate of session.context.pages()) {
        if (await browserTargetId(candidate).catch(() => null) !== preferredPageId) continue;
        page = candidate;
        break;
      }
      if (!page) throw new Error('找不到本批原报销标签页，请保留原单并核对当前状态');
    }
    if (resumePageId && new URL(page.url()).origin !== portalOrigin) throw new Error('原单所在标签已离开学校财务平台，请核对登录和原单');
    this.browser = session.browser;
    if (this.page !== page || this.resumeStages) this.workContext = null;
    this.page = session.page = page;
    if (!this.control.portalPageId) {
      this.control.portalPageId = preferredPageId || await browserTargetId(page);
      await this.saveProgress();
    }
    await page.bringToFront();
    if (resumePageId) return;
    const url = new URL(page.url());
    const forbidden = (await page.title().catch(() => '')) === '403 Forbidden';
    if (!isCampusLogin(url) && (forbidden || url.origin !== portalOrigin || url.pathname.startsWith('/ClaimsPublicPCWeb/'))) {
      const response = await page.goto(portalUrl, { waitUntil: 'domcontentloaded' });
      if (response?.status() >= 400) throw new Error(`学校财务页面返回 ${response.status()}，请检查校园网连接后重试`);
    }
    await page.waitForURL((current) => current.origin === portalOrigin || isCampusLogin(current), { timeout: 60000 });
    await this.waitForCampusLogin();
    await savePlatformSession(page, this.appDir);
  }

  async waitForCampusLogin() {
    const { page, portalOrigin } = this;
    if (!isCampusLogin(page.url())) return;
    this.control.waitingForCampusLogin = true;
    this.log('等待校园网登录', 'waiting', '请在报销专用 Chrome 完成学校认证。返回财务页面后会自动继续。');
    const deadline = Date.now() + 10 * 60 * 1000;
    try {
      while (Date.now() < deadline) {
        await this.checkpoint();
        if (page.isClosed()) throw campusLoginError('学校登录标签已关闭，请保留原标签后继续。');
        if (new URL(page.url()).origin === portalOrigin) {
          delete this.control.waitingForCampusLogin;
          this.log('校园网登录已完成');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw campusLoginError('等待学校登录超时。登录完成后，在「执行与互动」发送「继续」。');
    } finally {
      delete this.control.waitingForCampusLogin;
    }
  }

  async claimPageReached() {
    const text = await this.bodyText({ bind: false, timeout: 1200 }).catch((error) => {
      if (error.name === 'TimeoutError' || /frame was detached/i.test(error.message)) return '';
      throw error;
    });
    return text.includes('单据填报-') || text.includes('确认提交报销单') ||
      (text.includes('经费预算信息') && text.includes('票据影像'));
  }

  async ensureFreshForm() {
    if (this.resumeStages) return;
    const text = await this.bodyText();
    if (text.includes('单据填报-') || text.includes('确认提交报销单')) throw new Error('页面已有报销草稿，不能覆盖；请先核实并结束该草稿，再新建任务');
  }

  async openClaim() {
    this.log('进入我要报销');
    if (await this.claimPageReached()) {
      await this.ensureFreshForm();
      return;
    }
    await this.checkpoint();
    try {
      await clickClaimEntry(this.page);
    } catch (error) {
      if (error.code !== CAMPUS_LOGIN_REQUIRED && !isCampusLogin(this.page.url())) throw error;
      await this.waitForCampusLogin();
      await this.guard();
      await clickClaimEntry(this.page);
    }
    this.log('等待学校填报页加载', 'running', '等待经费预算信息和票据影像出现');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (isCampusLogin(this.page.url())) throw campusLoginError();
      if (await this.claimPageReached()) {
        await this.ensureFreshForm();
        return;
      }
      await this.page.waitForTimeout(300);
    }
    throw claimEntryError('已点击“我要报销”，但学校填报页尚未加载。请保留当前报销标签后重试。');
  }

  async addProject() {
    const projects = planProjects(this.plan);
    if (!projects.length) throw new Error('未配置经费项目或分配金额');
    await this.guard();
    for (const project of projects) await this.addBudgetProject(project.projectNo);
    const { table } = await this.budgetSection();
    const selected = await projectRows(table);
    if (new Set(selected.map((item) => item.projectNo)).size !== projects.length || selected.some((item) => !projects.some((project) => project.projectNo === item.projectNo))) {
      throw new Error('学校页面实际选中的经费项目与报销事项不一致');
    }
    for (const project of projects) {
      const balanceCny = selected.find((item) => item.projectNo === project.projectNo)?.balanceCny;
      if (!Number.isSafeInteger(balanceCny)) throw new Error(`无法读取 ${project.projectNo} 的项目余额`);
      if (this.plan.didi && balanceCny <= 0) throw new Error(`项目 ${project.projectNo} 没有可用余额，请在右栏改选项目`);
      if (balanceCny < project.amountCny) throw new Error(`项目 ${project.projectNo} 余额 ${cny(balanceCny)} 元，不足分配的 ${cny(project.amountCny)} 元，请更新中栏分配`);
    }
    if (projects.length === 1) {
      this.plan.project.balanceCny = selected[0].balanceCny;
      this.progress.project = projects[0].projectNo;
    }
    await this.saveProgress();
  }

  async addDidiTickets() {
    await this.guard();
    const { plan, progress } = this;
    validateDidiInvoiceDates(plan.rows);
    const target = await browserTargetId(this.page);
    if (!target || target !== this.control.portalPageId || progress.uploadPageId && progress.uploadPageId !== target) {
      throw new Error('无法确认滴滴票夹仍在原报销标签');
    }
    const observed = await this.uploadSnapshot();
    const scope = await this.work();
    const wallet = didiWallet(scope);
    let confirmedHere = false;
    if (progress.didiWallet?.state !== 'started' && progress.didiWallet?.state !== 'verified') {
      if ((!observed.empty && observed.invoiceCount !== 0) || observed.invoiceNumbers.length || observed.fileNames.length) {
        throw new Error('原单已有票据，请核对后再添加滴滴票据');
      }
      const opened = await openDidiWallet(scope);
      const tickets = await readDidiWallet(opened, this.page, () => this.checkpoint());
      const limit = Math.min(plan.didi.budgetCny, plan.project.balanceCny);
      if (tickets.some(({ checked }) => checked) && !plan.rows.length) throw new Error('票夹已有勾选的票据，请核对原单后继续');
      const selected = plan.rows.length ? plan.rows.map((row) => ({
        invoiceNumber: row.invoiceNumber, date: row.date, amountCny: row.invoiceAmountCny,
      })) : selectDidiInvoices(tickets, limit, this.getSubmittedInvoices());
      if (!selected.length) throw new Error(`滴滴票夹没有符合报销年度且不超过 ${cny(limit)} 元的可用票据，请核对开票日期、预算和项目余额`);
      const total = selected.reduce((sum, { amountCny }) => sum + amountCny, 0);
      if (total > limit) throw new Error('已选滴滴票据金额超过当前预算或项目余额');
      plan.rows = selected.map(({ invoiceNumber, date, amountCny }) => ({
        invoiceNumber, date, invoiceAmountCny: amountCny, paidAmountCny: amountCny, reimbursementAmountCny: amountCny, amountBasis: '学校滴滴票夹',
      }));
      plan.invoiceTotalCny = plan.paidTotalCny = plan.totalCny = total;
      validateDidiSelection(plan, this.getSubmittedInvoices());
      await this.saveProgress();
      this.log('按预算选择滴滴票据', 'running', `选中 ${selected.length} 张，共 ${cny(total)} 元，预算上限 ${cny(plan.didi.budgetCny)} 元`);
      const confirm = await chooseDidiWalletCards(scope, opened, selected);
      await this.guard();
      progress.uploadPageId = target;
      progress.didiWallet = { state: 'started' };
      await this.saveProgress();
      await this.checkpoint();
      validateDidiInvoiceDates(plan.rows);
      await confirm.click();
      confirmedHere = true;
    }
    await wallet.waitFor({ state: 'hidden', timeout: 15000 });
    const expected = new Set(plan.rows.map(({ invoiceNumber }) => invoiceNumber));
    const signatures = (rows) => rows.map(({ date, amountCny }) => `${date} ${amountCny}`).sort().join('\n');
    const expectedSignatures = signatures(plan.rows.map(({ date, invoiceAmountCny }) => ({ date, amountCny: invoiceAmountCny })));
    const deadline = Date.now() + 12000;
    do {
      await this.checkpoint();
      const current = await this.uploadSnapshot();
      const sameNumbers = current.invoiceNumbers.length === expected.size && current.invoiceNumbers.every((number) => expected.has(number));
      const images = await observedDidiImages(await this.sectionRoot('票据影像'));
      const imageMatches = !current.invoiceNumbers.length && images.length === expected.size && images.every(({ order, seller }) => order && seller === '滴滴平台') &&
        signatures(images) === expectedSignatures && (confirmedHere || progress.didiWallet.state === 'verified');
      if (!current.busy && (sameNumbers || imageMatches) && current.invoiceCount === expected.size && current.invoiceTotalCny === plan.totalCny &&
          (current.attachmentCount === null || current.attachmentCount === 0)) {
        const number = documentId(await this.bodyText());
        if (number && progress.documentId && progress.documentId !== number) throw new Error('滴滴票据所在报销单已变化');
        if (number) progress.documentId = number;
        progress.didiWallet = { ...progress.didiWallet, state: 'verified' };
        progress.verifiedInvoiceNumbers = [...expected];
        progress.ownedDocument = true;
        await this.saveProgress();
        this.log('学校已接收滴滴票据', 'running', `${expected.size} 张 · ${cny(plan.totalCny)} 元`);
        await this.guard();
        await scope.getByRole('button', { name: '下一步', exact: true }).click();
        return;
      }
      await this.page.waitForTimeout(250);
    } while (Date.now() < deadline);
    throw new Error('学校票据影像与已选滴滴票号、张数或金额不一致，请保留原单');
  }

  async addBudgetProject(projectNo) {
    await this.checkpoint();
    const scope = await this.work();
    const { toolbar, table } = await this.budgetSection();
    const findRow = async (root) => {
      for (const row of await root.locator('tr:visible').filter({ hasText: projectNo }).all()) {
        const cells = await row.locator('td').allInnerTexts();
        if (cells.some((cell) => cell.trim() === projectNo)) return row;
      }
      return null;
    };
    let row = await findRow(table);
    if (!row) {
      this.log('添加经费项目');
      const dialog = scope.locator('.el-dialog:visible, [role="dialog"]:visible').filter({ hasText: '请选择预算项目' }).last();
      if (!await dialog.count()) await clickSectionAdd(toolbar, '经费预算信息');
      await dialog.waitFor({ state: 'visible', timeout: 15000 });
      await dialog.locator('tbody tr:visible td').first().waitFor({ timeout: 10000 }).catch(() => undefined);
      row = await findRow(dialog);
      if (!row) {
        const search = dialog.getByPlaceholder('请输入项目名称/编号', { exact: true }).filter({ visible: true });
        if (await search.count() === 1) {
          await search.fill(projectNo);
          await dialog.getByRole('button', { name: '查询', exact: true }).click();
        }
        const match = dialog.getByRole('cell', { name: projectNo, exact: true }).first();
        await match.waitFor({ state: 'visible', timeout: 30000 }).catch(() => undefined);
        row = await findRow(dialog);
      }
      if (!row) throw new Error(`学校项目列表中未找到 ${projectNo}`);
      await row.scrollIntoViewIfNeeded();
      const choice = row.locator('input[type="checkbox"], input[type="radio"]');
      if (await choice.count() !== 1) throw new Error('无法定位目标经费项目的选择控件');
      if (!await choice.isChecked()) {
        const label = row.locator('label.el-checkbox:visible, label.el-radio:visible');
        if (await label.count() === 1) await label.click();
        else await choice.check({ force: true });
      }
      if (!await choice.isChecked()) throw new Error('未能确认目标经费项目已选中');
      await dialog.getByRole('button', { name: /^确\s*认$/ }).click();
      await dialog.waitFor({ state: 'hidden' });
      await table.getByText(projectNo, { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 12000 }).catch(() => undefined);
      row = await findRow(table);
    } else this.log('已存在该经费项目，核对后复用');
    if (!row) throw new Error(`未能确认项目 ${projectNo} 已添加`);
  }

  async uploadSnapshot() {
    const panel = await this.sectionRoot('票据影像');
    const { text, attributes, busy, emptyGrid } = await panel.evaluate((root) => {
      const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[aria-hidden="true"]');
      const excluded = (node) => node.closest('.el-dialog, .el-message-box, [role="dialog"]') || (node.closest('.el-upload-list__item') && !node.closest('.el-upload-list__item.is-success'));
      const lines = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (parent && visible(parent) && !excluded(parent)) lines.push(walker.currentNode.textContent.trim());
      }
      const attributes = [...root.querySelectorAll('[title], [alt], [data-file-name], [data-invoice-number]')].filter((node) => visible(node) && !excluded(node)).flatMap((node) => ['title', 'alt', 'data-file-name', 'data-invoice-number'].map((name) => node.getAttribute(name)).filter(Boolean));
      const dialogs = [...document.querySelectorAll('.el-dialog, .el-message-box, [role="dialog"]')].some((node) => visible(node) && /上传|选择文件/.test(node.innerText));
      const loading = [...root.querySelectorAll('.el-loading-mask, [aria-busy="true"]')].some(visible);
      const grid = root.querySelector(':scope > .theSecondStep-top > .theSecondStep-divFlex');
      const emptyGrid = Boolean(grid && grid.childElementCount === 0 && !grid.textContent.trim());
      return { text: lines.filter(Boolean).join('\n'), attributes, busy: dialogs || loading, emptyGrid };
    });
    const content = `${text}\n${attributes.join('\n')}`;
    const fileNames = [...new Set([...text.split('\n'), ...attributes].map((name) => name.trim()).filter((name) => /^[^<>\n]+\.(?:pdf|png|jpe?g|webp|docx|xlsx?|csv|txt|md)$/i.test(name)))];
    const names = this.plan.uploadFiles.map((file) => file.name).filter((name) => fileNames.includes(name));
    const invoicePattern = this.plan.didi ? /\b(?:\d{16}|\d{20})\b/g : /\b\d{20}\b/g;
    const invoiceNumbers = [...new Set([...content.matchAll(invoicePattern)].map((match) => match[0]))];
    const receipt = readUploadReceipt(text);
    const empty = !busy && (emptyGrid || /暂无票据|未上传|暂无数据|发票(?:张数|数量|数)[：:\s]*0\b/.test(text)) && fileNames.length === 0 && invoiceNumbers.length === 0;
    return { names, fileNames, invoiceNumbers, busy, ...receipt, empty };
  }

  uploadReceiptMatches(observed, files) {
    if (!this.progress.uploadPageId || observed.busy || !files.length) return false;
    const uniqueFiles = new Set(files);
    if (uniqueFiles.size !== files.length || files.some((name) => !this.plan.uploadFiles.some((file) => file.name === name))) return false;
    if (observed.fileNames?.some((name) => !uniqueFiles.has(name))) return false;
    const rows = this.plan.rows.filter((row) => uniqueFiles.has(row.invoiceFile));
    if (observed.invoiceNumbers?.some((number) => !rows.some((row) => row.invoiceNumber === number))) return false;
    return observed.invoiceCount === rows.length &&
      observed.attachmentCount === files.length - rows.length &&
      observed.invoiceTotalCny === rows.reduce((total, row) => total + row.invoiceAmountCny, 0);
  }

  verifiedUploadFiles() {
    return this.progress.uploads.filter((operation) => operation.state === 'verified').flatMap((operation) => operation.files);
  }

  async verifyUploadOperation(operation, observed) {
    if (observed.busy) return false;
    const files = [...this.verifiedUploadFiles(), ...operation.files];
    const schoolReceipt = this.uploadReceiptMatches(observed, files);
    if (!schoolReceipt && !operation.files.every((name) => observed.names?.includes(name))) return false;
    operation.state = 'verified';
    operation.proof = {
      names: operation.files,
      invoiceNumbers: observed.invoiceNumbers || [],
      schoolReceipt: schoolReceipt ? { invoiceCount: observed.invoiceCount, attachmentCount: observed.attachmentCount, invoiceTotalCny: observed.invoiceTotalCny } : undefined,
    };
    await this.saveProgress();
    return true;
  }

  async uploadBatch(batch, index) {
    await this.guard();
    this.log(`上传第 ${index + 1} 批材料`, 'running', `${batch.length} 个文件`);
    await clickSectionAdd(await this.sectionRoot('票据影像'), '票据影像');
    await this.clickText('从本设备选择');
    const chooserPromise = this.page.waitForEvent('filechooser');
    await this.clickText('点击上传');
    const renamed = batch.some((file) => file.name !== basename(file.absolutePath));
    const mimeTypes = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    const upload = renamed
      ? await Promise.all(batch.map(async (file) => ({ name: file.name, mimeType: mimeTypes[extname(file.name).toLowerCase()] || 'application/octet-stream', buffer: await readFile(file.absolutePath) })))
      : batch.map((file) => file.absolutePath);
    await (await chooserPromise).setFiles(upload);
    const submit = (await this.work()).getByRole('button', { name: /^上\s*传$/ });
    await this.guard();
    const target = await browserTargetId(this.page);
    if ((this.control.portalPageId && this.control.portalPageId !== target) ||
        (this.progress.uploadPageId && this.progress.uploadPageId !== target)) throw new Error('上传前无法确认仍在原报销标签页');
    this.progress.uploadPageId = target;
    const operation = { files: batch.map((file) => file.name), state: 'started' };
    this.progress.uploads.push(operation);
    await this.saveProgress();
    await this.checkpoint();
    await submit.click();
    await submit.waitFor({ state: 'hidden', timeout: 600000 });
    const deadline = Date.now() + (this.uploadTimeoutMs ?? 120000);
    do {
      if (await this.verifyUploadOperation(operation, await this.uploadSnapshot())) return;
      await this.page.waitForTimeout(500);
    } while (Date.now() < deadline);
    throw new Error('上传结果待核实：学校页面的票据或附件数量未能与本次上传清单对齐');
  }

  async uploadAll() {
    await this.guard();
    let observed = await this.uploadSnapshot();
    if (observed.busy) throw new Error('票据上传或选择窗口尚未结束，请核实当前上传结果后继续');
    const pendingUpload = this.progress.uploads.find((operation) => operation.state === 'started');
    if (pendingUpload && !await this.verifyUploadOperation(pendingUpload, observed)) throw new Error('上传结果待核实：学校回执尚未与本次上传清单对齐');
    const expectedNumbers = this.plan.rows.map((row) => row.invoiceNumber);
    if (observed.fileNames.some((name) => !this.plan.uploadFiles.some((file) => file.name === name))) throw new Error('当前票据区含有本计划之外的附件，不能继续上传');
    if (observed.invoiceNumbers.some((number) => !expectedNumbers.includes(number))) throw new Error('当前页面含有本计划之外的发票，不能继续上传');
    if (!observed.empty && observed.names.length === 0 && this.progress.uploads.length === 0) throw new Error('无法确认当前票据区为空或属于本计划，请先核实已有附件');
    const verified = this.verifiedUploadFiles();
    if (verified.length && !this.uploadReceiptMatches(observed, verified) && verified.some((name) => !observed.names.includes(name))) {
      throw new Error('无法确认原单的已上传票据与当前学校回执一致');
    }
    const missing = this.plan.uploadFiles.filter((file) => !observed.names.includes(file.name) && !verified.includes(file.name));
    for (let offset = 0; offset < missing.length; offset += 10) await this.uploadBatch(missing.slice(offset, offset + 10), offset / 10);
    observed = await this.uploadSnapshot();
    const identified = expectedNumbers.every((number) => observed.invoiceNumbers.includes(number));
    const completeByName = identified && this.plan.uploadFiles.every((file) => observed.names.includes(file.name));
    const verifiedAfterUpload = this.verifiedUploadFiles();
    const completeByReceipt = verifiedAfterUpload.length === this.plan.uploadFiles.length && this.uploadReceiptMatches(observed, verifiedAfterUpload);
    const attachmentCountMatches = observed.attachmentCount === null || observed.attachmentCount === this.plan.uploadFiles.length - this.plan.rows.length;
    if ((!completeByName && !completeByReceipt) || !attachmentCountMatches || observed.invoiceCount !== this.plan.rows.length || observed.invoiceTotalCny !== this.plan.invoiceTotalCny) throw new Error('上传汇总不一致：请核对学校回执的票据、附件张数和发票金额');
    if (identified) {
      this.progress.verifiedInvoiceNumbers = expectedNumbers;
      await this.assertDocumentIdentity(null, observed.invoiceNumbers);
    }
    this.progress.ownedDocument = true;
    await this.saveProgress();
    this.log('学校已接收上传材料', 'running', `${observed.invoiceCount} 张发票，${this.plan.uploadFiles.length - this.plan.rows.length} 份附件`);
    await this.guard();
    await (await this.work()).getByRole('button', { name: '下一步', exact: true }).click();
  }

  async selectClaimType() {
    const claimType = this.plan.claimType || '日常报销';
    this.log('选择报销类别', 'running', claimType);
    const category = (await this.work()).getByText(this.plan.travel ? DOMESTIC_CLAIM_TYPE : claimType, { exact: true }).filter({ visible: true });
    await category.first().waitFor({ timeout: 30000 });
    if (this.plan.didi || this.plan.travel) await category.click();
    else await category.first().click();
    await this.page.waitForTimeout(500);
    await (await this.work()).getByRole('button', { name: '单据填报', exact: true }).click();
    await this.waitText(this.plan.travel ? /单据填报\s*-\s*(?:国内差旅(?:报销)?|差旅报销)/ : `单据填报-${claimType}`, 60000);
    if (this.plan.didi) {
      const id = fillingId((await this.work()).url());
      if (!id) throw new Error('学校未显示贸大出行原单的草稿编号');
      this.progress.fillingId = id;
      await this.saveProgress();
    }
    if (this.plan.travel) await this.bindTravelDraft();
  }

  async bindTravelDraft() {
    const scope = await this.work();
    const id = fillingId(scope.url());
    if (!id || !this.progress.ownedDocument || !this.progress.uploadPageId ||
        await browserTargetId(this.page) !== this.progress.uploadPageId ||
        this.progress.fillingId && this.progress.fillingId !== id) {
      throw new Error('学校差旅页无法与本次上传的原单对应，请保留当前单据');
    }
    this.progress.fillingId = id;
    await this.saveProgress();
  }

  async addTravelApplication(required) {
    const scope = await this.work();
    if (!required && !await scope.getByText('业务单信息', { exact: true }).filter({ visible: true }).count()) return;
    const previous = this.progress.travelApplication || this.progress.pendingTravelApplication;
    const code = await attachTravelApplication(scope, this.plan.travel.facts, {
      previous, required, ask: this.ask, guard: () => this.guard(),
      onSelect: async (selected) => {
        this.progress.pendingTravelApplication = selected;
        await this.saveProgress();
      },
    });
    if (!code) return;
    this.progress.travelApplication = code;
    delete this.progress.pendingTravelApplication;
    await this.saveProgress();
    this.log('已关联国内出差申请', 'running', code);
  }

  async fillForm() {
    this.log('填写报销事由和费用类型');
    const currentText = await this.bodyText();
    if (!currentText.includes('请确认明细费用类型')) {
      if (this.plan.travel) {
        await this.bindTravelDraft();
        await this.addTravelApplication(true);
      }
      const reasonInput = (await this.work()).locator('input[role="textbox"][aria-autocomplete="list"]');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await reasonInput.fill(this.plan.reason);
        await this.page.keyboard.press('Escape');
        await this.page.waitForTimeout(300);
        if ((await reasonInput.inputValue().catch(() => '')).trim() === this.plan.reason) break;
        this.log(`报销事由填入校验未通过（第 ${attempt + 1} 次），重新填入`, 'running');
      }
      if ((await reasonInput.inputValue()).trim() !== this.plan.reason) {
        throw new Error('学校页面中的报销事由与确认内容不一致，请核对字段长度和实际填写内容');
      }
      await (await this.work()).getByRole('button', { name: '保存并下一步', exact: true }).click();
    }
    const hasExpenseDialog = this.plan.travel
      ? await this.travelExpenseDialogVisible()
      : (await this.waitText(/请确认明细费用类型|报销支出费用明细/, 300000)).includes('请确认明细费用类型');
    this.log('费用类型弹窗检测', 'running', hasExpenseDialog ? '已检测到' : '已进入费用明细');
    if (hasExpenseDialog) await this.fillExpenseType();
    if (this.plan.travel) return;
    if (!this.plan.projectAllocationDraft) {
      this.log('核对费用明细', 'running');
      await this.adjustExpenseAmounts();
      await this.verifyDetailAmounts();
    }
  }

  async fillExpenseType() {
    if (!this.plan.expenseType) {
      const rows = await this.expenseDialogRows();
      const preview = rows.length ? `\n当前明细行：${rows.map((text, index) => `${index + 1}. ${text}`).join('；')}` : '';
      for (let attempt = 0; attempt < 2 && !this.plan.expenseType; attempt += 1) {
        const answer = await this.ask(`请选择“${this.plan.subject}”的明细费用类型。可直接回复科目，也可在学校页面选好后回复「继续」。${preview}`, { kind: 'expense_type', required: true });
        const text = await this.bodyText();
        if (!text.includes('请确认明细费用类型') && text.includes('报销支出费用明细')) return;
        const parsed = parseExpenseTypeAnswer(answer);
        if (!parsed.defaultType) {
          if (/继续|恢复|往下做|接着办/.test(answer) && await this.expenseDialogSelectionsComplete()) {
            this.log('接续学校页面已选科目', 'running');
            await this.guard();
            await this.confirmExpenseTypes();
            return;
          }
          this.log('费用类型回复无法解析', 'error', answer);
          continue;
        }
        this.plan.expenseType = parsed.defaultType;
        this.plan.expenseTypeRules = parsed.rules;
        await this.onLearned?.('expenseType', parsed);
        this.log('费用类型已学习', 'running', `${this.plan.subject} 默认 ${parsed.defaultType}`);
      }
      if (!this.plan.expenseType) throw new Error('无法理解费用类型回复，请在学校页面选择科目并确认后继续');
    } else this.log('按记忆选择费用类型', 'running', this.plan.expenseType);
    await this.applyExpenseTypes();
    await this.confirmExpenseTypes();
  }

  async confirmExpenseTypes() {
    await (await this.expenseDialogRoot()).getByRole('button', { name: /^确\s*认$/ }).click();
    if (this.plan.travel) await (await this.work()).waitForURL(DOMESTIC_TRAVEL_PAGE, { timeout: 60000 });
    else await this.waitText('报销支出费用明细', 300000);
  }

  async travelExpenseDialogVisible() {
    const scope = await this.work();
    const dialog = scope.getByText('请确认明细费用类型', { exact: true }).filter({ visible: true }).first();
    return Promise.any([
      scope.waitForURL(DOMESTIC_TRAVEL_PAGE, { timeout: 60000 }).then(() => false),
      dialog.waitFor({ timeout: 60000 }).then(() => true),
    ]).catch(() => { throw new Error('学校未进入国内差旅明细，请核对业务单和明细费用类型'); });
  }

  async fillTravelForm() {
    await this.bindTravelDraft();
    if (!this.progress.travelApplication) throw new Error('原单缺少已关联的国内出差申请');
    this.log('填写差旅住宿和补贴');
    const scope = await this.work();
    await scope.getByText('出差人员明细', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 });
    await fillDomesticTravel(scope, this.plan.travel, { guard: () => this.guard(), ask: this.ask });
    await this.guard();
    const next = scope.getByRole('button', { name: '保存并下一步', exact: true }).filter({ visible: true });
    if (await next.count() !== 1) throw new Error('差旅页未显示唯一的保存按钮');
    this.progress.travelVerified = true;
    await this.saveProgress();
    await next.click();
    await this.waitText('报销支出费用明细', 60000);
    await this.bindTravelDraft();
  }

  async verifyTravelProjectDetails({ recheck = false } = {}) {
    if (!this.progress.travelVerified || !this.progress.travelApplication || recheck && !this.progress.travelProjectDetails?.length) {
      throw new Error('学校原单的出差申请或差旅金额尚未核对');
    }
    await this.bindTravelDraft();
    const scope = await this.work();
    const code = await linkedTravelApplication(scope);
    if (code !== this.progress.travelApplication) throw new Error('费用页的国内出差申请与原单不一致');
    const projects = planProjects(this.plan);
    let snapshot = await this.projectDetailSnapshot(projects);
    const travelRows = snapshot.rows.filter(({ subject, category }) => /差旅/.test(subject + category));
    if (!recheck && travelRows.length === projects.length &&
        projects.every(({ projectNo }) => travelRows.filter((row) => row.projectNo === projectNo && row.editable).length === 1) &&
        snapshot.rows.every((row) => !row.amountCny || travelRows.includes(row))) {
      const wanted = new Map(projects.map(({ projectNo, amountCny }) => [projectNo, amountCny]));
      const targets = new Set(travelRows.map(({ key }) => key));
      const write = (reducing) => this.projectDetailSnapshot(projects, async (row, amount, purpose) => {
        if (!targets.has(row.key)) return;
        const cents = wanted.get(row.projectNo);
        if (reducing ? row.amountCny > cents : row.amountCny < cents) {
          await amount.fill(cny(cents));
          await amount.press('Tab');
        }
        if (!reducing && row.purpose !== this.plan.reason) {
          await purpose.fill(this.plan.reason);
          await purpose.press('Tab');
        }
      });
      if (travelRows.some((row) => row.amountCny > wanted.get(row.projectNo))) await write(true);
      if (travelRows.some((row) => row.amountCny < wanted.get(row.projectNo) || row.purpose !== this.plan.reason)) await write(false);
      snapshot = await this.projectDetailSnapshot(projects);
    }
    const populated = snapshot.rows.filter(({ amountCny }) => amountCny > 0);
    if (snapshot.availableCny !== this.plan.totalCny || snapshot.remainingCny !== 0 ||
        !populated.length || populated.some(({ subject, category, purpose }) => !/差旅/.test(subject + category) || purpose !== this.plan.reason) ||
        projects.some((project) => populated.filter(({ projectNo }) => projectNo === project.projectNo)
          .reduce((total, { amountCny }) => total + amountCny, 0) !== project.amountCny)) {
      throw new Error('学校费用明细、差旅科目或用途与核定金额不一致');
    }
    const verified = populated.map(({ key, amountCny }) => [key, amountCny]);
    if (recheck) {
      if (JSON.stringify(this.progress.travelProjectDetails) !== JSON.stringify(verified)) throw new Error('提交前差旅费用分配已变化');
      return;
    }
    this.progress.travelProjectDetails = verified;
    this.progress.detailVerified = true;
    await this.saveProgress();
  }

  async adjustExpenseAmounts() {
    const scope = await this.detailSection();
    for (const row of this.plan.rows) {
      const containers = scope.locator('[data-invoice-number], tr, .nextClick-body').filter({ hasText: row.invoiceNumber });
      if (await containers.count() !== 1) continue;
      const inputs = containers.locator('input[placeholder*="金额"]:visible, input[data-reimbursement-amount]:visible');
      if (await inputs.count() === 1) {
        await inputs.fill(cny(row.reimbursementAmountCny));
        await inputs.press('Tab');
      }
    }
  }

  async detailSection() {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const panel = await this.sectionRoot('报销支出费用明细').catch((error) => {
        if (error.code !== 'SECTION_NOT_READY') throw error;
        return null;
      });
      if (panel && await panel.locator('input[placeholder*="金额"]:visible, input[data-reimbursement-amount]:visible').count()) return panel;
      await this.checkpoint();
      await this.page.waitForTimeout(250);
    }
    throw new Error('学校费用明细尚未加载出可核对的金额，请保留原单后重试');
  }

  async detailAmountSnapshot() {
    const panel = await this.detailSection();
    const snapshot = await panel.evaluate((root, didi) => {
      const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden' && !node.closest('[aria-hidden="true"]');
      const cents = (value) => {
        const raw = String(value).trim().replaceAll(',', '').replace(/^[¥￥]\s*/, '');
        if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
        const result = Math.round(Number(raw) * 100);
        return Number.isSafeInteger(result) ? result : null;
      };
      const rows = [...root.querySelectorAll('input[placeholder*="金额"], input[data-reimbursement-amount]')].filter(visible).map((input) => {
        let container = input.closest('[data-invoice-number], [data-invoice], tr, .nextClick-body');
        let invoiceNumbers = [];
        while (container && root.contains(container)) {
          const identityText = `${container.getAttribute('data-invoice-number') || ''} ${container.getAttribute('data-invoice') || ''} ${container.innerText}`;
          const pattern = didi ? /\b(?:\d{16}|\d{20})\b/g : /\b\d{20}\b/g;
          invoiceNumbers = [...new Set([...identityText.matchAll(pattern)].map((match) => match[0]))];
          if (invoiceNumbers.length) break;
          container = container.parentElement;
        }
        return {
          invoiceNumber: invoiceNumbers.length === 1 ? invoiceNumbers[0] : null,
          amountCny: cents(input.value),
          grouped: Boolean(input.closest('.el-collapse-item .detail')),
        };
      });
      const remaining = root.innerText.match(/待分配金额\s*[:：]?\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)/)?.[1];
      return { rows, remainingCny: remaining === undefined ? null : cents(remaining) };
    }, Boolean(this.plan.didi));
    return snapshot;
  }

  async groupedDetailPurpose() {
    const panel = await this.sectionRoot('报销支出费用明细');
    const field = panel.locator('.el-collapse-item .detail input[placeholder="请输入用途"]:visible');
    if (await field.count() !== 1) return null;
    return field.evaluate((input) => ({ value: input.value.trim(), maxLength: input.maxLength }));
  }

  purposeMatchesSchoolLimit(purpose) {
    return purpose?.value && purpose.maxLength > 0 && this.plan.reason.length > purpose.maxLength &&
      purpose.value === this.plan.reason.slice(0, purpose.maxLength).trimEnd();
  }

  async verifyGroupedDetail(snapshot, { recheck = false } = {}) {
    const row = snapshot.rows[0];
    if (snapshot.rows.length !== 1 || !row.grouped || row.invoiceNumber || row.amountCny !== this.plan.totalCny ||
        snapshot.remainingCny !== 0 || !this.plan.rows.length ||
        this.plan.rows.some((invoice) => invoice.reimbursementAmountCny !== invoice.invoiceAmountCny)) return false;
    const files = this.verifiedUploadFiles();
    const receipt = this.progress.uploads.at(-1)?.proof?.schoolReceipt;
    const evidence = this.plan.didi
      ? this.progress.didiWallet?.state === 'verified' && this.plan.rows.every(({ invoiceNumber }) => this.progress.verifiedInvoiceNumbers?.includes(invoiceNumber))
      : receipt && files.length === this.plan.uploadFiles.length && this.uploadReceiptMatches(receipt, files);
    if (!this.progress.ownedDocument || !evidence) throw new Error('费用明细核验失败：学校按科目合并显示金额，无法将这条明细与本次的发票和附件核验记录对应，请核对原单');
    const scope = await this.work();
    const id = fillingId(scope.url());
    if (!id || await browserTargetId(this.page) !== this.progress.uploadPageId) throw new Error('费用明细核验失败：无法确认这是本次上传票据的原草稿');
    if (this.progress.fillingId && this.progress.fillingId !== id) throw new Error('当前填报页面的草稿已变化，请保留原单');
    if (!(await this.bodyText()).includes(this.plan.project.projectNo)) throw new Error('费用明细核验失败：学校费用明细所属的经费项目与本机计划不一致');
    const purpose = await this.groupedDetailPurpose();
    if (!purpose) throw new Error('用途核验失败：无法读取学校费用明细的用途栏');
    if (recheck) {
      if (purpose.value !== this.progress.schoolDetailPurpose || !this.purposeMatchesSchoolLimit(purpose)) {
        throw new Error('用途核验失败：学校费用明细的用途与上次核验时不一致，请检查原单');
      }
      return true;
    }
    if (purpose.value !== this.plan.reason) {
      // The school copies the approved reason into the detail, subject to that field's own limit.
      if (this.plan.didi || !this.purposeMatchesSchoolLimit(purpose)) {
        const limit = purpose.maxLength > 0 ? `（学校用途栏上限 ${purpose.maxLength} 字）` : '';
        throw new Error(`用途核验失败：学校费用明细的金额已核对，页面用途与已确认的报销事由不一致${limit}，请核对学校用途栏`);
      }
      if (this.progress.schoolDetailPurpose !== purpose.value) {
        this.log('学校用途栏达到字数上限', 'warning', `上限 ${purpose.maxLength} 字 · 页面用途「${purpose.value}」`);
      }
      this.progress.schoolDetailPurpose = purpose.value;
    } else delete this.progress.schoolDetailPurpose;
    this.progress.fillingId = id;
    return true;
  }

  async verifyDetailAmounts() {
    const detailWasVerified = this.progress.detailVerified;
    if (detailWasVerified) {
      this.progress.detailVerified = false;
      delete this.progress.detailAmounts;
      await this.saveProgress();
    }
    const expected = new Map(this.plan.rows.map(({ invoiceNumber, reimbursementAmountCny }) => [invoiceNumber, reimbursementAmountCny]));
    let observed;
    while (true) {
      observed = await this.detailAmountSnapshot();
      const amounts = new Map(observed.rows.map(({ invoiceNumber, amountCny }) => [invoiceNumber, amountCny]));
      const exact = observed.rows.length === this.plan.rows.length && amounts.size === this.plan.rows.length &&
        observed.rows.every(({ invoiceNumber, amountCny }) => Number.isSafeInteger(amountCny) && expected.get(invoiceNumber) === amountCny) &&
        observed.rows.reduce((sum, { amountCny }) => sum + amountCny, 0) === this.plan.totalCny && observed.remainingCny === 0;
      if (exact) {
        delete this.progress.schoolDetailPurpose;
        break;
      }
      if (await this.verifyGroupedDetail(observed)) break;
      if (this.plan.didi) throw new Error('学校费用明细的滴滴票号或金额与本笔选择不一致，请核对原单');
      const remaining = observed.remainingCny === null ? '学校待分配金额暂时无法读取' : `学校待分配 ${cny(observed.remainingCny)} 元`;
      const differences = this.plan.rows.flatMap(({ invoiceNumber, reimbursementAmountCny }, index) => {
        const shown = amounts.get(invoiceNumber);
        return Number.isSafeInteger(shown) && shown !== reimbursementAmountCny
          ? [`第 ${index + 1} 张应报 ${cny(reimbursementAmountCny)} 元，学校显示 ${cny(shown)} 元。`] : [];
      });
      const detail = `学校费用明细金额核验失败。本机核定 ${cny(this.plan.totalCny)} 元，${remaining}。${differences.join('')}`;
      const answer = await this.ask(`${detail} 请核对学校页面的逐张金额或科目合并明细，再回复「重新核对」。`, { kind: 'amount_review', required: true });
      if (answer !== '继续') throw new Error(detail);
      await this.guard();
    }
    await this.assertDocumentIdentity(null, observed.rows.map((row) => row.invoiceNumber));
    this.progress.detailVerified = true;
    this.progress.detailAmounts = observed.rows.map(({ invoiceNumber, amountCny }) => ({ invoiceNumber, amountCny }));
    await this.saveProgress();
    if (!detailWasVerified) this.log('学校费用明细金额核对通过', 'running', `${cny(this.plan.totalCny)} 元 · 待分配 0.00 元`);
  }

  async projectDetailBoxes(panel, projects) {
    const boxes = await panel.locator('.project-box:visible').all();
    const selected = new Map();
    for (const box of boxes) {
      const label = await box.locator('.project-head .project-name').innerText({ timeout: 3000 });
      const project = projects.find(({ projectNo, projectName }) => label.trim() === `${projectNo}-${projectName}`);
      if (!project || selected.has(project.projectNo)) throw new Error('学校费用明细中的项目编号和名称与已选项目不一致');
      selected.set(project.projectNo, box);
    }
    if (selected.size !== projects.length) throw new Error('学校费用明细未显示全部已选项目');
    return selected;
  }

  async projectDetailSnapshot(projects, visit = null) {
    const panel = await this.sectionRoot('报销支出费用明细');
    const selected = await this.projectDetailBoxes(panel, projects);
    const rows = [];
    for (const [projectNo, box] of selected) {
      const tabs = await box.getByRole('tab').all();
      if (!tabs.length) throw new Error(`学校未显示项目 ${projectNo} 的可用额度和费用科目`);
      const active = (await Promise.all(tabs.map((tab) => tab.getAttribute('aria-selected')))).indexOf('true');
      for (const [tabIndex, tab] of tabs.entries()) {
        await this.checkpoint();
        if (await tab.getAttribute('aria-selected') !== 'true') await tab.click();
        const pane = box.locator('.el-tab-pane:visible');
        if (await pane.count() !== 1) throw new Error(`无法定位项目 ${projectNo} 的额度明细`);
        const quota = (await tab.innerText()).trim();
        for (const header of await pane.locator('.el-collapse-item__header:visible').all()) {
          if (await header.getAttribute('aria-expanded') !== 'true' && !await header.evaluate((node) => node.closest('.el-collapse-item').classList.contains('is-active'))) await header.click();
        }
        const details = await pane.locator('.el-collapse-item .detail').all();
        for (const [index, detail] of details.entries()) {
          const amount = detail.getByPlaceholder('请输入金额', { exact: true });
          const purpose = detail.getByPlaceholder('请输入用途', { exact: true });
          await amount.waitFor({ state: 'visible', timeout: 3000 });
          const row = await detail.evaluate((element) => {
            const input = element.querySelector('input[placeholder="请输入金额"]');
            return {
              subject: element.closest('.el-collapse-item').querySelector('.subject')?.textContent.trim(),
              content: element.querySelector('.name')?.textContent.trim() || '',
              limit: element.querySelector('.right-message')?.textContent.split('/').at(-1),
              editable: Boolean(input && !input.disabled && !input.readOnly),
            };
          });
          const rawAmount = (await amount.inputValue()).trim();
          const amountCny = rawAmount ? schoolMoneyCny(rawAmount) : 0;
          if (!row.subject || amountCny === null || await purpose.count() !== 1) throw new Error(`项目 ${projectNo} 的费用科目、金额或用途无法核对`);
          const category = JSON.stringify([row.subject, row.content]);
          const entry = { key: JSON.stringify([projectNo, quota, tabIndex, category, index]), projectNo, category,
            subject: row.subject, editable: row.editable, amountCny, limitCny: schoolMoneyCny(row.limit), purpose: (await purpose.inputValue()).trim() };
          rows.push(entry);
          if (visit) await visit(entry, amount, purpose);
        }
      }
      if (active >= 0 && active !== tabs.length - 1) await tabs[active].click();
    }
    const amountShown = async (selector, label) => schoolMoneyCny((await panel.locator(selector).innerText({ timeout: 3000 })).replace(label, '').replace(/[:：]/, ''));
    return { rows, availableCny: await amountShown('.total-money', '可分配报销金额'), remainingCny: await amountShown('.allocate-money', '待分配金额') };
  }

  async fillProjectDetails() {
    const projects = planProjects(this.plan);
    const filling = fillingId((await this.work()).url());
    const files = this.verifiedUploadFiles();
    const receipt = this.progress.uploads.at(-1)?.proof?.schoolReceipt;
    const invoicesMatched = this.plan.rows.every(({ invoiceNumber }) => this.progress.verifiedInvoiceNumbers?.includes(invoiceNumber));
    const uploaded = files.length === this.plan.uploadFiles.length && (receipt && this.uploadReceiptMatches(receipt, files) || invoicesMatched && this.plan.uploadFiles.every(({ name }) => files.includes(name)));
    if (!filling || this.progress.fillingId && this.progress.fillingId !== filling || await browserTargetId(this.page) !== this.progress.uploadPageId ||
        !this.progress.ownedDocument || !uploaded) {
      throw new Error('无法将学校项目明细与本次已上传的发票对应，请保留当前报销单');
    }
    this.progress.fillingId = filling;
    await this.assertDocumentIdentity();
    this.log('按项目填写经费分配', 'running', projects.map(({ projectNo, amountCny }) => `${projectNo} ${cny(amountCny)} 元`).join('、'));
    const panel = await this.sectionRoot('报销支出费用明细');
    await panel.locator('.project-box:visible .project-name').nth(projects.length - 1).waitFor({ state: 'visible', timeout: 30000 }).catch(() => {
      throw new Error('学校费用明细暂未显示全部已选项目，请核对当前报销单');
    });
    const readAmounts = async () => {
      const snapshot = await this.projectDetailSnapshot(projects);
      if (!snapshot.rows.length || ![this.plan.invoiceTotalCny, this.plan.totalCny].includes(snapshot.availableCny)) throw new Error('学校的可分配金额与本笔发票或核定金额不一致');
      return snapshot;
    };
    let before = await readAmounts();
    let expected = this.progress.projectExpenseAmounts;
    if (!expected) {
      let type = this.progress.projectExpenseType || this.plan.expenseType;
      const amounts = () => fundingDetailAmounts(projects, before.rows, this.plan.totalCny, before.availableCny, type);
      try { expected = amounts(); }
      catch (error) {
        if (error.code !== 'PROJECT_EXPENSE_TYPE_REQUIRED') throw error;
        const choices = projectExpenseChoices(projects, before.rows).map((label, index) => ({ value: String(index + 1), label }));
        if (!choices.length) throw Object.assign(new Error('无法从学校页面核对各科目金额。请先在原单上核对科目及分配，再回复「继续」。', { cause: error }), { code: error.code });
        const answer = await this.ask('请选择本笔报销在各项目中共用的费用科目。执行器会按清单分配金额。', {
          kind: 'project_expense_type', required: true, choices,
        });
        type = choices.find(({ value }) => value === answer)?.label;
        if (!type) throw new Error('尚未选定本笔费用科目');
        await this.guard();
        await this.assertDocumentIdentity();
        before = await readAmounts();
        expected = amounts();
        this.progress.projectExpenseType = type;
      }
    }
    if (expected.length !== before.rows.length || expected.some((row, index) => row.key !== before.rows[index].key) ||
        projects.some((project) => expected.filter((row) => row.projectNo === project.projectNo).reduce((sum, row) => sum + row.amountCny, 0) !== project.amountCny)) {
      throw new Error('学校费用明细布局或分配已变化，请保留当前报销单');
    }
    const amountByRow = new Map(expected.map(({ key, amountCny }) => [key, amountCny]));
    const subjects = new Set(before.rows.filter(({ key }) => amountByRow.get(key) > 0).map(({ subject }) => subject));
    this.log('核对项目费用科目', 'running', [...subjects].join('、'));
    this.progress.projectExpenseAmounts = expected;
    this.progress.detailVerified = false;
    await this.saveProgress();
    const setAmount = async (field, cents) => {
      await field.fill(cny(cents));
      await field.press('Tab');
      if (schoolMoneyCny(await field.inputValue()) !== cents) throw new Error('学校未接受该项目的分配金额，请核对可用额度');
    };
    if (before.rows.some((row) => row.amountCny > amountByRow.get(row.key))) {
      await this.projectDetailSnapshot(projects, async (row, amount) => {
        const wanted = amountByRow.get(row.key);
        if (wanted === undefined) throw new Error('学校费用明细在分配过程中发生变化');
        if (row.amountCny > wanted) await setAmount(amount, wanted);
      });
    }
    if (before.rows.some((row) => row.amountCny !== amountByRow.get(row.key) || row.amountCny > 0 && row.purpose !== this.plan.reason)) {
      await this.projectDetailSnapshot(projects, async (row, amount, purpose) => {
        const wanted = amountByRow.get(row.key);
        if (wanted === undefined) throw new Error('学校费用明细在分配过程中发生变化');
        if (row.amountCny !== wanted) await setAmount(amount, wanted);
        if (wanted > 0 && row.purpose !== this.plan.reason) {
          await purpose.fill(this.plan.reason);
          await purpose.press('Tab');
        }
      });
    }
    const after = await this.projectDetailSnapshot(projects);
    if (after.availableCny !== before.availableCny || after.remainingCny !== after.availableCny - this.plan.totalCny || after.rows.length !== expected.length ||
        after.rows.some((row, index) => row.key !== expected[index].key || row.amountCny !== expected[index].amountCny || row.amountCny > 0 && row.purpose !== this.plan.reason)) {
      throw new Error('学校各项目的分配金额或用途与本笔报销不一致');
    }
    this.progress.detailVerified = true;
    await this.saveProgress();
  }

  async expenseDialogRoot() {
    const scope = await this.work();
    const dialog = scope.locator('.el-dialog:visible, [role="dialog"]:visible').filter({ hasText: '明细费用类型' }).last();
    return await dialog.count() ? dialog : scope.locator('body');
  }

  async dumpExpenseDialog(root) {
    try {
      const html = await root.evaluate((element) => element.outerHTML.slice(0, 30000));
      await writeFile(join(this.appDir, '.runtime', 'debug-expense-dialog.html'), html, { mode: 0o600 });
    } catch {}
  }

  async expenseDialogRows() {
    try {
      const root = await this.expenseDialogRoot();
      return await root.evaluate((element) => {
        const containers = new Set();
        for (const radio of element.querySelectorAll('input[type="radio"]')) {
          const container = radio.closest('.nextClick-body') || radio.closest('tr') || radio.closest('.el-form-item') || radio.closest('li');
          if (container) containers.add(container);
        }
        return [...containers].map((item) => item.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
      });
    } catch {
      return [];
    }
  }

  async expenseDialogSelectionsComplete() {
    const root = await this.expenseDialogRoot();
    return root.evaluate((element) => {
      if (!element.matches('.el-dialog, [role="dialog"]')) return false;
      const groups = new Map();
      for (const radio of element.querySelectorAll('input[type="radio"]:enabled')) {
        const label = radio.closest('label') || radio;
        if (!label.getClientRects().length || getComputedStyle(label).visibility !== 'visible') continue;
        const group = radio.closest('.el-radio-group, [role="radiogroup"], .nextClick-body, tr, .el-form-item, li') || radio.name || element;
        groups.set(group, Boolean(groups.get(group) || radio.checked || label.getAttribute('aria-checked') === 'true'));
      }
      return groups.size > 0 && [...groups.values()].every(Boolean);
    });
  }

  async applyExpenseTypes() {
    const defaultType = this.plan.expenseType;
    const rules = this.plan.expenseTypeRules || [];
    const root = await this.expenseDialogRoot();
    await this.dumpExpenseDialog(root);
    const applied = await root.evaluate((element, { defaultType, rules }) => {
      const pick = (scope, type) => {
        const label = [...scope.querySelectorAll('label.el-radio')].find((item) => item.textContent.trim() === type);
        if (label) { label.click(); return true; }
        if (type === '设备') {
          const radio = scope.querySelector('input[type="radio"][value="160112"]');
          if (radio) { radio.click(); return true; }
        }
        return false;
      };
      const containers = new Set();
      for (const radio of element.querySelectorAll('input[type="radio"]')) {
        const container = radio.closest('.nextClick-body') || radio.closest('tr') || radio.closest('.el-form-item') || radio.closest('li');
        if (container) containers.add(container);
      }
      const rows = [...containers];
      if (!rows.length) return { rowCount: 0, ok: pick(element, defaultType), details: [] };
      const details = rows.map((row) => {
        const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
        const rule = rules.find((item) => item.keyword && text.includes(item.keyword));
        const type = rule ? rule.type : defaultType;
        return { text: text.slice(0, 30), type, ok: pick(row, type) };
      });
      return { rowCount: rows.length, ok: details.every((item) => item.ok), details };
    }, { defaultType, rules });
    if (applied.rowCount === 0) {
      if (defaultType === '设备') {
        await (await this.work()).locator('input[type="radio"][value="160112"]').evaluateAll((nodes) => {
          for (const node of nodes) node.click();
        });
      } else {
        await (await this.work()).locator('label.el-radio').evaluateAll((nodes, type) => {
          for (const node of nodes.filter((item) => item.textContent.trim() === type)) node.click();
        }, defaultType);
      }
      this.log('费用类型整单选择', 'running', defaultType);
      return;
    }
    this.log('费用类型逐行选择', 'running', applied.details.map((item) => `${item.text}→${item.type}${item.ok ? '' : '（失败）'}`).join('；'));
    if (!applied.ok) throw new Error('部分明细行未能匹配费用类型选项，请人工在页面上确认');
  }

  async fillPayment() {
    this.log('填写支付信息');
    const scope = await this.work();
    if (this.progress.paymentVerified) {
      this.progress.paymentVerified = false;
      await this.saveProgress();
    }
    if (!(await this.bodyText()).includes(this.plan.paymentType)) {
      await scope.getByRole('button', { name: '添加支付类型', exact: true }).click();
      await scope.getByText(this.plan.paymentType, { exact: false }).first().click();
    }
    const { panel, amount } = await this.paymentField(scope, { editable: true });
    if (this.plan.totalCny === this.plan.invoiceTotalCny && this.plan.paidTotalCny === this.plan.totalCny) {
      const fillAll = panel.getByText('全部填入', { exact: true }).filter({ visible: true });
      if (await fillAll.count() === 1 && await fillAll.isEnabled()) await fillAll.click();
    }
    if (schoolMoneyCny(await amount.inputValue()) !== this.plan.totalCny) await amount.fill(cny(this.plan.totalCny));
    await amount.press('Tab');
    const deadline = Date.now() + PAYMENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await this.checkpoint();
      const text = await panel.innerText({ timeout: 1000 }).catch(() => '');
      const remaining = text.match(REMAINING_PAYMENT)?.[1] ??
        (await this.bodyText({ timeout: 1000 }).catch(() => '')).match(REMAINING_PAYMENT)?.[1];
      if (schoolMoneyCny(remaining) === 0 && schoolMoneyCny(await amount.inputValue({ timeout: 1000 }).catch(() => '')) === this.plan.totalCny) {
        await this.guard();
        await (await this.work()).getByRole('button', { name: '保存并下一步', exact: true }).click();
        const stage = await this.waitForPaymentAdvance();
        this.progress.paymentVerified = true;
        await this.saveProgress();
        return stage;
      }
      await this.page.waitForTimeout(250);
    }
    throw new Error('支付金额未生效，请核对本笔支付总额与待支付金额');
  }

  async waitForPaymentAdvance() {
    const deadline = Date.now() + (this.paymentAdvanceTimeoutMs ?? PAYMENT_TIMEOUT_MS);
    let remainingCny = null;
    while (Date.now() < deadline) {
      await this.checkpoint();
      const scope = await this.work();
      const text = await scope.locator('body').innerText({ timeout: 1000 }).catch(() => '');
      if (text.includes('确认提交报销单')) return 'confirm';
      if (text.includes('请选择线上审批加签人')) return 'signer';
      remainingCny = schoolMoneyCny(text.match(REMAINING_PAYMENT)?.[1]);
      await this.page.waitForTimeout(250);
    }
    const detail = Number.isSafeInteger(remainingCny) && remainingCny !== 0 ? `，学校仍显示待支付 ${cny(remainingCny)} 元` : '';
    throw new Error(`支付保存后未进入加签或提交确认${detail}。请核对原单的支付信息。`);
  }

  async paymentField(scope, { editable = false } = {}) {
    const panels = scope.locator('.part-box:visible').filter({
      has: scope.getByRole('button', { name: '添加支付类型', exact: true, includeHidden: true }),
    });
    const deadline = Date.now() + PAYMENT_TIMEOUT_MS;
    let multiple = false;
    while (Date.now() < deadline) {
      await this.checkpoint();
      const panelCount = await panels.count();
      const panel = panelCount === 1 ? panels : await claimSectionRoot(scope, '支付信息').catch((error) => {
        if (error.code !== 'SECTION_NOT_READY') throw error;
        return null;
      });
      multiple = panelCount > 1;
      if (panel) {
        const amount = panel.getByPlaceholder('请输入金额', { exact: true }).filter({ visible: true });
        const count = await amount.count();
        multiple = count > 1;
        if (count === 1 && (!editable || await amount.isEditable({ timeout: 500 }).catch(() => false))) return { panel, amount };
      }
      await this.page.waitForTimeout(250);
    }
    throw new Error(multiple ? '学校支付区显示多个金额框，无法核对本笔支付金额' : '学校支付金额栏尚未就绪，请保留原单后重试');
  }

  async addSigner() {
    if (!this.plan.signer) {
      const answer = await this.ask('科研口尚未配置默认加签人，请回复加签人姓名和工号。', { kind: 'signer', required: true });
      const employeeNo = answer.match(/\d{3,10}/)?.[0];
      const name = answer.replace(employeeNo || '', '').trim();
      if (!employeeNo || !name) throw new Error('未提供有效加签人');
      this.plan.signer = { name, employeeNo };
    }
    this.log('添加加签人');
    await this.waitText('请选择线上审批加签人', 60000);
    const scope = await this.work();
    const visibleDialogs = () => scope.locator('.el-dialog:visible');
    const outerDialog = () => visibleDialogs().filter({ hasText: '线上审批' }).last();
    const innerDialog = () => visibleDialogs().filter({ hasText: '查询' }).last();
    const confirmButton = (dialogScope) => dialogScope.getByRole('button', { name: /^确\s*认$/ }).first();
    const current = await outerDialog().innerText();
    if (signerShown(current, this.plan.signer) && !(await innerDialog().count())) return outerDialog();
    if (!(await innerDialog().count())) await scope.getByText('加签人', { exact: true }).first().click();
    const dialog = innerDialog();
    const nameInput = dialog.getByPlaceholder('请输入姓名');
    const queryButton = dialog.getByRole('button', { name: /^查\s*询$/ });
    const rows = dialog.locator('tbody tr:visible');
    const exactMatches = () => rows.evaluateAll((items, signer) => {
      const clean = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
      return items.flatMap((item, index) => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        const cells = Array.from(item.cells, (cell) => clean(cell.innerText));
        if (!checkbox || !cells.includes(clean(signer.name)) ||
            signer.employeeNo && !cells.includes(clean(signer.employeeNo))) return [];
        return [{ index, checked: checkbox.checked }];
      });
    }, this.plan.signer);
    const waitLoadingDone = async () => {
      const mask = dialog.locator('.el-loading-mask').first();
      await mask.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
      await mask.waitFor({ state: 'hidden', timeout: 20000 }).catch(() => undefined);
    };
    let matches = [];
    const deadline = Date.now() + 40000;
    for (let attempt = 1; attempt <= 3 && !matches.length && Date.now() < deadline; attempt += 1) {
      await nameInput.fill(this.plan.signer.name);
      await queryButton.click();
      await waitLoadingDone();
      const until = Math.min(Date.now() + 8000, deadline);
      while (!matches.length && Date.now() < until) {
        matches = await exactMatches();
        if (!matches.length) await this.page.waitForTimeout(500);
      }
      if (!matches.length && attempt < 3 && Date.now() < deadline) this.log('加签人查询结果未加载到目标行，重新查询', 'warning', `第 ${attempt} 次`);
    }
    if (matches.length !== 1) {
      const notice = matches.length > 1
        ? `学校查到多位「${this.plan.signer.name}」。`
        : `学校未查到与「${this.plan.signer.name}」完全一致的员工。`;
      await this.ask(notice + '请在学校查询窗口只勾选正确的一位，再回复「继续」。', { kind: 'signer_pick', required: true });
    } else {
      const match = matches[0];
      if (!match.checked) await rows.nth(match.index).locator('input[type="checkbox"]').evaluate((element) => element.click());
    }
    const checked = await rows.locator('input[type="checkbox"]:checked').count();
    if (checked !== 1 || !(await exactMatches()).some((match) => match.checked)) throw new Error('请核对学校页面上勾选的加签人姓名和工号');
    await confirmButton(dialog).click();
    await dialog.waitFor({ state: 'hidden', timeout: 30000 });
    const selected = await outerDialog().innerText();
    if (!signerShown(selected, this.plan.signer)) throw new Error('加签人选择未通过核对');
    return outerDialog();
  }

  async verifyConfirmation(signerDialog = null) {
    await this.guard();
    const text = await this.bodyText();
    const signerText = signerDialog ? await signerDialog.innerText() : text;
    let reasonMatches = text.includes(this.plan.reason);
    if (this.plan.didi) {
      validateDidiInvoiceDates(this.plan.rows);
      validateDidiSelection(this.plan, this.getSubmittedInvoices());
      if (this.progress.didiWallet?.state !== 'verified' || !this.plan.rows.length) throw new Error('尚未核对本笔滴滴票据，不能提交');
    }
    if (this.plan.travel) {
      const scope = await this.work();
      await this.verifyTravelProjectDetails({ recheck: true });
      const { amount } = await this.paymentField(scope);
      if (schoolMoneyCny(await amount.inputValue()) !== this.plan.totalCny) throw new Error('提交前差旅支付金额与核定总额不一致');
    }
    if (this.plan.projectAllocationDraft) {
      await this.verifyProjectConfirmation(signerDialog);
      reasonMatches = true;
    } else if (this.progress.schoolDetailPurpose) {
      const detail = await this.detailAmountSnapshot();
      if (!await this.verifyGroupedDetail(detail, { recheck: true })) throw new Error('金额核验失败：提交前学校科目合并明细的金额或分配已变化，请核对原单');
      reasonMatches = true;
    } else if (!reasonMatches) {
      const scope = await this.work();
      if (signerDialog || preReviewFinanceId(scope.url()) || this.progress.fillingId && fillingId(scope.url()) === this.progress.fillingId) {
        const purposes = await scope.locator('input[placeholder="请输入用途"]:visible').evaluateAll((fields) => fields.map((field) => field.value.trim()));
        reasonMatches = purposes.length > 0 && purposes.every((purpose) => purpose === this.plan.reason);
      }
    }
    if (!reasonMatches || !text.includes(this.plan.project.projectNo) || !signerShown(signerText, this.plan.signer)) throw new Error('提交前页面的事由、项目或加签人未与计划一致');
    if (!this.plan.projectAllocationDraft && !this.plan.travel) {
      const amounts = [...text.matchAll(/(?:报销金额|报销总金额|报销合计|合计金额)[：:\s]*[¥￥]?\s*([\d,]+\.\d{2})/g)].map((match) => Math.round(Number(match[1].replaceAll(',', '')) * 100));
      if (!amounts.length || amounts.some((amount) => amount !== this.plan.totalCny)) throw new Error('提交前报销金额与计划不一致或无法读取');
    }
    await this.assertDocumentIdentity(text);
    if (!this.progress.paymentVerified || !this.progress.detailVerified) throw new Error('当前草稿缺少本批费用分配或支付金额的核验记录，请核对当前单据');
    return text;
  }

  async verifyProjectConfirmation(signerDialog) {
    const projects = planProjects(this.plan);
    const panel = await this.sectionRoot('报销支出费用明细');
    const boxes = await this.projectDetailBoxes(panel, projects);
    const rowSignatures = (rows) => rows.map((row) => JSON.stringify(row)).sort().join('\n');
    const describeRows = (rows) => rows.map(([category, amount]) =>
      `${JSON.parse(category).filter(Boolean).join(' / ') || '未识别科目'} ${cny(amount)} 元`).join('、');
    for (const project of projects) {
      const box = boxes.get(project.projectNo);
      const observed = await box.locator(':scope > .money-use').innerText({ timeout: 3000 });
      const total = schoolMoneyCny(observed.match(/报销金额\s*([\d,]+\.\d{2})/)?.[1]);
      const rows = await box.locator('.el-collapse-item .detail').evaluateAll((elements) => elements.map((row) => ({
        category: JSON.stringify([
          row.closest('.el-collapse-item').querySelector('.subject')?.textContent.trim() || '',
          row.querySelector('.name')?.textContent.trim() || '',
        ]),
        amount: row.querySelector('input[placeholder="请输入金额"]')?.value.trim(),
        purpose: row.querySelector('input[placeholder="请输入用途"]')?.value.trim(),
      })));
      const amounts = rows.map((row) => row.amount === '' ? 0 : schoolMoneyCny(row.amount));
      if (total !== project.amountCny || amounts.some((amount, index) => amount === null || amount > 0 && rows[index].purpose !== this.plan.reason) ||
          amounts.reduce((sum, amount) => sum + amount, 0) !== project.amountCny) throw new Error(`提交前项目 ${project.projectNo} 的金额或用途与分配不一致`);
      const expected = this.progress.projectExpenseAmounts?.filter(({ projectNo, amountCny }) => projectNo === project.projectNo && amountCny > 0)
        .map(({ key, amountCny }) => [JSON.parse(key)[3], amountCny]);
      if (!expected?.length) throw new Error(`提交前缺少项目 ${project.projectNo} 的原单费用科目核验记录`);
      const current = rows.flatMap(({ category }, index) => amounts[index] > 0 ? [[category, amounts[index]]] : []);
      if (rowSignatures(expected) !== rowSignatures(current)) {
        throw new Error(`提交前项目 ${project.projectNo} 的费用科目或分配不一致，应为 ${describeRows(expected)}，当前为 ${describeRows(current)}`);
      }
    }
    const scope = await this.work();
    const { amount: payment } = await this.paymentField(scope);
    if (schoolMoneyCny(await payment.inputValue()) !== this.plan.totalCny) throw new Error('提交前支付金额与核定报销额不一致');
    if (signerDialog) return;
    const dialog = scope.locator('.el-dialog:visible').filter({ hasText: '确认提交报销单' });
    const shown = await dialog.locator('.expenseShow-max').filter({ has: scope.getByText('费用明细', { exact: true }) }).locator('.expenseShow-box').evaluateAll((boxes) => boxes.map((box) => {
      const fields = [...box.querySelectorAll('.expenseShow-flex')];
      const field = (name) => fields.find((row) => row.firstElementChild?.textContent.trim() === name)?.lastElementChild?.textContent.trim();
      return { projectName: field('项目'), amount: field('支出金额') };
    }));
    const totals = new Map();
    for (const project of projects) totals.set(project.projectName, (totals.get(project.projectName) || 0) + project.amountCny);
    for (const { projectName, amount } of shown) {
      const cents = schoolMoneyCny(amount);
      if (!totals.has(projectName) || !cents) throw new Error('学校提交确认中的经费项目或金额无法核对');
      totals.set(projectName, totals.get(projectName) - cents);
    }
    if ([...totals.values()].some((amount) => amount !== 0)) throw new Error('学校提交确认中的分配金额与计划不一致');
  }

  async schoolSubmissionReceipt() {
    const targets = this.page.frames().filter((frame) => URL.canParse(frame.url()) && new URL(frame.url()).pathname === '/ClaimsPublicPCWeb/expenseAccountInquiry');
    const visible = [];
    for (const target of targets) {
      const element = await target.frameElement().catch(() => null);
      if (!target.parentFrame() || await element?.isVisible().catch(() => false)) visible.push(target);
    }
    if (visible.length !== 1) return null;
    const frame = visible[0];
    const code = new URL(frame.url()).searchParams.get('code');
    if (!/^[A-Za-z0-9-]{6,40}$/.test(code || '') || code === this.control.previousFinanceFormId) return null;
    if (this.progress.preReviewFinanceFormId && code !== this.progress.preReviewFinanceFormId) return null;
    const text = await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    const result = text.match(/您的报销单[^\S\r\n]*[：:][^\S\r\n]*([A-Za-z0-9-]{6,40})\s*\n\s*(已处理完成|已提交预审|预审通过|已提交审批|审批中)(?=\s|$)/);
    if (result) return result[1] === code ? { financeFormId: code, receipt: result[2] } : null;
    if (!this.progress.signerVerified || !text.includes('报销单查询')) return null;
    const receipt = await frame.locator('.el-table:visible').evaluateAll((tables, expected) => {
      const projectsMatch = (text) => {
        if (expected.projects.length === 1) return expected.projects[0].includes(text);
        const remaining = [...expected.projects];
        let value = text;
        while (remaining.length && value) {
          const candidates = remaining.flatMap((labels, index) => labels.filter((label) => value === label || value.startsWith(label) && /^[,，、;；\s]/.test(value.slice(label.length))).map((label) => ({ label, index })));
          candidates.sort((left, right) => right.label.length - left.label.length);
          if (!candidates.length) return false;
          const { label, index } = candidates[0];
          remaining.splice(index, 1);
          value = value.slice(label.length).replace(/^[,，、;；\s]+/, '');
        }
        return remaining.length === 0 && !value;
      };
      const required = ['报销单号', '状态', '经费项目', '报销/借款事由', '支付金额', ...(expected.didi ? [] : ['报销/借款金额'])];
      const matches = [];
      for (const table of tables) {
        const headers = [...table.querySelectorAll('thead th')].map((cell) => cell.innerText.trim());
        const indexes = required.map((label) => headers.indexOf(label));
        if (indexes.includes(-1)) continue;
        for (const row of table.querySelectorAll('tbody tr')) {
          if (!row.getClientRects().length) continue;
          const cells = [...row.cells].map((cell) => cell.innerText.trim());
          const [number, status, project, reason, payment, amount] = indexes.map((index) => cells[index]);
          if (number !== expected.code || reason !== expected.reason || !project || !projectsMatch(project)) continue;
          const amounts = expected.didi ? [payment] : [payment, amount];
          if (!amounts.every((value) => value?.replace(/[¥￥,]/g, '').trim() === expected.amount)) continue;
          if (/^(审批中|审批通过|已提交审批|已处理完成|处理完成|已提交预审|预审通过)$/.test(status || '') ||
              expected.acceptBooked && /^(提交|已提交|已制单)$/.test(status || '')) matches.push(status);
        }
      }
      return matches.length === 1 ? matches[0] : null;
    }, {
      code,
      didi: Boolean(this.plan.didi),
      acceptBooked: Boolean(this.plan.didi || this.plan.travel),
      reason: this.plan.reason,
      projects: planProjects(this.plan).map(({ projectNo, projectName }) => [projectNo, `${projectNo}-${projectName}`, ...(this.plan.projectAllocationDraft || this.plan.didi ? [projectName] : [])]),
      amount: cny(this.plan.totalCny),
    });
    return receipt ? { financeFormId: code, receipt } : null;
  }

  async recordSchoolSubmission(receipt) {
    this.progress.submission = { ...this.progress.submission, ...receipt, state: 'verified', fingerprint: this.plan.fingerprint, verifiedAt: new Date().toISOString() };
    await this.saveProgress();
    this.log('学校已回传单号', 'completed', `${receipt.financeFormId} · ${receipt.receipt}`);
    return 'submitted';
  }

  schoolConfirmation(scope) {
    return scope.locator('.el-dialog:visible').filter({ hasText: '确认提交报销单' });
  }

  preReviewFollowup(scope) {
    return scope.locator('.el-dialog:visible:not([data-rbx-prior-submit]), .el-message-box:visible:not([data-rbx-prior-submit])')
      .filter({
        hasText: /(?:是否|确认|确定)\s*(?:(?:要|确认|确定|继续)\s*){0,2}提交/,
        has: scope.getByRole('button', { name: PRE_REVIEW_CONFIRM_BUTTON }),
        hasNot: scope.getByRole('button', { name: '提交预审', exact: true, includeHidden: true }),
      });
  }

  async submitPreReview(scope, confirmation = scope) {
    await this.guard();
    if (this.control.skipSubmit) throw new Error('用户要求不再提交');
    if (this.plan.didi) validateDidiInvoiceDates(this.plan.rows);
    await this.preReviewFollowup(scope).evaluateAll((dialogs) => dialogs.forEach((dialog) => dialog.setAttribute('data-rbx-prior-submit', '1')));
    this.progress.submission.state = 'attempted';
    // Earlier submit_pre_review checkpoints covered both submission clicks.
    this.progress.submission.action = 'request_pre_review';
    await this.saveProgress();
    await this.checkpoint();
    if (this.control.skipSubmit) throw new Error('用户要求不再提交');
    if (this.plan.didi) validateDidiInvoiceDates(this.plan.rows);
    this.log('提交预审');
    await confirmation.getByRole('button', { name: '提交预审', exact: true }).click();
    this.log('等待学校提交结果', 'running', '检查后续确认窗口或学校回执');
  }

  async requireSubmissionVerification(error = null) {
    if (error) this.log('提交结果需要核实', 'warning', error.message);
    this.progress.submission.state = 'verification_required';
    await this.saveProgress();
    this.log('提交结果待核实', 'waiting', '学校尚未返回可核对的回执');
    return 'verification_required';
  }

  async waitForSubmission(scope, { before = '', schoolFilling, resumed = false }) {
    const timeout = this.submissionTimeoutMs ?? (schoolFilling ? 180000 : 30000);
    let deadline = Date.now() + (resumed ? Math.min(timeout, 3000) : timeout);
    const onOriginalDraft = () => !schoolFilling ||
      Boolean(this.progress.fillingId && fillingId(scope.url()) === this.progress.fillingId ||
        this.progress.preReviewFinanceFormId && preReviewFinanceId(scope.url()) === this.progress.preReviewFinanceFormId);
    try {
      while (Date.now() < deadline && !this.control.cancelled) {
        if (this.progress.uploadPageId) {
          const schoolReceipt = await this.schoolSubmissionReceipt().catch(() => null);
          if (schoolReceipt) return this.recordSchoolSubmission(schoolReceipt);
        }
        const text = await scope.locator('body').innerText({ timeout: 1000 }).catch(() => '');
        const notices = await scope.locator('.el-message:visible:not([data-rbx-prior-notice]), .el-notification:visible:not([data-rbx-prior-notice]), [role="status"]:visible:not([data-rbx-prior-notice])').allInnerTexts().catch(() => []);
        if (submissionFailed(text) || notices.some(submissionFailed)) {
          this.log('学校提示提交失败', 'warning', '请查看原报销标签上的学校提示');
          break;
        }
        const receipt = notices.find(submissionSucceeded);
        const ownSuccessPage = submissionSucceeded(text) && !submissionSucceeded(before) && text.includes(this.plan.reason) && (this.progress.submission.documentId ? text.includes(this.progress.submission.documentId) : text.includes(cny(this.plan.totalCny)));
        if (!schoolFilling && (receipt || ownSuccessPage)) {
          this.progress.submission = { ...this.progress.submission, state: 'verified', receipt: receipt || '当前单据显示提交成功', verifiedAt: new Date().toISOString() };
          await this.saveProgress();
          return 'submitted';
        }
        const { action } = this.progress.submission;
        const previewCode = preReviewFinanceId(scope.url());
        if (action === 'confirm_signer' && (onOriginalDraft() || previewCode && previewCode !== this.control.previousFinanceFormId &&
            this.progress.fillingId && !this.progress.preReviewFinanceFormId && this.progress.uploadPageId === await browserTargetId(this.page))) {
          const confirmation = this.schoolConfirmation(scope);
          const button = confirmation.getByRole('button', { name: '提交预审', exact: true });
          if (await confirmation.count() === 1 && await button.count() === 1 && await button.isEnabled()) {
            await this.verifyConfirmation();
            if (this.control.skipSubmit) {
              this.progress.submission = { state: 'not_started' };
              await this.saveProgress();
              return 'preview';
            }
            if (previewCode) this.progress.preReviewFinanceFormId = previewCode;
            await this.submitPreReview(scope, confirmation);
            deadline = Date.now() + timeout;
          }
        } else if (action === 'request_pre_review' && onOriginalDraft()) {
          const dialog = this.preReviewFollowup(scope);
          const button = dialog.getByRole('button', { name: PRE_REVIEW_CONFIRM_BUTTON });
          if (await dialog.count() === 1 && await button.count() === 1 && await button.isEnabled()) {
            await this.guard();
            if (this.control.skipSubmit || !onOriginalDraft()) break;
            if (schoolFilling) await this.assertDocumentIdentity();
            this.progress.submission.state = 'attempted';
            this.progress.submission.action = 'confirm_pre_review';
            await this.saveProgress();
            await this.checkpoint();
            if (this.control.skipSubmit || !onOriginalDraft()) break;
            if (this.plan.didi) validateDidiInvoiceDates(this.plan.rows);
            this.log('确认提交预审');
            await button.click();
            this.log('等待学校回执', 'running', '收到单号和学校状态后自动登记');
            deadline = Date.now() + timeout;
          }
        }
        await this.page.waitForTimeout(250);
      }
    } catch (error) { return this.requireSubmissionVerification(error); }
    return this.requireSubmissionVerification();
  }

  async confirmAndFinish(signerDialog = null) {
    if (this.progress.submission.state !== 'not_started') return 'verification_required';
    if (!signerDialog) await this.waitText('确认提交报销单', 60000);
    const before = await this.verifyConfirmation(signerDialog);
    if (this.control.skipSubmit) return 'preview';
    const schoolPurpose = this.progress.schoolDetailPurpose;
    if (!this.control.autoSubmit || schoolPurpose) {
      const reminders = this.plan.warnings?.length ? `\n核对提醒\n${this.plan.warnings.map((warning) => `• ${warning}`).join('\n')}` : '';
      const projects = planProjects(this.plan).map(({ projectNo, amountCny }) => `${projectNo} ${cny(amountCny)} 元`).join('、');
      const detailPurpose = schoolPurpose ? `\n学校费用明细的用途栏有字数限制，实际显示「${schoolPurpose}」。请核对这段用途。` : '';
      const answer = await this.ask(`请核对本笔报销：${this.plan.reason}，金额 ${cny(this.plan.totalCny)} 元，项目 ${projects}，发票 ${this.plan.rows.length} 张，附件 ${this.plan.uploadFiles.length} 个，加签人 ${this.plan.signer.name} ${this.plan.signer.employeeNo || ''}。${detailPurpose}${reminders}\n回复“确认提交”才会提交预审。`, { kind: 'final_approval', required: true });
      if (answer.replace(/\s/g, '') !== '确认提交' || this.control.skipSubmit) return 'preview';
      const approved = await this.verifyConfirmation(signerDialog);
      if (approved !== before) throw new Error('提交前页面已变化，原确认已失效，请重新核对');
    }
    await this.guard();
    const scope = await this.work();
    const schoolFillingId = fillingId(scope.url());
    const previewCode = preReviewFinanceId(scope.url());
    if (previewCode && (previewCode === this.control.previousFinanceFormId ||
        this.progress.preReviewFinanceFormId && previewCode !== this.progress.preReviewFinanceFormId)) {
      throw new Error('学校确认页的报销单号与本笔原单不一致');
    }
    if (previewCode) this.progress.preReviewFinanceFormId = previewCode;
    const schoolFilling = Boolean(schoolFillingId || previewCode);
    if (schoolFilling && this.progress.uploadPageId) this.progress.fillingId = schoolFillingId;
    const waitAfterSigner = Boolean(signerDialog && schoolFilling);
    await scope.locator('.el-message, .el-notification, [role="status"]').evaluateAll((nodes) => nodes.forEach((node) => node.setAttribute('data-rbx-prior-notice', '1')));
    this.progress.signerVerified = true;
    this.progress.submission = {
      state: signerDialog ? 'attempted' : 'not_started', action: signerDialog ? 'confirm_signer' : undefined,
      at: new Date().toISOString(), fingerprint: this.plan.fingerprint, documentId: documentId(before),
    };
    if (signerDialog) await this.saveProgress();
    try {
      await this.checkpoint();
      if (this.control.skipSubmit) throw new Error('用户要求不再提交');
      if (signerDialog) {
        if (this.plan.didi) validateDidiInvoiceDates(this.plan.rows);
        this.log('确认加签人');
        await signerDialog.getByRole('button', { name: /^确\s*认$/ }).first().click();
      }
      if (waitAfterSigner) {
        this.log('等待学校确认结果', 'running', '检查最终确认窗口或学校回执');
      } else {
        if (signerDialog) {
          await this.waitText('确认提交报销单', 60000);
          await this.verifyConfirmation();
        }
        await this.submitPreReview(scope, schoolFilling ? this.schoolConfirmation(scope) : scope);
      }
    } catch (error) {
      if (this.progress.submission.state === 'not_started') throw error;
      return this.requireSubmissionVerification(error);
    }
    return this.waitForSubmission(scope, { before, schoolFilling });
  }

  async detectStage() {
    if (this.plan.travel && DOMESTIC_TRAVEL_PAGE.test((await this.work({ bind: false })).url())) return 'travel_form';
    const text = await this.bodyText({ bind: false });
    if (text.includes('请选择线上审批加签人')) return 'signer';
    if (text.includes('确认提交报销单')) return 'confirm';
    if (text.includes('报销支出费用明细')) return 'detail_payment';
    if (text.includes('单据填报-') || text.includes('请确认明细费用类型')) return 'form';
    if (text.includes('经费预算信息')) return 'start';
    if (!text.includes('财务服务平台') && (text.includes('日常报销') || /国内差旅|差旅报销/.test(text) || text.includes('贸大出行'))) return 'claimtype';
    return 'unknown';
  }

  async run() {
    const pendingSubmission = this.progress.submission.state !== 'not_started';
    if (pendingSubmission && (!this.resumeStages || !this.progress.uploadPageId)) return 'verification_required';
    await this.guard();
    if (!this.resumeStages && !this.plan.didi && Number.isSafeInteger(this.plan.totalCny)) {
      this.log('本机发票和付款金额核对通过', 'running', `核定 ${cny(this.plan.totalCny)} 元 · 学校费用分配待回读`);
    }
    await this.openPlatform();
    await this.guard();
    if (this.resumeStages && this.progress.uploadPageId &&
        (pendingSubmission && this.progress.submission.fingerprint === this.plan.fingerprint ||
          this.progress.ownedDocument && this.progress.fillingId && this.progress.detailVerified && this.progress.paymentVerified && this.progress.signerVerified)) {
      const receipt = await this.schoolSubmissionReceipt();
      if (receipt) return this.recordSchoolSubmission(receipt);
    }
    if (pendingSubmission) {
      const { state, fingerprint } = this.progress.submission;
      if (!['attempted', 'verification_required'].includes(state) || fingerprint !== this.plan.fingerprint) return 'verification_required';
      return this.waitForSubmission(await this.work(), { schoolFilling: true, resumed: true });
    }
    if (this.plan.didi) validateDidiInvoiceDates(this.plan.rows);
    let stage = this.resumeStages ? await this.detectStage() : 'unknown';
    const pendingUpload = this.progress.uploads.find((operation) => operation.state === 'started');
    if (pendingUpload && (!this.resumeStages || !this.progress.uploadPageId || !['start', 'form'].includes(stage))) return 'verification_required';
    if (stage === 'unknown') {
      if (this.resumeStages && this.progress.ownedDocument) throw new Error('无法确认原报销单所处阶段，请保留当前页面');
      await this.openClaim();
      stage = await this.detectStage();
    }
    this.log('识别页面所处阶段', 'running', stage);
    if (stage === 'unknown') throw new Error('无法确认当前报销页面，不会重复建单');
    if (pendingUpload && stage === 'start') {
      const { table } = await this.budgetSection();
      const selected = await projectRows(table);
      const expected = planProjects(this.plan);
      const sameProjects = selected.length === expected.length && expected.every(({ projectNo }) => selected.some((item) => item.projectNo === projectNo));
      if (!sameProjects || !await this.verifyUploadOperation(pendingUpload, await this.uploadSnapshot())) return 'verification_required';
    }
    let originalUpload = false;
    if (this.resumeStages && stage === 'form' && this.progress.uploadPageId && (!this.progress.documentId || pendingUpload) && !this.plan.didi) {
      const text = await this.bodyText();
      const receipt = readUploadReceipt(text);
      const files = [...this.verifiedUploadFiles(), ...(pendingUpload?.files || [])];
      originalUpload = planProjects(this.plan).every(({ projectNo }) => text.includes(projectNo)) &&
        files.length === this.plan.uploadFiles.length && this.uploadReceiptMatches(receipt, files);
      if (!originalUpload) throw new Error('无法确认原单经费项目和上传回执，请保留当前单据核对');
      if (pendingUpload) await this.verifyUploadOperation(pendingUpload, receipt);
      this.progress.ownedDocument = true;
      this.log('已核对原单上传回执', 'running', `${receipt.invoiceCount} 张发票，${receipt.attachmentCount} 张附件`);
      await this.saveProgress();
    }
    const didiCategory = this.plan.didi && stage === 'claimtype' && this.progress.didiWallet?.state === 'verified';
    if ((this.resumeStages && !['start', 'detail_payment'].includes(stage) && !originalUpload && !didiCategory) ||
        this.progress.documentId || this.progress.fillingId) {
      await this.assertDocumentIdentity();
    }
    if (this.plan.didi && stage !== 'start' && this.progress.didiWallet?.state !== 'verified') return 'verification_required';
    let paymentStage;
    const steps = [
      ['start', async () => {
        await this.addProject();
        if (this.plan.travel) await this.addTravelApplication(false);
        if (this.plan.didi) await this.addDidiTickets();
        else await this.uploadAll();
      }],
      ['claimtype', () => this.selectClaimType()],
      ['form', () => this.fillForm()],
      ...(this.plan.travel ? [['travel_form', () => this.fillTravelForm()]] : []),
      ['detail_payment', async () => {
        if (this.plan.travel) await this.verifyTravelProjectDetails();
        else if (this.plan.projectAllocationDraft) await this.fillProjectDetails();
        else await this.verifyDetailAmounts();
        paymentStage = await this.fillPayment();
      }],
    ];
    const index = ['signer', 'confirm'].includes(stage) ? steps.length : steps.findIndex(([name]) => name === stage);
    for (let cursor = index; cursor < steps.length; cursor += 1) {
      await this.guard();
      this.stage = steps[cursor][0];
      await steps[cursor][1]();
    }
    this.stage = paymentStage || (stage === 'confirm' ? 'confirm' : 'signer');
    await this.guard();
    return this.confirmAndFinish(this.stage === 'signer' ? await this.addSigner() : null);
  }
}
