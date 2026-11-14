import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestRoute } from './request-fixture.mjs';
import { readModelSettings, modelForPurpose, publicModelSettings } from '../lib/model-settings.mjs';
import { redactModelText } from '../lib/model-input.mjs';
import { confirmSubmission } from '../lib/submission-confirmation.mjs';
import { privateDataDirectory, profileId } from '../lib/platform.mjs';
import { listWorkspaces, readWorkspaceSources, requestWorkspaceProcess, resolveWorkspace, saveWorkspaceSource, workspaceRecordRoot } from '../lib/workspaces.mjs';

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

test('annual receipt folders are separate from each owner’s runtime and the public examples', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reimbursement-workspaces-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const program = join(root, 'program');
  await Promise.all(['2026', '2027', '2099'].map((year) => mkdir(join(program, 'examples', year), { recursive: true })));
  const legacy = join(program, 'owner', 'Example A', '2026');
  const firstSource = join(root, 'first originals');
  const secondSource = join(root, 'other-year originals');
  const otherSource = join(root, 'another owner');
  for (const path of [legacy, firstSource, secondSource, otherSource]) await mkdir(path, { recursive: true });
  await writeFile(join(firstSource, 'original.txt'), 'a synthetic receipt');

  const legacyWorkspace = await resolveWorkspace(program, { owner: 'Example A', year: '2026' });
  assert.equal(legacyWorkspace.sourceRoot, legacy);
  const first = await saveWorkspaceSource(program, legacyWorkspace, firstSource);
  const next = await resolveWorkspace(program, { owner: 'Example A', year: '2027', create: true, sourceRoot: secondSource });
  const other = await resolveWorkspace(program, { owner: 'Example B', year: '2026', create: true, sourceRoot: otherSource });
  const demo = await resolveWorkspace(program, { owner: '示例', year: '2027' });

  assert.equal(first.dataDirectory, next.dataDirectory);
  assert.equal((await resolveWorkspace(program, { owner: 'Example A', year: '2026' })).sourceRoot, firstSource);
  assert.equal(next.sourceRoot, secondSource);
  assert.equal(workspaceRecordRoot(await readWorkspaceSources(first.dataDirectory), legacy), firstSource);
  const relocated = join(root, 'relocated originals');
  await mkdir(relocated);
  await saveWorkspaceSource(program, first, relocated);
  const sources = await readWorkspaceSources(first.dataDirectory);
  assert.equal(workspaceRecordRoot(sources, legacy), relocated);
  assert.equal(workspaceRecordRoot(sources, firstSource), relocated);
  assert.equal(workspaceRecordRoot(sources, secondSource), secondSource);
  assert.deepEqual((await readdir(first.dataDirectory)).sort(), ['.runtime', '2026']);
  assert.deepEqual(await readdir(legacy), []);
  assert.equal(await readFile(join(firstSource, 'original.txt'), 'utf8'), 'a synthetic receipt');
  await assert.rejects(saveWorkspaceSource(program, next, firstSource), /独立于其他年度/);
  await assert.rejects(saveWorkspaceSource(program, next, program), /独立于程序/);
  await assert.rejects(saveWorkspaceSource(program, next, join(root, 'missing')), /不存在或不可读/);
  assert.notEqual(other.dataDirectory, first.dataDirectory);
  assert.notEqual(demo.dataDirectory, first.dataDirectory);
  assert.equal(demo.sourceRoot, join(program, 'examples', '2027'));
  assert.deepEqual(await listWorkspaces(program), [
    { name: '示例', years: ['2026', '2027'], example: true },
    { name: 'Example A', years: ['2026', '2027'] },
    { name: 'Example B', years: ['2026'] },
  ]);
  await symlink(firstSource, join(other.dataDirectory, '2027'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveWorkspace(program, { owner: 'Example B', year: '2027' }), /普通文件夹/);
});

test('switching the receipt directory retains records and protects submitted folders after restart', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reimbursement-switch-source-')));
  const program = join(root, 'program');
  const originals = join(root, 'original documents');
  const directory = join(program, 'owner', 'Sample');
  const runtime = join(directory, '.runtime');
  const oldRoot = join(directory, '2026');
  const pendingFolder = 'pending';
  const bookedFolder = 'previous-claim';
  for (const path of [runtime, oldRoot, join(originals, pendingFolder), join(originals, bookedFolder)]) await mkdir(path, { recursive: true });
  const project = fileURLToPath(new URL('..', import.meta.url));
  for (const path of ['server.mjs', 'lib', 'public', 'scripts']) {
    await cp(join(project, path), join(program, path), { recursive: true });
  }
  await symlink(join(project, 'node_modules'), join(program, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const data = 'mock supporting document';
  await writeFile(join(originals, pendingFolder, 'receipt.txt'), data);
  await writeFile(join(originals, bookedFolder, 'receipt.txt'), data);
  const group = { id: '000001', key: '@事项/000001', sourceRoot: oldRoot, folders: [bookedFolder], name: 'Test claim', subject: '办公用品', status: 'submitted', fileCount: 1 };
  await writeFile(join(runtime, 'claim-groups.json'), JSON.stringify([group]));
  await writeFile(join(runtime, 'claim-reasons.json'), JSON.stringify([[`${oldRoot}\0${pendingFolder}`, { draft: '示例事由', savedOnce: true }]]));
  await writeFile(join(runtime, 'project-matches.json'), JSON.stringify([[`${oldRoot}\0${pendingFolder}`, { projectNo: 'FIXTURE', projectName: '示例经费', funding: '教学' }]]));
  let processHandle;
  async function stop() {
    if (processHandle?.connected) {
      const exited = once(processHandle, 'exit');
      processHandle.disconnect();
      await exited;
    }
  }
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
  });
  async function start() {
    processHandle = fork(join(program, 'server.mjs'), [], { env: { ...process.env, PORT: '0',
      REIMBURSEMENT_RUNNER_DATA_DIR: directory, REIMBURSEMENT_WORKSPACE: JSON.stringify({ owner: 'Sample', year: '2026' }) }, silent: true });
    const { port } = await requestWorkspaceProcess(processHandle, 'ready');
    return async (route, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-reimbursement-year': '2026' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
  }
  let request = await start();
  const change = await request('/api/workspace-source', { previousSourceRoot: oldRoot, sourceRoot: originals });
  assert.equal(change.status, 200, JSON.stringify(change.body));
  assert.equal(change.body.sourceRoot, originals);
  await stop();
  request = await start();
  const result = (await request('/api/folders')).body;
  assert.equal(result.sourceRoot, originals);
  assert.equal(result.folders.find(({ path }) => path === pendingFolder).reasonDraft, '示例事由');
  assert.equal(result.folders.find(({ path }) => path === pendingFolder).match.projectNo, 'FIXTURE');
  assert.equal(result.folders.find(({ path }) => path === bookedFolder).reimbursed, true);
  assert.equal(result.claims.length, 1);
  assert.equal((await request('/api/claim-groups', { sourceRoot: originals, folders: [bookedFolder] })).status, 409);
  assert.equal((await request('/api/plans', { sourceRoot: oldRoot, folder: pendingFolder, subject: '其他' })).status, 409);
  assert.equal((await request('/api/funding-summary')).body.year, '2026');
  assert.equal(await readFile(join(originals, bookedFolder, 'receipt.txt'), 'utf8'), data);
  assert.deepEqual(await readdir(oldRoot), []);
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
