import { allocateProjects, matchProjects, projectNumberKey } from './project-allocation.js';
import { bindModelSettings } from './model-settings.js';
import { bindFundingSummary } from './funding-summary.js';
import { bindPayrollForm } from './payroll.js';
import { bindReviewArchive } from './review-archive.js';
import { mountSignerPicker } from './signer-picker.js';

const SUBJECTS = ['电脑配件', '办公用品', '书籍资料', 'AI服务', '数据服务', '境外软件订阅', '劳务费', '差旅', '其他'];
const ROUTE_LABELS = { smart: '智能报销系统', legacy: '日常线下报销', labor: '薪酬申报', split: '混合结算', review: '办理系统待核对' };
const EXPENSE_TYPES = ['设备', '办公费', '数据采集费', '其他材料费', '其他教学杂项费用'];
const TRAVEL_ROLES = [
  { value: 'other', label: '其他人员（含学生）' },
  { value: 'bureau_senior', label: '局级、教授、研究员等' },
  { value: 'senior_50_plus', label: '50 周岁及以上正高级' },
  { value: 'ministerial_academician', label: '部级及相当职务人员、院士' },
];
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'waiting_input', 'pausing']);
const LEGACY_CONFIG_STORAGE_KEY = 'reimbursement-assistant-row-configs';
let configStorageKey;
let storedConfigs = {};
function selectConfigStorage(workspace) {
  const scope = workspace ? `:${encodeURIComponent(workspace.owner)}:${workspace.year}` : '';
  const key = LEGACY_CONFIG_STORAGE_KEY + scope;
  if (key === configStorageKey) return;
  configStorageKey = key;
  try { storedConfigs = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { storedConfigs = {}; }
}
const state = {
  folders: [],
  sourceFolders: [],
  selectedSources: new Set(),
  sourceNotice: '',
  sourceAmounts: new Map(),
  sourceRoot: '',
  demoMode: true,
  workspace: null,
  blockingRun: null,
  defaultSourceRoot: '',
  projects: [],
  projectSigners: {},
  payrollCategories: [],
  payrollPositions: [],
  payrollExpenseItems: [],
  payrollSignerNames: {},
  signerRoster: [],
  projectSyncedAt: null,
  activeFolder: '',
  selected: new Set(),
  configs: new Map(),
  plans: new Map(),
  amounts: new Map(),
  rowStatus: new Map(),
  detailFolder: '',
  batch: null,
  run: null,
  autoChecking: null,
  executing: false,
  sending: false,
  configurationGeneration: 0,
  completedRunIds: null,
};
const checkTasks = new Map();
const savingMatches = new Set();
const dissolvingClaims = new Set();
const reasonEntries = new Map();
const allocationEdits = new Map();
let fxLookup = null;
let fxMessage = null;
let claimRouteRequest;
const $ = (id) => document.getElementById(id);
const yuan = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' });
const money = (cents, missing = '待核定') => Number.isSafeInteger(cents) ? yuan.format(cents / 100) : missing;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const itemFor = (folder) => state.folders.find((item) => item.path === folder);
const displayNameFor = (folder) => itemFor(folder)?.label || folder;

function recognizedPaymentTotal(plan) {
  return plan?.paymentCandidates?.length
    ? plan.paymentCandidates.reduce((total, { amountCny }) => total + amountCny, 0)
    : null;
}

function paymentReviewNeeded(plan) {
  if (!plan?.paymentCandidates?.length || !plan.rows.length) return false;
  const linked = new Set(plan.rows.flatMap((row) => row.paymentFiles || []));
  return plan.rows.some((row) => !row.paymentFiles?.length) || plan.paymentCandidates.some(({ name }) => !linked.has(name));
}

function renderSources() {
  const pending = state.sourceFolders.filter((item) => !item.reimbursed);
  const keyword = $('sourceFilter').value.trim().toLowerCase();
  $('sourceCount').textContent = `${pending.filter((item) => !item.claimKey).length} 个可合并`;
  $('sourceRows').innerHTML = pending.filter((item) => item.path.toLowerCase().includes(keyword)).map((item) => {
    const preview = state.sourceAmounts.get(item.path);
    const claim = state.plans.get(item.claimKey);
    const merged = claim?.sourceFolders?.length > 1;
    const amount = claim && !merged ? claim : preview;
    const recognized = amount?.recognizedPaymentCny ?? recognizedPaymentTotal(amount);
    let value = '金额待核对';
    if (merged) {
      value = Number.isSafeInteger(preview?.totalCny) ? `来源预估 ${money(preview.totalCny)} · 见合并事项` : '见合并事项核对结果';
    } else if (amount?.error) {
      value = `识别失败 · ${amount.error}`;
    } else if (Number.isSafeInteger(amount?.totalCny) && !paymentReviewNeeded(claim)) {
      value = `核定 ${money(amount.totalCny)}`;
    } else if (amount) {
      const invoices = amount.invoiceTotalCny > 0 ? `发票 ${money(amount.invoiceTotalCny)}` : '未识别到有效发票';
      const payment = recognized > 0 ? `识别到付款 ${money(recognized)}` : '实付待核对';
      value = `${invoices} · ${payment}`;
      if (amount.invoiceTotalCny > 0 && recognized > 0 && (!claim || paymentReviewNeeded(claim))) value += ' · 待确认对应关系';
    }
    return `<label class="source-row${item.claimKey ? ' is-assigned' : ''}"><input type="checkbox" data-source="${escapeHtml(item.path)}" aria-label="选择来源 ${escapeHtml(item.path)}" ${state.selectedSources.has(item.path) ? 'checked' : ''} ${item.claimKey ? 'disabled' : ''}><strong>${escapeHtml(item.path)}</strong><small>${item.fileCount} 个文件 · ${escapeHtml(value)}</small>${item.claimKey ? `<small>已加入 ${escapeHtml(item.claimLabel)}</small>` : ''}</label>`;
  }).join('') || '<p class="muted">没有符合条件的来源文件夹。</p>';
  const selection = state.selectedSources.size ? `已勾选 ${state.selectedSources.size} 个来源文件夹` : '';
  $('sourceSelection').textContent = [state.sourceNotice, selection].filter(Boolean).join(' ') || '先勾选属于同一事项的文件夹。';
  updateSourceActions();
}

function updateSourceActions() {
  $('createClaim').disabled = !state.selectedSources.size;
  const item = itemFor(state.activeFolder);
  $('addToClaim').disabled = !state.selectedSources.size || !item?.groupId || singleProjectClaim(item);
}

function chooseClaimRoute({ folder, merge = false } = {}) {
  const dialog = $('claimRouteDialog');
  if (dialog.open || $('saveClaimRoute').disabled) return;
  const item = itemFor(folder);
  const selection = merge ? [...state.selected].filter((key) => !singleProjectClaim(itemFor(key))) : [...state.selectedSources];
  if (folder ? !item?.groupId : selection.length < (merge ? 2 : 1)) return;
  const sourceRoot = state.sourceRoot;
  const sources = folder ? {} : merge ? { mergeKeys: selection } : { folders: selection, subject: configFor(selection[0]).subject };
  claimRouteRequest = { folder, groupId: item?.groupId, sourceRoot, ...sources };
  $('claimRouteChoice').value = selectedClaimRoute(folder);
  $('saveClaimRoute').textContent = folder ? '保存' : '合并';
  $('claimRouteStatus').textContent = '';
  dialog.showModal();
}

function focusClaim(folder, route) {
  const filter = $('claimRouteFilter');
  if (filter.value && filter.value !== route) {
    filter.value = route;
    renderSchoolFinanceEntry();
  }
  const item = itemFor(folder);
  if (item && !matchesClaimSearch(item)) $('folderFilter').value = '';
  state.activeFolder = folder;
}

async function saveClaimRoute() {
  const { folder, groupId, sourceRoot, ...sources } = claimRouteRequest;
  const reimbursementRoute = $('claimRouteChoice').value;
  const dialog = $('claimRouteDialog');
  $('saveClaimRoute').disabled = true;
  $('cancelClaimRoute').disabled = true;
  $('claimRouteStatus').textContent = '正在保存…';
  try {
    const { group } = await api(folder ? `/api/claim-groups/${groupId}` : '/api/claim-groups', {
      method: folder ? 'PATCH' : 'POST', body: JSON.stringify({ sourceRoot, reimbursementRoute, ...sources }),
    });
    dialog.close();
    if (sourceRoot !== state.sourceRoot) return;
    if (folder) {
      const item = itemFor(folder);
      if (!item) return;
      item.offlineBooking = group.bookingOptions?.offline === true;
      focusClaim(folder, selectedClaimRoute(folder));
      invalidatePlan(folder, () => {});
      setWorklistStatus('办理方式已保存。');
      return;
    }
    state.selectedSources.clear();
    state.sourceNotice = '';
    if (sources.mergeKeys) state.selected.clear();
    await refreshFolders();
    if (sourceRoot !== state.sourceRoot) return;
    focusClaim(group.key, reimbursementRouteFor(group.key));
    renderRows();
    setWorklistStatus('报销事项已保存。请填写事由并匹配经费项目。');
    autoCheckAll();
  } catch (error) {
    if (dialog.open) $('claimRouteStatus').textContent = error.message;
    else setWorklistStatus(error.message);
  } finally {
    $('saveClaimRoute').disabled = false;
    $('cancelClaimRoute').disabled = false;
  }
}

async function updateClaimSources(folder, folders) {
  const item = itemFor(folder);
  if (!item?.groupId) return;
  try {
    await api(`/api/claim-groups/${item.groupId}`, { method: 'PUT', body: JSON.stringify({ sourceRoot: state.sourceRoot, folders }) });
    state.selectedSources.clear();
    state.sourceNotice = '';
    await refreshFolders();
    state.activeFolder = folder;
    renderRows();
    setWorklistStatus('来源已更新。请重新核对合并金额，再保存或更新事由。');
    autoCheckAll();
  } catch (error) { setWorklistStatus(error.message); }
}

async function dissolveClaim(folder) {
  const item = itemFor(folder);
  const sourceRoot = state.sourceRoot;
  const key = projectMatchKey(sourceRoot, folder);
  if (!item?.groupId || dissolvingClaims.has(key)) return;
  dissolvingClaims.add(key);
  const button = folderRow(folder)?.querySelector('[data-dissolve-claim]');
  if (button) button.disabled = true;
  let dissolved = false;
  try {
    const { group } = await api(`/api/claim-groups/${item.groupId}`, { method: 'DELETE', body: JSON.stringify({ sourceRoot }) });
    dissolved = true;
    clearTimeout(reasonEntries.get(key)?.timer);
    reasonEntries.delete(key);
    allocationEdits.delete(key);
    if (state.sourceRoot !== sourceRoot) return;
    const feedback = $('executionDetails');
    if (feedback.dataset.folder === folder && feedback.dataset.openRun !== 'true') $('executionFeedback').hidden = true;
    await refreshFolders();
    if (state.sourceRoot !== sourceRoot) return;
    const released = new Set(state.sourceFolders.filter((source) => group.folders.includes(source.path) && !source.reimbursed && !source.claimKey).map((source) => source.path));
    const filter = $('sourceFilter');
    const keyword = filter.value.trim().toLowerCase();
    if ([...released].some((path) => !path.toLowerCase().includes(keyword))) filter.value = '';
    state.sourceNotice = released.size ? `已退回 ${released.size} 个来源文件夹，可以重新勾选。` : '合并已撤销。';
    renderSources();
    const first = [...$('sourceRows').querySelectorAll('[data-source]')].find((input) => released.has(input.dataset.source));
    first?.scrollIntoView({ block: 'nearest' });
    first?.focus({ preventScroll: true });
    autoCheckAll();
  } catch (error) {
    setWorklistStatus(dissolved ? `合并已撤销，请刷新文件夹。${error.message}` : `撤销合并失败。${error.message}`);
  } finally {
    dissolvingClaims.delete(key);
    const control = folderRow(folder)?.querySelector('[data-dissolve-claim]');
    if (control) control.disabled = false;
  }
}

async function prepareSource(item, generation) {
  const config = configFor(item.path);
  try {
    const { plan } = await api('/api/plans', { method: 'POST', body: JSON.stringify({ sourceRoot: state.sourceRoot, folder: item.path, subject: config.subject, funding: config.funding, project: null, previewOnly: true }) });
    if (generation !== state.configurationGeneration) return;
    state.sourceAmounts.set(item.path, {
      totalCny: plan.totalCny, invoiceTotalCny: plan.invoiceTotalCny, recognizedPaymentCny: recognizedPaymentTotal(plan),
      fingerprint: plan.fingerprint, cacheState: plan.cacheState,
    });
    renderSources();
  } catch (error) {
    if (generation !== state.configurationGeneration) return;
    state.sourceAmounts.set(item.path, { error: error.message });
    renderSources();
  }
}

async function api(path, options = {}) {
  const requestHeaders = new Headers(options.headers);
  requestHeaders.set('content-type', 'application/json');
  if (state.workspace) requestHeaders.set('x-reimbursement-year', state.workspace.year);
  let response;
  try {
    response = await fetch(path, { ...options, headers: requestHeaders });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('本机请求超时，请查看当前状态后重试。');
    throw new Error('无法连接本机服务。请通过「打开报销助手」启动后重试。');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw new Error(payload?.error || `本机服务返回异常（${response.status}）。`);
  return payload;
}

function persistConfigs() {
  const output = { ...storedConfigs };
  for (const [folder, config] of state.configs) {
    output[folder] = {
      ...output[folder],
      subject: config.subject,
      funding: config.funding,
      travelRole: config.travelRole,
      travelFundType: config.travelFundType,
    };
  }
  storedConfigs = output;
  try { localStorage.setItem(configStorageKey, JSON.stringify(output)); } catch {}
}

function configFor(folder) {
  if (!state.configs.has(folder)) {
    const firstSegment = folder.split('/')[0];
    const saved = storedConfigs[folder] || {};
    const savedSubject = itemFor(folder)?.subject || state.sourceFolders.find((item) => item.path === folder)?.subject;
    const defaultSubject = SUBJECTS.includes(firstSegment) ? firstSegment : ({ AI: 'AI服务', 数据: '数据服务', 资料费: '书籍资料', 书籍: '书籍资料', cursor: '境外软件订阅', office: '境外软件订阅' }[firstSegment] || '其他');
    state.configs.set(folder, {
      subject: savedSubject || saved.subject || defaultSubject,
      funding: saved.funding === '科研' ? '科研' : '教学',
      travelRole: saved.travelRole || 'other',
      travelFundType: saved.travelFundType || 'budget',
      match: null,
      version: 0,
    });
  }
  return state.configs.get(folder);
}

function legacyProjectMatch(folder) {
  const saved = storedConfigs[folder];
  if (saved?.matchConfirmed !== true) return null;
  const manual = saved.projectChoice === 'manual';
  const projectNo = manual ? saved.manualProjectNo : saved.projectChoice;
  const projectName = manual ? saved.manualProjectName : saved.projectName;
  if (typeof projectNo !== 'string' || typeof projectName !== 'string' || !projectNo.trim() || !projectName.trim()) return null;
  return { projectNo, projectName, funding: saved.funding === '科研' ? '科研' : '教学' };
}

function applyProjectMatch(config, match) {
  config.match = match;
  if (match?.funding) config.funding = match.funding;
}

const singleProjectClaim = (item) => Boolean(item?.payroll || item?.didi);

const projectMatchKey = (sourceRoot, folder) => `${sourceRoot}\0${folder}`;

async function writeProjectMatch(sourceRoot, folder, match, importOnly = false) {
  const result = await api('/api/project-match', {
    method: 'POST',
    body: JSON.stringify({ sourceRoot, folder, match, importOnly }),
  });
  return result.match;
}

function setRunDrawer(open) {
  open = open && !state.demoMode;
  $('runDrawer').hidden = !open;
  $('runToggle').hidden = open || state.demoMode;
  $('runToggle').setAttribute('aria-expanded', String(open));
  if (open) $('runBadge').hidden = true;
}

function rowStatusFor(folder) {
  const item = itemFor(folder);
  if (state.blockingRun?.plan.folder === folder) return { type: 'reminder', text: runStatusLabel(state.blockingRun) };
  if (item?.didi) {
    const entry = reasonEntry(folder);
    const needsReason = cleanReason(entry.text) !== entry.confirmed || item.didi.blocker;
    if (needsReason) return { type: 'blocked', text: '待补齐' };
    if (item.didi.signer === null) return { type: 'blocked', text: '待指定加签人' };
    return { type: 'ready', text: '可执行' };
  }
  const plan = state.plans.get(folder);
  if (plan?.status === 'ready' && cleanReason(reasonEntry(folder).text) !== plan.reason) return { type: 'blocked', text: '事由待更新' };
  if (state.rowStatus.has(folder)) return state.rowStatus.get(folder);
  if (plan) return checkedPlanStatus(plan);
  return { type: 'idle', text: '未检查' };
}

function setRowStatus(folder, type, text) {
  state.rowStatus.set(folder, { type, text });
}

function selectedClaimRoute(folder) {
  return itemFor(folder)?.offlineBooking ? 'legacy' : 'smart';
}

function reimbursementRouteFor(folder) {
  const plan = state.plans.get(folder);
  const subject = plan?.subject || configFor(folder).subject;
  if (subject === '劳务费') return 'labor';
  return plan?.reimbursementRoute || (subject === '差旅' ? 'smart' : selectedClaimRoute(folder));
}

const schoolFinanceMessages = new Map();
let checkingSchoolFinance = false;

function renderSchoolFinanceEntry() {
  const kind = $('claimRouteFilter').value;
  $('addDidiClaim').hidden = Boolean(kind && kind !== 'smart' && kind !== 'didi');
  $('schoolFinanceEntry').hidden = kind !== 'legacy' && kind !== 'labor';
  $('addPayroll').hidden = kind !== 'labor';
  $('addPayroll').disabled = !state.payrollCategories.length;
  $('claimInstructions').textContent = kind === 'legacy' ? '匹配一项经费，确认事由和纸质附件张数。'
    : kind === 'labor' ? '保存申报后，在右栏匹配经费，再勾选执行。'
    : kind === 'didi' ? '填写预算和用车事由，在右栏匹配经费。执行时从学校滴滴票夹选票。' : '点卡片匹配经费。';
  $('checkSchoolFinance').disabled = checkingSchoolFinance;
  $('schoolFinanceStatus').textContent = schoolFinanceMessages.get(kind) || '';
}

async function checkSchoolFinanceEntry() {
  const kind = $('claimRouteFilter').value;
  if (checkingSchoolFinance || (kind !== 'legacy' && kind !== 'labor')) return;
  checkingSchoolFinance = true;
  schoolFinanceMessages.set(kind, '正在核对学校财务系统…');
  renderSchoolFinanceEntry();
  try {
    const result = await api('/api/school-finance/check', { method: 'POST', body: JSON.stringify({ kind }) });
    schoolFinanceMessages.set(kind, [result.computer, result.message].filter(Boolean).join(' · '));
  } catch (error) {
    schoolFinanceMessages.set(kind, error.message);
  } finally {
    checkingSchoolFinance = false;
    renderSchoolFinanceEntry();
  }
}

function canSelectForExecution(folder) {
  if (itemFor(folder)?.payroll) return true;
  const route = reimbursementRouteFor(folder);
  return !route || route === 'smart' || route === 'legacy';
}

function checkedPlanStatus(plan) {
  if (plan.subject === '劳务费' || plan.reimbursementRoute === 'labor') return { type: 'reminder', text: '准备校方申报表' };
  if (plan.reimbursementRoute === 'legacy') {
    if (plan.fxNeeded?.length) return { type: 'blocked', text: '待补中行牌价' };
    if (!Number.isSafeInteger(plan.totalCny)) return { type: 'blocked', text: '付款材料待核对' };
  }
  if (plan.reimbursementRoute === 'split') return { type: 'blocked', text: '请按结算方式拆分' };
  if (plan.reimbursementRoute === 'review') return { type: 'blocked', text: '付款材料待核对' };
  if (plan.status !== 'ready') return { type: 'blocked', text: plan.project.projectNo ? '待补充/核对' : '待匹配' };
  if (plan.reimbursementRoute === 'smart' && plan.signer === null) return { type: 'blocked', text: '待指定加签人' };
  if (plan.warnings?.length) return { type: 'reminder', text: '有提醒，可执行' };
  return { type: 'checked', text: '核对通过' };
}

function storeCheckedPlan(plan) {
  state.plans.set(plan.folder, plan);
  if (!canSelectForExecution(plan.folder)) state.selected.delete(plan.folder);
  state.amounts.set(plan.folder, { totalCny: plan.totalCny, invoiceTotalCny: plan.invoiceTotalCny });
  state.rowStatus.set(plan.folder, checkedPlanStatus(plan));
}

function setWorklistStatus(text) {
  $('worklistStatus').textContent = text;
}

function folderRow(folder) {
  return [...$('folderRows').children].find((item) => item.dataset.path === folder);
}

function updateRowInPlace(folder) {
  const row = folderRow(folder);
  if (row) {
    const selectable = canSelectForExecution(folder);
    const checkbox = row.querySelector('.row-select');
    checkbox.disabled = !selectable;
    checkbox.checked = state.selected.has(folder);
    checkbox.title = selectable ? '勾选以加入报销批次' : '请按此事项的办理系统处理';
    const route = row.querySelector('.folder-route');
    if (route) route.textContent = ROUTE_LABELS[reimbursementRouteFor(folder)] || '';
    if (row.querySelector('.reason-action')) updateReasonInPlace(folder, row);
    updateAllocationInPlace(folder, row);
    const details = row.querySelector('.detail-row');
    if (details) {
      const plan = state.plans.get(folder);
      details.disabled = !plan;
      details.textContent = paymentReviewNeeded(plan) ? '核对发票和付款' : '详情';
    }
    const amount = folderAmount(folder);
    row.querySelector('.folder-amount').textContent = amount.value;
    row.querySelector('.folder-amount-label').textContent = amount.label;
  }
  if (state.activeFolder === folder) renderProjects();
  if (state.detailFolder === folder) renderDetailModal();
}

function updateProjectStatus(text) {
  $('projectStatus').textContent = text;
}

function savedProjectStatus() {
  if (!state.projectSyncedAt) return '登录校园网后同步项目和可用金额。';
  const count = state.projects.filter((project) => Number.isSafeInteger(project.balanceCny)).length;
  const date = new Date(state.projectSyncedAt).toLocaleString('zh-CN', { hour12: false });
  return `${state.projects.length} 个项目，${count} 个已读取可用金额。同步于 ${date}。`;
}

function renderTravelSection(plan) {
  const travel = plan.travel;
  if (!travel) return '';
  const profile = travel.profile || {};
  const facts = travel.facts || {};
  const config = configFor(plan.folder);
  const roleOptions = TRAVEL_ROLES.map((item) => `<option value="${item.value}" ${(profile.role || config.travelRole) === item.value ? 'selected' : ''}>${item.label}</option>`).join('');
  const fundOptions = `<option value="budget" ${(profile.fundType || config.travelFundType) === 'budget' ? 'selected' : ''}>预算类经费</option><option value="research" ${(profile.fundType || config.travelFundType) === 'research' ? 'selected' : ''}>科研类经费</option>`;
  const segmentRows = (facts.segments || []).map((segment) => `<tr><td>${escapeHtml(segment.travelDate || '')}</td><td>${escapeHtml(segment.serviceNumber)}</td><td>${escapeHtml(segment.departure)}→${escapeHtml(segment.destination)}</td><td>${escapeHtml(segment.transportMode)}</td><td>${segment.ticketAmountCny ? money(segment.ticketAmountCny) : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">未识别到机票/车票行程段</td></tr>';
  const stayRows = travel.lodging.stays.map((stay) => `<tr><td>${escapeHtml(stay.location)}</td><td>${escapeHtml(stay.checkInDate || '')} ~ ${escapeHtml(stay.checkOutDate || '')}</td><td>${stay.guestCount || '—'}</td><td>${stay.amountCny ? money(stay.amountCny) : '—'}</td><td>${stay.limitCny ? money(stay.limitCny) : '—'}</td><td>${stay.eligibleCny ? money(stay.eligibleCny) : '—'}</td><td>${escapeHtml(stay.note || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">无住宿记录</td></tr>';
  const allowance = travel.allowance;
  const allowanceHtml = allowance
    ? `<p>伙食 ${money(allowance.mealAmountCny)}（${allowance.mealRate} 元/人/天）+ 市内交通 ${money(allowance.localTransportCny)}（${allowance.localTransportRate} 元/人/天）= <strong>${money(allowance.totalCny)}</strong>，共 ${travel.days} 天。</p>${allowance.assumptions.length ? `<p class="muted">估算假设：${escapeHtml(allowance.assumptions.join('；'))}</p>` : ''}`
    : '<p class="muted">出发/返程日期不完整，暂不能计算补贴。</p>';
  const breakdown = allowance
    ? `<p>票据核定 ${money(plan.ticketTotalCny)} + 补贴 ${money(allowance.totalCny)} = <strong>核定报销 ${money(plan.totalCny)}</strong></p>`
    : '';
  const flightNote = travel.flight?.note ? `<p>机票渠道：${escapeHtml(travel.flight.note)}</p>` : '';
  return `<section class="detail-section"><h3>差旅核算</h3>
    <div class="edit-grid"><label>职务/职称档次<select id="editTravelRole">${roleOptions}</select></label><label>经费类型<select id="editTravelFund">${fundOptions}</select></label></div>
    <p>目的地：${escapeHtml(facts.destination || '未识别')}；行程：${escapeHtml(facts.startDate || '?')} ~ ${escapeHtml(facts.endDate || '?')}；人数：${facts.travelerCount || '按 1 人'}${facts.travelers?.length ? `（${escapeHtml(facts.travelers.map((item) => item.name).join('、'))}）` : ''}</p>
    <p class="muted">${escapeHtml(profile.fundTypeLabel || '')}；交通标准：${escapeHtml(profile.transport || '')}；住宿按附表二“${escapeHtml(profile.lodgingGrade || '')}”档核价。</p>
    <table class="invoice-table"><thead><tr><th>日期</th><th>班次</th><th>行程</th><th>方式</th><th>票价</th></tr></thead><tbody>${segmentRows}</tbody></table>
    <table class="invoice-table"><thead><tr><th>入住地</th><th>入住~退房</th><th>人数</th><th>金额</th><th>限额</th><th>计入</th><th>说明</th></tr></thead><tbody>${stayRows}</tbody></table>
    ${allowanceHtml}${flightNote}${breakdown}
  </section>`;
}

function renderMaterialReview(plan) {
  const options = (selected) => `<option value="">尚未确认</option>${(plan.supportingFiles || []).map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}`;
  const confirmed = plan.confirmations || {};
  const purchase = ['办公用品', '电脑配件'].includes(plan.subject);
  const paidFields = plan.rows.filter((row) => row.needsAllocation || row.amountBasis === '手填实付金额').map((row) => {
    const value = confirmed.paidAmountsCny?.[row.invoiceNumber];
    return `<label>发票 ${escapeHtml(row.invoiceNumber)} 的实付金额（元）<input type="number" min="0.01" step="0.01" inputmode="decimal" data-paid-invoice="${escapeHtml(row.invoiceNumber)}" value="${Number.isSafeInteger(value) ? (value / 100).toFixed(2) : ''}"></label>`;
  }).join('');
  const payments = plan.paymentCandidates || [];
  const paymentFields = payments.length && plan.rows.length ? `<details id="paymentReview" class="funding-data" ${paymentReviewNeeded(plan) ? 'open' : ''}>
    <summary>核对发票对应的付款凭证</summary>
    <p class="muted">按发票勾选实际对应的付款，可选多笔。核对金额、日期和交易明细后点「保存核对结果」，助手会按发票与对应实付金额的较小值计算。</p>
    ${plan.rows.map((row) => `<fieldset data-invoice-payments="${escapeHtml(row.invoiceNumber)}">
      <legend>${escapeHtml(plan.fileSources?.[row.invoiceFile]?.folder || row.invoiceFile)} · 发票 ${escapeHtml(row.invoiceNumber)} · ${money(row.invoiceAmountCny)}${row.date ? ' · ' + escapeHtml(row.date) : ''}</legend>
      ${payments.map(({ name, amountCny, date }) => `<label class="checkbox-row"><input type="checkbox" value="${escapeHtml(name)}" ${row.paymentFiles.includes(name) ? 'checked' : ''}>${escapeHtml(plan.fileSources?.[name]?.name || name)} · ${money(amountCny)}${date ? ' · ' + escapeHtml(date) : ''}${plan.fileSources?.[name] ? ' · ' + escapeHtml(plan.fileSources[name].folder) : ''}</label>`).join('')}
    </fieldset>`).join('')}
  </details>` : '';
  return `<section class="detail-section"><h3>材料核对${paidFields ? '与合并付款分配' : ''}</h3><p class="muted">签字、印章和公务卡核对只作提醒。材料确认和分配金额只用于当前附件。</p>
    ${paymentFields}
    <div class="edit-grid">
    ${paidFields}
    ${purchase ? `<label>我已核对签字的签收单<select id="confirmReceipt">${options(confirmed.receiptFile)}</select></label>` : ''}
    ${plan.subject === '电脑配件' ? `<label class="checkbox-row"><input id="confirmGovernmentProcurement" type="checkbox" ${confirmed.governmentProcurement ? 'checked' : ''}>本批属于政府采购设备</label><label>资产入账凭证（仅政府采购设备）<select id="confirmAsset">${options(confirmed.assetFile)}</select></label>` : ''}
    ${plan.subject === 'AI服务' ? `<label>我已核对公司印章的服务清单<select id="confirmSeal">${options(confirmed.sealedDetailFile)}</select></label>` : ''}
    <label class="checkbox-row"><input id="confirmCard" type="checkbox" ${confirmed.paymentCardConfirmed ? 'checked' : ''}>我已确认本批付款记录属于公务卡</label></div>
    <button id="saveMaterials" class="secondary" type="button">保存核对结果${paidFields ? '和实付金额' : ''}</button><p id="materialStatus" class="muted" role="status"></p></section>`;
}

async function saveMaterialReview() {
  const folder = state.detailFolder;
  const plan = state.plans.get(folder);
  if (!plan) return;
  const generation = state.configurationGeneration;
  const status = $('materialStatus');
  const button = $('saveMaterials');
  const paidAmountsCny = {};
  for (const input of $('detailContent').querySelectorAll('[data-paid-invoice]')) {
    if (!input.value && !input.validity.badInput) continue;
    const amount = Math.round(Number(input.value) * 100);
    if (!input.validity.valid || !Number.isSafeInteger(amount) || amount <= 0) {
      status.textContent = '请输入大于零的实付金额，最多两位小数。';
      input.focus();
      return;
    }
    paidAmountsCny[input.dataset.paidInvoice] = amount;
  }
  const paymentLinks = { ...plan.confirmations?.paymentLinks };
  for (const field of $('detailContent').querySelectorAll('[data-invoice-payments]')) {
    const invoice = field.dataset.invoicePayments;
    const inputs = [...field.querySelectorAll('input[type="checkbox"]')];
    if (inputs.some((input) => input.checked !== input.defaultChecked)) {
      paymentLinks[invoice] = inputs.filter(({ checked }) => checked).map(({ value }) => value);
    }
  }
  const payload = { fingerprint: plan.fingerprint, receiptFile: $('confirmReceipt')?.value, assetFile: $('confirmAsset')?.value, sealedDetailFile: $('confirmSeal')?.value, paymentCardConfirmed: $('confirmCard').checked, governmentProcurement: $('confirmGovernmentProcurement')?.checked === true, paidAmountsCny,
    ...(Object.keys(paymentLinks).length ? { paymentLinks } : {}) };
  button.disabled = true;
  status.textContent = '正在保存核对结果…';
  try {
    const { plan: saved } = await api(`/api/plans/${plan.id}/confirmations`, { method: 'POST', body: JSON.stringify(payload) });
    if (generation !== state.configurationGeneration) return;
    storeCheckedPlan(saved);
    renderRows();
    const message = paymentReviewNeeded(saved) ? '核对结果已保存。请继续核对尚未关联的发票或付款。'
      : Number.isSafeInteger(saved.totalCny) ? `核对结果已保存，核定报销 ${money(saved.totalCny)}。` : '核对结果已保存。请查看剩余金额核对事项。';
    if ($('executionDetails').dataset.folder === folder) $('executionFeedback').hidden = true;
    setWorklistStatus(message);
    if (state.detailFolder === folder) {
      renderDetailModal();
      $('materialStatus').textContent = message;
      $('materialStatus').scrollIntoView({ block: 'nearest' });
    }
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
}

function reasonEntry(folder) {
  const key = projectMatchKey(state.sourceRoot, folder);
  if (!reasonEntries.has(key)) reasonEntries.set(key, { sourceRoot: state.sourceRoot, folder, text: '', saved: '', hasSaved: false, error: '' });
  return reasonEntries.get(key);
}

const cleanReason = (text) => text.trim().replace(/\s+/g, ' ');

function reasonControls(folder) {
  const entry = reasonEntry(folder);
  const plan = state.plans.get(folder);
  const text = cleanReason(entry.text);
  const canConfirm = Boolean(projectForFolder(folder) && plan?.project.projectNo);
  let status = entry.error;
  if (!status && entry.confirming) status = entry.hasSaved ? '正在更新…' : '正在保存…';
  if (!status && text !== entry.saved) status = '待保存';
  if (!status && text) {
    if (itemFor(folder)?.didi && text === entry.confirmed && !itemFor(folder).didi.blocker) status = '已保存';
    else if (plan?.reason === text) status = '已保存';
    else if (!entry.hasSaved) status = '草稿已保存';
    else status = canConfirm ? '已保存，待更新' : '已保存';
  }
  return { status, label: entry.hasSaved ? '更新事由' : '保存事由', disabled: entry.confirming || (!text && !entry.saved) };
}

function renderReasonForm(folder) {
  const controls = reasonControls(folder);
  const didi = Boolean(itemFor(folder)?.didi);
  return `<form class="folder-reason-form">
    <label>报销事项／事由<textarea class="folder-reason-input" rows="2" maxlength="${didi ? 50 : 500}" aria-label="报销事由 ${escapeHtml(displayNameFor(folder))}" placeholder="${didi ? '写清这次用车对应的具体教学科研工作' : '写清合并后的费用用于哪项具体教学科研工作'}">${escapeHtml(reasonEntry(folder).text)}</textarea></label>
    <button class="secondary reason-action" type="submit" ${controls.disabled ? 'disabled' : ''}>${controls.label}</button>
    <small class="reason-status" role="status">${escapeHtml(controls.status)}</small>
  </form>`;
}

function updateReasonInPlace(folder, row = folderRow(folder)) {
  if (!row) return;
  const controls = reasonControls(folder);
  const button = row.querySelector('.reason-action');
  button.textContent = controls.label;
  button.disabled = controls.disabled;
  row.querySelector('.reason-status').textContent = controls.status;
  const status = rowStatusFor(folder);
  const badge = row.querySelector('.row-state');
  badge.className = `row-state ${status.type}`;
  badge.textContent = status.text;
  updateSelectionCount();
}

function reasonRequest(entry, explicit = false, reason = cleanReason(entry.text), sourceFolders = entry.sourceFolders) {
  return JSON.stringify({ sourceRoot: entry.sourceRoot, folder: entry.folder, sourceFolders, reason, explicit });
}

async function saveReasonDraft(entry, explicit = false) {
  clearTimeout(entry.timer);
  const requested = cleanReason(entry.text);
  const sourceFolders = entry.sourceFolders;
  const operation = (entry.pending || Promise.resolve()).catch(() => undefined).then(async () => {
    const text = explicit ? requested : cleanReason(entry.text);
    const didi = itemFor(entry.folder)?.didi;
    if (text === entry.saved && (!explicit || !text || !didi && entry.hasSaved)) return;
    const result = await api('/api/claim-reason', { method: 'POST', body: reasonRequest(entry, explicit, text, sourceFolders) });
    entry.saved = result.reasonDraft;
    entry.hasSaved = result.reasonSaved === true;
    if (didi) {
      didi.blocker = result.blocker;
      didi.revision = result.revision;
      entry.confirmed = result.blocker ? '' : result.reasonDraft;
    }
    entry.error = '';
  });
  entry.pending = operation;
  try {
    await operation;
  } catch (error) {
    entry.error = `事由保存失败：${error.message}`;
    throw error;
  } finally {
    if (entry.pending === operation) entry.pending = null;
    if (entry.sourceRoot === state.sourceRoot) updateReasonInPlace(entry.folder);
  }
}

async function saveClaimPurpose(event) {
  const form = event.target.closest('.folder-reason-form');
  if (!form) return;
  event.preventDefault();
  const folder = form.closest('.folder-row').dataset.path;
  const entry = reasonEntry(folder);
  if (entry.confirming) return;
  entry.confirming = true;
  entry.error = '';
  const reason = cleanReason(entry.text);
  updateReasonInPlace(folder);
  try {
    await saveReasonDraft(entry, true);
    if (itemFor(folder)?.didi) return;
    if (entry.sourceRoot !== state.sourceRoot || cleanReason(entry.text) !== reason || !reason) return;
    const plan = state.plans.get(folder);
    if (!projectForFolder(folder) || !plan?.project.projectNo || plan.reason === reason) return;
    const result = await api(`/api/plans/${plan.id}/purpose`, { method: 'POST', body: JSON.stringify({ reason, confirmed: true }) });
    if (state.plans.get(folder)?.id !== plan.id || cleanReason(entry.text) !== reason) return;
    storeCheckedPlan(result.plan);
    if (state.detailFolder === folder) renderDetailModal();
  } catch (error) {
    if (!entry.error) entry.error = error.message;
  } finally {
    entry.confirming = false;
    if (entry.sourceRoot === state.sourceRoot) updateReasonInPlace(folder);
  }
}

const foreignMoney = ({ currency, minor, digits }) => `${currency} ${(minor / 10 ** digits).toFixed(digits)}`;

function renderForeignReview(plan) {
  if (!plan.foreignClaim) return '';
  const entries = plan.rows.filter((row) => row.foreignMoney);
  const parts = entries.flatMap((row) => (row.fx || []).map((part) => `<li><span>${escapeHtml(row.invoiceNumber)} · ${escapeHtml(foreignMoney(part.native))}</span><span>${money(part.cny)} · ${part.quoteKey ? '按付款日折算' : '人民币实扣'}</span></li>`)).join('');
  const missing = (plan.fxNeeded || []).map(({ date, currency }) => `<li><span>${escapeHtml(date)} · ${escapeHtml(currency)} 牌价待补</span><button type="button" class="secondary" data-fx-date="${escapeHtml(date)}" data-fx-currency="${escapeHtml(currency)}" ${fxLookup ? 'disabled' : ''}>查询并保存截图</button></li>`).join('');
  const saved = (plan.fxQuotes || []).map((quote) => `<li><span>${escapeHtml(quote.quotedAt)} · ${escapeHtml(quote.ratePer100)} 元／100 ${escapeHtml(quote.currency)}</span><a href="/api/plans/${encodeURIComponent(plan.id)}/fx-quote/${encodeURIComponent(quote.key)}" download>下载中行牌价截图</a></li>`).join('');
  const status = fxLookup?.folder === plan.folder ? '查询中。若中行窗口出现验证码，请完成验证，结果出来后会自动保存。' : fxMessage?.folder === plan.folder ? fxMessage.text : '';
  if (!parts && !missing && !saved && !status) return '';
  return `<section class="detail-section fx-review"><h3>付款核对</h3><ul>${parts}${missing}${saved}</ul>${status ? `<p class="muted" role="status">${escapeHtml(status)}</p>` : ''}</section>`;
}

async function lookupForeignQuote(button) {
  if (fxLookup) return;
  const folder = state.detailFolder;
  const plan = state.plans.get(folder);
  if (!plan?.foreignClaim) return;
  const { fxDate: date, fxCurrency: currency } = button.dataset;
  fxLookup = { folder };
  fxMessage = null;
  renderDetailModal();
  try {
    await api(`/api/plans/${plan.id}/fx-quote`, { method: 'POST', body: JSON.stringify({ date, currency }) });
    if (state.folders.some((item) => item.path === folder && !item.reimbursed)) {
      configFor(folder).version += 1;
      await prepareFolder(folder);
    }
  } catch (error) { fxMessage = { folder, text: error.message }; }
  finally {
    fxLookup = null;
    if (state.detailFolder === folder) renderDetailModal();
  }
}

function defaultSignerLabel({ signerDefault, signerDefaultSource }) {
  if (signerDefaultSource === 'conflict') return '项目默认加签人不同，请为本笔指定';
  if (!signerDefault) return '未设置默认加签人';
  return (signerDefaultSource === 'project' ? '项目默认 · ' : '经费口径备用 · ') + signerDefault.name;
}

function applySignerRoster(result) {
  if (Array.isArray(result.signerRoster)) state.signerRoster = result.signerRoster;
  else if (Array.isArray(result.signerNames)) state.signerRoster = result.signerNames.map((name) => ({ name, employeeNo: '' }));
}

let detailSignerPicker;
function renderPlanDetails(plan) {
  const recognized = recognizedPaymentTotal(plan);
  const showRecognized = recognized !== null && (paymentReviewNeeded(plan) || !Number.isSafeInteger(plan.paidTotalCny));
  const reviewSource = plan.uploadSource === 'ai' ? '模型复核' : plan.uploadSource === 'ai-cache' ? '模型复核结果已缓存' : '本机规则';
  const currentReason = plan.reason && cleanReason(reasonEntry(plan.folder).text) === plan.reason ? plan.reason : '';
  const ready = plan.status === 'ready' && currentReason;
  const labor = plan.subject === '劳务费';
  const offline = labor || plan.reimbursementRoute === 'legacy';
  const routeLabel = ROUTE_LABELS[labor ? 'labor' : plan.reimbursementRoute] || '待核对';
  const invoiceRows = plan.rows.map((row) => `<tr><td>${escapeHtml(row.invoiceNumber || row.invoiceFile)}${plan.fileSources?.[row.invoiceFile] ? `<small class="source-note">${escapeHtml(plan.fileSources[row.invoiceFile].folder)}</small>` : ''}</td><td>${escapeHtml(row.date || '')}</td><td>${money(row.invoiceAmountCny)}${row.foreignMoney ? `<small class="source-note">${escapeHtml(foreignMoney(row.foreignMoney))}</small>` : ''}</td><td>${money(row.paidAmountCny)}</td><td>${money(row.reimbursementAmountCny)}</td></tr>`).join('');
  const batchRows = plan.batches.map((batch, index) => `<tr><td>第 ${index + 1} 批</td><td>${batch.length}</td><td>${escapeHtml(batch.join('、'))}</td></tr>`).join('');
  const warnings = plan.warnings.length ? `<div class="warnings"><strong>核对提醒</strong><ul>${plan.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : '';
  const signerPending = plan.reimbursementRoute === 'smart' && plan.signer === null;
  const executionLabel = offline ? checkedPlanStatus(plan).text : ready && !signerPending ? (warnings ? '有提醒，可以执行' : '核对通过，可以执行') : '尚不能执行';
  const KIND_LABELS = { invoice: '发票', detail: '订单/明细', payment: '支付记录', receipt: '签收单', asset: '资产卡片', other: '其他正式材料' };
  const fileNames = labor ? plan.supportingFiles : offline ? plan.paperFiles || plan.uploadFiles : plan.uploadFiles;
  const fileHeading = labor ? '来源材料' : offline ? '线下材料' : '全部上传文件';
  const files = fileNames.map((file) => {
    const source = plan.fileSources?.[file];
    const kind = KIND_LABELS[plan.uploadTypes?.[file]];
    return `<li>${escapeHtml(source?.name || file)}
      ${kind ? `<small>（${kind}）</small>` : ''}
      ${source ? `<small class="source-note">来源 ${escapeHtml(source.folder)}${offline ? '' : ` · 上传名 ${escapeHtml(file)}`}</small>` : ''}
    </li>`;
  }).join('');
  const expenseTypeOptions = ['<option value="">执行时确认</option>', ...EXPENSE_TYPES.map((type) => `<option value="${type}" ${plan.expenseType === type ? 'selected' : ''}>${type}</option>`)].join('');
  const subjectOptions = SUBJECTS.map((subject) => `<option value="${subject}" ${plan.subject === subject ? 'selected' : ''}>${subject}</option>`).join('');
  return `<div class="plan">
    <section class="detail-section"><h3>办理系统</h3><p>${routeLabel}</p></section>
    ${labor ? '' : `<div class="metrics"><div class="metric"><small>发票总额</small><strong>${money(plan.invoiceTotalCny)}</strong></div><div class="metric"><small>${showRecognized ? '已识别付款' : '已关联实付'}</small><strong>${money(showRecognized ? recognized : plan.paidTotalCny)}</strong></div><div class="metric"><small>核定报销</small><strong>${money(plan.totalCny)}</strong></div></div>`}
    <section class="detail-section"><h3>报销事由</h3><p class="muted">${currentReason ? `${offline ? '' : '学校页面填写内容 '}${escapeHtml(currentReason)}` : '请在报销事项中填写事由，再点击保存或更新。'}</p></section>
    ${plan.sourceFolders ? `<section class="detail-section"><h3>来源文件夹</h3><ul>${plan.sourceFolders.map((folder) => `<li>${escapeHtml(folder)}</li>`).join('')}</ul><p class="muted">合并检查 ${plan.sourceFolders.length} 个文件夹，共用一笔报销事由和经费项目。</p></section>` : ''}
    <div class="edit-grid">
      <label>报销科目<select id="editSubject">${subjectOptions}</select></label>
      ${labor || plan.subject === '差旅' || !['smart', 'legacy'].includes(plan.reimbursementRoute) ? '' : `
        <label>日常办理方式<select id="editBookingRoute"><option value="" ${!plan.bookingOptions?.offline ? 'selected' : ''}>智能报销系统（默认）</option><option value="legacy" ${plan.bookingOptions?.offline ? 'selected' : ''}>日常线下报销</option></select></label>
        ${offline ? `<label>纸质附件张数<input id="editPaperCount" type="number" min="1" max="50" step="1" value="${plan.attachmentCount ?? ''}"></label>` : ''}
      `}
      ${offline ? '' : `<label>费用类型<select id="editExpenseType">${expenseTypeOptions}</select></label>
        <div id="detailSignerPicker" class="signer-picker"></div>`}
    </div>
    <div class="edit-actions"><button id="savePlanEdit" class="secondary" type="button">保存设置</button><span id="editStatus" class="muted"></span></div>
    ${offline ? '' : `<dl><dt>费用类型特例</dt><dd>${plan.expenseTypeRules?.length ? escapeHtml(plan.expenseTypeRules.map((rule) => `${rule.keyword}→${rule.type}`).join('、')) : '无'}</dd><dt>票据</dt><dd>${plan.rows.length} 张发票，${plan.uploadFiles.length} 个上传文件（${reviewSource}），分 ${plan.batches.length} 批</dd><dt>检查状态</dt><dd>${plan.cacheState === 'cached' ? '本机取字结果已缓存' : '已读取新增或更新的附件'}。</dd></dl>`}
    <div class="${ready && !signerPending ? 'muted' : 'warnings'}"><strong>${executionLabel}</strong>${plan.blockers?.length ? `<ul>${plan.blockers.map((message) => `<li>${escapeHtml(message)}</li>`).join('')}</ul>` : ''}</div>
    ${warnings}
    ${renderMaterialReview(plan)}
    ${renderTravelSection(plan)}
    ${renderForeignReview(plan)}
    ${labor ? '' : `<section class="detail-section"><h3>发票明细</h3><table class="invoice-table"><thead><tr><th>发票号码</th><th>日期</th><th>发票</th><th>实付</th><th>报销</th></tr></thead><tbody>${invoiceRows}</tbody></table></section>`}
    ${offline ? '' : `<section class="detail-section"><h3>上传批次</h3><table class="invoice-table"><thead><tr><th>批次</th><th>文件数</th><th>文件</th></tr></thead><tbody>${batchRows}</tbody></table></section>`}
    <details ${labor ? 'open' : ''}><summary>${fileHeading}（${fileNames.length} 个）</summary><ul class="file-list">${files}</ul></details>
  </div>`;
}

function openDetails(folder) {
  const plan = state.plans.get(folder);
  if (!plan) return;
  state.detailFolder = folder;
  renderDetailModal();
  if (paymentReviewNeeded(plan)) $('paymentReview').querySelector('summary').focus();
}

function closeDetails() {
  state.detailFolder = '';
  $('detailModal').hidden = true;
  detailSignerPicker = null;
}

async function savePlanEdits() {
  const folder = state.detailFolder;
  const plan = state.plans.get(folder);
  if (!plan) return;
  const config = configFor(folder);
  const subject = $('editSubject').value;
  const expenseType = $('editExpenseType')?.value;
  if (detailSignerPicker && !detailSignerPicker.reportValidity()) return;
  const signer = detailSignerPicker?.value();
  const payload = { sourceRoot: state.sourceRoot, folder, planId: plan.id, subject };
  if ($('editBookingRoute')) {
    const count = $('editPaperCount');
    if (count && !count.reportValidity()) return;
    const previousCount = plan.bookingOptions?.fingerprint === plan.fingerprint ? plan.bookingOptions.attachmentCount : null;
    payload.bookingOptions = {
      offline: $('editBookingRoute').value === 'legacy',
      attachmentCount: count ? count.value ? (Number(count.value) === plan.attachmentCount ? previousCount : Number(count.value)) : null : previousCount,
    };
  }
  if (expenseType && expenseType !== plan.expenseType) payload.expenseType = expenseType;
  if (signer !== undefined && (signer?.name !== plan.signerOverride?.name ||
      (signer?.employeeNo || '') !== (plan.signerOverride?.employeeNo || ''))) {
    payload.signerOverride = signer;
  }
  if (subject === '差旅' && $('editTravelRole')) {
    payload.travelProfile = { role: $('editTravelRole').value, fundType: $('editTravelFund').value };
    config.travelRole = payload.travelProfile.role;
    config.travelFundType = payload.travelProfile.fundType;
  }
  $('savePlanEdit').disabled = true;
  $('editStatus').textContent = '保存中…';
  try {
    const result = await api('/api/plan-override', { method: 'POST', body: JSON.stringify(payload) });
    applySignerRoster(result);
    config.subject = subject;
    const item = itemFor(folder);
    if (item && payload.bookingOptions && item.offlineBooking !== payload.bookingOptions.offline) {
      item.offlineBooking = payload.bookingOptions.offline;
      focusClaim(folder, selectedClaimRoute(folder));
    }
    persistConfigs();
    if (result.recheck) {
      state.amounts.delete(folder);
      await invalidatePlan(folder, () => {});
      return;
    }
    if (result.plan) storeCheckedPlan(result.plan);
    renderRows();
    renderDetailModal();
    $('editStatus').textContent = result.changes?.length ? `已保存并记住：${result.changes.join('；')}` : '已保存（与已记住的一致）';
  } catch (error) {
    $('editStatus').textContent = `保存失败：${error.message}`;
  } finally {
    const button = $('savePlanEdit');
    if (button) button.disabled = false;
  }
}

function renderDetailModal() {
  const plan = state.detailFolder ? state.plans.get(state.detailFolder) : null;
  if (!plan) {
    $('detailModal').hidden = true;
    return;
  }
  $('detailTitle').textContent = plan.displayName || displayNameFor(plan.folder);
  $('detailSubtitle').textContent = plan.subject === '劳务费'
    ? `${plan.supportingFiles.length} 个来源材料`
    : `${plan.rows.length} 张发票 · 核定报销 ${money(plan.totalCny)} · ${plan.cacheState === 'cached' ? '复用缓存' : '重新识别'}`;
  $('detailContent').innerHTML = renderPlanDetails(plan);
  $('savePlanEdit')?.addEventListener('click', savePlanEdits);
  const picker = $('detailSignerPicker');
  detailSignerPicker = picker ? mountSignerPicker(picker, {
    label: '本笔加签人', roster: state.signerRoster, selected: plan.signerOverride,
    defaultLabel: `沿用默认（${defaultSignerLabel(plan)}）`,
  }) : null;
  $('saveMaterials')?.addEventListener('click', saveMaterialReview);
  $('detailModal').hidden = false;
}

function folderAmount(folder) {
  const item = itemFor(folder);
  if (item?.didi) return { value: money(item.didi.budgetCny), label: '预算上限' };
  if (item?.payroll) return { value: money(item.payroll.totalCny), label: '应发合计' };
  const amount = state.amounts.get(folder);
  if (Number.isSafeInteger(amount?.totalCny)) return { value: money(amount.totalCny), label: '核定报销' };
  if (amount?.invoiceTotalCny > 0) return { value: money(amount.invoiceTotalCny), label: '发票合计 · 待核定' };
  return { value: '待核定', label: '报销金额' };
}

function projectForFolder(folder) {
  return projectsForFolder(folder)[0] || null;
}

function projectsForFolder(folder) {
  if (!folder) return [];
  return matchProjects(configFor(folder).match).map((project) => ({
    ...project,
    projectName: state.projects.find((item) => item.projectNo === project.projectNo)?.projectName || project.projectName,
  }));
}

function parseAllocationAmount(value) {
  const input = value.trim();
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(input)) return null;
  const [whole, decimals = ''] = input.split('.');
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function allocationState(folder) {
  const key = projectMatchKey(state.sourceRoot, folder);
  const edits = allocationEdits.get(key);
  const projects = projectsForFolder(folder);
  const fields = projects.slice(0, -1).map((project) => {
    const saved = Number.isSafeInteger(project.amountCny) ? (project.amountCny / 100).toFixed(2) : '';
    const value = edits?.get(project.projectNo) ?? saved;
    const amountCny = parseAllocationAmount(value);
    const dirty = amountCny !== (project.amountCny ?? null) || Boolean(value.trim() && amountCny === null);
    return { ...project, value, amountCny, dirty };
  });
  const draft = projects.length > 1 ? [...fields.map(({ projectNo, projectName, amountCny }) => ({ projectNo, projectName, amountCny })), { ...projects.at(-1), amountCny: null }] : projects;
  const amount = state.amounts.get(folder) || {};
  const result = allocateProjects(draft, amount.totalCny);
  if (result.error && !Number.isSafeInteger(amount.totalCny)) {
    const plan = state.plans.get(folder);
    result.error = paymentReviewNeeded(plan) ? '请先核对发票和付款并保存。助手会计算核定报销额。'
      : plan?.blockers?.[0] || '请先完成材料核对。';
  }
  return { ...result, draft, fields, amount, dirty: fields.some((field) => field.dirty), saving: savingMatches.has(key) };
}

function renderAllocation(folder) {
  if (projectsForFolder(folder).length < 2) return '';
  const allocation = allocationState(folder);
  const last = allocation.draft.at(-1);
  return `<form class="allocation-form" aria-label="经费分配">
    <div class="allocation-heading"><strong>经费分配</strong><div><span>发票合计 <b data-invoice-total>${money(allocation.amount.invoiceTotalCny)}</b></span><span>核定报销额 <b data-claim-total>${money(allocation.amount.totalCny)}</b></span></div></div>
    ${allocation.fields.map((project) => `<label class="allocation-row"><span>${escapeHtml(project.projectName)}<small>${escapeHtml(project.projectNo)}</small></span><input class="allocation-input" data-allocation-project="${escapeHtml(project.projectNo)}" inputmode="decimal" maxlength="18" aria-label="${escapeHtml(project.projectName)} 报销金额" value="${escapeHtml(project.value)}" placeholder="金额（元）" ${allocation.saving ? 'disabled' : ''}></label>`).join('')}
    <div class="allocation-row"><span>${escapeHtml(last.projectName)}<small>${escapeHtml(last.projectNo)} · 自动补齐</small></span><output class="allocation-remainder" aria-label="${escapeHtml(last.projectName)} 自动分配金额">${money(allocation.allocations?.at(-1).amountCny, '—')}</output></div>
    <div class="allocation-actions"><small class="allocation-status" role="status">${escapeHtml(allocationStatus(allocation))}</small><button class="secondary" type="submit" ${allocation.saving || allocation.error || !allocation.dirty ? 'disabled' : ''}>保存分配</button></div>
  </form>`;
}

function allocationStatus({ saving, error, dirty }) {
  if (saving) return '正在保存…';
  return error || (dirty ? '分配待保存' : '分配已保存');
}

function updateAllocationInPlace(folder, row = folderRow(folder)) {
  const form = row?.querySelector('.allocation-form');
  if (!form) return;
  const allocation = allocationState(folder);
  form.querySelector('[data-invoice-total]').textContent = money(allocation.amount.invoiceTotalCny);
  form.querySelector('[data-claim-total]').textContent = money(allocation.amount.totalCny);
  form.querySelector('.allocation-remainder').textContent = money(allocation.allocations?.at(-1).amountCny, '—');
  form.querySelector('.allocation-status').textContent = allocationStatus(allocation);
  form.querySelector('button').disabled = allocation.saving || Boolean(allocation.error) || !allocation.dirty;
  for (const input of form.querySelectorAll('.allocation-input')) input.disabled = allocation.saving;
}

function renderProjects() {
  const folder = state.activeFolder;
  const route = folder ? reimbursementRouteFor(folder) : '';
  const amount = folderAmount(folder);
  const matched = projectsForFolder(folder);
  const saving = savingMatches.has(projectMatchKey(state.sourceRoot, folder));
  const matchAction = saving ? '<small role="status">正在保存匹配…</small>' : matched.length
    ? '<button class="text-button" type="button" data-clear-match>取消匹配</button>' : '';
  $('matchTarget').innerHTML = folder
    ? `<small>当前匹配事项</small><strong>${escapeHtml(displayNameFor(folder))}</strong><span>${amount.label} ${amount.value}${matched.length ? ` · 已选 ${matched.length} 个项目` : ''}</span>${matchAction}`
    : '请在中间选择报销事项。';
  $('matchFunding').disabled = !folder || saving || Boolean(itemFor(folder)?.payroll);
  $('manualProjectForm').querySelector('button').disabled = !folder || saving;
  if (folder) {
    const config = configFor(folder);
    $('matchFunding').value = config.funding;
    if ($('manualMatch').dataset.folder !== folder) {
      $('manualProjectNo').value = '';
      $('manualProjectName').value = '';
      $('manualMatch').dataset.folder = folder;
    }
  }
  const keyword = $('projectFilter').value.trim().toLowerCase();
  const manual = matched.filter(({ projectNo }) => !state.projects.some((project) => project.projectNo === projectNo));
  const projects = [...state.projects, ...manual].filter((project) => `${project.projectName} ${project.projectNo} ${project.department || ''}`.toLowerCase().includes(keyword));
  const allocations = folder ? allocationState(folder).allocations : null;
  const list = $('projectRows');
  const scroll = list.scrollTop;
  list.innerHTML = projects.map((project) => {
    const current = matched.some((item) => item.projectNo === project.projectNo);
    const defaultSigner = state.projectSigners[projectNumberKey(project.projectNo)];
    const amountCny = allocations?.find((item) => item.projectNo === project.projectNo)?.amountCny ?? (!matched.length ? state.amounts.get(folder)?.totalCny : null);
    const difference = route === 'smart' && Number.isSafeInteger(amountCny) && Number.isSafeInteger(project.balanceCny)
      ? project.balanceCny - amountCny : null;
    return `<article class="project-match${current ? ' is-matched' : ''}">
      <div class="project-match-name"><strong>${escapeHtml(project.projectName || project.projectNo)}</strong><small>${escapeHtml(project.projectNo)}</small>${defaultSigner ? `<small>默认加签人 ${escapeHtml(defaultSigner.name)}</small>` : ''}</div>
      <div class="project-money">
        <div class="project-balance">可用金额 <span>${money(project.balanceCny, '待同步')}</span></div>
        <div class="project-labor">其中劳务费 <span>${money(project.laborBalanceCny, '待查询')}</span></div>
        ${Number.isSafeInteger(project.totalCny) ? `<div>项目总额 ${money(project.totalCny)}</div>` : ''}
      </div>
      ${difference !== null && difference < 0 ? `<small class="match-shortage">按已同步余额，差 ${money(-difference)}</small>` : ''}
      <div class="project-match-actions">
        <button class="secondary" type="button" data-match-project="${escapeHtml(project.projectNo)}" aria-pressed="${current}" aria-label="${current ? '移除' : '匹配'} ${escapeHtml(project.projectName || project.projectNo)}" ${!folder || saving ? 'disabled' : ''}>${current ? '移除' : singleProjectClaim(itemFor(folder)) && matched.length ? '改选' : '匹配'}</button>
        <button class="secondary" type="button" data-project-signer="${escapeHtml(project.projectNo)}" aria-label="设置加签人 ${escapeHtml(project.projectName || project.projectNo)}">加签人</button>
      </div>
    </article>`;
  }).join('') || '<p class="muted">没有符合条件的项目。可以同步学校项目，或手动匹配。</p>';
  list.scrollTop = scroll;
}

function updateSelectionCount() {
  const selected = selectedFolders();
  const count = selected.length;
  const ready = selected.filter((folder) => {
    const item = itemFor(folder);
    if (item?.payroll) return !item.payroll.blocker;
    if (item?.didi) return !item.didi.blocker && item.didi.signer !== null && cleanReason(reasonEntry(folder).text) === reasonEntry(folder).confirmed;
    const plan = state.plans.get(folder);
    return plan?.status === 'ready' && (plan.reimbursementRoute !== 'smart' || plan.signer !== null) &&
      plan.reason === cleanReason(reasonEntry(folder).text) && !allocationState(folder).dirty;
  }).length;
  $('selectionCount').textContent = count ? `已选 ${count} 个报销事项 · ${state.blockingRun ? '有一笔原任务待处理' : `${ready} 个可执行`}` : '勾选中间的报销事项后批量执行';
  $('mergeClaims').disabled = selected.filter((folder) => !singleProjectClaim(itemFor(folder))).length < 2;
}

function selectMatchTarget(row) {
  const folder = row.dataset.path;
  if (state.activeFolder === folder) return;
  const previous = folderRow(state.activeFolder);
  state.activeFolder = folder;
  previous?.classList.remove('is-current');
  previous?.querySelector('.match-row')?.setAttribute('aria-pressed', 'false');
  row.classList.add('is-current');
  row.querySelector('.match-row').setAttribute('aria-pressed', 'true');
  renderProjects();
  updateSourceActions();
}

function renderClaimSources(item) {
  if (!item.sourceFolders) return '';
  const sources = item.sourceFolders.map((source) => `<li>${escapeHtml(source)}${item.sourceFolders.length > 1 ? `<button class="text-button" type="button" data-remove-source="${escapeHtml(source)}">移出</button>` : ''}</li>`).join('');
  const undoing = dissolvingClaims.has(projectMatchKey(state.sourceRoot, item.path));
  return `<div class="claim-source-actions">
    <details class="claim-sources"><summary>${item.sourceFolders.length} 个来源文件夹 · 已保存</summary><ul>${sources}</ul></details>
    <button class="text-button" type="button" data-dissolve-claim ${undoing ? 'disabled' : ''}>撤销合并</button>
  </div>`;
}

function visiblePendingClaims(pending) {
  const routeFilter = $('claimRouteFilter').value;
  return pending.filter((item) => {
    const route = reimbursementRouteFor(item.path);
    const listRoute = route === 'review' || route === 'split' ? selectedClaimRoute(item.path) : route;
    return matchesClaimSearch(item) && (!routeFilter || (routeFilter === 'didi' ? item.didi : listRoute === routeFilter));
  });
}

function matchesClaimSearch(item) {
  const keyword = $('folderFilter').value.trim().toLowerCase();
  const searchable = `${item.label || ''} ${item.subject || ''} ${item.path} ${item.reasonDraft || ''} ${item.submission?.financeFormId || ''} ${(item.sourceFolders || []).join(' ')}`;
  return searchable.toLowerCase().includes(keyword);
}

function renderRows() {
  const pending = state.folders.filter((item) => !item.reimbursed);
  const folders = visiblePendingClaims(pending);
  const history = state.folders.filter((item) => item.reimbursed && matchesClaimSearch(item));
  if (!folders.some((item) => item.path === state.activeFolder)) state.activeFolder = folders[0]?.path || '';
  $('folderCount').textContent = `${pending.length} 个`;
  $('reimbursedHistory').hidden = !history.length;
  $('historyHeading').textContent = `${history.some((item) => item.submission?.appointment || item.submission?.payroll) ? '已办理' : '已报销'}（${history.length}）`;
  $('historyRows').innerHTML = history.map((item) => {
    const { submission } = item;
    const appointment = submission?.appointment ? `<small class="source-note">已预约待线下送审 · ${escapeHtml(submission.campus || '预约校区')} ${escapeHtml(submission.appointment)} · ${escapeHtml(submission.financeFormId)}</small>
      ${submission.pdfName ? `<a href="/api/runs/${escapeHtml(submission.runId)}/appointment-pdf" target="_blank" rel="noopener">查看报销单 PDF</a>` : ''}` : '';
    const payrollReceipt = submission?.payroll ? `<small class="source-note">${escapeHtml(submission.schoolStatus || '已申报')} · ${escapeHtml(submission.financeFormId)}</small>` : '';
    const didiReceipt = submission?.didi ? `<small class="source-note">${escapeHtml(submission.schoolStatus || '已提交')} · ${escapeHtml(submission.financeFormId)} · ${money(submission.totalCny)} · ${submission.invoiceCount} 张票据</small>` : '';
    const sources = item.sourceFolders?.length ? `<details><summary>${item.sourceFolders.length} 个来源 · ${escapeHtml(submission?.financeFormId || '')}</summary>
      <ul>${item.sourceFolders.map((folder) => `<li>${escapeHtml(folder)}</li>`).join('')}</ul>
      ${submission?.allocations?.length ? `<ul aria-label="经费分配">${submission.allocations.map(({ projectName, amountCny }) => `<li>${escapeHtml(projectName)} · ${money(amountCny)}</li>`).join('')}</ul>` : ''}</details>` : '';
    const label = escapeHtml(item.label || item.path);
    const withdrawal = item.withdrawalRunId ? ` <button class="text-button" type="button" data-withdraw-run="${escapeHtml(item.withdrawalRunId)}" data-claim-label="${label}">撤回报销</button>` : '';
    return `<li>${label}${withdrawal}${appointment}${payrollReceipt}${didiReceipt}${sources}</li>`;
  }).join('');
  const list = $('folderRows');
  const scroll = list.scrollTop;
  const editing = document.activeElement?.matches('.folder-reason-input, .allocation-input') ? document.activeElement : null;
  const editingFolder = editing?.closest('.folder-row')?.dataset.path;
  const selection = editing ? [editing.selectionStart, editing.selectionEnd] : null;
  list.innerHTML = folders.map((item) => {
    const folder = item.path;
    const label = escapeHtml(item.label || folder);
    if (item.payroll) return `<article class="folder-row payroll-row${folder === state.activeFolder ? ' is-current' : ''}" data-path="${escapeHtml(folder)}">
      <input class="row-select" type="checkbox" aria-label="执行申报 ${label}" ${state.selected.has(folder) ? 'checked' : ''}>
      <div class="folder-label"><strong class="folder-name">${label}</strong>
      <div class="folder-meta"><span>${escapeHtml(item.payroll.category)}</span><span>${item.payroll.peopleCount} 条明细</span>${item.payroll.signerName ? `<span>加签 ${escapeHtml(item.payroll.signerName)}</span>` : ''}</div>
      <small class="folder-project">${escapeHtml(item.match?.projectName || '')}</small>
      ${item.payroll.blocker ? `<small class="source-note">${escapeHtml(item.payroll.blocker)}</small>` : ''}</div>
      <div class="folder-figure"><strong class="folder-amount">${money(item.payroll.totalCny)}</strong><small>应发合计</small></div>
      <div class="folder-actions">
        <button type="button" class="secondary match-row" aria-label="匹配经费 ${label}" aria-pressed="${folder === state.activeFolder}">匹配经费</button>
        <button type="button" class="secondary edit-payroll">修改申报</button>
      </div>
    </article>`;
    const status = rowStatusFor(folder);
    const plan = state.plans.get(folder);
    const projects = projectsForFolder(folder);
    const current = folder === state.activeFolder;
    const amount = folderAmount(folder);
    const routeLabel = ROUTE_LABELS[reimbursementRouteFor(folder)] || '';
    const routeEdit = item.groupId && !item.didi && !['劳务费', '差旅'].includes(plan?.subject || configFor(folder).subject);
    const routeControl = routeEdit
      ? `<button type="button" class="text-button folder-route" data-edit-claim-route aria-label="更改办理方式 ${label}">${routeLabel}</button>`
      : `<span class="folder-route">${routeLabel}</span>`;
    const selectable = canSelectForExecution(folder);
    return `<article class="folder-row${current ? ' is-current' : ''}" data-path="${escapeHtml(folder)}">
      <input class="row-select" type="checkbox" aria-label="执行 ${label}" title="${selectable ? '勾选以加入报销批次' : '请按此事项的办理系统处理'}" ${selectable ? '' : 'disabled'} ${state.selected.has(folder) && selectable ? 'checked' : ''}>
      <div class="folder-label">
        <strong class="folder-name">${label}</strong>
        <div class="folder-meta"><span>${item.didi ? '滴滴票夹' : `${item.fileCount} 个文件`}</span>${routeControl}<span class="row-state ${status.type}">${escapeHtml(status.text)}</span></div>
        ${projects.length ? `<small class="folder-project">已保存 · ${projects.length === 1 ? escapeHtml(projects[0].projectName) : `${projects.length} 个经费项目`}</small>` : ''}
      </div>
      <div class="folder-figure"><strong class="folder-amount">${amount.value}</strong><small class="folder-amount-label">${amount.label}</small></div>
      <div class="folder-actions">
        <button class="secondary match-row" type="button" aria-label="匹配经费 ${label}" aria-pressed="${current}">匹配经费</button>
        ${item.didi ? '<button class="secondary" type="button" data-edit-didi>详情</button><button class="text-button" type="button" data-remove-didi>移除</button>'
          : `<button class="secondary detail-row" type="button" ${plan ? '' : 'disabled'}>${paymentReviewNeeded(plan) ? '核对发票和付款' : '详情'}</button>`}
      </div>
      ${item.didi ? '' : renderClaimSources(item)}
      ${renderReasonForm(folder)}
      ${renderAllocation(folder)}
    </article>`;
  }).join('') || (pending.length ? '<p class="muted">没有符合筛选条件的事项。</p>' : '<p class="muted">先在左侧勾选文件夹，合并为一个报销事项。</p>');
  list.scrollTop = scroll;
  if (editingFolder) {
    const row = folderRow(editingFolder);
    const input = editing.dataset.allocationProject
      ? [...(row?.querySelectorAll('.allocation-input') || [])].find((item) => item.dataset.allocationProject === editing.dataset.allocationProject)
      : row?.querySelector('.folder-reason-input');
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(...selection);
  }
  renderProjects();
  renderSources();
  updateSelectionCount();
}

function invalidatePlan(folder, update) {
  const config = configFor(folder);
  update(config);
  config.version += 1;
  state.plans.delete(folder);
  if (state.detailFolder === folder) closeDetails();
  persistConfigs();
  setRowStatus(folder, 'queued', '待核对');
  renderRows();
  return prepareFolder(folder);
}

function matchProject(project, remove = false) {
  const folder = state.activeFolder;
  if (!folder) return;
  const { funding } = configFor(folder);
  if (singleProjectClaim(itemFor(folder))) {
    return saveProjectMatch(folder, remove ? null : { projectNo: project.projectNo, projectName: project.projectName, funding });
  }
  const current = allocationState(folder).draft;
  if (!remove && current.some((item) => item.projectNo === project.projectNo)) return;
  const selected = remove ? current.filter((item) => item.projectNo !== project.projectNo) : [...current, { projectNo: project.projectNo, projectName: project.projectName }];
  if (!selected.length) return saveProjectMatch(folder, null);
  if (selected.length === 1) {
    const { projectNo, projectName } = selected[0];
    return saveProjectMatch(folder, { projectNo, projectName, funding });
  }
  const allocations = selected.map((item, index) => ({ ...item, amountCny: index === selected.length - 1 ? null : item.amountCny ?? null }));
  return saveProjectMatch(folder, { funding, allocations });
}

async function saveProjectMatch(folder, match) {
  const sourceRoot = state.sourceRoot;
  const key = projectMatchKey(sourceRoot, folder);
  if (savingMatches.has(key)) return;
  savingMatches.add(key);
  renderProjects();
  updateAllocationInPlace(folder);
  try {
    const saved = await writeProjectMatch(sourceRoot, folder, match);
    if (sourceRoot !== state.sourceRoot || !itemFor(folder)) return;
    if (!saved) state.selected.delete(folder);
    allocationEdits.delete(key);
    const details = $('executionDetails');
    if (details.dataset.folder === folder && details.dataset.allocation === 'true') $('executionFeedback').hidden = true;
    $('manualMatch').dataset.folder = '';
    if (singleProjectClaim(itemFor(folder))) {
      applyProjectMatch(configFor(folder), saved);
      itemFor(folder).match = saved;
      await refreshSavedClaim(folder, '经费匹配已保存。', false);
    }
    else await invalidatePlan(folder, (config) => applyProjectMatch(config, saved));
    return true;
  } catch (error) {
    setWorklistStatus(`未能保存项目匹配：${error.message}`);
  } finally {
    savingMatches.delete(key);
    renderProjects();
    updateAllocationInPlace(folder);
  }
}

async function prepareFolder(folder) {
  const item = itemFor(folder);
  if (!item || item.reimbursed || singleProjectClaim(item)) return false;
  const generation = state.configurationGeneration;
  const config = configFor(folder);
  const version = config.version;
  const previous = checkTasks.get(folder);
  if (previous?.version === version && previous.generation === generation) return previous.promise;
  const project = projectForFolder(folder);
  const entry = { version, generation, promise: null };
  entry.promise = (async () => {
    setRowStatus(folder, 'running', '核对中');
    updateRowInPlace(folder);
    try {
      const result = await api('/api/plans', {
        method: 'POST',
        body: JSON.stringify({
          sourceRoot: state.sourceRoot, folder, subject: config.subject, funding: config.funding, project,
          travelProfile: config.subject === '差旅' ? { role: config.travelRole, fundType: config.travelFundType } : undefined,
        }),
      });
      if (config.version !== version || generation !== state.configurationGeneration) return false;
      const plan = result.plan;
      const matchUpdated = Object.hasOwn(result, 'match') && JSON.stringify(config.match) !== JSON.stringify(result.match);
      if (matchUpdated) {
        applyProjectMatch(config, result.match);
        if (!result.match) state.selected.delete(folder);
      }
      storeCheckedPlan(plan);
      if (matchUpdated || $('claimRouteFilter').value) renderRows();
      else {
        updateRowInPlace(folder);
        if (plan.sourceFolders?.length) renderSources();
      }
      return plan.status === 'ready';
    } catch (error) {
      if (config.version === version && generation === state.configurationGeneration) {
        setRowStatus(folder, 'error', '检查失败');
        setWorklistStatus(`“${displayNameFor(folder)}”检查失败：${error.message}`);
        updateRowInPlace(folder);
      }
      return false;
    }
  })();
  checkTasks.set(folder, entry);
  try {
    return await entry.promise;
  } finally {
    if (checkTasks.get(folder) === entry) checkTasks.delete(folder);
  }
}

function selectedFolders() {
  return state.folders.filter((item) => !item.reimbursed && state.selected.has(item.path) && canSelectForExecution(item.path)).map((item) => item.path);
}

async function checkSelected() {
  const folders = selectedFolders().filter((folder) => !singleProjectClaim(itemFor(folder)));
  if (!folders.length) {
    setWorklistStatus('请先勾选要重新检查的文件夹。');
    return;
  }
  let succeeded = 0;
  let failed = 0;
  for (const folder of folders) {
    if (await prepareFolder(folder)) succeeded += 1;
    else failed += 1;
  }
  setWorklistStatus(`选中文件夹检查完成：成功 ${succeeded} 个，失败 ${failed} 个。`);
}

async function autoCheckAll() {
  if (state.demoMode) return;
  const generation = state.configurationGeneration;
  if (state.autoChecking?.generation === generation) return state.autoChecking.promise;
  const previous = state.autoChecking;
  const task = { generation, promise: null };
  state.autoChecking = task;
  task.promise = (async () => {
    await previous?.promise;
    if (generation !== state.configurationGeneration) return;
    await checkWorklist(generation);
  })();
  try { await task.promise; }
  finally { if (state.autoChecking === task) state.autoChecking = null; }
}

async function checkWorklist(generation) {
  setWorklistStatus('正在核对来源材料和报销事项。可同时合并文件夹、填写事由和匹配经费。');
  const keyword = $('sourceFilter').value.trim().toLowerCase();
  const sources = state.sourceFolders.filter((item) => !item.reimbursed && !state.sourceAmounts.has(item.path) &&
    !(item.claimKey && configFor(item.claimKey).subject === '劳务费'));
  if (keyword) sources.sort((a, b) => Number(b.path.toLowerCase().includes(keyword)) - Number(a.path.toLowerCase().includes(keyword)));
  for (const item of sources) {
    if (generation !== state.configurationGeneration) return;
    await prepareSource(item, generation);
  }
  for (const { path } of state.folders.filter((item) => !item.reimbursed && !singleProjectClaim(item))) {
    if (generation !== state.configurationGeneration) return;
    await prepareFolder(path);
  }
  if (generation === state.configurationGeneration) {
    const failed = [...state.sourceAmounts.values()].filter((amount) => amount.error).length + [...state.rowStatus.values()].filter(({ type }) => type === 'error').length;
    setWorklistStatus(failed ? `${failed} 个文件夹或事项检查失败，请查看各行提示。`
      : '事项核对完成。保存事由并匹配经费后，可勾选批量执行。');
  }
}

function showExecutionFeedback(message, { blocked = true, folder = '', focusReason = false, allocation = false, openRun = false, reveal = true } = {}) {
  const feedback = $('executionFeedback');
  const details = $('executionDetails');
  $('executionStatus').textContent = message;
  feedback.classList.toggle('is-blocked', blocked);
  feedback.hidden = false;
  details.dataset.folder = folder;
  details.dataset.openRun = String(openRun);
  details.dataset.allocation = String(allocation);
  details.textContent = openRun ? '查看执行进度' : allocation ? '查看分配'
    : paymentReviewNeeded(state.plans.get(folder)) ? '核对发票和付款' : '查看详情';
  details.hidden = !openRun && !allocation && !state.plans.has(folder) && !itemFor(folder)?.didi;
  if (!blocked || !reveal) return;
  feedback.scrollIntoView({ block: 'nearest' });
  if (!focusReason) return;
  const input = folderRow(folder)?.querySelector('.folder-reason-input');
  if (!input) return;
  const entry = reasonEntry(folder);
  entry.error ||= '请先保存或更新本笔事由。';
  updateReasonInPlace(folder);
  input.focus();
}

async function executeSelected() {
  if (state.executing) return;
  if (state.batch && ['queued', 'running'].includes(state.batch.status)) {
    setRunDrawer(true);
    showExecutionFeedback('已有批次在执行，进度见“执行与互动”。', { blocked: false });
    return;
  }
  const selected = selectedFolders();
  if (state.blockingRun) {
    const run = state.blockingRun;
    const resumeSelected = selected.includes(run.plan.folder) && run.canResumePreview && !otherRunYear(run);
    showExecutionFeedback(resumeSelected ? '这笔事项已有原草稿。请从「执行与互动」继续原草稿。' : blockingRunText(run),
      { openRun: true });
    if (resumeSelected) setRunDrawer(true);
    return;
  }
  const direct = selected.map(itemFor).filter(singleProjectClaim);
  const folders = selected.filter((folder) => !singleProjectClaim(itemFor(folder)));
  if (selected.some((folder) => savingMatches.has(projectMatchKey(state.sourceRoot, folder)))) {
    showExecutionFeedback('正在保存所选文件夹的经费匹配，请稍后再执行。');
    return;
  }
  if (!selected.length) {
    showExecutionFeedback('请先勾选要执行的事项。');
    return;
  }
  const incomplete = direct.find((item) => (item.payroll || item.didi).blocker ||
    item.didi && cleanReason(reasonEntry(item.path).text) !== reasonEntry(item.path).confirmed);
  if (incomplete) {
    showExecutionFeedback(`${incomplete.label} · ${(incomplete.payroll || incomplete.didi).blocker || '请先保存或更新用车事由'}`, { folder: incomplete.path, focusReason: Boolean(incomplete.didi && incomplete.match) });
    return;
  }
  const unsignedDidi = direct.find((item) => item.didi?.signer === null);
  if (unsignedDidi) {
    showExecutionFeedback(`${unsignedDidi.label} · 请在项目设置默认加签人，或在详情填写本笔加签人。`, { folder: unsignedDidi.path });
    return;
  }
  const missing = folders.filter((folder) => !state.plans.has(folder));
  if (missing.length) {
    showExecutionFeedback(`尚未启动。以下事项需要先检查材料。\n${missing.map(displayNameFor).join('、')}`);
    return;
  }
  const pendingAmounts = folders.filter((folder) => {
    const plan = state.plans.get(folder);
    return paymentReviewNeeded(plan) || (plan.status !== 'ready' && !Number.isSafeInteger(plan.totalCny));
  });
  if (pendingAmounts.length) {
    const messages = pendingAmounts.map((folder) => {
      const plan = state.plans.get(folder);
      return `${displayNameFor(folder)} · ${plan.blockers?.[0] || '请查看金额核对结果'}`;
    });
    showExecutionFeedback(`尚未启动。请先核对以下事项的材料和金额。\n${messages.join('\n')}`, { folder: pendingAmounts[0] });
    return;
  }
  const unmatched = folders.filter((folder) => !projectForFolder(folder));
  if (unmatched.length) {
    showExecutionFeedback(`请先为以下报销事项匹配经费项目。\n${unmatched.map(displayNameFor).join('、')}`, { folder: unmatched[0] });
    return;
  }
  const unallocated = folders.filter((folder) => {
    if (projectsForFolder(folder).length < 2) return false;
    const allocation = allocationState(folder);
    return allocation.error || allocation.dirty;
  });
  if (unallocated.length) {
    const messages = unallocated.map((folder) => `${displayNameFor(folder)} · ${allocationState(folder).error || '请先保存经费分配'}`);
    showExecutionFeedback(`请先完成中栏的经费分配。\n${messages.join('\n')}`, { folder: unallocated[0], allocation: true });
    return;
  }
  const editedReasons = folders.filter((folder) => {
    const { reason } = state.plans.get(folder);
    return !reason || cleanReason(reasonEntry(folder).text) !== reason;
  });
  if (editedReasons.length) {
    const messages = editedReasons.map((folder) => [folder, reasonEntry(folder).error].filter(Boolean).join(' · '));
    showExecutionFeedback(`尚未启动。请先保存或更新以下文件夹的报销事由。\n${messages.join('\n')}`, { folder: editedReasons[0], focusReason: true });
    return;
  }
  const blocked = folders.filter((folder) => state.plans.get(folder).status !== 'ready');
  if (blocked.length) {
    const messages = blocked.map((folder) => `${displayNameFor(folder)} · ${state.plans.get(folder).blockers?.[0] || '请查看核对结果'}`);
    showExecutionFeedback(`尚未启动。请先处理以下问题。\n${messages.join('\n')}`, { folder: blocked[0] });
    return;
  }
  const plans = folders.map((folder) => state.plans.get(folder));
  const unsigned = plans.find((plan) => plan.reimbursementRoute === 'smart' && plan.signer === null);
  if (unsigned) {
    const message = unsigned.signerDefaultSource === 'conflict' ? '所选经费项目的默认加签人不同，请在详情指定本笔加签人。'
      : '请在项目设置默认加签人，或在详情填写本笔加签人。';
    showExecutionFeedback(`${displayNameFor(unsigned.folder)} · ${message}`, { folder: unsigned.folder });
    return;
  }
  const reminderLines = plans.flatMap((plan) => (plan.warnings || []).map((warning) => `${plan.displayName || displayNameFor(plan.folder)} · ${warning}`));
  const reminderText = reminderLines.length ? `\n本批核对提醒\n${reminderLines.join('\n')}` : '';
  const reminderFolder = plans.find((plan) => plan.warnings?.length)?.folder;
  state.executing = true;
  $('executeSelected').disabled = true;
  showExecutionFeedback(`正在核对并启动所选批次…${reminderText}`, { blocked: false, folder: reminderFolder });
  try {
    const payload = direct.length ? { entries: selected.map((folder) => {
      const item = itemFor(folder);
      if (item?.didi) return { didiId: item.groupId, revision: item.didi.revision };
      return item?.payroll ? { payrollId: item.groupId, revision: item.payroll.revision } : { planId: state.plans.get(folder).id };
    }) } : { planIds: plans.map((plan) => plan.id) };
    const result = await api('/api/batch-runs', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.batch = result.batch;
    state.run = null;
    setRunDrawer(true);
    showExecutionFeedback(`批次已启动，共 ${result.batch.runs.length} 笔。请在「执行与互动」核对并逐笔确认提交。${reminderText}`, { blocked: false, folder: reminderFolder });
    renderRun();
  } catch (error) {
    if (/已失效/.test(error.message)) {
      showExecutionFeedback('计划已失效，正在重新检查选中文件夹…', { blocked: false });
      let recovered = 0;
      for (const folder of folders) {
        state.plans.delete(folder);
        updateRowInPlace(folder);
        if (await prepareFolder(folder)) recovered += 1;
      }
      if (recovered === folders.length && folders.length) {
        state.executing = false;
        $('executeSelected').disabled = false;
        return executeSelected();
      }
      const failed = folders.find((folder) => state.plans.get(folder)?.status !== 'ready');
      showExecutionFeedback(`重新检查完成 ${recovered}/${folders.length} 个。请查看尚未通过的文件夹。`, { folder: failed });
    } else {
      showExecutionFeedback(`批次启动失败。${error.message}`, { openRun: /草稿|财务浏览器|原单/.test(error.message) });
    }
  } finally {
    state.executing = false;
    $('executeSelected').disabled = false;
  }
}

const runStatusLabels = { queued: '排队中', running: '执行中', waiting_input: '等待你的回复', pausing: '将在当前步骤后暂停', error: '执行暂停', completed: '已提交', preview: '已停在提交前', idle: '尚未执行', verification_required: '结果待核实', stopped: '已停止排队', abandoned: '已结束草稿' };
const batchStatusLabels = { queued: '排队中', running: '执行中', paused: '等待继续', completed: '已完成', completed_with_errors: '已完成但有失败', error: '失败', preview: '停在提交前', verification_required: '结果待核实', interrupted: '重启后已停止', abandoned: '草稿已结束' };
const waitingForCampusLogin = (run) => run.status === 'running' && run.waitingForCampusLogin;
const runStatusLabel = (run) => {
  if (waitingForCampusLogin(run)) return '等待校园网登录';
  if (run.appointment) return run.appointment.pdfName ? '已预约 · PDF 已保存' : '已预约 · 待保存 PDF';
  if (run.payrollReceipt) return run.payrollReceipt.schoolStatus || '已申报';
  if (run.result === 'payroll_header_ready') return '已填入学校抬头';
  if (run.status === 'running' && run.schoolStep) return run.schoolStep;
  return runStatusLabels[run.status] || run.status;
};

function runReference(run) {
  const label = run.plan.displayName || run.plan.folder;
  const number = run.payrollReceipt?.financeFormId || run.appointment?.financeFormId || run.schoolDraftNo;
  return number ? `${label} · 学校单号 ${number}` : label;
}

function otherRunYear(run) {
  return run?.year && state.workspace && run.year !== state.workspace.year ? run.year : null;
}

function blockingRunText(run) {
  const year = otherRunYear(run);
  const next = year ? `请切回 ${year} 年度处理原任务。`
    : run.canResumePreview ? '可查看并继续原草稿。作废或删除原草稿后，也可登记结束。'
    : '请查看原任务，核对学校原单状态。';
  return `当前有一笔任务待处理 · ${runReference(run)} · ${runStatusLabel(run)}。${next}`;
}

function executionError(value) {
  return String(value || '').replace(/\x1b\[[\d;]*m/g, '').replace(/\s*Call log:[\s\S]*$/, '').trim();
}

function currentRun() {
  if (state.batch) {
    return state.batch.runs.find((run) => run.id === state.batch.currentRunId)
      || state.batch.runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status))
      || state.batch.runs.at(-1)
      || null;
  }
  return state.run;
}

function canRecordSubmission(run) {
  return run?.canEndDraft && run.plan.reimbursementRoute === 'smart' && !run.plan.didi && !run.plan.payrollRevision;
}

function renderRun() {
  const run = currentRun();
  const year = otherRunYear(run);
  $('submissionActions').hidden = Boolean(year) || run?.pendingKind !== 'final_approval';
  $('draftActions').hidden = Boolean(year) || (!run?.canResumePreview && !run?.canEndDraft);
  $('resumeDraft').hidden = !run?.canResumePreview;
  $('endDraft').hidden = !run?.canEndDraft;
  $('recordSubmission').hidden = !canRecordSubmission(run);
  $('replyForm').hidden = Boolean(year);
  if ($('draftActionStatus').dataset.runId !== run?.id) $('draftActionStatus').hidden = true;
  if (!run) {
    $('runStatus').className = 'run-status idle';
    $('runStatus').textContent = '尚未执行';
    $('batchQueue').innerHTML = '';
    $('timeline').innerHTML = '';
    $('messages').innerHTML = '<div class="empty-chat">启动批次后，这里会显示执行问题；你也可以随时发指令。</div>';
    return;
  }
  const waitingLogin = waitingForCampusLogin(run);
  $('runStatus').className = `run-status ${waitingLogin ? 'waiting_input' : run.status}`;
  const started = new Date(state.batch?.createdAt || run.createdAt);
  const time = Number.isFinite(started.getTime()) ? started.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const batchStatus = state.batch?.status === 'error' && state.batch.runs.every((item) => item.status === 'completed')
    ? 'completed' : state.batch?.status;
  const batchText = state.batch
    ? `批次${batchStatusLabels[batchStatus] || batchStatus} · 第 ${Math.min((state.batch.currentIndex ?? 0) + 1, state.batch.runs.length)}/${state.batch.runs.length} 笔 · `
    : '';
  const error = executionError(run.error);
  $('runStatus').textContent = `${batchText}${time ? `${time} 启动 · ` : ''}${runStatusLabel(run)} · ${runReference(run)}${error ? ` · ${error}` : ''}`;
  $('batchQueue').innerHTML = state.batch ? state.batch.runs.map((item, index) => {
    const amount = item.plan.didi && item.plan.totalCny == null ? `预算 ${money(item.plan.didi.budgetCny)}` : money(item.plan.totalCny);
    return `<div class="queue-item ${item.id === run.id ? 'active' : ''} ${item.status}"><span>${index + 1}. ${escapeHtml(item.plan.displayName || item.plan.folder)} · ${amount}</span><span>${escapeHtml(runStatusLabel(item))}</span></div>`;
  }).join('') : '';
  $('timeline').innerHTML = run.events.slice(-14).reverse().map((event) => `<div class="event"><time>${new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><span>${escapeHtml(event.step)}${event.detail ? ` · ${escapeHtml(event.detail)}` : ''}</span></div>`).join('');
  $('messages').innerHTML = run.messages.length ? run.messages.map((message) => `<div class="message ${message.role}">${escapeHtml(message.text)}</div>`).join('') : '<div class="empty-chat">执行已经开始，等待网页反馈。</div>';
  if (year) $('messages').insertAdjacentHTML('beforeend', `<div class="empty-chat">请切回 ${escapeHtml(year)} 年度处理原任务。</div>`);
  if (run.pendingChoices?.length) $('messages').insertAdjacentHTML('beforeend', `<div class="payroll-choices">${run.pendingChoices.map(({ value, label }) =>
    `<button type="button" class="secondary" data-run-choice="${escapeHtml(value)}">${escapeHtml(value + '. ' + label)}</button>`).join('')}</div>`);
  if (run.appointment?.pdfName) $('messages').insertAdjacentHTML('beforeend', `<a href="/api/runs/${escapeHtml(run.id)}/appointment-pdf" target="_blank" rel="noopener">查看报销单 PDF</a>`);
  $('messages').scrollTop = $('messages').scrollHeight;
  $('replyInput').placeholder = waitingLogin ? '请在报销专用 Chrome 登录，登录后自动继续'
    : batchStatus === 'paused' ? '回复「继续」接续本批次剩余报销'
    : run.pendingQuestion ? '回复当前问题；也可输入“暂停”或“先别提交”' : '暂停、继续、重试、别提交，或询问执行状态';
  const needsAttention = waitingLogin || batchStatus === 'paused' || ['waiting_input', 'error', 'pausing', 'verification_required', 'preview'].includes(run.status);
  $('runBadge').hidden = !needsAttention || !$('runDrawer').hidden;
}

async function sendRunMessage(message) {
  const run = currentRun();
  if (!message || state.sending) return;
  if (!run) {
    alert('请先启动一个批次，再向执行区发送指令。');
    return;
  }
  state.sending = true;
  $('replyButton').disabled = true;
  try {
    const result = await api(`/api/runs/${run.id}/instructions`, { method: 'POST', body: JSON.stringify({ message }) });
    if (result.batch && result.batch.id === state.batch?.id) {
      state.batch = result.batch;
    } else if (state.batch) {
      const index = state.batch.runs.findIndex((item) => item.id === result.run.id);
      if (index >= 0) state.batch.runs[index] = result.run;
    } else {
      state.run = result.run;
    }
    $('replyInput').value = '';
    renderRun();
  } catch (error) {
    alert(error.message);
  } finally {
    state.sending = false;
    $('replyButton').disabled = false;
  }
}

async function updateOriginalDraft(action) {
  const run = currentRun();
  if (!run || otherRunYear(run)) return;
  const resume = action === 'resume';
  const submitted = action === 'submitted';
  if (!(resume ? run.canResumePreview : submitted ? canRecordSubmission(run) : run.canEndDraft)) return;
  const status = $('draftActionStatus');
  if ($('resumeDraft').disabled) return;
  if (action === 'abandon_draft' && !window.confirm('请确认你已在学校系统作废或删除了这张草稿，并核实从未提交。登记后可开始其他事项。')) return;
  const financeFormId = submitted ? window.prompt(`请核对「${runReference(run)}」已在学校提交，并填入该笔回执上的学校报销单号。`)?.trim() : undefined;
  if (submitted && !financeFormId) return;
  status.dataset.runId = run.id;
  status.hidden = false;
  status.textContent = resume ? '正在接回原草稿…' : '正在保存核实结果…';
  $('resumeDraft').disabled = $('endDraft').disabled = $('recordSubmission').disabled = true;
  try {
    const result = resume
      ? await api(`/api/runs/${run.id}/instructions`, { method: 'POST', body: JSON.stringify({ message: '继续' }) })
      : await api(`/api/runs/${run.id}/resolution`, { method: 'POST', body: JSON.stringify({ confirmed: true, resolution: action, financeFormId }) });
    if (!submitted) {
      if (result.batch) state.batch = result.batch;
      if (state.batch) {
        const index = state.batch.runs.findIndex(({ id }) => id === run.id);
        if (index >= 0) state.batch.runs[index] = result.run;
      } else state.run = result.run;
    }
    status.textContent = resume ? '原任务已恢复，进度见上方。' : submitted
      ? '学校回执已登记。' : '已登记原草稿作废。可返回工作清单移除事项或开始新批次。';
    $('executionFeedback').hidden = true;
    await refreshExecution();
  } catch (error) {
    status.textContent = `未能${resume ? '接回原草稿' : '登记'}。${error.message}`;
  } finally {
    $('resumeDraft').disabled = $('endDraft').disabled = $('recordSubmission').disabled = false;
  }
}

async function refreshFolders(options) {
  const result = await api('/api/folders', options);
  const { sourceRoot } = result;
  const generation = ++state.configurationGeneration;
  if (state.sourceRoot !== sourceRoot) {
    state.sourceRoot = sourceRoot;
    state.configs.clear();
    state.selected.clear();
    state.activeFolder = '';
    state.selectedSources.clear();
    state.sourceNotice = '';
    state.sourceAmounts.clear();
  }
  state.plans.clear();
  state.amounts.clear();
  state.rowStatus.clear();
  state.sourceFolders = result.folders;
  $('receiptDirectory').textContent = sourceRoot;
  $('editReceiptDirectory').hidden = !state.workspace || state.workspace.example;
  state.payrollCategories = result.payrollCategories || [];
  state.payrollPositions = result.payrollPositions || [];
  state.payrollExpenseItems = result.payrollExpenseItems || [];
  state.payrollSignerNames = result.payrollSignerNames || {};
  applySignerRoster(result);
  renderSchoolFinanceEntry();
  state.folders = (result.claims || []).sort((a, b) => (a.label || a.path).localeCompare(b.label || b.path, 'zh-CN'));
  state.selectedSources = new Set([...state.selectedSources].filter((path) => state.sourceFolders.some((item) => item.path === path && !item.reimbursed && !item.claimKey)));
  const pending = state.folders.filter((item) => !item.reimbursed);
  const paths = new Set(pending.map((item) => item.path));
  state.selected = new Set([...state.selected].filter((folder) => paths.has(folder)));
  if (state.detailFolder) closeDetails();
  await Promise.all(pending.map(async (item) => {
    if (item.payroll) {
      if (!savingMatches.has(projectMatchKey(sourceRoot, item.path))) applyProjectMatch(configFor(item.path), item.match ?? null);
      return;
    }
    const entry = reasonEntry(item.path);
    entry.sourceFolders = item.sourceFolders;
    if (!entry.pending && cleanReason(entry.text) === entry.saved) entry.text = entry.saved = item.reasonDraft || '';
    if (item.didi) entry.confirmed = item.didi.blocker ? '' : item.reasonDraft;
    entry.hasSaved ||= item.reasonSaved === true;
    const key = projectMatchKey(sourceRoot, item.path);
    if (savingMatches.has(key)) return;
    let match = item.match;
    if (match === undefined && sourceRoot === state.defaultSourceRoot) {
      const legacy = legacyProjectMatch(item.path);
      if (legacy) {
        try {
          match = await writeProjectMatch(sourceRoot, item.path, legacy, true);
        } catch (error) {
          setWorklistStatus(`旧版项目匹配导入失败：${error.message}`);
        }
      }
    }
    if (generation !== state.configurationGeneration || savingMatches.has(key)) return;
    applyProjectMatch(configFor(item.path), match ?? null);
    if (!match) state.selected.delete(item.path);
  }));
  if (generation !== state.configurationGeneration) return;
  $('manualMatch').dataset.folder = '';
  renderRows();
}

async function refreshExecution() {
  try {
    const previous = currentRun();
    const [batchResult, runResult] = await Promise.all([api('/api/batches'), api('/api/runs')]);
    const orderedRuns = [...runResult.runs].reverse().sort((a, b) =>
      (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    const completedRunIds = orderedRuns.filter(({ status }) => status === 'completed').map(({ id }) => id).sort().join(',');
    if (state.completedRunIds !== null && state.completedRunIds !== completedRunIds) loadFundingSummary();
    state.completedRunIds = completedRunIds;
    const blocking = orderedRuns.find(({ id }) => id === runResult.blockingRunId) || null;
    const previousBlocker = state.blockingRun;
    state.blockingRun = blocking;
    $('blockingRunNotice').hidden = !blocking;
    if (blocking) $('blockingRunMessage').textContent = blockingRunText(blocking);
    if (previousBlocker?.id !== blocking?.id || previousBlocker?.status !== blocking?.status) {
      const changed = [...new Set([previousBlocker?.plan.folder, blocking?.plan.folder])].filter(Boolean);
      for (const folder of changed) {
        if (folderRow(folder)?.querySelector('.row-state')) updateRowInPlace(folder);
      }
      updateSelectionCount();
      if (!blocking && $('executionDetails').dataset.openRun === 'true') $('executionFeedback').hidden = true;
    }
    const actionable = blocking || orderedRuns.find((run) => ACTIVE_RUN_STATUSES.has(run.status) || ['preview', 'verification_required'].includes(run.status));
    const selected = actionable || orderedRuns[0] || null;
    const matchedBatch = selected ? [...batchResult.batches].reverse().find((batch) => batch.runs.some((run) => run.id === selected.id)) : batchResult.batches.at(-1);
    state.batch = matchedBatch ? { ...matchedBatch, currentRunId: actionable?.id || matchedBatch.currentRunId } : null;
    state.run = state.batch ? null : selected;
    const next = currentRun();
    if (next && (previous?.id !== next.id || previous.status !== next.status)) {
      if (['error', 'verification_required', 'waiting_input'].includes(next.status)) {
        const issue = executionError(next.error) || next.pendingQuestion || runStatusLabels[next.status];
        showExecutionFeedback(`${runReference(next)} · ${issue}`, { openRun: true, reveal: false });
      } else if (previous && ['error', 'verification_required', 'waiting_input'].includes(previous.status) && ACTIVE_RUN_STATUSES.has(next.status)) {
        showExecutionFeedback(`${runReference(next)} · ${runStatusLabel(next)}`, { blocked: false, openRun: true });
      }
    }
    if (previous && next && previous.id === next.id && previous.status !== 'completed' && next.status === 'completed') {
      await refreshFolders();
      autoCheckAll();
    }
    renderRun();
  } catch {}
}

async function checkCampusLogin() {
  const status = $('loginStatus');
  status.hidden = false;
  status.className = 'login-status';
  status.textContent = '正在检查报销专用 Chrome 的学校登录状态。';
  $('checkLogin').disabled = true;
  try {
    const result = await api('/api/login-status');
    status.className = `login-status ${result.loggedIn ? 'ok' : 'warning'}`;
    status.textContent = result.message;
  } catch (error) {
    status.className = 'login-status error';
    status.textContent = error.message;
  } finally {
    $('checkLogin').disabled = false;
  }
}

async function loadProjects() {
  try {
    const result = await api('/api/projects');
    state.projects = result.projects || [];
    state.projectSigners = result.projectSigners || {};
    state.projectSyncedAt = result.syncedAt || null;
    updateProjectStatus(savedProjectStatus());
  } catch (error) {
    updateProjectStatus(`读取本地项目失败：${error.message}。可以重新同步或手动匹配。`);
  }
}

async function syncProjects() {
  $('syncProjects').disabled = true;
  updateProjectStatus('正在逐个读取学校项目和可用金额…');
  try {
    const result = await api('/api/projects/sync', { method: 'POST' });
    state.projects = result.projects || [];
    state.projectSigners = result.projectSigners || {};
    state.projectSyncedAt = result.syncedAt || new Date().toISOString();
    updateProjectStatus(savedProjectStatus());
    renderRows();
    loadFundingSummary();
  } catch (error) {
    const detail = executionError(error.message).replace(/[。！？]+$/, '');
    updateProjectStatus(`项目同步失败。${detail}。已保留本地项目列表，也可手动输入。`);
  } finally {
    $('syncProjects').disabled = false;
  }
}

function toggleSelectAll() {
  const pending = state.folders.filter((item) => !item.reimbursed);
  const visible = visiblePendingClaims(pending).filter((item) => {
    if (item.payroll) return !item.payroll.blocker && item.match?.projectNo;
    if (item.didi) return !item.didi.blocker && item.didi.signer !== null && cleanReason(reasonEntry(item.path).text) === reasonEntry(item.path).confirmed;
    return canSelectForExecution(item.path) && projectForFolder(item.path);
  }).map((item) => item.path);
  const allSelected = visible.length && visible.every((folder) => state.selected.has(folder));
  for (const folder of visible) {
    if (allSelected) state.selected.delete(folder);
    else state.selected.add(folder);
  }
  renderRows();
}

let teachingSignerPicker;
let researchSignerPicker;
function renderBasicSettings(result) {
  state.workspace = result.workspace ?? null;
  selectConfigStorage(state.workspace);
  state.defaultSourceRoot = result.defaultSourceRoot;
  $('sourceRoot').value = result.sourceRoot;
  $('sourceRoot').readOnly = Boolean(state.workspace);
  applySignerRoster(result);
  teachingSignerPicker = mountSignerPicker($('teachingSignerPicker'), {
    label: '教学备用加签人', roster: state.signerRoster,
    selected: result.preferences?.signers?.['教学'], defaultLabel: '不设置备用加签人',
  });
  researchSignerPicker = mountSignerPicker($('researchSignerPicker'), {
    label: '科研备用加签人', roster: state.signerRoster,
    selected: result.preferences?.signers?.['科研'], defaultLabel: '不设置备用加签人',
  });
  if (result.preferences) {
    const { campus, autoPrint, smartPaymentLabel, legacyPaymentLabel, researchProjectNos } = result.preferences;
    $('bookingCampus').value = campus;
    $('autoPrint').checked = autoPrint;
    $('smartPaymentLabel').value = smartPaymentLabel;
    $('legacyPaymentLabel').value = legacyPaymentLabel;
    $('researchProjectNos').value = (researchProjectNos || []).join('\n');
  }
  state.demoMode = result.demoMode === true;
  $('openWorkspace').hidden = !state.workspace;
  $('profileStatus').textContent = state.workspace ? `${state.workspace.owner} · ${state.workspace.year} 年度 · ${state.demoMode ? '示例资料' : '本机资料'}`
    : state.demoMode ? '示例资料 · 本机服务已连接' : '本机资料 · 服务已连接';
  setReviewArchiveAvailable(!state.demoMode && result.reviewArchiveAvailable === true);
  $('demoIntro').hidden = !state.demoMode;
  $('schoolAccess').hidden = state.demoMode;
  $('liveWorklist').hidden = state.demoMode;
  $('fundingSync').hidden = state.demoMode;
  $('runToggle').hidden = state.demoMode;
  $('returnToDemo').hidden = state.demoMode || Boolean(state.workspace);
  $('saveRoot').textContent = state.demoMode ? '启用正式模式' : '保存基本信息';
  $('saveRoot').hidden = Boolean(state.workspace && state.demoMode);
  if (state.demoMode) setRunDrawer(false);
  $('paymentCardLast4').placeholder = result.paymentCardConfigured ? '已配置，留空保留' : '请输入公务卡尾号 4 位';
}

async function loadConfig() {
  renderBasicSettings(await api('/api/config', { signal: AbortSignal.timeout(15000) }));
}

let availableOwners = [];

function renderWorkspaceYears() {
  const owner = availableOwners.find(({ name }) => name === $('workspaceOwner').value);
  const select = $('workspaceYear');
  const previous = select.value;
  select.replaceChildren();
  for (const year of owner?.years ?? []) select.add(new Option(`${year} 年度`, year));
  if (owner && !owner.example) select.add(new Option('新建年度…', 'new'));
  select.value = [...select.options].some(({ value }) => value === previous) ? previous
    : owner?.name === state.workspace?.owner ? state.workspace?.year : select.options[0]?.value;
  if (select.selectedIndex < 0 && select.options.length) select.selectedIndex = 0;
  renderWorkspaceChoice();
}

function renderWorkspaceChoice() {
  const newOwner = $('workspaceOwner').value === '';
  const newYear = newOwner || $('workspaceYear').value === 'new';
  $('newWorkspaceOwnerField').hidden = !newOwner;
  $('newWorkspaceOwner').required = newOwner;
  $('workspaceYearField').hidden = newOwner;
  $('workspaceYear').required = !newOwner;
  $('newWorkspaceYearField').hidden = !newYear;
  $('newWorkspaceYear').required = newYear;
  $('newWorkspaceSourceField').hidden = !newYear;
  $('newWorkspaceSource').required = newYear;
  $('applyWorkspace').textContent = newYear ? '创建并打开' : '打开';
  $('workspaceDirectoryHint').textContent = newYear ? '选择已有的年度票据文件夹。助手会在使用人资料中保存路径和识别结果。' : '';
}

async function openWorkspaceChooser(create = false) {
  const dialog = $('workspaceDialog');
  const button = $('applyWorkspace');
  const status = $('workspaceStatus');
  if (!dialog.open) dialog.showModal();
  button.disabled = true;
  status.textContent = '正在读取本机目录…';
  try {
    const result = await api('/api/workspaces', { signal: AbortSignal.timeout(15000) });
    availableOwners = result.owners;
    const select = $('workspaceOwner');
    select.replaceChildren(...availableOwners.map(({ name }) => new Option(name, name)), new Option('新建使用人…', ''));
    select.value = create ? '' : result.current.owner;
    $('newWorkspaceYear').value = String(new Date().getFullYear());
    $('newWorkspaceSource').value = '';
    renderWorkspaceYears();
    status.textContent = '';
    button.disabled = false;
  } catch (error) { status.textContent = error.message; }
}

async function openSelectedWorkspace(event) {
  event.preventDefault();
  const button = $('applyWorkspace');
  const status = $('workspaceStatus');
  const chosen = $('workspaceOwner').value;
  const create = !chosen || $('workspaceYear').value === 'new';
  const owner = chosen || $('newWorkspaceOwner').value.trim();
  const year = create ? $('newWorkspaceYear').value.trim() : $('workspaceYear').value;
  const sourceRoot = create ? $('newWorkspaceSource').value.trim() : undefined;
  button.disabled = true;
  status.textContent = '正在打开本机资料…';
  try {
    await Promise.all([...reasonEntries.values()].filter((entry) => entry.sourceRoot === state.sourceRoot && cleanReason(entry.text) !== entry.saved)
      .map((entry) => saveReasonDraft(entry)));
    const { location } = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ owner, year, create, sourceRoot }) });
    window.location.assign(location);
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

async function saveRoot(demoMode = false) {
  const status = $('basicSettingsStatus');
  const sourceRoot = $('sourceRoot').value.trim();
  const card = $('paymentCardLast4').value.trim();
  if (!demoMode && !sourceRoot) {
    status.textContent = '请填写票据根目录。';
    return;
  }
  if (!teachingSignerPicker.reportValidity() || !researchSignerPicker.reportValidity()) return;
  $('saveRoot').disabled = true;
  status.textContent = '正在保存基本信息…';
  try {
    await Promise.all([...reasonEntries.values()].filter((entry) => entry.sourceRoot === state.sourceRoot && cleanReason(entry.text) !== entry.saved).map((entry) => saveReasonDraft(entry)));
    const preferences = {
      signers: {
        教学: teachingSignerPicker.value(),
        科研: researchSignerPicker.value(),
      },
      campus: $('bookingCampus').value, autoPrint: $('autoPrint').checked,
      smartPaymentLabel: $('smartPaymentLabel').value, legacyPaymentLabel: $('legacyPaymentLabel').value,
      researchProjectNos: $('researchProjectNos').value.split(/\r?\n/).map((number) => number.trim()).filter(Boolean),
    };
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify(demoMode ? { demoMode: true }
      : { sourceRoot, preferences, ...(card ? { paymentCardLast4: card } : {}) }) });
    renderBasicSettings(result);
    $('paymentCardLast4').value = '';
    status.textContent = '基本信息已保存。';
    if (result.changed) {
      state.configurationGeneration += 1;
      checkTasks.clear();
      state.selected.clear();
      state.plans.clear();
      state.batch = null;
      state.run = null;
      try {
        await loadProjects();
        await refreshFolders();
        loadFundingSummary();
        autoCheckAll();
      } catch (error) { setWorklistStatus(`刷新文件夹失败。${error.message}`); }
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    $('saveRoot').disabled = false;
  }
}

async function refreshFoldersManually() {
  const button = $('refreshFolders');
  const status = $('folderRefreshStatus');
  button.disabled = true;
  button.textContent = '刷新中…';
  status.hidden = false;
  status.textContent = '正在读取本机票据目录…';
  try {
    const before = new Map(state.sourceAmounts);
    state.sourceAmounts.clear();
    await refreshFolders({ signal: AbortSignal.timeout(30000) });
    const generation = state.configurationGeneration;
    const visible = state.sourceFolders.filter((item) => !item.reimbursed).length;
    loadFundingSummary();
    status.textContent = `已读取目录，正在核对 ${visible} 个待报销来源文件夹的材料和金额…`;
    await autoCheckAll();
    if (generation !== state.configurationGeneration) {
      status.textContent = '票据目录已更新，请查看当前工作清单。';
      return;
    }
    const results = [...state.sourceAmounts.entries()];
    const updated = results.filter(([path, amount]) => {
      const prior = before.get(path)?.fingerprint;
      return amount.fingerprint && (prior ? prior !== amount.fingerprint : amount.cacheState === 'new' || amount.cacheState === 'refreshed');
    }).length;
    const failed = results.filter(([, amount]) => amount.error).length;
    const awaitingSources = state.sourceFolders.filter((item) => {
      const preview = state.sourceAmounts.get(item.path);
      return !item.claimKey && preview && !preview.error && !Number.isSafeInteger(preview.totalCny);
    }).length;
    const awaitingClaims = [...state.plans.values()].filter((plan) => paymentReviewNeeded(plan) || !Number.isSafeInteger(plan.totalCny)).length;
    status.textContent = `刷新完成。核对 ${results.length} 个来源文件夹，${updated} 个有新材料或文件变化。${awaitingSources ? `${awaitingSources} 个未合并的来源金额待核对。` : ''}${awaitingClaims ? `${awaitingClaims} 个报销事项待核对材料或金额。` : ''}${failed ? `${failed} 个识别失败，详情见对应文件夹。` : ''}`;
  } catch (error) {
    status.textContent = `刷新失败。${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = '刷新文件夹';
  }
}

async function saveReceiptDirectory(event) {
  event.preventDefault();
  const status = $('receiptDirectoryStatus');
  const button = $('saveReceiptDirectory');
  const previousSourceRoot = state.sourceRoot;
  const sourceRoot = $('receiptDirectoryPath').value.trim();
  button.disabled = true;
  status.textContent = '正在检查原票据目录…';
  try {
    await Promise.all([...reasonEntries.values()].filter((entry) => entry.sourceRoot === previousSourceRoot && cleanReason(entry.text) !== entry.saved)
      .map((entry) => saveReasonDraft(entry)));
    const result = await api('/api/workspace-source', { method: 'POST', body: JSON.stringify({ previousSourceRoot, sourceRoot }) });
    renderBasicSettings(result);
    $('receiptDirectoryDialog').close();
    await refreshFoldersManually();
  } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
}

async function withdrawHistoryClaim(event) {
  const button = event.target.closest('[data-withdraw-run]');
  if (!button || button.disabled) return;
  const label = button.dataset.claimLabel;
  if (!window.confirm(`确认「${label}」的原单已在学校系统撤回或删除？登记后，事项会回到待报销。`)) return;
  button.disabled = true;
  let registered = false;
  try {
    const { folder } = await api(`/api/runs/${encodeURIComponent(button.dataset.withdrawRun)}/withdrawal`, {
      method: 'POST', body: JSON.stringify({ confirmed: true }),
    });
    registered = true;
    state.sourceAmounts.clear();
    state.activeFolder = folder;
    await refreshFolders();
    loadFundingSummary();
    await autoCheckAll();
    setWorklistStatus(`「${label}」已登记撤回，请在待报销清单匹配经费项目。`);
  } catch (error) {
    setWorklistStatus(registered ? `撤回已登记，请刷新文件夹。${error.message}` : `撤回登记失败。${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function init() {
  try {
    renderSchoolFinanceEntry();
    await loadConfig();
    await loadProjects();
    await refreshFolders();
    loadFundingSummary();
    await refreshExecution();
    autoCheckAll();
  } catch (error) {
    if (!$('liveWorklist').hidden || !state.workspace) $('profileStatus').textContent = `读取本机资料失败。${error.message}`;
    setWorklistStatus(error.message);
    $('folderRows').textContent = '读取失败，请检查本地服务。';
  }
}

const loadModelSettings = bindModelSettings(api);
const loadFundingSummary = bindFundingSummary({ api, money, escapeHtml, onPayrollSync: refreshFolders, currentYear: () => state.workspace?.year });
const setReviewArchiveAvailable = bindReviewArchive(api);

async function refreshSavedClaim(folder, message, focus = true) {
  const saved = await api('/api/folders');
  if (saved.sourceRoot !== state.sourceRoot) return;
  applySignerRoster(saved);
  const item = saved.claims?.find((entry) => entry.path === folder);
  if (!item) return;
  state.folders = [...state.folders.filter((entry) => entry.path !== folder), item]
    .sort((a, b) => (a.label || a.path).localeCompare(b.label || b.path, 'zh-CN'));
  applyProjectMatch(configFor(folder), item.match ?? null);
  if (item.didi) {
    const entry = reasonEntry(folder);
    entry.sourceFolders = item.sourceFolders;
    if (!entry.pending && cleanReason(entry.text) === entry.saved) entry.text = entry.saved = item.reasonDraft || '';
    entry.hasSaved ||= item.reasonSaved === true;
    entry.confirmed = item.didi.blocker ? '' : item.reasonDraft;
  }
  if (focus) focusClaim(folder, item.payroll ? 'labor' : 'didi');
  renderRows();
  setWorklistStatus(message);
}

const openPayroll = bindPayrollForm({
  api, $, money,
  getContext: () => ({
    sourceRoot: state.sourceRoot, categories: state.payrollCategories, positions: state.payrollPositions,
    expenseItems: state.payrollExpenseItems, signerNames: state.payrollSignerNames, signerRoster: state.signerRoster,
  }),
  async onSave(result) {
    await refreshSavedClaim(result.key, '薪酬申报已保存，请在右栏匹配经费。');
  },
});
$('addPayroll').addEventListener('click', () => openPayroll().catch((error) => setWorklistStatus(error.message)));
let projectSignerPicker;
function openProjectSigner(project) {
  const dialog = $('projectSignerDialog');
  const signer = state.projectSigners[projectNumberKey(project.projectNo)];
  $('projectSignerForm').dataset.projectNo = project.projectNo;
  $('projectSignerForm').dataset.sourceRoot = state.sourceRoot;
  $('projectSignerProject').textContent = [project.projectNo, project.projectName].filter(Boolean).join(' · ');
  projectSignerPicker = mountSignerPicker($('projectSignerPicker'), {
    label: '项目默认加签人', roster: state.signerRoster, selected: signer,
    defaultLabel: '不设置项目默认加签人',
  });
  $('projectSignerStatus').textContent = '';
  dialog.showModal();
}

$('closeProjectSigner').addEventListener('click', () => $('projectSignerDialog').close());
$('projectSignerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const { sourceRoot, projectNo } = event.currentTarget.dataset;
  const status = $('projectSignerStatus');
  const button = $('saveProjectSigner');
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = '正在保存…';
  try {
    const result = await api('/api/project-signer', { method: 'POST', body: JSON.stringify({
      sourceRoot, projectNo, signer: projectSignerPicker.value(),
    }) });
    $('projectSignerDialog').close();
    if (sourceRoot !== state.sourceRoot) return;
    state.projectSigners = result.projectSigners;
    applySignerRoster(result);
    renderProjects();
    await refreshFolders();
    await autoCheckAll();
  } catch (error) {
    if ($('projectSignerDialog').open) status.textContent = error.message;
    else setWorklistStatus(`默认加签人已保存。刷新清单失败，${error.message}`);
  } finally { button.disabled = false; }
});

let editingDidi = null;
let didiSignerPicker;
function openDidi(item = null) {
  editingDidi = item;
  $('didiTitle').textContent = item ? '贸大出行详情' : '新增贸大出行';
  $('saveDidi').textContent = item ? '保存详情' : '保存预算';
  $('didiBudget').value = item ? (item.didi.budgetCny / 100).toFixed(2) : '';
  didiSignerPicker = mountSignerPicker($('didiSignerPicker'), {
    label: '本笔加签人', roster: state.signerRoster, selected: item?.didi.signerOverride,
    defaultLabel: item?.match ? `沿用默认（${defaultSignerLabel(item.didi)}）` : '沿用默认（匹配项目后带出）',
  });
  $('didiStatus').textContent = '';
  $('didiDialog').showModal();
}

$('addDidiClaim').addEventListener('click', () => openDidi());
$('closeDidi').addEventListener('click', () => $('didiDialog').close());
$('didiForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const sourceRoot = state.sourceRoot;
  const item = editingDidi;
  const button = $('saveDidi');
  if (button.disabled) return;
  button.disabled = true;
  $('didiStatus').textContent = '正在保存…';
  try {
    const { key } = await api(item ? '/api/didi-claims/' + item.groupId : '/api/didi-claims', {
      method: item ? 'PUT' : 'POST',
      body: JSON.stringify({ sourceRoot, budget: $('didiBudget').value, revision: item?.didi.revision,
        signerOverride: didiSignerPicker.value(),
      }),
    });
    $('didiDialog').close();
    if (sourceRoot === state.sourceRoot) await refreshSavedClaim(key, item ? '贸大出行详情已更新。' : '预算已保存，请填写用车事由并在右栏匹配经费。');
  } catch (error) {
    if ($('didiDialog').open) $('didiStatus').textContent = error.message;
    else setWorklistStatus(error.message);
  } finally { button.disabled = false; }
});
$('openSettings').addEventListener('click', async () => {
  $('settingsDialog').showModal();
  loadModelSettings();
  $('basicSettingsForm').inert = true;
  $('basicSettingsStatus').textContent = '正在读取基本信息…';
  try {
    await loadConfig();
    $('basicSettingsStatus').textContent = '';
  } catch (error) {
    $('basicSettingsStatus').textContent = `读取基本信息失败。${error.message}`;
  } finally {
    $('basicSettingsForm').inert = false;
  }
});
$('closeSettings').addEventListener('click', () => $('settingsDialog').close());
$('openWorkspace').addEventListener('click', () => openWorkspaceChooser());
$('setupLive').addEventListener('click', () => state.workspace ? openWorkspaceChooser(true) : $('openSettings').click());
$('closeWorkspace').addEventListener('click', () => $('workspaceDialog').close());
$('workspaceForm').addEventListener('submit', openSelectedWorkspace);
$('workspaceOwner').addEventListener('change', renderWorkspaceYears);
$('workspaceYear').addEventListener('change', renderWorkspaceChoice);
$('returnToDemo').addEventListener('click', () => saveRoot(true));
$('confirmSubmission').addEventListener('click', () => sendRunMessage('确认提交'));
$('skipSubmission').addEventListener('click', () => sendRunMessage('先别提交'));
$('recordSubmission').addEventListener('click', () => updateOriginalDraft('submitted'));
$('resumeDraft').addEventListener('click', () => updateOriginalDraft('resume'));
$('endDraft').addEventListener('click', () => updateOriginalDraft('abandon_draft'));
$('viewBlockingRun').addEventListener('click', () => setRunDrawer(true));
$('settingsDialog').addEventListener('close', () => { $('paymentCardLast4').value = ''; });
$('basicSettingsForm').addEventListener('submit', (event) => {
  event.preventDefault();
  saveRoot();
});
$('checkLogin').addEventListener('click', checkCampusLogin);
$('syncProjects').addEventListener('click', syncProjects);
$('refreshFolders').addEventListener('click', refreshFoldersManually);
$('copyReceiptDirectory').addEventListener('click', async () => {
  const status = $('folderRefreshStatus');
  status.hidden = false;
  if (!state.sourceRoot) return;
  try { await navigator.clipboard.writeText(state.sourceRoot); status.textContent = '已复制原票据目录路径。'; }
  catch { status.textContent = '可选中上方的原票据目录路径并复制。'; }
});
$('editReceiptDirectory').addEventListener('click', () => {
  $('receiptDirectoryPath').value = state.sourceRoot;
  $('receiptDirectoryStatus').textContent = '';
  $('receiptDirectoryDialog').showModal();
});
$('receiptDirectoryForm').addEventListener('submit', saveReceiptDirectory);
$('closeReceiptDirectory').addEventListener('click', () => $('receiptDirectoryDialog').close());
$('historyRows').addEventListener('click', withdrawHistoryClaim);
$('selectAll').addEventListener('click', toggleSelectAll);
$('checkSelected').addEventListener('click', checkSelected);
$('executeSelected').addEventListener('click', executeSelected);
$('sourceFilter').addEventListener('input', renderSources);
$('sourceRows').addEventListener('change', (event) => {
  const input = event.target.closest('[data-source]');
  if (!input) return;
  state.sourceNotice = '';
  if (input.checked) state.selectedSources.add(input.dataset.source);
  else state.selectedSources.delete(input.dataset.source);
  renderSources();
});
$('createClaim').addEventListener('click', () => chooseClaimRoute());
$('mergeClaims').addEventListener('click', () => chooseClaimRoute({ merge: true }));
$('claimRouteForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!$('saveClaimRoute').disabled) saveClaimRoute();
});
$('cancelClaimRoute').addEventListener('click', () => $('claimRouteDialog').close());
$('claimRouteDialog').addEventListener('cancel', (event) => {
  if ($('saveClaimRoute').disabled) event.preventDefault();
});
$('addToClaim').addEventListener('click', () => {
  const item = itemFor(state.activeFolder);
  if (item) updateClaimSources(item.path, [...item.sourceFolders, ...state.selectedSources]);
});
$('executionDetails').addEventListener('click', (event) => {
  const { folder, openRun, allocation } = event.currentTarget.dataset;
  if (openRun === 'true') setRunDrawer(true);
  else if (allocation === 'true') {
    if (!folderRow(folder)) $('folderFilter').value = '';
    state.activeFolder = folder;
    renderRows();
    const form = folderRow(folder)?.querySelector('.allocation-form');
    form?.scrollIntoView({ block: 'nearest' });
    form?.querySelector('.allocation-input')?.focus({ preventScroll: true });
  } else if (itemFor(folder)?.didi) openDidi(itemFor(folder));
  else openDetails(folder);
});
$('folderFilter').addEventListener('input', renderRows);
$('claimRouteFilter').addEventListener('change', () => {
  renderRows();
  renderSchoolFinanceEntry();
});
$('checkSchoolFinance').addEventListener('click', checkSchoolFinanceEntry);
$('folderRows').addEventListener('click', (event) => {
  const row = event.target.closest('.folder-row');
  if (!row) return;
  const entry = itemFor(row.dataset.path);
  if (entry?.didi && event.target.closest('[data-edit-didi]')) {
    openDidi(entry);
    return;
  }
  if (entry?.didi && event.target.closest('[data-remove-didi]')) {
    if (state.blockingRun?.plan.folder === entry.path) {
      showExecutionFeedback('这笔事项还有学校原草稿。请先继续原草稿，或在学校作废后登记结束，再移除。', { openRun: true });
      setRunDrawer(true);
      return;
    }
    const sourceRoot = state.sourceRoot;
    const button = event.target.closest('[data-remove-didi]');
    button.disabled = true;
    api('/api/didi-claims/' + entry.groupId, { method: 'DELETE', body: JSON.stringify({ sourceRoot }) }).then(() => {
      if (sourceRoot !== state.sourceRoot) return;
      state.folders = state.folders.filter((item) => item.path !== entry.path);
      state.selected.delete(entry.path);
      const key = projectMatchKey(sourceRoot, entry.path);
      clearTimeout(reasonEntries.get(key)?.timer);
      reasonEntries.delete(key);
      renderRows();
      setWorklistStatus('已移除这笔贸大出行。');
    }).catch((error) => showExecutionFeedback(`移除失败。${error.message}`, { openRun: /草稿|执行|核实/.test(error.message) }))
      .finally(() => { button.disabled = false; });
    return;
  }
  if (entry?.payroll && event.target.closest('.edit-payroll')) {
    openPayroll(entry).catch((error) => setWorklistStatus(error.message));
    return;
  }
  if (event.target.closest('[data-edit-claim-route]')) {
    chooseClaimRoute({ folder: row.dataset.path });
    return;
  }
  const remove = event.target.closest('[data-remove-source]');
  if (remove) {
    const item = itemFor(row.dataset.path);
    updateClaimSources(item.path, item.sourceFolders.filter((folder) => folder !== remove.dataset.removeSource));
    return;
  }
  if (event.target.closest('[data-dissolve-claim]')) {
    dissolveClaim(row.dataset.path);
    return;
  }
  if (event.target.closest('.detail-row')) {
    openDetails(row.dataset.path);
    return;
  }
  if (event.target.closest('.match-row')) {
    selectMatchTarget(row);
    if (matchMedia('(max-width: 1050px)').matches) $('matchingProjects').scrollIntoView({ block: 'start' });
    return;
  }
  if (event.target.closest('button, input, textarea, select, label, summary, a')) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && row.contains(selection.anchorNode)) return;
  selectMatchTarget(row);
});
$('folderRows').addEventListener('change', (event) => {
  if (!event.target.matches('.row-select')) return;
  const folder = event.target.closest('.folder-row').dataset.path;
  if (event.target.checked) state.selected.add(folder);
  else state.selected.delete(folder);
  updateSelectionCount();
});
$('folderRows').addEventListener('input', (event) => {
  if (event.target.matches('.allocation-input')) {
    const folder = event.target.closest('.folder-row').dataset.path;
    const key = projectMatchKey(state.sourceRoot, folder);
    if (!allocationEdits.has(key)) allocationEdits.set(key, new Map());
    allocationEdits.get(key).set(event.target.dataset.allocationProject, event.target.value);
    updateAllocationInPlace(folder);
    updateSelectionCount();
    if (folder === state.activeFolder) renderProjects();
    return;
  }
  if (!event.target.matches('.folder-reason-input')) return;
  const folder = event.target.closest('.folder-row').dataset.path;
  const entry = reasonEntry(folder);
  entry.text = event.target.value;
  entry.error = '';
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => saveReasonDraft(entry).catch(() => undefined), 350);
  updateReasonInPlace(folder);
});
$('folderRows').addEventListener('focusout', (event) => {
  if (!event.target.matches('.folder-reason-input')) return;
  const entry = reasonEntry(event.target.closest('.folder-row').dataset.path);
  if (cleanReason(entry.text) !== entry.saved) saveReasonDraft(entry).catch(() => undefined);
});
$('folderRows').addEventListener('submit', (event) => {
  if (event.target.matches('.allocation-form')) {
    event.preventDefault();
    const folder = event.target.closest('.folder-row').dataset.path;
    const allocation = allocationState(folder);
    if (allocation.draft.length > 1 && !allocation.error && allocation.dirty) {
      saveProjectMatch(folder, { funding: configFor(folder).funding, allocations: allocation.draft });
    }
    return;
  }
  saveClaimPurpose(event);
});
window.addEventListener('pagehide', () => {
  const headers = { 'content-type': 'application/json' };
  if (state.workspace) headers['x-reimbursement-year'] = state.workspace.year;
  for (const entry of reasonEntries.values()) {
    if (entry.sourceRoot !== state.sourceRoot || cleanReason(entry.text) === entry.saved) continue;
    fetch('/api/claim-reason', { method: 'POST', headers, body: reasonRequest(entry), keepalive: true }).catch(() => undefined);
  }
});
$('projectFilter').addEventListener('input', renderProjects);
$('matchTarget').addEventListener('click', (event) => {
  if (!event.target.closest('[data-clear-match]') || !state.activeFolder) return;
  saveProjectMatch(state.activeFolder, null);
});
$('projectRows').addEventListener('click', (event) => {
  const button = event.target.closest('[data-match-project], [data-project-signer]');
  if (!button) return;
  const projectNo = button.dataset.matchProject ?? button.dataset.projectSigner;
  const project = [...state.projects, ...projectsForFolder(state.activeFolder)].find((item) => item.projectNo === projectNo);
  if (!project) return;
  if (button.hasAttribute('data-project-signer')) openProjectSigner(project);
  else matchProject(project, button.getAttribute('aria-pressed') === 'true');
});
$('matchFunding').addEventListener('change', (event) => {
  const folder = state.activeFolder;
  if (!folder) return;
  const funding = event.target.value;
  const { match } = configFor(folder);
  if (match?.allocations) saveProjectMatch(folder, { funding, allocations: allocationState(folder).draft });
  else if (match) saveProjectMatch(folder, { ...match, funding });
  else invalidatePlan(folder, (config) => { config.funding = funding; });
});
$('manualProjectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const projectNo = $('manualProjectNo').value.trim();
  const projectName = $('manualProjectName').value.trim();
  if (!projectNo || !projectName) return;
  if (await matchProject({ projectNo, projectName })) $('manualMatch').open = false;
});
$('replyForm').addEventListener('submit', (event) => {
  event.preventDefault();
  sendRunMessage($('replyInput').value.trim());
});
$('messages').addEventListener('click', (event) => {
  const choice = event.target.closest('[data-run-choice]');
  if (choice) sendRunMessage(choice.dataset.runChoice);
});
$('closeDetail').addEventListener('click', closeDetails);
$('detailContent').addEventListener('click', (event) => {
  const button = event.target.closest('[data-fx-date]');
  if (button) lookupForeignQuote(button);
});
document.querySelector('[data-close-detail]').addEventListener('click', closeDetails);
$('runToggle').addEventListener('click', () => setRunDrawer($('runDrawer').hidden));
$('runClose').addEventListener('click', () => setRunDrawer(false));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('detailModal').hidden) closeDetails();
  else if (!$('runDrawer').hidden) setRunDrawer(false);
});
setInterval(refreshExecution, 2000);
init();
