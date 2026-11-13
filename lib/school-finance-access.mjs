import { setTimeout as delay } from 'node:timers/promises';
import { schoolReportUrl, waitForSchoolAccess } from './school-report-browser.mjs';

const portalHost = 'aws.suibe.edu.cn';
const financeHost = 'cwc.suibe.edu.cn';
const routes = {
  legacy: { entry: '财务系统', path: /^\/SFP_Claims1Self(?:\/|$)/ },
  labor: { entry: '薪酬申报', path: /^\/SFP_SalarySelf\/SalaryDeclareManagement(?:\/|$)/ },
};

function address(value) {
  try { return new URL(value); } catch { return new URL('about:blank'); }
}

export function schoolFinanceLink(scope, name) {
  return scope.getByRole('link', { name, exact: true }).filter({ visible: true });
}

export async function activateSchoolControl(control, message, timeout = 7000) {
  await control.waitFor({ state: 'visible', timeout }).catch(() => { throw new Error(message); });
  if (await control.count() !== 1 || !await control.isEnabled()) throw new Error(message);
  await control.evaluate((element) => element.click());
}

async function financeFrame(pages, route, signal, milliseconds) {
  const deadline = Date.now() + milliseconds;
  do {
    signal.throwIfAborted();
    for (const page of pages) {
      if (page.isClosed()) continue;
      for (const frame of page.frames()) {
        const url = address(frame.url());
        if (url.hostname !== financeHost || !route.path.test(url.pathname)) continue;
        let visible = true;
        for (let candidate = frame; candidate.parentFrame(); candidate = candidate.parentFrame()) {
          const owner = await candidate.frameElement().catch(() => null);
          if (!owner || !await owner.isVisible().catch(() => false)) { visible = false; break; }
        }
        if (visible) return frame;
      }
    }
    await delay(220, undefined, { signal });
  } while (Date.now() < deadline);
  return null;
}

async function openFinance(page, kind, route, signal, onAccess = () => {}, waitForAccess = false) {
  let access = '';
  const accessOptions = () => ({
    signal: waitForAccess ? signal : AbortSignal.any([signal, AbortSignal.timeout(18000)]),
    onState(state) { access = state; onAccess(state); },
  });
  const failure = () => {
    const host = address(page.url()).hostname;
    if (access === 'waiting_login' || host === 'authserver.suibe.edu.cn') {
      return { status: 'waiting_login', message: '请在运行学校财务系统的电脑上完成学校统一身份认证。' };
    }
    if (host === portalHost && access === 'running') {
      return { status: 'entry_timeout', message: '一网通办已打开，学校财务页面仍在跳转。请稍后再核对入口。' };
    }
    return { status: 'waiting_network', message: '学校财务系统暂未连通。请在运行学校财务系统的电脑上登录 aTrust。' };
  };
  const url = schoolReportUrl(kind);
  const current = address(page.url());
  const sameFinance = current.hostname === financeHost && (kind === 'labor' ? route.path.test(current.pathname) : !current.pathname.startsWith('/SFP_SalarySelf/'));
  const keepCurrent = sameFinance || [portalHost, 'authserver.suibe.edu.cn'].includes(current.hostname);
  try { await waitForSchoolAccess(page, url, kind, { ...accessOptions(), keepCurrent }); }
  catch { return failure(); }

  if (address(page.url()).hostname === portalHost) {
    const entry = schoolFinanceLink(page, route.entry);
    await entry.waitFor({ state: 'visible', timeout: 8000 }).catch(() => { throw new Error('一网通办未显示学校财务入口。'); });
    if (await entry.count() !== 1) throw new Error('一网通办未找到唯一的学校财务入口。');
    const href = await entry.evaluate((element) => element.href);
    const target = address(href);
    if (target.protocol !== 'https:' || target.hostname !== portalHost || target.pathname !== '/r/or') {
      throw new Error('学校财务入口链接已变化，请核对一网通办。');
    }
    await page.goto(href, { waitUntil: 'commit', timeout: 14000 }).catch(() => undefined);
    const arrived = await page.waitForURL((destination) => destination.hostname === financeHost || destination.hostname === 'authserver.suibe.edu.cn',
      { waitUntil: 'commit', timeout: 24000 }).then(() => true).catch(() => false);
    if (!arrived) return failure();
    try { await waitForSchoolAccess(page, href, kind, { ...accessOptions(), keepCurrent: true }); }
    catch { return failure(); }
  }
  if (address(page.url()).hostname !== financeHost) return failure();
  return null;
}

export async function openSchoolFinanceWorkspace(page, { kind, signal, onAccess, waitForAccess }) {
  if (!Object.hasOwn(routes, kind)) throw new Error('请选择日常线下报销或薪酬申报。');
  const route = routes[kind];
  const blocked = await openFinance(page, kind, route, signal, onAccess, waitForAccess);
  if (blocked) return blocked;
  const pages = [page];
  const track = (popup) => pages.push(popup);
  page.on('popup', track);
  async function close(closePages = true) {
    page.off('popup', track);
    if (closePages) await Promise.all(pages.slice(1).map((popup) => popup.close().catch(() => undefined)));
  }
  try {
    let frame = await financeFrame(pages, route, signal, kind === 'legacy' ? 3200 : 8500);
    if (!frame && kind === 'legacy') {
      await activateSchoolControl(schoolFinanceLink(page, '网上预约报销'), '学校财务系统未显示「网上预约报销」。');
      frame = await financeFrame(pages, route, signal, 14500);
    }
    if (!frame) throw new Error('学校财务系统已打开，暂未找到对应的填报页面。');
    return { frame, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function openDailyBookingForm(frame) {
  await activateSchoolControl(schoolFinanceLink(frame, '其他事项报销'), '网上预约报销未显示「其他事项报销」。');
  await frame.locator('#txt_Remark:visible').waitFor({ state: 'visible', timeout: 12000 })
    .catch(() => { throw new Error('「其他事项报销」已打开，报销事由字段未确认。'); });
}

export async function openPayrollHeader(frame, category) {
  const categoryLink = schoolFinanceLink(frame, category).and(frame.locator('a.linkTab'));
  await activateSchoolControl(categoryLink, `学校薪酬申报未找到「${category}」。`);
  const declare = frame.getByText('薪资申报', { exact: true }).filter({ visible: true });
  if (await declare.count() === 1) await activateSchoolControl(declare, '学校薪资申报页面暂不可用。');
  await activateSchoolControl(schoolFinanceLink(frame, '创建'), '薪资申报未找到「创建」。');
  const header = frame.locator('#txt_GrantContent:visible');
  await header.waitFor({ state: 'visible', timeout: 10000 })
    .catch(() => { throw new Error('学校薪酬申报已打开，空白申报抬头未确认。'); });
  return header;
}

export async function checkSchoolFinancePage(page, { kind, signal }) {
  const workspace = await openSchoolFinanceWorkspace(page, { kind, signal });
  if (!workspace.frame) return workspace;
  const { frame } = workspace;
  try {
    if (kind === 'legacy') {
      await openDailyBookingForm(frame);
      for (const name of ['添加经费项目', '上传附件信息', '保存并提交']) {
        if (await schoolFinanceLink(frame, name).count() !== 1) throw new Error('学校的其他事项报销表单已变化，请重新核对。');
      }
      return { status: 'form_verified', message: '已核对「其他事项报销」空白表单，可见报销事由、经费项目、附件和保存并提交。' };
    }

    const payroll = frame.locator('a.linkTab:visible');
    await payroll.first().waitFor({ state: 'visible', timeout: 7500 })
      .catch(() => { throw new Error('学校薪酬申报未显示可用的薪资套类。'); });
    const categories = [...new Set((await payroll.allTextContents()).map((label) => label.trim())
      .filter((label) => /劳务费|工资/.test(label) && !/教育发展基金会|工会|学生基金会/.test(label)))];
    if (!categories.includes('校外人员劳务费')) {
      return { status: 'page_verified', categories, message: '已打开学校薪酬申报。校外人员劳务费的空白抬头待核对。' };
    }
    await openPayrollHeader(frame, '校外人员劳务费');
    return {
      status: 'form_verified', categories,
      message: '已核对校外人员劳务费的空白申报抬头。学校按经费项目带出发放部门。',
    };
  } finally {
    await workspace.close();
  }
}
