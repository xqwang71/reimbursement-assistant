import { execFile } from 'node:child_process';
import { copyFile, link, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isInsideDirectory, pythonExecutable } from './platform.mjs';

const exec = promisify(execFile);
const pdfTextScript = fileURLToPath(new URL('../scripts/pdf_text.py', import.meta.url));
const maxPdfBytes = 32 * 1024 * 1024;
const schoolNumber = /^\d{13}$/;
const compact = (text) => String(text ?? '').normalize('NFKC').replace(/\s+/g, '');
const escapeRegExp = (text) => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

async function appointmentText(file) {
  const readWithPoppler = () => exec('pdftotext', ['-enc', 'UTF-8', '-layout', file, '-'], { timeout: 10000 });
  const readWithPython = () => exec(pythonExecutable(), ['-X', 'utf8', pdfTextScript, file], { timeout: 10000 });
  const [first, fallback] = process.platform === 'win32'
    ? [readWithPython, readWithPoppler]
    : [readWithPoppler, readWithPython];
  const { stdout } = await first().catch(fallback);
  return stdout;
}

function checkPdfBytes(data) {
  if (data.length > maxPdfBytes || !data.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
      !data.subarray(-2048).includes(Buffer.from('%%EOF'))) throw new Error('学校返回的预约单 PDF 不完整');
}

async function checkAppointmentPdf(file, number, expected) {
  const text = (await appointmentText(file).catch(() => {
    throw new Error('无法读取预约单 PDF 的文字，请检查 PDF 读取组件');
  })).normalize('NFKC');
  const numbers = new Set(text.match(/(?<!\d)\d{13}(?!\d)/g) || []);
  const financeFormId = number || (numbers.size === 1 ? [...numbers][0] : null);
  if (!numbers.has(financeFormId) || !/附件张数|附件份数/.test(text) || !/预约日期|报销事由/.test(text)) {
    throw new Error('PDF 上的学校单号或预约单内容与本笔不符');
  }
  if (expected) {
    const plain = compact(text);
    const dates = plain.replace(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/g,
      (_, year, month, day) => [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-'));
    const amount = (expected.totalCny / 100).toFixed(2);
    const matchesProject = [expected.project.projectNo, expected.project.projectName].some((value) =>
      value && plain.toUpperCase().includes(compact(value).toUpperCase()));
    if (!plain.includes(compact(expected.reason)) || !matchesProject ||
        !new RegExp('(?<!\\d)' + escapeRegExp(amount) + '(?!\\d)').test(text.replace(/(?<=\d),(?=\d)/g, '')) ||
        !dates.includes(expected.date) || !plain.includes(expected.campus || '松江')) {
      throw new Error('预约单 PDF 的事由、项目、金额或预约地点时间与本笔不符');
    }
  }
  return financeFormId;
}

export async function saveAppointmentPdf(sourceRoot, folder, financeFormId, bytes, expected = null) {
  if (financeFormId && !schoolNumber.test(financeFormId)) throw new Error('学校报销单号格式有误');
  if (!financeFormId && !bytes) return null;
  if (!financeFormId && !expected) throw new Error('需要核对学校报销单号与本笔事项');
  const root = await realpath(sourceRoot);
  const directory = await realpath(resolve(root, folder));
  if (!isInsideDirectory(root, directory) || directory === root) throw new Error('找不到本笔报销的原票据文件夹');
  const destination = (number) => {
    const name = '报销预约单-' + number + '.pdf';
    return { path: join(directory, name), name, financeFormId: number };
  };
  async function existingPdf(file) {
    const existing = await lstat(file.path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!existing) return null;
    if (!existing.isFile() || existing.size > maxPdfBytes) throw new Error('票据文件夹已存在同名文件，请核对');
    checkPdfBytes(await readFile(file.path));
    await checkAppointmentPdf(file.path, file.financeFormId, expected);
    return file;
  }
  const existing = financeFormId ? await existingPdf(destination(financeFormId)) : null;
  if (existing) return existing;
  if (!bytes) return null;
  checkPdfBytes(bytes);
  const temporary = join(directory, '.' + randomUUID() + '.pdf');
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try {
    const file = destination(await checkAppointmentPdf(temporary, financeFormId, expected));
    try {
      await link(temporary, file.path).catch(async (error) => {
        if (!['EXDEV', 'EPERM', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
        await copyFile(temporary, file.path, constants.COPYFILE_EXCL);
      });
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return existingPdf(file);
    }
    return file;
  } finally {
    await rm(temporary, { force: true });
  }
}

const cups = (args) => exec('lpstat', args, { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } })
  .then(({ stdout }) => stdout, () => '');

async function acceptsPrintJobs(queue) {
  const text = await cups(['-a', queue, '-p', queue]);
  return (text.startsWith(queue + ' accepting requests') || text.startsWith(queue + '正在接受请求')) &&
    !/ is disabled\b|已禁用|已停用|未启用/.test(text);
}

export async function defaultPrintQueue() {
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Printer -Filter "Default = TRUE" | Where-Object { -not $_.WorkOffline -and $_.PrinterStatus -ne 7 -and $_.Name -notmatch "PDF|XPS|OneNote|Fax" } | Select-Object -ExpandProperty Name'],
    { timeout: 8000 }).catch(() => ({ stdout: '' }));
    return stdout.trim() || null;
  }
  const queue = (await cups(['-d'])).match(/^(?:system default destination|系统默认目的位置)[:：]\s*(.+)$/m)?.[1]?.trim();
  return queue && await acceptsPrintJobs(queue) ? queue : null;
}

export async function printAppointmentPdf(file, queue) {
  if (process.platform === 'win32') {
    const path = `'${file.replaceAll("'", "''")}'`;
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${path} -Verb Print`], { timeout: 12000 });
    return '已交给本机默认打印程序';
  }
  const { stdout } = await exec('lp', ['-d', queue, '-n', '1', file], { timeout: 10000 });
  return stdout.match(new RegExp(escapeRegExp(queue) + '-\\d+'))?.[0] || '已送到打印队列';
}
