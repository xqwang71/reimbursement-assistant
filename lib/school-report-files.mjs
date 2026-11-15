import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { readDownloadedRegister, readFundingExports } from './funding-summary.mjs';

const filenames = {
  smart: { xlsx: '报销单统计.xlsx', xls: '报销单统计.xls' },
  legacy: { xlsx: '报销单查询.xlsx', xls: '报销单查询.xls' },
};

const hash = (content) => createHash('sha256').update(content).digest('hex');
const number = (value) => String(value || '').trim().replace(/^(\d+)\.0+$/, '$1');

function reportNames(kind, category) {
  if (kind !== 'labor') return filenames[kind];
  const name = String(category || '').normalize('NFKC').trim();
  if (!/^[\p{L}\p{N} ()·—_-]{1,60}$/u.test(name)) throw new Error('学校薪酬套类名称无法保存，请核对。');
  const label = /劳务费$/.test(name) ? name : `薪酬申报-${name}`;
  return { xlsx: `${label}导出.xlsx`, xls: `${label}导出.xls` };
}

export async function installSchoolRegister({ downloadPath, sourceRoot, runtimeDir, year, kind, category, expectedCount = null, guard }) {
  const { size } = await stat(downloadPath);
  if (!size || size > 64 * 1024 * 1024) throw new Error('下载的 Excel 大小异常，已保留当前执行表。');
  const bytes = await readFile(downloadPath);
  const signature = bytes.subarray(0, 8).toString('hex');
  const extension = signature.startsWith('504b0304') ? 'xlsx' : signature === 'd0cf11e0a1b11ae1' ? 'xls' : '';
  if (!extension) throw new Error('学校返回的文件不是可读取的 Excel，已保留当前执行表。');
  const names = reportNames(kind, category);
  const filename = names[extension];
  const staged = extname(downloadPath).toLowerCase() === `.${extension}` ? downloadPath : `${downloadPath}.${extension}`;
  if (staged !== downloadPath) await rename(downloadPath, staged);
  const records = await readDownloadedRegister(staged, kind).catch(() => { throw new Error('下载表缺少单号、经费项目或金额等字段，已保留当前执行表。'); });
  if (expectedCount !== null && records.length !== expectedCount) {
    throw new Error(`学校查询有 ${expectedCount} 条，Excel 读到 ${records.length} 条。已保留当前执行表。`);
  }
  if (records.some(({ date }) => date && !date.startsWith(`${year}-`))) {
    throw new Error(`下载表含其他年度的记录，请核对学校查询范围。已保留当前执行表。`);
  }
  const target = join(sourceRoot, filename);
  const alternatives = Object.values(names);
  const readCurrent = (name) => readFile(join(sourceRoot, name)).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const previous = await Promise.all(alternatives.map(async (name) => ({ name, content: await readCurrent(name) })));
  const existing = await readFundingExports(sourceRoot, year);
  if (existing.year !== year) throw new Error('票据目录的报销年度已变化，请重新同步。');
  const identity = (row) => kind === 'labor' ? row.laborKey : number(row.financeId);
  const seen = new Set(records.map(identity));
  const missing = new Set(existing.records.filter((row) => row.kind === kind && alternatives.includes(row.file) && !seen.has(identity(row))).map(identity));
  if (missing.size) throw new Error(`下载表少了 ${missing.size} 条现有记录。已保留当前执行表，请检查学校查询范围。`);
  if (!records.length && expectedCount !== 0) throw new Error('学校返回空表，未能核对查询记录数，已保留当前执行表。');
  const lastDate = records.map(({ date }) => date).filter(Boolean).sort().at(-1) || '';
  const old = previous.find(({ name }) => name === filename)?.content;
  if (existing.sources.some((source) => source.kind === kind && source.file === filename) && old?.equals(bytes)) {
    return { filename, rowCount: records.length, lastDate, updated: false };
  }
  await guard();
  const backup = join(runtimeDir, 'school-export-backups', year, kind);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const { name, content } of previous) {
    if (!content) continue;
    await writeFile(join(backup, `${hash(content)}-${name}`), content, { flag: 'wx', mode: 0o600 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  const temporary = join(sourceRoot, `.${filename}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await guard();
    for (const { name, content } of previous) {
      const current = await readCurrent(name);
      if (content ? !current?.equals(content) : current !== null) throw new Error('同步期间执行表已更新，请重新同步。');
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return { filename, rowCount: records.length, lastDate, updated: true };
}
