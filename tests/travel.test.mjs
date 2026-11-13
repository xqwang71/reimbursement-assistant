import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { browserExecutable } from '../lib/platform.mjs';
import { createPlan, fingerprintFolder, validatePlanForExecution } from '../lib/planner.mjs';
import { confirmClaimPurpose } from '../lib/claim-purpose.mjs';
import { ReimbursementExecutor } from '../lib/executor.mjs';
import { travelPortal, travelSchoolForm } from './travel-browser-fixture.mjs';

const project = { projectNo: 'TEST-2026-01', projectName: '金融教学测试' };
const purpose = { reason: '合肥差旅：参加虚构数字教学研讨会', confirmed: true };
const trip = {
  destination: '安徽合肥', startDate: '2099-08-11', endDate: '2099-08-14', travelerCount: 1, travelers: [{ name: '示例出差人' }],
  segments: [
    { travelDate: '2099-08-11', serviceNumber: 'MU9001', departure: '上海', destination: '合肥', transportMode: '飞机', ticketAmount: 512 },
    { travelDate: '2099-08-14', serviceNumber: 'MU9002', departure: '合肥', destination: '上海', transportMode: '飞机', ticketAmount: 638 },
  ],
  lodgingStays: [{ location: '安徽合肥', checkInDate: '2099-08-11', checkOutDate: '2099-08-14', amount: 1265, guestCount: 1 }],
  flightPurchaseChannel: 'third_party',
};

async function simulationDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'runner-domestic-travel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function syntheticSample(t, { includeCorrectDate = true } = {}) {
  const appDir = await simulationDirectory(t);
  const sourceRoot = join(appDir, 'source');
  const folder = '差旅/合肥模拟';
  await mkdir(join(sourceRoot, folder), { recursive: true });
  const seller = '上海示例国际旅行社有限公司';
  const hotel = '合肥示例酒店有限公司';
  const invoice = (number, sellerName, item, price) =>
    `发票号码：${number}\n销 名称：${sellerName}\n*${item}\n（小写）¥${price}\n开票日期：2099年08月15日`;
  const payment = (name, price) => `交易成功\n支付金额：${price}\n支付时间：2099-08-05\n对方户名\n${name}`;
  const comparison = (month) =>
    `政府采购机票管理网站\n已选择的去程航班：出发日期：2099-${month}-11\n东方航空MU9001\n已选择的回程航班：出发日期：2099-${month}-14\n东方航空MU9002\n总价格：¥1430`;
  const documents = {
    '订单9000000000000201-电子普通发票(1).pdf': invoice('12345678901234567890', seller, '服务*代订机票', '512.00'),
    '订单9000000000000201-电子普通发票(2).pdf': invoice('12345678901234567891', seller, '服务*代订机票', '638.00'),
    '住宿发票.pdf': invoice('12345678901234567892', hotel, '服务*住宿费', '1265.00'),
    '合并付款.jpg': payment(seller, '1150.00'),
    '酒店付款.jpg': payment(hotel, '1265.00'),
    '九月比价.png': comparison('09'),
    ...(includeCorrectDate ? { '八月比价.png': comparison('08') } : {}),
    '行程单.png': '订单详情\n2099-08-11 上海到合肥\n东航MU9001\n2099-08-14 合肥到上海\n东航MU9002',
    '酒店水单.pdf': '合肥示例酒店\n入离日期：2099年8月11日 - 2099年8月14日\n总金额 1265.00',
  };
  for (const [name, text] of Object.entries(documents)) await writeFile(join(sourceRoot, folder, name), text);
  const { files, fingerprint } = await fingerprintFolder(sourceRoot, folder);
  const cache = join(appDir, '.runtime/cache', encodeURIComponent(folder));
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, fingerprint + '.json'), JSON.stringify({ documents: files.map((file) => ({ file, text: documents[file.name] })) }));
  await writeFile(join(cache, 'travel-' + fingerprint + '.json'), JSON.stringify({ facts: trip }));
  return { appDir, sourceRoot, folder, subject: '差旅', funding: '教学', project };
}

async function planFor(input) {
  const original = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = '';
  try { return confirmClaimPurpose(await createPlan({ ...input, paymentType: '教职工银行-建设银行', signer: { name: '示例教学加签人', employeeNo: '980001' } }), purpose); }
  finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = original;
  }
}

test('a comparison with the same flight numbers on a different date cannot clear the travel plan', async (t) => {
  const plan = await planFor(await syntheticSample(t, { includeCorrectDate: false }));
  assert.equal(plan.status, 'blocked');
  assert.match(plan.blockers.join('\n'), /公务机票比价截图/);
  assert.ok(!plan.uploadFiles.some(({ name }) => name === '九月比价.png'));
});

test('domestic travel reaches submission preview on the simulated school without submitting', async (t) => {
  const input = await syntheticSample(t);
  const expectedFile = '八月比价.png';
  const plan = await planFor(input);
  assert.equal(plan.status, 'ready', plan.blockers.join('\n'));
  assert.equal(plan.invoiceTotalCny, 241500);
  assert.equal(plan.paidTotalCny, 241500);
  assert.equal(plan.ticketTotalCny, 220000);
  assert.equal(plan.totalCny, 292000);
  assert.deepEqual(plan.travel.flight.comparisonFiles, [expectedFile]);
  assert.ok(plan.uploadFiles.some(({ name }) => name === expectedFile));
  assert.equal(plan.uploadFiles.length, 8);
  assert.equal(new Set(plan.rows.filter(({ travelKind }) => travelKind === 'flight').flatMap(({ paymentFiles }) => paymentFiles)).size, 1);
  const validate = () => validatePlanForExecution({ plan, sourceRoot: input.sourceRoot });
  await validate();
  await assert.rejects(validatePlanForExecution({ plan: { ...plan, totalCny: plan.ticketTotalCny }, sourceRoot: input.sourceRoot }), /计划金额校验失败/);
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (pathname === '/microportalweb/') return response.end(travelPortal());
    if (/^\/(?:ClaimsPublicPCWeb\/(?:fast-reimbursement|reimburse|filling)|TravelPCWeb\/travel-reimbursement)$/.test(pathname)) {
      return response.end(travelSchoolForm(plan, pathname));
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const executablePath = process.env.CI ? process.env.RUNNER_CHROME_BIN : browserExecutable();
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking'] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin + '/microportalweb/');
  const trace = [];
  const control = { skipSubmit: true, autoSubmit: true };
  const executor = new ReimbursementExecutor({
    plan, appDir: input.appDir, control, validate,
    onEvent: ({ step }) => trace.push(step),
    ask: async (question) => assert.fail('Unexpected manual step: ' + question),
  });
  executor.page = page;
  executor.openPlatform = async () => assert.equal(page.url(), origin + '/microportalweb/');
  try {
    assert.equal(await executor.run(), 'preview', trace.join(' → '));
  } catch (error) {
    const work = await executor.work();
    t.diagnostic(JSON.stringify(await work.locator('.el-dialog:visible').evaluateAll((nodes) => nodes.map((dialog) => ({
      headings: [...dialog.querySelectorAll('th')].map((node) => node.textContent),
      rowCount: dialog.querySelectorAll('tbody tr').length,
      queryType: dialog.querySelector('input[placeholder="请选择业务单类型"]')?.value,
      controls: [...dialog.querySelectorAll('button')].map((node) => [node.textContent, node.disabled]),
    })))));
    t.diagnostic(trace.join(' → '));
    throw error;
  }
  const work = await executor.work();
  const state = await work.evaluate(() => window.travelSimulation());
  assert.equal(context.pages().length, 1);
  assert.equal(state.phase, 'pay');
  assert.equal(state.application, 'B2026-SIM-001');
  assert.equal(state.associations, 1);
  assert.deepEqual(state.files.sort(), plan.uploadFiles.map(({ name }) => name).sort());
  assert.equal(state.uploads, 1);
  assert.equal(Number(state.lodging), 1050);
  assert.equal(Number(state.meal), 400);
  assert.equal(Number(state.local), 320);
  assert.equal(Number(state.allocated), 2920);
  assert.equal(Number(state.payment), 2920);
  assert.equal(state.signer, true);
  assert.equal(state.signerConfirmClicks, 0);
  assert.equal(state.submitClicks, 0);
  assert.equal(control.progress.submission.state, 'not_started');
  assert.equal(await work.getByText('请选择线上审批加签人', { exact: true }).isVisible(), true);
});
