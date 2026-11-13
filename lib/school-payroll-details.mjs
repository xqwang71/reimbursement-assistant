import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { activateSchoolControl } from './school-finance-access.mjs';
import { PAYROLL_EXPENSE_ITEMS } from './payroll-intake.mjs';

const fields = {
  name: ['姓名', '人员姓名', '人员'],
  code: ['工号', '学号', '人员号', '工号/人员号', '工号/学号', '人员编号', '职工号', '教工号'],
  certificate: ['证件号', '证件号码', '身份证号', '身份证号码'],
  organization: ['部门', '所属部门', '单位', '院系'],
  position: ['职务职称', '职称职务', '职称/职务', '职称', '专业技术职称'],
  purpose: ['用途', '发放用途', '劳务用途', '备注'],
  hours: ['工作学时', '学时', '工作小时'],
  amount: ['其他劳务费', '学生劳务费', '劳务费', '劳务报酬', '应发金额', '发放金额', '应发合计', '应发'],
  total: ['应发合计', '应发金额'],
};
const normalize = (value) => String(value ?? '').normalize('NFKC').trim();
const number = (value) => normalize(value).replace(/,/g, '');
const positionName = (value) => {
  const label = normalize(value).replace(/^\d+\s*[-—]\s*/, '');
  return ({ 1: '正高', 2: '副高', 3: '院士', 4: '全国知名专家', 5: '其他', 正高级: '正高', 副高级: '副高' })[label] || label;
};
const amountCny = (value) => number(value) ? Math.round(Number(number(value)) * 100) : NaN;

export function payrollAction(scope, ...labels) {
  const escape = (char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = labels.map((label) => Array.from(label, escape).join('\\s*')).join('|');
  const text = scope.locator('a:visible, button:visible, [role="button"]:visible')
    .filter({ hasText: new RegExp('^\\s*[+＋]?\\s*(?:' + pattern + ')\\s*$') });
  const inputs = scope.locator(labels.map((label) => 'input:is([type="button"],[type="submit"])[value=' + JSON.stringify(label) + ']:visible').join(','));
  return text.or(inputs);
}

async function gridFor(scope, detail) {
  const candidates = scope.locator('.k-grid:visible');
  const ids = await candidates.evaluateAll((elements, { aliases, detail }) => elements.flatMap((element) => {
    const grid = window.jQuery?.(element).data('kendoGrid');
    const titles = (grid?.columns || []).map((column) => String(column.title || '').normalize('NFKC').replace(/[\s*：:]/g, ''));
    const has = (type) => titles.some((title) => aliases[type].includes(title));
    if (!has('name') || (detail && !['position', 'purpose', 'amount'].some(has))) return [];
    return /^[\w-]+$/.test(element.id) ? [element.id] : [];
  }), { aliases: fields, detail });
  if (ids.length !== 1) return null;
  return scope.locator('#' + ids[0]);
}

async function gridSnapshot(grid) {
  return grid.evaluate((element, { aliases, expenseItems }) => {
    const widget = window.jQuery?.(element).data('kendoGrid');
    if (!widget || widget.dataSource._requestInProgress) return null;
    const columns = widget.columns.filter((column) => column.field);
    const titleOf = (column) => String(column.title || '').normalize('NFKC').replace(/[\s*：:]/g, '');
    const keys = {
      name: ['Name', 'PersonName', 'EmpName', 'StudentName', 'c_Name'],
      code: ['Code', 'PersonCode', 'EmployeeCode', 'EmpCode', 'c_Code', 'PersonNo', 'StudentNo'],
      certificate: ['CertNo', 'IDNumber', 'IDNo', 'CertificateNo', 'IDCardNo'],
      organization: ['OrgName', 'DeptName'],
    };
    const pick = (field, titles) => titles.map((title) => columns.find((column) => titleOf(column) === title)?.field).find(Boolean) ||
      keys[field]?.find((key) => columns.some((column) => column.field === key));
    const fields = Object.fromEntries(Object.entries(aliases).map(([field, titles]) => [field, pick(field, titles)]));
    const expenseFields = Object.fromEntries(expenseItems.flatMap((title) => {
      const matches = columns.filter((column) => !column.hidden && titleOf(column) === title);
      return matches.length === 1 ? [[title, matches[0].field]] : [];
    }));
    if (fields.certificate && fields.code === fields.certificate) delete fields.code;
    const rows = Array.from(widget.tbody.find('tr[data-uid]'), (row) => {
      const item = widget.dataItem(row);
      const result = { uid: row.getAttribute('data-uid') };
      for (const [field, key] of Object.entries(fields)) {
        if (!key) continue;
        const value = field === 'certificate' && key === 'IcNo' ? item?.IcNoReal : item?.[key];
        // Kendo can store a code for a rendered dropdown cell such as 职称职务.
        const index = widget.columns.filter((column) => !column.hidden).findIndex((column) => column.field === key);
        const titledCell = Array.from(row.cells).find((cell) => cell.getAttribute('name') === key);
        const cell = (titledCell || (index < 0 ? null : row.cells[index]))?.innerText?.trim();
        result[field] = field === 'position' && cell ? cell : value ?? cell;
      }
      result.expenses = Object.fromEntries(Object.entries(expenseFields).map(([label, key]) => [label, item?.[key]]));
      result.personnelId = item?.PersonnelID || item?.PeopleID;
      if (!result.organization) result.organization = item?.Company;
      return result;
    });
    return { fields, expenseFields, rows, total: widget.dataSource.total() };
  }, { aliases: fields, expenseItems: PAYROLL_EXPENSE_ITEMS });
}

async function readGrid(grid, signal) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    signal.throwIfAborted();
    const data = await gridSnapshot(grid);
    if (data && Number.isSafeInteger(data.total)) {
      if (data.total > data.rows.length && data.total <= 200) {
        await grid.evaluate((element, size) => {
          const source = window.jQuery(element).data('kendoGrid').dataSource;
          if (source.pageSize() !== size) source.pageSize(size);
        }, data.total);
      } else return data;
    }
    await delay(250, undefined, { signal });
  }
  throw new Error('学校明细或人员列表暂未加载完成。');
}

function identity(person, category, lookupKey) {
  const kind = /^[A-Z0-9-]{4,40}$/.test(normalize(person.code).toUpperCase()) ? 'code' : 'certificate';
  const code = normalize(person[kind]).toUpperCase();
  const personnelId = normalize(person.personnelId).toUpperCase();
  const hash = (type, value) => createHmac('sha256', Buffer.from(lookupKey, 'hex')).update([category, type, value].join('\0')).digest('hex');
  const internalKey = /^[A-Z0-9-]{1,80}$/.test(personnelId) ? hash('personnel', personnelId) : '';
  const fullCode = /^[A-Z0-9-]{4,40}$/.test(code) && /^[A-Z0-9]{4}$/.test(code.slice(-4));
  if (!internalKey && !fullCode) return null;
  const identityTail = /^[A-Z0-9]{4}$/.test(code.slice(-4)) ? code.slice(-4) : '';
  return {
    key: fullCode ? hash(kind, code) : internalKey,
    internalKey: internalKey || hash(kind, code),
    category, name: normalize(person.name), identityTail, organization: normalize(person.organization).slice(0, 100), source: 'school',
  };
}

function rowLocator(grid, uid) {
  if (!/^[\w-]{1,80}$/.test(uid || '')) throw new Error('学校未返回可核对的人员行。');
  return grid.locator('tbody tr[data-uid="' + uid + '"]:not(.k-grid-content-locked *):visible');
}

async function openedChooser(frame, opener, options) {
  const { signal } = options;
  const dialogs = frame.locator('.k-window-content:visible, dialog[open]:visible');
  const before = await dialogs.evaluateAll((items) => items.map((item) => item.id));
  await activateSchoolControl(opener, '学校未显示唯一的人员选择按钮。');
  for (let attempt = 0; attempt < 24; attempt += 1) {
    signal.throwIfAborted();
    for (const dialog of await dialogs.all()) {
      if (before.includes(await dialog.getAttribute('id'))) continue;
      const grid = await gridFor(dialog, false);
      if (grid) return { dialog, grid };
    }
    await delay(300, undefined, { signal });
  }
  throw new Error('学校人员选择窗口或人员列表未加载。');
}

async function searchChooser(chooser, value, signal) {
  const { dialog, grid } = chooser;
  const schoolQuery = dialog.locator('#txt_Para:visible, #txt_EmployeeCode:visible');
  const query = await schoolQuery.count() ? schoolQuery :
    dialog.locator('input:is([type="text"],[type="search"],:not([type])):visible:not([readonly]):not([disabled])');
  if (await query.count() !== 1) throw new Error('学校人员选择窗口未显示唯一的姓名查询框。');
  const search = payrollAction(dialog, '查询', '搜索', '筛选');
  if (await search.count() !== 1) throw new Error('学校人员选择窗口未显示唯一的查询按钮。');
  await readGrid(grid, signal);
  await query.fill(value);
  // Wait for this search to rebind the school's Kendo grid, including searches with zero hits.
  await grid.evaluate((element) => {
    const widget = window.jQuery(element).data('kendoGrid');
    element.removeAttribute('data-runner-payroll-search');
    widget.one('dataBound', () => element.setAttribute('data-runner-payroll-search', 'ready'));
  });
  await activateSchoolControl(search, '无法执行学校人员查询。');
  await grid.and(dialog.locator('[data-runner-payroll-search="ready"]')).waitFor({ state: 'visible', timeout: 10000 })
    .catch(() => { throw new Error('学校未返回本次人员查询结果。'); });
  const data = await readGrid(grid, signal);
  if (data.total !== data.rows.length) throw new Error('学校查询返回了多页人员，请确认姓名后重试。');
  return data.rows;
}

async function useChooserRow({ dialog, grid }, uid, frame) {
  const row = rowLocator(grid, uid);
  const choose = payrollAction(row, '选择', '添加');
  if (await choose.count() === 1) {
    await activateSchoolControl(choose, '学校人员结果已变化。');
    return;
  }
  const confirm = payrollAction(dialog, '确定', '添加', '选中', '保存选中', '保存所选')
    .or(dialog.locator('[onclick="Save_SelectPeople()"]:visible, [onclick="Save_SelectPeople();"]:visible'));
  if (await confirm.count() !== 1) throw new Error('学校人员窗口未显示唯一的确认按钮。');
  const input = row.locator('input[type="radio"]:visible, input[type="checkbox"]:visible');
  if (await input.count() === 1) await input.check();
  else {
    if (await row.count() !== 1) throw new Error('学校人员结果已变化。');
    await row.click();
    if (!await row.evaluate((element) => element.matches('.k-state-selected, .k-selected, [aria-selected="true"]'))) {
      throw new Error('学校未确认所选人员行。');
    }
  }
  await activateSchoolControl(confirm, '学校未能确认所选人员。');
  const sameName = frame.locator('.k-window-content:visible').filter({ hasText: /存在相同姓名的人员/ });
  const okay = payrollAction(sameName, '确定');
  if (await okay.count() === 1) await activateSchoolControl(okay, '无法确认学校同名人员提示。');
}

async function chooseRecipient(frame, detail, person, index, options) {
  const { payroll, signal, lookupKey, draft, ask, persist, checkpoint } = options;
  const workflow = frame.locator('#Hid_SubmitAuditType');
  if (await workflow.count() === 1 && await workflow.inputValue() === '2') {
    throw new Error('学校当前套类使用资金池自动添加人员，请核对本笔发放套类。');
  }
  const chooser = await openedChooser(frame, payrollAction(detail, '添加人员'), options);
  const results = await searchChooser(chooser, person.name, signal);
  const sameName = results.filter((row) => normalize(row.name) === normalize(person.name)).flatMap((row) => {
    const recipient = identity(row, payroll.category, lookupKey);
    return recipient ? [{ row, recipient }] : [];
  });
  let matches = sameName;
  const remembered = draft.people?.[index];
  const expectedKey = remembered || person.recipientKey;
  let requireChoice = false;
  if (expectedKey) {
    const keyed = matches.filter(({ recipient }) => (remembered ? recipient.internalKey : recipient.key) === expectedKey);
    // History can use a certificate where the school's picker also exposes a personnel number.
    matches = keyed.length || remembered ? keyed : matches.filter(({ recipient, row }) =>
      recipient.identityTail === person.identityTail || normalize(row.certificate).toUpperCase().endsWith(person.identityTail || '\0'));
  } else if (person.identityTail) matches = matches.filter(({ recipient }) => recipient.identityTail === person.identityTail);
  if (!matches.length && !remembered && sameName.length) {
    matches = sameName;
    requireChoice = true;
  }
  if (!matches.length) throw new Error('学校未找到第 ' + (index + 1) + ' 条发放明细对应的人员。请核对姓名、学校人员登记或已选人员。');
  let indexChosen = 0;
  while (matches.length > 1 || requireChoice) {
    const choices = matches.map(({ recipient }, i) => ({
      value: String(i + 1), label: [recipient.name, recipient.identityTail && '尾号 ' + recipient.identityTail, recipient.organization].filter(Boolean).join(' · '),
    }));
    const message = requireChoice ? '已记住的尾号与当前学校结果不同。请核对并选择对应人员。' : '学校找到多位同名人员。请按尾号和部门选择。';
    const answer = await ask('第 ' + (index + 1) + ' 条发放明细 · ' + message, { kind: 'payroll_person', choices });
    indexChosen = choices.findIndex(({ value }) => value === normalize(answer));
    if (indexChosen >= 0) break;
    await checkpoint();
  }
  await checkpoint();
  const { row, recipient } = matches[indexChosen];
  draft.people ||= [];
  if (draft.people.some((key, other) => other !== index && key === recipient.internalKey)) {
    throw new Error('同一学校人员在本笔申报中出现多次，请合并该人员的发放明细。');
  }
  draft.people[index] = recipient.internalKey;
  draft.addingPerson = index;
  await persist();
  await useChooserRow(chooser, row.uid, frame);
  return recipient;
}

function payrollAmount(row, person) {
  return amountCny(person.expenseItem ? row.expenses[person.expenseItem] : row.amount);
}

function sameDetail(row, person) {
  const total = amountCny(row.total);
  const other = person.expenseItem && Object.entries(row.expenses).some(([label, value]) => label !== person.expenseItem && Math.abs(amountCny(value)) > 0);
  return positionName(row.position) === positionName(person.position) && normalize(row.purpose) === normalize(person.purpose) &&
    (!person.hours || number(row.hours) !== '' && Number(number(row.hours)) === Number(person.hours)) &&
    payrollAmount(row, person) === person.amountCny && !other && (!Number.isFinite(total) || total === person.amountCny);
}

async function fillEditor(scope, label, key, value, kind) {
  const byLabel = scope.getByLabel(label, { exact: true }).filter({ visible: true });
  const selector = 'input, textarea, select';
  const byName = /^[\w-]+$/.test(key || '') ? scope.locator(':is(' + selector + '):is([name="' + key + '"], [id="' + key + '"]):visible') : byLabel;
  const field = byLabel.or(byName);
  if (kind === 'position' && /^[\w-]+$/.test(key || '')) {
    const widget = scope.locator(':is(' + selector + '):is([name="' + key + '"], [id="' + key + '"])');
    if (await widget.count() === 1) {
      const chosen = await widget.evaluate((element, expected) => {
        const list = window.jQuery?.(element).data('kendoDropDownList');
        if (!list) return null;
        const normalize = (value) => String(value || '').trim().replace(/^\d+\s*[-—]\s*/, '').replace(/高级$/, '高');
        const items = Array.from(list.dataSource.view()).filter((item) => normalize(item[list.options.dataTextField]) === normalize(expected));
        if (items.length !== 1) return false;
        list.value(String(items[0][list.options.dataValueField]));
        list.trigger('change');
        return normalize(list.text()) === normalize(expected);
      }, value);
      if (chosen === true) return;
      if (chosen === false) throw new Error('学校职称选项里未找到「' + value + '」。');
    }
  }
  if (await field.count() !== 1 || !await field.isEditable()) throw new Error('学校发放明细未找到可填写的「' + label + '」。');
  if (kind === 'position' && await field.evaluate((element) => element.tagName === 'SELECT')) {
    const found = await field.locator('option').evaluateAll((options) => options.map((option) => ({ label: option.label, value: option.value })));
    const matches = found.filter((option) => positionName(option.label) === positionName(value));
    if (matches.length !== 1) throw new Error('学校职称选项里未找到「' + value + '」。');
    await field.selectOption(matches[0].value);
    return;
  }
  await field.fill(value);
  await field.blur();
  const actual = await field.inputValue();
  if (kind === 'numeric' ? number(actual) === '' || Number(number(actual)) !== Number(value) : normalize(actual) !== normalize(value)) {
    throw new Error('学校未保留填写的「' + label + '」。');
  }
}

async function editPayrollRow(detail, grid, data, row, person, checkpoint) {
  const amountField = person.expenseItem ? data.expenseFields[person.expenseItem] : data.fields.amount;
  const otherAmount = Object.entries(row.expenses).find(([label, value]) => data.expenseFields[label] !== amountField && Math.abs(amountCny(value)) > 0);
  if (otherAmount) throw new Error('学校原草稿已有「' + otherAmount[0] + '」金额。请核对该条发放明细。');
  const target = rowLocator(grid, row.uid);
  const select = target.locator('input[type="checkbox"]:visible, input[type="radio"]:visible');
  if (await grid.getAttribute('id') === 'grid_Declare_Detail_En') {
    const selected = await target.evaluate((element) => {
      const grid = window.jQuery('#grid_Declare_Detail_En').data('kendoGrid');
      grid.select(window.jQuery(element));
      return Array.from(grid.select()).some((row) => row.dataset.uid === element.dataset.uid);
    });
    if (!selected) throw new Error('学校未确认需要编辑的发放明细行。');
  } else if (await select.count() === 1) {
    const other = grid.locator('tbody tr[data-uid] input[type="checkbox"]:checked:visible').and(grid.locator('tbody tr[data-uid]:not([data-uid="' + row.uid + '"]) input'));
    for (const input of await other.all()) await input.uncheck();
    await select.check();
  } else {
    if (await target.count() !== 1) throw new Error('学校发放人员已变化。');
    await target.click();
    if (!await target.evaluate((element) => element.matches('.k-state-selected, .k-selected, [aria-selected="true"]'))) {
      throw new Error('学校未确认需要编辑的发放明细行。');
    }
  }
  await activateSchoolControl(payrollAction(detail, '行编辑'), '学校未显示「行编辑」。');
  const editor = target;
  await fillEditor(editor, '职称职务', data.fields.position, person.position, 'position');
  await fillEditor(editor, '用途', data.fields.purpose, person.purpose, 'text');
  if (person.hours) await fillEditor(editor, '工作学时', data.fields.hours, person.hours, 'numeric');
  await fillEditor(editor, person.expenseItem || '应发金额', amountField, (person.amountCny / 100).toFixed(2), 'numeric');
  const rowSave = payrollAction(editor, '保存', '更新');
  const save = await rowSave.count() ? rowSave : payrollAction(detail, '保存', '保存明细');
  await checkpoint();
  await activateSchoolControl(save, '学校发放明细未显示唯一的保存按钮。');
}

async function detailGrid(detail, { signal, checkpoint }) {
  let grid;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await checkpoint();
    grid = await gridFor(detail, true);
    if (grid) break;
    await delay(250, undefined, { signal });
  }
  if (!grid) throw new Error('学校薪酬草稿已打开，暂未识别到发放明细表。');
  return grid;
}

function rowIdentity(payroll, lookupKey) {
  return (row) => identity(row, payroll.category, lookupKey)?.internalKey;
}

export async function fillPayrollDetails(detail, options) {
  const { payroll, signal, draft, checkpoint, lookupKey, log, rememberRecipient, persist, frame } = options;
  const grid = await detailGrid(detail, options);
  const rowKey = rowIdentity(payroll, lookupKey);
  const samePerson = (row, person, key) => normalize(row.name) === normalize(person.name) && rowKey(row) === key;
  for (const [index, person] of payroll.people.entries()) {
    await checkpoint();
    let data = await readGrid(grid, signal);
    if (index === 0) {
      const missing = payroll.people.find(({ expenseItem }) => expenseItem && !data.expenseFields[expenseItem]);
      if (missing) throw new Error('学校当前薪酬套类未显示「' + missing.expenseItem + '」栏。');
    }
    if (data.rows.some((row) => !(draft.people || []).includes(rowKey(row)))) {
      throw new Error('学校草稿中有尚未匹配的人员。请核对原草稿后回复「继续」。');
    }
    let key = draft.people?.[index];
    let recipient;
    if (!key || !data.rows.some((row) => samePerson(row, person, key))) {
      if (draft.addingPerson === index) {
        throw new Error('学校尚未确认第 ' + (index + 1) + ' 条人员的添加结果。回复「继续」可重新读取本笔明细。');
      }
      if (data.rows.some((row) => normalize(row.name) === normalize(person.name) && !person.recipientKey)) {
        throw new Error('第 ' + (index + 1) + ' 条发放人员可能与原草稿重复。请核对人员。');
      }
      recipient = await chooseRecipient(frame, detail, person, index, options);
      key = recipient.internalKey;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        data = await readGrid(grid, signal);
        if (data.rows.some((row) => samePerson(row, person, key))) break;
        await delay(300, undefined, { signal });
      }
    }
    const matches = data.rows.filter((row) => samePerson(row, person, key));
    if (matches.length !== 1) throw new Error('学校未确认第 ' + (index + 1) + ' 条人员已加入本笔草稿。');
    if (draft.addingPerson === index) {
      delete draft.addingPerson;
      await persist();
    }
    if (recipient?.identityTail) {
      const { internalKey, ...memory } = recipient;
      await rememberRecipient?.(memory);
    }
    if (!sameDetail(matches[0], person)) await editPayrollRow(detail, grid, data, matches[0], person, checkpoint);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      data = await readGrid(grid, signal);
      if (data.rows.some((row) => samePerson(row, person, key) && sameDetail(row, person))) break;
      await delay(300, undefined, { signal });
    }
    if (!data.rows.some((row) => samePerson(row, person, key) && sameDetail(row, person))) {
      throw new Error('学校未确认第 ' + (index + 1) + ' 条明细的职称、用途、学时或应发金额。');
    }
    log('核对学校发放明细', (index + 1) + '/' + payroll.people.length);
  }
}

export async function verifyPayrollDetails(detail, options) {
  const { payroll, draft, signal, lookupKey } = options;
  const grid = await detailGrid(detail, options);
  const { rows, total } = await readGrid(grid, signal);
  const rowKey = rowIdentity(payroll, lookupKey);
  const verified = payroll.people.map((person, index) => rows.find((row) => rowKey(row) === draft.people?.[index] &&
    normalize(row.name) === normalize(person.name) && sameDetail(row, person)));
  if (total !== payroll.people.length || rows.length !== total ||
      verified.some((row) => !row) || new Set(verified).size !== total ||
      verified.reduce((sum, row, index) => sum + payrollAmount(row, payroll.people[index]), 0) !== payroll.totalCny) {
    throw new Error('学校草稿的人员明细或应发合计与本机事项不一致。');
  }
}

const finalPath = 'https://cwc.suibe.edu.cn/SFP_SalarySelf/SalaryDeclareDetail/SubmitSalaryDeclareDetail';
const reviewerPath = 'https://cwc.suibe.edu.cn/SFP_SalarySelf/SalaryDeclareDetail/SaveThreeApprover';
const onlineConfirmation = /^确认走线上审批吗[?？]?$/;
const optionalAttachments = /^您未上传任何附件[，,]\s*确认继续提交吗[?？]?$/;
const schoolValidation = /请上传附件[!！]|请选择分管校领导|分管校领导不能为空|提交校验错误数据|劳务时间冲突校验|校验校外人员工作单位/;
const signerValue = (code, name) => code + '-' + name;

async function selectReviewer(dialog, chooser, match, name) {
  const code = normalize(match.code);
  const label = signerValue(code, name);
  const checkbox = rowLocator(chooser.grid, match.uid).locator('input[name="chkReviewer"]:visible');
  const finish = chooser.dialog.locator('a[onclick="SaveMultiSelectReviewer()"]:visible');
  if (await checkbox.count() !== 1 || await finish.count() !== 1) throw new Error('学校加签人列表未显示勾选或保存。');
  const reviewerId = await dialog.locator('#HidReviewerID').inputValue();
  const selected = await checkbox.evaluate((input) => ({
    personnelId: input.value, category: input.title, label: input.getAttribute('codename'),
  }));
  if (!/^[\w-]{1,80}$/.test(reviewerId) || !/^[\w-]{1,80}$/.test(selected.personnelId) ||
      selected.category !== '0' || normalize(selected.label) !== label || selected.personnelId !== match.personnelId) {
    throw new Error('学校加签人勾选项与查到的教工不一致。');
  }
  if (await chooser.dialog.locator('input[name="chkReviewer"]:checked').count()) throw new Error('学校加签窗口已有勾选，请核对。');
  await checkbox.check();
  await activateSchoolControl(finish, '学校加签人选择未保存。');
  const tags = dialog.locator('#ReviewerMultiplePerson ul li span[id]');
  const values = await tags.evaluateAll((spans) => spans.map((span) => ({ key: span.id, label: span.textContent })));
  if (values.length !== 1 || normalize(values[0].label) !== label ||
      values[0].key.split('|').slice(0, 3).join('|') !== [selected.category, selected.personnelId, reviewerId].join('|')) {
    throw new Error('学校加签窗口未确认唯一的「' + name + '」。');
  }
  return { code, reviewer: { reviewerId, personnelId: selected.personnelId, category: selected.category } };
}

async function fillApprover(dialog, options) {
  const { frame, plan, signal, checkpoint } = options;
  const multi = dialog.locator('a.k-i-search[onclick^="fun_ReviewerMultiplePerson("]:visible');
  const open = multi.or(dialog.locator('[onclick^="SelectThreeApproverPerson("]:visible'))
    .or(payrollAction(dialog, '选择加签人', '加签人', '加签'));
  await open.waitFor({ state: 'visible', timeout: 6500 }).catch(() => { throw new Error('学校加签窗口未显示人员选择按钮。'); });
  const multiple = await multi.count() === 1;
  if (multiple) {
    const current = await dialog.locator('#ReviewerMultiplePerson ul li span[id]').evaluateAll((tags) =>
      tags.map((tag) => ({ label: tag.textContent, ids: tag.id.split('|') })));
    if (current.length) {
      const code = plan.signer.employeeNo;
      const [category, personnelId, reviewerId] = current[0].ids;
      const action = await multi.getAttribute('onclick');
      if (current.length === 1 && code && normalize(current[0].label) === signerValue(code, plan.signer.name) &&
          category === '0' && /^[\w-]{1,80}$/.test(personnelId || '') && /^[\w-]{1,80}$/.test(reviewerId || '') &&
          action?.startsWith("fun_ReviewerMultiplePerson('" + reviewerId + "'")) {
        return { code, reviewer: { reviewerId, personnelId, category } };
      }
      throw new Error('学校加签窗口已有人员，请核对现有加签名单。');
    }
  }
  const chooser = await openedChooser(frame, open, options);
  const rows = await searchChooser(chooser, plan.signer.employeeNo || plan.signer.name, signal);
  const matches = rows.filter((row) => normalize(row.name) === plan.signer.name && normalize(row.code) &&
    (!plan.signer.employeeNo || normalize(row.code) === plan.signer.employeeNo));
  if (matches.length !== 1) throw new Error('学校未找到唯一的加签人「' + plan.signer.name + '」。');
  const code = normalize(matches[0].code);
  await checkpoint();
  if (multiple) return selectReviewer(dialog, chooser, matches[0], plan.signer.name);
  await useChooserRow(chooser, matches[0].uid, frame);
  const field = dialog.locator('#txtSelectThreeApprover:visible, #txtThreeApprover:visible');
  const values = await field.evaluateAll((inputs) => inputs.map((input) => input.value));
  if (!values.length || !values.every((value) => normalize(value) === signerValue(code, plan.signer.name))) {
    throw new Error('学校未确认已选加签人「' + plan.signer.name + '」。');
  }
  return { code };
}

async function acceptPayrollDialog(frame, phrase) {
  const message = frame.locator('#extOkCancelDialog:visible');
  if (await message.count() !== 1 || !phrase.test(normalize(await message.innerText()))) return false;
  const buttons = message.locator('..').locator('.k-ext-dialog-buttons:visible');
  const confirm = payrollAction(buttons, '确定', '确认', '是');
  if (await confirm.count() !== 1) return false;
  await activateSchoolControl(confirm, '学校薪酬确认窗口已变化。');
  return true;
}

function reviewerSaveMatches(request, frame, draft, reviewer) {
  if (!reviewer || request.frame() !== frame || request.method() !== 'POST') return false;
  const values = new URLSearchParams(request.postData() || '');
  const expected = { DeclareID: draft.declareId, ReviewerID: reviewer.reviewerId, PersonCategory: reviewer.category, PersonnelID: reviewer.personnelId };
  return [...values.keys()].length === 4 && Object.entries(expected).every(([field, value]) =>
    String(values.get('p_en[0].' + field)).toLowerCase() === value.toLowerCase());
}

export async function submitPayroll(detail, options) {
  const { plan, signal, frame, draft, checkpoint, beforeSubmit, beforeApproval, stage } = options;
  const page = frame.page();
  const online = detail.locator('#chkIsThree:visible').or(detail.getByRole('checkbox', { name: '线上审批', exact: true }));
  if (await online.count() !== 1) throw new Error('学校薪酬页面未显示可确认的「线上审批」选项。');
  await online.check();
  if (!await online.isChecked() || !await online.evaluate((element) => {
    const field = window.jQuery?.(element);
    return field && typeof field.attr === 'function' ? field.attr('checked') === 'checked' : element.checked;
  })) throw new Error('学校未保留「线上审批」选择。');

  const submit = detail.locator('#btnSubmit[onclick="SubmitSalaryDeclare()"]:visible');
  if (await submit.count() !== 1 || !await submit.isEnabled()) throw new Error('学校未显示唯一的薪酬提交按钮。');

  let signer;
  let reviewerSaveStarted = false;
  let checkedFinalRequest = false;
  let result;
  let attempted = false;
  let error;
  const saveReviewer = async (route) => {
    if (reviewerSaveStarted || !reviewerSaveMatches(route.request(), frame, draft, signer?.reviewer)) {
      error ||= new Error('学校保存加签人的请求与原单或已选人员不一致。');
      await route.abort().catch(() => undefined);
      return;
    }
    reviewerSaveStarted = true;
    await route.fallback();
  };
  const guard = async (route) => {
    const request = route.request();
    const body = new URLSearchParams(request.postData() || '');
    const values = Array.from(body, ([key, value]) => /(?:threeapprover|selectapprover|addapprover|addsign)/i.test(key) ? normalize(value) : '').filter(Boolean);
    // The school's synchronous SaveThreeApprover callback initiates final submission only after success.
    // Waiting for that response body here would block the callback and the final request.
    const signed = signer?.reviewer ? reviewerSaveStarted : signer &&
      values.some((value) => value === signer.code || value === signerValue(signer.code, plan.signer.name));
    if (checkedFinalRequest || request.frame() !== frame || request.method() !== 'POST' || String(body.get('p_IsThree')).toLowerCase() !== 'true' ||
        String(body.get('p_DeclareID')).toLowerCase() !== draft.declareId.toLowerCase() || !signed) {
      error ||= new Error('学校提交请求尚未确认原单、线上审批或指定加签人。请核对学校页面。');
      await route.abort().catch(() => undefined);
      return;
    }
    checkedFinalRequest = true;
    try {
      await beforeSubmit(signer.code);
      attempted = true;
      await route.fallback();
    } catch (cause) {
      const stopped = await route.abort().then(() => true, () => false);
      error ||= stopped && !attempted && cause.code === 'PAYROLL_SKIP_SUBMIT'
        ? Object.assign(cause, { code: 'PAYROLL_SUBMIT_PAUSED' }) : cause;
    }
  };
  const onResponse = async (response) => {
    if (response.url().split('?')[0] !== finalPath || response.frame() !== frame) return;
    result = await response.json().catch(() => ({}));
  };
  const approval = frame.locator('#temp_div_ThreeApprover:visible');
  await page.route(finalPath + '*', guard);
  await page.route(reviewerPath + '*', saveReviewer);
  page.on('response', onResponse);
  try {
    await checkpoint();
    let confirmedOnline = await approval.isVisible() || await acceptPayrollDialog(frame, onlineConfirmation);
    if (!confirmedOnline) await activateSchoolControl(submit, '无法打开学校薪酬提交确认。');
    let confirmedAttachments = false;
    for (let step = 0; step < 50 && !result && !error; step += 1) {
      signal.throwIfAborted();
      if (!confirmedOnline) confirmedOnline = await acceptPayrollDialog(frame, onlineConfirmation);
      if (confirmedOnline && !confirmedAttachments) confirmedAttachments = await acceptPayrollDialog(frame, optionalAttachments);
      if (!signer && await approval.isVisible()) {
        stage?.('正在选择加签人');
        signer = await fillApprover(approval, options);
        const finish = payrollAction(approval, '确定', '确认', '提交', '确认提交', '保存', '保存并提交');
        if (await finish.count() !== 1 || !await finish.isEnabled()) throw new Error('学校加签窗口未显示可用的确认按钮。');
        if (signer.reviewer && await finish.getAttribute('onclick') !== 'ThreeApprover()') throw new Error('学校加签确认的处理方式有变化。');
        await checkpoint();
        await beforeApproval(signer.code);
        await activateSchoolControl(finish, '无法确认学校薪酬加签。');
      }
      if (!attempted) {
        const messages = await frame.getByText(schoolValidation).filter({ visible: true }).allInnerTexts();
        const validation = messages.join(' ').match(schoolValidation)?.[0];
        if (validation) throw new Error('学校提示「' + validation.replace(/[!！]$/, '') + '」。');
      }
      await delay(250, undefined, { signal });
    }
    if (error) throw error;
    if (!attempted) throw new Error('学校尚未进入本笔薪酬的最终线上提交。请查看当前校方校验提示。');
  } finally {
    page.off('response', onResponse);
    await page.unroute(reviewerPath + '*', saveReviewer);
    await page.unroute(finalPath + '*', guard);
  }
}
