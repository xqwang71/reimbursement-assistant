import test from 'node:test';
import { readModelSettings } from '../lib/model-settings.mjs';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { executeRunWithRecovery } from '../lib/execution-recovery.mjs';
import { runPayrollWithRecovery } from '../lib/payroll-recovery.mjs';
import { parseExpenseTypeAnswer } from '../lib/executor.mjs';
import { fundingDetailAmounts, projectExpenseChoices } from '../lib/funding-detail.mjs';

async function fixture(t, { target = 'original', progress = {}, stage = 'detail_payment' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rbx-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const page = {
    isClosed: () => false, url: () => 'https://school.example/filling',
    context: () => ({ newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: target } }), detach: async () => {} }) }),
    screenshot: async () => Buffer.from('simulated screenshot'),
  };
  const run = { id: 'run-fixture', plan: { fingerprint: 'fixture' }, events: [], control: { portalPageId: 'original', progress: { uploads: [], submission: { state: 'not_started' }, ...progress } } };
  const executor = {
    page, portalOrigin: 'https://school.example', stage, resumeStages: false,
    detectStage: async () => stage, bodyText: async () => '报销支出费用明细',
    work: async () => ({ locator: () => ({ allInnerTexts: async () => ['下一步'] }) }),
  };
  const notes = [];
  return { run, executor, notes, directory, options: { run, executor, cwd: directory, settingsDir: directory, onRecovery: (...values) => notes.push(values) } };
}

test('transient failures capture the original page and resume up to three times', async (t) => {
  const { run, executor, notes, directory, options } = await fixture(t);
  const calls = [];
  executor.run = async () => { calls.push(executor.resumeStages); throw new Error('等待页面按钮超时'); };
  await assert.rejects(executeRunWithRecovery(options), /等待页面按钮超时/);
  assert.deepEqual(calls, [false, true, true, true]);
  assert.deepEqual(notes.map(([, status]) => status), ['running', 'running', 'running', 'waiting']);
  const captures = join(directory, '.runtime', 'recovery', run.id);
  const files = await readdir(captures);
  assert.equal(files.length, 4);
  if (process.platform !== 'win32') assert.equal((await stat(join(captures, files[0]))).mode & 0o777, 0o600);
});

test('a safe recovery completes while the diagnosis model is still waiting', { skip: process.platform === 'win32' ? 'Uses a POSIX executable fixture' : false }, async (t) => {
  const { run, executor, notes, directory, options } = await fixture(t);
  const binary = join(directory, 'fake-codex');
  const release = join(directory, 'release');
  const answered = join(directory, 'answered');
  await mkdir(join(directory, '.runtime'));
  const settings = await readModelSettings(directory);
  settings.assignments.recovery = 'deepseek';
  await writeFile(join(directory, '.runtime', 'model-config.json'), JSON.stringify(settings));
  await writeFile(binary, `#!${process.execPath}
const { existsSync, writeFileSync } = require('node:fs');
const poll = setInterval(() => {
  if (!existsSync(${JSON.stringify(release)})) return;
  clearInterval(poll);
  const text = JSON.stringify({ stage: 'detail_payment', action: 'resume', note: '滞后的诊断' });
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  writeFileSync(${JSON.stringify(answered)}, '');
}, 10);
`, { mode: 0o700 });
  const previous = process.env.CODEX_BIN;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.CODEX_BIN = binary;
  process.env.DEEPSEEK_API_KEY = 'test-only';
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
  });
  run.events.push({ type: 'step', step: '填写支付信息' });
  executor.run = async () => {
    if (!executor.resumeStages) throw new Error('等待支付栏加载超时');
    return 'submitted';
  };
  const operation = executeRunWithRecovery(options);
  const timer = new AbortController();
  let first;
  try {
    first = await Promise.race([operation, delay(1000, 'waiting_for_model', { signal: timer.signal })]);
  } finally {
    timer.abort();
    await writeFile(release, '');
    await operation;
  }
  for (let tries = 0; tries < 100 && !await access(answered).then(() => true, () => false); tries += 1) await delay(10);
  await access(answered);
  assert.equal(first, 'submitted');
  assert.match(notes[0][0], /填写支付信息.*等待支付栏加载超时/);
  assert.equal(notes.length, 1);
});

test('receipt recovery resumes verification on the original tab only', async (t) => {
  const progress = { uploadPageId: 'original', submission: { state: 'verification_required', action: 'submit_pre_review', fingerprint: 'fixture' } };
  const { executor, notes, options } = await fixture(t, { progress, stage: 'unknown' });
  executor.run = async () => executor.resumeStages ? 'submitted' : 'verification_required';
  assert.equal(await executeRunWithRecovery(options), 'submitted');
  assert.match(notes[0][0], /学校回执/);
  const other = await fixture(t, { progress, target: 'different-tab' });
  other.executor.run = async () => 'verification_required';
  assert.equal(await executeRunWithRecovery(other.options), 'verification_required');
  assert.equal(other.executor.resumeStages, false);
  assert.equal(other.notes.length, 0);
});

test('the executor reads a full sentence choosing an expense type for the current claim', () => {
  assert.deepEqual(parseExpenseTypeAnswer('这笔科目选了数据采集费'), { defaultType: '数据采集费', rules: [] });
});

test('blank project amounts use the planned shared subject instead of the visible alternatives', () => {
  const projects = [{ projectNo: 'A', amountCny: 300000 }, { projectNo: 'B', amountCny: 10800 }];
  const selected = '其他教学杂项费用';
  const rows = projects.flatMap(({ projectNo }) => [selected, '办公费'].map((subject) => ({
    key: projectNo + subject, projectNo, subject, category: JSON.stringify([subject, '']), amountCny: 0, limitCny: 310800,
  })));
  assert.deepEqual(projectExpenseChoices(projects, rows), [selected, '办公费']);
  assert.deepEqual(fundingDetailAmounts(projects, rows, 310800, 310800, selected).map(({ amountCny }) => amountCny),
    [300000, 0, 10800, 0]);
  rows[0].amountCny = 300000;
  assert.deepEqual(projectExpenseChoices(projects, rows), [selected]);
  assert.deepEqual(fundingDetailAmounts(projects, rows, 310800, 310800, selected).map(({ amountCny }) => amountCny),
    [300000, 0, 10800, 0]);
  assert.throws(() => fundingDetailAmounts(projects, [...rows, { ...rows[2], key: 'second-eligible-row' }], 310800, 310800, selected),
    { code: 'PROJECT_EXPENSE_TYPE_REQUIRED' });
});

test('a stalled payroll browser is detached before the executor resumes the original draft', async () => {
  const control = { progress: { payroll: { declareId: 'SCHOOL-ORIGINAL', approvalAttemptedAt: 'saved' } } };
  const calls = [];
  const result = await runPayrollWithRecovery(async ({ openSession, signal, control }) => {
    await openSession();
    assert.equal(control.progress.payroll.declareId, 'SCHOOL-ORIGINAL');
    assert.equal(control.progress.payroll.approvalAttemptedAt, 'saved');
    if (calls.length === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return 'declared';
  }, {
    control, signal: AbortSignal.timeout(2000),
    async openSession() {
      calls.push('connect');
      return { page: { isClosed: () => false }, async disconnect() { calls.push('detach'); } };
    },
    async captureSchoolError() { calls.push('screenshot'); },
  }, {
    idleMs: 20, retryMs: 0, waiting: () => false,
    async onRetry(attempt) { calls.push('retry ' + attempt); },
  });
  assert.equal(result, 'declared');
  assert.deepEqual(calls, ['connect', 'screenshot', 'detach', 'retry 1', 'connect']);
});
