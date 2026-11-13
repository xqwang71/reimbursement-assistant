const SMART_TITLE = /^\s*智能网报\s*5[.．]0\s*$/;
const CLAIM_TITLE = /^\s*我要报销\s*$/;
export const CAMPUS_LOGIN_REQUIRED = 'CAMPUS_LOGIN_REQUIRED';

export function isCampusLogin(url) {
  return new URL(url).hostname === 'authserver.suibe.edu.cn';
}

export function campusLoginError(message = '请在报销专用 Chrome 完成学校登录，再发送「继续」。') {
  return Object.assign(new Error(message), { code: CAMPUS_LOGIN_REQUIRED });
}

export function claimEntryError(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: 'CLAIM_ENTRY' });
}

export async function claimSectionRoot(scope, label) {
  if (label === '票据影像') {
    const title = scope.locator('.fast-reimbursement-cardHead').filter({ hasText: /^\s*票据影像/ });
    const panel = scope.locator('.fast-reimbursement-divBottom:visible').filter({ has: title });
    const matches = await panel.count();
    if (matches === 1) return panel;
    if (matches > 1) throw new Error('无法定位唯一的“票据影像”区域，请核对当前单据');
  }
  if (label === '报销支出费用明细') {
    const title = scope.locator('.fast-reimbursement-cardHead').getByText(label, { exact: true });
    const panel = scope.locator('.part-box:visible').filter({ has: title });
    if (await panel.count() === 1) return panel;
  }
  for (const heading of await scope.getByText(label, { exact: true }).all()) {
    if (!await heading.isVisible()) continue;
    let section = heading.locator('xpath=ancestor::*[self::section or self::fieldset or @role="region" or contains(concat(" ",normalize-space(@class)," ")," el-card ") or contains(concat(" ",normalize-space(@class)," ")," panel ")][1]');
    if (!await section.count()) section = heading.locator('xpath=ancestor::div[.//table or .//input or .//img or contains(.,"暂无票据") or contains(.,"未上传") or contains(.,"发票张数") or contains(.,"发票数量")][1]');
    if (!await section.count()) continue;
    const text = await section.innerText();
    if (['经费预算信息', '业务单信息', '票据影像', '报销支出费用明细', '支付信息'].some((other) => other !== label && text.includes(other))) continue;
    return section;
  }
  throw Object.assign(new Error(`无法定位独立的“${label}”区域，请核对页面，不能使用其他区域代替`), { code: 'SECTION_NOT_READY' });
}

export async function claimBudgetSection(scope) {
  const title = scope.locator('.fast-reimbursement-cardHead').getByText('经费预算信息', { exact: true });
  const toolbar = scope.locator('.fast-reimbursement-cardFlex:visible').filter({ has: title });
  const matches = await toolbar.count();
  if (!matches) {
    const section = await claimSectionRoot(scope, '经费预算信息');
    return { toolbar: section, table: section };
  }
  const table = toolbar.locator('xpath=following-sibling::*[1][contains(concat(" ",normalize-space(@class)," ")," fast-reimbursement-table ")]').filter({ visible: true });
  if (matches !== 1 || await table.count() !== 1) throw Object.assign(new Error('无法定位“经费预算信息”对应的项目表，请核对当前单据'), { code: 'SECTION_NOT_READY' });
  return { toolbar, table };
}

export async function clickSectionAdd(region, name) {
  const button = region.locator('button:visible').filter({ hasText: /^\s*添\s*加\s*$/ });
  if (await button.count() !== 1) throw new Error(`无法定位“${name}”区域唯一的“添加”按钮`);
  await button.click({ timeout: 8000 });
}

export async function clickClaimEntry(page) {
  const title = page.locator('.el-submenu__title').filter({ hasText: SMART_TITLE, visible: true });
  const shortcut = page.locator('.my-app-item .menu-title').filter({ hasText: CLAIM_TITLE, visible: true });
  try {
    await Promise.race([
      title.or(shortcut).first().waitFor({ state: 'visible', timeout: 15000 }),
      page.waitForURL(isCampusLogin, { waitUntil: 'commit', timeout: 15000 }).then(() => { throw campusLoginError(); }),
    ]);
  } catch (error) {
    if (error.code === CAMPUS_LOGIN_REQUIRED || isCampusLogin(page.url())) throw campusLoginError();
    throw claimEntryError('未找到学校财务首页的“智能网报5.0”。请检查专用浏览器的校园网登录状态。', error);
  }
  if (await shortcut.count() === 1) {
    await clickEntryLabel(shortcut);
    return;
  }
  if (await title.count() !== 1) throw claimEntryError('学校页面上无法确定唯一的“智能网报5.0”菜单。');
  const menu = title.locator('xpath=..');
  const label = menu.locator('li.el-menu-item > span').filter({ hasText: CLAIM_TITLE, visible: true });
  try {
    if (!await label.count() && await menu.getAttribute('aria-expanded') !== 'true') {
      await title.click({ timeout: 8000 });
    }
    await label.first().waitFor({ state: 'visible', timeout: 8000 });
  } catch (error) {
    throw claimEntryError('学校的“我要报销”入口尚未显示。请保留当前报销标签后重试。', error);
  }
  if (await label.count() !== 1) throw claimEntryError('学校页面上有多个“我要报销”入口，无法确定当前入口。');
  await clickEntryLabel(label);
}

async function clickEntryLabel(label) {
  try { await label.click({ timeout: 8000 }); }
  catch (error) { throw claimEntryError('已找到“我要报销”，但当前无法点击。请查看专用浏览器中是否有弹窗遮挡。', error); }
}
