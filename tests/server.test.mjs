import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, rename, writeFile, readFile, access, stat, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cachedFixture, concretePurpose } from './fixtures.mjs';
import { requestRoute } from './request-fixture.mjs';
import { readModelSettings } from '../lib/model-settings.mjs';
import { planProjects } from '../public/project-allocation.js';
import { BOC_HISTORY } from '../lib/boc-rates.mjs';
import { pythonExecutable } from '../lib/platform.mjs';

const source = dirname(dirname(fileURLToPath(import.meta.url)));

async function addSourceFixture(t, app, options = {}) {
  const item = await cachedFixture(t, { folder: 'second', invoiceNumber: '12345678901234567891', orderNumber: '2234567890123456', paymentId: 'PAY-0002', invoice: 20000, order: 20000, payment: 20000, ...options });
  await cp(item.batchDir, join(app.sourceRoot, item.folder), { recursive: true });
  await cp(join(item.appDir, '.runtime/cache', encodeURIComponent(item.folder)), join(app.appDir, '.runtime/cache', encodeURIComponent(item.folder)), { recursive: true });
  return item.folder;
}

async function matchClaimProject(app, folder, project) {
  const matched = await app.request('/api/project-match', {
    sourceRoot: app.sourceRoot, folder, match: { ...project, funding: '教学' },
  });
  assert.equal(matched.status, 200, JSON.stringify(matched.body));
}

test('research project routing is stored in the local profile and applies to new matches after restart', async (t) => {
  const app = await setup(t);
  const research = { projectNo: 'DEMO-2099-R1', projectName: '虚构科研项目' };
  const teaching = { projectNo: 'DEMO-2099-T1', projectName: '虚构教学项目' };
  const sourceRoot = app.sourceRoot;
  assert.deepEqual((await app.request('/api/config')).body.preferences.researchProjectNos, []);
  const settings = await app.request('/api/config', { sourceRoot, preferences: { researchProjectNos: [' demo-2099-r1 ', 'DEMO-2099-R1'] } });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.body.preferences.researchProjectNos, [research.projectNo]);
  const invalid = await app.request('/api/config', { sourceRoot, preferences: { researchProjectNos: ['项目 编号'] } });
  assert.equal(invalid.status, 400);
  await app.stop();
  await app.start();
  const save = (match) => app.request('/api/project-match', { sourceRoot, folder: app.folder, match });
  assert.equal((await save({ ...research, funding: '教学' })).body.match.funding, '科研');
  assert.equal((await save({ ...teaching, funding: '教学' })).body.match.funding, '教学');
  const split = await save({ funding: '教学', allocations: [{ ...teaching, amountCny: 100 }, research] });
  assert.equal(split.status, 200);
  assert.equal(split.body.match.funding, '科研');
});

async function setup(t, options = {}) {
  const fixtureCleanup = [];
  const input = await cachedFixture({ after: (cleanup) => fixtureCleanup.push(cleanup) }, options);
  const demoSigners = { 教学: { name: '示例教学加签人', employeeNo: '980001' }, 科研: { name: '示例科研加签人', employeeNo: '' } };
  const code = join(input.appDir, 'code');
  await mkdir(code, { recursive: true });
  await cp(join(source, 'server.mjs'), join(code, 'server.mjs'));
  await cp(join(source, 'lib'), join(code, 'lib'), { recursive: true });
  await mkdir(join(code, 'public'));
  await cp(join(source, 'public/project-allocation.js'), join(code, 'public/project-allocation.js'));
  if (options.payrollHistory || options.fundingExport) {
    await mkdir(join(code, 'scripts'));
    await cp(join(source, 'scripts/read_funding_exports.py'), join(code, 'scripts/read_funding_exports.py'));
  }
  const started = join(input.appDir, '.runtime/fake-browser-started');
  const loginReady = join(input.appDir, '.runtime/login-ready');
  const previewExecution = `
    const originalTarget = 'test-original-school-tab';
    if (this.control.progress.uploadPageId) {
      if (!this.resumeStages || this.control.progress.uploadPageId !== originalTarget ||
          this.control.progress.fillingId !== 'test-original-draft' || this.control.skipSubmit || this.control.autoSubmit) {
        throw Error('须从原草稿接回，并等待确认');
      }
    } else {
      this.control.progress.uploadPageId = originalTarget;
      this.control.progress.fillingId = 'test-original-draft';
      await this.onProgress();
    }
    await this.ask('核对模拟草稿后再确认提交', { kind: 'final_approval' });
    return 'preview';`;
  const amountReviewExecution = `
    const reply = await this.ask('请在学校页面核对金额，再回复重新核对。', { kind: 'amount_review' });
    if (reply !== '继续') throw Error('unexpected amount review reply');
    return 'preview';`;
  const waitingExecution = options.projectExpenseQuestion
    ? "return await this.ask('本笔请选择费用科目',{kind:'project_expense_type',choices:[{value:'1',label:'办公费'},{value:'2',label:'其他教学杂项费用'}]});"
    : options.amountReviewQuestion ? amountReviewExecution : "await this.ask('本地测试等待用户输入',{kind:'pause'});return 'preview';";
  await writeFile(join(code, 'lib/executor.mjs'), `import {access, writeFile} from 'node:fs/promises';
export class ReimbursementExecutor {
constructor(options){Object.assign(this,options);}
async run(){${options.requireLogin ? `await access(${JSON.stringify(loginReady)}).catch(()=>{throw new Error('未找到学校财务首页的“智能网报5.0”。请检查专用浏览器的校园网登录状态。');});` : ''}await writeFile(${JSON.stringify(started)},'started');this.control.progress.ownedDocument=true;await this.onProgress();${options.previewExecution ? previewExecution : options.submit ? "this.control.progress.submission={state:'verified',financeFormId:'TEST-SCHOOL-123',verifiedAt:new Date().toISOString()};await this.onProgress();return 'submitted';" : waitingExecution}}
}
`);
  await writeFile(join(code, 'lib/browser-session.mjs'), `export async function getBrowserSession(){throw Error('test must not open any financial browser');} export async function savePlatformSession(){} export async function savedPlatformUrl(){return '';} export async function browserTargetId(){return null;} export async function browserPageForTarget(){return null;}`);
  const appointmentAttempts = join(input.appDir, 'appointment-attempts');
  const appointmentReady = join(input.appDir, 'appointment-ready');
  if (options.schoolBooking) await writeFile(join(code, 'lib/school-finance-runner.mjs'), `
import { access, appendFile } from 'node:fs/promises';
export async function preparePayrollHeader(){throw Error('test must not fill payroll');}
export const fillPayrollHeader = preparePayrollHeader;
export const workspaceFor = preparePayrollHeader;
export async function executeDailySchoolBooking({control, plan, persist, record}){
  const {progress} = control;
  if(progress.submission.state === 'not_started'){
    await appendFile(${JSON.stringify(appointmentAttempts)}, 'submit\\n');
    progress.booking = { appointment: { date:'2026-11-13' } };
    progress.submission = { state:'attempted', fingerprint:plan.fingerprint };
    await persist();
  }
  await access(${JSON.stringify(appointmentReady)}).catch(()=>{ throw Error('学校原单查询尚未完成'); });
  progress.submission = { state:'verified', financeFormId:'9999999999901', verifiedAt:new Date().toISOString() };
  await persist();
  await record();
  progress.booking.pdfName = '报销预约单-9999999999901.pdf';
  progress.booking.printState = 'saved';
  await persist();
  return 'booked';
}
`);
  if (options.payrollExecution) await writeFile(join(code, 'lib/school-payroll-executor.mjs'), `
import {access, appendFile} from 'node:fs/promises';
export async function executeSchoolPayroll({plan, payroll, control, validate, persist, record, stage}) {
  if (control.progress.submission.state === 'verified') { await record(); return 'declared'; }
  await validate();
  if(plan.reimbursementRoute !== 'labor' || payroll.people.length !== plan.peopleCount || !plan.signer?.name) throw new Error('未按薪酬事项接入学校执行');
  const financeFormId = plan.reason.includes('首笔') ? 'TEST-LABOR-001' : 'TEST-LABOR-002';
  if (${options.payrollExecution === 'restart'} && financeFormId.endsWith('001')) {
    if (!control.progress.payroll?.approvalAttemptedAt) {
      control.progress.payroll = { declareId:'draft-original', financeFormId, approvalAttemptedAt:new Date().toISOString() };
      stage('正在等学校回执');
      await persist();
      await appendFile(${JSON.stringify(appointmentAttempts)}, 'confirm\\n');
    }
    if (control.progress.payroll.declareId !== 'draft-original') throw Error('未找到原草稿');
    const ready = await access(${JSON.stringify(appointmentReady)}).then(()=>true,()=>false);
    if (!ready) return new Promise(()=>{});
  }
  control.progress.submission = {state:'verified', financeFormId, verifiedAt:new Date().toISOString()};
  await persist();
  if (${options.payrollExecution === 'restart'} && financeFormId.endsWith('001')) return new Promise(()=>{});
  await record();
  return 'declared';
}
`);
  await writeFile(join(input.appDir, '.runtime/config.json'), JSON.stringify({ sourceRoot: input.sourceRoot, paymentCardLast4: '1234', configurationRevision: 0, preferences: { signers: options.noSigners ? {} : demoSigners } }));
  if (options.modelSettings) {
    const settings = await readModelSettings(input.appDir);
    settings.models[0].model = options.modelSettings.model || 'demo-test-model';
    settings.assignments.interaction = 'deepseek';
    settings.assignments.recovery = 'deepseek';
    await writeFile(join(input.appDir, '.runtime/model-config.json'), JSON.stringify(settings));
  }
  if (options.fakeCodex) {
    const script = join(code, 'fake-codex.cjs');
    await writeFile(script, options.fakeCodex);
    const codexFile = join(code, 'lib/codex.mjs');
    const codex = (await readFile(codexFile, 'utf8')).replace('spawn(binary, args,', 'spawn(process.execPath, [' + JSON.stringify(script) + ', ...args],');
    await writeFile(codexFile, codex);
  }
  if (options.projects) await writeFile(join(input.appDir, '.runtime/projects.json'), JSON.stringify({ projects: options.projects }));
  if (options.legacyReason || options.signerByFunding) await writeFile(join(input.appDir, '.runtime/memory.json'), JSON.stringify({
    reasonByFolder: { [input.folder]: options.legacyReason }, signerByFunding: options.signerByFunding,
  }));
  const previous = { ...process.env };
  process.env.REIMBURSEMENT_SOURCE_ROOT = input.sourceRoot;
  process.env.REIMBURSEMENT_RUNNER_DATA_DIR = input.appDir;
  process.env.DEEPSEEK_API_KEY = options.modelSettings?.apiKey || '';
  process.env.DEEPSEEK_MODEL = '';
  let handleRequest;
  let incarnation = 0;
  const start = async () => {
    const url = pathToFileURL(join(code, 'server.mjs'));
    url.searchParams.set('instance', String(++incarnation));
    ({ handleRequest } = await import(url));
  };
  const stop = async () => {
    handleRequest = undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  t.after(async () => {
    await stop();
    for (const key of ['REIMBURSEMENT_SOURCE_ROOT', 'REIMBURSEMENT_RUNNER_DATA_DIR', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    for (const cleanup of fixtureCleanup) await cleanup();
  });
  const request = (path, data, method) => requestRoute(handleRequest, path, data, method);
  await start();
  const plan = async (folder = input.folder, { confirm = true, funding = '教学', project = { projectNo: 'TEST-2026-01', projectName: '测试项目' } } = {}) => {
    const response = await request('/api/plans', { folder, subject: input.subject, funding, project });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const checked = response.body.plan;
    if (!confirm) return checked;
    const confirmed = await request(`/api/plans/${checked.id}/purpose`, concretePurpose);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    return confirmed.body.plan;
  };
  return { ...input, plan, request, started, loginReady, appointmentAttempts, appointmentReady, start, stop };
}

test('an export-only withdrawal persists across checks and can be removed locally', async (t) => {
  const app = await setup(t, { fundingExport: true });
  const file = join(app.sourceRoot, '报销单统计.xlsx');
  await cp(join(source, 'examples/2026/报销单统计.xlsx'), file);
  const route = '/api/funding-summary/withdrawal';
  const pending = { sourceRoot: app.sourceRoot, financeId: 'DEMO-SMART-002', confirmed: true };
  const progress = async () => (await app.request('/api/funding-summary')).body.totals.submittedCny;
  const original = await readFile(file);
  assert.equal(await progress(), 45000);
  assert.equal((await app.request(route, { ...pending, confirmed: false })).status, 400);
  assert.equal((await app.request(route, { ...pending, sourceRoot: 'another year' })).status, 409);
  assert.equal((await app.request(route, { ...pending, financeId: 'DEMO-SMART-001' })).status, 409);
  assert.equal((await app.request(route, pending)).status, 200);
  assert.equal((await app.request(route, pending)).status, 200);
  assert.equal(await progress(), 0);
  await app.stop();
  await app.start();
  assert.equal(await progress(), 0);
  assert.equal((await app.request(route, pending, 'DELETE')).status, 200);
  assert.equal(await progress(), 45000);
  assert.deepEqual(await readFile(file), original);
});

test('model settings retain only environment variable names and route enabled interaction', async (t) => {
  const app = await setup(t, {
    modelSettings: { apiKey: 'test-key-preserved', model: 'legacy-test-model' },
    fakeCodex: `let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
      if (!prompt.includes('执行与互动') || !prompt.includes('当前模式为 status')) process.exit(2);
      const model = process.argv[process.argv.indexOf('--model')+1];
      const text = model === 'interaction-test-model' && process.env.REIMBURSEMENT_MODEL_API_KEY === 'test-key-preserved' ? '已按设置调用互动模型' : '配置没有生效';
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
    });`,
  });
  const config = join(app.appDir, '.runtime/model-config.json');
  const read = (await app.request('/api/model-settings')).body;
  assert.equal(read.connections[0].keyConfigured, true);
  assert.equal(read.models[0].model, 'legacy-test-model');
  assert.equal(Object.keys(read.assignments).length, 4);
  assert.equal(JSON.stringify(read).includes('test-key-preserved'), false);
  read.models.push({ id: 'interactive', name: '执行互动模型', connectionId: 'deepseek', model: 'interaction-test-model', effort: 'medium' });
  read.assignments.interaction = 'interactive';
  const saved = await app.request('/api/model-settings', read);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.assignments.interaction, 'interactive');
  assert.equal(saved.body.assignments.recovery, 'deepseek');
  assert.equal(JSON.stringify(saved.body).includes('test-key-preserved'), false);
  if (process.platform !== 'win32') assert.equal((await stat(config)).mode & 0o777, 0o600);
  const written = await readFile(config, 'utf8');
  assert.equal(JSON.parse(written).connections[0].keyEnv, 'DEEPSEEK_API_KEY');
  assert.doesNotMatch(written, /test-key-preserved/);
  assert.equal((await app.request('/api/chat', { message: '查看执行状态' })).body.answer, '已按设置调用互动模型');
  const changed = saved.body;
  changed.connections[0].baseUrl = 'https://example.invalid/v1';
  assert.equal((await app.request('/api/model-settings', changed)).status, 400);
  assert.equal(await readFile(config, 'utf8'), written);
  await app.stop();
  await app.start();
  assert.equal((await app.request('/api/model-settings')).body.assignments.interaction, 'interactive');
});

test('a project expense answer is routed to the live question without interpreting project changes', async (t) => {
  const app = await setup(t, { projectExpenseQuestion: true });
  const plan = await app.plan();
  const started = await app.request('/api/runs', { planId: plan.id });
  assert.equal(started.status, 202);
  const route = '/api/runs/' + started.body.run.id;
  const wait = async (status) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { run } = (await app.request(route)).body;
      if (run.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('execution did not reach ' + status);
  };
  assert.equal((await wait('waiting_input')).pendingChoices[1].label, '其他教学杂项费用');
  const ambiguous = await app.request(route + '/instructions', { message: '其他教学杂项费用，108 元换到另一个项目' });
  assert.equal(ambiguous.body.run.status, 'waiting_input');
  assert.match(ambiguous.body.run.messages.at(-1).text, /请选择本笔的费用科目/);
  await app.request(route + '/instructions', { message: '都是 全部填入 其他教育杂项费用' });
  assert.equal((await wait('preview')).result, '2');
});

test('amount review waits through general chat and resumes for an explicit recheck', async (t) => {
  const app = await setup(t, { amountReviewQuestion: true });
  const plan = await app.plan();
  const started = await app.request('/api/runs', { planId: plan.id });
  assert.equal(started.status, 202);
  const route = `/api/runs/${started.body.run.id}`;
  const waitFor = async (status) => {
    const deadline = Date.now() + 2500;
    do {
      const { run } = (await app.request(route)).body;
      if (run.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.fail('execution did not reach ' + status);
  };
  assert.equal((await waitFor('waiting_input')).pendingKind, 'amount_review');
  assert.equal((await app.request(route + '/replies', { message: '这里是什么金额' })).status, 409);
  const chat = await app.request(route + '/instructions', { message: '我在看页面' });
  assert.equal(chat.body.run.status, 'waiting_input');
  assert.match(chat.body.run.messages.at(-1).text, /重新核对/);
  const recheck = await app.request(route + '/instructions', { message: '你来核对下' });
  assert.match(recheck.body.run.messages.at(-1).text, /正在重新读取学校费用明细/);
  await waitFor('preview');
});

test('continuing a batch after campus login resumes the original run', async (t) => {
  const app = await setup(t, {
    requireLogin: true, submit: true, modelSettings: { apiKey: 'test-key' },
    fakeCodex: `let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
      const text = prompt.includes('当前模式为 instruction') ? JSON.stringify({action:'control',control:'resume'}) : '正等校园网登录。';
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
    });`,
  });
  const plan = await app.plan();
  const start = await app.request('/api/batch-runs', { planIds: [plan.id] });
  assert.equal(start.status, 202);
  const { id, runs: [run] } = start.body.batch;
  const waitForBatch = async (status) => {
    const deadline = Date.now() + 2500;
    let batch;
    do {
      batch = (await app.request(`/api/batches/${id}`)).body.batch;
      if (batch.status === status) return batch;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(batch.status, status);
  };
  const failed = await waitForBatch('error');
  assert.match(failed.runs[0].error, /校园网登录状态/);
  await assert.rejects(access(app.started), { code: 'ENOENT' });
  await writeFile(app.loginReady, 'signed in');
  const status = await app.request(`/api/runs/${run.id}/instructions`, { message: '为什么继续没有反应？' });
  assert.equal(status.body.run.status, 'error');
  await assert.rejects(access(app.started), { code: 'ENOENT' });
  const resumed = await app.request(`/api/runs/${run.id}/instructions`, { message: '学校页面弄好了，往下做' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.run.id, run.id);
  assert.ok(['running', 'completed'].includes(resumed.body.run.status), resumed.body.run.status);
  const completed = await waitForBatch('completed');
  assert.equal(completed.runs[0].status, 'completed');
  assert.equal((await app.request('/api/runs')).body.runs.length, 1);
});

test('card configuration survives restart and old plan schemas are not executable', async (t) => {
  const app = await setup(t);
  assert.equal((await app.request('/api/config')).body.paymentCardConfigured, true);
  const plan = await app.plan();
  assert.equal(plan.status, 'ready', JSON.stringify(plan.blockers));
  await app.stop();
  await app.start();
  assert.equal((await app.request('/api/config')).body.paymentCardConfigured, true);
});

test('a foreign-only draft includes its same-day BOC screenshot and exposes the converted amount', async (t) => {
  const app = await setup(t, { omitInvoice: true, order: null, payment: null, subject: '境外软件订阅', extra: [
    { name: 'Invoice-Test.pdf', kind: 'invoice', text: 'Invoice\nInvoice number FX-TEST\nDate of issue September 23, 2026\nAmount due EUR 12.00' },
    { name: '外币付款.png', kind: 'payment', text: '交易成功\n原币金额 EUR 12.00\n支付时间 2026-09-24' },
  ] });
  const first = await app.plan(undefined, { confirm: false });
  assert.equal(first.reimbursementRoute, 'legacy');
  assert.equal(first.totalCny, null);
  assert.deepEqual(first.fxNeeded, [{ date: '2026-09-24', currency: 'EUR' }]);
  assert.equal((await app.request(`/api/plans/${first.id}/fx-quote`, { date: '2026-09-23', currency: 'EUR' })).status, 400);
  const directory = join(app.appDir, '.runtime/boc-rates');
  await mkdir(directory);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=', 'base64');
  const key = '2026-09-24-EUR';
  const name = `中国银行外汇牌价-${key}.png`;
  const path = join(directory, name);
  await writeFile(path, png);
  await writeFile(join(directory, `${key}.json`), JSON.stringify({ date: '2026-09-24', currency: 'EUR', ratePer100: '801.34', quotedAt: '2026-09-24 12:00:00', sourceUrl: BOC_HISTORY, column: '中行折算价', sha256: createHash('sha256').update(png).digest('hex') }));
  assert.equal((await app.request(`/api/plans/${first.id}/fx-quote`, { date: '2026-09-24', currency: 'EUR' })).status, 200);
  const ready = await app.plan(undefined, { confirm: false });
  assert.equal(ready.totalCny, 9616);
  assert.equal(ready.reimbursementRoute, 'legacy');
  assert.ok(ready.paperFiles.includes(name));
  assert.deepEqual(ready.uploadFiles, []);
  assert.equal(ready.attachmentCount, 3);
  assert.equal(ready.fxQuotes[0].absolutePath, undefined);
  assert.deepEqual(ready.fxNeeded, []);
  const download = `/api/plans/${ready.id}/fx-quote/${key}`;
  const response = await app.request(download);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(response.body, png);
  const confirmed = await app.request(`/api/plans/${ready.id}/purpose`, concretePurpose);
  assert.equal(confirmed.status, 200);
  const { id } = confirmed.body.plan;
  await writeFile(path, 'changed');
  assert.equal((await app.request(`/api/plans/${id}/fx-quote/${key}`)).status, 409);
  const batch = await app.request('/api/batch-runs', { planIds: [id] });
  assert.equal(batch.status, 409);
  assert.match(batch.body.error, /牌价截图已变化/);
  assert.equal((await app.request('/api/runs')).body.runs.length, 0);
});

test('a school appointment resumes its original receipt after restart without repeating submission', async (t) => {
  const app = await setup(t, { schoolBooking: true });
  const smart = await app.plan();
  const override = await app.request('/api/plan-override', { folder: smart.folder, bookingOptions: { offline: true, attachmentCount: 2 } });
  assert.equal(override.status, 200);
  assert.equal(override.body.recheck, true);
  const plan = await app.plan();
  assert.equal(plan.reimbursementRoute, 'legacy');
  assert.equal(plan.attachmentCount, 2);
  assert.deepEqual(plan.uploadFiles, []);
  assert.equal(plan.status, 'ready');
  const start = await app.request('/api/runs', { planId: plan.id });
  assert.equal(start.status, 202);
  const route = `/api/runs/${start.body.run.id}`;
  const wait = async (status) => {
    for (let retry = 0; retry < 40; retry += 1) {
      const { run } = (await app.request(route)).body;
      if (run.status === status) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('run did not reach ' + status);
  };
  await wait('verification_required');
  await app.stop();
  await app.start();
  await writeFile(app.appointmentReady, '');
  assert.ok([200, 202].includes((await app.request(route + '/instructions', { message: '继续' })).status));
  const run = await wait('completed');
  assert.equal(run.appointment.financeFormId, '9999999999901');
  assert.equal(run.appointment.date, '2026-11-13');
  assert.equal(await readFile(app.appointmentAttempts, 'utf8'), 'submit\n');
  await access(app.batchDir);
  const { claims, folders } = (await app.request('/api/folders')).body;
  assert.equal(claims.find((item) => item.path === app.folder).submission.appointment, '2026-11-13');
  assert.equal(folders.find((item) => item.path === app.folder).reimbursed, true);
  assert.equal((await app.request('/api/runs', { planId: plan.id })).status, 409);
});

test('payroll intake requires each purpose and uses the grant type to choose the signer', async (t) => {
  const project = { projectNo: 'TEST-2026-01', projectName: '模拟课程经费' };
  const app = await setup(t, { projects: [project] });
  const input = {
    sourceRoot: app.sourceRoot, category: '校外人员劳务费',
    grantType: '非科研项目', reason: '为案例开发整理访谈资料',
    people: [
      { name: '模拟人员', position: '副高', hours: '1.5', amount: '123.45', expenseItem: '讲座费', purpose: '整理金融数据分析课程案例的访谈记录' },
      { name: '模拟助理', position: '其他', hours: '1', amount: '100.00', purpose: '校对案例中的变量名称与问卷编码' },
    ],
  };
  const missing = await app.request('/api/payroll-claims', { ...input, people: [input.people[0], { ...input.people[1], purpose: '  ' }] });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /第 2 条用途/);
  const invalid = await app.request('/api/payroll-claims', { ...input, people: [{ ...input.people[0], expenseItem: '办公费' }] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /费用项/);
  const saved = await app.request('/api/payroll-claims', input);
  assert.equal(saved.status, 201);
  const route = '/api/payroll-claims/' + saved.body.id;
  const unmatched = (await app.request(route)).body;
  assert.equal(unmatched.project, null);
  assert.equal((await app.request(route + '/prepare', { sourceRoot: app.sourceRoot })).status, 409);
  assert.equal((await app.request('/api/batch-runs', { entries: [{ payrollId: saved.body.id, revision: unmatched.revision }] })).status, 409);
  await matchClaimProject(app, saved.body.key, project);
  await app.stop();
  await app.start();
  const list = (await app.request('/api/folders')).body;
  const claim = list.claims.find((item) => item.path === saved.body.key);
  assert.deepEqual(claim.payroll, { category: input.category, peopleCount: 2, totalCny: 22345, signerName: '示例教学加签人', revision: claim.payroll.revision, blocker: '' });
  assert.doesNotMatch(JSON.stringify(list), /模拟人员|001X|问卷编码/);
  const { body: draft } = await app.request(route);
  assert.equal(claim.payroll.revision, draft.revision);
  assert.notEqual(draft.revision, unmatched.revision);
  assert.equal(draft.project.projectNo, project.projectNo);
  assert.equal(draft.department, undefined);
  assert.equal(draft.people[0].identityTail, undefined);
  assert.equal(draft.people[0].position, '副高');
  assert.equal(draft.people[0].expenseItem, '讲座费');
  assert.equal(draft.people[0].amountCny, 12345);
  assert.deepEqual(draft.people.map(({ purpose }) => purpose), input.people.map(({ purpose }) => purpose));
  assert.equal(draft.signer.name, '示例教学加签人');
  const update = await app.request(route, { ...input, revision: draft.revision, grantType: '科研项目' }, 'PUT');
  assert.equal(update.status, 200);
  assert.equal((await app.request(route)).body.project.projectNo, project.projectNo);
  assert.equal((await app.request(route)).body.signer.name, '示例科研加签人');
  assert.equal((await app.request(route, { ...input, revision: draft.revision }, 'PUT')).status, 409);
  const prepared = await app.request(route + '/prepare', { sourceRoot: app.sourceRoot });
  assert.equal(prepared.status, 202);
  assert.deepEqual(prepared.body.run.plan.signer, { name: '示例科研加签人', employeeNo: '' });
  assert.doesNotMatch(JSON.stringify(prepared.body), /模拟人员|001X|问卷编码/);
});

test('Didi saves a budget, matches in the worklist and starts an independent smart reimbursement', async (t) => {
  const project = { projectNo: 'TEST-2026-01', projectName: '模拟课程经费' };
  const another = { projectNo: 'TEST-2026-02', projectName: '另一经费' };
  const app = await setup(t, { projects: [project, another] });
  const scope = { sourceRoot: app.sourceRoot };
  const worklist = async (key) => (await app.request('/api/folders')).body.claims.find((item) => item.path === key);
  const run = (id, revision) => app.request('/api/batch-runs', { entries: [{ didiId: id, revision }] });
  assert.equal((await app.request('/api/didi-claims', { ...scope, budget: '25.999' })).status, 400);
  const { status, body: { id, key } } = await app.request('/api/didi-claims', { ...scope, budget: '150.25' });
  assert.equal(status, 201);
  const unmatched = await worklist(key);
  assert.equal(unmatched.match, null);
  assert.equal(unmatched.didi.budgetCny, 15025);
  assert.deepEqual(unmatched.sourceFolders, []);
  assert.equal((await run(id, unmatched.didi.revision)).status, 409);
  const reason = { ...scope, folder: key, reason: '走访金融实训合作企业的用车费用', explicit: true };
  await matchClaimProject(app, key, project);
  assert.match((await worklist(key)).didi.blocker, /事由/);
  assert.equal((await app.request('/api/claim-reason', reason)).body.blocker, '');
  await matchClaimProject(app, key, another);
  assert.match((await worklist(key)).didi.blocker, /事由/);
  assert.equal((await app.request('/api/claim-reason', reason)).body.blocker, '');
  const beforeEdit = (await worklist(key)).didi.revision;
  assert.equal((await app.request('/api/didi-claims/' + id, { ...scope, budget: '149.95' }, 'PUT')).status, 200);
  assert.equal((await run(id, beforeEdit)).status, 409);
  await app.stop();
  await app.start();
  const ready = await worklist(key);
  assert.equal(ready.didi.blocker, '');
  assert.equal(ready.didi.budgetCny, 14995);
  assert.equal(ready.match.projectNo, another.projectNo);
  const started = await run(id, ready.didi.revision);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const plan = started.body.batch.runs[0].plan;
  assert.equal(plan.claimType, '贸大出行');
  assert.equal(plan.reimbursementRoute, 'smart');
  assert.equal(plan.totalCny, null);
  assert.deepEqual(plan.rows, []);
  assert.deepEqual(plan.uploadFiles, []);
  assert.equal(plan.project.projectNo, another.projectNo);
});

test('a Didi draft can resume after restart and the claim can be removed after the draft is abandoned', async (t) => {
  const project = { projectNo: 'TEST-2026-01', projectName: '模拟课程经费' };
  const app = await setup(t, { projects: [project], previewExecution: true });
  const scope = { sourceRoot: app.sourceRoot };
  const created = await app.request('/api/didi-claims', { ...scope, budget: '150.25' });
  assert.equal(created.status, 201);
  const { id, key } = created.body;
  await matchClaimProject(app, key, project);
  assert.equal((await app.request('/api/claim-reason', {
    ...scope, folder: key, reason: '走访金融实训合作企业的用车费用', explicit: true,
  })).body.blocker, '');
  const worklist = async () => (await app.request('/api/folders')).body.claims.find(({ path }) => path === key);
  const entries = [{ didiId: id, revision: (await worklist()).didi.revision }];
  const started = await app.request('/api/batch-runs', { entries });
  assert.equal(started.status, 202);
  const batchId = started.body.batch.id;
  const runId = started.body.batch.runs[0].id;
  const route = `/api/runs/${runId}`;
  const instruction = (message) => app.request(`${route}/instructions`, { message });
  const waitForBatch = async (predicate) => {
    const deadline = Date.now() + 2500;
    let batch;
    do {
      batch = (await app.request(`/api/batches/${batchId}`)).body.batch;
      if (predicate(batch)) return batch;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.fail(`unexpected batch status: ${batch.status}; ${batch.runs[0].status}; ${batch.runs[0].error}`);
  };
  const approval = (batch) => batch.runs[0].pendingKind === 'final_approval';
  const preview = (batch) => batch.status === 'preview';
  await waitForBatch(approval);
  assert.equal((await instruction('先别提交')).status, 200);
  await waitForBatch(preview);
  await app.stop();
  await app.start();
  const blocked = (await app.request('/api/runs')).body;
  assert.equal(blocked.blockingRunId, runId);
  assert.equal(blocked.runs[0].canResumePreview, true);
  assert.equal((await app.request('/api/batch-runs', { entries })).status, 409);
  const remove = () => app.request(`/api/didi-claims/${id}`, scope, 'DELETE');
  assert.equal((await remove()).status, 409);

  const resumed = await instruction('继续');
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.batch.id, batchId);
  assert.equal(resumed.body.run.id, runId);
  await waitForBatch(approval);
  assert.equal((await instruction('先别提交')).status, 200);
  await waitForBatch(preview);
  const resolveDraft = (confirmed) => app.request(`${route}/resolution`, { confirmed, resolution: 'abandon_draft' });
  const deadline = Date.now() + 2500;
  let unconfirmed = await resolveDraft(false);
  while (unconfirmed.status === 409 && unconfirmed.body.error.includes('本任务正在处理') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    unconfirmed = await resolveDraft(false);
  }
  assert.equal(unconfirmed.status, 400, JSON.stringify(unconfirmed.body));
  const resolved = await resolveDraft(true);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.run.status, 'abandoned');
  await waitForBatch((batch) => batch.status === 'abandoned');
  assert.equal((await app.request('/api/runs')).body.blockingRunId, null);
  assert.equal((await remove()).status, 200);
  assert.equal(await worklist(), undefined);
});

test('payroll only remembers the selected person when historical recipients share a name', async (t) => {
  const category = '学生劳务费';
  const project = { projectNo: 'TEST-2026-01', projectName: '模拟课程经费' };
  const app = await setup(t, { payrollHistory: true, projects: [project] });
  const exportFile = join(app.sourceRoot, category + '导出.xlsx');
  execFileSync(pythonExecutable(), ['-X', 'utf8', '-c', [
    'from openpyxl import Workbook',
    'import sys',
    'book = Workbook()',
    'sheet = book.active',
    "sheet.append(['单据编号', '人员', '工号/人员号', '发放日期', '所属部门'])",
    "sheet.append(['ONE', '模拟同名', 'ST00001234', '2026-06-03', '模拟一院'])",
    "sheet.append(['TWO', '模拟同名', 'ST00005678', '2026-06-09', '模拟二院'])",
    "sheet.append(['THREE', '模拟同名', 'ST00005678', '2026-07-08', '模拟二院'])",
    "sheet.append(['DRAFT', '未发放人员', 'ST00009999', '', '模拟二院'])",
    'book.save(sys.argv[1])',
  ].join('\n'), exportFile]);
  const list = '/api/payroll-people?category=' + encodeURIComponent(category);
  const before = (await app.request(list)).body;
  assert.equal(before.historyAvailable, true);
  assert.deepEqual(before.people.map(({ identityTail }) => identityTail), ['1234', '5678']);
  assert.doesNotMatch(JSON.stringify(before), /ST0000|未发放人员/);
  assert.ok(before.people.every((person) => !person.confirmed));
  const confirm = { sourceRoot: app.sourceRoot, category, key: before.people[1].key, name: '模拟同名' };
  assert.equal((await app.request('/api/payroll-people/confirm', { ...confirm, name: '另一个人' })).status, 409);
  const selected = await app.request('/api/payroll-people/confirm', confirm);
  assert.equal(selected.status, 200);
  assert.equal(selected.body.person.identityTail, '5678');

  const draft = await app.request('/api/payroll-claims', {
    sourceRoot: app.sourceRoot, projectNo: project.projectNo, category, grantType: '非科研项目', reason: '整理实训数据',
    people: [{ name: '模拟同名', recipientKey: confirm.key, identityTail: '1234', position: '其他', amount: '10', purpose: '整理实训数据和变量编码' }],
  });
  assert.equal(draft.status, 201);
  const person = (await app.request('/api/payroll-claims/' + draft.body.id)).body.people[0];
  assert.equal(person.identityTail, '5678');
  await app.stop();
  await rename(exportFile, join(app.sourceRoot, '旧执行表.xlsx'));
  await app.start();
  const restored = (await app.request(list)).body.people;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].key, confirm.key);
  assert.equal(restored[0].confirmed, true);
  assert.doesNotMatch(await readFile(join(app.appDir, '.runtime/payroll-recipients.json'), 'utf8'), /ST00005678/);
});

test('selected payroll declarations and regular reimbursements run in the same batch', async (t) => {
  const project = { projectNo: 'TEST-2026-01', projectName: '模拟课程经费' };
  const app = await setup(t, { payrollExecution: true, submit: true, projects: [project] });
  const smart = await app.plan();
  const entries = [];
  for (const reason of ['首笔整理案例资料', '第二笔核对访谈记录']) {
    const saved = await app.request('/api/payroll-claims', {
      sourceRoot: app.sourceRoot, category: '校外人员劳务费', grantType: '非科研项目', reason,
      people: [{ name: '模拟人员', position: '其他', hours: '1', amount: '10', purpose: reason }],
    });
    assert.equal(saved.status, 201);
    await matchClaimProject(app, saved.body.key, project);
    const draft = (await app.request('/api/payroll-claims/' + saved.body.id)).body;
    entries.push({ payrollId: saved.body.id, revision: draft.revision });
  }
  const stale = await app.request('/api/batch-runs', { entries: [{ ...entries[0], revision: 'old' }] });
  assert.equal(stale.status, 409);
  const started = await app.request('/api/batch-runs', { entries: [entries[0], { planId: smart.id }, entries[1]] });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual(started.body.batch.runs.map(({ plan }) => plan.reimbursementRoute), ['labor', 'smart', 'labor']);
  const route = '/api/batches/' + started.body.batch.id;
  let batch;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    batch = (await app.request(route)).body.batch;
    if (batch.status !== 'running' && batch.status !== 'queued') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(batch.status, 'completed', JSON.stringify(batch));
  assert.deepEqual(batch.runs.map((run) => run.result), ['declared', 'submitted', 'declared']);
  const folders = (await app.request('/api/folders')).body;
  for (const entry of entries) {
    const claim = folders.claims.find((item) => item.groupId === entry.payrollId);
    assert.equal(claim.reimbursed, true);
    assert.equal(claim.submission.payroll, true);
    assert.match(claim.submission.financeFormId, /^TEST-LABOR-00[12]$/);
  }
});

test('restart leaves unverified payroll pending until explicitly asked to check the original receipt', async (t) => {
  const project = { projectNo: 'TEST-2026-01', projectName: '模拟课程经费' };
  const app = await setup(t, { payrollExecution: 'restart', projects: [project] });
  const entries = [];
  for (const reason of ['首笔整理资料', '第二笔核对记录']) {
    const saved = await app.request('/api/payroll-claims', {
      sourceRoot: app.sourceRoot, category: '校外人员劳务费', grantType: '非科研项目', reason,
      people: [{ name: '模拟人员', position: '其他', hours: '1', amount: '10', purpose: reason }],
    });
    assert.equal(saved.status, 201);
    await matchClaimProject(app, saved.body.key, project);
    const { body: draft } = await app.request('/api/payroll-claims/' + saved.body.id);
    entries.push({ payrollId: saved.body.id, revision: draft.revision });
  }
  const { status, body } = await app.request('/api/batch-runs', { entries });
  assert.equal(status, 202);
  const route = '/api/batches/' + body.batch.id;
  for (let attempt = 0; attempt < 40 && !await access(app.appointmentAttempts).then(() => true, () => false); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await readFile(app.appointmentAttempts, 'utf8'), 'confirm\n');
  const before = (await app.request(route)).body.batch.runs[0];
  assert.equal(before.schoolDraftNo, 'TEST-LABOR-001');
  assert.equal(before.schoolStep, '正在等学校回执');
  await app.stop();
  await writeFile(app.appointmentReady, '');
  await app.start();
  const interrupted = (await app.request(route)).body.batch;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.runs[0].status, 'verification_required');
  assert.equal(interrupted.runs[1].status, 'stopped');
  assert.equal(await readFile(app.appointmentAttempts, 'utf8'), 'confirm\n');
});

test('foreign invoice paid in RMB uses the smart route and keeps the existing invoice compatibility check', async (t) => {
  const app = await setup(t, { omitInvoice: true, order: null, payment: null, subject: '境外软件订阅', extra: [
    { name: 'Invoice-Test.pdf', kind: 'invoice', text: 'Invoice\nInvoice number FX-TEST\nDate of issue September 24, 2026\nAmount due USD 20.00' },
    { name: '人民币支付.png', kind: 'payment', text: '交易成功\n原币金额 USD 20.00\n人民币实际扣款 140.10\n支付时间 2026-09-24' },
  ] });
  const plan = await app.plan();
  assert.equal(plan.reimbursementRoute, 'smart');
  assert.equal(plan.totalCny, 14010);
  assert.deepEqual(plan.fxNeeded, []);
  assert.deepEqual(plan.fxQuotes, []);
  assert.match(plan.blockers.join(' '), /20 位电子发票/);
  assert.doesNotMatch(plan.blockers.join(' '), /旧财务|线下/);
});

test('a labor matter keeps its sources, reason and funding while staying outside both smart submission routes', async (t) => {
  const app = await setup(t, { extra: [{ name: '劳务发放清单.xlsx', kind: 'other', text: '模拟劳务发放清单' }] });
  const create = await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders: [app.folder], subject: '劳务费' });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const group = create.body.group;
  const project = { projectNo: 'TEST-2026-01', projectName: '测试项目', funding: '教学' };
  const reason = '支付金融数据案例建设所需的案例整理劳务费';
  assert.equal((await app.request('/api/project-match', { sourceRoot: app.sourceRoot, folder: group.key, match: project })).status, 200);
  assert.equal((await app.request('/api/claim-reason', { sourceRoot: app.sourceRoot, folder: group.key, reason, explicit: true })).status, 200);
  for (const afterRestart of [false, true]) {
    if (afterRestart) {
      await app.stop();
      await app.start();
    }
    const plan = await app.plan(group.key, { confirm: false });
    assert.equal(plan.subject, '劳务费');
    assert.equal(plan.reimbursementRoute, 'labor');
    assert.equal(plan.reason, reason);
    assert.equal(plan.project.projectNo, project.projectNo);
    assert.deepEqual(plan.sourceFolders, [app.folder]);
    assert.ok(plan.supportingFiles.includes('劳务发放清单.xlsx'));
    assert.deepEqual(plan.rows, []);
    assert.deepEqual(plan.uploadFiles, []);
    assert.equal(plan.totalCny, null);
    assert.match((await app.request('/api/runs', { planId: plan.id })).body.error, /薪酬申报/);
    assert.match((await app.request('/api/batch-runs', { planIds: [plan.id] })).body.error, /薪酬申报/);
    assert.equal((await app.request('/api/runs')).body.runs.length, 0);
  }
});

test('merged matters persist sources, reasons and project matches and execute as one claim', async (t) => {
  const app = await setup(t);
  const second = await addSourceFixture(t, app);
  const created = await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders: [app.folder, second], subject: 'AI服务' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const group = created.body.group;
  const reason = '金融文本分析课程实训所需的年报提取模型调用';
  assert.equal((await app.request('/api/claim-reason', { sourceRoot: app.sourceRoot, folder: group.key, reason, explicit: true })).status, 200);
  assert.equal((await app.request('/api/project-match', { sourceRoot: app.sourceRoot, folder: group.key, match: { projectNo: 'TEST-2026-01', projectName: '测试项目', funding: '教学' } })).status, 200);
  let plan = await app.plan(group.key, { confirm: false });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.blockers));
  assert.equal(plan.reason, reason);
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.totalCny, 29000);
  const duplicate = await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders: [second] });
  assert.equal(duplicate.status, 409);
  await app.stop();
  await app.start();
  const folders = (await app.request('/api/folders')).body;
  const restored = folders.claims.find((item) => item.path === group.key);
  assert.deepEqual(restored.sourceFolders, [app.folder, second]);
  assert.equal(restored.reasonDraft, reason);
  assert.equal(restored.match.projectNo, 'TEST-2026-01');
  assert.deepEqual((await app.request('/api/runs')).body.runs, []);
  assert.ok(folders.folders.filter((item) => !item.reimbursed).every((item) => item.claimKey === group.key));
  plan = await app.plan(group.key, { confirm: false });
  const execution = await app.request('/api/batch-runs', { planIds: [plan.id] });
  assert.equal(execution.status, 202);
  assert.equal(execution.body.batch.runs.length, 1);
  assert.equal(execution.body.batch.runs[0].plan.rows.length, 2);
  assert.equal((await app.request('/api/claim-groups/' + group.id, { sourceRoot: app.sourceRoot, folders: [app.folder] }, 'PUT')).status, 409);
  await app.stop();
});

test('a merged draft saves its route before checking and keeps its purpose and match when switched', async (t) => {
  const app = await setup(t);
  const second = await addSourceFixture(t, app);
  const root = { sourceRoot: app.sourceRoot };
  const project = { projectNo: 'TEST-2026-01', projectName: '测试项目', funding: '教学' };
  const reason = '金融文本分析实训所需的案例讲义和课堂演示材料';
  const result = await app.request('/api/claim-groups', { ...root, folders: [app.folder, second], subject: 'AI服务', reimbursementRoute: 'legacy' });
  assert.equal(result.status, 201);
  const { key, id } = result.body.group;
  const draft = async () => (await app.request('/api/folders')).body.claims.find((item) => item.path === key);
  assert.equal((await draft()).offlineBooking, true);
  assert.equal((await app.request('/api/project-match', { ...root, folder: key, match: project })).status, 200);
  assert.equal((await app.request('/api/claim-reason', { ...root, folder: key, reason, explicit: true })).status, 200);
  const first = await app.plan(key, { confirm: false });
  assert.equal(first.reimbursementRoute, 'legacy');
  assert.equal(first.status, 'ready', JSON.stringify(first.blockers));
  assert.deepEqual(first.uploadFiles, []);
  assert.equal((await app.request('/api/plan-override', { folder: key, bookingOptions: { offline: true, attachmentCount: 2 } })).status, 200);
  const checked = await app.plan(key, { confirm: false });
  assert.equal(checked.attachmentCount, 2);
  const confirmed = await app.request(`/api/plans/${checked.id}/confirmations`, { fingerprint: checked.fingerprint, paymentCardConfirmed: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.plan.reimbursementRoute, 'legacy');
  assert.equal(confirmed.body.plan.attachmentCount, 2);
  const route = '/api/claim-groups/' + id;
  assert.equal((await app.request(route, { ...root, reimbursementRoute: 'smart' }, 'PATCH')).status, 200);
  assert.equal((await app.request('/api/batch-runs', { planIds: [confirmed.body.plan.id] })).status, 404);
  const switched = await draft();
  assert.equal(switched.offlineBooking, false);
  assert.equal(switched.reasonDraft, reason);
  assert.equal(switched.match.projectNo, project.projectNo);
  const smart = await app.plan(key, { confirm: false });
  assert.equal(smart.reimbursementRoute, 'smart');
  assert.ok(smart.uploadFiles.length > 0);
  assert.equal((await app.request(route, { ...root, reimbursementRoute: 'legacy' }, 'PATCH')).status, 200);
  await app.stop();
  await app.start();
  assert.equal((await draft()).offlineBooking, true);
  const restored = await app.plan(key, { confirm: false });
  assert.equal(restored.reimbursementRoute, 'legacy');
  assert.equal(restored.attachmentCount, 2);
  assert.equal(restored.reason, reason);
});

test('group membership changes invalidate saved purpose and groups can be merged or dissolved', async (t) => {
  const app = await setup(t);
  const second = await addSourceFixture(t, app);
  const first = (await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders: [app.folder], subject: 'AI服务' })).body.group;
  const other = (await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders: [second], subject: 'AI服务' })).body.group;
  const result = await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, mergeKeys: [first.key, other.key] });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body.group.folders, [app.folder, second]);
  assert.deepEqual(result.body.group.mergedFrom, [first.key, other.key]);
  const rows = (await app.request('/api/folders')).body.claims.filter((item) => !item.reimbursed);
  assert.equal(rows.length, 1);
  const bad = await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders: ['../outside'] });
  assert.equal(bad.status, 409);
  const merged = result.body.group;
  await app.request('/api/project-match', { sourceRoot: app.sourceRoot, folder: merged.key, match: { projectNo: 'TEST-2026-01', projectName: '测试项目', funding: '教学' } });
  await app.request('/api/claim-reason', { sourceRoot: app.sourceRoot, folder: merged.key, reason: '金融文本分析实训所需模型调用', explicit: true });
  assert.equal((await app.plan(merged.key, { confirm: false })).status, 'ready');
  const edited = await app.request('/api/claim-groups/' + merged.id, { sourceRoot: app.sourceRoot, folders: [app.folder] }, 'PUT');
  assert.equal(edited.status, 200);
  assert.equal((await app.plan(merged.key, { confirm: false })).status, 'blocked');
  const route = '/api/claim-groups/' + merged.id;
  const root = { sourceRoot: app.sourceRoot };
  assert.equal((await app.request(route, { ...root, folders: [app.folder, second] }, 'PUT')).status, 200);
  const previous = await app.plan(merged.key, { confirm: false });
  const undone = await app.request(route, root, 'DELETE');
  assert.equal(undone.status, 200);
  assert.deepEqual(undone.body.group.folders, [app.folder, second]);
  assert.equal((await app.request('/api/batch-runs', { planIds: [previous.id] })).status, 404);
  await app.stop();
  await app.start();
  assert.equal((await app.request(route, root, 'DELETE')).status, 200);
  const worklist = (await app.request('/api/folders')).body;
  assert.equal(worklist.claims.filter((item) => !item.reimbursed).length, 0);
  assert.deepEqual(worklist.folders.filter((item) => !item.claimKey && !item.reimbursed).map(({ path }) => path).sort(), [app.folder, second]);
  const regrouped = await app.request('/api/claim-groups', { ...root, folders: [second] });
  assert.equal(regrouped.status, 201);
  assert.notEqual(regrouped.body.group.id, merged.id);
  assert.deepEqual(regrouped.body.group.folders, [second]);
  assert.equal(regrouped.body.group.match, null);
  assert.equal(regrouped.body.group.reason.draft, '');
});

test('a verified grouped claim archives its sources and a confirmed withdrawal restores them', async (t) => {
  const app = await setup(t, { submit: true });
  const second = await addSourceFixture(t, app);
  const group = (await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders: [app.folder, second], subject: 'AI服务' })).body.group;
  await app.request('/api/project-match', { sourceRoot: app.sourceRoot, folder: group.key, match: { projectNo: 'TEST-2026-01', projectName: '测试项目', funding: '教学' } });
  await app.request('/api/claim-reason', { sourceRoot: app.sourceRoot, folder: group.key, reason: '金融文本分析实训所需模型调用', explicit: true });
  const plan = await app.plan(group.key, { confirm: false });
  const started = await app.request('/api/batch-runs', { planIds: [plan.id] });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  let run;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    run = (await app.request('/api/runs')).body.runs[0];
    if (run.status === 'completed' && run.events.some((event) => event.step === '标记已报销')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(run.status, 'completed');
  await access(join(app.sourceRoot, app.folder + '-已报销'));
  await access(join(app.sourceRoot, second + '-已报销'));
  let archived;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    archived = (await app.request('/api/folders')).body.claims.find((item) => item.groupId === group.id);
    if (archived.archivedFolders?.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(archived.reimbursed, true);
  assert.equal(archived.submission.financeFormId, 'TEST-SCHOOL-123');
  assert.deepEqual(archived.sourceFolders, [app.folder, second]);
  assert.equal(archived.archivedFolders.length, 2);
  assert.equal((await app.request('/api/batch-runs', { planIds: [plan.id] })).status, 409);
  assert.equal((await app.request(`/api/claim-groups/${group.id}`, { sourceRoot: app.sourceRoot }, 'DELETE')).status, 409);
  const withdrawal = `/api/runs/${run.id}/withdrawal`;
  assert.equal(archived.withdrawalRunId, run.id);
  assert.equal((await app.request(withdrawal, { confirmed: false })).status, 400);
  assert.equal((await app.request(withdrawal, { confirmed: true })).status, 200);
  await access(join(app.sourceRoot, app.folder));
  await access(join(app.sourceRoot, second));
  await assert.rejects(access(join(app.sourceRoot, second + '-已报销')), { code: 'ENOENT' });
  await app.stop();
  await app.start();
  const restored = (await app.request('/api/folders')).body.claims.find((item) => item.groupId === group.id);
  assert.equal(restored.reimbursed, false);
  assert.deepEqual(restored.sourceFolders, [app.folder, second]);
  assert.equal(restored.match.projectNo, 'TEST-2026-01');
  assert.equal((await app.plan(group.key, { confirm: false })).rows.length, 2);
  assert.equal((await app.request(withdrawal, { confirmed: true })).status, 200);
  const history = JSON.parse(await readFile(join(app.appDir, '.runtime/history.json'), 'utf8'));
  assert.equal(history.withdrawals.length, 1);
  assert.equal(history.withdrawals[0].runId, run.id);
  assert.equal(history.submittedInvoiceNumbers.length, 0);
});

test('multiple merged matters remain separate claims in one execution batch', async (t) => {
  const app = await setup(t);
  const second = await addSourceFixture(t, app);
  const third = await addSourceFixture(t, app, { folder: 'third', invoiceNumber: '12345678901234567892', orderNumber: '3234567890123456', paymentId: 'PAY-0003' });
  const fourth = await addSourceFixture(t, app, { folder: 'fourth', invoiceNumber: '12345678901234567893', orderNumber: '4234567890123456', paymentId: 'PAY-0004' });
  const planIds = [];
  for (const [index, folders] of [[app.folder, second], [third, fourth]].entries()) {
    const response = await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders, subject: 'AI服务' });
    assert.equal(response.status, 201);
    const group = response.body.group;
    const first = { projectNo: 'TEST-2026-01', projectName: '测试项目' };
    const match = index === 0 ? { funding: '教学', allocations: [
      { ...first, amountCny: 12501 }, { projectNo: 'TEST-2026-02', projectName: '第二项目', amountCny: null },
    ] } : { ...first, funding: '教学' };
    assert.equal((await app.request('/api/project-match', { sourceRoot: app.sourceRoot, folder: group.key, match })).status, 200);
    await app.request('/api/claim-reason', { sourceRoot: app.sourceRoot, folder: group.key, reason: '金融文本分析实训 ' + folders[0] + ' 所需模型调用', explicit: true });
    planIds.push((await app.plan(group.key, { confirm: false })).id);
  }
  try {
    const execution = await app.request('/api/batch-runs', { planIds });
    assert.equal(execution.status, 202, JSON.stringify(execution.body));
    assert.equal(execution.body.batch.runs.length, 2);
    assert.deepEqual(execution.body.batch.runs.map((run) => run.plan.sourceFolders.length), [2, 2]);
    assert.notEqual(execution.body.batch.runs[0].plan.groupId, execution.body.batch.runs[1].plan.groupId);
    assert.deepEqual(planProjects(execution.body.batch.runs[0].plan).map(({ amountCny }) => amountCny), [12501, 16499]);
    assert.equal(planProjects(execution.body.batch.runs[1].plan).length, 1);
  } finally { await app.stop(); }
});

test('three-project allocations persist and a changed share invalidates the old plan', async (t) => {
  const app = await setup(t);
  const group = (await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders: [app.folder], subject: 'AI服务' })).body.group;
  const saveMatch = (allocations) => app.request('/api/project-match', { sourceRoot: app.sourceRoot, folder: group.key, match: { funding: '教学', allocations } });
  const draft = [
    { projectNo: 'TEST-2026-01', projectName: '第一项目', amountCny: 3201 },
    { projectNo: 'DEMO-TEST-01', projectName: '科研项目', amountCny: null },
    { projectNo: 'TEST-2026-03', projectName: '第三项目', amountCny: null },
  ];
  assert.equal((await saveMatch([draft[0], { ...draft[0], amountCny: null }])).status, 400);
  assert.equal((await saveMatch(draft)).status, 200);
  await app.request('/api/claim-reason', { sourceRoot: app.sourceRoot, folder: group.key, reason: '金融文本分析实训所需模型调用', explicit: true });
  const incomplete = await app.plan(group.key, { confirm: false });
  assert.equal(incomplete.status, 'blocked');
  assert.match(incomplete.blockers.join(' '), /手动分配项目/);
  draft[1].amountCny = 2000;
  await saveMatch(draft);
  const plan = await app.plan(group.key, { confirm: false });
  assert.equal(plan.status, 'ready', JSON.stringify(plan.blockers));
  assert.equal(plan.signer.name, '示例教学加签人');
  assert.deepEqual(planProjects(plan).map(({ amountCny }) => amountCny), [3201, 2000, 3799]);
  await app.stop();
  await app.start();
  assert.deepEqual((await app.request('/api/folders')).body.claims.find((claim) => claim.groupId === group.id).match.allocations, draft);
  draft[1].amountCny = 5799;
  await saveMatch(draft);
  const stale = await app.request('/api/batch-runs', { planIds: [plan.id] });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /分配金额已变化/);
  const zero = await app.plan(group.key, { confirm: false });
  assert.equal(zero.status, 'blocked');
  assert.match(zero.blockers.join(' '), /最后一个项目/);
});

test('restart repairs a submitted matter whose sources were marked but not all renamed', async (t) => {
  const app = await setup(t);
  const second = await addSourceFixture(t, app);
  const group = (await app.request('/api/claim-groups', { sourceRoot: app.sourceRoot, folders: [app.folder, second], subject: 'AI服务' })).body.group;
  await app.request('/api/project-match', { sourceRoot: app.sourceRoot, folder: group.key, match: { projectNo: 'TEST-2026-01', projectName: '测试项目', funding: '教学' } });
  await app.request('/api/claim-reason', { sourceRoot: app.sourceRoot, folder: group.key, reason: '金融文本分析实训所需模型调用', explicit: true });
  const plan = await app.plan(group.key, { confirm: false });
  await app.stop();
  await rename(join(app.sourceRoot, app.folder), join(app.sourceRoot, app.folder + '-已报销'));
  await writeFile(join(app.appDir, '.runtime/runs.json'), JSON.stringify([{
    id: '99999999-9999-4999-8999-999999999999', plan, sourceRoot: app.sourceRoot,
    control: { progress: { uploads: [], submission: { state: 'verified', financeFormId: 'TEST-SCHOOL-456', verifiedAt: new Date().toISOString() } } },
    events: [], messages: [], status: 'completed', bookkeeping: { historyRecorded: true, folderMarked: true },
  }]));
  await app.start();
  const archived = (await app.request('/api/folders')).body.claims.find((item) => item.groupId === group.id);
  assert.equal(archived.reimbursed, true);
  assert.deepEqual(archived.archivedFolders, [app.folder + '-已报销', second + '-已报销']);
  assert.equal(archived.submission.financeFormId, 'TEST-SCHOOL-456');
  await access(join(app.sourceRoot, second + '-已报销'));
  const history = JSON.parse(await readFile(join(app.appDir, '.runtime/history.json'), 'utf8'));
  assert.equal(history.submittedInvoiceNumbers.length, 2);
  await app.stop();
  await app.start();
  assert.equal((await app.request('/api/folders')).body.claims.filter((item) => item.groupId === group.id).length, 1);
});
test('both execution APIs reject missing payment without starting any browser', async (t) => {
  const app = await setup(t, { payment: null });
  const plan = await app.plan();
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.paidTotalCny, null);
  assert.match(plan.blockers.join(' '), /发票缺少对应的有效付款凭证/);
  const manual = await app.request(`/api/plans/${plan.id}/confirmations`, {
    fingerprint: plan.fingerprint, paidAmountsCny: { [plan.rows[0].invoiceNumber]: 8765 },
  });
  assert.equal(manual.status, 400);
  assert.equal((await app.request('/api/runs', { planId: plan.id })).status, 409);
  assert.equal((await app.request('/api/batch-runs', { planIds: [plan.id] })).status, 409);
  await assert.rejects(access(app.started));
  assert.equal((await app.request('/api/runs')).body.runs.length, 0);
});

test('a matched payment lets a batch execute with the receipt reminder', async (t) => {
  const app = await setup(t, { subject: '电脑配件', payment: 8765 });
  const plan = await app.plan();
  assert.equal(plan.status, 'ready');
  assert.match(plan.warnings.join(' '), /签收单/);
  try {
    const execution = await app.request('/api/batch-runs', { planIds: [plan.id] });
    assert.equal(execution.status, 202);
    assert.equal(execution.body.batch.runs[0].plan.totalCny, 8765);
  } finally {
    await app.stop();
  }
});

test('an unmatched folder shows its amount without being assigned a funding project', async (t) => {
  const app = await setup(t);
  const plan = await app.plan(undefined, { confirm: false, project: null });
  assert.equal(plan.totalCny, 9000);
  assert.equal(plan.project.projectNo, '');
  assert.equal(plan.status, 'blocked');
  assert.equal((await app.request('/api/runs', { planId: plan.id })).status, 409);
  try {
    const matched = await app.plan();
    const execution = await app.request('/api/batch-runs', { planIds: [matched.id] });
    assert.equal(execution.status, 202);
    assert.equal(execution.body.batch.runs[0].plan.project.projectNo, 'TEST-2026-01');
  } finally {
    await app.stop();
  }
});

test('archived folders are excluded from worklist execution even with the old override', async (t) => {
  const app = await setup(t, { folder: 'archive-已报销' });
  const folders = await app.request('/api/folders');
  assert.equal(folders.body.folders[0].path, app.folder);
  const result = await app.request('/api/plans', { folder: app.folder, subject: app.subject, funding: '教学', allowReimbursed: true });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /已报销/);
  await assert.rejects(access(app.started));
});

test('handwritten reasons survive restart before matching and require confirmation for the current plan', async (t) => {
  const app = await setup(t);
  const reason = `${concretePurpose.matter}：${concretePurpose.use}`;
  const draft = { sourceRoot: app.sourceRoot, folder: app.folder, reason };
  const autosaved = await app.request('/api/claim-reason', draft);
  assert.equal(autosaved.status, 200);
  assert.equal(autosaved.body.reasonSaved, false);
  assert.equal((await app.request('/api/claim-reason', { ...draft, explicit: true })).body.reasonSaved, true);
  await app.stop();
  await app.start();
  assert.equal((await app.request('/api/folders')).body.folders[0].reasonDraft, reason);
  assert.equal((await app.request('/api/folders')).body.folders[0].reasonSaved, true);
  const unmatched = await app.plan(undefined, { confirm: false, project: null });
  assert.equal(unmatched.reason, '');
  assert.equal((await app.request(`/api/plans/${unmatched.id}/purpose`, { reason, confirmed: true })).status, 400);
  const matched = await app.plan(undefined, { confirm: false });
  assert.equal(matched.reason, '');
  assert.equal((await app.request(`/api/plans/${matched.id}/purpose`, { reason: '办公用品：打印装订', confirmed: true })).status, 409);
  const confirmed = await app.request(`/api/plans/${matched.id}/purpose`, { reason, confirmed: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.plan.reason, reason);
  assert.equal(confirmed.body.plan.status, 'ready');
  await app.request('/api/claim-reason', { ...draft, reason: `${reason}及结果核验` });
  const execution = await app.request('/api/runs', { planId: confirmed.body.plan.id });
  assert.equal(execution.status, 409);
  assert.match(execution.body.error, /事由.*更新/);
  assert.equal((await app.plan(undefined, { confirm: false })).reason, '');
  await assert.rejects(access(app.started));
});

test('signer defaults follow confirmed research funding rather than old global memories', async (t) => {
  const app = await setup(t, { signerByFunding: { 教学: { name: '旧版示例加签人' }, 科研: { name: '旧版示例加签人' } } });
  const teaching = await app.plan(undefined, { confirm: false });
  assert.deepEqual(teaching.signer, { name: '示例教学加签人', employeeNo: '980001' });
  const research = await app.plan(undefined, { confirm: false, funding: '科研', project: { projectNo: 'DEMO-TEST-01', projectName: '虚构研究经费' } });
  assert.equal(research.funding, '科研');
  assert.equal(research.signer.name, '示例科研加签人');
});

test('a manually entered signer is selectable later and survives a plan recheck and restart', async (t) => {
  const app = await setup(t);
  const initial = await app.plan(undefined, { confirm: false });
  const name = '模拟加签人';
  const saved = await app.request('/api/plan-override', { folder: app.folder, signerName: '　' + name + '　' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.plan.signer, { name, employeeNo: '' });
  const nextName = '另一位模拟加签人';
  const revised = await app.request('/api/plan-override', {
    folder: app.folder, subject: initial.subject === '办公用品' ? '书籍资料' : '办公用品', signerName: nextName,
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.recheck, true);
  assert.equal((await app.plan(undefined, { confirm: false })).signer.name, nextName);
  await app.stop();
  await app.start();
  assert.deepEqual((await app.request('/api/folders')).body.signerNames.slice(0, 2), [name, nextName]);
  assert.equal((await app.plan(undefined, { confirm: false })).signer.name, nextName);
});

test('an explicit project match survives restart before any plan is generated', async (t) => {
  const app = await setup(t);
  const match = { projectNo: 'TEST-2026-01', projectName: '测试项目', funding: '科研' };
  const selection = { sourceRoot: app.sourceRoot, folder: app.folder, match };
  const saved = await app.request('/api/project-match', selection);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await app.stop();
  await app.start();
  assert.deepEqual((await app.request('/api/folders')).body.folders[0].match, match);
  const plan = await app.plan();
  assert.equal(plan.funding, '科研');
  assert.equal(plan.project.projectNo, match.projectNo);
  const otherRoot = join(app.appDir, 'other-source');
  await cp(app.sourceRoot, otherRoot, { recursive: true });
  await app.request('/api/config', { sourceRoot: otherRoot });
  assert.equal((await app.request('/api/folders')).body.folders[0].match, undefined);
  assert.equal((await app.request('/api/project-match', selection)).status, 409);
  await app.request('/api/config', { sourceRoot: app.sourceRoot });
  assert.deepEqual((await app.request('/api/folders')).body.folders[0].match, match);
  const repeated = await app.plan();
  assert.equal((await app.request('/api/project-match', { ...selection, match: null })).body.match, null);
  assert.equal((await app.request('/api/runs', { planId: repeated.id })).status, 409);
  assert.equal((await app.request('/api/project-match', { ...selection, importOnly: true })).body.match, null);
  await assert.rejects(access(app.started));
});

test('a same-length attachment change invalidates a previously ready plan at execution', async (t) => {
  const app = await setup(t);
  const plan = await app.plan();
  assert.equal(plan.status, 'ready');
  const path = join(app.batchDir, '支付.png');
  await writeFile(path, (await readFile(path, 'utf8')).replace('90.00', '80.00'));
  const result = await app.request('/api/batch-runs', { planIds: [plan.id] });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /附件已变化/);
  await assert.rejects(access(app.started));
});

test('one waiting run blocks competing execution and browser-changing helper routes', async (t) => {
  const app = await setup(t);
  const plan = await app.plan();
  assert.equal((await app.request('/api/runs', { planId: plan.id })).status, 202);
  const deadline = Date.now() + 2000;
  let runs;
  do { runs = (await app.request('/api/runs')).body.runs; if (runs[0]?.status === 'waiting_input') break; await new Promise((resolve) => setTimeout(resolve, 10)); } while (Date.now() < deadline);
  assert.equal(runs[0].status, 'waiting_input');
  for (const [path, payload] of [['/api/runs', { planId: plan.id }], ['/api/projects/sync', {}], ['/api/config', { sourceRoot: app.sourceRoot }], ['/api/login-status', undefined]]) assert.equal((await app.request(path, payload)).status, 409, path);
});

test('manual material confirmations survive an unchanged recheck', async (t) => {
  const app = await setup(t, { payment: 10000, subject: '办公用品', extra: [{ name: '签收单.pdf', kind: 'receipt', text: '待用户查看签字的签收材料' }] });
  const initial = await app.plan();
  assert.equal(initial.status, 'ready');
  assert.match(initial.warnings.join(' '), /缺少已核对签字的签收单/);
  const confirmed = await app.request(`/api/plans/${initial.id}/confirmations`, { fingerprint: initial.fingerprint, receiptFile: '签收单.pdf', paymentCardConfirmed: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.plan.status, 'ready', JSON.stringify(confirmed.body.plan.blockers));
  const repeated = await app.plan();
  assert.equal(repeated.status, 'ready', JSON.stringify(repeated.blockers));
  assert.equal(repeated.confirmations.receiptFile, '签收单.pdf');
  assert.ok(!repeated.warnings.some((warning) => /缺少已核对签字/.test(warning)));
});

test('manual payment links validate the evidence and survive rechecking unchanged attachments', async (t) => {
  const app = await setup(t, { payment: 10000, order: null });
  const cache = join(app.appDir, '.runtime/cache', encodeURIComponent(app.folder));
  const files = await readdir(cache);
  await Promise.all(files.filter((name) => name.startsWith('selection-')).map((name) => unlink(join(cache, name))));
  const initial = await app.plan();
  assert.equal(initial.status, 'blocked');
  const [invoice] = initial.rows;
  const payment = initial.paymentCandidates[0].name;
  const confirm = (names) => app.request(`/api/plans/${initial.id}/confirmations`, {
    fingerprint: initial.fingerprint, paymentLinks: { [invoice.invoiceNumber]: names },
  });
  assert.equal((await confirm([invoice.invoiceFile])).status, 400);
  const confirmed = await confirm([payment]);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.plan.status, 'ready');
  assert.equal(confirmed.body.plan.totalCny, 10000);
  const repeated = await app.plan();
  assert.deepEqual(repeated.rows[0].paymentFiles, [payment]);
  await writeFile(join(app.batchDir, '补充材料.bin'), '本地模拟附件');
  const rechecked = await app.plan(undefined, { confirm: false });
  assert.equal(rechecked.confirmations.paymentLinks, undefined);
  assert.equal(rechecked.status, 'blocked');
});

test('attachment review sends the batch text to the selected model and computes amounts locally', async (t) => {
  const app = await setup(t, {
    order: null,
    paymentNote: '附件中的服务说明\n'.repeat(260) + '人工核对字段：模拟订单的付款记录\n联系邮箱：fixture@example.test',
    modelSettings: { apiKey: 'fixture-key', model: 'fixture-attachments' },
    fakeCodex: String.raw`let prompt = '';
      process.stdin.on('data', (chunk) => prompt += chunk);
      process.stdin.on('end', () => {
        const files = JSON.parse(prompt.split('文件清单：').at(-1));
        const invoice = files.find(({ fields }) => fields.includes('发票金额='));
        const payment = files.find(({ fields }) => fields.includes('支付金额='));
        if (process.argv[process.argv.indexOf('--model') + 1] !== 'fixture-attachments' ||
            !invoice || !payment || !payment.content.includes('\n人工核对字段:模拟订单的付款记录\n') ||
            !payment.fields.includes('日期=') || prompt.includes('fixture@example.test') || prompt.includes('支付.png')) process.exit(2);
        const text = JSON.stringify({
          upload: [invoice.name, payment.name], types: { [invoice.name]: 'invoice', [payment.name]: 'payment' },
          matches: { [invoice.name]: { payment: [payment.name] } }, totalCny: 1
        });
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
      });`,
  });
  const cache = join(app.appDir, '.runtime/cache', encodeURIComponent(app.folder));
  await Promise.all((await readdir(cache)).filter((name) => name.startsWith('selection-')).map((name) => unlink(join(cache, name))));
  const initial = await app.plan(undefined, { confirm: false });
  assert.equal(initial.uploadSource, 'rule');
  assert.equal(initial.totalCny, null);
  assert.match(initial.warnings.join(' '), /附件识别的外部模型已关闭/);

  const { body: settings } = await app.request('/api/model-settings');
  settings.assignments.attachments = 'deepseek';
  assert.equal((await app.request('/api/model-settings', settings)).status, 200);
  const checked = await app.plan();
  assert.equal(checked.uploadSource, 'ai', checked.warnings.join(' '));
  assert.deepEqual(checked.rows[0].paymentFiles, ['支付.png']);
  assert.equal(checked.totalCny, 9000);
  const cached = await app.plan();
  assert.equal(cached.uploadSource, 'ai-cache');
  assert.equal(cached.totalCny, checked.totalCny);
});

test('government procurement remains selected when asset evidence needs reconfirmation', async (t) => {
  const app = await setup(t, { subject: '电脑配件', extra: [{ name: '资产入账凭证.pdf', kind: 'asset', text: '固定资产卡片' }] });
  const initial = await app.plan();
  const marked = await app.request(`/api/plans/${initial.id}/confirmations`, { fingerprint: initial.fingerprint, governmentProcurement: true });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.plan.status, 'ready');
  assert.match(marked.body.plan.warnings.join(' '), /政府采购.*资产入账/);
  const confirmed = await app.request(`/api/plans/${marked.body.plan.id}/confirmations`, { fingerprint: initial.fingerprint, assetFile: '资产入账凭证.pdf' });
  assert.equal(confirmed.body.plan.status, 'ready');
  await writeFile(join(app.batchDir, '签字补充.bin'), '本地测试附件变化');
  const rechecked = await app.plan(undefined, { confirm: false });
  assert.equal(rechecked.confirmations.governmentProcurement, true);
  assert.match(rechecked.warnings.join(' '), /政府采购.*资产入账/);
});

test('the API ignores legacy folder reasons and binds confirmation to the selected project', async (t) => {
  const app = await setup(t, { legacyReason: '教学使用AI服务11月' });
  const unconfirmed = await app.plan(undefined, { confirm: false });
  assert.equal(unconfirmed.reason, '');
  assert.equal(unconfirmed.status, 'blocked');
  assert.equal((await app.request('/api/runs', { planId: unconfirmed.id })).status, 409);
  const confirmed = await app.plan();
  const repeated = await app.plan(undefined, { confirm: false });
  assert.equal(repeated.reason, confirmed.reason);
  const switched = await app.plan(undefined, { confirm: false, project: { projectNo: 'TEST-2026-02', projectName: '另一测试项目' } });
  assert.equal(switched.purpose, null);
  assert.equal(switched.status, 'blocked');
  assert.equal((await app.request('/api/runs', { planId: repeated.id })).status, 404);
  await assert.rejects(access(app.started));
});

test('the catalog title determines the meal reminder even if the client supplies a different name', async (t) => {
  const app = await setup(t, {
    invoiceItem: '*餐饮服务*误餐费',
    projects: [{ projectNo: 'TEST-2026-01', projectName: '内涵建设经费—金融学专业建设' }],
  });
  const plan = await app.plan(undefined, { project: { projectNo: ' TEST-2026-01 ', projectName: '测试项目' } });
  assert.equal(plan.project.projectName, '内涵建设经费—金融学专业建设');
  assert.match(plan.warnings.join(' '), /不得支出误餐费/);
  try {
    assert.equal((await app.request('/api/runs', { planId: plan.id })).status, 202);
  } finally {
    await app.stop();
  }
});

test('different invoices cannot reuse the same transaction in a batch or after verified reimbursement', async (t) => {
  const app = await setup(t);
  const second = await cachedFixture(t, { folder: 'another-batch', invoiceNumber: '12345678901234567891', paymentNote: '同一流水的另一张截图' });
  await cp(second.batchDir, join(app.sourceRoot, second.folder), { recursive: true });
  await cp(join(second.appDir, '.runtime/cache', second.folder), join(app.appDir, '.runtime/cache', second.folder), { recursive: true });
  const firstPlan = await app.plan();
  const secondPlan = await app.plan(second.folder);
  assert.equal(firstPlan.status, 'ready');
  assert.equal(secondPlan.status, 'ready');
  assert.notEqual(firstPlan.rows[0].invoiceNumber, secondPlan.rows[0].invoiceNumber);
  const result = await app.request('/api/batch-runs', { planIds: [firstPlan.id, secondPlan.id] });
  assert.equal(result.status, 409);
  assert.match(result.body.error, /同一付款凭证/);
  await assert.rejects(access(app.started));

  await app.stop();
  const storedPlans = JSON.parse(await readFile(join(app.appDir, '.runtime/plans.json'), 'utf8'));
  const runId = '11111111-1111-4111-8111-111111111111';
  const batchId = '22222222-2222-4222-8222-222222222222';
  await writeFile(join(app.appDir, '.runtime/runs.json'), JSON.stringify([{
    id: runId,
    plan: storedPlans.find((plan) => plan.id === firstPlan.id),
    status: 'preview',
    events: [],
    messages: [],
  }]));
  await writeFile(join(app.appDir, '.runtime/batches.json'), JSON.stringify([{
    id: batchId, runIds: [runId], currentRunId: runId, currentIndex: 0, status: 'preview',
  }]));
  await app.start();
  const manual = await app.request(`/api/runs/${runId}/instructions`, { message: '已手动提交' });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.run.status, 'preview');
  assert.match(manual.body.run.messages.at(-1).text, /登记手动提交.*报销单号/);
  const resolved = await app.request(`/api/runs/${runId}/resolution`, { confirmed: true, resolution: 'submitted', financeFormId: 'TEST-DOC-001' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.run.status, 'completed');
  const batch = (await app.request('/api/batches')).body.batches.find((item) => item.id === batchId);
  assert.equal(batch.status, 'completed');
  assert.equal(batch.currentRunId, null);
  await app.stop();
  await app.start();
  const duplicate = await app.request('/api/runs', { planId: secondPlan.id });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /付款已记入另一报销单/);
  await assert.rejects(access(app.started));
});

test('a submission attempt remains blocked after restart and ordinary cancellation', async (t) => {
  const app = await setup(t);
  const plan = await app.plan();
  await app.stop();
  const run = { id: '11111111-1111-4111-8111-111111111111', plan, sourceRoot: app.sourceRoot, status: 'running', result: null, error: null, events: [], messages: [], control: { progress: { submission: { state: 'attempted' }, uploads: [] } }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeFile(join(app.appDir, '.runtime/runs.json'), JSON.stringify([run]));
  await app.start();
  assert.equal((await app.request('/api/runs')).body.runs[0].status, 'verification_required');
  assert.equal((await app.request(`/api/runs/${run.id}/instructions`, { message: '重试' })).status, 409);
  await app.request(`/api/runs/${run.id}/instructions`, { message: '取消任务' });
  assert.equal((await app.request('/api/projects/sync', {})).status, 409);
  assert.equal((await app.request('/api/runs', { planId: plan.id })).status, 409);
  await assert.rejects(access(app.started));
});
