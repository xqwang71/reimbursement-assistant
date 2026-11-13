import { setTimeout as delay } from 'node:timers/promises';
import { activateSchoolControl, openDailyBookingForm, schoolFinanceLink } from './school-finance-access.mjs';
import { normalizeClaimReason } from './claim-purpose.mjs';

const projectInput = 'input[name="ddl_FundProject_input"]:visible';
const budgetCheckbox = 'input[type="checkbox"][name="chk_fundproject_jxp"]';
const paperField = 'input[id="txt_SOS㊙ReceiptNumber"]';
const priceField = '#div_ExpendProInfo_Tabs input[name$="㊙PayAmount"]:visible';
const purposeField = '#div_ExpendProInfo_Tabs input[name$="㊙Remark"]:visible';
const bookingGrid = '#grid_COQ_OrderList';
const acceptedStatus = /^(?:提交|已提交|预收|审批中|已审批|已审核|已制单|已预约)$/;
const guidPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const cents = (amount) => {
  const text = String(amount ?? '').replace(/[,，\s￥¥]/g, '');
  return /^\d+(?:\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;
};
const dateKey = (value) => String(value ?? '').replace(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?/, (_, y, m, d) =>
  [y, m.padStart(2, '0'), d.padStart(2, '0')].join('-')).slice(0, 10);
const chinaDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' }).format(new Date());

async function waitFor(read, signal, timeout = 11000) {
  const deadline = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    const value = await read();
    if (value) return value;
    await delay(240, undefined, { signal });
  } while (Date.now() < deadline);
  return null;
}

async function field(locator, message, timeout = 10000) {
  await locator.waitFor({ state: 'visible', timeout }).catch(() => { throw new Error(message); });
  if (await locator.count() !== 1) throw new Error(message);
  return locator;
}

const click = (frame, name, message, timeout) => activateSchoolControl(schoolFinanceLink(frame, name), message, timeout);

async function chooseProject(frame, plan, signal, checkpoint, ask) {
  if (!await frame.locator(projectInput).count()) await click(frame, '添加经费项目', '学校表单未显示「添加经费项目」。');
  await field(frame.locator(projectInput), '学校未打开经费项目选择框。');
  const code = plan.project.projectNo.trim().toUpperCase();
  await frame.evaluate((code) => window.jQuery('#ddl_FundProject').data('kendoComboBox').search(code), code);
  const options = frame.locator('#ddl_FundProject_listbox li:visible');
  const option = await waitFor(async () => {
    const matches = (await options.allTextContents()).flatMap((label, index) =>
      (label.toUpperCase().match(/[A-Z][A-Z\d]*(?:-[A-Z\d]+)+/g) || []).includes(code) ? [index] : []);
    return matches.length === 1 ? options.nth(matches[0]) : null;
  }, signal);
  if (!option) throw new Error('学校经费列表未找到唯一的项目 ' + plan.project.projectNo + '。');
  await activateSchoolControl(option, '学校经费项目暂不可选。');
  const selected = await frame.evaluate(() => String(window.jQuery('#ddl_FundProject').data('kendoComboBox').dataItem()?.Value || ''));
  if (!guidPattern.test(selected || '')) throw new Error('学校经费列表未找到唯一的项目 ' + plan.project.projectNo + '。');
  const rows = frame.locator(budgetCheckbox);
  const readRows = () => rows.evaluateAll((inputs) => inputs.flatMap((input, index) => {
    const row = input.closest('tr');
    if (!row?.getClientRects().length) return [];
    const cells = [...row.cells].map((cell) => cell.textContent.trim());
    if (cells.length !== 5) return [];
    return [{ index, label: cells[0], balance: cells[1], business: cells[2] }];
  }));
  const choices = await waitFor(async () => {
    const found = await readRows();
    return found.length ? found : null;
  }, signal);
  if (!choices) throw new Error('所选项目在学校系统未显示可用的支出项。');
  const available = choices.filter((item) => item.business === '日常报销' && cents(item.balance) !== null && cents(item.balance) >= plan.totalCny);
  if (!available.length) throw new Error('所选项目的日常报销支出项没有足够的学校可用余额。');
  const matching = available.filter((item) => plan.expenseType && item.label.includes(plan.expenseType));
  let chosen = matching.length === 1 ? matching[0] : available.length === 1 ? available[0] : null;
  if (!chosen) {
    const labels = available.map((item) => item.label).join('、');
    for (let attempt = 0; attempt < 3 && !chosen; attempt += 1) {
      const answer = await ask('这项经费有多个可用支出项，请回复其中一项名称。' + labels, { kind: 'school_expense' });
      chosen = available.find((item) => item.label === String(answer || '').trim());
    }
    if (!chosen) throw new Error('未选定学校支出项。可用支出项为 ' + labels + '。');
  }
  await checkpoint();
  if (!(await readRows()).some((item) => item.index === chosen.index && item.label === chosen.label && cents(item.balance) >= plan.totalCny)) {
    throw new Error('学校经费项目或余额已变化，请继续核对。');
  }
  const exact = rows.nth(chosen.index);
  await exact.evaluate((element) => { if (!element.checked) element.click(); });
  if (!await exact.isChecked()) throw new Error('学校支出项未勾选成功。');
  await click(frame, '确定', '学校经费项目选择框未显示唯一的确定按钮。');
  return { projectId: selected.toLowerCase(), expenseLabel: chosen.label };
}

async function setMoney(control, totalCny, message) {
  const target = await field(control, message);
  const amount = (totalCny / 100).toFixed(2);
  await target.fill(amount);
  await target.blur();
  if (cents(await target.inputValue()) !== totalCny) throw new Error(message);
}

async function fillPayment(frame, plan, signal, paymentLabel) {
  const employee = await frame.locator('#txtEmployeeNo').inputValue({ timeout: 3000 }).catch(() => '');
  const employeeName = await frame.locator('#txtEmployeeName').inputValue({ timeout: 3000 }).catch(() => '');
  if (!employee.trim() || !employeeName.trim()) throw new Error('学校表单未带出当前报销人的姓名和工号。');
  const add = frame.locator('#id_paytype:visible');
  if (await add.count() === 1) await activateSchoolControl(add, '学校未打开支付类型。');
  const bank = frame.getByLabel(paymentLabel, { exact: true }).and(frame.locator('input[type="checkbox"][name="chk_SOS_SettlementType"]'));
  await bank.waitFor({ state: 'attached', timeout: 9000 }).catch(() => { throw new Error('学校未显示设置中的支付类型：' + paymentLabel); });
  if (await bank.count() !== 1) throw new Error('学校未显示唯一的支付类型：' + paymentLabel);
  await bank.evaluate((element) => { if (!element.checked) element.click(); });
  const payee = await field(frame.locator('input[name="txt_SOS_STNo"]:visible'), '学校未显示教职工收款行。');
  const payeeReady = () => payee.evaluate((input, identity) => {
    const row = input.closest('tr');
    const name = row.querySelector('input[name="txt_SOS_STName"]')?.value.trim();
    const hasAccount = [...row.querySelectorAll('input[name="txt_SOS_STCardNo"],input[id$="㊙CardNo"]')].some((field) => field.value.trim());
    return input.value.trim() === identity.employee && name === identity.employeeName && hasAccount;
  }, { employee: employee.trim(), employeeName: employeeName.trim() });
  if (!await payeeReady()) {
    await payee.fill(employee.trim());
    await payee.blur();
  }
  if (!await waitFor(payeeReady, signal, 4800)) {
    const dialog = frame.locator('#tmp_div_Person_SelectList:visible');
    if (!await dialog.count()) {
      const search = frame.locator('#div_ClaimsOrderAccountsPayableSettlement [onclick^="fun_SOS_selectPerson("]:visible');
      await activateSchoolControl(search, '学校未显示本人账户搜索入口。');
    }
    const filter = await field(dialog.locator('input[name^="txt_Select_Person_EmpCodeName_"]:visible'), '学校未打开人员查询。');
    await filter.fill(employee.trim());
    await click(dialog, '筛选', '学校人员查询未显示筛选按钮。');
    const grid = dialog.locator('.k-grid tbody tr');
    const match = await waitFor(async () => {
      const indices = await grid.evaluateAll((rows, identity) => rows.flatMap((row, index) => {
        const cells = [...row.cells].map((cell) => cell.textContent.trim());
        return cells.includes(identity.employee) && cells.includes(identity.employeeName) ? [index] : [];
      }), { employee: employee.trim(), employeeName: employeeName.trim() });
      return indices.length === 1 ? grid.nth(indices[0]) : null;
    }, signal);
    if (!match) throw new Error('学校人员库未找到当前报销人唯一的收款账户。');
    await match.dblclick({ timeout: 7000 });
  }
  if (!await waitFor(payeeReady, signal, 7000)) {
    throw new Error('学校未带出本人收款账户。');
  }
  await setMoney(frame.locator('input[name="txt_SOS_STAmount"]:visible'), plan.totalCny, '学校支付金额未填入。');
  if (cents(await frame.locator('#txt_SOS_SettlementAmount').inputValue({ timeout: 4000 })) !== plan.totalCny) throw new Error('学校显示的支付合计与核定金额不一致。');
}

async function fillPaperCount(frame, plan) {
  const line = await field(frame.locator('#div_ExpendProInfo_Tabs input[name$="㊙InvoiceNumber"]:visible'), '学校未显示支出项的纸质附件张数。');
  const filled = await line.evaluate((element, value) => {
    const widget = window.jQuery?.(element).data('kendoNumericTextBox');
    if (!widget) return false;
    widget.value(value);
    widget.trigger('change');
    return true;
  }, plan.attachmentCount);
  if (!filled) {
    await line.fill(String(plan.attachmentCount));
    await line.blur();
  }
  if (Number(await line.inputValue()) !== plan.attachmentCount ||
      Number(await frame.locator(paperField).inputValue({ timeout: 5000 })) !== plan.attachmentCount) {
    throw new Error('学校显示的纸质附件张数与本笔不符。');
  }
}

async function chooseAppointment(frame, signal, campus) {
  const calendar = frame.locator('#div_ClaimsOrderAccountsPayableReserveDate');
  const options = calendar.locator('span[timerangeid]');
  const today = chinaDay();
  const read = () => options.evaluateAll((nodes, name) => {
    const month = document.querySelector('#dp_CCM_Month')?.value;
    const year = document.querySelector('#dp_CCM_Year')?.value;
    if (!/^\d{1,2}$/.test(month) || !/^\d{4}$/.test(year)) return [];
    return nodes.flatMap((node, index) => {
      if (!node.getClientRects().length || node.textContent.trim() !== '可约') return [];
      const table = node.closest('table');
      const day = table?.parentElement?.id.match(/^div㊙(\d{1,2})$/)?.[1];
      const location = node.closest('ul[ullocalcode]')?.getAttribute('ullocalcode');
      if (!day || !location || !table.innerText.includes(name)) return [];
      return [{ index, date: [year, month, day].join('-'), label: node.parentElement.innerText.trim(), location }];
    });
  }, campus);
  const choices = await waitFor(async () => {
    const slots = (await read()).filter((slot) => dateKey(slot.date) > today).sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
    return slots.length ? slots : null;
  }, signal);
  if (!choices) throw new Error('学校暂未显示' + campus + '校区可预约的后续时段。');
  const chosen = choices[0];
  await activateSchoolControl(options.nth(chosen.index), '学校预约时段暂不可选。');
  const selected = await waitFor(() => frame.evaluate(() => ({
    date: document.querySelector('#HidReserveDate')?.value,
    slot: document.querySelector('#HidReserveTimeRangeID')?.value,
    location: document.querySelector('#HidLocalCode')?.value,
  })).then((value) => value.slot && value.location ? value : null), signal, 5500);
  if (!selected || selected.location !== chosen.location || dateKey(selected.date) !== dateKey(chosen.date)) throw new Error('学校未选定本次预约时段。');
  return { date: dateKey(chosen.date), label: chosen.label, slotId: selected.slot, campusCode: selected.location, campus };
}

export async function fillDailyBooking(frame, { plan, progress, signal, checkpoint, ask, log, persist, campus = '松江', legacyPaymentLabel = '教职工银行卡-建设银行' }) {
  const saved = progress.booking;
  if (!saved?.orderId) await openDailyBookingForm(frame);
  const formId = await frame.locator('#Hid_OrderId').inputValue({ timeout: 9000 }).catch(() => '');
  if (!guidPattern.test(formId) || saved?.orderId && formId.toLowerCase() !== saved.orderId) throw new Error('找不到本笔线下报销的学校原表单。');
  const reason = await field(frame.locator('#txt_Remark:visible'), '学校未显示报销事由。');
  const currentReason = (await reason.inputValue()).trim();
  if (currentReason && currentReason !== plan.reason) throw new Error('学校表单已有其他事项，请核对后再继续。');
  if (plan.reason.length > 200) throw new Error('学校支出用途最多 200 字，请缩短事由。');
  if (!await frame.locator('#txt_CLUI_Mobile').inputValue({ timeout: 4000 }).catch(() => '')) throw new Error('学校财务表单需要报销人手机号，请补全学校个人资料后继续。');
  progress.booking ||= { orderId: formId.toLowerCase() };
  await persist();

  await checkpoint();
  await reason.fill(plan.reason);
  await reason.blur();
  if (!progress.booking.projectId) {
    const selection = await chooseProject(frame, plan, signal, checkpoint, ask);
    Object.assign(progress.booking, selection);
    await persist();
  }
  await setMoney(frame.locator(priceField), plan.totalCny, '学校支出项报销金额未填入。');
  const purpose = await field(frame.locator(purposeField), '学校未显示支出项用途。');
  await purpose.fill(plan.reason);
  await purpose.blur();
  if (cents(await frame.locator('#SumAmount').inputValue({ timeout: 5000 })) !== plan.totalCny) throw new Error('学校显示的报销合计与核定金额不一致。');
  log('核对经费与金额', progress.booking.expenseLabel);
  await checkpoint();
  await fillPaperCount(frame, plan);
  log('填写纸质附件', String(plan.attachmentCount) + ' 张');
  await checkpoint();
  progress.booking.appointment = await chooseAppointment(frame, signal, campus);
  await persist();
  log('预约' + campus + '校区', progress.booking.appointment.date + ' ' + progress.booking.appointment.label);
  await checkpoint();
  await fillPayment(frame, plan, signal, legacyPaymentLabel);
  return progress.booking;
}

export async function readDailyBookingReceipt(frame, plan, booking, financeFormId, signal) {
  const orderField = frame.locator('#txt_COQ_OrderNo:visible');
  if (!await orderField.count()) {
    const tab = frame.locator('#OrderQuery:visible').filter({ hasText: '报销单查询' });
    await activateSchoolControl(tab, '学校未显示「报销单查询」。', 12000);
  }
  await field(orderField, '学校未打开报销单查询。');
  await orderField.fill(financeFormId || '');
  const reason = await field(frame.locator('#txt_COQ_Remark:visible'), '学校查询未显示报销事由。');
  await reason.fill(financeFormId ? '' : plan.reason);
  const query = frame.getByRole('link', { name: '查询', exact: true }).or(frame.getByRole('button', { name: '查询', exact: true })).filter({ visible: true });
  await activateSchoolControl(query, '学校未显示唯一的查询按钮。');
  return waitFor(async () => {
    const receipt = await frame.locator(bookingGrid).evaluate((element, orderId) => {
      const grid = window.jQuery(element).data('kendoGrid');
      if (!grid || grid.dataSource._requestInProgress) return null;
      const rows = grid.dataSource.view().filter((row) => String(row.OrderID).toLowerCase() === orderId);
      if (rows.length !== 1) return null;
      const { OrderNo, OrderStateName, SettlementAmount, ActualAmount, ProjectNameList, ProjectIDList, Remark,
        LocalName, LocalCode, ReserveDate_Str, ReserveTimeRangeID, TotalAttachments } = rows[0];
      return { OrderNo, OrderStateName, SettlementAmount, ActualAmount, ProjectNameList, ProjectIDList, Remark,
        LocalName, LocalCode, ReserveDate_Str, ReserveTimeRangeID, TotalAttachments };
    }, booking.orderId).catch(() => null);
    if (!receipt || !/^\d{13}$/.test(receipt.OrderNo) || financeFormId && financeFormId !== receipt.OrderNo || !acceptedStatus.test(receipt.OrderStateName)) return null;
    const projectCodes = String(receipt.ProjectNameList || '').toUpperCase().match(/[A-Z][A-Z\d]*(?:-[A-Z\d]+)+/g) || [];
    const projectIds = String(receipt.ProjectIDList || '').toLowerCase().match(/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/g) || [];
    if (!projectCodes.includes(plan.project.projectNo.toUpperCase()) && !projectIds.includes(booking.projectId)) return null;
    const listedAttachments = String(receipt.TotalAttachments ?? '').trim();
    const campus = booking.appointment.campus || '松江';
    const location = String(receipt.LocalName || '').trim();
    const sameCampus = location === campus || location === campus + '校区' || location === campus + '本部';
    if (cents(receipt.SettlementAmount) !== plan.totalCny || (Number(receipt.ActualAmount) > 0 && cents(receipt.ActualAmount) !== plan.totalCny) ||
      normalizeClaimReason(receipt.Remark) !== plan.reason || (listedAttachments !== '0' && Number(listedAttachments) !== plan.attachmentCount) ||
      !sameCampus || dateKey(receipt.ReserveDate_Str) !== booking.appointment.date) return null;
    return { financeFormId: receipt.OrderNo, schoolStatus: receipt.OrderStateName };
  }, signal, 10500);
}

export function watchAppointmentPdf(frame, orderId) {
  const page = frame.page();
  const previews = new Set();
  const onPopup = (popup) => previews.add(popup);
  let result;
  const record = (response) => {
    const url = new URL(response.url());
    if (url.hostname !== 'cwc.suibe.edu.cn' || !url.pathname.endsWith('/COQ_ClaimsOrderQuery/Op_Order_Print') ||
        !response.ok() || !/application\/pdf/i.test(response.headers()['content-type'] || '')) return;
    const request = response.request();
    if (!(url.search + (request.postData() || '')).toLowerCase().includes(orderId)) return;
    result = response.body().catch(() => null);
  };
  page.on('response', record);
  page.on('popup', onPopup);
  return {
    async bytes(signal, timeout = 5000) {
      return waitFor(async () => {
        if (result) {
          const document = await result;
          if (document) return document;
        }
        for (const popup of previews) {
          const url = popup.url();
          if (!url.startsWith('blob:https://cwc.suibe.edu.cn/')) continue;
          const encoded = await frame.evaluate(async (address) => {
            const response = await fetch(address, { signal: AbortSignal.timeout(3500) });
            const blob = await response.blob();
            if (!response.ok || !/^application\/pdf\b/i.test(blob.type) || blob.size > 32 * 1024 * 1024) return null;
            return new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(blob);
            });
          }, url).catch(() => null);
          if (encoded) return Buffer.from(encoded, 'base64');
        }
        return null;
      }, signal, timeout);
    },
    stop() {
      page.off('response', record);
      page.off('popup', onPopup);
    },
  };
}

export async function submitDailyBooking(frame, signal) {
  const response = frame.page().waitForResponse((item) => {
    const url = new URL(item.url());
    return url.hostname === 'cwc.suibe.edu.cn' && url.pathname.endsWith('/COC_ClaimsOrderCreateDaily/Save_DailyOrder') &&
      item.request().method() === 'POST';
  }, { timeout: 20000 }).catch(() => null);
  await click(frame, '保存并提交', '学校未显示「保存并提交」。');
  const result = await response;
  const data = await result?.json().catch(() => null);
  if (data?.Successed === false) {
    const description = data.Tag || data.FailReasonDesc || '学校返回提交失败。';
    return frame.evaluate((html) => new DOMParser().parseFromString(String(html), 'text/html').body.textContent
      .trim().replace(/\d{6,}/g, '…').slice(0, 160), description).catch(() => '学校返回提交失败。');
  }
  if (data?.Successed !== true || !data.Tag) return;
  const tag = await frame.evaluate((html) => new DOMParser().parseFromString(String(html), 'text/html').body.textContent.trim(), data.Tag);
  if (!tag) return;
  const confirmation = frame.locator('.k-window:visible').filter({ hasText: tag }).getByRole('button', { name: '确定', exact: true })
    .or(frame.locator('.k-window:visible').filter({ hasText: tag }).getByRole('link', { name: '确定', exact: true }));
  if (await waitFor(async () => await confirmation.count() === 1, signal, 4500)) {
    await activateSchoolControl(confirmation, '学校已收到预约，正在核对查询结果。').catch(() => undefined);
  }
}

export async function reprintDailyBooking(frame, orderId, financeFormId, signal) {
  const buttons = frame.locator(`${bookingGrid} a[onclick^="fun_COQ_Print("]:visible`).filter({ hasText: /^\s*打印\s*$/ });
  const indices = await buttons.evaluateAll((controls, identity) => {
    const grid = window.jQuery('#grid_COQ_OrderList').data('kendoGrid');
    return controls.flatMap((control, index) => {
      const item = grid?.dataItem(control.closest('tr'));
      return item && String(item.OrderID).toLowerCase() === identity.orderId && item.OrderNo === identity.financeFormId ? [index] : [];
    });
  }, { orderId, financeFormId });
  if (indices.length !== 1) throw new Error('报销单查询中未找到本单的唯一打印按钮。');
  const capture = watchAppointmentPdf(frame, orderId);
  try {
    await activateSchoolControl(buttons.nth(indices[0]), '报销单查询中的打印按钮暂不可用。');
    return await capture.bytes(signal, 13500);
  } finally {
    capture.stop();
  }
}
