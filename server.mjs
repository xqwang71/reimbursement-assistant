import http from 'node:http';
import { readFile, writeFile, mkdir, rename, readdir, lstat, realpath } from 'node:fs/promises';
import { basename, join, resolve, dirname, extname, posix } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { listFinalFolders, isReimbursedFolder, createPlan, publicPlan, PLAN_VERSION, SUBJECTS, validatePlanForExecution, fingerprintFolder, fingerprintPlan } from './lib/planner.mjs';
import { confirmClaimPurpose, normalizeClaimReason } from './lib/claim-purpose.mjs';
import { claimWithdrawalFor, markClaimWithdrawn, reimbursementSourceFolders } from './lib/claim-withdrawal.mjs';
import { ReimbursementExecutor } from './lib/executor.mjs';
import { askInteractionAgent, parseInstruction } from './lib/codex.mjs';
import { executeRunWithRecovery } from './lib/execution-recovery.mjs';
import { didiBudgetCny, validateDidiSelection } from './lib/didi-invoices.mjs';
import { normalizeModelSettings, publicModelSettings, readModelSettings } from './lib/model-settings.mjs';
import { documentNumber, fundingSummaryCsv, readFundingExports, readPayrollPeople, summarizeFunding } from './lib/funding-summary.mjs';
import { DEFAULT_PORT, isInsideDirectory, privateDataDirectory, profileId, receiptDirectory, serviceRevision } from './lib/platform.mjs';
import { DEFAULT_PREFERENCES, localPreferences, localSigner, projectFunding } from './lib/local-settings.mjs';
import { createSchoolFundingSync } from './lib/school-funding-sync.mjs';
import { checkSchoolFinancePage } from './lib/school-finance-access.mjs';
import { listWebProjects } from './lib/projects.mjs';
import { browserPageForTarget, browserTargetId, getBrowserSession, savePlatformSession, savedPlatformUrl } from './lib/browser-session.mjs';
import { CAMPUS_LOGIN_REQUIRED } from './lib/portal-navigation.mjs';
import { loadMemory, learnExpenseType, applyLearning, rememberPlanEdit, EXPENSE_TYPES } from './lib/memory.mjs';
import { DEFAULT_TRAVEL_PROFILE } from './lib/travel.mjs';
import { matchProjects, planProjects } from './public/project-allocation.js';
import { captureBocQuote, readBocQuote } from './lib/boc-rates.mjs';
import { PAYROLL_CATEGORIES, PAYROLL_EXPENSE_ITEMS, PAYROLL_POSITIONS, payrollSignerNames, payrollApproval, payrollIntake } from './lib/payroll-intake.mjs';
import { executeDailySchoolBooking, preparePayrollHeader } from './lib/school-finance-runner.mjs';
import { executeSchoolPayroll } from './lib/school-payroll-executor.mjs';
import { runPayrollWithRecovery } from './lib/payroll-recovery.mjs';
import { readSchoolPayrollStates } from './lib/school-payroll-status.mjs';
import { searchSchoolStudents, STUDENT_PAYROLL } from './lib/school-payroll-people.mjs';
import { saveAppointmentPdf } from './lib/school-appointment-pdf.mjs';
import { hasReviewArchive, listArchivedBatches, readArchivedBatch, reviewArchivePath } from './lib/review-archive.mjs';
import { answerWorkspaceRequests, isWorkspaceYear, listWorkspaces, publicWorkspace, requestWorkspaceProcess, resolveWorkspace } from './lib/workspaces.mjs';

const APP_DIR = await realpath(fileURLToPath(new URL('.', import.meta.url)));
const SERVICE_REVISION = await serviceRevision(APP_DIR);
const PUBLIC_DIR = join(APP_DIR, 'public');
let workspace = process.send && process.env.REIMBURSEMENT_WORKSPACE
  ? await resolveWorkspace(APP_DIR, JSON.parse(process.env.REIMBURSEMENT_WORKSPACE)) : null;
const workspaceAtLaunch = workspace;
const EXAMPLE_ROOT = join(APP_DIR, 'examples', '2099');
const DATA_APP_DIR = await privateDataDirectory(APP_DIR, process.env, workspace);
const PROFILE_ID = profileId(DATA_APP_DIR);
const RUNTIME_DIR = join(DATA_APP_DIR, '.runtime');
const REVIEW_ARCHIVE_FILE = reviewArchivePath(RUNTIME_DIR);
const DEFAULT_SOURCE_ROOT = workspace ? workspace.sourceRoot
  : await receiptDirectory(resolve(process.env.REIMBURSEMENT_SOURCE_ROOT || join(DATA_APP_DIR, '票据')), APP_DIR, DATA_APP_DIR);
const DEFAULT_DEMO = workspace?.example ?? !process.env.REIMBURSEMENT_SOURCE_ROOT;
const RUNS_FILE = join(RUNTIME_DIR, 'runs.json');
const BATCHES_FILE = join(RUNTIME_DIR, 'batches.json');
const HISTORY_FILE = join(RUNTIME_DIR, 'history.json');
const PROJECTS_FILE = join(RUNTIME_DIR, 'projects.json');
const PROJECT_MATCHES_FILE = join(RUNTIME_DIR, 'project-matches.json');
const CLAIM_REASONS_FILE = join(RUNTIME_DIR, 'claim-reasons.json');
const CLAIM_GROUPS_FILE = join(RUNTIME_DIR, 'claim-groups.json');
const PAYROLL_RECIPIENTS_FILE = join(RUNTIME_DIR, 'payroll-recipients.json');
const BOOKING_OPTIONS_FILE = join(RUNTIME_DIR, 'school-booking-options.json');
const PLANS_FILE = join(RUNTIME_DIR, 'plans.json');
const CONFIG_FILE = join(RUNTIME_DIR, 'config.json');
const MODEL_CONFIG_FILE = join(RUNTIME_DIR, 'model-config.json');
const FUNDING_ATTRIBUTIONS_FILE = join(RUNTIME_DIR, 'funding-attributions.json');
const FUNDING_WITHDRAWALS_FILE = join(RUNTIME_DIR, 'funding-withdrawals.json');
let demoMode = DEFAULT_DEMO;
let SOURCE_ROOT = workspace?.sourceRoot ?? (demoMode ? EXAMPLE_ROOT : DEFAULT_SOURCE_ROOT);
let liveSourceRoot = DEFAULT_SOURCE_ROOT;
let preferences = DEFAULT_PREFERENCES;
const schoolFundingSync = createSchoolFundingSync({
  appDir: DATA_APP_DIR, runtimeDir: RUNTIME_DIR, currentRoot: () => SOURCE_ROOT, syncPayrollStatuses: refreshSchoolPayrollStatuses,
});
let paymentCardLast4 = '';
let configurationRevision = randomUUID();
let browserReservation = null;
let persistence = Promise.resolve();
const PLATFORM_DEFAULT_URL = 'http://znbx.suibe.edu.cn:8000/microportalweb/#/main';
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'waiting_input', 'pausing']);
const plans = new Map();
const runs = new Map();
const batches = new Map();
const pending = new Map();
const resolvingRuns = new Set();
const planOperations = new Map();
let history = { submittedInvoiceNumbers: [], submittedPaymentKeys: [], withdrawals: [] };
let projectCatalog = { projects: [], syncedAt: null };
let projectMatches = new Map();
let fundingAttributions = new Map();
let fundingWithdrawals = new Map();
let claimReasons = new Map();
let claimGroups = new Map();
let payrollRecipients = new Map();
let payrollLookupKey = randomBytes(32).toString('hex');
let payrollLookupKeySaved = false;
const schoolPayrollChoices = new Map();
let bookingOptions = new Map();
let worklistWrites = Promise.resolve();
let importedReasons = false;
let memory = { expenseTypeBySubject: {} };

try {
  history = { ...history, ...JSON.parse(await readFile(HISTORY_FILE, 'utf8')) };
} catch {}
try {
  projectCatalog = { ...projectCatalog, ...JSON.parse(await readFile(PROJECTS_FILE, 'utf8')) };
} catch {}
try {
  const saved = JSON.parse(await readFile(PROJECT_MATCHES_FILE, 'utf8'));
  projectMatches = new Map(await Promise.all(saved.map(async ([key, value]) => {
    const [root, folder] = key.split('\0');
    return [projectMatchKey(await realpath(root).catch(() => root), folder), value];
  })));
} catch {}
try { fundingAttributions = new Map(JSON.parse(await readFile(FUNDING_ATTRIBUTIONS_FILE, 'utf8'))); } catch {}
try { fundingWithdrawals = new Map(JSON.parse(await readFile(FUNDING_WITHDRAWALS_FILE, 'utf8'))); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  const saved = JSON.parse(await readFile(CLAIM_REASONS_FILE, 'utf8'));
  claimReasons = new Map(saved.map(([key, reason]) => [
    key, typeof reason === 'string' ? { draft: reason, savedOnce: Boolean(reason) } : reason,
  ]));
} catch {}
try {
  claimGroups = new Map(JSON.parse(await readFile(CLAIM_GROUPS_FILE, 'utf8')).map((group) => [group.key, group]));
} catch {}
try {
  const saved = JSON.parse(await readFile(PAYROLL_RECIPIENTS_FILE, 'utf8'));
  if (/^[a-f\d]{64}$/.test(saved.lookupKey) && Array.isArray(saved.people)) {
    payrollLookupKey = saved.lookupKey;
    payrollRecipients = new Map(saved.people.map((person) => [person.key, person]));
    payrollLookupKeySaved = true;
  }
} catch {}
try { bookingOptions = new Map(JSON.parse(await readFile(BOOKING_OPTIONS_FILE, 'utf8'))); } catch {}
memory = await loadMemory(DATA_APP_DIR);
const savedConfig = await readFile(CONFIG_FILE, 'utf8').then(JSON.parse, (error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (savedConfig) {
  if (!workspace) {
    demoMode = typeof savedConfig.demoMode === 'boolean' ? savedConfig.demoMode : !savedConfig.sourceRoot && DEFAULT_DEMO;
    liveSourceRoot = await receiptDirectory(resolve(savedConfig.liveSourceRoot || savedConfig.sourceRoot || DEFAULT_SOURCE_ROOT), APP_DIR, DATA_APP_DIR);
    SOURCE_ROOT = demoMode ? EXAMPLE_ROOT : liveSourceRoot;
  }
  preferences = localPreferences(savedConfig.preferences);
  if (/^\d{4}$/.test(savedConfig.paymentCardLast4 || '')) paymentCardLast4 = savedConfig.paymentCardLast4;
  if (typeof savedConfig.configurationRevision === 'string' && savedConfig.configurationRevision) configurationRevision = savedConfig.configurationRevision;
}
try {
  const savedPlans = JSON.parse(await readFile(PLANS_FILE, 'utf8'));
  for (const plan of savedPlans) {
    if (plan?.purpose && typeof plan.reason === 'string' && plan.reason && plan.sourceRoot && plan.folder && !isReimbursedFolder(plan.folder)) {
      const key = projectMatchKey(plan.sourceRoot, plan.folder);
      if (!claimReasons.has(key)) {
        claimReasons.set(key, { draft: plan.reason, savedOnce: true });
        importedReasons = true;
      }
    }
    if (!plan?.id || plan.version !== PLAN_VERSION || (!workspace && plan.sourceRoot !== SOURCE_ROOT) || plan.configurationRevision !== configurationRevision) continue;
    applyMemoryToPlan(plan);
    plans.set(plan.id, plan);
  }
} catch {}

try {
  const savedRuns = JSON.parse(await readFile(RUNS_FILE, 'utf8'));
  for (const run of savedRuns) {
    if (!run?.id) continue;
    run.control ||= {};
    run.control.progress ||= { uploads: [], submission: { state: 'not_started' } };
    run.control.progress.uploads ||= [];
    run.control.progress.submission ||= { state: 'not_started' };
    run.sourceRoot ||= run.plan?.sourceRoot || SOURCE_ROOT;
    run.configurationRevision ||= run.plan?.configurationRevision;
    run.control.autoSubmit = false;
    if (run.control.progress.submission.state === 'verified') {
      const booking = run.control.progress.booking;
      const missingPdf = run.plan.reimbursementRoute === 'legacy' && (!booking?.pdfName || !booking.printState || booking.printState === 'attempted');
      run.status = missingPdf ? 'verification_required' : 'completed';
      run.result = run.plan.reimbursementRoute === 'legacy' ? 'booked' : run.plan.payrollRevision ? 'declared' : 'submitted';
      if (missingPdf) run.error = '学校预约已核实。回复「继续」可保存或恢复原单 PDF。';
    }
    else if (hasUnresolvedEffect(run)) { run.status = 'verification_required'; run.error = '本机服务在办理途中重启，学校结果待核对。'; }
    else if (run.status === 'queued') { run.status = 'stopped'; }
    else if (ACTIVE_RUN_STATUSES.has(run.status)) {
      run.status = 'error';
      if (run.control.waitingForCampusLogin) {
        run.errorCode = CAMPUS_LOGIN_REQUIRED;
        run.error = '服务重启前正在等待学校登录。完成登录后可在「执行与互动」发送「继续」。';
      } else run.error = '服务已重启，任务已停止；核对当前草稿后可重试';
    }
    delete run.control.waitingForCampusLogin;
    runs.set(run.id, run);
  }
} catch {}
try {
  for (const batch of JSON.parse(await readFile(BATCHES_FILE, 'utf8'))) {
    if (['queued', 'running'].includes(batch.status)) batch.status = 'interrupted';
    batches.set(batch.id, batch);
  }
} catch {}

function atomicJson(file, value) {
  const content = JSON.stringify(value, null, 2);
  const saved = persistence.then(async () => {
    await mkdir(RUNTIME_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  });
  persistence = saved.catch(() => undefined);
  return saved;
}

async function savePlans() { await atomicJson(PLANS_FILE, [...plans.values()]); }
async function saveRuns() {
  await atomicJson(RUNS_FILE, [...runs.values()]);
  await atomicJson(BATCHES_FILE, [...batches.values()]);
}

async function refreshSchoolPayrollStatuses(sourceRoot, frame, signal) {
  const receipts = [...runs.values()].flatMap((run) => {
    const { progress } = run.control;
    const { financeFormId, state } = progress.submission;
    const { declareId } = progress.payroll || {};
    const projectNo = run.plan.project?.projectNo;
    if (run.sourceRoot !== sourceRoot || !run.plan.payrollRevision || !run.bookkeeping?.payrollRecorded ||
        state !== 'verified' || !financeFormId || !declareId || !projectNo) return [];
    return [{ runId: run.id, declareId, financeFormId, projectNo }];
  });
  const statuses = await readSchoolPayrollStates(frame, receipts, signal);
  signal.throwIfAborted();
  if (sourceRoot !== SOURCE_ROOT) throw new Error('票据目录已切换，请重新同步。');
  for (const { runId, ...status } of statuses) runs.get(runId).schoolPayrollStatus = status;
  if (statuses.length) await saveRuns();
  return { checked: statuses.length, total: receipts.length };
}

function heldRun(exceptId = '') {
  return [...runs.values()].find((run) => run.id !== exceptId && holdsDocument(run));
}

function holdsDocument(run) {
  if (claimWithdrawalFor(history, run.id)) return false;
  return ACTIVE_RUN_STATUSES.has(run.status) || ['preview', 'verification_required'].includes(run.status) ||
    (run.status === 'error' && run.control?.progress?.ownedDocument && !run.resolved) || hasUnresolvedEffect(run);
}

function hasUnresolvedEffect(run) {
  if (run.resolved) return false;
  const progress = run.control?.progress;
  if (progress?.submission?.state === 'verified') return run.bookkeeping?.historyRecorded !== true;
  return Boolean(progress?.payroll?.draftAttemptedAt || progress?.payroll?.approvalAttemptedAt ||
    progress?.submission?.state && progress.submission.state !== 'not_started' || progress?.didiWallet?.state === 'started' ||
    progress?.uploads?.some((operation) => operation.state === 'started'));
}

function canResumeSmartPreview(run) {
  const { progress, cancelled } = run.control;
  return run.status === 'preview' && run.plan.reimbursementRoute === 'smart' && !run.resolved && !cancelled &&
    progress.ownedDocument && Boolean(progress.uploadPageId && (progress.fillingId || progress.documentId)) &&
    progress.submission.state === 'not_started' && !hasUnresolvedEffect(run);
}

function schoolReceiptOnly(run) {
  const { progress } = run.control;
  return ['legacy', 'labor'].includes(run.plan.reimbursementRoute) &&
    (progress.submission.state !== 'not_started' || Boolean(progress.payroll?.approvalAttemptedAt));
}

function canResumeCampusLogin(run) {
  if (run.status !== 'error' || run.resolved || run.control.cancelled) return false;
  const { progress } = run.control;
  const loginFailure = run.errorCode === CAMPUS_LOGIN_REQUIRED || /请检查专用浏览器的校园网登录状态|尚未登录学校财务平台/.test(run.error || '');
  return loginFailure && progress.submission.state === 'not_started' && progress.uploads.length === 0 &&
    !progress.ownedDocument && !progress.uploadPageId && !progress.documentId && !progress.fillingId;
}

function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }

function reserveBrowser(owner, exceptId = '') {
  const held = heldRun(exceptId);
  if (browserReservation || held) throw httpError(409, held ? `“${planLabel(held.plan)}”的草稿或操作结果尚未结束，请先核实或结束该任务` : '财务浏览器正在被另一任务占用');
  browserReservation = owner;
}
function releaseBrowser(owner) { if (browserReservation === owner) browserReservation = null; }
async function withBrowserReservation(task) {
  const owner = randomUUID();
  reserveBrowser(owner);
  try { return await task(); } finally { releaseBrowser(owner); }
}

async function withPlanOperation(sourceRoot, folder, task) {
  const key = `${sourceRoot}\0${folder}`;
  const operation = (planOperations.get(key) || Promise.resolve()).catch(() => undefined).then(task);
  planOperations.set(key, operation);
  try { return await operation; } finally { if (planOperations.get(key) === operation) planOperations.delete(key); }
}

function validatePlanContext(plan) {
  if (plan.sourceRoot !== SOURCE_ROOT || plan.configurationRevision !== configurationRevision) throw httpError(409, '根目录或公务卡配置已变化，请重新检查文件夹');
  if (!isDeepStrictEqual(plan.bookingOptions ?? null, bookingOptionsFor(plan.sourceRoot, plan.folder))) {
    throw httpError(409, '办理方式或纸质附件张数已变化，请重新检查事项');
  }
  const planned = plan.projectAllocationDraft ?? matchProjects(plan.project);
  if (planned.some((project) => catalogProject(project).projectName !== project.projectName)) throw httpError(409, '项目清单名称已更新，请重新核对报销事项');
  const group = claimGroupFor(plan.sourceRoot, plan.folder);
  const subject = memory.subjectByFolder?.[folderMemoryKey(plan.sourceRoot, plan.folder)] || group?.subject;
  if (subject && subject !== plan.subject) throw httpError(409, '报销科目已变化，请重新核对办理系统');
  if (plan.groupId && (!group || group.status !== 'draft' || !isDeepStrictEqual(group.folders, plan.sourceFolders))) throw httpError(409, '报销事项的来源文件夹已变化，请重新检查');
  if (!plan.groupId && [...claimGroups.values()].some((item) => item.sourceRoot === plan.sourceRoot && item.status !== 'dissolved' && item.folders.includes(plan.folder))) throw httpError(409, '该文件夹已加入报销事项，请从报销事项执行');
  const match = projectMatchFor(plan.sourceRoot, plan.folder);
  const configured = matchProjects(match).map(catalogProject);
  if (match !== undefined && (!isDeepStrictEqual(planned, configured) || (match && plan.funding !== match.funding))) {
    throw httpError(409, '报销事项的经费项目或分配金额已变化，请重新核对后执行');
  }
}

function catalogProject(project) {
  if (!project) return null;
  const projectNo = String(project.projectNo || '').trim();
  const official = projectCatalog.projects.find((item) => item.projectNo === projectNo);
  return { ...project, projectNo, projectName: official?.projectName || String(project.projectName || '').trim() };
}

function normalizeProjectMatch(match) {
  if (match === null) return null;
  const { funding, allocations } = match || {};
  if (!['教学', '科研'].includes(funding)) throw httpError(400, '请选择经费口径');
  const normalizeProject = (project) => {
    const { projectNo, projectName } = project || {};
    if (typeof projectNo !== 'string' || !projectNo.trim() || typeof projectName !== 'string' || !projectName.trim()) throw httpError(400, '请填写项目编号和名称');
    return catalogProject({ projectNo, projectName });
  };
  if (allocations === undefined) {
    const project = normalizeProject(match);
    return { ...project, funding: projectFunding(funding, [project], preferences) };
  }
  if (!Array.isArray(allocations) || allocations.length < 2) throw httpError(400, '请选择至少两个经费项目再分配');
  const projects = allocations.map((project, index) => {
    const { amountCny = null } = project || {};
    const last = index === allocations.length - 1;
    if (last ? amountCny !== null : amountCny !== null && (!Number.isSafeInteger(amountCny) || amountCny <= 0)) throw httpError(400, '请填入大于零的金额，最后一个项目自动补齐');
    return { ...normalizeProject(project), amountCny };
  });
  if (new Set(projects.map(({ projectNo }) => projectNo)).size !== projects.length) throw httpError(400, '同一事项不能重复选择同一个项目');
  return { funding: projectFunding(funding, projects, preferences), allocations: projects };
}

function projectMatchKey(root, folder) { return `${root}\0${folder}`; }
function folderMemoryKey(root, folder) { return workspace ? projectMatchKey(root, folder) : folder; }

function claimGroupFor(root, key) {
  const group = claimGroups.get(key);
  return group?.sourceRoot === root ? group : null;
}

function bookingOptionsFor(root, folder) {
  const groupOptions = claimGroupFor(root, folder)?.bookingOptions;
  return groupOptions === undefined ? bookingOptions.get(projectMatchKey(root, folder)) ?? null : groupOptions;
}

function bookingOptionsForRoute(route, subject, previous = null) {
  if (route === 'legacy') {
    if (subject === '劳务费' || subject === '差旅') throw httpError(400, '劳务费和差旅请按各自的办理方式处理');
    return { attachmentCount: null, ...previous, offline: true };
  }
  if (route !== 'smart') throw httpError(400, '请选择智能报销系统或日常线下报销');
  return previous?.attachmentCount != null ? { ...previous, offline: false } : null;
}

function projectMatchFor(root, key) {
  const group = claimGroupFor(root, key);
  return group ? group.match : projectMatches.get(projectMatchKey(root, key));
}

function claimReasonFor(root, key) {
  return claimGroupFor(root, key)?.reason || claimReasons.get(projectMatchKey(root, key));
}

function sourcesFor(root, key) { return claimGroupFor(root, key)?.folders || [key]; }
function planLabel(plan) { return plan.displayName || plan.folder; }

async function commitGroups(updated) {
  await atomicJson(CLAIM_GROUPS_FILE, [...updated.values()]);
  claimGroups = updated;
}

async function saveGroup(group) {
  const updated = new Map(claimGroups);
  updated.set(group.key, { ...group, updatedAt: new Date().toISOString() });
  await commitGroups(updated);
}

function withWorklistWrite(task) {
  const operation = worklistWrites.then(task);
  worklistWrites = operation.catch(() => undefined);
  return operation;
}

async function rememberPayrollPerson(person) {
  const confirmed = { ...person, confirmed: true };
  const updated = new Map(payrollRecipients);
  updated.set(person.key, confirmed);
  await atomicJson(PAYROLL_RECIPIENTS_FILE, { lookupKey: payrollLookupKey, people: [...updated.values()] });
  payrollRecipients = updated;
  payrollLookupKeySaved = true;
  return confirmed;
}

async function payrollPeopleFor(sourceRoot, category) {
  const found = new Map();
  let historyAvailable = true;
  try {
    for (const person of await readPayrollPeople(sourceRoot, category, payrollLookupKey)) found.set(person.key, person);
  } catch { historyAvailable = false; }
  for (const person of payrollRecipients.values()) {
    if (person.category === category) found.set(person.key, person);
  }
  const people = [...found.values()].sort((a, b) =>
    Number(Boolean(b.confirmed)) - Number(Boolean(a.confirmed)) ||
    a.name.localeCompare(b.name, 'zh-CN') || a.identityTail.localeCompare(b.identityTail));
  return { people, historyAvailable };
}

async function fundingSnapshot(sourceRoot) {
  const exports = await readFundingExports(sourceRoot);
  if (demoMode) return { ...summarizeFunding({ exports, sourceRoot }), demoMode: true };
  const activeReceipts = [...runs.values()].filter((run) => !claimWithdrawalFor(history, run.id));
  const scope = `${sourceRoot}\0`;
  const restorable = new Set([...fundingWithdrawals.keys()].filter((key) => key.startsWith(scope)).map((key) => key.slice(scope.length)));
  const withdrawals = new Set(restorable);
  for (const { financeFormId, sourceRoot: originalRoot } of history.withdrawals || []) {
    if (financeFormId && originalRoot === sourceRoot) withdrawals.add(documentNumber(financeFormId));
  }
  return summarizeFunding({ exports, sourceRoot, projects: projectCatalog.projects, runs: activeReceipts, attributions: fundingAttributions, withdrawals, restorable });
}

function folderHasOpenRun(sourceRoot, folder) {
  const sources = sourcesFor(sourceRoot, folder);
  return [...runs.values()].some((run) => run.sourceRoot === sourceRoot &&
    (run.plan.folder === folder || (run.plan.sourceFolders || [run.plan.folder]).some((item) => sources.includes(item))) && holdsDocument(run));
}

function schoolBookingsFor(sourceRoot) {
  return [...runs.values()].filter((run) => run.sourceRoot === sourceRoot && run.bookkeeping?.appointmentRecorded &&
    run.plan.reimbursementRoute === 'legacy' && !claimWithdrawalFor(history, run.id));
}

function appointmentSummary(run) {
  const { booking, submission } = run.control.progress;
  return { runId: run.id, financeFormId: submission.financeFormId, appointment: booking.appointment.date,
    campus: (booking.appointment.campus || '松江') + '校区', pdfName: booking.pdfName };
}

function saveProjectMatch(sourceRoot, folder, match, importOnly) {
  const operation = worklistWrites.then(async () => {
    if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新文件夹');
    const key = projectMatchKey(sourceRoot, folder);
    const group = claimGroupFor(sourceRoot, folder);
    match = normalizeProjectMatch(match);
    if ((group?.payroll || group?.didi) && match?.allocations) throw httpError(400, '本事项请选择一个经费项目');
    const previous = projectMatchFor(sourceRoot, folder);
    if ((importOnly && previous !== undefined) || isDeepStrictEqual(previous, match)) return previous;
    if (folderHasOpenRun(sourceRoot, folder)) {
      throw httpError(409, '本笔正在执行或待核实，请先处理当前任务再改经费');
    }
    if (group) {
      if (group.status !== 'draft') throw httpError(409, '该报销事项已结束');
      await saveGroup({ ...group, match, ...(group.payroll || group.didi ? { revision: randomUUID() } : {}) });
      return match;
    }
    const updated = new Map(projectMatches);
    updated.set(key, match);
    await atomicJson(PROJECT_MATCHES_FILE, [...updated]);
    projectMatches = updated;
    return match;
  });
  worklistWrites = operation.catch(() => undefined);
  return operation;
}

function saveClaimReason(sourceRoot, folder, reason, { explicit = false, requireCurrentDraft = false, expectedSources, expectedFingerprint } = {}) {
  const operation = worklistWrites.then(async () => {
    if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新文件夹');
    const key = projectMatchKey(sourceRoot, folder);
    if (claimGroupFor(sourceRoot, folder)?.payroll) throw httpError(400, '请在薪酬申报表中修改发放内容');
    const group = claimGroupFor(sourceRoot, folder);
    if (group && expectedSources && !isDeepStrictEqual(group.folders, expectedSources)) throw httpError(409, '事项来源已变化，请核对后重新保存事由');
    const previous = claimReasonFor(sourceRoot, folder);
    if (requireCurrentDraft && previous?.draft !== reason) throw httpError(409, '事由草稿已变化，请重新保存或更新');
    const record = { draft: reason, savedOnce: previous?.savedOnce === true || (explicit && Boolean(reason)) };
    if (group?.didi) {
      if (explicit && reason && group.match?.projectNo) {
        record.projectNo = group.match.projectNo;
        record.funding = group.match.funding;
      } else if (previous?.draft === reason && previous.projectNo) {
        record.projectNo = previous.projectNo;
        record.funding = previous.funding;
      }
      if (explicit && reason && reason.length > 50) throw httpError(400, '请将报销事由控制在 50 字内');
    } else if (group && explicit && reason) {
      record.fingerprint = (await fingerprintPlan(sourceRoot, { folder, sourceFolders: group.folders })).fingerprint;
      if (expectedFingerprint && record.fingerprint !== expectedFingerprint) throw httpError(409, '事项附件已变化，请重新检查');
    } else if (group && previous?.draft === reason && previous?.fingerprint) record.fingerprint = previous.fingerprint;
    if (isDeepStrictEqual(previous, record)) return record;
    if (previous?.draft !== reason && folderHasOpenRun(sourceRoot, folder)) throw httpError(409, '本笔正在执行或待核实，请先处理当前任务再改事由');
    if (group) {
      if (group.status !== 'draft') throw httpError(409, '该报销事项已结束');
      await saveGroup({ ...group, reason: record, ...(group.didi ? { revision: randomUUID() } : {}) });
      return record;
    }
    const updated = new Map(claimReasons);
    updated.set(key, record);
    await atomicJson(CLAIM_REASONS_FILE, [...updated]);
    claimReasons = updated;
    return record;
  });
  worklistWrites = operation.catch(() => undefined);
  return operation;
}

function purposeForCurrentDraft(plan) {
  if (!plan) return null;
  const draft = claimReasonFor(plan.sourceRoot, plan.folder)?.draft;
  return draft === undefined || draft === plan.reason ? plan.purpose : null;
}

async function validateCurrentPlan(plan) {
  await worklistWrites;
  if (demoMode) throw httpError(409, '示例模式只读取虚构数据。切换到正式模式后可填报。');
  if (plan.payrollRevision) return validatePayrollPlan(plan);
  if (plan.didi) {
    const group = claimGroupFor(plan.sourceRoot, plan.folder);
    if (group?.didi) {
      const blocker = didiBlocker(group);
      if (blocker) throw httpError(409, blocker);
    }
    if (plan.sourceRoot !== SOURCE_ROOT || plan.configurationRevision !== configurationRevision || !group?.didi || group.status !== 'draft' ||
        group.didi.budgetCny !== plan.didi.budgetCny || group.match?.projectNo !== plan.project?.projectNo ||
        catalogProject(group.match)?.projectName !== plan.project?.projectName || group.match?.funding !== plan.funding ||
        group.reason?.draft !== plan.reason || group.reason?.projectNo !== plan.project?.projectNo) {
      throw httpError(409, '贸大出行的预算、经费项目或事由已变化，请重新选择事项');
    }
    if (!plan.signer?.name) throw httpError(409, '请在设置中填写本笔经费口径的常用加签人。');
    validateDidiSelection(plan, history.submittedInvoiceNumbers);
    return;
  }
  if (schoolBookingsFor(plan.sourceRoot).some((run) => (run.plan.sourceFolders || [run.plan.folder]).some((folder) => (plan.sourceFolders || [plan.folder]).includes(folder)))) {
    throw httpError(409, '所选票据已有学校预约回执');
  }
  validatePlanContext(plan);
  if (plan.reimbursementRoute === 'smart' && !plan.signer?.name) throw httpError(409, '请在检查详情或设置中填写加签人。');
  await validatePlanForExecution({
    plan,
    sourceRoot: plan.sourceRoot,
    historyInvoiceNumbers: history.submittedInvoiceNumbers,
    historyPaymentKeys: history.submittedPaymentKeys,
  });
  validatePlanContext(plan);
  if (!purposeForCurrentDraft(plan)) throw httpError(409, '报销事由已修改，请在清单点击“更新事由”后执行');
  const current = [...plans.values()].findLast((item) => item.sourceRoot === plan.sourceRoot && item.folder === plan.folder);
  if (current?.status !== 'ready' || !isDeepStrictEqual(current.purpose, plan.purpose) ||
      !isDeepStrictEqual(current.rows, plan.rows) || !isDeepStrictEqual(current.uploadFiles, plan.uploadFiles) ||
      !isDeepStrictEqual(current.travel, plan.travel) || !isDeepStrictEqual(current.signer, plan.signer) || current.totalCny !== plan.totalCny ||
      current.reimbursementRoute !== plan.reimbursementRoute || current.attachmentCount !== plan.attachmentCount) {
    throw httpError(409, '本笔报销事项或检查结果已变化，请重新核对后执行');
  }
}

function payrollBlocker(group) {
  if (!group.match?.projectNo || !group.match.projectName) return '请在右栏匹配薪酬申报的经费项目。';
  const approval = approvalFor(group.payroll);
  if (!approval) return '请核对发放类型。';
  if (!approval.signer) return '请为本笔薪酬申报填写加签人，或在设置中配置常用加签人。';
  const { people, totalCny, reason } = group.payroll;
  if (!normalizeClaimReason(reason)) return '请填写薪酬发放内容。';
  if (!Array.isArray(people) || !people.length || people.some((person) =>
    !person.name || !person.position || !normalizeClaimReason(person.purpose) || !Number.isSafeInteger(person.amountCny) || person.amountCny <= 0)) {
    return '请核对每条发放明细的姓名、职称、用途和金额。';
  }
  const missingHours = people.findIndex((person) => !person.hours);
  if (group.payroll.category === '校外人员劳务费' && missingHours >= 0) return `请填写第 ${missingHours + 1} 条的工作学时。`;
  if (!Number.isSafeInteger(totalCny) || totalCny !== people.reduce((total, person) => total + person.amountCny, 0)) return '薪酬发放合计与明细不一致，请重新保存申报。';
  return '';
}

function approvalFor(payroll) {
  return payrollApproval(payroll.grantType, preferences.signers, payroll.signerOverride);
}

function payrollPlan(group, preview = false) {
  return {
    version: PLAN_VERSION, folder: group.key, groupId: group.id, displayName: group.name, sourceRoot: group.sourceRoot, configurationRevision,
    subject: '劳务费', reimbursementRoute: 'labor', payrollRevision: group.revision, fingerprint: group.revision, payrollPreview: preview,
    project: catalogProject(group.match), reason: group.payroll.reason, peopleCount: group.payroll.people.length,
    ...approvalFor(group.payroll),
    totalCny: group.payroll.totalCny, rows: [], paymentKeys: [], uploadFiles: [], batches: [],
  };
}

function didiBlocker(group) {
  if (!group.match?.projectNo || !group.match.projectName) return '请在右栏匹配一个经费项目';
  if (!group.reason?.savedOnce || !group.reason.draft || group.reason.projectNo !== group.match.projectNo || group.reason.funding !== group.match.funding) return '请写清用车事由并保存';
  return '';
}

function didiPlan(group) {
  const { key, id, sourceRoot, didi, reason, match } = group;
  const funding = match?.funding || '教学';
  return {
    version: PLAN_VERSION, folder: key, groupId: id, displayName: reason?.draft || group.name, sourceRoot, sourceFolders: [], configurationRevision,
    subject: group.subject, reimbursementRoute: 'smart', didi: { budgetCny: didi.budgetCny },
    fingerprint: createHash('sha256').update(JSON.stringify([key, didi.budgetCny, match, reason?.draft])).digest('hex'),
    project: catalogProject(match), funding, reason: reason?.draft || '', signer: preferences.signers[funding],
    claimType: '贸大出行', expenseType: '市内差旅费', paymentType: preferences.smartPaymentLabel,
    totalCny: null, rows: [], paymentKeys: [], uploadFiles: [], batches: [],
  };
}

function validatePayrollPlan(plan) {
  const group = claimGroupFor(plan.sourceRoot, plan.folder);
  if (plan.sourceRoot !== SOURCE_ROOT || plan.configurationRevision !== configurationRevision ||
      group?.status !== 'draft' || !group.payroll || group.revision !== plan.payrollRevision) {
    throw httpError(409, '薪酬申报已更新，请从清单重新选择');
  }
  const blocker = payrollBlocker(group);
  if (blocker) throw httpError(409, blocker);
  if (!isDeepStrictEqual(approvalFor(group.payroll).signer, plan.signer)) throw httpError(409, '加签人已变化，请重新选择事项。');
}

function checkBatchOverlap(selectedPlans) {
  const previousByKey = new Map();
  for (const plan of selectedPlans) {
    const keys = [...(plan.sourceFolders || [plan.folder]).map((folder) => `source:${plan.sourceRoot}/${folder}`), ...plan.rows.filter((row) => row.invoiceNumber).map((row) => `invoice:${row.invoiceNumber}`), ...plan.paymentKeys];
    for (const key of new Set(keys)) {
      const other = previousByKey.get(key);
      if (other) {
        const kind = key.startsWith('source:') ? '来源文件夹' : key.startsWith('invoice:') ? '发票' : '付款凭证';
        throw new Error(`“${other}”和“${planLabel(plan)}”使用同一${kind}，请先核对费用归属`);
      }
      previousByKey.set(key, planLabel(plan));
    }
  }
}

function storeCurrentPlan(plan, sourceRoot, revision) {
  plan.sourceRoot = sourceRoot;
  plan.configurationRevision = revision;
  for (const existing of plans.values()) {
    if (existing.folder !== plan.folder || existing.sourceRoot !== sourceRoot) continue;
    if (existing.signerOverride &&
        existing.fingerprint === plan.fingerprint && existing.project.projectNo === plan.project.projectNo && existing.funding === plan.funding) {
      plan.signer = existing.signerOverride;
      plan.signerOverride = existing.signerOverride;
    }
    plans.delete(existing.id);
  }
  applyMemoryToPlan(plan);
  plan.id = randomUUID();
  plans.set(plan.id, plan);
}

async function validateRun(run) {
  if (run.sourceRoot !== SOURCE_ROOT || run.configurationRevision !== configurationRevision) throw httpError(409, '本任务的根目录或配置已变化，请切回原配置并重新检查后再执行');
  return validateCurrentPlan(run.plan);
}

async function recordSubmitted(run) {
  if (claimWithdrawalFor(history, run.id)) return;
  if (run.control.progress.submission.state !== 'verified') throw new Error('缺少已核实提交结果，不会登记已报销');
  if (run.plan.payrollRevision) {
    if (run.bookkeeping?.payrollRecorded) return;
    const { financeFormId, verifiedAt, schoolStatus } = run.control.progress.submission;
    if (!financeFormId) throw new Error('学校薪酬申报单号缺失。');
    await withWorklistWrite(async () => {
      const group = claimGroupFor(run.sourceRoot, run.plan.folder);
      if (!group?.payroll || group.revision !== run.plan.payrollRevision ||
          group.status === 'submitted' && group.submission?.runId !== run.id) throw new Error('薪酬原事项已变化，请核对学校申报回执。');
      await saveGroup({
        ...group, status: 'submitted',
        submission: { runId: run.id, financeFormId, totalCny: run.plan.totalCny, at: verifiedAt, schoolStatus, payroll: true },
      });
    });
    run.bookkeeping = { ...run.bookkeeping, historyRecorded: true, payrollRecorded: true };
    run.status = 'completed';
    run.result = 'declared';
    run.error = null;
    await saveRuns();
    return;
  }
  const offline = run.plan.reimbursementRoute === 'legacy';
  if (offline && run.bookkeeping?.appointmentRecorded) return;
  if (run.plan.didi) {
    if (!run.control.progress.submission.financeFormId || run.control.progress.didiWallet?.state !== 'verified' || !run.plan.rows.length) {
      throw new Error('贸大出行缺少已核实的学校回执或票据记录');
    }
    validateDidiSelection(run.plan);
  }
  await withWorklistWrite(async () => {
    const updated = {
      ...history,
      submittedInvoiceNumbers: [...new Set([...history.submittedInvoiceNumbers, ...run.plan.rows.map((row) => row.invoiceNumber).filter(Boolean)])],
      submittedPaymentKeys: [...new Set([...history.submittedPaymentKeys, ...(run.plan.paymentKeys || [])])],
    };
    await atomicJson(HISTORY_FILE, updated);
    history = updated;
  });
  if (!offline && !run.plan.didi) {
    run.status = 'completed';
    run.result = 'submitted';
    run.error = null;
  }
  run.bookkeeping ||= {};
  run.bookkeeping.historyRecorded = true;
  await saveRuns();
  if (run.plan.groupId) {
    await withWorklistWrite(async () => {
      const group = claimGroupFor(run.sourceRoot, run.plan.folder);
      if (!group) throw new Error('已提交事项的来源映射缺失，请核对本机记录');
      const submission = { runId: run.id, financeFormId: run.control.progress.submission.financeFormId || run.control.progress.submission.documentId, totalCny: run.plan.totalCny, at: run.control.progress.submission.verifiedAt };
      if (run.plan.didi) Object.assign(submission, { didi: true, schoolStatus: run.control.progress.submission.receipt, invoiceCount: run.plan.rows.length });
      if (offline) submission.appointment = run.control.progress.booking.appointment.date;
      if (run.plan.projectAllocationDraft) submission.allocations = planProjects(run.plan);
      await saveGroup({ ...group, status: 'submitted', submission });
    });
  }
  if (offline) {
    run.bookkeeping.appointmentRecorded = true;
    await saveRuns();
    return;
  }
  if (run.plan.didi) {
    run.status = 'completed';
    run.result = 'submitted';
    run.error = null;
    run.bookkeeping.folderMarked = true;
    addMessage(run, 'assistant', `贸大出行已登记，学校单号 ${run.control.progress.submission.financeFormId}，报销 ${(run.plan.totalCny / 100).toFixed(2)} 元。`);
    await saveRuns();
    return;
  }
  try {
    const reimbursedFolder = await markFolderReimbursed(run.plan, run.sourceRoot);
    run.bookkeeping.folderMarked = true;
    delete run.bookkeeping.renameError;
    run.events.push({ type: 'step', step: '标记已报销', status: 'completed', detail: reimbursedFolder, at: new Date().toISOString() });
    addMessage(run, 'assistant', run.plan.groupId ? `已核实“${planLabel(run.plan)}”提交结果，${run.plan.sourceFolders.length} 个来源文件夹已归入报销历史。` : `已核实本单提交结果，文件夹已标记为“${reimbursedFolder}”。`);
    if (run.plan.groupId) await withWorklistWrite(async () => {
      const group = claimGroupFor(run.sourceRoot, run.plan.folder);
      await saveGroup({ ...group, archivedFolders: run.plan.archivedFolders });
    });
  } catch (error) {
    run.bookkeeping.renameError = error.message;
    addMessage(run, 'assistant', `本单已核实提交，发票已记入防重复记录；文件夹暂未改名：${error.message}。请核对后手动整理文件夹。`);
  }
  await saveRuns();
}

function isRecordedReimbursement(run) {
  return run && !run.plan.payrollRevision && run.bookkeeping?.historyRecorded &&
    run.control.progress.submission.state === 'verified';
}

async function restoreClaimFolders(run) {
  const root = await realpath(run.sourceRoot);
  const moves = [];
  const directoryExists = async (path) => {
    const entry = await lstat(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (entry && !entry.isDirectory()) throw httpError(409, '原票据路径已被其他文件占用，请核对文件夹');
    return Boolean(entry);
  };
  for (const folder of reimbursementSourceFolders(run.plan)) {
    const current = resolve(root, folder);
    const parent = await realpath(dirname(current));
    if (!isInsideDirectory(root, current) || (parent !== root && !isInsideDirectory(root, parent))) {
      throw httpError(409, '原票据文件夹不在当前票据根目录');
    }
    const archived = `${current}-已报销`;
    const currentExists = await directoryExists(current);
    const archivedExists = run.plan.reimbursementRoute !== 'legacy' && await directoryExists(archived);
    if (currentExists && archivedExists) throw httpError(409, `原文件夹和归档文件夹同时存在，请先核对：${folder}`);
    if (!currentExists && !archivedExists) throw httpError(409, `找不到原票据文件夹：${folder}`);
    if (archivedExists) moves.push({ archived, current });
  }
  for (const { archived, current } of moves) await rename(archived, current);
}

function withdrawReimbursement(run) {
  return withWorklistWrite(async () => {
    if (!isRecordedReimbursement(run) || run.sourceRoot !== SOURCE_ROOT) throw httpError(404, '找不到本票据目录中的报销原单');
    const group = claimGroupFor(run.sourceRoot, run.plan.folder);
    const linkedGroup = group?.status === 'submitted' && group.submission?.runId === run.id;
    const existing = claimWithdrawalFor(history, run.id);
    const folder = run.plan.groupId ? run.plan.folder : reimbursementSourceFolders(run.plan)[0];
    if (existing && !linkedGroup) return { folder };
    if (run.plan.groupId && !linkedGroup) throw httpError(409, '合并事项的原单记录已变化，请刷新后核对');
    const sources = reimbursementSourceFolders(run.plan);
    if ([...runs.values()].some((other) => other.sourceRoot === run.sourceRoot && ACTIVE_RUN_STATUSES.has(other.status) &&
        reimbursementSourceFolders(other.plan).some((source) => sources.includes(source)))) {
      throw httpError(409, '同一票据文件夹有正在执行的事项，请等当前执行结束');
    }
    if (!existing) {
      await restoreClaimFolders(run);
      const updated = markClaimWithdrawn(history, run, [...runs.values()].filter(isRecordedReimbursement));
      await atomicJson(HISTORY_FILE, updated);
      history = updated;
    }
    if (linkedGroup) {
      const { submission, archivedFolders, ...draft } = group;
      await saveGroup({ ...draft, status: 'draft' });
    }
    return { folder };
  });
}

function applyMemoryToPlan(plan) {
  if (memory.expenseTypeBySubject[plan.subject]) plan.expenseType = memory.expenseTypeBySubject[plan.subject];
  plan.expenseTypeRules = memory.expenseTypeRules || [];
  const saved = memory.signerByClaim[projectMatchKey(plan.sourceRoot, plan.folder)];
  if (saved?.signer?.name && saved.fingerprint === plan.fingerprint &&
      saved.projectNo === plan.project?.projectNo && saved.funding === plan.funding) {
    plan.signer = { ...saved.signer };
    plan.signerOverride = plan.signer;
  }
}

async function applyMemoryToPlans() {
  for (const plan of plans.values()) applyMemoryToPlan(plan);
  await savePlans();
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function publicConfig() {
  return { demoMode, sourceRoot: liveSourceRoot, defaultSourceRoot: workspace?.sourceRoot ?? DEFAULT_SOURCE_ROOT, workspace: publicWorkspace(workspace),
    paymentCardConfigured: Boolean(paymentCardLast4), preferences,
    reviewArchiveAvailable: !demoMode && await hasReviewArchive(REVIEW_ARCHIVE_FILE).catch(() => false) };
}

function selectWorkspaceYear(selection) {
  return withWorklistWrite(async () => {
    const next = await resolveWorkspace(APP_DIR, selection);
    if (next.dataDirectory !== DATA_APP_DIR) throw new Error('请选择当前使用人的年度。');
    if (next.sourceRoot === SOURCE_ROOT) return publicWorkspace(workspace);
    if (browserReservation || [...runs.values()].some((run) => ACTIVE_RUN_STATUSES.has(run.status)) || schoolFundingSync.view(SOURCE_ROOT)?.active) {
      throw new Error('当前年度还有正在执行或同步的操作，结束后再切换。');
    }
    await atomicJson(CONFIG_FILE, { demoMode, sourceRoot: demoMode ? '' : next.sourceRoot, liveSourceRoot: next.sourceRoot,
      preferences, paymentCardLast4, configurationRevision });
    workspace = next;
    SOURCE_ROOT = liveSourceRoot = next.sourceRoot;
    return publicWorkspace(workspace);
  });
}

async function body(request) {
  let text = '';
  request.setEncoding('utf8');
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 256 * 1024) throw httpError(413, '请求内容过大');
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw httpError(400, '请求内容格式有误'); }
}

function publicRun(run) {
  const booking = run.control.progress.booking;
  const appointment = run.control.progress.submission.state === 'verified' && booking?.appointment;
  const submission = run.control.progress.submission;
  const question = pending.get(run.id);
  const draftNumber = run.control.progress.payroll?.financeFormId || booking?.pdfFinanceFormId;
  const year = workspace ? basename(run.sourceRoot) : null;
  return {
    id: run.id,
    ...(isWorkspaceYear(year) ? { year } : {}),
    plan: publicPlan(run.plan),
    status: run.status,
    result: run.result,
    error: run.error,
    events: run.events,
    messages: run.messages,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    needsVerification: run.status === 'verification_required',
    canResumePreview: canResumeSmartPreview(run),
    canEndDraft: ['preview', 'verification_required', 'error'].includes(run.status) &&
      submission.state !== 'verified' && holdsDocument(run),
    pendingQuestion: question?.question || null,
    pendingKind: question?.metadata.kind || null,
    ...(question?.metadata.choices ? { pendingChoices: question.metadata.choices } : {}),
    ...(run.plan.payrollRevision && submission.state === 'verified' ? { payrollReceipt: {
      financeFormId: submission.financeFormId, schoolStatus: run.schoolPayrollStatus?.label || submission.schoolStatus,
    } } : {}),
    waitingForCampusLogin: run.control.waitingForCampusLogin === true,
    ...(run.control.schoolStep ? { schoolStep: run.control.schoolStep } : {}),
    ...(draftNumber ? { schoolDraftNo: draftNumber } : {}),
    ...(appointment ? { appointment: {
      date: appointment.date, campus: (appointment.campus || '松江') + '校区', financeFormId: run.control.progress.submission.financeFormId, pdfName: booking.pdfName,
    } } : {}),
  };
}

function publicBatch(batch) {
  const batchRuns = batch.runIds.map((id) => runs.get(id)).filter(Boolean).map(publicRun);
  return {
    id: batch.id,
    status: batch.status,
    currentIndex: batch.currentIndex,
    currentRunId: batch.currentRunId,
    error: batch.error,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    runs: batchRuns,
  };
}

function addMessage(run, role, text) {
  run.messages.push({ id: randomUUID(), role, text, at: new Date().toISOString() });
  run.updatedAt = new Date().toISOString();
}

async function markFolderReimbursed(plan, sourceRoot) {
  if (plan.sourceFolders) {
    plan.archivedFolders = [];
    for (const source of plan.sources) {
      plan.archivedFolders.push(await markFolderReimbursed({ folder: source.folder, fingerprint: source.fingerprint }, sourceRoot));
      await saveRuns();
    }
    return plan.archivedFolders.join('、');
  }
  if (plan.folder.endsWith('-已报销')) return plan.folder;
  const source = resolve(sourceRoot, plan.folder);
  const targetFolder = `${plan.folder}-已报销`;
  const target = resolve(sourceRoot, targetFolder);
  if (!isInsideDirectory(sourceRoot, source) || !isInsideDirectory(sourceRoot, target)) throw new Error('报销文件夹路径无效');
  try {
    const current = await fingerprintFolder(sourceRoot, plan.folder);
    if (current.fingerprint !== plan.fingerprint) throw new Error('提交后附件已变化，需人工整理本批文件夹');
    await rename(source, target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const marked = await fingerprintFolder(sourceRoot, targetFolder);
    if (marked.fingerprint !== plan.fingerprint) throw new Error('已报销文件夹与本任务附件不一致，需人工核对');
  }
  plan.folder = targetFolder;
  return targetFolder;
}

function createRun(plan) {
  return {
    id: randomUUID(),
    plan: structuredClone(plan),
    sourceRoot: plan.sourceRoot,
    configurationRevision: plan.configurationRevision,
    status: 'queued',
    result: null,
    error: null,
    events: [],
    messages: [],
    control: { paused: false, skipSubmit: false, autoSubmit: false, cancelled: false, resumeStages: false, progress: { uploads: [], submission: { state: 'not_started' } } },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function resumePending(run, question, answer) {
  pending.delete(run.id);
  run.status = 'running';
  run.updatedAt = new Date().toISOString();
  question.resolve(answer);
  saveRuns().catch(() => undefined);
}

function pendingAnswer(question, message) {
  const { kind, choices } = question.metadata;
  if (kind === 'amount_review') {
    const text = message.normalize('NFKC').replace(/\s|[。！!？?]+$/g, '');
    return directInstruction(message) === 'resume' || /^(?:请)?(?:(?:你|助手)来?)?(?:重新|再)?核对(?:一下|下|一遍)?(?:金额)?$/.test(text)
      ? '继续' : undefined;
  }
  if (!choices) return message;
  const compact = message.normalize('NFKC').replace(/\s/g, '');
  const numbered = choices.find(({ value }) => value === compact);
  if (numbered || kind !== 'project_expense_type') return numbered?.value;
  const requested = compact.replace(/[。！!]+$/, '')
    .replace(/^(?:(?:这笔|本笔|我选了?|选择|选|都是|都用|全部填入|用|按)){0,4}/, '')
    .replace(/^其他教育杂项费用$/, '其他教学杂项费用');
  return choices.find(({ label }) => [compact, requested].includes(label.replace(/\s/g, '')))?.value;
}

function pendingChoiceHint(question) {
  if (question.metadata.kind === 'amount_review') return question.question;
  return question.metadata.kind === 'project_expense_type'
    ? '请选择本笔的费用科目，也可以回复科目名称或选项编号。'
    : '请从当前学校搜索结果中选择人员，也可以回复选项编号。';
}

function isStatusQuestion(message) {
  return /[?？]\s*$/.test(message) || /到哪|哪一步|什么状态|(?:看下|看看|查询|报告).*进度|为什么|怎么回事|卡在哪|失败了吗|报错(?:了吗|了没|是什么)/.test(message);
}

function directInstruction(message) {
  if (isStatusQuestion(message)) return '';
  const text = message.replace(/\s|[。！!]+$/g, '').replace(/^请(?:你)?/, '');
  if (/^(?:先别|暂不|不要|别|不|取消)提交(?:[，,。].*)?$/.test(text)) return 'skip_submit';
  if (/^(?:取消任务|放弃(?:这笔)?|终止(?:执行)?|别报了|不报了|这笔算了)$/.test(text)) return 'cancel';
  if (/^(?:全自动|自动)?(?:重试|重新执行|再试一次)$/.test(text)) return 'retry';
  if (/^(?:暂停(?:执行)?|先停(?:一下)?|停止执行|停一下)$/.test(text)) return 'pause';
  if (/^(?:(?:我)?(?:已经|已)?登录(?:完成了?|成功了?|完了|好了)?[，,、]?)?(?:全自动|自动)?(?:继续(?:执行|报销)?|恢复(?:执行)?)$/.test(text)) return 'resume';
  return '';
}

async function answerWithCodex(run, message) {
  const question = run && pending.get(run.id);
  const local = !run ? null
    : run.status === 'completed' ? '本笔已收到学校回执并登记。'
    : question ? question.question
    : run.control.waitingForCampusLogin ? '正在等待校园网登录，完成后会接着执行。'
    : run.status === 'verification_required' ? run.error || '学校结果待核实，回复「继续」可核对原单。'
    : run.status === 'error' ? ['本笔执行已暂停。', run.error, !run.resolved && !run.control.cancelled &&
      (run.control.progress.uploadPageId || run.control.portalPageId) ? '原单仍打开时，可回复「继续」接回原单。' : ''].filter(Boolean).join(' ')
    : null;
  const context = run && {
    status: run.status,
    pending: question?.metadata.kind,
    campusLogin: run.control.waitingForCampusLogin === true,
    submission: run.control.progress.submission.state,
    latestSteps: run.events.slice(-6).map(({ step, status }) => ({ step, status })),
  };
  const answer = local || await askInteractionAgent({
    mode: 'status', input: { context, message },
    cwd: APP_DIR,
    settingsDir: DATA_APP_DIR,
  }).catch(() => {
    if (!run) return '当前没有选中的报销任务。';
    const latest = run.events.at(-1)?.step;
    return latest ? `最近一步是「${latest}」。${run.error || ''}` : run.error || '当前任务还没有执行记录。';
  });
  if (run) {
    addMessage(run, 'assistant', answer);
    await saveRuns();
  }
  return answer;
}

async function openSchoolRunSession(run, signal) {
  if (schoolFundingSync.view(run.sourceRoot)?.active) throw new Error('学校执行表正在同步。同步结束后回复「继续」。');
  const previous = run.control.portalPageId || '';
  signal.throwIfAborted();
  const browserSession = await getBrowserSession(DATA_APP_DIR);
  const page = await browserPageForTarget(browserSession.context, previous);
  const session = { ...browserSession, page: page || await browserSession.context.newPage() };
  try {
    run.control.portalPageId = await browserTargetId(session.page);
    if (run.control.portalPageId !== previous && run.control.progress.submission.state === 'not_started') delete run.control.progress.booking;
    await saveRuns();
    return session;
  } catch (error) {
    await session.cleanup?.();
    throw error;
  }
}

async function executeSchoolRun(run) {
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(8 * 60 * 1000)]);
  const log = (step, detail) => {
    run.updatedAt = new Date().toISOString();
    run.events.push({ type: 'step', step, status: 'running', detail, at: run.updatedAt });
    saveRuns().catch(() => undefined);
  };
  const stage = (step) => {
    if (run.control.schoolStep === step) return;
    run.control.schoolStep = step;
    run.updatedAt = new Date().toISOString();
    saveRuns().catch(() => undefined);
  };
  let access;
  try {
    const options = {
      plan: run.plan, control: run.control, sourceRoot: run.sourceRoot, signal,
      autoPrint: preferences.autoPrint, campus: preferences.campus, legacyPaymentLabel: preferences.legacyPaymentLabel,
      openSession: (attemptSignal = signal) => openSchoolRunSession(run, attemptSignal),
      validate: () => validateRun(run),
      persist: () => saveRuns(),
      record: () => recordSubmitted(run),
      async captureSchoolError(page) {
        const directory = join(RUNTIME_DIR, 'recovery', run.id);
        const image = await page.screenshot({ timeout: 5000 });
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(join(directory, `school-${Date.now()}.png`), image, { mode: 0o600 });
      },
      onAccess(state) {
        if (run.control.cancelled) stop.abort();
        if (access === state) return;
        access = state;
        run.control.waitingForCampusLogin = state === 'waiting_login';
        if (state === 'waiting_network') {
          stage('等待 aTrust 连通');
          log('等待学校网络', '请在运行学校财务系统的电脑上登录 aTrust。');
        }
        if (state === 'waiting_login') {
          stage('等待学校登录');
          log('等待学校登录', '完成学校统一身份认证后自动继续。');
        }
      },
      log, stage,
      async ask(question, metadata) {
        run.status = 'waiting_input';
        addMessage(run, 'assistant', question);
        const answer = new Promise((resolvePromise, reject) => {
          pending.set(run.id, { question, metadata, resolve: resolvePromise, reject });
        });
        await saveRuns();
        return answer;
      },
    };
    let result;
    if (run.plan.payrollRevision) {
      const payroll = claimGroupFor(run.sourceRoot, run.plan.folder)?.payroll;
      const executePayroll = run.plan.payrollPreview || !run.plan.fingerprint ? preparePayrollHeader : executeSchoolPayroll;
      if (executePayroll === executeSchoolPayroll && !payrollLookupKeySaved) await withWorklistWrite(async () => {
        if (payrollLookupKeySaved) return;
        await atomicJson(PAYROLL_RECIPIENTS_FILE, { lookupKey: payrollLookupKey, people: [] });
        payrollLookupKeySaved = true;
      });
      const payrollOptions = {
        ...options, payroll, lookupKey: payrollLookupKey,
        rememberRecipient: (person) => withWorklistWrite(() => rememberPayrollPerson(person)),
      };
      result = executePayroll === executeSchoolPayroll ? await runPayrollWithRecovery(executePayroll, payrollOptions, {
        waiting: () => run.control.paused || run.status === 'waiting_input' || ['waiting_login', 'waiting_network'].includes(access),
        async onRetry(attempt) {
          stage('正在接回学校原单');
          log('自动恢复', `正在重新读取原单（第 ${attempt}/3 次）`);
          await saveRuns();
        },
      }) : await executePayroll(payrollOptions);
    } else result = await executeDailySchoolBooking(options);
    run.result = result;
    run.status = result === 'preview' ? 'preview' : 'completed';
    run.error = null;
    if (result === 'booked') {
      const { booking, submission } = run.control.progress;
      const printing = booking.printState === 'queued' ? 'PDF 已保存并送印。' : booking.printState === 'uncertain' ? 'PDF 已保存，打印结果待确认。' : 'PDF 已保存，可打印。';
      addMessage(run, 'assistant', `已在报销单查询核实${booking.appointment.campus || '松江'}校区 ${booking.appointment.date} 的预约，学校单号 ${submission.financeFormId}。${printing}`);
    }
    if (result === 'payroll_header_ready') {
      const signer = run.plan.signer?.name;
      addMessage(run, 'assistant', `学校申报抬头已填好。${signer ? `本机已带出加签人${signer}。` : ''}人员明细、加签和提交待学校端核对。`);
    }
    if (result === 'declared') addMessage(run, 'assistant', `学校已受理薪酬申报，单号 ${run.control.progress.submission.financeFormId}。`);
  } catch (error) {
    run.status = hasUnresolvedEffect(run) ? 'verification_required' : 'error';
    run.error = stop.signal.aborted ? '用户已停止本笔申报。' : error.message.split('\n')[0].replace(/https?:\/\/[^\s]+/g, '学校网页');
    run.errorCode = error.code || null;
    addMessage(run, 'assistant', run.error);
  } finally {
    delete run.control.waitingForCampusLogin;
    pending.delete(run.id);
    run.updatedAt = new Date().toISOString();
    await saveRuns();
  }
}

async function executeRun(run) {
  if (run.plan.reimbursementRoute === 'legacy' || run.plan.payrollRevision) return executeSchoolRun(run);
  const executor = new ReimbursementExecutor({
    plan: run.plan,
    appDir: DATA_APP_DIR,
    control: run.control,
    resumeStages: run.control.resumeStages === true,
    validate: () => validateRun(run),
    onProgress: () => saveRuns(),
    getSubmittedInvoices: () => history.submittedInvoiceNumbers,
    onEvent(event) {
      run.events.push(event);
      run.updatedAt = event.at;
      saveRuns().catch(() => undefined);
    },
    async ask(question, metadata = {}) {
      run.status = 'waiting_input';
      addMessage(run, 'assistant', question);
      const answer = new Promise((resolvePromise, reject) => {
        pending.set(run.id, { question, metadata, resolve: resolvePromise, reject });
      });
      await saveRuns();
      return answer;
    },
    onLearned(kind, value) {
      if (kind !== 'expenseType') return;
      learnExpenseType(DATA_APP_DIR, memory, run.plan.subject, value).then((learned) => {
        if (learned) {
          const ruleText = value.rules?.length ? `；特例 ${value.rules.map((rule) => `${rule.keyword}→${rule.type}`).join('、')}` : '';
          addMessage(run, 'assistant', `已记住：“${run.plan.subject}”明细费用类型默认“${value.defaultType}”${ruleText}，下次自动使用。`);
        }
      }).catch(() => undefined);
    },
  });
  try {
    const result = await executeRunWithRecovery({
      executor, run, cwd: APP_DIR, settingsDir: DATA_APP_DIR,
      onRecovery(detail, status) {
        executor.log('自动恢复', status, detail);
        if (status === 'waiting') addMessage(run, 'assistant', detail);
      },
    });
    run.result = result;
    run.status = result === 'submitted' ? (run.plan.didi ? 'running' : 'completed') : result === 'verification_required' ? 'verification_required' : 'preview';
    if (result === 'submitted') await recordSubmitted(run);
    if (result === 'verification_required') addMessage(run, 'assistant', '学校结果尚未核实。回复「继续」可重新核对原单。');

  } catch (error) {
    run.status = hasUnresolvedEffect(run) ? 'verification_required' : 'error';
    run.error = error.message;
    run.errorCode = error.code === CAMPUS_LOGIN_REQUIRED ? CAMPUS_LOGIN_REQUIRED : null;
    addMessage(run, 'assistant', `执行暂停：${error.message}`);
  } finally {
    pending.delete(run.id);
    run.updatedAt = new Date().toISOString();
    await savePlans().catch(() => undefined);
    await saveRuns();
  }
}

async function executeBatch(batch, startIndex = 0) {
  batch.status = 'running';
  batch.error = null;
  batch.updatedAt = new Date().toISOString();
  for (let index = startIndex; index < batch.runIds.length; index += 1) {
    const run = runs.get(batch.runIds[index]);
    if (!run) continue;
    const school = (candidate) => ['legacy', 'labor'].includes(candidate.plan.reimbursementRoute);
    const previous = batch.runIds.slice(0, index).map((id) => runs.get(id))
      .findLast((candidate) => candidate?.status === 'completed' && school(candidate) === school(run));
    if (previous) {
      run.control.portalPageId ||= previous.control.progress.uploadPageId || previous.control.portalPageId;
      if (previous.plan.reimbursementRoute === run.plan.reimbursementRoute) {
        run.control.previousFinanceFormId = previous.control.progress.submission.financeFormId;
      }
    }
    batch.currentIndex = index;
    batch.currentRunId = run.id;
    batch.updatedAt = new Date().toISOString();
    try { if (!schoolReceiptOnly(run)) await validateRun(run); } catch (error) {
      run.status = 'error';
      run.error = error.message;
      batch.status = 'error';
      batch.error = error.message;
      for (const id of batch.runIds.slice(index + 1)) { const queued = runs.get(id); if (queued) queued.status = 'stopped'; }
      await saveRuns();
      return;
    }
    run.status = 'running';
    const amount = run.plan.didi ? `预算上限 ${(run.plan.didi.budgetCny / 100).toFixed(2)} 元` : `金额 ${(run.plan.totalCny / 100).toFixed(2)} 元`;
    addMessage(run, 'assistant', `开始执行“${planLabel(run.plan)}”，${amount}。`);
    await executeRun(run);
    if (run.status !== 'completed') {
      batch.status = run.status;
      for (const id of batch.runIds.slice(index + 1)) { const queued = runs.get(id); if (queued) queued.status = 'stopped'; }
      await saveRuns();
      return;
    }
    batch.updatedAt = new Date().toISOString();
  }
  batch.currentRunId = null;
  const failed = batch.runIds.map((id) => runs.get(id)).some((run) => run?.status === 'error');
  batch.status = failed ? 'completed_with_errors' : 'completed';
  batch.updatedAt = new Date().toISOString();
}

async function checkCampusLogin() {
  const { page } = await getBrowserSession(DATA_APP_DIR);
  await page.bringToFront().catch(() => undefined);
  const onSchoolPage = /znbx\.suibe\.edu\.cn|authserver\.suibe\.edu\.cn/.test(page.url());
  const forbidden = (await page.title().catch(() => '')) === '403 Forbidden';
  if (!onSchoolPage || forbidden) {
    const targetUrl = process.env.SUIBE_REIMBURSEMENT_URL || await savedPlatformUrl(DATA_APP_DIR) || PLATFORM_DEFAULT_URL;
    try {
      const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (response && response.status() >= 400) {
        return { loggedIn: false, status: 'unreachable', message: `学校财务页面返回 ${response.status()}，请检查校园网连接后重试。` };
      }
      await page.waitForTimeout(2000);
    } catch {
      return { loggedIn: false, status: 'unreachable', message: '学校网页暂时不可达，请检查校园网连接后重试。' };
    }
  }
  if (/authserver\.suibe\.edu\.cn/.test(page.url())) {
    return { loggedIn: false, status: 'login_required', message: '请在报销专用 Chrome 中完成学校统一身份认证。' };
  }
  await page.waitForTimeout(1500);
  const text = (await Promise.all(page.frames().map(async (frame) => {
    try { return await frame.locator('body').innerText({ timeout: 1000 }); } catch { return ''; }
  }))).join('\n');
  if (/znbx\.suibe\.edu\.cn/.test(page.url()) && /财务服务平台|网上报销|智能网报/.test(text)) {
    await savePlatformSession(page, DATA_APP_DIR).catch(() => undefined);
    return { loggedIn: true, status: 'logged_in', message: '校园网报销平台已登录，会话可复用。' };
  }
  return { loggedIn: false, status: 'unknown', message: '已打开学校网页。若专用 Chrome 停在认证页，请登录后重新检查。' };
}

async function route(request, response) {
  const host = request.headers.host;
  const localHosts = [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`];
  if (!localHosts.includes(host)) throw httpError(403, '请从本机报销助手页面访问。');
  const url = new URL(request.url, `http://${host}`);
  const isApi = url.pathname.startsWith('/api/');
  if (isApi && (request.headers['sec-fetch-site'] === 'cross-site' ||
      request.headers.origin && request.headers.origin !== 'http://' + host)) {
    throw httpError(403, '请从本机报销助手页面访问。');
  }
  if (isApi && !['GET', 'HEAD'].includes(request.method) &&
      request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, '请从本机报销助手页面操作。');
  const requestYear = request.headers['x-reimbursement-year'] || url.searchParams.get('year');
  if (isApi && workspace && requestYear && requestYear !== workspace.year &&
      url.pathname !== '/api/workspaces') {
    throw httpError(409, '当前年度已切换，请刷新页面后再操作。');
  }
  if (workspace && request.method === 'POST') {
    const action = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/(?:resolution|instructions|replies|withdrawal)$/);
    const run = action && runs.get(action[1]);
    if (run && run.sourceRoot !== SOURCE_ROOT) throw httpError(409, '请切回这笔任务所属的年度后再操作。');
  }
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return json(response, 200, { ok: true, edition: 'community', planVersion: PLAN_VERSION, profile: PROFILE_ID,
      program: profileId(APP_DIR), revision: SERVICE_REVISION, workspaceManaged: Boolean(workspace) && process.connected });
  }
  if (url.pathname === '/api/workspaces') {
    if (!workspace || !process.connected) throw httpError(404, '请从「打开报销助手」启动后选择使用人与年度。');
    if (request.method === 'GET') return json(response, 200, { current: publicWorkspace(workspace), owners: await listWorkspaces(APP_DIR) });
    if (request.method === 'POST') {
      const input = await body(request);
      const allowCreate = input?.create === true;
      try {
        return json(response, 200, await requestWorkspaceProcess(process, 'open', { owner: input?.owner, year: input?.year, create: allowCreate }));
      } catch (error) { throw httpError(409, error.message); }
    }
    throw httpError(405, '请从使用人与年度菜单操作。');
  }
  if (demoMode && url.pathname.startsWith('/api/') && !['/api/config', '/api/model-settings'].includes(url.pathname) &&
      (request.method !== 'GET' || !['/api/funding-summary', '/api/funding-summary/source',
        '/api/funding-summary/sync', '/api/folders', '/api/projects', '/api/runs', '/api/batches'].includes(url.pathname))) {
    throw httpError(409, '示例模式只读取虚构数据。切换到正式模式后可办理。');
  }
  if (request.method === 'GET' && url.pathname === '/api/model-settings') {
    return json(response, 200, publicModelSettings(await readModelSettings(DATA_APP_DIR)));
  }
  if (request.method === 'POST' && url.pathname === '/api/model-settings') {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, '请通过本机设置页面保存模型');
    const input = await body(request);
    return withWorklistWrite(async () => {
      const previous = await readModelSettings(DATA_APP_DIR);
      let settings;
      try { settings = normalizeModelSettings(input, previous); }
      catch (error) { throw httpError(400, error.message); }
      await atomicJson(MODEL_CONFIG_FILE, settings);
      return json(response, 200, publicModelSettings(settings));
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/login-status') {
    return withBrowserReservation(async () => json(response, 200, await checkCampusLogin()));
  }
  if (request.method === 'POST' && url.pathname === '/api/school-finance/check') {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, '请通过工作清单核对学校入口。');
    const kind = (await body(request))?.kind;
    if (kind !== 'legacy' && kind !== 'labor') throw httpError(400, '请选择日常线下报销或薪酬申报。');
    return withBrowserReservation(async () => {
      if (schoolFundingSync.view(SOURCE_ROOT)?.active) throw httpError(409, '学校执行表正在同步，请同步结束后核对填报入口。');
      const signal = AbortSignal.timeout(58000);
      const session = await getBrowserSession(DATA_APP_DIR, { temporary: true });
      let result;
      try {
        result = await checkSchoolFinancePage(session.page, { kind, signal });
      } catch (error) {
        if (signal.aborted) throw httpError(504, '学校填报入口核对超时。请检查本机的校园网或零信任连接后重试。');
        throw error;
      } finally {
        await session.page.close().catch(() => undefined);
        await session.cleanup?.();
      }
      return json(response, 200, { kind, computer: '本机', ...result });
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/config') {
    return json(response, 200, await publicConfig());
  }
  if (request.method === 'POST' && url.pathname === '/api/config') {
    return withBrowserReservation(() => withWorklistWrite(async () => {
      const input = await body(request);
      if (workspace && (workspace.example || input.demoMode === true || String(input.sourceRoot || '').trim() !== workspace.sourceRoot)) {
        throw httpError(409, '请从页面上方选择使用人和年度。');
      }
      const nextDemo = input.demoMode === true;
      let nextRoot = EXAMPLE_ROOT;
      if (!nextDemo) {
        if (!String(input.sourceRoot || '').trim()) throw httpError(400, '请填写票据根目录');
        const requestedRoot = resolve(String(input.sourceRoot).trim().replace(/^"(.*)"$/, '$1'));
        try { nextRoot = await receiptDirectory(requestedRoot, APP_DIR, DATA_APP_DIR, workspace); }
        catch (error) { throw httpError(400, error.message); }
        if (nextRoot === DEFAULT_SOURCE_ROOT && !process.env.REIMBURSEMENT_SOURCE_ROOT) await mkdir(nextRoot, { recursive: true, mode: 0o700 });
        if (!await readdir(nextRoot).catch(() => null)) throw httpError(400, '票据目录不存在或不可读');
      }
      const nextCard = input.paymentCardLast4 === undefined ? paymentCardLast4 : String(input.paymentCardLast4);
      if (nextCard && !/^\d{4}$/.test(nextCard)) throw httpError(400, '公务卡尾号应为 4 位数字');
      let nextPreferences;
      try { nextPreferences = localPreferences(input.preferences, preferences); }
      catch (error) { throw httpError(400, error.message); }
      const changed = nextRoot !== SOURCE_ROOT || nextDemo !== demoMode || nextCard !== paymentCardLast4 || !isDeepStrictEqual(nextPreferences, preferences);
      const nextRevision = changed ? randomUUID() : configurationRevision;
      await atomicJson(CONFIG_FILE, { demoMode: nextDemo, sourceRoot: nextDemo ? '' : nextRoot,
        liveSourceRoot: nextDemo ? liveSourceRoot : nextRoot, preferences: nextPreferences,
        paymentCardLast4: nextCard, configurationRevision: nextRevision });
      if (nextRoot !== SOURCE_ROOT) schoolFundingSync.stop(SOURCE_ROOT, '票据目录已切换。');
      SOURCE_ROOT = nextRoot;
      if (!nextDemo) liveSourceRoot = nextRoot;
      demoMode = nextDemo;
      preferences = nextPreferences;
      paymentCardLast4 = nextCard;
      configurationRevision = nextRevision;
      return json(response, 200, { ...await publicConfig(), changed });
    }));
  }
  if (url.pathname === '/api/review-archive') {
    if (request.method !== 'GET') throw httpError(405, '旧审核档案供查阅。');
    const id = url.searchParams.get('batch');
    if (id !== null && (!id || id.length > 128)) throw httpError(400, '旧批次编号格式有误。');
    const year = workspace ? Number(workspace.year) : null;
    const archive = await (id === null ? listArchivedBatches(REVIEW_ARCHIVE_FILE, year) : readArchivedBatch(REVIEW_ARCHIVE_FILE, id, year))
      .catch(() => { throw httpError(500, '无法读取旧审核档案，请核对导入的数据库。'); });
    if (!archive) throw httpError(404, id === null ? '当前用户资料没有旧审核档案。' : '找不到旧审核批次。');
    return json(response, 200, archive);
  }
  if (request.method === 'GET' && url.pathname === '/api/folders') {
    if (demoMode) return json(response, 200, { sourceRoot: SOURCE_ROOT, folders: [], claims: [], signerNames: [], payrollCategories: [], payrollPositions: [], payrollExpenseItems: [], payrollSignerNames: {} });
    const sourceRoot = SOURCE_ROOT;
    const appointments = schoolBookingsFor(sourceRoot);
    const bySource = new Map(appointments.flatMap((run) => (run.plan.sourceFolders || [run.plan.folder]).map((folder) => [folder, run])));
    const entries = await listFinalFolders(sourceRoot);
    const paths = new Set(entries.map((folder) => folder.path));
    const reimbursements = new Map();
    for (const run of runs.values()) {
      if (run.sourceRoot !== sourceRoot || !isRecordedReimbursement(run) || run.plan.groupId ||
          run.plan.reimbursementRoute === 'legacy' || claimWithdrawalFor(history, run.id)) continue;
      const [original] = reimbursementSourceFolders(run.plan);
      const archive = `${original}-已报销`;
      reimbursements.set(paths.has(archive) ? archive : original, run);
    }
    const folders = entries.map((folder) => bySource.has(folder.path) || reimbursements.has(folder.path) ? { ...folder, reimbursed: true } : folder);
    const groups = [...claimGroups.values()].filter((group) => group.sourceRoot === sourceRoot && group.status !== 'dissolved');
    const claimed = new Map(groups.flatMap((group) => group.folders.map((folder) => [folder, group])));
    const archived = new Set(groups.flatMap((group) => [...(group.archivedFolders || []), ...(group.submission?.appointment ? group.folders : [])]));
    const claims = groups.map((group) => {
      const receiptRun = runs.get(group.submission?.runId);
      const submission = group.submission?.appointment && receiptRun ? { ...group.submission, ...appointmentSummary(receiptRun) }
        : group.submission?.payroll && receiptRun?.schoolPayrollStatus
          ? { ...group.submission, schoolStatus: receiptRun.schoolPayrollStatus.label } : group.submission;
      return {
        path: group.key, groupId: group.id, label: group.status === 'submitted' ? (group.reason?.draft || group.name) : group.name, sourceFolders: group.folders,
        subject: group.status === 'draft' ? memory.subjectByFolder?.[folderMemoryKey(sourceRoot, group.key)] || group.subject : group.subject,
        fileCount: group.folders.reduce((total, folder) => total + (folders.find((item) => item.path === folder)?.fileCount || 0), 0) || group.fileCount,
        match: group.match, reasonDraft: group.reason?.draft || '', reasonSaved: group.reason?.savedOnce === true,
        offlineBooking: bookingOptionsFor(sourceRoot, group.key)?.offline === true,
        reimbursed: group.status === 'submitted',
        submission,
        withdrawalRunId: group.status === 'submitted' && isRecordedReimbursement(receiptRun) ? receiptRun.id : undefined,
        archivedFolders: group.archivedFolders,
        ...(group.didi ? { didi: { budgetCny: group.didi.budgetCny, revision: group.revision, blocker: group.status === 'draft' ? didiBlocker(group) : '' } } : {}),
        ...(group.payroll ? { payroll: {
          category: group.payroll.category,
          peopleCount: group.payroll.people.length,
          totalCny: group.payroll.totalCny,
          signerName: approvalFor(group.payroll)?.signer?.name || '',
          revision: group.revision,
          blocker: group.status === 'draft' ? payrollBlocker(group) : '',
        } } : {}),
      };
    });
    claims.push(...folders.filter((folder) => folder.reimbursed && !archived.has(folder.path)).map((folder) => {
      const booked = bySource.get(folder.path);
      return booked
        ? { ...folder, label: planLabel(booked.plan), submission: appointmentSummary(booked), withdrawalRunId: booked.id }
        : { ...folder, withdrawalRunId: reimbursements.get(folder.path)?.id };
    }));
    return json(response, 200, { sourceRoot, claims, signerNames: [...new Set([...memory.signerNames, ...Object.values(preferences.signers).filter(Boolean).map(({ name }) => name)])], payrollCategories: PAYROLL_CATEGORIES, payrollPositions: PAYROLL_POSITIONS, payrollExpenseItems: PAYROLL_EXPENSE_ITEMS, payrollSignerNames: payrollSignerNames(preferences.signers), folders: folders.map((folder) => {
      if (folder.reimbursed) return folder;
      const key = projectMatchKey(sourceRoot, folder.path);
      const reason = claimReasons.get(key);
      const group = claimed.get(folder.path);
      return { ...folder, subject: memory.subjectByFolder?.[folderMemoryKey(sourceRoot, folder.path)], claimKey: group?.key, claimLabel: group?.name, match: projectMatches.get(key), reasonDraft: reason?.draft, reasonSaved: reason?.savedOnce === true };
    }) });
  }
  if (request.method === 'GET' && url.pathname === '/api/payroll-people') {
    const category = url.searchParams.get('category');
    if (!PAYROLL_CATEGORIES.includes(category)) throw httpError(400, '请选择薪酬套类');
    const sourceRoot = SOURCE_ROOT;
    const result = await payrollPeopleFor(sourceRoot, category);
    if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据目录已变化，请刷新');
    return json(response, 200, { ...result, sourceRoot, schoolSearch: category === STUDENT_PAYROLL });
  }
  if (request.method === 'POST' && ['/api/payroll-people/search', '/api/payroll-people/confirm'].includes(url.pathname)) {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, '请在薪酬申报表中选择人员');
    const input = await body(request);
    const { sourceRoot, category } = input;
    if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据目录已变化，请刷新');
    if (!PAYROLL_CATEGORIES.includes(category)) throw httpError(400, '请选择薪酬套类');
    if (url.pathname.endsWith('/search')) {
      const name = normalizeClaimReason(input.name);
      if (!name || name.length > 50) throw httpError(400, '请填写人员姓名');
      if (category !== STUDENT_PAYROLL) throw httpError(409, '本套类可从历史发放人员选择。新姓名可先保存到草稿。');
      return withBrowserReservation(async () => {
        if (schoolFundingSync.view(sourceRoot)?.active) throw httpError(409, '学校执行表正在同步，请稍后查询人员');
        const signal = AbortSignal.timeout(78000);
        const session = await getBrowserSession(DATA_APP_DIR, { temporary: true });
        try {
          const result = await searchSchoolStudents(session.page, { name, key: payrollLookupKey, signal });
          const now = Date.now();
          for (const [key, choice] of schoolPayrollChoices) {
            if (choice.expiresAt <= now) schoolPayrollChoices.delete(key);
          }
          for (const person of result.people) schoolPayrollChoices.set(person.key, { person, sourceRoot, expiresAt: now + 10 * 60 * 1000 });
          return json(response, 200, result);
        } catch (error) {
          throw httpError(502, error.message.split('\n')[0]);
        } finally {
          await session.page.close().catch(() => undefined);
          await session.cleanup?.();
        }
      });
    }
    const key = String(input.key || '');
    if (!/^[a-f\d]{64}$/.test(key)) throw httpError(400, '请选择一位查询结果中的人员');
    const school = schoolPayrollChoices.get(key);
    const remembered = payrollRecipients.get(key);
    const person = school?.sourceRoot === sourceRoot && school.expiresAt > Date.now() ? school.person
      : remembered || (await payrollPeopleFor(sourceRoot, category)).people.find((item) => item.key === key);
    if (person?.category !== category || person.name !== normalizeClaimReason(input.name)) throw httpError(409, '人员结果已变化，请重新查找');
    return withWorklistWrite(async () => {
      if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据目录已变化，请刷新');
      return json(response, 200, { person: await rememberPayrollPerson(person) });
    });
  }
  const didiMatch = url.pathname.match(/^\/api\/didi-claims(?:\/([a-f\d-]+))?$/);
  if (didiMatch && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
    const [, id] = didiMatch;
    if (id ? request.method === 'POST' : request.method !== 'POST') throw httpError(405, '请从贸大出行事项办理');
    const input = await body(request);
    return withWorklistWrite(async () => {
      if (input.sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新');
      const existing = id && claimGroupFor(SOURCE_ROOT, `@事项/${id}`);
      if (id && (!existing?.didi || existing.status !== 'draft' || folderHasOpenRun(SOURCE_ROOT, existing.key))) {
        throw httpError(409, '本笔贸大出行已变化、正在执行或等待核实');
      }
      if (request.method === 'DELETE') {
        await saveGroup({ ...existing, status: 'dissolved' });
        return json(response, 200, { key: existing.key });
      }
      const budgetCny = didiBudgetCny(input.budget);
      if (!budgetCny) throw httpError(400, '请填写大于零的预算上限，最多两位小数');
      const groupId = id || randomUUID();
      const key = `@事项/${groupId}`;
      const group = existing || {
        id: groupId, key, sourceRoot: SOURCE_ROOT, folders: [], name: '贸大出行', subject: '贸大出行',
        match: null, status: 'draft', fileCount: 0, createdAt: new Date().toISOString(),
      };
      await saveGroup({ ...group, didi: { budgetCny }, revision: randomUUID() });
      return json(response, id ? 200 : 201, { id: groupId, key });
    });
  }
  const payrollMatch = url.pathname.match(/^\/api\/payroll-claims(?:\/([a-f\d-]+)(\/prepare)?)?$/);
  if (payrollMatch && ['GET', 'POST', 'PUT'].includes(request.method)) {
    const [, id, prepare] = payrollMatch;
    const existing = id && claimGroupFor(SOURCE_ROOT, `@事项/${id}`);
    if (id && !existing?.payroll) throw httpError(404, '薪酬申报事项不存在');
    const approval = existing?.payroll && approvalFor(existing.payroll);
    if (request.method === 'GET' && id && !prepare) return json(response, 200, { revision: existing.revision, project: existing.match, ...existing.payroll, ...approval });
    if (prepare ? request.method !== 'POST' : (request.method !== 'POST' || id) && (request.method !== 'PUT' || !id)) {
      throw httpError(405, '请从薪酬申报清单办理');
    }
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, '请通过薪酬申报表保存');
    const input = await body(request);
    if (prepare) {
      await worklistWrites;
      if (input.sourceRoot !== SOURCE_ROOT || existing !== claimGroupFor(SOURCE_ROOT, existing.key) || existing.status !== 'draft') {
        throw httpError(409, '薪酬申报已变化，请刷新');
      }
      const blocker = payrollBlocker(existing);
      if (blocker) throw httpError(409, blocker);
      const plan = payrollPlan(existing, true);
      const run = createRun(plan);
      reserveBrowser(run.id);
      run.status = 'running';
      runs.set(run.id, run);
      addMessage(run, 'assistant', '正在填入学校薪酬申报抬头。');
      executeRun(run).catch(() => undefined).finally(() => releaseBrowser(run.id));
      await saveRuns();
      return json(response, 202, { run: publicRun(run) });
    }
    return withWorklistWrite(async () => {
      if (input.sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新');
      if (id && (existing !== claimGroupFor(SOURCE_ROOT, existing.key) || existing.status !== 'draft' || input.revision !== existing.revision || folderHasOpenRun(SOURCE_ROOT, existing.key))) {
        throw httpError(409, '该薪酬事项已变化或正在执行，请刷新');
      }
      let payroll;
      try {
        payroll = payrollIntake(input, {
          recipients: payrollRecipients,
          previousPeople: existing?.payroll.category === input.category ? existing.payroll.people : [],
        });
      }
      catch (error) { throw httpError(400, error.message); }
      const groupId = id || randomUUID();
      const key = `@事项/${groupId}`;
      const group = {
        id: groupId, key, sourceRoot: SOURCE_ROOT, folders: [], name: payroll.reason, subject: '劳务费',
        match: existing?.match ?? null,
        reason: { draft: payroll.reason, savedOnce: true },
        status: 'draft', fileCount: 0, payroll, revision: randomUUID(),
        createdAt: existing?.createdAt || new Date().toISOString(),
      };
      await saveGroup(group);
      return json(response, id ? 200 : 201, { id: groupId, key });
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/claim-groups') {
    const input = await body(request);
    return withWorklistWrite(async () => {
      if (input.sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新');
      const merging = Array.isArray(input.mergeKeys) ? input.mergeKeys.map((key) => claimGroupFor(SOURCE_ROOT, key)) : [];
      if (merging.some((group) => !group || group.status !== 'draft' || group.payroll || group.didi)) throw httpError(409, '请选择尚未执行的文件报销事项');
      const sources = merging.length ? merging.flatMap((group) => group.folders) : input.folders;
      if (!Array.isArray(sources) || !sources.length || sources.some((folder) => typeof folder !== 'string') || new Set(sources).size !== sources.length) throw httpError(400, '请选择不重复的来源文件夹');
      const folders = [...sources].sort();
      const available = await listFinalFolders(input.sourceRoot);
      if (input.sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新');
      if (folders.some((folder) => !available.some((item) => item.path === folder && !item.reimbursed)) ||
          schoolBookingsFor(SOURCE_ROOT).some((run) => (run.plan.sourceFolders || [run.plan.folder]).some((folder) => folders.includes(folder)))) throw httpError(409, '来源文件夹已变化或已经办理，请刷新');
      const mergedKeys = new Set(merging.map((group) => group.key));
      const occupied = [...claimGroups.values()].find((group) => group.sourceRoot === SOURCE_ROOT && group.status !== 'dissolved' && !mergedKeys.has(group.key) && group.folders.some((folder) => folders.includes(folder)));
      if (occupied) throw httpError(409, '来源文件夹已经加入其他报销事项，请先拆开或合并该事项');
      if (folders.some((folder) => folderHasOpenRun(SOURCE_ROOT, folder))) throw httpError(409, '来源文件夹正在执行或等待核实');
      const oldMatches = merging.length ? merging.map((group) => group.match) : folders.map((folder) => projectMatchFor(SOURCE_ROOT, folder));
      const oldReasons = merging.length ? merging.map((group) => group.reason) : folders.map((folder) => claimReasonFor(SOURCE_ROOT, folder));
      let commonMatch = oldMatches[0] && oldMatches.every((match) => isDeepStrictEqual(match, oldMatches[0])) ? oldMatches[0] : null;
      if (commonMatch?.allocations) commonMatch = { ...commonMatch, allocations: commonMatch.allocations.map((project) => ({ ...project, amountCny: null })) };
      const commonReason = oldReasons[0]?.draft && oldReasons.every((reason) => reason?.draft === oldReasons[0].draft) ? oldReasons[0] : { draft: '', savedOnce: false };
      const id = randomUUID();
      const key = `@事项/${id}`;
      const first = merging[0];
      const subject = memory.subjectByFolder?.[folderMemoryKey(SOURCE_ROOT, first?.key || folders[0])] || first?.subject || input.subject || '其他';
      if (!Object.hasOwn(SUBJECTS, subject)) throw httpError(400, '请选择有效的报销科目');
      const booking = bookingOptionsForRoute(input.reimbursementRoute === undefined ? 'smart' : input.reimbursementRoute, subject);
      const group = { id, key, sourceRoot: SOURCE_ROOT, folders, name: folders.map((folder) => folder.split('/').at(-1)).join('、'), subject, match: commonMatch, reason: commonReason, bookingOptions: booking, status: 'draft', fileCount: folders.reduce((n, folder) => n + available.find((item) => item.path === folder).fileCount, 0), mergedFrom: [...mergedKeys], createdAt: new Date().toISOString() };
      const updated = new Map(claimGroups);
      for (const previous of merging) {
        updated.set(previous.key, { ...previous, status: 'dissolved', mergedInto: key });
        for (const plan of plans.values()) if (plan.folder === previous.key) plans.delete(plan.id);
      }
      updated.set(key, group);
      await commitGroups(updated);
      return json(response, 201, { group });
    });
  }
  const groupMatch = url.pathname.match(/^\/api\/claim-groups\/([0-9a-f-]+)$/);
  if (groupMatch && ['PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    const input = await body(request);
    return withWorklistWrite(async () => {
      const group = [...claimGroups.values()].find((item) => item.id === groupMatch[1] && item.sourceRoot === SOURCE_ROOT);
      if (!group || group.payroll || group.didi || input.sourceRoot !== SOURCE_ROOT) throw httpError(409, '报销事项已变化，请刷新');
      const undo = request.method === 'DELETE';
      if (undo && group.status === 'dissolved' && !group.mergedInto) return json(response, 200, { group });
      if (group.status !== 'draft') throw httpError(409, '报销事项已变化，请刷新');
      if (folderHasOpenRun(SOURCE_ROOT, group.key)) throw httpError(409, '报销事项正在执行或等待核实');
      let updated;
      if (undo) updated = { ...group, status: 'dissolved' };
      else if (request.method === 'PATCH') {
        const previous = bookingOptionsFor(group.sourceRoot, group.key);
        const subject = memory.subjectByFolder?.[folderMemoryKey(group.sourceRoot, group.key)] || group.subject;
        const booking = bookingOptionsForRoute(input.reimbursementRoute, subject, previous);
        if (isDeepStrictEqual(booking, previous)) return json(response, 200, { group: { ...group, bookingOptions: previous } });
        updated = { ...group, bookingOptions: booking };
      } else {
        const folders = input.folders;
        if (!Array.isArray(folders) || !folders.length || folders.some((folder) => typeof folder !== 'string') || new Set(folders).size !== folders.length) throw httpError(400, '请保留至少一个来源文件夹');
        const available = await listFinalFolders(group.sourceRoot);
        if (group.sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新');
        if (folders.some((folder) => !available.some((item) => item.path === folder && !item.reimbursed))) throw httpError(409, '来源文件夹已变化或已经报销');
        if (folders.some((folder) => folderHasOpenRun(SOURCE_ROOT, folder))) throw httpError(409, '来源文件夹正在执行或等待核实');
        const occupied = [...claimGroups.values()].some((item) => item.sourceRoot === SOURCE_ROOT && item.key !== group.key && item.status !== 'dissolved' && item.folders.some((folder) => folders.includes(folder)));
        if (occupied) throw httpError(409, '来源文件夹已经加入其他报销事项');
        updated = { ...group, folders: [...folders].sort(), name: folders.map((folder) => folder.split('/').at(-1)).join('、'), fileCount: folders.reduce((n, folder) => n + available.find((item) => item.path === folder).fileCount, 0) };
      }
      await saveGroup(updated);
      for (const plan of plans.values()) if (plan.folder === group.key) plans.delete(plan.id);
      await savePlans();
      return json(response, 200, { group: updated });
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/claim-reason') {
    const input = await body(request);
    const { sourceRoot, folder } = input;
    if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新文件夹');
    if (typeof input.reason !== 'string' || input.reason.length > 500) throw httpError(400, '请填写 500 字以内的报销事由草稿');
    const group = claimGroupFor(sourceRoot, folder);
    const available = group ? group.status === 'draft' : (await listFinalFolders(sourceRoot)).some((item) => item.path === folder && !item.reimbursed);
    if (!available) throw httpError(409, '请选择当前清单中的待报销文件夹');
    const reasonDraft = normalizeClaimReason(input.reason);
    const saved = await saveClaimReason(sourceRoot, folder, reasonDraft, { explicit: input.explicit === true, expectedSources: input.sourceFolders });
    const updated = group?.didi && claimGroupFor(sourceRoot, folder);
    return json(response, 200, { reasonDraft: saved.draft, reasonSaved: saved.savedOnce, ...(updated ? { blocker: didiBlocker(updated), revision: updated.revision } : {}) });
  }
  if (request.method === 'POST' && url.pathname === '/api/project-match') {
    const input = await body(request);
    const { sourceRoot, folder } = input;
    if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新文件夹');
    const group = claimGroupFor(sourceRoot, folder);
    const available = group ? group.status === 'draft' : (await listFinalFolders(sourceRoot)).some((item) => item.path === folder && !item.reimbursed);
    if (!available) throw httpError(409, '请选择当前清单中的待报销文件夹');
    return json(response, 200, { match: await saveProjectMatch(sourceRoot, folder, input.match, input.importOnly === true) });
  }
  if (request.method === 'GET' && url.pathname === '/api/projects') {
    return json(response, 200, demoMode ? { projects: [], syncedAt: null } : projectCatalog);
  }
  if (request.method === 'GET' && url.pathname === '/api/funding-summary') {
    const summary = await fundingSnapshot(SOURCE_ROOT);
    const format = url.searchParams.get('export');
    if (['projects', 'details'].includes(format)) {
      response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="reimbursement-${format}-${summary.year || 'current'}.csv"` });
      return response.end(fundingSummaryCsv(summary, format === 'details'));
    }
    return json(response, 200, summary);
  }
  if (url.pathname === '/api/funding-summary/sync') {
    if (request.method === 'GET') return json(response, 200, { job: schoolFundingSync.view(SOURCE_ROOT) });
    if (['POST', 'DELETE'].includes(request.method)) {
      if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, '请通过报销汇总页面操作同步。');
      const sourceRoot = SOURCE_ROOT;
      if (request.method === 'DELETE') return json(response, 200, { job: schoolFundingSync.stop(sourceRoot) });
      const { year } = await readFundingExports(sourceRoot);
      if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据目录已切换，请重新同步。');
      return json(response, 202, { job: schoolFundingSync.start(sourceRoot, year) });
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/funding-summary/source') {
    const sourceRoot = SOURCE_ROOT;
    const file = url.searchParams.get('file');
    const { sources } = await readFundingExports(sourceRoot);
    if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据目录已切换，请刷新报销汇总。');
    if (!sources.some((source) => source.file === file && source.state === 'read' &&
        (['smart', 'legacy', 'labor'].includes(source.kind) || (demoMode && source.kind === 'budget')))) {
      throw httpError(404, '未找到这份 Excel。');
    }
    const path = await realpath(join(sourceRoot, file));
    if (!isInsideDirectory(await realpath(sourceRoot), path)) throw httpError(404, '未找到这份 Excel。');
    const content = await readFile(path);
    const type = extname(file).toLowerCase() === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.ms-excel';
    response.writeHead(200, { 'content-type': type, 'content-length': content.length, 'cache-control': 'no-store',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file)}` });
    return response.end(content);
  }
  if (url.pathname === '/api/funding-summary/withdrawal' && ['POST', 'DELETE'].includes(request.method)) {
    const { sourceRoot, financeId: originalId, confirmed } = await body(request);
    const financeId = documentNumber(originalId);
    if (typeof originalId !== 'string' || !financeId || financeId.length > 128 || /[\x00-\x1f\x7f]/u.test(financeId)) throw httpError(400, '请选择要核对的学校单号。');
    return withWorklistWrite(async () => {
      if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据目录已切换，请重新读取报销汇总。');
      const key = `${sourceRoot}\0${financeId}`;
      const restore = request.method === 'DELETE';
      const updated = new Map(fundingWithdrawals);
      if (restore) updated.delete(key);
      else {
        if (confirmed !== true) throw httpError(400, '请确认已在学校系统撤回或作废该单。');
        if ([...runs.values()].some((run) => run.sourceRoot === sourceRoot && !claimWithdrawalFor(history, run.id) &&
            documentNumber(run.control.progress.submission.financeFormId || run.control.progress.submission.documentId) === financeId)) {
          throw httpError(409, '本机有这笔执行记录，请从「已办理」登记撤回。');
        }
        if (!updated.has(key)) {
          const { records } = await readFundingExports(sourceRoot);
          const rows = records.filter((record) => documentNumber(record.financeId) === financeId && ['smart', 'legacy'].includes(record.kind));
          if (!rows.some(({ state }) => state === 'pending') || rows.some(({ state }) => state === 'booked')) {
            throw httpError(409, '年度学校导出表中没有可登记撤回的待入账单据。');
          }
          updated.set(key, { withdrawnAt: new Date().toISOString() });
        }
      }
      await atomicJson(FUNDING_WITHDRAWALS_FILE, [...updated]);
      fundingWithdrawals = updated;
      return json(response, 200, { financeId, withdrawn: !restore });
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/funding-summary/attribution') {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, '请在报销汇总页面选择台账名目');
    const { sourceRoot, recordKey, ledgerNo } = await body(request);
    if (typeof recordKey !== 'string' || typeof ledgerNo !== 'string') throw httpError(400, '请选择有效的报销单据和台账名目');
    return withWorklistWrite(async () => {
      if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据目录已变化，请刷新报销汇总');
      const summary = await fundingSnapshot(sourceRoot);
      if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据目录已变化，请刷新报销汇总');
      const project = summary.projects.find((item) => item.records.some(({ key }) => key === recordKey));
      if (!project || project.lines.length < 2 || ledgerNo && !project.lines.some((line) => line.ledgerNo === ledgerNo)) {
        throw httpError(400, '请选择该学校项目下的台账名目');
      }
      const updated = new Map(fundingAttributions);
      const key = `${sourceRoot}\0${recordKey}`;
      if (ledgerNo) updated.set(key, ledgerNo);
      else updated.delete(key);
      await atomicJson(FUNDING_ATTRIBUTIONS_FILE, [...updated]);
      fundingAttributions = updated;
      return json(response, 200, { saved: true });
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/projects/sync') {
    return withBrowserReservation(async () => {
      const projects = await listWebProjects(DATA_APP_DIR);
      const catalog = { projects, syncedAt: new Date().toISOString() };
      await atomicJson(PROJECTS_FILE, catalog);
      projectCatalog = catalog;
      return json(response, 200, projectCatalog);
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/plans') {
    const input = await body(request);
    if (typeof input.folder !== 'string' || !input.folder.trim()) throw httpError(400, '请选择票据文件夹');
    if (isReimbursedFolder(input.folder)) throw httpError(409, '该文件夹已报销，已移入历史清单');
    if (schoolBookingsFor(SOURCE_ROOT).some((run) => (run.plan.sourceFolders || [run.plan.folder]).includes(input.folder))) throw httpError(409, '该文件夹已有学校预约回执');
    const group = claimGroupFor(SOURCE_ROOT, input.folder);
    if (group && group.status !== 'draft') throw httpError(409, '该报销事项已结束');
    if (group?.payroll) throw httpError(400, '请从薪酬申报表打开本笔事项');
    if (group?.didi) throw httpError(400, '贸大出行的票据在执行时从学校票夹选取');
    if (input.folder.startsWith('@事项/') && !group) throw httpError(404, '报销事项不存在');
    const memoryKey = folderMemoryKey(SOURCE_ROOT, input.folder);
    const subject = memory.subjectByFolder?.[memoryKey] || group?.subject || input.subject;
    const travelProfile = input.travelProfile || memory.travelProfileByFolder?.[memoryKey] || (subject === '差旅' ? DEFAULT_TRAVEL_PROFILE : null);
    const sourceRoot = SOURCE_ROOT;
    const revision = configurationRevision;
    return withPlanOperation(sourceRoot, input.folder, async () => {
      if (sourceRoot !== SOURCE_ROOT || revision !== configurationRevision) throw httpError(409, '检查期间根目录或配置已变化，请重新检查');
      const previous = [...plans.values()].findLast((plan) => plan.folder === input.folder && plan.subject === subject && plan.sourceRoot === sourceRoot && plan.configurationRevision === revision);
      const match = projectMatchFor(sourceRoot, input.folder);
      const projectAllocationDraft = match?.allocations?.map(catalogProject);
      const project = projectAllocationDraft?.[0] || catalogProject(match === undefined ? input.project : match);
      const savedBooking = bookingOptionsFor(sourceRoot, input.folder);
      let plan = await createPlan({ appDir: DATA_APP_DIR, sourceRoot, folder: input.folder, sourceFolders: group?.folders, groupId: group?.id, displayName: group?.reason?.draft || group?.name, subject, funding: match?.funding || input.funding, project, projectAllocationDraft, historyInvoiceNumbers: history.submittedInvoiceNumbers, historyPaymentKeys: history.submittedPaymentKeys, force: input.force === true, travelProfile, paymentCardLast4, confirmations: previous?.confirmations || {}, purpose: purposeForCurrentDraft(previous), bookingOptions: savedBooking, paymentType: match?.funding === undefined && !project ? '' : preferences.smartPaymentLabel, signer: preferences.signers[match?.funding || input.funding] });
      if (sourceRoot !== SOURCE_ROOT || revision !== configurationRevision) throw httpError(409, '检查期间根目录或配置已变化，请重新检查');
      if (match !== projectMatchFor(sourceRoot, input.folder)) throw httpError(409, '经费匹配已变化，请重新检查文件夹');
      if (savedBooking !== bookingOptionsFor(sourceRoot, input.folder)) throw httpError(409, '办理方式或纸质附件张数已变化，请重新检查事项');
      if (group && (!claimGroupFor(sourceRoot, input.folder) || claimGroupFor(sourceRoot, input.folder).status !== 'draft' || !isDeepStrictEqual(group.folders, claimGroupFor(sourceRoot, input.folder).folders))) throw httpError(409, '事项来源已变化，请重新检查');
      if (memory.subjectByFolder?.[memoryKey] && memory.subjectByFolder[memoryKey] !== subject) throw httpError(409, '报销科目已变化，请重新核对办理系统');
      const reason = group && claimReasonFor(sourceRoot, input.folder);
      if (reason?.savedOnce && reason.fingerprint === plan.fingerprint && reason.draft && project?.projectNo && project?.projectName) {
        plan = confirmClaimPurpose(plan, { reason: reason.draft, confirmed: true });
      }
      storeCurrentPlan(plan, sourceRoot, revision);
      await savePlans();
      return json(response, 200, { plan: publicPlan(plan), match });
    });
  }
  const quoteMatch = url.pathname.match(/^\/api\/plans\/([0-9a-f-]+)\/fx-quote(?:\/(20\d\d-\d\d-\d\d-[A-Z]{3}))?$/);
  if (quoteMatch && request.method === 'POST' && !quoteMatch[2]) {
    const plan = plans.get(quoteMatch[1]);
    if (!plan) throw httpError(404, '计划已失效，请重新检查');
    const { date, currency } = await body(request);
    validatePlanContext(plan);
    if (!plan.fxNeeded?.some((quote) => quote.date === date && quote.currency === currency)) throw httpError(400, '请选择本次付款缺少的中行牌价');
    const quote = await captureBocQuote(DATA_APP_DIR, date, currency);
    return json(response, 200, { date: quote.date, currency: quote.currency, ratePer100: quote.ratePer100 });
  }
  if (quoteMatch?.[2] && request.method === 'GET') {
    const proof = plans.get(quoteMatch[1])?.fxQuotes?.find(({ key }) => key === quoteMatch[2]);
    if (!proof) throw httpError(404, '未找到本笔对应的中国银行牌价截图');
    const quote = await readBocQuote(DATA_APP_DIR, proof.date, proof.currency);
    if (!quote || quote.sha256 !== proof.sha256 || quote.ratePer100 !== proof.ratePer100) throw httpError(409, '牌价截图已变化，请重新检查');
    const content = await readFile(quote.absolutePath);
    response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(quote.name)}` });
    return response.end(content);
  }
  const purposeMatch = url.pathname.match(/^\/api\/plans\/([0-9a-f-]+)\/purpose$/);
  if (request.method === 'POST' && purposeMatch) {
    const previous = plans.get(purposeMatch[1]);
    if (!previous) return json(response, 404, { error: '计划已失效，请重新检查' });
    const input = await body(request);
    return withPlanOperation(previous.sourceRoot, previous.folder, async () => {
      validatePlanContext(previous);
      if (!plans.has(previous.id)) throw httpError(409, '计划已变化，请重新检查文件夹');
      const current = await fingerprintPlan(previous.sourceRoot, previous);
      if (current.fingerprint !== previous.fingerprint) throw httpError(409, '附件已变化，请重新检查后确认报销事项');
      let plan;
      try { plan = confirmClaimPurpose(previous, input); } catch (error) { throw httpError(400, error.message); }
      await saveClaimReason(previous.sourceRoot, previous.folder, plan.reason, { explicit: true, requireCurrentDraft: typeof input.reason === 'string', expectedSources: previous.sourceFolders, expectedFingerprint: previous.fingerprint });
      validatePlanContext(previous);
      storeCurrentPlan(plan, previous.sourceRoot, previous.configurationRevision);
      await savePlans();
      return json(response, 200, { plan: publicPlan(plan) });
    });
  }
  const confirmationMatch = url.pathname.match(/^\/api\/plans\/([0-9a-f-]+)\/confirmations$/);
  if (request.method === 'POST' && confirmationMatch) {
    const previous = plans.get(confirmationMatch[1]);
    if (!previous) return json(response, 404, { error: '计划已失效，请重新检查' });
    validatePlanContext(previous);
    const sourceRoot = SOURCE_ROOT;
    const revision = configurationRevision;
    const input = await body(request);
    return withPlanOperation(sourceRoot, previous.folder, async () => {
      if (sourceRoot !== SOURCE_ROOT || revision !== configurationRevision || !plans.has(previous.id)) throw httpError(409, '材料确认期间配置或原计划已变化，请重新检查');
      if (folderHasOpenRun(sourceRoot, previous.folder)) throw httpError(409, '本笔正在执行或待核实，请先处理当前任务再改材料或金额');
      if (input.fingerprint !== previous.fingerprint) throw httpError(409, '附件已变化，材料确认已失效');
      const confirmations = { fingerprint: input.fingerprint };
      const paymentLinks = input.paymentLinks ?? previous.confirmations?.paymentLinks;
      if (paymentLinks !== undefined) {
        const invoices = new Set(previous.rows.map(({ invoiceNumber }) => invoiceNumber));
        const payments = new Set(previous.paymentCandidates?.map(({ name }) => name));
        if (!previous.paymentCandidates || !paymentLinks || typeof paymentLinks !== 'object' || Array.isArray(paymentLinks) ||
            Object.entries(paymentLinks).some(([invoice, names]) => !invoices.has(invoice) || !Array.isArray(names) ||
              new Set(names).size !== names.length || names.some((name) => !payments.has(name)))) {
          throw httpError(400, '请选择本次检查中识别到的发票和有效付款凭证。');
        }
        confirmations.paymentLinks = paymentLinks;
      }
      for (const key of ['receiptFile', 'sealedDetailFile', 'assetFile']) if (previous.supportingFiles.includes(input[key])) confirmations[key] = input[key];
      confirmations.paymentCardConfirmed = input.paymentCardConfirmed === true;
      if (previous.subject === '电脑配件') {
        confirmations.governmentProcurement = (input.governmentProcurement ?? previous.confirmations?.governmentProcurement) === true;
      }
      const paidAmounts = input.paidAmountsCny ?? previous.confirmations?.paidAmountsCny ?? {};
      const editableInvoices = new Set(previous.rows.filter((row) => row.needsAllocation || row.amountBasis === '手填实付金额').map((row) => row.invoiceNumber));
      if (typeof paidAmounts !== 'object' || Array.isArray(paidAmounts) || Object.entries(paidAmounts).some(([number, amount]) =>
        !editableInvoices.has(number) || !Number.isSafeInteger(amount) || amount <= 0)) {
        throw httpError(400, '只有已关联合并付款的发票可在详情补填分配金额，金额须大于零');
      }
      if (Object.keys(paidAmounts).length) confirmations.paidAmountsCny = paidAmounts;
      const plan = await createPlan({ appDir: DATA_APP_DIR, sourceRoot, folder: previous.folder, sourceFolders: previous.sourceFolders, groupId: previous.groupId, displayName: previous.displayName, subject: previous.subject, funding: previous.funding, project: catalogProject(previous.project), projectAllocationDraft: previous.projectAllocationDraft, travelProfile: previous.travelProfile, historyInvoiceNumbers: history.submittedInvoiceNumbers, historyPaymentKeys: history.submittedPaymentKeys, confirmations, paymentCardLast4, purpose: purposeForCurrentDraft(previous), bookingOptions: previous.bookingOptions, paymentType: preferences.smartPaymentLabel, signer: preferences.signers[previous.funding] });
      if (sourceRoot !== SOURCE_ROOT || revision !== configurationRevision || !plans.has(previous.id)) throw httpError(409, '材料确认期间配置或原计划已变化，请重新检查');
      if (plan.fingerprint !== previous.fingerprint) throw httpError(409, '附件已变化，请重新检查后填写实付金额或确认材料');
      if (folderHasOpenRun(sourceRoot, previous.folder)) throw httpError(409, '本笔正在执行或待核实，请先处理当前任务再改材料或金额');
      storeCurrentPlan(plan, sourceRoot, revision);
      await savePlans();
      return json(response, 200, { plan: publicPlan(plan) });
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/plan-override') {
    const input = await body(request);
    if (input.reason !== undefined) throw httpError(400, '请刷新页面，在文件夹卡片确认报销事由');
    const folder = String(input.folder || '').trim();
    if (!folder) return json(response, 400, { error: '缺少文件夹' });
    if (input.subject !== undefined && !Object.hasOwn(SUBJECTS, input.subject)) throw httpError(400, '请选择有效的报销科目');
    let signer;
    try {
      if (input.signerName !== undefined) {
        const fallback = Object.values(preferences.signers).find((item) => item?.name === input.signerName);
        signer = localSigner({ name: input.signerName, employeeNo: input.signerEmployeeNo ?? fallback?.employeeNo ?? '' });
        if (!signer) throw new Error('请填写本笔加签人姓名');
      }
    } catch (error) { throw httpError(400, error.message); }
    const sourceRoot = SOURCE_ROOT;
    return withPlanOperation(sourceRoot, folder, () => withWorklistWrite(async () => {
      if (sourceRoot !== SOURCE_ROOT) throw httpError(409, '票据根目录已变化，请刷新');
      const existing = [...plans.values()].filter((plan) => plan.folder === folder && plan.sourceRoot === sourceRoot);
      const latest = existing.at(-1) || null;
      const subjectChanged = input.subject && latest && input.subject !== latest.subject;
      if ((signer || subjectChanged || input.bookingOptions !== undefined) && folderHasOpenRun(sourceRoot, folder)) {
        throw httpError(409, '本笔正在执行或待核实，请先处理当前任务再更新设置');
      }
      if (signer || input.bookingOptions !== undefined) {
        if (!latest) throw httpError(404, '事项已变化，请重新检查');
        validatePlanContext(latest);
      }
      let bookingChanged = false;
      const key = projectMatchKey(sourceRoot, folder);
      if (input.bookingOptions !== undefined) {
        const { offline, attachmentCount } = input.bookingOptions ?? {};
        if (typeof offline !== 'boolean' || attachmentCount !== null && (!Number.isSafeInteger(attachmentCount) || attachmentCount < 1 || attachmentCount > 50)) {
          throw httpError(400, '学校要求每笔纸质附件为 1 至 50 张');
        }
        const next = offline || attachmentCount !== null
          ? { offline, attachmentCount, ...(attachmentCount === null ? {} : { fingerprint: latest.fingerprint }) }
          : null;
        if (!isDeepStrictEqual(next, bookingOptionsFor(sourceRoot, folder))) {
          const group = claimGroupFor(sourceRoot, folder);
          if (group) await saveGroup({ ...group, bookingOptions: next });
          else {
            const updated = new Map(bookingOptions);
            if (next) updated.set(key, next);
            else updated.delete(key);
            await atomicJson(BOOKING_OPTIONS_FILE, [...updated]);
            bookingOptions = updated;
          }
          bookingChanged = true;
        }
      }
      const travelProfile = input.travelProfile?.role ? { role: input.travelProfile.role, fundType: input.travelProfile.fundType === 'research' ? 'research' : 'budget' } : null;
      const changes = await rememberPlanEdit(DATA_APP_DIR, memory, {
        folder,
        folderKey: folderMemoryKey(sourceRoot, folder),
        subject: input.subject,
        expenseType: input.expenseType,
        travelProfile,
        signerChoice: signer ? { key, signer, fingerprint: latest.fingerprint, projectNo: latest.project.projectNo, funding: latest.funding } : null,
      });
      const profileChanged = travelProfile && latest?.travelProfile && (latest.travelProfile.role !== travelProfile.role || latest.travelProfile.fundType !== travelProfile.fundType);
      const recheck = Boolean(subjectChanged || profileChanged || bookingChanged);
      for (const plan of existing) {
        if (recheck) plans.delete(plan.id);
        else {
          if (input.expenseType && EXPENSE_TYPES.includes(input.expenseType)) plan.expenseType = input.expenseType;
          if (signer) {
            plan.signer = signer;
            plan.signerOverride = signer;
          }
        }
      }
      if (existing.length || recheck) await savePlans();
      return json(response, 200, { changes, recheck, signerNames: memory.signerNames, plan: !recheck && latest ? publicPlan(latest) : null });
    }));
  }
  if (request.method === 'GET' && url.pathname === '/api/batches') {
    const visible = [...batches.values()].filter((batch) => !workspace || batch.runIds.some((id) => runs.get(id)?.sourceRoot === SOURCE_ROOT));
    return json(response, 200, { batches: demoMode ? [] : visible.map(publicBatch) });
  }
  const batchMatch = url.pathname.match(/^\/api\/batches\/([0-9a-f-]+)$/);
  if (request.method === 'GET' && batchMatch) {
    const batch = batches.get(batchMatch[1]);
    return batch ? json(response, 200, { batch: publicBatch(batch) }) : json(response, 404, { error: '批次不存在' });
  }
  if (request.method === 'POST' && url.pathname === '/api/batch-runs') {
    const input = await body(request);
    const entries = Array.isArray(input.entries) ? input.entries : (Array.isArray(input.planIds) ? input.planIds.map((planId) => ({ planId })) : []);
    if (!entries.length) return json(response, 400, { error: '请先选择要执行的事项' });
    await worklistWrites;
    const selectedPlans = entries.map((entry) => {
      if (entry?.didiId) {
        const group = claimGroupFor(SOURCE_ROOT, `@事项/${entry.didiId}`);
        if (!group?.didi || group.status !== 'draft' || group.revision !== entry.revision) throw httpError(409, '贸大出行事项已变化，请刷新');
        return didiPlan(group);
      }
      if (!entry?.payrollId) return plans.get(entry?.planId);
      const group = claimGroupFor(SOURCE_ROOT, `@事项/${entry.payrollId}`);
      if (!group?.payroll || group.status !== 'draft' || group.revision !== entry.revision) throw httpError(409, '薪酬申报已变化，请刷新清单后重新选择');
      return payrollPlan(group);
    });
    if (selectedPlans.some((plan) => !plan)) return json(response, 404, { error: '存在已失效的报销计划，请重新检查文件夹' });
    const folders = selectedPlans.map((plan) => plan.folder);
    if (new Set(folders).size !== folders.length) return json(response, 409, { error: '同一个文件夹不能重复加入批次' });
    const owner = randomUUID();
    reserveBrowser(owner);
    try {
      for (const plan of selectedPlans) {
        try { await validateCurrentPlan(plan); }
        catch (error) { throw new Error(`${planLabel(plan)} · ${error.message}`); }
      }
      checkBatchOverlap(selectedPlans);
    } catch (error) { releaseBrowser(owner); return json(response, 409, { error: error.message }); }
    const duplicate = [...runs.values()].find((run) => folders.includes(run.plan.folder) && ACTIVE_RUN_STATUSES.has(run.status));
    if (duplicate) { releaseBrowser(owner); return json(response, 409, { error: `“${duplicate.plan.folder}”已有执行中的任务`, run: publicRun(duplicate) }); }
    const batch = {
      id: randomUUID(),
      runIds: [],
      currentIndex: 0,
      currentRunId: null,
      status: 'queued',
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    for (const plan of selectedPlans) {
      const run = createRun(plan);
      runs.set(run.id, run);
      batch.runIds.push(run.id);
    }
    batches.set(batch.id, batch);
    executeBatch(batch).catch((error) => {
      batch.status = 'error';
      batch.error = error.message;
      batch.updatedAt = new Date().toISOString();
    }).finally(() => { releaseBrowser(owner); saveRuns().catch(() => undefined); });
    await saveRuns();
    return json(response, 202, { batch: publicBatch(batch) });
  }
  if (request.method === 'GET' && url.pathname === '/api/runs') {
    const blocking = heldRun();
    return json(response, 200, demoMode ? { runs: [], blockingRunId: null }
      : { runs: [...runs.values()].filter((run) => !workspace || run.sourceRoot === SOURCE_ROOT || run === blocking).map(publicRun),
        blockingRunId: blocking?.id || null });
  }
  if (request.method === 'POST' && url.pathname === '/api/runs') {
    const input = await body(request);
    const plan = plans.get(input.planId);
    if (!plan) return json(response, 404, { error: '报销计划不存在，请重新生成' });
    const duplicate = [...runs.values()].find((run) => run.plan.folder === plan.folder && ACTIVE_RUN_STATUSES.has(run.status));
    if (duplicate) return json(response, 409, { error: '该文件夹已有执行中的任务', run: publicRun(duplicate) });
    const owner = randomUUID();
    reserveBrowser(owner);
    try { await validateCurrentPlan(plan); } catch (error) { releaseBrowser(owner); return json(response, 409, { error: error.message }); }
    const run = createRun(plan);
    run.control.resumeStages = input.resume === true;
    runs.set(run.id, run);
    run.status = 'running';
    addMessage(run, 'assistant', input.resume === true ? `从当前网页状态继续执行“${planLabel(plan)}”，已完成的阶段会自动跳过。` : `开始执行“${planLabel(plan)}”，金额 ${(plan.totalCny / 100).toFixed(2)} 元。`);
    executeRun(run).finally(() => releaseBrowser(owner));
    await saveRuns();
    return json(response, 202, { run: publicRun(run) });
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)$/);
  if (request.method === 'GET' && runMatch) {
    const run = runs.get(runMatch[1]);
    return run ? json(response, 200, { run: publicRun(run) }) : json(response, 404, { error: '任务不存在' });
  }
  const appointmentMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/appointment-pdf$/);
  if (appointmentMatch && request.method === 'GET') {
    const run = runs.get(appointmentMatch[1]);
    if (run?.plan.reimbursementRoute !== 'legacy' || !run.bookkeeping?.appointmentRecorded || !run.control.progress.booking.pdfName) throw httpError(404, '预约单 PDF 尚未保存');
    const folder = run.plan.sourceFolders?.[0] || run.plan.folder;
    const file = await saveAppointmentPdf(run.sourceRoot, folder, run.control.progress.submission.financeFormId);
    if (!file) throw httpError(404, '原票据文件夹中的预约单 PDF 已移动');
    const content = await readFile(file.path);
    response.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}` });
    return response.end(content);
  }
  const withdrawalMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/withdrawal$/);
  if (request.method === 'POST' && withdrawalMatch) {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw httpError(415, '请通过报销历史登记撤回');
    const input = await body(request);
    if (input.confirmed !== true) throw httpError(400, '请确认学校原单已撤回或删除');
    return json(response, 200, await withdrawReimbursement(runs.get(withdrawalMatch[1])));
  }
  const resolutionMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/resolution$/);
  if (request.method === 'POST' && resolutionMatch) {
    const run = runs.get(resolutionMatch[1]);
    if (!run || !['verification_required', 'preview', 'error'].includes(run.status)) return json(response, 409, { error: '当前任务不等待核实' });
    const input = await body(request);
    if (resolvingRuns.has(run.id) || browserReservation === run.id || !['verification_required', 'preview', 'error'].includes(run.status)) {
      throw httpError(409, '本任务正在处理，请刷新后查看。');
    }
    resolvingRuns.add(run.id);
    try {
      if (input.confirmed !== true) throw httpError(400, '请先核实学校系统中的本笔单据状态');
      if (run.plan.didi && input.resolution === 'submitted' && (!run.plan.rows.length || run.control.progress.didiWallet?.state !== 'verified')) {
        throw httpError(409, '请在「执行与互动」回复「继续」，核对本笔滴滴票据和学校原单');
      }
      if (run.plan.payrollRevision && (input.resolution !== 'abandon_draft' || run.control.progress.submission.state === 'verified')) {
        throw httpError(409, '请在「执行与互动」回复「继续」，执行器会从学校核对本笔薪酬申报原单。');
      }
      if (run.plan.reimbursementRoute === 'legacy' && (input.resolution === 'submitted' || run.control.progress.submission.state === 'verified')) {
        throw httpError(409, '请在「执行与互动」回复「继续」，执行器会按学校原单核对并保存 PDF。');
      }
      if (input.resolution === 'submitted') {
        const financeFormId = String(input.financeFormId || '').trim();
        if (!/^[A-Za-z0-9-]{6,40}$/.test(financeFormId)) throw httpError(400, '请填写已核实提交成功的学校报销单号');
        run.control.progress.submission = { state: 'verified', source: 'user_verified', financeFormId, verifiedAt: new Date().toISOString() };
        await saveRuns();
        await recordSubmitted(run);
        run.status = 'completed';
        run.result = 'submitted';
      } else if (input.resolution === 'not_submitted') {
        run.control.progress.submission = { state: 'not_started' };
        run.control.cancelled = false;
        const uncertainUpload = run.control.progress.didiWallet?.state === 'started' || run.control.progress.uploads.some((operation) => operation.state === 'started');
        run.resolved = !uncertainUpload;
        run.status = uncertainUpload ? 'verification_required' : 'error';
        run.error = uncertainUpload ? '已确认未提交，但附件上传结果仍待核实；请在学校系统中作废或删除该草稿后，再登记“已作废/删除草稿”' : '用户已核实未提交；重试前仍会核对当前附件和草稿';
      } else if (input.resolution === 'abandon_draft') {
        if (run.control.progress.submission.state === 'verified') throw httpError(409, '本笔已核实提交，请从「已办理」登记撤回。');
        run.resolved = true;
        run.control.cancelled = true;
        run.status = 'abandoned';
        run.error = null;
        addMessage(run, 'assistant', '已记录你在学校系统作废或删除了该草稿并核实未提交，本任务结束。');
        const batch = [...batches.values()].find((item) => item.currentRunId === run.id);
        if (batch) {
          batch.status = 'abandoned';
          batch.error = null;
          batch.updatedAt = run.updatedAt;
        }
      } else throw httpError(400, '请选择本次已核实的单据结果');
      await saveRuns();
      return json(response, 200, { run: publicRun(run) });
    } finally { resolvingRuns.delete(run.id); }
  }
  const replyMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/replies$/);
  if (request.method === 'POST' && replyMatch) {
    const run = runs.get(replyMatch[1]);
    if (!run) return json(response, 404, { error: '任务不存在' });
    const input = await body(request);
    const message = String(input.message || '').trim();
    const question = pending.get(run.id);
    if (!question) return json(response, 409, { error: '当前没有等待回复的问题' });
    const answer = pendingAnswer(question, message);
    if (!answer) return json(response, 409, { error: pendingChoiceHint(question) });
    addMessage(run, 'user', message);
    if (question.metadata.kind === 'pause' && /继续|恢复/.test(message)) run.control.paused = false;
    resumePending(run, question, answer);
    return json(response, 200, { run: publicRun(run) });
  }
  const instructionMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/instructions$/);
  if (request.method === 'POST' && instructionMatch) {
    const run = runs.get(instructionMatch[1]);
    if (!run) return json(response, 404, { error: '任务不存在' });
    const input = await body(request);
    const message = String(input.message || '').trim();
    if (!message) return json(response, 400, { error: '请输入指令或问题' });
    const compact = message.replace(/\s/g, '');
    const initialQuestion = pending.get(run.id)?.metadata.kind;
    let directive = directInstruction(message);
    let intent = { action: 'chat' };
    if (!directive && !isStatusQuestion(message) && compact !== '确认提交' &&
        (!initialQuestion || ['pause', 'final_approval'].includes(initialQuestion) || /暂停|重试|终止|提交|放弃/.test(message))) {
      intent = await parseInstruction({
        message, context: { status: run.status, awaiting: initialQuestion, latestStep: run.events.at(-1)?.step },
        cwd: APP_DIR, settingsDir: DATA_APP_DIR,
      });
      if (intent.action === 'control') directive = intent.control;
    }
    const question = pending.get(run.id);
    const questionKind = question?.metadata.kind || '';
    const wantsRetry = directive === 'retry';
    const wantsPause = directive === 'pause';
    const wantsResume = directive === 'resume';
    addMessage(run, 'user', message);

    if (directive && run.status === 'completed') {
      addMessage(run, 'assistant', '本笔已收到学校回执并登记。');
      return json(response, 200, { run: publicRun(run) });
    }

    if (directive === 'cancel') {
      run.control.cancelled = true;
      run.control.paused = false;
      const pendingQuestion = pending.get(run.id);
      if (pendingQuestion) {
        pending.delete(run.id);
        pendingQuestion.reject(new Error('用户取消任务'));
      } else if (!ACTIVE_RUN_STATUSES.has(run.status)) {
        run.status = hasUnresolvedEffect(run) ? 'verification_required' : 'error';
        run.error = hasUnresolvedEffect(run) ? '任务已停止，上传或提交结果仍须核实' : '用户取消任务';
      }
      run.updatedAt = new Date().toISOString();
      addMessage(run, 'assistant', hasUnresolvedEffect(run) ? '已停止后续执行，之前的上传或提交结果仍需在学校系统核实，核实前不会启动其他任务。' : '已按你的要求停止这笔任务；当前草稿可在学校系统里作废。');
      await saveRuns();
      return json(response, 200, { run: publicRun(run) });
    }

    if (directive === 'skip_submit') {
      run.control.skipSubmit = true;
      if (questionKind === 'final_approval') {
        resumePending(run, question, '不提交');
        addMessage(run, 'assistant', '已按你的要求保留在提交前页面，不会提交预审。');
      } else {
        addMessage(run, 'assistant', '已记录“先别提交”。执行到最后确认页时会保留草稿，不会提交预审。');
      }
      await saveRuns();
      return json(response, 200, { run: publicRun(run) });
    }

    const progress = run.control.progress;
    const resumeSchool = (run.plan.reimbursementRoute === 'legacy' || run.plan.payrollRevision) && !run.resolved &&
      (wantsResume || wantsRetry || compact === '确认提交') && ['preview', 'error', 'verification_required'].includes(run.status);
    const resumeUpload = wantsResume && run.status === 'verification_required' && !run.resolved && progress.uploadPageId &&
      progress.submission.state === 'not_started' && (progress.didiWallet?.state === 'started' || progress.uploads.some((operation) => operation.state === 'started'));
    const resumeSubmission = wantsResume && run.status === 'verification_required' && !run.resolved && progress.uploadPageId &&
      ['attempted', 'verification_required'].includes(progress.submission.state) && progress.submission.fingerprint === run.plan.fingerprint;
    const resumeLogin = (wantsResume || wantsRetry) && canResumeCampusLogin(run);
    const resumePreview = wantsResume && canResumeSmartPreview(run);
    const resumeSamePage = wantsResume && run.status === 'error' && !run.resolved && !run.control.cancelled &&
      (progress.uploadPageId || run.control.portalPageId) && !hasUnresolvedEffect(run);
    if (wantsRetry && !resumeSchool && (run.status === 'verification_required' || hasUnresolvedEffect(run) || progress.submission.state === 'verified')) {
      return json(response, 409, { error: '学校结果待核实。回复「继续」可核对原单。' });
    }
    if (resumeSchool || resumeLogin || resumeUpload || resumeSubmission || resumeSamePage || resumePreview || (wantsRetry && run.status === 'error')) {
      if (resolvingRuns.has(run.id)) throw httpError(409, '本任务的核实结果正在保存，请稍后查看。');
      reserveBrowser(run.id, run.id);
      if (!resumeSchool || !schoolReceiptOnly(run)) {
        await validateRun(run).catch((error) => { releaseBrowser(run.id); throw httpError(409, error.message); });
      }
      run.error = null;
      run.errorCode = null;
      run.status = 'running';
      run.control.paused = false;
      run.control.cancelled = false;
      if (resumeSchool) run.control.payrollRecoveryAttempts = 0;
      if (resumeSchool && compact === '确认提交') run.control.skipSubmit = false;
      if (resumePreview) run.control.skipSubmit = false;
      run.control.resumeStages = !resumeLogin;
      run.control.autoSubmit = false;
      run.resolved = false;
      addMessage(run, 'assistant', resumeUpload
        ? '正在接回原报销单并核对已上传票据，核对通过后从当前步骤继续。'
        : resumeSubmission ? '正在读取原单的学校提交回执。'
        : resumePreview ? '正在接回原草稿。请核对后再确认是否提交。'
        : resumeLogin ? '正在原报销标签检查学校登录，认证后继续当前批次。' : '已从当前网页状态重试，已完成的阶段会自动跳过。');
      const batch = [...batches.values()].find((item) =>
        item.currentRunId === run.id && (['verification_required', 'error', 'interrupted'].includes(item.status) ||
          (resumeSchool || resumePreview) && item.status === 'preview'));
      if (batch) {
        for (const id of batch.runIds.slice(batch.currentIndex + 1)) {
          const queued = runs.get(id);
          if (queued?.status === 'stopped') {
            queued.status = 'queued';
          }
        }
      }
      const execution = batch ? executeBatch(batch, batch.currentIndex) : executeRun(run);
      execution.catch((error) => {
        run.status = hasUnresolvedEffect(run) ? 'verification_required' : 'error';
        run.error = error.message;
        if (batch) {
          batch.status = run.status;
          batch.error = error.message;
          for (const id of batch.runIds.slice(batch.currentIndex + 1)) {
            const queued = runs.get(id);
            if (queued?.status === 'queued') queued.status = 'stopped';
          }
        }
      }).finally(() => { releaseBrowser(run.id); saveRuns().catch(() => undefined); });
      await saveRuns();
      return json(response, resumeUpload || resumeSubmission ? 202 : 200, { run: publicRun(run), ...(batch ? { batch: publicBatch(batch) } : {}) });
    }

    if (wantsRetry) {
      addMessage(run, 'assistant', '当前任务不是失败状态，不能重试；如果正在执行，可以先发送“暂停”。');
      return json(response, 200, { run: publicRun(run) });
    }

    if (questionKind === 'pause') {
      if (wantsResume) {
        run.control.paused = false;
        resumePending(run, question, '继续');
        addMessage(run, 'assistant', '已收到继续指令，将从暂停点续跑。');
      } else {
        await answerWithCodex(run, message);
      }
      return json(response, 200, { run: publicRun(run) });
    }

    if (questionKind === 'final_approval') {
      if (compact === '确认提交') {
        resumePending(run, question, message);
        addMessage(run, 'assistant', '已收到最终确认，正在提交预审。');
      } else if (wantsPause) {
        run.control.paused = true;
        addMessage(run, 'assistant', '当前正在等待最终确认。你可以先核实页面；确认前不会提交。');
      } else {
        await answerWithCodex(run, message);
      }
      return json(response, 200, { run: publicRun(run) });
    }

    if (wantsPause) {
      if (!ACTIVE_RUN_STATUSES.has(run.status)) {
        addMessage(run, 'assistant', '当前没有正在执行的步骤。');
        return json(response, 200, { run: publicRun(run) });
      }
      run.control.paused = true;
      if (!question) run.status = 'pausing';
      addMessage(run, 'assistant', question ? '已记录暂停。当前问题仍需要你回复；当前网页步骤结束后会停在下一检查点。' : '收到暂停指令，将在当前网页步骤结束后暂停。');
      await saveRuns();
      return json(response, 200, { run: publicRun(run) });
    }

    if (wantsResume) {
      run.control.paused = false;
      if (question?.metadata.choices) {
        addMessage(run, 'assistant', pendingChoiceHint(question));
      } else if (question) {
        resumePending(run, question, '继续');
        addMessage(run, 'assistant', questionKind === 'amount_review' ? '正在重新读取学校费用明细和待分配金额。' : '已把你的回复交给当前等待步骤，继续执行。');
      } else {
        if (run.status === 'pausing') run.status = 'running';
        const detail = run.control.waitingForCampusLogin ? '正在等待学校认证。登录完成后会自动继续。'
          : run.status === 'error' ? '当前任务停在报错步骤。请查看上方提示，准备好后可发送「重试」。'
            : run.status === 'verification_required' ? '当前没有可核对的原单。请保留原报销标签。' : '已收到继续指令。';
        addMessage(run, 'assistant', detail);
      }
      await saveRuns();
      return json(response, 200, { run: publicRun(run) });
    }

    if (question) {
      if (isStatusQuestion(message)) await answerWithCodex(run, message);
      else {
        const answer = pendingAnswer(question, message);
        if (answer) {
          if (questionKind === 'amount_review') addMessage(run, 'assistant', '正在重新读取学校费用明细和待分配金额。');
          resumePending(run, question, answer);
        } else {
          addMessage(run, 'assistant', pendingChoiceHint(question));
          await saveRuns();
        }
      }
      return json(response, 200, { run: publicRun(run) });
    }

    if (intent.action === 'learn' && intent.learn && /以后|今后|记住|一律|长期/.test(message)) {
      const changes = await applyLearning(DATA_APP_DIR, memory, intent.learn);
      if (changes.length) {
        await applyMemoryToPlans();
        addMessage(run, 'assistant', `已记住并应用到所有计划：${changes.join('；')}。`);
      } else {
        addMessage(run, 'assistant', '这些规则与已有记忆一致，无需更新。');
      }
      return json(response, 200, { run: publicRun(run) });
    }
    await answerWithCodex(run, message);
    return json(response, 200, { run: publicRun(run) });
  }
  if (request.method === 'POST' && url.pathname === '/api/chat') {
    const input = await body(request);
    const run = runs.get(input.runId);
    const answer = await answerWithCodex(run, String(input.message || ''));
    return json(response, 200, { answer, run: run ? publicRun(run) : null });
  }
  if (request.method === 'GET' && !isApi) {
    const requested = url.pathname === '/' ? 'index.html' : posix.normalize(url.pathname).replace(/^\/+/, '');
    const path = resolve(PUBLIC_DIR, requested);
    if (!isInsideDirectory(PUBLIC_DIR, path)) return json(response, 403, { error: '禁止访问' });
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[extname(path)] || 'application/octet-stream';
    const content = await readFile(path).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return null;
      throw error;
    });
    if (content === null) return json(response, 404, { error: '找不到页面资源' });
    response.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
    return response.end(content);
  }
  json(response, 404, { error: '接口不存在' });
}

await atomicJson(CONFIG_FILE, { demoMode, sourceRoot: demoMode ? '' : SOURCE_ROOT, liveSourceRoot, preferences, paymentCardLast4, configurationRevision });
if (importedReasons) await atomicJson(CLAIM_REASONS_FILE, [...claimReasons]);
for (const run of runs.values()) {
  const marked = run.plan.payrollRevision ? run.bookkeeping?.payrollRecorded
    : run.plan.reimbursementRoute === 'legacy' ? run.bookkeeping?.appointmentRecorded : run.bookkeeping?.folderMarked;
  if (run.control.progress.submission.state === 'verified' && (!run.bookkeeping?.historyRecorded || !marked)) {
    try { await recordSubmitted(run); } catch (error) { run.status = 'verification_required'; run.error = `已核实提交，本地登记尚未完成：${error.message}`; }
  }
}
await saveRuns();

export function handleRequest(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; style-src 'self' 'unsafe-inline'");
  return route(request, response).catch((error) => {
    if (!response.headersSent) json(response, error.statusCode || 500, { error: error.message });
    else response.end();
  });
}

if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => null) === fileURLToPath(import.meta.url)) {
  const server = http.createServer(handleRequest);
  const listening = new Promise((ready, reject) => {
    server.once('listening', () => ready({ port: server.address().port }));
    server.once('error', reject);
  });
  if (process.send) {
    answerWorkspaceRequests(process, 'ready', () => listening);
    if (workspaceAtLaunch) answerWorkspaceRequests(process, 'year', selectWorkspaceYear);
    process.once('disconnect', () => server.close(() => process.exit(0)));
  }
  listening.catch((error) => {
    console.error('无法启动本机服务。' + error.code);
    if (!process.send) process.exitCode = 1;
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`报销助手开源版：http://127.0.0.1:${server.address().port}`);
  });
}
