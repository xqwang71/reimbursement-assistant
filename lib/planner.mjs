import { readdir, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve, relative, extname, basename, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { askCodex } from './codex.mjs';
import { analyzeTravel, reconcileTravel, validTravelAmounts } from './travel.mjs';
import { reconcileClaim } from './claim-policy.mjs';
import { applyClaimPurpose, mentionsMealExpense, validateClaimPurpose } from './claim-purpose.mjs';
import { allocateProjects } from '../public/project-allocation.js';
import { displayForeignMoney, parseForeignDocument } from './foreign-money.mjs';
import { reconcileForeignClaim } from './foreign-claim.mjs';
import { readBocQuote } from './boc-rates.mjs';
import { isInsideDirectory, pythonExecutable } from './platform.mjs';
import { redactModelText } from './model-input.mjs';

export const PLAN_VERSION = 16;
export const SELECTION_VERSION = 3;

const IGNORED = new Set(['.DS_Store', 'Thumbs.db']);
const extractionLocks = new Map();
const ocrScript = fileURLToPath(new URL('../scripts/rapid_ocr.py', import.meta.url));
const pdfTextScript = fileURLToPath(new URL('../scripts/pdf_text.py', import.meta.url));
export const SUBJECTS = {
  '电脑配件': { expenseType: '设备' },
  '办公用品': { expenseType: '' },
  '书籍资料': { expenseType: '' },
  'AI服务': { expenseType: '' },
  '数据服务': { expenseType: '' },
  '境外软件订阅': { expenseType: '' },
  '劳务费': { expenseType: '' },
  '差旅': { expenseType: '' },
  '其他': { expenseType: '' },
};

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(stderr.slice(-1500) || `${command} 退出（${code}）`)));
  });
}

export const isReimbursedFolder = (folder) => folder.split('/').some((part) => part.endsWith('-已报销'));

export async function listFinalFolders(sourceRoot) {
  const root = await realpath(sourceRoot);
  const result = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const visible = entries.filter((entry) => !entry.name.startsWith('.'));
    const files = visible.filter((entry) => entry.isFile() && !IGNORED.has(entry.name));
    const directories = visible.filter((entry) => entry.isDirectory());
    if (directory !== root && files.length && !directories.length) {
      const path = relative(root, directory).split(sep).join('/');
      result.push({ path, fileCount: files.length, reimbursed: isReimbursedFolder(path) });
    }
    for (const entry of directories) await walk(join(directory, entry.name));
  }
  await walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
}

function money(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Math.round(Number(match[1].replaceAll(',', '')) * 100);
  }
  return null;
}

function dateOf(text) {
  const date = text.match(/(20\d{2})[-年/](\d{1,2})[-月/](\d{1,2})/);
  return date ? `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}` : null;
}

function parseDocument(file, text) {
  // PDF layouts can insert spaces between any characters. Keep line breaks as field boundaries.
  const invoiceText = text.replace(/[\t\p{Zs}\u200B\uFEFF]/gu, '');
  const invoiceNumber = invoiceText.match(/发票号码[：:]?\s*(\d+)/)?.[1] || null;
  const orderNumbers = [...new Set([...text.matchAll(/订单(?:编号|号)[：:]?\s*([A-Za-z0-9-]{15,40})/g)].map((match) => match[1]))];
  const orderNumber = orderNumbers[0] || null;
  const transactionId = text.match(/(?:交易单号|交易流水号|支付流水号)[：:]?\s*([A-Za-z0-9-]{6,64})/)?.[1] || null;
  const invoiceAmountCny = money(invoiceText, [/[（(]小写[）)]\s*[¥￥]\s*([\d,.]+)/, /价税合计[^\n]*?[¥￥]\s*([\d,.]+)/]);
  const orderAmountCny = money(text, [/(?:实付款|实付金额|订单实付)[：:]?\s*[¥￥]?\s*([\d,.]+)/]);
  const paymentAmountCny = money(text, [/(?:交易金额|付款金额|支付金额)[：:]?\s*[¥￥]?\s*([\d,.]+)/, /^\s*[-—]\s*([\d,]+\.\d{2})\s*$/m]);
  const dateText = invoiceNumber ? invoiceText : text;
  const preferredDate = dateText.match(/(?:下单时间|购买日期|支付时间|交易时间|开票日期)[：:]?\s*(20\d{2}[-年/]\d{1,2}[-月/]\d{1,2})/)?.[1];
  const foreign = !invoiceNumber ? parseForeignDocument(text, file.name) : null;
  return { file, invoiceNumber, orderNumber, orderNumbers, transactionId, invoiceAmountCny, orderAmountCny, paymentAmountCny, date: dateOf(preferredDate || dateText), text, ...(foreign ? { foreign } : {}) };
}

async function extractDocuments(files, workDir) {
  const documents = [];
  const ocrFiles = [];
  for (const file of files) {
    if (extname(file.name).toLowerCase() === '.pdf') {
      let text = await run('pdftotext', ['-layout', file.absolutePath, '-']).then(({ stdout }) => stdout, () => '');
      if (!text.trim()) {
        text = await run(pythonExecutable(), ['-X', 'utf8', pdfTextScript, file.absolutePath])
          .then(({ stdout }) => stdout, () => '');
      }
      if (text.trim()) documents.push(parseDocument(file, text));
      else ocrFiles.push(file);
    } else if (/\.(png|jpe?g|webp|docx|xlsx?|csv|txt|md)$/i.test(file.name)) ocrFiles.push(file);
  }
  if (ocrFiles.length) {
    await mkdir(workDir, { recursive: true, mode: 0o700 });
    const manifest = join(workDir, 'manifest.json');
    const output = join(workDir, 'result.json');
    await writeFile(manifest, JSON.stringify({ files: ocrFiles.map((file) => ({ name: file.name, path: file.absolutePath })) }), { mode: 0o600 });
    await run(pythonExecutable(), ['-X', 'utf8', ocrScript, manifest, output], { cwd: workDir })
      .catch(() => { throw new Error('本机附件识别组件未就绪。请按 README 安装 OCR 依赖后重新检查。'); });
    const result = JSON.parse(await readFile(output, 'utf8'));
    for (const item of result.files || []) {
      const source = ocrFiles.find((file) => file.name === item.name);
      if (source) documents.push(parseDocument(source, (item.pages || []).join('\n')));
    }
  }
  return documents;
}

const JUNK_FILE = /(~\$|\.sync-conflict[-.])/i;

export async function fingerprintFolder(sourceRoot, folder) {
  const root = resolve(sourceRoot);
  const directory = resolve(root, folder);
  if (!isInsideDirectory(root, directory) || !isInsideDirectory(await realpath(root), await realpath(directory))) {
    throw new Error('报销文件夹路径无效');
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.filter((item) => item.isFile() && !item.name.startsWith('.') && !IGNORED.has(item.name) && !JUNK_FILE.test(item.name)).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
    const absolutePath = join(directory, entry.name);
    const sha256 = createHash('sha256').update(await readFile(absolutePath)).digest('hex');
    files.push({ name: entry.name, absolutePath, sha256 });
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(files.map(({ name, sha256 }) => ({ name, sha256 })))).digest('hex');
  return { files, fingerprint };
}

export async function fingerprintSources(sourceRoot, folders) {
  if (!Array.isArray(folders) || !folders.length || folders.some((folder) => typeof folder !== 'string') || new Set(folders).size !== folders.length) throw new Error('请选择有效且不重复的来源文件夹');
  const sources = [];
  const files = [];
  for (const folder of [...folders].sort()) {
    const source = await fingerprintFolder(sourceRoot, folder);
    const index = sources.length + 1;
    sources.push({ folder, fingerprint: source.fingerprint });
    for (const file of source.files) {
      files.push({ ...file, name: folders.length > 1 ? `${index}__${file.name}` : file.name, sourceFolder: folder, sourceName: file.name });
    }
  }
  const fingerprint = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
  return { files, sources, fingerprint };
}

export function fingerprintPlan(sourceRoot, plan) {
  return plan.sourceFolders ? fingerprintSources(sourceRoot, plan.sourceFolders) : fingerprintFolder(sourceRoot, plan.folder);
}

async function extractDocumentsCached(appDir, folder, files, fingerprint, force) {
  const cacheKey = `${folder}\0${fingerprint}`;
  if (extractionLocks.has(cacheKey)) return extractionLocks.get(cacheKey);
  const task = (async () => {
    const cacheRoot = join(appDir, '.runtime', 'cache');
    const cacheDir = join(cacheRoot, encodeURIComponent(folder));
    const supported = files.filter((file) => /\.(pdf|png|jpe?g|webp|docx|xlsx?|csv|txt|md)$/i.test(file.name));
    const rawFingerprint = createHash('sha256').update(JSON.stringify(supported.map(({ name, sha256 }) => ({ name, sha256 })))).digest('hex');
    const cacheFile = join(cacheDir, `${rawFingerprint}.json`);
    if (!force) {
      const cacheNames = [...new Set([`${rawFingerprint}.json`, `${fingerprint}.json`])];
      const directories = await readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
      const candidates = [cacheDir, ...directories.filter((entry) => entry.isDirectory() && entry.name !== encodeURIComponent(folder)).map((entry) => join(cacheRoot, entry.name))];
      for (const directory of candidates) for (const name of cacheNames) {
        try {
          const cached = JSON.parse(await readFile(join(directory, name), 'utf8'));
          if (!Array.isArray(cached.documents) || !supported.every((file) => cached.documents.some((document) => document.file?.name === file.name && typeof document.text === 'string'))) continue;
          const documents = cached.documents.filter((document) => supported.some((file) => file.name === document.file?.name)).map((document) => parseDocument(supported.find((file) => file.name === document.file.name), document.text));
          return { documents, cacheState: 'cached', fingerprint };
        } catch {}
      }
    }
    const documents = await extractDocuments(supported, join(appDir, '.runtime', 'ocr', fingerprint));
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, JSON.stringify({ fingerprint: rawFingerprint, documents }), { mode: 0o600 });
    return { documents, cacheState: force ? 'refreshed' : 'new', fingerprint };
  })();
  extractionLocks.set(cacheKey, task);
  try { return await task; } finally { extractionLocks.delete(cacheKey); }
}

async function decideUploadsWithAi({ appDir, folder, candidates, docByName, fingerprint, subject }) {
  const cacheDir = join(appDir, '.runtime', 'cache', encodeURIComponent(folder));
  const cacheFile = join(cacheDir, `selection-v${SELECTION_VERSION}-${subject}-${fingerprint}.json`);
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (cached.version === SELECTION_VERSION && cached.subject === subject && Array.isArray(cached.upload) && cached.types && cached.matches) return { upload: cached.upload, types: cached.types, matches: cached.matches, source: 'ai-cache' };
  } catch {}
  const aliases = new Map(candidates.map(({ name }, index) => [`附件${index + 1}`, name]));
  const manifest = candidates.map((file, index) => {
    const doc = docByName.get(file.name);
    const parts = [];
    if (doc?.invoiceAmountCny != null) parts.push(`发票金额=${(doc.invoiceAmountCny / 100).toFixed(2)}元`);
    if (doc?.orderAmountCny != null) parts.push(`订单实付=${(doc.orderAmountCny / 100).toFixed(2)}元`);
    if (doc?.paymentAmountCny != null) parts.push(`支付金额=${(doc.paymentAmountCny / 100).toFixed(2)}元`);
    if (doc?.foreign?.money) parts.push(`原币金额=${displayForeignMoney(doc.foreign.money)}`);
    if (doc?.foreign?.debitCny) parts.push(`人民币实扣=${(doc.foreign.debitCny / 100).toFixed(2)}元`);
    const text = redactModelText(doc?.text).replace(/\s+/g, ' ').trim().slice(0, 1600);
    return { name: `附件${index + 1}`, fields: parts.join('；') || '（未提取到关键字段）', content: text || '（无文字内容）' };
  });
  const prompt = `你是学校财务报销的材料筛选助手。下面是一个报销事项的候选附件及提取的文字。
本批科目为 ${subject}。材料可能包括发票、订单/服务明细、付款记录、签字版签收单、资产卡片。保留与本批有关的正式材料。不要用文件名推断已签字或已盖章。
你的任务：从中挑选需要上传到报销系统的文件，并判定每个入选文件属于哪类材料。规则：
- 发票、订单截图/明细、支付记录三类都要尽量覆盖；同一订单的重复材料（如同时有订单截图和明细表）只需保留信息最全的一个；
- 注意：订单截图/明细不一定是文件名带“订单”“明细”的文件，手机 App 的订阅页、套餐页、商品详情截图（通常含订阅时间、套餐价格）也算订单截图；文件名像“微信图片_…”的截图要靠内容判断类型；
- 不要选：待签字文件、与报销无关的文件、内容重复的副本；${subject === '差旅' ? '出差申请表/审批单不要选（出差审批在学校系统中线上关联，不作为附件上传）；' : ''}
- 拿不准的相关文件保留为 other，交由规则与人工复核；不得因不属于三类而丢弃签收单或资产卡片。
你的任务分三部分：
1. upload：挑选需要上传的文件名清单（原样取自下面清单）。
2. types：给每个入选文件标类型：invoice=发票，detail=订单截图/明细，payment=支付记录，receipt=签收单，asset=资产卡片，other=其他相关正式材料。
3. matches：把每张发票和它对应的订单截图、支付记录配起来，按金额、订单号、时间、商品名称判断对应关系。键是发票文件名，值是 {"detail":["订单截图文件名",...],"payment":["支付记录文件名",...]}，配不上的留空数组。只有入选 upload 的文件才能出现在 matches 里。
只输出严格 JSON，不要输出任何其他文字：
{"upload":["文件名1",...],"types":{"文件名1":"invoice|detail|payment|receipt|asset|other",...},"matches":{"发票文件名":{"detail":[...],"payment":[...]}}}
文件清单：
${JSON.stringify(manifest, null, 2)}`;
  const text = await askCodex({ prompt, cwd: appDir, purpose: 'attachments', timeoutMs: 180000 });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI 未返回 JSON');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.upload) || !parsed.upload.length) throw new Error('AI 未选出任何文件');
  const upload = [...new Set(parsed.upload.filter((name) => aliases.has(name)))];
  if (!upload.length) throw new Error('AI 选出的文件名都不在清单中');
  const kinds = new Set(['invoice', 'detail', 'payment', 'receipt', 'asset', 'other']);
  const types = {};
  for (const name of upload) {
    const kind = parsed.types?.[name];
    if (kinds.has(kind)) types[aliases.get(name)] = kind;
  }
  const chosen = new Set(upload);
  const matches = {};
  for (const [invoiceFile, link] of Object.entries(parsed.matches || {})) {
    if (!chosen.has(invoiceFile)) continue;
    const clean = {
      detail: (Array.isArray(link?.detail) ? link.detail : []).filter((name) => chosen.has(name)).map((name) => aliases.get(name)),
      payment: (Array.isArray(link?.payment) ? link.payment : []).filter((name) => chosen.has(name)).map((name) => aliases.get(name)),
    };
    matches[aliases.get(invoiceFile)] = clean;
  }
  await mkdir(cacheDir, { recursive: true });
  const selected = upload.map((name) => aliases.get(name));
  await writeFile(cacheFile, JSON.stringify({ version: SELECTION_VERSION, subject, fingerprint, upload: selected, types, matches }), { mode: 0o600 });
  return { upload: selected, types, matches, source: 'ai' };
}

function reimbursementRestriction(route, subject) {
  if (route === 'labor' || subject === '劳务费') return '劳务费走学校财务系统的薪酬申报';
  if (route === 'split') return '同一事项含人民币和外币实付。请按可独立核对的票据拆分事项。同一张发票跨币种支付时，请先核对学校办理方式';
  if (route === 'review') return '请先核对实际扣款币种和金额，再确定办理系统';
  return '';
}

const AUTOMATIC_INVOICE_NUMBER = /^\d{20}$/;

export async function createPlan({ appDir, sourceRoot, folder, sourceFolders = null, groupId = null, displayName = null, subject, funding, project = null, projectAllocationDraft = null, historyInvoiceNumbers = [], historyPaymentKeys = [], force = false, allowReimbursed = false, travelProfile = null, confirmations = {}, paymentCardLast4 = '', purpose = null, bookingOptions = null, paymentType = '', signer = null }) {
  if ((sourceFolders || [folder]).some(isReimbursedFolder) && !allowReimbursed) throw new Error('该文件夹已归入报销历史');
  if (!SUBJECTS[subject]) throw new Error('请选择有效的报销科目');
  if (!['教学', '科研'].includes(funding)) throw new Error('请选择教学或科研');
  const current = await fingerprintPlan(sourceRoot, { folder, sourceFolders });
  const { files, fingerprint } = current;
  const basePlan = {
    version: PLAN_VERSION, folder, subject, funding, fingerprint,
    ...(sourceFolders ? { groupId, displayName, sourceFolders: current.sources.map((source) => source.folder), sources: current.sources, fileSources: Object.fromEntries(files.map((file) => [file.name, { folder: file.sourceFolder, name: file.sourceName }])) } : {}),
    project: project || { projectNo: '', projectName: '', balanceCny: null },
    ...(projectAllocationDraft ? { projectAllocationDraft } : {}),
  };
  if (subject === '劳务费') {
    const reimbursementRoute = 'labor';
    return applyClaimPurpose({
      ...basePlan, reimbursementRoute, claimType: '劳务费',
      materialBlockers: [reimbursementRestriction(reimbursementRoute, subject)], materialWarnings: [],
      materials: [], rows: [], confirmations: {}, paymentKeys: [],
      uploadFiles: [], batches: [], supportingFiles: files.map((file) => file.name),
      invoiceTotalCny: null, paidTotalCny: null, totalCny: null,
    }, purpose);
  }
  const extraction = { documents: [], cacheState: 'cached' };
  const extractedSources = [];
  for (const source of current.sources || [{ folder, fingerprint }]) {
    const selected = files.filter((file) => !sourceFolders || file.sourceFolder === source.folder);
    const originals = selected.map((file) => ({ ...file, name: file.sourceName || file.name }));
    const extracted = await extractDocumentsCached(appDir, source.folder, originals, source.fingerprint, force);
    if (extracted.cacheState !== 'cached') extraction.cacheState = extracted.cacheState;
    const byPath = new Map(selected.map((file) => [file.absolutePath, file]));
    extraction.documents.push(...extracted.documents.map((document) => ({ ...document, file: byPath.get(document.file.absolutePath) })));
    extractedSources.push({ ...source, files: originals, documents: extracted.documents, renamed: new Map(selected.map((file) => [file.sourceName || file.name, file.name])) });
  }
  const documents = extraction.documents;
  const warnings = files.filter((file) => /待签字/.test(file.name)).map((file) => `${file.name} 尚未签字，不会上传`);
  let selection = { upload: [], types: {}, matches: {}, source: 'rule' };
  const candidates = files.filter((file) => !/待签字/.test(file.name));
  try {
    const single = extractedSources.length === 1 ? extractedSources[0] : null;
    selection = await decideUploadsWithAi({ appDir, folder: single?.folder || folder, candidates, docByName: new Map(documents.map((document) => [document.file.name, document])), fingerprint: single?.fingerprint || fingerprint, subject });
  } catch (error) {
    warnings.push(`AI 材料关联未完成，按可验证依据检查：${error.message}`);
    if (extractedSources.length > 1) {
      for (const source of extractedSources) {
        try {
          const cached = await decideUploadsWithAi({ appDir, folder: source.folder, candidates: source.files.filter((file) => !/待签字/.test(file.name)), docByName: new Map(source.documents.map((document) => [document.file.name, document])), fingerprint: source.fingerprint, subject });
          const rename = (name) => source.renamed.get(name);
          selection.upload.push(...cached.upload.map(rename));
          for (const [name, kind] of Object.entries(cached.types)) selection.types[rename(name)] = kind;
          for (const [name, links] of Object.entries(cached.matches)) selection.matches[rename(name)] = { detail: links.detail.map(rename), payment: links.payment.map(rename) };
        } catch {}
      }
    }
  }
  const currentConfirmations = confirmations.fingerprint === fingerprint ? confirmations : {};
  if (subject === '电脑配件' && confirmations.governmentProcurement === true && currentConfirmations !== confirmations) {
    currentConfirmations.governmentProcurement = true;
  }
  const reconciliation = { documents, files, selection, subject, historyInvoiceNumbers, confirmations: currentConfirmations, paymentCardLast4 };
  const foreignClaim = documents.some((document) => document.foreign && !/待签字/.test(document.file.name));
  const assessment = foreignClaim
    ? await reconcileForeignClaim(reconciliation, (date, currency) => readBocQuote(appDir, date, currency))
    : reconcileClaim(reconciliation);
  const assessedRoute = assessment.reimbursementRoute ?? 'smart';
  const reimbursementRoute = bookingOptions?.offline && assessedRoute === 'smart' && subject !== '差旅' ? 'legacy' : assessedRoute;
  const routeRestriction = reimbursementRestriction(reimbursementRoute, subject);
  if (routeRestriction) assessment.blockers.push(routeRestriction);
  if (foreignClaim && reimbursementRoute === 'smart' && assessment.rows.some((row) => !AUTOMATIC_INVOICE_NUMBER.test(row.invoiceNumber))) {
    assessment.blockers.push('按人民币实付走智能报销系统。当前自动填报支持完整 20 位电子发票，本笔请在学校端核对票据填报方式');
  }
  const claimedFiles = new Set([...assessment.uploadNames, ...assessment.rows.flatMap((row) => row.paymentFiles)]);
  const mealExpense = mentionsMealExpense(folder) || documents.some((doc) => claimedFiles.has(doc.file.name) && (mentionsMealExpense(doc.file.name) || mentionsMealExpense(doc.text)));
  if (assessment.paymentKeys.some((key) => historyPaymentKeys.includes(key))) assessment.blockers.push('本笔付款已记入另一报销单，请核对原单和费用归属');
  let travel = null;
  let totalCny = assessment.totalCny;
  let ticketTotalCny = totalCny;
  if (subject === '差旅') {
    totalCny = null;
    if (reimbursementRoute !== 'smart') assessment.blockers.push('当前国内差旅自动填报只支持智能报销系统');
    try {
      const docByName = new Map(documents.map((document) => [document.file.name, document]));
      const analysis = await analyzeTravel({ appDir, folder, candidates, docByName, fingerprint, profile: travelProfile || undefined });
      const checked = reconcileTravel(analysis, assessment, docByName);
      travel = checked.travel;
      assessment.rows = checked.rows;
      assessment.uploadNames = checked.uploadNames;
      assessment.blockers.push(...travel.blockers);
      warnings.push(...travel.warnings);
      ticketTotalCny = travel.amounts?.ticketCny ?? null;
      totalCny = checked.totalCny;
    } catch (error) { assessment.blockers.push(`差旅事实尚未确认：${error.message}`); }
  }
  const fxQuotes = assessment.fxQuotes || [];
  const reviewedFiles = [...files.filter((file) => assessment.uploadNames.includes(file.name)), ...fxQuotes.map(({ name, absolutePath, sha256 }) => ({ name, absolutePath, sha256 }))];
  const offline = reimbursementRoute === 'legacy';
  const paperOverride = bookingOptions?.fingerprint === fingerprint ? bookingOptions.attachmentCount : null;
  const attachmentCount = offline ? paperOverride ?? new Set(reviewedFiles.map((file) => file.sha256)).size : null;
  const uploadFiles = offline ? [] : reviewedFiles;
  if (offline && projectAllocationDraft) assessment.blockers.push('日常线下报销请选择一个经费项目');
  if (offline && (!attachmentCount || attachmentCount > 50)) assessment.blockers.push('请核对本笔的纸质附件张数，学校要求 1 至 50 张');
  return applyClaimPurpose({
    ...basePlan, mealExpense, reimbursementRoute, bookingOptions,
    ...(offline ? { attachmentCount, paperFiles: reviewedFiles.map(({ name }) => name) } : {}),
    materialBlockers: assessment.blockers, materialWarnings: [...warnings, ...assessment.warnings],
    materials: assessment.materials, confirmations: currentConfirmations, rows: assessment.rows,
    ...(!foreignClaim && subject !== '差旅' ? { paymentCandidates: assessment.paymentCandidates } : {}),
    uploadFiles, uploadSource: selection.source, uploadTypes: selection.types, uploadMatches: selection.matches,
    supportingFiles: candidates.filter((file) => /\.(pdf|png|jpe?g|webp)$/i.test(file.name)).map((file) => file.name),
    claimType: subject === '差旅' ? '国内差旅' : '日常报销', travel: travel || undefined,
    travelProfile: travel?.profile || travelProfile || undefined,
    cacheState: extraction.cacheState,
    invoiceTotalCny: assessment.invoiceTotalCny, paidTotalCny: assessment.paidTotalCny, totalCny, ticketTotalCny,
    ...(foreignClaim ? { foreignClaim, fxQuotes, fxNeeded: assessment.fxNeeded } : {}),
    batches: Array.from({ length: Math.ceil(uploadFiles.length / 10) }, (_, index) => uploadFiles.slice(index * 10, index * 10 + 10)),
    paymentKeys: assessment.paymentKeys,
    expenseType: SUBJECTS[subject].expenseType,
    paymentType, signer,
  }, purpose);
}

export async function validatePlanForExecution({ plan, sourceRoot, historyInvoiceNumbers = [], historyPaymentKeys = [] }) {
  if (plan.version !== PLAN_VERSION) throw new Error('检查规则已更新，请重新检查文件夹');
  if ((plan.sourceFolders || [plan.folder]).some(isReimbursedFolder)) throw new Error('已报销文件夹已归档，不能执行');
  if (plan.reimbursementRoute !== 'smart' && plan.reimbursementRoute !== 'legacy') {
    throw new Error(reimbursementRestriction(plan.reimbursementRoute, plan.subject) || '办理系统待核对，请重新检查文件夹');
  }
  if (plan.status !== 'ready' || plan.blockers?.length) throw new Error(`报销计划尚不能填报：${(plan.blockers || []).join('；')}`);
  validateClaimPurpose(plan);
  if (!Number.isSafeInteger(plan.totalCny) || plan.totalCny <= 0 || plan.rows.length === 0) throw new Error('当前计划不能自动执行');
  if (plan.projectAllocationDraft) {
    const { error } = allocateProjects(plan.projectAllocationDraft, plan.totalCny);
    if (error) throw new Error(error);
  }
  if (plan.reimbursementRoute === 'legacy' && (plan.projectAllocationDraft || plan.uploadFiles.length || !Number.isSafeInteger(plan.attachmentCount) || plan.attachmentCount < 1 || plan.attachmentCount > 50)) throw new Error('请核对线下报销的经费项目和纸质附件张数');
  if (plan.reimbursementRoute === 'smart' && plan.rows.some((row) => !AUTOMATIC_INVOICE_NUMBER.test(row.invoiceNumber))) throw new Error('当前仅支持完整20位电子发票号码，请人工核对其他票据身份');
  const invoiceNumbers = plan.rows.map((row) => row.invoiceNumber).filter(Boolean);
  if (new Set(invoiceNumbers).size !== invoiceNumbers.length) throw new Error('计划包含重复发票，请重新检查');
  const travel = plan.subject === '差旅';
  const invalidInvoiceAmount = plan.rows.some((row) => {
    if (![row.paidAmountCny, row.invoiceAmountCny, row.reimbursementAmountCny].every(Number.isSafeInteger)) return true;
    const max = Math.min(row.invoiceAmountCny, row.paidAmountCny);
    return travel && row.travelKind === 'lodging' ? row.reimbursementAmountCny < 0 || row.reimbursementAmountCny > max : row.reimbursementAmountCny !== max;
  });
  const totalMatches = travel ? validTravelAmounts(plan) : plan.rows.reduce((total, row) => total + row.reimbursementAmountCny, 0) === plan.totalCny;
  if (invalidInvoiceAmount || !totalMatches) throw new Error('计划金额校验失败，请重新检查');
  if (plan.rows.some((row) => historyInvoiceNumbers.includes(row.invoiceNumber))) throw new Error('发票已在另一笔任务提交，不能重复报销');
  if (plan.paymentKeys.some((key) => historyPaymentKeys.includes(key))) throw new Error('本笔付款已记入另一报销单，请核对原单和费用归属');
  for (const quote of plan.fxQuotes || []) {
    const bytes = await readFile(quote.absolutePath).catch(() => null);
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== quote.sha256) throw new Error('中行牌价截图已变化，请重新核对');
  }
  const current = await fingerprintPlan(sourceRoot, plan);
  if (current.fingerprint !== plan.fingerprint) throw new Error('附件已变化，原计划已失效，请重新检查文件夹');
  return plan;
}

export function publicPlan(plan) {
  const { paymentKeys, materialBlockers, materialWarnings, fxQuotes, ...visible } = plan;
  if (visible.subject === '劳务费') visible.reimbursementRoute = 'labor';
  if (visible.blockers) visible.blockers = visible.blockers.map((message) => message.replaceAll('旧财务报销系统', '学校财务系统'));
  return { ...visible, ...(fxQuotes ? { fxQuotes: fxQuotes.map(({ absolutePath, sha256, ...quote }) => quote) } : {}), uploadFiles: plan.uploadFiles.map((file) => file.name), batches: plan.batches.map((batch) => batch.map((file) => file.name)) };
}

export function fileAbsolutePath(plan, file) {
  return file.absolutePath;
}

export function planFileNames(plan) {
  return plan.uploadFiles.map((file) => basename(file.absolutePath));
}
