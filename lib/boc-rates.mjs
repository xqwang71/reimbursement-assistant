import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bankCurrencyName } from './foreign-money.mjs';

export const BOC_HISTORY = 'https://www.boc.cn/sourcedb/whpjSearch/index.html';
export const BOC_CURRENT = 'https://www.boc.cn/sourcedb/whpj/';
import { browserExecutable } from './platform.mjs';
const ratePattern = /^\d+(?:\.\d{1,8})?$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const rateDir = (appDir) => join(appDir, '.runtime', 'boc-rates');
export const quoteKey = (date, currency) => /^20\d\d-\d\d-\d\d$/.test(date) && bankCurrencyName(currency) ? `${date}-${currency}` : null;

export async function readBocQuote(appDir, date, currency) {
  const key = quoteKey(date, currency);
  if (!key) return null;
  try {
    const record = JSON.parse(await readFile(join(rateDir(appDir), `${key}.json`), 'utf8'));
    if (record.date !== date || record.currency !== currency || record.column !== '中行折算价' || !ratePattern.test(record.ratePer100) || Number(record.ratePer100) <= 0 ||
        !record.quotedAt?.startsWith(date) || ![BOC_HISTORY, BOC_CURRENT].includes(record.sourceUrl)) return null;
    const name = `中国银行外汇牌价-${key}.png`;
    const absolutePath = join(rateDir(appDir), name);
    if (digest(await readFile(absolutePath)) !== record.sha256) return null;
    return { ...record, key, name, absolutePath };
  } catch { return null; }
}

export function officialQuote({ currencyName, date, highlight = false }) {
  const candidates = [];
  for (const table of document.querySelectorAll('table')) {
    const headers = [...(table.querySelector('tr')?.cells || [])].map((cell) => cell.textContent.trim());
    const currencyIndex = headers.indexOf('货币名称');
    const rateIndex = headers.indexOf('中行折算价');
    const timeIndex = headers.indexOf('发布时间');
    const dateIndex = headers.indexOf('发布日期');
    if ([currencyIndex, rateIndex, timeIndex].includes(-1)) continue;
    for (const row of table.rows) {
      const cells = [...row.cells];
      if (!row.getClientRects().length || cells[currencyIndex]?.textContent.trim() !== currencyName) continue;
      const stamp = `${cells[dateIndex]?.textContent.trim() || ''} ${cells[timeIndex]?.textContent.trim() || ''}`;
      const parsed = stamp.match(/(20\d\d)[-\/.](\d{1,2})[-\/.](\d{1,2}).*?(\d{2}:\d{2}:\d{2})/);
      if (!parsed || `${parsed[1]}-${parsed[2].padStart(2, '0')}-${parsed[3].padStart(2, '0')}` !== date) continue;
      const ratePer100 = cells[rateIndex]?.textContent.trim();
      if (!/^\d+(?:\.\d{1,8})?$/.test(ratePer100) || Number(ratePer100) <= 0) continue;
      candidates.push({ ratePer100, quotedAt: `${date} ${parsed[4]}`, cell: cells[rateIndex] });
    }
  }
  candidates.sort((left, right) => right.quotedAt.localeCompare(left.quotedAt));
  const chosen = candidates[0];
  if (!chosen || candidates.some((item) => item.quotedAt === chosen.quotedAt && item.ratePer100 !== chosen.ratePer100)) return null;
  if (highlight) chosen.cell.style.boxShadow = 'inset 0 0 0 3px #ad1733';
  return { ratePer100: chosen.ratePer100, quotedAt: chosen.quotedAt };
}

async function capturePage(date, currency, sourceUrl) {
  const { chromium } = await import('playwright');
  const history = sourceUrl === BOC_HISTORY;
  const browser = await chromium.launch({ executablePath: browserExecutable(), headless: !history });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 940 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const response = await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!response?.ok() || new URL(page.url()).origin !== new URL(sourceUrl).origin) throw new Error('中国银行牌价页面暂时无法打开');
    const args = { date, currencyName: bankCurrencyName(currency) };
    if (history) {
      await page.locator('#searchTime').fill(date);
      await page.locator('#pjname').selectOption({ value: args.currencyName });
      await page.locator('#searchbtn').click();
      const noQuote = page.locator('.resTable tbody').getByText(/暂无数据|系统繁忙|对不起，请选择/).first();
      const result = await Promise.race([
        page.waitForFunction(officialQuote, args, { timeout: 120000 }).then(() => 'quoted'),
        noQuote.waitFor({ timeout: 120000 }).then(() => 'unavailable'),
      ]).catch(() => 'pending');
      if (result === 'unavailable') throw new Error(`中国银行查询未返回可用牌价。${await noQuote.innerText()}`);
      if (result === 'pending') throw new Error('中行未返回该币种当天的牌价。请完成银行验证后重试，或核对付款日期和币种。');
    }
    if (new URL(page.url()).origin !== new URL(sourceUrl).origin) throw new Error('查询页面已离开中国银行网站');
    const quote = await page.evaluate(officialQuote, { ...args, highlight: true });
    if (!quote) return null;
    const screenshot = await page.screenshot({ fullPage: true, timeout: 12000 });
    const after = await page.evaluate(officialQuote, args);
    if (quote.ratePer100 !== after?.ratePer100 || quote.quotedAt !== after?.quotedAt) throw new Error('截图时中行报价刷新，请重试');
    return { quote: { ...quote, date, currency, sourceUrl, column: '中行折算价', sha256: digest(screenshot) }, screenshot };
  } finally { await browser.close().catch(() => undefined); }
}

let activeCapture = false;
export async function captureBocQuote(appDir, date, currency) {
  const key = quoteKey(date, currency);
  if (!key) throw new Error('中国银行历史牌价未提供该币种或日期不完整');
  const existing = await readBocQuote(appDir, date, currency);
  if (existing) return existing;
  if (activeCapture) throw new Error('已有一笔中行牌价正在查询，请先完成该次查询');
  activeCapture = true;
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format();
    const current = date === today ? await capturePage(date, currency, BOC_CURRENT).catch(() => null) : null;
    const result = current || await capturePage(date, currency, BOC_HISTORY);
    if (!result) throw new Error('中国银行未显示付款当天的中行折算价');
    const dir = rateDir(appDir);
    const name = `中国银行外汇牌价-${key}.png`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, randomUUID());
    try {
      await writeFile(`${temporary}.png`, result.screenshot, { mode: 0o600 });
      await writeFile(`${temporary}.json`, JSON.stringify(result.quote), { mode: 0o600 });
      await rename(`${temporary}.png`, join(dir, name));
      await rename(`${temporary}.json`, join(dir, `${key}.json`));
    } finally {
      await Promise.all([rm(`${temporary}.png`, { force: true }), rm(`${temporary}.json`, { force: true })]);
    }
    return { ...result.quote, key, name, absolutePath: join(dir, name) };
  } finally { activeCapture = false; }
}
