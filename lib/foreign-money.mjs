const currencyNames = {
  USD: '美元', EUR: '欧元', GBP: '英镑', JPY: '日元', HKD: '港币', AUD: '澳大利亚元', CAD: '加拿大元', SGD: '新加坡元', CHF: '瑞士法郎', NZD: '新西兰元',
  KRW: '韩国元', THB: '泰国铢', MOP: '澳门元', TWD: '新台币', MYR: '林吉特', PHP: '菲律宾比索', IDR: '印尼卢比', VND: '越南盾', INR: '印度卢比',
  AED: '阿联酋迪拉姆', SAR: '沙特里亚尔', BRL: '巴西雷亚尔', MXN: '墨西哥比索', ZAR: '南非兰特', RUB: '卢布', TRY: '土耳其里拉',
  DKK: '丹麦克朗', NOK: '挪威克朗', SEK: '瑞典克朗', PLN: '波兰兹罗提', HUF: '匈牙利福林', CZK: '捷克克朗', KWD: '科威特第纳尔', QAR: '卡塔尔里亚尔',
  BND: '文莱元', MNT: '蒙古图格里克', NPR: '尼泊尔卢比', ILS: '以色列谢克尔', PKR: '巴基斯坦卢比', KHR: '柬埔寨瑞尔', RSD: '塞尔维亚第纳尔', KZT: '哈萨克斯坦坚戈', RON: '罗马尼亚列伊', ZMW: '赞比亚克瓦查', MUR: '毛里求斯卢比',
};
export const bankCurrencyName = (currency) => Object.hasOwn(currencyNames, currency) ? currencyNames[currency] : null;
const tokens = new Map(Object.entries(currencyNames).map(([code, name]) => [name, code]));
for (const [name, code] of Object.entries({ 人民币: 'CNY', 元: 'CNY', RMB: 'CNY', 港元: 'HKD', 加元: 'CAD', 澳元: 'AUD', 韩元: 'KRW', 'US$': 'USD', 'HK$': 'HKD', 'CA$': 'CAD', 'A$': 'AUD', 'S$': 'SGD', 'NZ$': 'NZD', '€': 'EUR', '£': 'GBP', '¥': 'CNY', '$': '$' })) tokens.set(name, code);
const codes = new Set(Intl.supportedValuesOf('currency'));
const dollarCurrencies = new Set(['USD', 'HKD', 'CAD', 'AUD', 'NZD', 'SGD', 'TWD']);
export const isDollarCurrency = (code) => dollarCurrencies.has(code);
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const marker = `${[...tokens.keys()].sort((left, right) => right.length - left.length).map(escaped).join('|')}|(?<![A-Za-z])[A-Za-z]{3}(?![A-Za-z])`;
const decimal = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,8})?';
const moneyPattern = new RegExp(`(?:(${marker})[ \\t]*)?(-?${decimal})(?:[ \\t]*(${marker}))?`, 'g');
const currency = (text) => tokens.get(String(text).toUpperCase()) || (codes.has(String(text).toUpperCase()) ? text.toUpperCase() : null);
const currencyDigits = (code) => code === '$' ? 2 : new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;

function monetaryValues(value, fallback = null) {
  return [...value.matchAll(moneyPattern)].flatMap((match) => {
    const before = currency(match[1]);
    const after = currency(match[3]);
    const detected = after && after !== '$' ? after : before || after;
    const unqualifiedYenSign = (match[1] === '¥' && !after) || (match[3] === '¥' && !before);
    const ambiguousSymbol = (detected === '$' && isDollarCurrency(fallback)) || (fallback === 'JPY' && unqualifiedYenSign);
    const code = ambiguousSymbol ? fallback : detected || fallback;
    if (!code || before && after && !['$', 'CNY'].includes(before) && after !== '$' && before !== after) return [];
    const digits = currencyDigits(code);
    const [whole, fraction = ''] = match[2].replace(/[-,]/g, '').split('.');
    if (/[^0]/.test(fraction.slice(digits))) return [];
    const minor = Number(whole + fraction.slice(0, digits).padEnd(digits, '0'));
    return Number.isSafeInteger(minor) && minor > 0 ? [{ currency: code, minor, digits }] : [];
  });
}

function fields(text, label) {
  const pattern = new RegExp(`^[ \\t]*(?:${label})[ \\t]*[:：]?[ \\t]*(.*)$`, 'gim');
  return [...text.matchAll(pattern)].map((match) => match[1].trim() || text.slice(match.index + match[0].length).match(/^\s*([^\r\n]+)/)?.[1].trim() || '');
}

function dateFrom(value) {
  const numeric = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?=\d{2}:\d{2}|[^\d]|$)/);
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = value.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/);
  const dayFirst = value.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(20\d{2})\b/);
  const parts = numeric?.slice(1) || (named && [named[3], months.indexOf(named[1].slice(0, 3).toLowerCase()) + 1, named[2]]) || (dayFirst && [dayFirst[3], months.indexOf(dayFirst[2].slice(0, 3).toLowerCase()) + 1, dayFirst[1]]);
  if (!parts) return null;
  const [year, month, day] = parts.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() + 1 === month && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}

const only = (amounts) => {
  const unique = new Map(amounts.map((amount) => [`${amount.currency}:${amount.minor}`, amount]));
  return unique.size === 1 ? unique.values().next().value : null;
};

function parseMoneyDocument(rawText, name, includeRmbOnly = false) {
  const text = String(rawText || '').normalize('NFKC');
  const invoiceNumber = text.match(/\b(?:invoice|tax invoice)\s*(?:number|no\.?|#)\s*[:：]?\s*([\w][\w/-]{1,60})/i)?.[1]?.toUpperCase() || null;
  const namedReceipt = /\breceipt\s*(?:number|no\.?|#)|\bdate paid\b/i.test(text);
  const invoiceHeader = /^\s*(?:tax )?invoice\s*$/im.test(text) || /^invoice[-_ .]/i.test(name);
  const paymentHeader = /\b(?:payment (?:date|successful|completed|amount)|transaction (?:date|amount))\b|支付成功|交易成功|付款成功/i.test(text);
  const invoice = !namedReceipt && Boolean(invoiceHeader || invoiceNumber && !paymentHeader);
  const reportedCurrency = fields(text, '原(?:始)?交易币种|交易币种|原币币种|外币币种|币种|currency').map((value) => currency(value.trim())).find(Boolean);
  const billedCurrency = fields(text, '扣款币种|入账币种|记账币种|结算币种|billing currency').map((value) => currency(value.trim())).find(Boolean);
  const labeled = (labels, fallback = reportedCurrency) => fields(text, labels).flatMap((value) => monetaryValues(value, fallback));
  const originalAmounts = (amounts) => amounts.filter((amount) => amount.currency !== 'CNY');
  const native = (amounts) => {
    const explicit = amounts.filter((amount) => amount.currency !== '$');
    return only(explicit.length ? explicit : amounts);
  };
  if (invoice) {
    const due = labeled('amount due|invoice total|total amount|grand total|外币合计|价税合计');
    const total = labeled('total(?=[ \\t]*(?:[:：]?[ \\t]*(?:[A-Z]{3}\\b|[\\d$¥€£])|$))');
    const options = originalAmounts(due).length ? originalAmounts(due) : originalAmounts(total);
    const money = native(options);
    if (!money && (due.length || total.length) && [...due, ...total].every((amount) => amount.currency === 'CNY')) return null;
    return { kind: 'invoice', number: invoiceNumber, money, date: fields(text, 'date of issue|invoice date|开票日期').map(dateFrom).find(Boolean) || null };
  }

  const completed = namedReceipt || /(?:交易|付款|支付|扣款|入账)(?:已)?(?:成功|完成)|已(?:付款|支付|扣款|入账)|(?:交易|支付|付款)状态[\s:：]*(?:成功|完成)|记账(?:时间|日期)[\s:：]*20\d{2}/.test(text) || /\b(?:payment|transaction|charge)\s+(?:successful|completed|succeeded|posted)\b|\bstatus[\s:]+(?:paid|posted|completed|succeeded)\b/i.test(text);
  const cancelled = /(?:交易|付款|支付|扣款)(?:失败|取消|处理中)|(?:已退款|退款成功|已退回|已撤销|未支付)|\b(?:payment failed|payment pending|refunded)\b/i.test(text);
  const originals = labeled('原(?:始)?交易金额|交易原币金额|原币金额|外币(?:交易|支付)?金额|original (?:transaction )?amount|foreign (?:currency )?amount');
  const amountLabels = '订单金额|交易金额|支付金额|付款金额|实付金额|实付款|amount paid|transaction amount|payment amount|paid amount';
  const amounts = labeled(amountLabels);
  const debitLabels = '实际扣款(?:金额)?|扣款金额|入账金额|记账金额|实际支付金额|billing amount|charged amount';
  const debitFields = fields(text, debitLabels);
  const debitAmounts = debitFields.flatMap((value) => monetaryValues(value, billedCurrency || reportedCurrency));
  const options = [originals, amounts, debitAmounts].map(originalAmounts).find((values) => values.length) || [];
  const money = native(options);
  const yenSign = money?.currency === 'JPY' && billedCurrency !== 'CNY';
  const settlementCurrency = billedCurrency || (yenSign ? 'JPY' : null);
  const rmbLabels = '人民币(?:实际)?(?:扣款|入账|记账|实付)(?:金额)?';
  const rmbFields = fields(text, rmbLabels);
  const settlement = yenSign ? debitFields.flatMap((value) => monetaryValues(value, settlementCurrency)) : debitAmounts;
  const actual = rmbFields.flatMap((value) => monetaryValues(value, 'CNY')).concat(settlement).filter((amount) => amount.currency === 'CNY');
  const paidFields = fields(text, '交易金额|支付金额|付款金额|实付金额|实付款|amount paid|payment amount|paid amount');
  const paidRmb = paidFields.flatMap((value) => monetaryValues(value, yenSign ? 'JPY' : null)).filter((amount) => amount.currency === 'CNY');
  const shown = only((yenSign ? labeled(amountLabels, 'JPY') : amounts).filter((amount) => amount.currency === 'CNY'));
  const wallet = /账单详情|交易详情|支付详情/.test(text) && /扣款成功|支付成功|交易成功|已扣款|已支付/.test(text);
  const header = text.split(/^[ \t]*(?:订单金额|原(?:始)?交易金额|付款金额|支付金额|交易金额)/m)[0];
  const headerDebits = [...header.matchAll(/^[ \t]*(?:(¥|CNY|RMB|人民币)[ \t]*)?[-−–—][ \t]*([\d,]+\.\d{2})[ \t]*(元|人民币|CNY|RMB)?[ \t]*$/gim)];
  if (wallet) for (const match of headerDebits) if (match[3] || match[1] && (!yenSign || match[1] !== '¥')) actual.push(...monetaryValues(match[2], 'CNY'));
  const rmbWallet = wallet && shown && (!billedCurrency || billedCurrency === 'CNY') && !settlement.some((amount) => amount.currency !== 'CNY');
  const headerAmount = only(headerDebits.flatMap((match) => monetaryValues(match[2], 'CNY')));
  const discounts = labeled('[\\u3400-\\u9fff]{0,14}(?:立减|优惠(?:金额)?|折扣(?:金额)?)', 'CNY');
  const discountCny = discounts.filter((amount) => amount.currency === 'CNY').reduce((sum, amount) => sum + amount.minor, 0);
  const walletDebit = rmbWallet && headerAmount && (headerAmount.minor === shown.minor || headerAmount.minor + discountCny === shown.minor) ? headerAmount.minor : null;
  const paidDebit = !rmbWallet || !headerAmount ? only(paidRmb)?.minor : null;
  const debitCny = only(actual)?.minor ?? walletDebit ?? paidDebit ?? null;
  const debitConflict = actual.length > 0 && (!only(actual) || walletDebit !== null && walletDebit !== debitCny);
  const rmbMarker = yenSign ? /人民币|\b(?:CNY|RMB)\b/i : /人民币|\b(?:CNY|RMB)\b|¥/i;
  const rmbDebitExpected = Boolean(actual.length || paidRmb.length || rmbFields.length || billedCurrency === 'CNY' || rmbWallet ||
    [...debitFields, ...paidFields].some((value) => rmbMarker.test(value)));
  if (!options.length && (!namedReceipt || amounts.some((amount) => amount.currency === 'CNY')) && !(includeRmbOnly && rmbDebitExpected)) return null;
  const date = fields(text, '原(?:始)?交易(?:日期|时间)|交易(?:日期|时间)|支付(?:日期|时间)|付款(?:日期|时间)|扣款(?:日期|时间)|date paid|payment date|transaction date').map(dateFrom).find(Boolean) || null;
  return { kind: 'payment', invoiceNumber, money, debitCny, debitConflict, rmbDebitExpected, date, completed: completed && !cancelled, namedReceipt };
}

export function parseForeignDocument(rawText, name = '') {
  return parseMoneyDocument(rawText, name);
}

export function parseRmbSettlement(rawText) {
  const result = parseMoneyDocument(rawText, '', true);
  return result?.kind === 'payment' && result.rmbDebitExpected && result.completed ? result : null;
}

export function exchangeToCny(money, ratePer100) {
  if (!/^\d+(?:\.\d{1,8})?$/.test(String(ratePer100))) return null;
  const [integer, decimals = ''] = String(ratePer100).split('.');
  const scale = 10n ** BigInt(money.digits + decimals.length);
  const product = BigInt(money.minor) * BigInt(integer + decimals);
  const cents = Number((product * 2n + scale) / (scale * 2n));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export const displayForeignMoney = (money) => money ? `${money.currency} ${(money.minor / 10 ** money.digits).toFixed(money.digits)}` : '原币金额待核对';
