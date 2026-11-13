import { createHmac } from 'node:crypto';
import { activateSchoolControl, openDailyBookingForm, openSchoolFinanceWorkspace } from './school-finance-access.mjs';
import { normalizeClaimReason } from './claim-purpose.mjs';

export const STUDENT_PAYROLL = '学生劳务费';
const rosterPath = '/SFP_Claims1Self/Com_ClaimsSelfWidget/GetPersonSelectList';

export async function searchSchoolStudents(page, { name, key, signal }) {
  const workspace = await openSchoolFinanceWorkspace(page, { kind: 'legacy', signal });
  if (!workspace.frame) throw new Error(workspace.message);
  try {
    const { frame } = workspace;
    await openDailyBookingForm(frame);
    await activateSchoolControl(frame.locator('#id_paytype:visible'), '学校人员查询入口暂不可用。', 11000);
    const bank = frame.getByLabel('教职工银行卡-建设银行', { exact: true })
      .and(frame.locator('input[type="checkbox"][name="chk_SOS_SettlementType"]'));
    await bank.waitFor({ state: 'attached', timeout: 9000 });
    if (await bank.count() !== 1) throw new Error('学校未显示唯一的人员查询入口。');
    await bank.evaluate((element) => { if (!element.checked) element.click(); });
    const chooser = frame.locator('#div_ClaimsOrderAccountsPayableSettlement [onclick^="fun_SOS_selectPerson("]:visible');
    await activateSchoolControl(chooser, '学校未显示人员选择窗口。', 10000);
    const dialog = frame.locator('#tmp_div_Person_SelectList:visible');
    const query = dialog.locator('input[name^="txt_Select_Person_EmpCodeName_"]:visible');
    await query.waitFor({ state: 'visible', timeout: 10000 });
    const selected = await dialog.locator('#dp_COM_PersonType').evaluate((element) => {
      const widget = window.jQuery(element).data('kendoDropDownList');
      const student = Array.from(widget.dataSource.view()).find((item) => String(item[widget.options.dataTextField]).trim() === '学生');
      if (!student) return false;
      widget.value(String(student[widget.options.dataValueField]));
      widget.trigger('change');
      return widget.text().trim() === '学生';
    });
    if (!selected) throw new Error('学校人员类别未切换到学生。');

    await frame.waitForFunction(() => {
      const grid = window.jQuery('#tmp_div_Person_SelectList .k-grid').data('kendoGrid');
      return grid && !grid.dataSource._requestInProgress;
    }, undefined, { timeout: 11000 });
    await query.fill(name);
    const loaded = frame.page().waitForResponse((response) => {
      const url = new URL(response.url());
      return url.hostname === 'cwc.suibe.edu.cn' && url.pathname === rosterPath;
    }, { timeout: 12000 }).catch(() => null);
    await activateSchoolControl(dialog.getByText('筛选', { exact: true }).filter({ visible: true }), '学校未显示人员筛选按钮。');
    if (!(await loaded)?.ok()) throw new Error('学校没有返回本次人员搜索结果。');
    await frame.waitForFunction(() => {
      const grid = window.jQuery('#tmp_div_Person_SelectList .k-grid').data('kendoGrid');
      return grid && !grid.dataSource._requestInProgress;
    }, undefined, { timeout: 11000 });

    const result = await dialog.locator('.k-grid').evaluate((element) => {
      const grid = window.jQuery(element).data('kendoGrid');
      if (!['Name', 'Code', 'OrgName'].every((field) => grid.columns.some((column) => column.field === field))) return null;
      const rows = Array.from(grid.dataSource.view(), ({ Name, Code, OrgName }) => ({ Name, Code, OrgName }));
      return { total: grid.dataSource.total(), rows };
    });
    if (!result || !Number.isSafeInteger(result.total)) throw new Error('学校人员搜索结果的字段有变化。');
    const people = result.rows.flatMap(({ Name, Code, OrgName }) => {
      const code = String(Code || '').trim().toUpperCase();
      const personName = normalizeClaimReason(Name);
      if (!personName || !/^[A-Z\d-]{4,40}$/.test(code) || !/^[A-Z\d]{4}$/.test(code.slice(-4))) return [];
      return [{
        key: createHmac('sha256', Buffer.from(key, 'hex')).update([STUDENT_PAYROLL, 'code', code].join('\0')).digest('hex'),
        category: STUDENT_PAYROLL,
        name: personName,
        identityTail: code.slice(-4),
        organization: normalizeClaimReason(OrgName).slice(0, 100),
        source: 'school',
      }];
    });
    return { people, complete: result.total === people.length };
  } finally {
    await workspace.close();
  }
}
