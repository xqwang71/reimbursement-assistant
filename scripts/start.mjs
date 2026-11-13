import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, privateDataDirectory, profileId } from '../lib/platform.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const port = Number(process.env.PORT || DEFAULT_PORT);
const url = `http://127.0.0.1:${port}`;
const installOcr = process.argv.includes('--install-ocr');
const openBrowser = !process.argv.includes('--no-open');

function run(command, args, message) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(message);
}

function canRun(command, args) {
  return spawnSync(command, args, { stdio: 'ignore', windowsHide: true }).status === 0;
}

function findPython() {
  const override = process.env.REIMBURSEMENT_PYTHON;
  const candidates = override ? [[override]]
    : windows ? [['py', '-3.12'], ['py', '-3.11'], ['py', '-3'], ['python']]
      : [['python3.12'], ['python3.11'], ['python3']];
  const checkVersion = 'import sys; sys.exit(not (sys.version_info >= (3, 10)))';
  const match = candidates.find(([command, ...args]) => canRun(command, [...args, '-c', checkVersion]));
  if (!match) throw new Error('请先安装 Python 3.10 或更新版本。建议使用 Python 3.11 或 3.12。');
  return match;
}

async function preparePython(userData) {
  const directory = join(userData, 'python');
  const python = windows ? join(directory, 'Scripts', 'python.exe') : join(directory, 'bin', 'python');
  const basicImports = 'import openpyxl, xlrd, pypdfium2';
  if (!existsSync(python)) {
    const override = process.env.REIMBURSEMENT_PYTHON;
    if (!installOcr && override && canRun(override, ['-c', basicImports])) return override;
    const [command, ...args] = findPython();
    await mkdir(userData, { recursive: true, mode: 0o700 });
    run(command, [...args, '-m', 'venv', directory], '无法创建本机 Python 环境。请检查 Python 和文件夹权限。');
  }
  const imports = installOcr ? `${basicImports}, PIL, rapidocr, onnxruntime, docx` : basicImports;
  if (!canRun(python, ['-c', imports])) {
    const requirements = installOcr ? 'requirements-ocr.txt' : 'requirements.txt';
    run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(root, requirements)],
      '安装 Python 依赖失败。请检查网络和 Python 版本后重试。');
  }
  if (installOcr) {
    run(python, ['-X', 'utf8', join(root, 'scripts', 'rapid_ocr.py'), '--setup'], '本机 OCR 初始化失败。');
  }
  return python;
}

async function health(expectedProfile) {
  try {
    const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(500) });
    const payload = await response.json().catch(() => null);
    return payload?.edition === 'community' && payload.profile === expectedProfile ? 'ready' : 'occupied';
  } catch { return ''; }
}

function showPage() {
  if (!openBrowser) return;
  const command = windows ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log('请在浏览器打开 ' + url));
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 13) throw new Error('请先安装 Node.js 22.13 或更新版本。');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应为 1 到 65535 的整数。');
  const userData = await privateDataDirectory(root);
  const profile = profileId(userData);
  const current = await health(profile);
  if (current === 'occupied') throw new Error('本机端口已被其他程序或用户数据目录使用。请关闭占用端口的程序，或更改 PORT。');
  if (current === 'ready' && !installOcr) return showPage();
  const python = await preparePython(userData);
  if (installOcr) return console.log('OCR 组件已安装。请重新打开报销助手。');
  if (!existsSync(join(root, 'node_modules', 'playwright', 'package.json'))) {
    if (windows) run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm ci --no-audit --no-fund'], '安装 Node.js 依赖失败。');
    else run('npm', ['ci', '--no-audit', '--no-fund'], '安装 Node.js 依赖失败。');
  }
  const server = spawn(process.execPath, [join(root, 'server.mjs')], {
    cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, REIMBURSEMENT_PYTHON: python },
  });
  server.on('error', () => { process.exitCode = 1; });
  server.on('exit', (code) => { process.exitCode = code || 0; });
  for (let attempt = 0; attempt < 40 && server.exitCode === null && server.signalCode === null; attempt += 1) {
    if (await health(profile) === 'ready') return showPage();
    await delay(250);
  }
  if (server.exitCode === null && server.signalCode === null) server.kill();
  throw new Error('服务未能启动。请检查上方错误，或换一个本机端口后重试。');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
