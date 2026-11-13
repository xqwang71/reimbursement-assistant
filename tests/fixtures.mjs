import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SELECTION_VERSION } from '../lib/planner.mjs';
const defaultOrderNumber = '1234567890123456';

export const concretePurpose = {
  matter: '金融文本分析课程建设',
  use: '调试年报结构化提取实训程序所用模型调用费',
  confirmed: true,
};

export async function cachedFixture(t, { invoice = 10000, payment = 9000, order = 10000, duplicate = false, subject = 'AI服务', extra = [], folder = 'batch', invoiceNumber = '12345678901234567890', invoiceItem = '*信息技术服务*AI服务', paymentNote = '', paymentId = 'PAY-0001', orderNumber = defaultOrderNumber, omitInvoice = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'runner-regression-')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }));
  const appDir = join(directory, 'app');
  const sourceRoot = join(directory, 'source');
  const batchDir = join(sourceRoot, folder);
  await mkdir(batchDir, { recursive: true });
  const records = [
    ...(omitInvoice ? [] : [{ name: '发票.pdf', kind: 'invoice', invoiceNumber, orderNumber, invoiceAmountCny: invoice, text: `发票号码：${invoiceNumber}\n订单编号：${orderNumber}\n（小写）¥${(invoice / 100).toFixed(2)}\n开票日期：2026年11月1日\n${invoiceItem} 1 ${(invoice / 100).toFixed(2)}` }]),
    ...(order === null ? [] : [{ name: '网站订单.pdf', kind: 'detail', orderNumber, orderAmountCny: order, text: `网站订单详情\n订单编号：${orderNumber}\n实付款：¥${(order / 100).toFixed(2)}\n下单日期：2026年11月1日` }]),
    ...(payment === null ? [] : [{ name: '支付.png', kind: 'payment', paymentAmountCny: payment, text: `交易成功\n交易金额 ${(payment / 100).toFixed(2)}\n支付时间：2026年11月1日\n付款方式：工商银行信用卡(1234)\n交易单号：${paymentId}\n${payment < (order ?? invoice) ? '银行立减 优惠' : ''}\n${paymentNote}` }]),
    ...extra,
  ];
  if (duplicate) records.push({ ...records[0], name: '发票副本.pdf' });
  for (const record of records) await writeFile(join(batchDir, record.name), record.text);
  const names = (await readdir(batchDir)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const fileHashes = [];
  for (const name of names) fileHashes.push({ name, sha256: createHash('sha256').update(await readFile(join(batchDir, name))).digest('hex') });
  const fingerprint = createHash('sha256').update(JSON.stringify(fileHashes)).digest('hex');
  const documents = records.map((record) => ({ invoiceNumber: null, orderNumber: null, invoiceAmountCny: null, orderAmountCny: null, paymentAmountCny: null, date: '2026-11-01', ...record, file: { name: record.name, absolutePath: join(batchDir, record.name) } }));
  const cacheDir = join(appDir, '.runtime/cache', encodeURIComponent(folder));
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(cacheDir, `${fingerprint}.json`), JSON.stringify({ fingerprint, documents }));
  const matches = Object.fromEntries(records.filter((record) => record.kind === 'invoice').map((record) => [record.name, { detail: order === null ? [] : ['网站订单.pdf'], payment: payment === null ? [] : ['支付.png'] }]));
  const ai = { version: SELECTION_VERSION, subject, fingerprint, upload: records.map((record) => record.name), types: Object.fromEntries(records.map((record) => [record.name, record.kind])), matches, review: { status: 'complete', blockers: [] } };
  await writeFile(join(cacheDir, `selection-v${SELECTION_VERSION}-${subject}-${fingerprint}.json`), JSON.stringify(ai));
  return { appDir, sourceRoot, folder, subject, funding: '教学', project: { projectNo: 'TEST-2026-01', projectName: '模拟经费' }, paymentCardLast4: '1234', batchDir, records, fingerprint };
}

