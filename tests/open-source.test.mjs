import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestRoute } from './request-fixture.mjs';
import { readModelSettings, modelForPurpose, publicModelSettings } from '../lib/model-settings.mjs';
import { redactModelText } from '../lib/model-input.mjs';
import { confirmSubmission } from '../lib/submission-confirmation.mjs';
import { privateDataDirectory, profileId } from '../lib/platform.mjs';

test('fresh installation serves the synthetic workbooks and blocks live operations in demo mode', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reimbursement-community-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  process.env.REIMBURSEMENT_RUNNER_DATA_DIR = join(root, 'profile');
  delete process.env.REIMBURSEMENT_SOURCE_ROOT;
  const { handleRequest } = await import('../server.mjs');
  const request = (path, data, method, headers) => requestRoute(handleRequest, path, data, method, headers);

  assert.equal((await request('/api/health')).body.edition, 'community');
  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(index.body.toString(), /设置我的报销/);
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  assert.equal((await request('/', undefined, undefined, navigation)).status, 200);
  assert.equal((await request('/api/funding-summary', undefined, undefined, navigation)).status, 403);
  const { body: config } = await request('/api/config');
  assert.equal(config.demoMode, true);
  assert.deepEqual(config.preferences.signers, { 教学: null, 科研: null });
  assert.deepEqual(config.preferences.researchProjectNos, []);
  assert.equal(config.preferences.autoPrint, false);
  const { body: summary } = await request('/api/funding-summary');
  assert.equal(summary.demoMode, true);
  assert.equal(summary.year, '2099');
  assert.ok(summary.sources.filter(({ kind }) => kind !== 'runner').length === 5 && summary.sources.every(({ state }) => state === 'read'));
  const project = summary.projects.find(({ projectNo }) => projectNo === 'DEMO-2099-001');
  assert.equal(project.rate, 0.15);
  assert.equal(project.bookedCny, 135000);
  assert.equal(project.submittedCny, 45000);
  const xls = await request('/api/funding-summary/source?file=' + encodeURIComponent('报销单查询.xls'));
  assert.equal(xls.body.subarray(0, 8).toString('hex'), 'd0cf11e0a1b11ae1');
  const template = '/api/funding-summary/source?file=' + encodeURIComponent('2099年度进账与报销台账.xlsx');
  assert.equal((await request(template)).body.subarray(0, 4).toString('hex'), '504b0304');
  assert.equal((await request('/api/login-status')).status, 409);
  assert.equal((await request('/api/funding-summary/sync', {})).status, 409);
  assert.equal((await request('/api/batch-runs', { entries: [] })).status, 409);
  assert.equal((await request('/api/config', undefined, undefined, { host: 'example.invalid:3033' })).status, 403);
  assert.equal((await request('/api/config', { demoMode: true }, 'POST', { origin: 'https://example.invalid' })).status, 403);
  assert.equal((await request('/api/config', { demoMode: true }, 'POST', { 'content-type': 'text/plain' })).status, 415);

  const receipts = join(root, '正式 票据', '2098');
  await mkdir(receipts, { recursive: true });
  const live = await request('/api/config', { sourceRoot: receipts, preferences: { campus: '长宁', signers: { 科研: { name: '示例加签人' } } } });
  assert.equal(live.status, 200);
  assert.equal(live.body.demoMode, false);
  assert.equal(live.body.preferences.signers['科研'].name, '示例加签人');
  assert.equal((await request('/api/funding-summary')).body.year, '2098');
  assert.equal((await request(template)).status, 404);
  assert.equal((await request('/api/config', { demoMode: true })).body.demoMode, true);
  const saved = JSON.parse(await readFile(join(root, 'profile', '.runtime', 'config.json'), 'utf8'));
  assert.equal(saved.demoMode, true);
  assert.equal(saved.liveSourceRoot.length > 0, true);
});

test('local data paths cannot resolve into the program, even through a directory link', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reimbursement-data-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const program = join(root, '程序');
  const data = join(root, '用户资料');
  await mkdir(program);
  const profile = (path) => privateDataDirectory(program, { REIMBURSEMENT_RUNNER_DATA_DIR: path });
  await assert.rejects(profile(join(program, 'data')), /用户数据目录/);
  const first = await profile(data);
  assert.notEqual(profileId(first), profileId(await profile(join(root, '其他用户资料'))));
  await mkdir(data);
  await symlink(program, join(data, '.runtime'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(profile(data), /用户数据目录/);
});

test('external models start disabled even when an API key exists in the environment', async () => {
  const settings = await readModelSettings(join(tmpdir(), 'reimbursement-empty-model-settings'));
  const env = { DEEPSEEK_API_KEY: 'test-secret' };
  assert.throws(() => modelForPurpose(settings, 'attachments', env), /已关闭/);
  assert.ok(Object.values(publicModelSettings(settings, env).assignments).every((value) => value === ''));
  assert.ok(!JSON.stringify(publicModelSettings(settings, env)).includes('test-secret'));
  const result = redactModelText('姓名：示例人员\n身份证号：100000000000000001\n银行卡号：1000 0000 0000 0000\n邮箱：demo@example.invalid\n金额：120.00');
  for (const value of ['示例人员', '100000000000000001', '1000 0000 0000 0000', 'demo@example.invalid']) assert.ok(!result.includes(value));
  assert.match(result, /120\.00/);
});

test('school submission requires explicit confirmation after displaying the current details', async () => {
  const calls = [];
  const options = { control: {}, question: '本笔金额 120.00 元', validate: async () => calls.push('validate'), checkpoint: async () => calls.push('checkpoint') };
  assert.equal(await confirmSubmission({ ...options, ask: async () => '继续' }), false);
  assert.deepEqual(calls, []);
  assert.equal(await confirmSubmission({ ...options, ask: async (question) => {
    assert.match(question, /本笔金额 120\.00 元/);
    return '确认提交';
  } }), true);
  assert.deepEqual(calls, ['validate', 'checkpoint']);
  assert.equal(await confirmSubmission({ ...options, control: { skipSubmit: true }, ask: async () => assert.fail() }), false);
});
