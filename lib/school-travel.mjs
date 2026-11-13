import { clickSectionAdd } from './portal-navigation.mjs';
import { schoolMoneyCny } from './funding-detail.mjs';
import { datePattern, travelDate } from './travel-evidence.mjs';

const APPLICATION = '国内出差申请';
const BUSINESS = '业务单信息';
const TABLES = '.el-table:visible, table:visible:not(.el-table table)';
const confirm = /^确\s*认$/;
const codePattern = /^[A-Z0-9][A-Z0-9-]{5,39}$/i;
const buttons = (scope, name) => scope.getByRole('button', { name, exact: true }).filter({ visible: true });
const heading = (scope, text) => scope.getByText(text, { exact: true }).filter({ visible: true });
const dialogFor = (scope, title) => scope.locator('.el-dialog:visible, [role="dialog"]:visible').filter({ has: heading(scope, title) });

function tableWith(scope, column, within = scope) {
  return within.locator(TABLES).filter({ has: scope.locator('th').filter({ hasText: column }) });
}

const rowList = (table) => table.locator('tbody tr:visible:not(.el-table__row--hidden)');
const compact = (text) => String(text || '').normalize('NFKC').replace(/\s+/g, '');
const format = (cents) => (cents / 100).toFixed(2);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const formItem = (root, label) => root.locator('.el-form-item:visible:has(.el-form-item__label:has-text(' + JSON.stringify(label) + '))');
const radios = (group) => group.locator('label:visible:has(input[type="radio"]), [role=radio]:visible:not(label *)');
const checkedRadios = (group) => group.locator('label:visible:has(input[type="radio"]:checked), [role=radio][aria-checked=true]:visible');

async function unique(locator, message, timeout = 10000) {
  await locator.first().waitFor({ state: 'visible', timeout }).catch(() => undefined);
  if (await locator.count() !== 1) throw new Error(message);
  return locator;
}

function businessToolbar(scope) {
  return scope.locator('.fast-reimbursement-cardFlex:visible, .theSecondStep-cardHead:visible, section:visible, [role="region"]:visible')
    .filter({ has: heading(scope, BUSINESS) })
    .filter({ has: buttons(scope, /^添\s*加$/) });
}

function businessRowsIn(table) {
  const headers = [...(table.querySelector('thead tr')?.cells || [])].map((cell) => cell.innerText.trim());
  const codeIndex = headers.indexOf('业务单号');
  if (codeIndex < 0) return [];
  return [...table.querySelectorAll('tbody tr')]
    .filter((row) => row.getClientRects().length && !row.classList.contains('el-table__row--hidden')).map((row) => {
      const cells = [...row.cells].map((cell) => cell.innerText.trim());
      return { code: cells[codeIndex], columns: Object.fromEntries(headers.map((name, index) => [name, cells[index] || ''])), text: cells.join('\n') };
    });
}

export async function linkedTravelApplication(scope) {
  const candidates = tableWith(scope, '业务单号').and(scope.locator(':not(.el-dialog *, [role=dialog] *)'));
  const records = (await Promise.all((await candidates.all()).map((table) => table.evaluate(businessRowsIn)))).flat();
  const distinct = [...new Map(records.filter(({ code }) => codePattern.test(code || '')).map((row) => [row.code, row])).values()];
  if (!distinct.length) return null;
  if (distinct.length !== 1 || !distinct[0].text.includes(APPLICATION)) throw new Error('当前报销页已有其他业务单，请核对原单');
  return distinct[0].code;
}

const datesIn = (value) => [...String(value || '').matchAll(datePattern)]
  .map(([date]) => travelDate(date)).filter(Boolean);

function applicationMatches(record, facts) {
  const { columns, text } = record;
  if (!compact(text).includes(APPLICATION) || /未通过|已撤销|已作废|已报销|审批中|待审批|驳回/.test(columns['单据状态'] || columns['审批状态'] || '')) return false;
  const departure = Object.entries(columns).find(([name]) => /(?:开始|起始|出发).*日期|出差开始时间/.test(name))?.[1];
  const arrival = Object.entries(columns).find(([name]) => /(?:截止|结束|返回|返程).*日期|出差结束时间/.test(name))?.[1];
  const location = Object.entries(columns).find(([name]) => /出差地点|出差地区|目的地/.test(name))?.[1];
  const dateRange = Object.entries(columns).find(([name]) => /^(?:出差日期|出差时间|行程日期|出差期间)$/.test(name))?.[1];
  const dates = datesIn(dateRange || text);
  const dateMatches = departure || arrival
    ? datesIn(departure).includes(facts.startDate) && datesIn(arrival).includes(facts.endDate)
    : dates.includes(facts.startDate) && dates.includes(facts.endDate) && (dateRange || new Set(dates).size === new Set([facts.startDate, facts.endDate]).size);
  const people = Object.entries(columns).find(([name]) => /出差人|出差人员|出差者/.test(name))?.[1] || columns['经办人'] || text;
  return Boolean(dateMatches && compact(location || text).includes(compact(facts.destination)) &&
    facts.travelers.length === facts.travelerCount && facts.travelers.every(({ name }) => compact(people).includes(compact(name))));
}

async function applicationRecords(dialog) {
  const tables = await dialog.locator(TABLES).all();
  const data = await Promise.all(tables.map((table) => table.evaluate(businessRowsIn)));
  return data.flat().filter(({ code }) => codePattern.test(code || ''));
}

async function chooseRow(row) {
  const input = row.locator('input[type=checkbox], input[type=radio]');
  if (await input.count() !== 1) throw new Error('学校未显示唯一的出差申请选择框');
  if (!await input.isChecked()) {
    const label = row.locator('label.el-checkbox:visible, label.el-radio:visible');
    if (await label.count() === 1) await label.click();
    else await input.check({ force: true });
  }
  if (!await input.isChecked()) throw new Error('学校未选中出差申请');
}

export async function attachTravelApplication(scope, facts, { previous, required = false, ask, guard, onSelect } = {}) {
  const linked = await linkedTravelApplication(scope);
  if (linked) {
    if (previous === linked) return linked;
    throw new Error('当前报销单已关联出差申请，无法确认属于本次任务');
  }
  const picker = dialogFor(scope, '选择业务单');
  if (!await picker.count()) {
    const toolbars = businessToolbar(scope);
    // On some school pages the business-order section first appears after selecting the claim type.
    if (!required && !await heading(scope, BUSINESS).count()) return null;
    let toolbar = await toolbars.count() === 1 ? toolbars : null;
    if (!toolbar) {
      const title = await unique(heading(scope, BUSINESS), '学校未显示「业务单信息」，无法关联国内出差申请');
      toolbar = title.locator('xpath=ancestor::div[.//button[normalize-space(.)="添加"]][1]');
    }
    await clickSectionAdd(toolbar, BUSINESS);
  }
  await unique(picker, '学校未打开「选择业务单」');
  const type = picker.getByPlaceholder('请选择业务单类型', { exact: true }).filter({ visible: true });
  if (await type.count() > 1) throw new Error('学校显示多个业务单类型选择框');
  if (await type.count() === 1 && !compact(await type.inputValue()).includes(APPLICATION)) {
    await type.click();
    const options = scope.getByRole('option', { name: APPLICATION, exact: true }).filter({ visible: true })
      .or(scope.locator('.el-select-dropdown__item:visible').filter({ hasText: /^\s*国内出差申请\s*$/ }));
    await (await unique(options, '业务单类型中未找到「国内出差申请」')).click();
  }
  const search = picker.getByPlaceholder('请输入业务单号', { exact: true }).filter({ visible: true });
  const query = buttons(picker, /^查\s*询$/);
  const queryCode = async (value) => {
    if (await search.count() !== 1 || await query.count() !== 1) throw new Error('学校业务单窗口缺少单号查询框');
    await search.fill(value);
    await query.click();
  };
  if (previous) await queryCode(previous);
  const candidates = new Map();
  const next = picker.getByRole('button', { name: /下一页/ }).or(picker.locator('button.btn-next')).filter({ visible: true });
  const waitRows = async () => {
    await picker.locator('.el-loading-mask:visible').first().waitFor({ state: 'hidden', timeout: 10000 });
    const table = tableWith(scope, '业务单号', picker);
    if (await table.count() === 1) {
      await rowList(table).first().or(table.getByText(/^(?:暂无数据|没有数据)$/)).first()
        .waitFor({ state: 'visible', timeout: 7000 }).catch(() => undefined);
    }
    return applicationRecords(picker);
  };
  let records = await waitRows();
  while (true) {
    await guard();
    for (const row of records) if (previous ? row.code === previous : applicationMatches(row, facts)) candidates.set(row.code, row);
    if (previous || await next.count() !== 1 || !await next.isEnabled() || await next.getAttribute('aria-disabled') === 'true') break;
    const prior = records.map(({ code }) => code).join('\n');
    await next.click();
    const deadline = Date.now() + 8000;
    do {
      records = await waitRows();
      if (records.map(({ code }) => code).join('\n') !== prior) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    if (records.map(({ code }) => code).join('\n') === prior) throw new Error('学校业务单列表未翻到下一页，请保留当前单据后重试');
  }
  const automatic = candidates.size === 1;
  const selected = automatic ? candidates.keys().next().value : String(await ask(
    candidates.size ? '有多张国内出差申请的行程相同，请回复本笔对应的业务单号。' : '学校列表未找到能按目的地、日期和出差人唯一核对的申请，请回复对应的国内出差申请单号。',
    { kind: 'travel_application', required: true, ...(candidates.size ? { choices: [...candidates.keys()].map((code) => ({ value: code, label: code })) } : {}) },
  )).trim();
  if (!codePattern.test(selected) || candidates.size && !candidates.has(selected) || previous && previous !== selected) throw new Error('出差申请单号未确认');
  await guard();
  const getRow = () => picker.locator('tbody tr:visible:not(.el-table__row--hidden)').filter({ has: heading(scope, selected) });
  if (!automatic || await getRow().count() !== 1) await queryCode(selected);
  const row = await unique(getRow(), '学校未显示唯一可关联的出差申请单');
  if (!(await row.innerText()).includes(APPLICATION)) throw new Error('学校显示的业务单不是国内出差申请');
  const otherChecked = picker.locator('tbody tr:visible').filter({ hasNot: heading(scope, selected) }).locator('input:checked');
  if (await otherChecked.count()) throw new Error('学校同时选中了其他业务单，请保留当前报销单核对');
  await chooseRow(row);
  await onSelect(selected);
  await guard();
  await (await unique(buttons(picker, confirm), '学校业务单窗口缺少确认按钮')).click();
  await picker.waitFor({ state: 'hidden', timeout: 10000 });
  await heading(scope, selected).first().waitFor({ timeout: 10000 });
  if (await linkedTravelApplication(scope) !== selected) throw new Error('学校未在原单上显示已关联的国内出差申请');
  return selected;
}

function cellAt(row, index) {
  return row.locator('td').nth(index);
}

async function columnNames(table) {
  return table.evaluate((root) => [...(root.querySelector('thead tr')?.cells || [])].map((cell) => cell.innerText.trim()));
}

async function cellAmount(cell) {
  const field = cell.locator('input:visible:not([type=hidden])');
  if (await field.count() === 1) return schoolMoneyCny(await field.inputValue());
  const text = (await cell.innerText()).replace(/编辑|完成|保存/g, '').trim();
  const values = text.split(/\n/).map(schoolMoneyCny).filter((value) => value !== null);
  return values.length === 1 ? values[0] : null;
}

async function fillRowMoney(row, entries) {
  const edit = buttons(row, '编辑');
  const done = buttons(row, /^(?:完成|保存)$/);
  if ((await Promise.all(entries.map(async ([cell, cents]) => await cellAmount(cell) === cents))).every(Boolean)) {
    if (await done.count() === 1) await done.click();
  } else {
    if (await edit.count() === 1) await edit.click();
    for (const [cell, cents] of entries) {
      if (await cellAmount(cell) === cents) continue;
      const amount = await unique(cell.locator('input:visible:enabled:not([readonly])'), '差旅明细缺少唯一可编辑金额');
      await amount.fill(format(cents));
      await amount.press('Tab');
    }
    if (await done.count() === 1) await done.click();
  }
  for (const [cell, cents] of entries) if (await cellAmount(cell) !== cents) throw new Error(`学校未接受差旅核定金额 ${format(cents)} 元`);
}

async function openTravelPanel(scope, name, marker) {
  if (await heading(scope, marker).count()) return;
  const label = heading(scope, name);
  const collapsed = scope.locator('.el-collapse-item__header[aria-expanded="false"]:visible').filter({ has: label });
  if (await collapsed.count() === 1) await collapsed.click();
}

async function selectSubsidyMethod(scope, amounts) {
  const dialog = dialogFor(scope, '补贴方式');
  const change = heading(scope, '修改补贴方式');
  const labels = [['交通', amounts.localTransportCny], ['伙食', amounts.mealCny], ['住宿', 0]];
  const item = (root, name) => root.locator('.el-form-item:visible').filter({ has: scope.getByText(new RegExp('^' + name + '\\s*[:：]?$')) });
  const selected = async (root, name) => {
    const group = item(root, name);
    return (await checkedRadios(group).allInnerTexts()).map((text) => text.trim());
  };
  const required = labels.some(([, cents]) => cents > 0);
  if (!await dialog.count() && await change.count() === 1) {
    const modes = await Promise.all(labels.map(async ([name, cents]) => {
      const current = await selected(scope, name);
      return current.length ? current.includes(cents > 0 ? '直接补贴' : '实报实销') : cents === 0;
    }));
    if (!modes.every(Boolean) && required) await change.click();
  }
  if (!await dialog.count()) return;
  for (const [name, cents] of labels) {
    const group = item(dialog, name);
    const wanted = cents > 0 ? '直接补贴' : '实报实销';
    if (!await group.count() && cents === 0) continue;
    const choice = await unique(radios(group).filter({ hasText: new RegExp('^\\s*' + wanted + '\\s*$') }),
      `学校未显示${name}的「${wanted}」选项`);
    if (!(await selected(dialog, name)).includes(wanted)) await choice.click();
    if (!(await selected(dialog, name)).includes(wanted)) throw new Error(`学校未接受${name}补贴方式`);
  }
  await (await unique(buttons(dialog, confirm), '学校补贴方式缺少确认按钮')).click();
  await dialog.waitFor({ state: 'hidden', timeout: 12000 });
}

async function selectSubsidyAccounts(scope, amounts, ask) {
  for (const [label, cents, expected] of [
    ['交通补贴科目', amounts.localTransportCny, /市内交通|交通补[贴助]|国内差旅/],
    ['伙食补贴科目', amounts.mealCny, /伙食补[贴助]|国内差旅/],
  ]) {
    const group = formItem(scope, label);
    if (!cents || !await group.count() || await checkedRadios(group).count()) continue;
    const options = radios(group);
    const preferred = options.filter({ hasText: expected });
    if (await options.count() === 1) await options.click();
    else if (await preferred.count() === 1) await preferred.click();
    else await ask(`学校有多个「${label}」选项。请在当前页面选好后回复「继续」。`, { kind: 'travel_subsidy_account', required: true });
    if (await checkedRadios(group).count() !== 1) throw new Error(`学校未确认「${label}」`);
  }
}

export async function fillDomesticTravel(scope, travel, { guard, ask }) {
  const { facts, amounts } = travel;
  await selectSubsidyMethod(scope, amounts);
  await guard();
  const lodgingSummary = /^住宿费(?:用)?(?:费用)?合计\s*[:：]?$/;
  await openTravelPanel(scope, '住宿费用', lodgingSummary);
  if (amounts.lodgingCny > 0) {
    const row = await unique(scope.locator('tbody tr:visible').filter({ has: heading(scope, lodgingSummary) }), '学校未显示唯一的住宿费用合计');
    const action = row.locator('td').last();
    await fillRowMoney(row, [[action, amounts.lodgingCny]]);
    const byTraveler = tableWith(scope, '职务职称').filter({ has: scope.locator('th').getByText('金额', { exact: true }) });
    if (await byTraveler.count()) {
      const table = await unique(byTraveler, '无法核对住宿按出差人员分配的明细');
      const index = (await columnNames(table)).indexOf('金额');
      const rows = await rowList(table).all();
      const observed = await Promise.all(rows.map((row) => cellAmount(cellAt(row, index))));
      if (!observed.every((amount) => amount !== null) || sum(observed) !== amounts.lodgingCny) {
        if (rows.length !== 1) throw new Error('学校要求逐人分配住宿费，请核对每位出差人的住宿金额');
        await fillRowMoney(rows[0], [[cellAt(rows[0], index), amounts.lodgingCny]]);
      }
    }
  }
  await openTravelPanel(scope, /^(?:市内)?补贴金额$/, /^(?:伙食|交通)补贴金额$/);
  const fields = [['交通补贴金额', amounts.localTransportCny], ['伙食补贴金额', amounts.mealCny]];
  const subsidy = tableWith(scope, '交通补贴金额').or(tableWith(scope, '伙食补贴金额')).or(tableWith(scope, '住宿补贴金额'));
  if (fields.some(([, cents]) => cents) || await subsidy.count()) {
    const table = await unique(subsidy, '学校未显示唯一的补贴费用明细');
    const headers = await columnNames(table);
    const rows = await rowList(table).all();
    if (rows.length !== facts.travelerCount) throw new Error('学校补贴人数和差旅行程不一致');
    const editable = fields.flatMap(([label, cents]) => {
      const index = headers.indexOf(label);
      if (cents && index < 0) throw new Error(`学校未显示「${label}」`);
      if (!Number.isInteger(cents / rows.length)) throw new Error('无法逐人核对补贴金额');
      return index < 0 ? [] : [[index, cents / rows.length]];
    });
    const lodgingSubsidy = headers.indexOf('住宿补贴金额');
    for (const row of rows) {
      if (lodgingSubsidy >= 0 && await cellAmount(cellAt(row, lodgingSubsidy)) !== 0) throw new Error('学校另列住宿补贴，请核对以免与住宿发票重复');
      await fillRowMoney(row, editable.map(([index, cents]) => [cellAt(row, index), cents]));
    }
  }
  await selectSubsidyAccounts(scope, amounts, ask);
}
