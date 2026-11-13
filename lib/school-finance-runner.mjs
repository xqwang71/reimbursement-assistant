import { setTimeout as delay } from 'node:timers/promises';
import { openPayrollHeader, openSchoolFinanceWorkspace } from './school-finance-access.mjs';
import { fillDailyBooking, readDailyBookingReceipt, reprintDailyBooking, submitDailyBooking, watchAppointmentPdf } from './daily-school-booking.mjs';
import { defaultPrintQueue, printAppointmentPdf, saveAppointmentPdf } from './school-appointment-pdf.mjs';
import { CAMPUS_LOGIN_REQUIRED } from './portal-navigation.mjs';
import { confirmSubmission } from './submission-confirmation.mjs';

export async function workspaceFor(page, kind, signal, onAccess, waitForAccess = false) {
  let workspace;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal.throwIfAborted();
    try {
      workspace = await openSchoolFinanceWorkspace(page, { kind, signal, onAccess, waitForAccess });
    } catch (error) {
      if (attempt === 2 || page.isClosed()) throw error;
      await delay(500, undefined, { signal });
      continue;
    }
    if (workspace.frame) return workspace;
    if (signal.aborted) break;
  }
  throw Object.assign(new Error(workspace.message), {
    code: workspace.status === 'waiting_login' ? CAMPUS_LOGIN_REQUIRED : workspace.status,
  });
}

async function selectPayrollOption(frame, id, label, project, signal) {
  const field = frame.locator('#' + id);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    signal.throwIfAborted();
    const selected = await field.evaluate((element, { label, project }) => {
      const widget = window.jQuery?.(element).data('kendoDropDownList');
      if (!widget) return false;
      const options = Array.from(widget.dataSource.view()).filter((item) => {
        const name = String(item[widget.options.dataTextField] || '').trim();
        return project ? (name.toUpperCase().match(/[A-Z][A-Z\d]*(?:-[A-Z\d]+)+/g) || []).includes(label.toUpperCase()) : name === label;
      });
      if (options.length !== 1) return false;
      const value = String(options[0][widget.options.dataValueField]);
      widget.value(value);
      widget.trigger('change');
      if (project) widget.trigger('close');
      return String(widget.value()) === value;
    }, { label, project }, { timeout: 3500 }).catch(() => false);
    if (selected) return true;
    await delay(350, undefined, { signal });
  }
  return false;
}

async function payrollProjectDepartment(frame, signal) {
  const field = frame.locator('#Dp_Dept');
  for (let attempt = 0; attempt < 25; attempt += 1) {
    signal.throwIfAborted();
    const selected = await field.evaluate((element) => {
      const widget = window.jQuery?.(element).data('kendoDropDownList');
      const item = widget?.dataItem();
      if (!widget?.value() || widget.dataSource._requestInProgress || !item || !widget.text().trim()) return '';
      return widget.text().trim();
    }, undefined, { timeout: 2000 }).catch(() => '');
    if (selected) return selected;
    await delay(350, undefined, { signal });
  }
  throw new Error('学校还未带出所选经费项目的发放部门。');
}

export async function fillPayrollHeader(frame, { plan, payroll, signal }) {
  const header = await openPayrollHeader(frame, payroll.category);
  if (!await selectPayrollOption(frame, 'Dp_Project', plan.project.projectNo, true, signal)) throw new Error('学校薪酬套类下未找到所选经费项目。');
  if (!await selectPayrollOption(frame, 'Dp_GrantClass', payroll.grantType, false, signal)) throw new Error('学校薪酬套类未找到填写的发放类型。');
  const department = await payrollProjectDepartment(frame, signal);
  await header.fill(payroll.reason);
  await header.blur();
  if (await header.inputValue() !== payroll.reason) throw new Error('学校未保留填写的发放内容。');
  return department;
}

export async function preparePayrollHeader({ plan, payroll, control = {}, openSession, signal, onAccess, log }) {
  let session;
  let workspace;
  try {
    session = await openSession();
    workspace = await workspaceFor(session.page, 'labor', signal, onAccess);
    while (control.paused && !control.cancelled) await delay(300, undefined, { signal });
    if (control.cancelled) throw new Error('用户已停止本笔薪酬填报。');
    const department = await fillPayrollHeader(workspace.frame, { plan, payroll, signal });
    log('填入薪酬申报抬头', payroll.category + ' · ' + plan.project.projectNo + ' · ' + department);
    return 'payroll_header_ready';
  } finally {
    await workspace?.close(false);
    await session?.cleanup?.();
  }
}

async function finishPdf({ sourceRoot, folder, plan, progress, bytes, financeFormId, log, persist, stage, selectPrintQueue, printPdf }) {
  const booking = progress.booking;
  const number = financeFormId || progress.submission.financeFormId || booking.pdfFinanceFormId;
  const expected = { reason: plan.reason, project: plan.project, totalCny: plan.totalCny, date: booking.appointment.date, campus: booking.appointment.campus || '松江' };
  const file = await saveAppointmentPdf(sourceRoot, folder, number, bytes, expected);
  if (!file) return false;
  if (booking.pdfName !== file.name || booking.pdfFinanceFormId !== file.financeFormId) {
    booking.pdfName = file.name;
    booking.pdfFinanceFormId = file.financeFormId;
    await persist();
    log('保存报销单 PDF', folder + '/' + file.name);
  }
  if (booking.printState === 'attempted') {
    booking.printState = 'uncertain';
    log('打印结果待确认', 'PDF 已保存，可查看本机打印队列。');
  }
  if (!booking.printState) {
    stage('正在检查打印机');
    const queue = await selectPrintQueue();
    if (!queue) {
      booking.printState = 'saved';
      log('保存待打印', '可打开 PDF 手动打印。');
    } else {
      booking.printState = 'attempted';
      booking.printQueue = queue;
      await persist();
      try {
        stage('正在送印报销预约单');
        const receipt = await printPdf(file.path, queue);
        booking.printState = 'queued';
        booking.printJobId = receipt;
        log('送到打印队列', receipt);
      } catch {
        booking.printState = 'uncertain';
        log('打印结果待确认', 'PDF 已保存，可查看本机打印队列。');
      }
    }
  }
  await persist();
  return true;
}

export async function executeDailySchoolBooking({
  plan, control, sourceRoot, openSession, signal, onAccess, validate, ask, log, persist, record, stage = () => {},
  autoPrint = false, campus = '松江', legacyPaymentLabel = '教职工银行卡-建设银行',
  selectPrintQueue = autoPrint ? defaultPrintQueue : async () => null, printPdf = printAppointmentPdf,
}) {
  const { progress } = control;
  const folder = plan.sourceFolders?.[0] || plan.folder;
  let session;
  let workspace;
  let initialPrint;
  let submissionNotice = '';
  let pdfError = '';
  const checkpoint = async () => {
    while (control.paused && !control.cancelled) await delay(300, undefined, { signal });
    signal.throwIfAborted();
    if (control.cancelled) throw new Error('用户已停止本笔报销。');
  };
  const finish = (bytes, financeFormId) => finishPdf({
    sourceRoot, folder, plan, progress, bytes, financeFormId, log, persist, stage, selectPrintQueue, printPdf,
  });
  const savePdf = async (bytes, financeFormId) => {
    try { return await finish(bytes, financeFormId); }
    catch (error) { pdfError = error.message; return false; }
  };
  async function queryReceipt(frame, booking) {
    const number = progress.submission.financeFormId || booking.pdfFinanceFormId;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await checkpoint();
      const receipt = await readDailyBookingReceipt(frame, plan, booking, number, signal).catch(() => null);
      if (receipt) return receipt;
      log('核对预约回执', '暂未找到与本次预约一致的记录（' + attempt + '/3）');
    }
    throw new Error([submissionNotice, '暂未查到与本笔匹配的学校预约回执。回复「继续」可重新查询。'].filter(Boolean).join(' '));
  }
  try {
    if (progress.submission.state === 'verified' && progress.booking?.pdfName) {
      await record();
      if (await finish()) return 'booked';
    }
    stage('正在打开学校预约报销');
    session = await openSession();
    workspace = await workspaceFor(session.page, 'legacy', signal, onAccess);
    const { frame } = workspace;
    if (progress.submission.state === 'not_started') {
      let form;
      for (let attempt = 1; !form; attempt += 1) {
        try {
          form = await fillDailyBooking(frame, { plan, progress, signal, checkpoint, ask, log, persist, campus, legacyPaymentLabel });
        } catch (error) {
          if (attempt === 3 || control.cancelled || signal.aborted || /足够|多个|未选定学校支出项|手机号|已有其他事项|字数|最多/.test(error.message)) throw error;
          log('恢复线下填报', '在同一页核对并重试（' + attempt + '/3）');
          await delay(500, undefined, { signal });
        }
      }
      await validate();
      await checkpoint();
      const appointment = progress.booking.appointment;
      const question = `请核对线下预约：${plan.reason}，项目 ${plan.project.projectNo}，金额 ${(plan.totalCny / 100).toFixed(2)} 元，纸质附件 ${plan.attachmentCount} 张，${appointment.campus}校区 ${appointment.date} ${appointment.label}。`;
      if (!await confirmSubmission({ control, ask, validate, checkpoint, question })) return 'preview';
      initialPrint = watchAppointmentPdf(frame, form.orderId);
      progress.submission = { state: 'attempted', fingerprint: plan.fingerprint, attemptedAt: new Date().toISOString() };
      await persist();
      log('提交预约', '正在保存并提交学校预约单。');
      submissionNotice = await submitDailyBooking(frame, signal).catch((error) => error.message.split('\n')[0]);
      if (submissionNotice) log('学校提交提示', submissionNotice);
    }

    const booking = progress.booking;
    if (!booking?.appointment || !booking.orderId) throw new Error('缺少本次预约的学校原单信息。');
    await checkpoint();
    stage('正在保存报销预约单 PDF');
    let saved = await savePdf(await initialPrint?.bytes(signal, 5000));
    if (!saved) {
      stage('正在从报销单查询补取 PDF');
      const original = await queryReceipt(frame, booking);
      saved = await savePdf(undefined, original.financeFormId);
      for (let attempt = 1; attempt <= 3 && !saved; attempt += 1) {
        await checkpoint();
        log('从报销单查询补取 PDF', '学校单号 ' + original.financeFormId);
        const document = await reprintDailyBooking(frame, booking.orderId, original.financeFormId, signal)
          .catch((error) => { pdfError = error.message.split('\n')[0]; return null; });
        saved = await savePdf(document, original.financeFormId);
      }
      if (!saved) {
        throw new Error(['学校预约已查到，PDF 尚未保存。', pdfError, '回复「继续」可按原单号重新获取。'].filter(Boolean).join(' '));
      }
    }
    stage('正在核对学校预约提交结果');
    const receipt = await queryReceipt(frame, booking);
    if (progress.submission.state !== 'verified') {
      progress.submission = { ...progress.submission, ...receipt, state: 'verified', verifiedAt: new Date().toISOString() };
      await persist();
    }
    await record();
    log('核实学校预约', receipt.financeFormId + ' · ' + booking.appointment.date + ' · ' + (booking.appointment.campus || '松江') + '校区');
    return 'booked';
  } finally {
    initialPrint?.stop();
    await workspace?.close(progress.submission.state === 'verified');
    await session?.cleanup?.();
  }
}
