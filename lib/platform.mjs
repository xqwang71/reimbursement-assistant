import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const DEFAULT_PORT = 3033;

export function userDataDirectory(env = process.env) {
  const home = homedir();
  if (env.REIMBURSEMENT_RUNNER_DATA_DIR) return env.REIMBURSEMENT_RUNNER_DATA_DIR;
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'ReimbursementAssistant');
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ReimbursementAssistant');
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'reimbursement-assistant');
}

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) {
    const parent = dirname(path);
    if (error.code !== 'ENOENT' || parent === path) throw error;
    const entry = await lstat(path).catch((cause) => {
      if (cause.code !== 'ENOENT') throw cause;
      return null;
    });
    if (entry?.isSymbolicLink()) throw new Error('用户数据目录包含失效的链接，请修复链接后重试。');
    return join(await canonicalPath(parent), basename(path));
  }
}

export async function privateDataDirectory(programDir, env = process.env) {
  const program = await realpath(programDir);
  const data = await canonicalPath(resolve(userDataDirectory(env)));
  const runtime = await canonicalPath(join(data, '.runtime'));
  const python = await canonicalPath(join(data, 'python'));
  if ([data, runtime, python].some((directory) => directory === program || isInsideDirectory(program, directory)) ||
      [runtime, python].some((directory) => !isInsideDirectory(data, directory))) {
    throw new Error('请将用户数据目录放在程序目录外。');
  }
  return data;
}

export async function receiptDirectory(path, programDir, dataDirectory) {
  const receipts = await canonicalPath(path);
  const runtime = await canonicalPath(join(dataDirectory, '.runtime'));
  const python = await canonicalPath(join(dataDirectory, 'python'));
  if ([programDir, runtime, python].some((directory) => receipts === directory ||
      isInsideDirectory(directory, receipts) || isInsideDirectory(receipts, directory))) {
    throw new Error('请选择独立于程序和运行数据的票据文件夹。');
  }
  return receipts;
}

export function profileId(dataDirectory) {
  return createHash('sha256').update(dataDirectory).digest('hex');
}

export function browserExecutable(env = process.env) {
  if (env.REIMBURSEMENT_BROWSER_BIN || env.RUNNER_CHROME_BIN) return env.REIMBURSEMENT_BROWSER_BIN || env.RUNNER_CHROME_BIN;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    const candidates = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']
      .flatMap((name) => roots.map((root) => join(root, name)));
    return candidates.find(existsSync) || 'chrome.exe';
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync) || 'google-chrome';
}

export const pythonExecutable = () => process.env.REIMBURSEMENT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

export function isInsideDirectory(root, target) {
  const path = relative(root, target);
  return Boolean(path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
