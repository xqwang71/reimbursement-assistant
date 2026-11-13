import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { askInteractionAgent } from './codex.mjs';
import { browserTargetId } from './browser-session.mjs';
import { CAMPUS_LOGIN_REQUIRED } from './portal-navigation.mjs';

const STAGES = ['entry', 'start', 'claimtype', 'form', 'travel_form', 'detail_payment', 'signer', 'confirm'];
const stageLabels = {
  entry: '财务首页', start: '经费与票据', claimtype: '报销类别', form: '单据填报',
  travel_form: '差旅住宿和补贴', detail_payment: '费用明细与支付', signer: '加签', confirm: '提交确认', receipt: '学校回执', unknown: '未识别页面',
};
const MAX_RECOVERIES = 3;
const CONTROL_TEXT = /我要报销|财务服务平台|经费预算信息|票据影像|选择报销类别|日常报销|国内差旅|单据填报|明细费用类型|报销支出费用明细|加签人|确认提交报销单|报销单查询|提交预审|处理中|加载|超时|报销单已/;
const BLOCKING_ERROR = /已变化|已离开|已被替换|找不到本批原报销标签|存在多个可见报销页面|无法核对.*身份|草稿的发票身份|页面已有报销草稿|不一致|校验失败|余额.*不足|不足.*分配|无法读取.*余额|用户取消/;

function brief(text, limit) {
  return String(text || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/https?:\/\/[^\s"'<>]+/gi, '[链接]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱]').replace(/\d{4,}/g, '[编号]').replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function observe(executor, run, settingsDir, attempt) {
  const progress = run.control.progress;
  const target = progress.uploadPageId || run.control.portalPageId;
  const page = executor.page;
  const observation = { originalTab: false, stage: 'unknown', labels: [], buttons: [], screenshot: false };
  if (!target || !page || page.isClosed() || new URL(page.url()).origin !== executor.portalOrigin ||
      await browserTargetId(page).catch(() => null) !== target) return observation;
  observation.originalTab = true;
  executor.workContext = null;
  const [pageText, detected, buttons, screenshot] = await Promise.all([
    executor.bodyText({ bind: false, timeout: 3000 }).catch(() => ''),
    executor.detectStage().catch(() => 'unknown'),
    executor.work({ bind: false }).then((scope) => scope.locator('button:visible').allInnerTexts()).catch(() => []),
    page.screenshot({ timeout: 5000 }).catch(() => null),
  ]);
  observation.stage = STAGES.includes(detected) ? detected : 'unknown';
  observation.labels = [...new Set(pageText.split('\n').map((line) => line.trim()).filter((line) => line.length <= 48 && CONTROL_TEXT.test(line)).map((line) => brief(line, 48)))].slice(0, 20);
  observation.buttons = [...new Set(buttons.filter((label) => label.trim().length <= 24).map((label) => brief(label, 24)).filter(Boolean))].slice(0, 18);
  if (screenshot) {
    const directory = join(settingsDir, '.runtime', 'recovery', run.id);
    observation.screenshot = await mkdir(directory, { recursive: true, mode: 0o700 })
      .then(() => writeFile(join(directory, `${Date.now()}-${attempt}.png`), screenshot, { mode: 0o600 }))
      .then(() => true).catch(() => false);
  }
  if (observation.stage === 'unknown' && /财务服务平台|我要报销/.test(pageText)) observation.stage = 'entry';
  return observation;
}

function recoveryAction({ run, executor, error, observation }) {
  const { control, plan } = run;
  const { progress } = control;
  if (!observation.originalTab || control.cancelled || error?.code === CAMPUS_LOGIN_REQUIRED || error?.statusCode === 409) return 'ask_user';
  if (['attempted', 'verification_required'].includes(progress.submission.state) &&
      progress.uploadPageId && progress.submission.fingerprint === plan.fingerprint) return 'verify';
  if (progress.submission.state !== 'not_started' || error?.code === 'PROJECT_EXPENSE_TYPE_REQUIRED' || BLOCKING_ERROR.test(error?.message || '')) return 'ask_user';
  if (progress.didiWallet?.state === 'started' || progress.uploads.some((operation) => operation.state === 'started')) {
    return progress.uploadPageId && ['start', 'form'].includes(observation.stage) ? 'verify' : 'ask_user';
  }
  const actual = STAGES.indexOf(observation.stage);
  const failed = STAGES.indexOf(executor.stage || 'entry');
  return actual >= 0 && actual >= failed && (observation.stage !== 'entry' || !progress.ownedDocument) ? 'resume' : 'ask_user';
}

async function diagnose(input, cwd, settingsDir) {
  const output = await askInteractionAgent({ mode: 'recovery', input, cwd, settingsDir, timeoutMs: 8000 });
  const parsed = JSON.parse(output.match(/\{[\s\S]*\}/)?.[0] || '{}');
  if (parsed.stage === input.stage && parsed.action === input.safeAction) return brief(parsed.note, 100);
  return '';
}

export async function executeRunWithRecovery({ executor, run, cwd, settingsDir, onRecovery }) {
  let currentDiagnosis;
  for (let attempt = 0; attempt <= MAX_RECOVERIES; attempt += 1) {
    let result;
    let error;
    try {
      result = await executor.run();
      if (result !== 'verification_required') return result;
    } catch (failure) {
      error = failure;
    } finally {
      currentDiagnosis = null;
    }
    const observation = await observe(executor, run, settingsDir, attempt).catch(() => ({ originalTab: false, stage: 'unknown', screenshot: false }));
    const action = recoveryAction({ run, executor, error, observation });
    if (attempt === MAX_RECOVERIES || action === 'ask_user') {
      if (attempt > 0) onRecovery(`自动恢复 ${attempt} 次后仍停在${stageLabels[observation.stage]}。`, 'waiting');
      if (error) throw error;
      return result;
    }
    const { progress } = run.control;
    const stage = action === 'verify' && progress.submission.state !== 'not_started' && observation.stage === 'unknown' ? 'receipt' : observation.stage;
    const lastStep = run.events.findLast((event) => event.type === 'step' && event.step !== '自动恢复')?.step;
    const failure = brief(String(error?.message || '').split('\n', 1)[0], 150);
    const diagnosis = {
      stage, safeAction: action, lastStep, failedStage: executor.stage, failure, screenshotSaved: observation.screenshot,
      labels: observation.labels, buttons: observation.buttons, attempt: attempt + 1, maximum: MAX_RECOVERIES,
      submission: progress.submission.state, uploadPending: progress.didiWallet?.state === 'started' || progress.uploads.some((operation) => operation.state === 'started'),
    };
    const reason = failure ? `${lastStep ? `「${lastStep}」` : ''}${failure}。` : '';
    const next = action === 'verify' ? '正在核对原单' : '从当前页面继续';
    onRecovery(`第 ${diagnosis.attempt}/${MAX_RECOVERIES} 次 · ${stageLabels[stage]}。${reason}${next}。`, 'running');
    executor.resumeStages = true;
    const recoveryEvent = run.events.at(-1);
    currentDiagnosis = diagnosis;
    void diagnose(diagnosis, cwd, settingsDir).then((note) => {
      if (note && currentDiagnosis === diagnosis && run.events.at(-1) === recoveryEvent) onRecovery(note, 'running');
    }).catch(() => undefined);
  }
}
