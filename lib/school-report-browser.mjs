import { join, win32 } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const SCHOOL_REPORTS = {
  smart: '智能报销系统', legacy: '学校财务系统 · 网上预约报销', labor: '学校财务系统 · 薪酬申报',
};

const DEFAULT_URLS = {
  smart: 'http://znbx.suibe.edu.cn:8000/microportalweb/#/main', legacy: 'https://aws.suibe.edu.cn/', labor: 'https://aws.suibe.edu.cn/',
};
const commands = 'button, a, input[type=button], input[type=submit], [role=button], [role=tab], .el-menu-item > span';
const queryLabel = /^\s*(?:查\s*询|检索|搜索)\s*$/;
const exportLabel = /^\s*(?:导\s*出(?:\s*Excel|查询结果|报销单|数据)?|Excel\s*导出|下载\s*Excel)\s*$/i;
const startDate = /开始日期|起始日期|开始时间|起始时间|起始预约时间|预约日期起|发放日期起|start(?:date|time)|begin(?:date|time)|(?:date|time)beg/i;
const endDate = /结束日期|截止日期|结束时间|截止时间|终止日期|预约日期止|发放日期止|end(?:date|time)|(?:date|time)end/i;

export function schoolReportUrl(kind, smartUrl = '') {
  return (kind === 'smart' ? smartUrl : kind === 'legacy' ? process.env.SUIBE_LEGACY_REIMBURSEMENT_URL : process.env.SUIBE_LABOR_REIMBURSEMENT_URL) || DEFAULT_URLS[kind];
}

function address(value) {
  try { return new URL(value); } catch { return new URL('about:blank'); }
}

function schoolHost(host, entry) {
  return host === address(entry).hostname || host.endsWith('.suibe.edu.cn');
}

async function until(find, signal, milliseconds = 12000) {
  const deadline = Date.now() + milliseconds;
  do {
    signal.throwIfAborted();
    const result = await find();
    if (result) return result;
    await delay(250, undefined, { signal });
  } while (Date.now() < deadline);
  return null;
}

async function inspectPage(page) {
  const url = address(page.url());
  const content = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '');
  const blocked = /该网站仅限于校内|请连接零信任|403 Forbidden|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED/.test(content);
  const login = url.hostname === 'authserver.suibe.edu.cn' || /\/login(?:\/page)?\/?$/i.test(url.pathname) && /登录|认证/.test(content);
  return { url, blocked, login };
}

export async function waitForSchoolAccess(page, url, kind, { signal, onState, keepCurrent = false }) {
  let navigate = !keepCurrent;
  for (;;) {
    signal.throwIfAborted();
    if (page.isClosed()) throw new Error('同步标签页已关闭，请重新同步。');
    let failed = false;
    if (navigate) {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null);
      failed = !response || response.status() >= 400;
      navigate = false;
    }
    const state = await inspectPage(page);
    if (state.login && !state.blocked && !failed) {
      onState('waiting_login', '请在同步浏览器中完成学校统一身份认证，登录后会自动继续。');
      await delay(1500, undefined, { signal });
      continue;
    }
    if (!failed && !state.blocked && schoolHost(state.url.hostname, url)) {
      onState('running', '已进入学校系统，正在打开查询。');
      return;
    }
    if (kind === 'smart') {
      onState('waiting_network', '智能报销系统暂时无法访问，正在等待连接恢复。');
    } else {
      onState('waiting_network', '等待学校财务系统网络。请在运行同步的电脑上登录 aTrust，连通后会自动继续。');
    }
    await delay(9000, undefined, { signal });
    navigate = true;
  }
}

async function visibleFrames(pages, entry) {
  const visible = [];
  for (const page of pages) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      if (!schoolHost(address(frame.url()).hostname, entry)) continue;
      const element = await frame.frameElement().catch(() => null);
      if (!frame.parentFrame() || await element?.isVisible().catch(() => false)) visible.push({ page, frame });
    }
  }
  return visible.reverse();
}

function action(scope, name) {
  const textual = scope.locator(commands).filter({ hasText: name, visible: true });
  const named = scope.getByRole('button', { name }).or(scope.getByRole('link', { name })).filter({ visible: true });
  return named.or(textual).first();
}

async function activate(control) {
  await control.waitFor({ state: 'visible', timeout: 9000 });
  if (!await control.isEnabled()) throw new Error('学校页面的查询或导出按钮当前不可用。');
  await control.evaluate((element) => element.click());
}

async function firstAction(pages, url, label) {
  for (const { page, frame } of await visibleFrames(pages, url)) {
    const control = action(frame, label);
    if (await control.count()) return { page, control };
  }
  return null;
}

async function reportFrame(pages, url, kind) {
  for (const candidate of await visibleFrames(pages, url)) {
    const { frame } = candidate;
    if (!await action(frame, exportLabel).count() || !await action(frame, queryLabel).count()) continue;
    if (kind === 'smart') {
      const target = address(frame.url());
      if (target.pathname === '/ClaimsPublicPCWeb/expenseAccountInquiry' && !target.searchParams.has('code')) return candidate;
    } else {
      if (kind === 'legacy' && await frame.locator('#dp_COQ_ReserveDateBeg').count()) return candidate;
      if (kind === 'labor' && await frame.locator('#dd_StratYear').count()) return candidate;
      const heading = kind === 'legacy' ? /报销单号|报销单查询/ : /薪资套类|劳务费|发放日期/;
      if (await frame.locator('body').innerText({ timeout: 1000 }).then((text) => heading.test(text)).catch(() => false)) return candidate;
    }
  }
  return null;
}

async function openFinanceFromPortal(pages, url, kind, { signal, onState }) {
  const label = kind === 'legacy' ? /^\s*财务系统\s*$/ : /^\s*薪酬申报\s*$/;
  for (;;) {
    const portal = await until(() => firstAction(pages, url, label), signal, 18000);
    if (!portal) throw new Error('一网通办未显示学校财务入口，请确认学校登录。');
    const before = new Set(pages);
    await portal.control.press('Enter', { timeout: 8000 });
    const linked = await until(() => pages.find((page) => !before.has(page) && !page.isClosed() && address(page.url()).hostname), signal, 12000);
    if (linked) {
      const transitDeadline = Date.now() + 10000;
      while (!linked.isClosed()) {
        const state = await inspectPage(linked);
        if (state.url.hostname === 'cwc.suibe.edu.cn' && !state.blocked) {
          onState('running', '已进入学校财务系统，正在打开查询。');
          return;
        }
        if (!state.blocked && state.url.hostname === 'aws.suibe.edu.cn' && Date.now() < transitDeadline) {
          await delay(400, undefined, { signal });
          continue;
        }
        if (!state.login || state.blocked) break;
        onState('waiting_login', '请在同步浏览器中完成学校统一身份认证，登录后会自动继续。');
        await delay(1500, undefined, { signal });
      }
      await linked.close().catch(() => undefined);
    }
    onState('waiting_network', '等待学校财务系统网络。请在同步电脑上登录 aTrust，连通后会自动继续。');
    await delay(9000, undefined, { signal });
  }
}

async function openReport(pages, url, kind, options) {
  const { signal } = options;
  const initial = await reportFrame(pages, url, kind);
  if (initial) return initial;
  if (kind === 'smart') {
    const title = /^\s*智能网报\s*5[.．]0\s*$/;
    const item = /^\s*我的报销单\s*$/;
    const start = await until(async () => {
      const found = await firstAction(pages, url, item);
      if (found) return found;
      const control = pages[0].locator('.el-submenu__title').filter({ hasText: title, visible: true }).first();
      return await control.count() ? { control, expand: true } : null;
    }, signal, 16000);
    if (!start && (await inspectPage(pages[0])).login) {
      await waitForSchoolAccess(pages[0], url, kind, { ...options, keepCurrent: true });
      return openReport(pages, url, kind, options);
    }
    if (!start) throw new Error('智能报销系统未找到「我的报销单」。');
    if (start.expand) await start.control.click({ timeout: 8000 });
    const entry = start.expand ? await until(() => firstAction(pages, url, item), signal) : start;
    if (!entry) throw new Error('智能报销系统未显示「我的报销单」。');
    await entry.control.click({ timeout: 8000 });
  } else {
    if (address(pages[0].url()).hostname === 'aws.suibe.edu.cn' && !pages.some((page) => !page.isClosed() && address(page.url()).hostname === 'cwc.suibe.edu.cn')) {
      await openFinanceFromPortal(pages, url, kind, options);
    }
    if (kind === 'legacy') {
      const booking = await until(() => firstAction(pages, url, /^\s*网上预约报销(?:系统)?\s*$/), signal, 4500);
      if (booking && !pages.some((page) => page.frames().some((frame) => address(frame.url()).pathname.startsWith('/SFP_Claims1Self')))) await activate(booking.control);
      const tab = await until(async () => {
        for (const { frame } of await visibleFrames(pages, url)) {
          const item = frame.locator('#OrderQuery').filter({ visible: true, hasText: '报销单查询' });
          if (await item.count() === 1) return item;
        }
        return null;
      }, signal, 10000);
      if (tab) await activate(tab);
    } else {
      const salary = await until(async () => {
        for (const candidate of await visibleFrames(pages, url)) {
          if (address(candidate.frame.url()).pathname.startsWith('/SFP_SalarySelf/') && await candidate.frame.locator('a.linkTab:visible').count()) return candidate;
        }
        return null;
      }, signal, 15000);
      if (salary) {
        const type = salary.frame.getByText('学生劳务费', { exact: true }).filter({ visible: true });
        if (await type.count() === 1 && !await type.evaluate((element) => element.classList.contains('linkTabOn'))) await activate(type);
        const statistics = salary.frame.getByText('申报查询统计', { exact: true }).filter({ visible: true });
        if (await statistics.count() === 1) await activate(statistics);
        const report = await until(() => reportFrame(pages, url, kind), signal, 18000);
        if (report) return report;
      }
    }
    const menu = kind === 'legacy' ? /^\s*报销单查询\s*$/ : /^\s*(?:申报查询统计|薪资套类汇总(?:查询)?|薪资汇总查询|发放明细查询)\s*$/;
    const entry = await until(async () => await reportFrame(pages, url, kind) || await firstAction(pages, url, menu), signal);
    if (entry?.frame) return entry;
    if (entry) await activate(entry.control);
  }
  const report = await until(() => reportFrame(pages, url, kind), signal, 16000);
  if (report) return report;
  throw new Error(`${SCHOOL_REPORTS[kind]}未找到可核验的查询与导出页面。`);
}

const dateDigits = (text) => text.match(/20\d\d|\d{1,2}/g)?.map((part) => part.padStart(2, '0')).join('-');

async function setSalaryPeriod(frame, year, signal) {
  const fields = ['#dd_StratYear', '#dd_EndYear', '#dd_StartMonth', '#dd_EndMonth'];
  const expected = [Number(year), Number(year), 1, 12];
  for (const [index, selector] of fields.entries()) {
    const requested = expected[index];
    const bound = index === 2 ? 'first' : index === 3 ? 'last' : '';
    const chosen = await until(() => frame.locator(selector).evaluate((element, { requested, bound }) => {
      const widget = window.jQuery?.(element).data('kendoDropDownList');
      if (!widget) return null;
      const values = Array.from(widget.dataSource.view(), (option) => String(option[widget.options.dataValueField]));
      const months = bound ? values.filter((option) => /^0?[1-9]$|^1[0-2]$/.test(option)).sort((a, b) => Number(a) - Number(b)) : [];
      const item = values.find((option) => Number(option) === requested) || (bound === 'first' ? months[0] : months.at(-1));
      if (!item) return null;
      if (Number(widget.value()) !== Number(item)) {
        widget.value(item);
        widget.trigger('change');
      }
      return Number(widget.value()) === Number(item) ? Number(item) : null;
    }, { requested, bound }, { timeout: 3500 }).catch(() => null), signal, 12000);
    if (!chosen) throw new Error(`薪酬申报无法确认 ${year} 年的发放期间。`);
    expected[index] = chosen;
  }
  const result = await frame.evaluate((fields) => fields.map((id) => Number(window.jQuery(document.querySelector(id)).data('kendoDropDownList')?.value())), fields);
  if (result.some((value, index) => value !== expected[index]) || expected[2] > expected[3]) throw new Error(`学校页面未确认 ${year} 年的发放期间。`);
  return { fromMonth: expected[2], throughMonth: expected[3] };
}

async function setYear(frame, year, signal) {
  if (await frame.locator('#dd_StratYear, #dd_EndYear, #dd_StartMonth, #dd_EndMonth').count() === 4) {
    return setSalaryPeriod(frame, year, signal);
  }
  const years = frame.locator('select:visible').filter({ has: frame.locator('option').filter({ hasText: new RegExp(`^\\s*${year}(?:年|年度)?\\s*$`) }) });
  if (await years.count() === 1) {
    const option = years.locator('option').filter({ hasText: new RegExp(`^\\s*${year}(?:年|年度)?\\s*$`) });
    const label = (await option.innerText()).trim();
    await years.selectOption({ label }, { timeout: 6000 });
    return { fromMonth: 1, throughMonth: 12 };
  }
  const fields = frame.locator('input:visible');
  const positions = await fields.evaluateAll((items, expressions) => items.flatMap((element, index) => {
    const label = [...(element.labels || [])].map((item) => item.innerText).join(' ');
    const value = [label, element.name, element.id, element.placeholder, element.title, element.getAttribute('aria-label')].join(' ');
    return expressions.flatMap((pattern, position) => new RegExp(pattern, 'i').test(value) ? [{ position, index }] : []);
  }), [startDate.source, endDate.source]);
  const start = positions.filter(({ position }) => position === 0);
  const end = positions.filter(({ position }) => position === 1);
  if (start.length !== 1 || end.length !== 1 || start[0].index === end[0].index) throw new Error('没有找到可核对的年度或日期范围，已保留当前执行表。');
  const first = fields.nth(start[0].index);
  const last = fields.nth(end[0].index);
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  await first.fill(from, { timeout: 7000 });
  await last.fill(to, { timeout: 7000 });
  await last.press('Tab');
  if (dateDigits(await first.inputValue()) !== from || dateDigits(await last.inputValue()) !== to) {
    throw new Error(`学校页面未确认 ${year} 年的起止日期，已保留当前执行表。`);
  }
  return { fromMonth: 1, throughMonth: 12 };
}

async function displayedTotal(frame) {
  const gridTotals = await frame.locator('.k-grid:visible').evaluateAll((grids) => grids.flatMap((grid) => {
    const total = window.jQuery?.(grid).data('kendoGrid')?.dataSource.total();
    return Number.isSafeInteger(total) ? [total] : [];
  })).catch(() => []);
  if (gridTotals.length === 1) return gridTotals[0];
  const pagination = await frame.locator('.el-pagination__total:visible, .el-pagination:visible, .pagination:visible, .k-pager-info:visible').allInnerTexts().catch(() => []);
  for (const text of pagination) {
    const value = text.match(/(?:共\s*([\d,]+)\s*(?:条|笔)|of\s+([\d,]+)\s+items)/i)?.slice(1).find(Boolean);
    if (value !== undefined) return Number(value.replaceAll(',', ''));
    if (/没有数据可显示|没有记录|No items to display/.test(text)) return 0;
  }
  return null;
}

async function queryYear(frame, year, signal) {
  const period = await setYear(frame, year, signal);
  const query = action(frame, queryLabel);
  const officialPayroll = address(frame.url()).hostname === 'cwc.suibe.edu.cn' && address(frame.url()).pathname.startsWith('/SFP_SalarySelf/');
  const response = officialPayroll ? frame.page().waitForResponse((result) =>
    address(result.url()).pathname === '/SFP_SalarySelf/SalaryLatorySummaryQuery/Act_GridRead', { timeout: 18000 }).catch(() => null) : null;
  await activate(query);
  if (response && !(await response)?.ok()) throw new Error('学校未返回本次薪酬查询结果，请稍后重新同步。');
  await delay(850, undefined, { signal });
  const ready = await until(async () => !await frame.locator('.el-loading-mask:visible').count() &&
    !await frame.locator('.k-grid:visible').evaluateAll((grids) => grids.some((grid) => window.jQuery?.(grid).data('kendoGrid')?.dataSource._requestInProgress === true)), signal, 30000);
  if (!ready) throw new Error('学校查询仍在加载，请稍后重新同步。');
  return { expectedCount: await displayedTotal(frame), ...period };
}

export async function captureSchoolDownload(page, directory, click, signal) {
  signal.throwIfAborted();
  const browser = page.context().browser();
  const session = await browser.newBrowserCDPSession();
  const target = await page.context().newCDPSession(page);
  const { frameTree } = await target.send('Page.getFrameTree');
  const { targetInfo } = await target.send('Target.getTargetInfo');
  await target.detach();
  const context = targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {};
  const frameIds = new Set();
  function collect(tree) {
    frameIds.add(tree.frame.id);
    for (const child of tree.childFrames || []) collect(child);
  }
  collect(frameTree);
  let timer;
  let cancel;
  let started;
  try {
    await session.send('Browser.setDownloadBehavior', { ...context, behavior: 'allow', downloadPath: directory, eventsEnabled: true });
    signal.throwIfAborted();
    const completion = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('学校没有返回完整的 Excel 下载。')), 45000);
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      session.on('Browser.downloadWillBegin', (event) => { if (frameIds.has(event.frameId)) started = event; });
      session.on('Browser.downloadProgress', (event) => {
        if (event.guid !== started?.guid) return;
        if (event.state === 'completed') {
          const suggestedFilename = win32.basename(started.suggestedFilename || '学校执行表');
          resolve({ downloadPath: event.filePath || join(directory, suggestedFilename), filePath: event.filePath, guid: event.guid, suggestedFilename });
        }
        if (event.state === 'canceled') reject(new Error('学校 Excel 下载已取消。'));
      });
    });
    const [, result] = await Promise.all([click(), completion]);
    return result;
  } finally {
    clearTimeout(timer);
    if (cancel) signal.removeEventListener('abort', cancel);
    await session.send('Browser.setDownloadBehavior', { ...context, behavior: 'default', eventsEnabled: false }).catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}

async function laborTypes(frame) {
  const excluded = /教育发展基金会|工会|学生基金会/;
  const tabs = frame.locator('a.linkTab:visible');
  const labels = [...new Set((await tabs.allInnerTexts()).map((text) => text.trim()).filter((text) => text && !excluded.test(text) && !['薪资申报', '申报查询统计'].includes(text)))];
  if (labels.length) return { types: labels.map((label) => ({ label })), tabs };
  const selects = frame.locator('select:visible');
  const groups = await selects.evaluateAll((items, excluded) => items.flatMap((select, index) => {
    const labels = [...select.options].filter((item) => !item.disabled && item.value && !new RegExp(excluded).test(item.textContent));
    const options = labels.some((item) => /劳务费/.test(item.textContent)) ? labels.map((item) => ({ label: item.textContent.trim(), value: item.value })) : [];
    return options.length ? [{ index, options }] : [];
  }), excluded.source);
  if (groups.length !== 1) throw new Error('薪酬申报未找到唯一的劳务费套类选择框。');
  return { select: selects.nth(groups[0].index), types: groups[0].options };
}

export async function downloadSchoolReports({ page, url, kind, year, directory, signal, onState, save, onFileError, onReport, capture = captureSchoolDownload, keepCurrent = false }) {
  const pages = [page];
  const track = (popup) => { pages.push(popup); popup.on('popup', track); };
  page.on('popup', track);
  const options = { signal, onState, keepCurrent };
  try {
    await waitForSchoolAccess(page, url, kind, options);
    const report = await openReport(pages, url, kind, options);
    if (kind === 'smart') {
      const showCancelled = report.frame.getByRole('checkbox', { name: /显示作废单据/ }).filter({ visible: true });
      if (await showCancelled.count() === 1) await showCancelled.check({ timeout: 6000 }).catch(() => undefined);
    }
    const labor = kind === 'labor' ? await laborTypes(report.frame) : null;
    for (const type of labor?.types || [null]) {
      signal.throwIfAborted();
      try {
        onState('running', `正在查询 ${year} 年${type ? `「${type.label}」` : '报销单'}。`);
        if (type && labor.tabs) {
          const tab = report.frame.getByRole('link', { name: type.label, exact: true }).filter({ visible: true });
          if (await tab.count() !== 1) throw new Error('无法确认薪酬套类。');
          if (!await tab.evaluate((element) => element.classList.contains('linkTabOn'))) await activate(tab);
          if (!await until(() => tab.evaluate((element) => element.classList.contains('linkTabOn')).catch(() => false), signal, 8000)) throw new Error('学校页面未切换到指定套类。');
          if (!await action(report.frame, exportLabel).count()) await activate(report.frame.getByText('申报查询统计', { exact: true }).filter({ visible: true }).first());
          if (!await until(() => reportFrame(pages, url, kind), signal, 10000)) throw new Error('未显示该套类的查询统计。');
        } else if (type) await labor.select.selectOption(type.value, { timeout: 8000 });
        const query = await queryYear(report.frame, year, signal);
        const { expectedCount } = query;
        if (expectedCount === 0) {
          await save({ ...query, category: type?.label, skipped: true });
          continue;
        }
        onState('running', `正在下载${type ? `「${type.label}」` : '学校执行表'}。`);
        const reportDirectory = await mkdtemp(join(directory, 'report-'));
        const artifact = await capture(report.page, reportDirectory, () => activate(action(report.frame, exportLabel)), signal);
        await save({ ...artifact, ...query, category: type?.label });
      } catch (error) {
        signal.throwIfAborted();
        if (!type || !onFileError) throw error;
        onFileError(type.label, error);
      }
    }
    await onReport?.(report.frame);
  } finally {
    page.off('popup', track);
    await Promise.all(pages.slice(1).map((popup) => popup.close().catch(() => undefined)));
  }
}
