import { claimSectionRoot, clickSectionAdd } from './portal-navigation.mjs';
import { schoolMoneyCny } from './funding-detail.mjs';

const WALLET_TIMEOUT_MS = 25000;

export function didiWallet(scope) {
  return scope.getByRole('dialog', { name: '选择发票', exact: true }).filter({ visible: true });
}

export async function openDidiWallet(scope) {
  const wallet = didiWallet(scope);
  const fromWallet = scope.getByText('从票夹选择', { exact: true }).filter({ visible: true });
  if (!await wallet.count()) {
    if (!await fromWallet.count()) await clickSectionAdd(await claimSectionRoot(scope, '票据影像'), '票据影像');
    await fromWallet.click({ timeout: WALLET_TIMEOUT_MS });
  }
  await wallet.waitFor({ state: 'visible', timeout: WALLET_TIMEOUT_MS });
  const folder = wallet.locator('.floder-item').filter({ has: scope.getByText('滴滴平台', { exact: true }) });
  await folder.waitFor({ state: 'visible', timeout: WALLET_TIMEOUT_MS });
  if (!(await folder.getAttribute('class')).split(/\s+/).includes('active')) {
    await folder.locator('.floder-name').click({ timeout: WALLET_TIMEOUT_MS });
    await folder.and(wallet.locator('.floder-item.active')).waitFor({ state: 'visible', timeout: WALLET_TIMEOUT_MS });
  }
  return wallet;
}

async function walletCards(wallet) {
  return wallet.locator('.bill-list .list > .bill').evaluateAll((cards) => cards.map((card) => {
    const get = (label) => [...card.querySelectorAll('.label')].find((field) => field.textContent.trim() === label)?.nextElementSibling?.textContent.trim() || '';
    const input = card.querySelector('input[type="checkbox"]');
    return {
      invoiceNumber: get('发票号码'), amount: get('合计金额'), seller: get('销售方名称'), date: get('开票日期'),
      checked: Boolean(input?.checked), available: Boolean(input && !input.disabled),
    };
  }));
}

export async function readDidiWallet(wallet, page, checkpoint) {
  const list = wallet.locator('.bill-list');
  const more = wallet.getByRole('button', { name: '加载更多', exact: true });
  const busy = wallet.locator('.el-loading-mask:visible, [aria-busy="true"]:visible');
  const empty = list.getByText(/^(?:暂无(?:可用)?(?:数据|票据|发票)|没有(?:可用)?(?:票据|发票)|无(?:可用)?(?:票据|发票))$/);
  let requestedCount = -1;
  let stableCount = -1;
  let stableSince = 0;
  let deadline = Date.now() + WALLET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await checkpoint();
    if (!await list.count() || await busy.count()) { await page.waitForTimeout(250); continue; }
    const cards = await walletCards(wallet);
    const active = await wallet.locator('.floder-item.active').innerText({ timeout: 1000 });
    const folderCount = Number(active.match(/共\s*(\d+)\s*张票据/)?.[1]);
    if (Number.isFinite(folderCount) && folderCount === 0) return [];
    if (cards.length && !await more.count() && (!Number.isFinite(folderCount) || cards.length >= folderCount)) {
      if (stableCount !== cards.length) { stableCount = cards.length; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 500) {
        const available = cards.filter(({ available, seller }) => available && seller === '滴滴平台').map(({ amount, ...card }) => ({
          ...card, amountCny: schoolMoneyCny(amount.replace(/\s*元$/, '')),
        }));
        if (!available.length && cards.some(({ available }) => available)) throw new Error('学校票夹尚未加载出可核对的滴滴票据');
        if (available.some(({ date, amountCny, invoiceNumber }) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || amountCny === null || !/^(?:\d{16}|\d{20})$/.test(invoiceNumber))) {
          throw new Error('有可用的滴滴票据缺少可核对的票号、日期或金额');
        }
        return available;
      }
    } else if (cards.length && await more.isVisible() && await more.isEnabled() && requestedCount !== cards.length) {
      requestedCount = cards.length;
      await more.click({ timeout: WALLET_TIMEOUT_MS });
      deadline = Date.now() + WALLET_TIMEOUT_MS;
    } else if (!cards.length && await empty.count()) return [];
    await page.waitForTimeout(250);
  }
  throw new Error('学校滴滴票夹尚未加载完成，请保留原单后重试');
}

export async function chooseDidiWalletCards(scope, wallet, tickets) {
  const confirm = wallet.getByRole('button', { name: '确认', exact: true });
  const before = await walletCards(wallet);
  const selected = new Set(tickets.map(({ invoiceNumber }) => invoiceNumber));
  if (before.some(({ invoiceNumber, checked }) => checked && !selected.has(invoiceNumber))) throw new Error('票夹已有本事项以外的勾选，请保留原单核对');
  for (const { invoiceNumber, amountCny, date } of tickets) {
    const card = wallet.locator('.bill-list .list > .bill').filter({ has: scope.getByText(invoiceNumber, { exact: true }) });
    const input = card.locator('input[type="checkbox"]');
    const observed = before.find((item) => item.invoiceNumber === invoiceNumber);
    if (await card.count() !== 1 || !observed?.available || observed.seller !== '滴滴平台' || observed.date !== date ||
        schoolMoneyCny(observed.amount.replace(/\s*元$/, '')) !== amountCny) throw new Error('滴滴票夹的票号、日期、金额或可选状态已变化');
    if (!await input.isChecked()) await card.locator('label.el-checkbox').filter({ visible: true }).click({ timeout: 8000 });
    if (!await input.isChecked()) throw new Error('学校票夹未能选中预定的滴滴票据');
  }
  const after = (await walletCards(wallet)).filter(({ checked }) => checked);
  if (after.length !== tickets.length || after.some(({ invoiceNumber }) => !selected.has(invoiceNumber))) throw new Error('学校票夹实际勾选与计划不一致');
  const footer = await wallet.locator('.el-dialog__footer').innerText({ timeout: 4000 });
  const count = Number(footer.match(/已选影像数量\s*[:：]\s*(\d+)/)?.[1]);
  const total = schoolMoneyCny(footer.match(/合计金额\s*[:：]\s*([￥¥\s\d,.]+)/)?.[1]);
  if (count !== tickets.length || total !== tickets.reduce((sum, ticket) => sum + ticket.amountCny, 0)) {
    throw new Error('学校票夹的勾选张数或合计金额与计划不一致');
  }
  return confirm;
}

export async function observedDidiImages(panel) {
  const cards = await panel.locator('.theSecondStep-divFlex .bill-card').evaluateAll((nodes) => nodes.map((node) => ({
    order: [...node.querySelectorAll('*')].some((item) => item.children.length === 0 && item.textContent.trim() === '出行订单'),
    text: node.innerText,
  })));
  return cards.map(({ text, order }) => {
    const seller = text.match(/销方\s*[:：]\s*([^\r\n]+)/)?.[1]?.trim();
    const date = text.match(/日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})/)?.[1];
    const amount = text.split('\n').map((value) => value.trim()).find((line) => /^(?:[￥¥]\s*)?[\d,]+\.\d{2}(?:\s*元)?$/.test(line));
    return { order, seller, date, amountCny: amount ? schoolMoneyCny(amount.replace(/\s*元$/, '')) : null };
  });
}
