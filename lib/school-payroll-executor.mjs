import { setTimeout as delay } from 'node:timers/promises';
import { activateSchoolControl, schoolFinanceLink } from './school-finance-access.mjs';
import { fillPayrollHeader, workspaceFor } from './school-finance-runner.mjs';
import { fillPayrollDetails, submitPayroll, verifyPayrollDetails, payrollAction } from './school-payroll-details.mjs';
import { schoolPayrollStatus } from './school-payroll-status.mjs';
import { confirmSubmission } from './submission-confirmation.mjs';

const schoolHost = 'cwc.suibe.edu.cn';
const declareAction = '/SFP_SalarySelf/SalaryDeclare/op_CreatDeclare';
const detailView = '#div_SalaryDeclareDetail';
function acceptedSchoolStatus(state) {
  const status = schoolPayrollStatus(state);
  return status && status.state !== 'excluded' ? status.label : '';
}
const normalized = (value) => String(value ?? '').trim().normalize('NFKC');
const cents = (value) => value == null || value === '' ? NaN : Math.round(Number(String(value).replace(/,/g, '')) * 100);

async function verifyBudget(frame, totalCny, signal) {
  const control = frame.locator('#Dp_Controls');
  if (await control.count() !== 1) throw new Error('学校薪酬表单未显示预算额度。');
  await control.evaluate(async (element) => {
    const widget = window.jQuery?.(element).data('kendoDropDownList');
    if (widget) await widget.dataSource.read();
  });
  let budget;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    signal.throwIfAborted();
    budget = await control.evaluate((element) => {
      const widget = window.jQuery?.(element).data('kendoDropDownList');
      if (!widget || widget.dataSource._requestInProgress) return null;
      const options = Array.from(widget.dataSource.view()).filter((item) =>
        item[widget.options.dataValueField] && !/^请选择/.test(String(item[widget.options.dataTextField] || '')));
      const selected = options.find((item) => String(item[widget.options.dataValueField]) === String(widget.value()));
      if (!selected && options.length === 1) {
        widget.value(String(options[0][widget.options.dataValueField]));
        widget.trigger('change');
      }
      const item = widget.dataItem();
      const balance = document.querySelector('#s_BudgetBalance')?.textContent?.trim() || '';
      return { choices: options.length, selected: Boolean(widget.value() && item && widget.text().trim() && !/^请选择/.test(widget.text())), balance };
    });
    if (budget?.choices) break;
    await delay(350, undefined, { signal });
  }
  if (!budget?.choices) throw new Error('学校未返回所选经费项目的薪酬预算额度。请核对该项目的劳务费额度和授权。');
  if (!budget.selected) throw new Error('学校给出了多个薪酬预算额度，无法确认应使用哪一项。');
  const amount = budget.balance.match(/^\s*[￥¥]?\s*([\d,.]+)\s*(?:元)?\s*$/)?.[1];
  if (amount && cents(amount) < totalCny) throw new Error('学校可用薪酬额度低于本笔应发合计。');
}

async function selectCategory(frame, category) {
  const categoryLink = schoolFinanceLink(frame, category).and(frame.locator('a.linkTab'));
  await activateSchoolControl(categoryLink, '学校未找到本笔申报的薪酬套类。');
  const declare = frame.getByText('薪资申报', { exact: true }).filter({ visible: true });
  if (await declare.count() === 1) await activateSchoolControl(declare, '学校薪资申报页面暂不可用。');
}

async function createDraft(frame, options, draft, checkpoint) {
  const { plan, payroll, signal, persist, validate, log } = options;
  if (!await frame.locator('a.linkTab:visible').count()) {
    const back = payrollAction(frame.locator(detailView), '返回');
    if (await back.count() === 1) await activateSchoolControl(back, '学校薪酬明细未返回申报清单。');
  }
  await fillPayrollHeader(frame, options);
  await verifyBudget(frame, plan.totalCny, signal);
  const header = frame.locator('#temp_div_CreatDeclare');
  const save = schoolFinanceLink(header, '保存').and(frame.locator('a[onclick="SavelDeclare();"]'));
  if (await save.count() !== 1) throw new Error('学校薪酬申报抬头未显示唯一的「保存」。');
  const periodId = await frame.locator('#Hid_Period').inputValue({ timeout: 3000 });
  if (!periodId) throw new Error('学校没有返回本次申报的发放期间。');
  await validate();
  await checkpoint();
  draft.periodId = periodId;
  draft.draftAttemptedAt = new Date().toISOString();
  await persist();
  const response = frame.page().waitForResponse((reply) => {
    const url = new URL(reply.url());
    return url.hostname === schoolHost && url.pathname === declareAction && reply.frame() === frame;
  }, { timeout: 14000 }).catch(() => null);
  await activateSchoolControl(save, '未能操作学校薪酬申报的保存按钮。');
  const reply = await response;
  const result = reply?.ok() ? await reply.json().catch(() => null) : null;
  const status = result?.Errors?.rs?.errors?.[0];
  if (typeof status === 'string' && status !== 'Successed') {
    delete draft.draftAttemptedAt;
    await persist();
    throw new Error('学校拒绝保存薪酬申报抬头。请查看学校页面提示后回复「继续」。');
  }
  const id = String(result?.Data?.[0] || '');
  if (status !== 'Successed' || !/^[A-Za-z0-9-]{1,80}$/.test(id)) {
    throw new Error('学校未返回薪酬草稿编号。请在薪资申报列表核对是否已有本笔草稿。');
  }
  draft.declareId = id;
  await persist();
  log('已建立学校薪酬草稿', payroll.category + ' · ' + plan.project.projectNo);
}

async function declaration(frame, id) {
  return frame.evaluate(async (id) => {
    let summary = null;
    if (typeof window.execAjax !== 'function') return summary;
    window.execAjax('SalaryDeclare', 'GetSalaryDeclareEn', { p_DeclareID: id }, (data) => {
      if (String(data?.DeclareID).toLowerCase() !== id.toLowerCase()) return;
      const { DeclareBillNo, ProjectCode, GrantContent, GrantNum, ShouldAmount, State, IsThree, ThreeState, ThreeApprover, LatoryID } = data;
      summary = { DeclareBillNo, ProjectCode, GrantContent, GrantNum, ShouldAmount, State, IsThree, ThreeState, ThreeApprover, LatoryID };
    });
    if (summary && summary.GrantContent == null) {
      // The school can omit GrantContent in its JSON even when the original declaration saved it.
      const path = '/SFP_SalarySelf/SalaryDeclareDetail/Ctrl_SalaryDeclare_DetailOperate';
      const type = document.querySelector('#Hid_SubmitAuditType')?.value || '0';
      const response = await fetch(path, {
        method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(6500),
        body: new URLSearchParams({ p_DeclareID: id, p_SubmitAuditType: type }),
      });
      if (!response.ok) return summary;
      const original = new DOMParser().parseFromString(await response.text(), 'text/html');
      if (original.querySelector('#Hid_DeclareID')?.value?.toLowerCase() !== id.toLowerCase()) return summary;
      const labels = Array.from(original.querySelectorAll('tr > th')).filter((heading) =>
        /^发放内容\s*[:：]?\s*$/.test(heading.textContent.trim()));
      if (labels.length === 1 && labels[0].nextElementSibling?.matches('td')) {
        summary.GrantContent = labels[0].nextElementSibling.textContent;
      }
      const count = original.querySelector('#GrantNum')?.textContent?.trim();
      const amount = original.querySelector('#ShouldAmount')?.textContent?.trim();
      if (/^\d+$/.test(count || '')) summary.GrantNum = count;
      if (/^[\d,]+(?:\.\d{1,2})?$/.test(amount || '')) summary.ShouldAmount = amount;
    }
    return summary;
  }, id);
}

function sameProject(summary, plan) {
  return normalized(summary?.ProjectCode).toUpperCase() === normalized(plan.project.projectNo).toUpperCase();
}

function sameHeader(summary, plan) {
  return sameProject(summary, plan) && normalized(summary?.GrantContent) === normalized(plan.reason);
}

async function openDraft(frame, draft, plan, category) {
  const result = await declaration(frame, draft.declareId);
  if (!result) throw new Error('学校未返回这笔薪酬原草稿。');
  if (!sameProject(result, plan)) throw new Error('学校原草稿的经费项目与本机事项不一致。');
  if (!normalized(result.GrantContent)) throw new Error('学校原草稿未返回发放内容。');
  if (normalized(result.GrantContent) !== normalized(plan.reason)) throw new Error('学校原草稿的发放内容与本机事项不一致。');
  if (normalized(result.State) !== '0') throw new Error('学校原单已不处于未提交状态，请核对当前单据。');
  const number = normalized(result.DeclareBillNo);
  if (/^[A-Za-z0-9-]{4,80}$/.test(number)) draft.financeFormId = number;
  const success = frame.locator('.k-window:visible, [role="dialog"]:visible')
    .filter({ hasText: /创建成功[!！]\s*是否现在开始编辑[?？]/ });
  const okay = payrollAction(success, '确定');
  const detail = frame.locator(detailView);
  if (await okay.count() === 1) {
    await activateSchoolControl(okay, '学校草稿已创建，无法进入明细编辑。');
  } else {
    const cancel = frame.locator('#temp_div_SelectPerson:visible a[onclick="CancelSelectPeople()"]:visible');
    const currentId = await detail.locator('#Hid_DeclareID').inputValue({ timeout: 700 }).catch(() => '');
    if (currentId.toLowerCase() === draft.declareId.toLowerCase() && await cancel.count() === 1) {
      await activateSchoolControl(cancel, '无法关闭原草稿上的旧人员搜索。');
    }
    if (!await frame.locator('#Hid_SubmitAuditType').count()) await selectCategory(frame, category);
    await frame.evaluate(({ declareId, periodId }) => {
      if (typeof window.JumpSalaryDetailDeclare !== 'function') throw new Error('学校未加载薪酬明细编辑入口。');
      window.JumpSalaryDetailDeclare(declareId, periodId);
    }, draft);
  }
  await payrollAction(detail, '返回').waitFor({ state: 'visible', timeout: 9000 })
    .catch(() => { throw new Error('学校薪酬草稿已建立，发放明细页未打开。'); });
  const id = await detail.locator('#Hid_DeclareID').inputValue({ timeout: 3500 }).catch(() => '');
  if (id.toLowerCase() !== draft.declareId.toLowerCase()) throw new Error('学校发放明细页的草稿编号与本笔不一致。');
  return detail;
}

async function savedSchoolSigner(frame, draft, plan, item) {
  const { name, employeeNo } = plan.signer;
  if (!employeeNo || !item.LatoryID) return false;
  return frame.evaluate(async ({ declareId, latoryId, expected }) => {
    const query = new URLSearchParams({
      p_DeclareID: declareId, p_LatoryID: latoryId, p_IsFlowAudit: 'True', p_OnlineAuditIsOptional: 'True',
    });
    const response = await fetch('/SFP_SalarySelf/SalaryDeclareDetail/Ctrl_ThreeApprover?' + query, {
      credentials: 'same-origin', signal: AbortSignal.timeout(6500),
    });
    if (!response.ok) return false;
    const view = new DOMParser().parseFromString(await response.text(), 'text/html');
    const selected = Array.from(view.querySelectorAll('#ReviewerMultiplePerson ul li span[id]'));
    return selected.length === 1 && selected[0].textContent.trim().normalize('NFKC') === expected;
  }, { declareId: draft.declareId, latoryId: item.LatoryID, expected: employeeNo + '-' + name }).catch(() => false);
}

async function verifyReceipt(frame, plan, draft, signal, log) {
  if (!draft?.declareId) throw new Error('本笔缺少学校薪酬草稿编号。');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    signal.throwIfAborted();
    const item = await declaration(frame, draft.declareId).catch(() => null);
    const number = normalized(item?.DeclareBillNo);
    const status = acceptedSchoolStatus(item?.State);
    const online = item?.IsThree === true || String(item?.IsThree).toLowerCase() === 'true' || item?.IsThree === 1;
    const approver = normalized(item?.ThreeApprover);
    if (sameHeader(item, plan) && status && online && Number(item.ThreeState) !== 1 &&
        /^[A-Za-z0-9-]{4,80}$/.test(number) && Number(item.GrantNum) === plan.peopleCount && cents(item.ShouldAmount) === plan.totalCny) {
      const signerMatches = draft.signerCode && (!approver || [draft.signerCode, draft.signerCode + '-' + plan.signer.name, plan.signer.name].includes(approver));
      if (signerMatches || await savedSchoolSigner(frame, draft, plan, item)) {
        return { financeFormId: number, schoolStatus: status, verifiedAt: new Date().toISOString() };
      }
    }
    log('核对学校薪酬回执', '正在核对学校单号、项目、线上状态与应发金额（' + attempt + '/3）');
    await delay(750, undefined, { signal });
  }
  throw Object.assign(new Error('学校尚未确认本笔线上审批。回复「继续」可再查原单。'), { code: 'PAYROLL_RECEIPT_PENDING' });
}

export async function executeSchoolPayroll(options) {
  const { plan, payroll, control, openSession, signal, onAccess, persist, validate, record, ask, log, stage = () => {} } = options;
  const { progress } = control;
  if (progress.submission.state === 'verified') {
    await record();
    return 'declared';
  }
  const draft = progress.payroll ||= {};
  const checkpoint = async () => {
    while (control.paused && !control.cancelled) await delay(300, undefined, { signal });
    signal.throwIfAborted();
    if (control.cancelled) throw new Error('用户已停止本笔薪酬申报。');
  };
  await checkpoint();
  const receiptOnly = progress.submission.state !== 'not_started' || Boolean(draft.approvalAttemptedAt);
  if (!receiptOnly) await validate();
  let session;
  let workspace;
  let submitError;
  try {
    stage('正在打开学校薪酬系统');
    session = await openSession();
    workspace = await workspaceFor(session.page, 'labor', signal, onAccess, true);
    const { frame } = workspace;
    stage('正在核对学校原单');
    const original = draft.declareId && !receiptOnly ?
      await declaration(frame, draft.declareId).catch(() => null) : null;
    if (!receiptOnly && !acceptedSchoolStatus(original?.State)) {
      if (!draft.declareId) {
        if (draft.draftAttemptedAt) throw new Error('上次保存未取得学校薪酬草稿编号。请核对学校薪资申报列表中的原草稿。');
        stage('正在保存学校草稿');
        await createDraft(frame, options, draft, checkpoint);
      }
      stage('正在核对学校原单');
      let detail;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await checkpoint();
        try { detail = await openDraft(frame, draft, plan, payroll.category); break; }
        catch (error) {
          if (attempt === 3 || signal.aborted) throw error;
          log('恢复学校发放明细', '在同一笔学校草稿中重新读取明细（' + attempt + '/3）');
          await delay(500, undefined, { signal });
        }
      }
      stage('正在填报发放明细');
      await fillPayrollDetails(detail, { ...options, frame, draft, checkpoint });
      detail = await openDraft(frame, draft, plan, payroll.category);
      await verifyPayrollDetails(detail, { ...options, draft, checkpoint });
      await validate();
      await checkpoint();
      const question = `请核对薪酬申报：${plan.reason}，项目 ${plan.project.projectNo}，${plan.peopleCount} 人，应发 ${(plan.totalCny / 100).toFixed(2)} 元，加签人 ${plan.signer.name}。`;
      if (!await confirmSubmission({ control, ask, validate, checkpoint, question })) return 'preview';
      await verifyPayrollDetails(detail, { ...options, draft, checkpoint });
      try {
        stage('正在进入线上审批');
        await submitPayroll(detail, {
          ...options, frame, draft, checkpoint,
          async beforeApproval(signerCode) {
            await validate();
            await checkpoint();
            if (control.skipSubmit) throw new Error('已停在提交前。');
            draft.signerCode = signerCode;
            draft.approvalAttemptedAt = new Date().toISOString();
            await persist();
            stage('正在确认加签');
          },
          async beforeSubmit(signerCode) {
            await validate();
            await checkpoint();
            if (control.skipSubmit) {
              throw Object.assign(new Error('已停在提交前。'), { code: 'PAYROLL_SKIP_SUBMIT' });
            }
            draft.signerCode = signerCode;
            progress.submission = { state: 'attempted', fingerprint: plan.fingerprint, attemptedAt: new Date().toISOString() };
            await persist();
            stage('正在等学校回执');
            log('提交学校薪酬申报', payroll.category + ' · ' + plan.project.projectNo);
          },
        });
      } catch (error) {
        if (error.code === 'PAYROLL_SUBMIT_PAUSED') {
          delete draft.approvalAttemptedAt;
          await persist();
          stage('已保留学校原草稿');
          return 'preview';
        }
        if (progress.submission.state === 'not_started' && !draft.approvalAttemptedAt) {
          if (control.skipSubmit) return 'preview';
          throw error;
        }
        submitError = error;
      }
    }

    stage('正在核对学校回执');
    const receipt = await verifyReceipt(frame, plan, draft, signal, log).catch((error) => {
      if (!submitError) throw error;
      throw Object.assign(new Error(submitError.message.split('\n')[0] + ' ' + error.message), { code: error.code });
    });
    progress.submission = { ...progress.submission, ...receipt, fingerprint: plan.fingerprint, state: 'verified' };
    await persist();
    await record();
    log('核实学校薪酬回执', receipt.financeFormId + ' · ' + receipt.schoolStatus);
    const success = frame.locator('#extAlertDialog:visible');
    if (await success.count() === 1 && /^提交成功[!！]?$/.test(normalized(await success.innerText()))) {
      const okay = payrollAction(success.locator('..').locator('.k-ext-dialog-buttons:visible'), '确定', '关闭');
      if (await okay.count() === 1) await activateSchoolControl(okay, '学校提交成功提示未关闭。').catch(() => undefined);
    }
    const back = payrollAction(frame.locator(detailView), '返回');
    if (await back.count() === 1) await activateSchoolControl(back, '学校薪酬明细未返回申报清单。').catch(() => undefined);
    return 'declared';
  } catch (error) {
    if (!signal.aborted && workspace?.frame && !session.page.isClosed()) await options.captureSchoolError?.(session.page).catch(() => undefined);
    throw error;
  } finally {
    await workspace?.close(progress.submission.state === 'verified');
    await session?.cleanup?.();
  }
}
