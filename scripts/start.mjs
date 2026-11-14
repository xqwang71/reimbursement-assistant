import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { DEFAULT_PORT, privateDataDirectory, profileId, serviceRevision } from '../lib/platform.mjs';
import { answerWorkspaceRequests, listWorkspaces, publicWorkspace, rememberWorkspace, requestWorkspaceProcess, resolveWorkspace, workspacePreference } from '../lib/workspaces.mjs';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const windows = process.platform === 'win32';
const installOcr = process.argv.includes('--install-ocr');
const openBrowser = !process.argv.includes('--no-open');

async function ownerEnvironment(workspace) {
  const userData = await privateDataDirectory(root, { ...process.env,
    REIMBURSEMENT_RUNNER_DATA_DIR: workspace?.dataDirectory || process.env.REIMBURSEMENT_RUNNER_DATA_DIR }, workspace);
  const filename = join(userData, '.env');
  const local = await lstat(filename).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (local && !local.isFile()) throw new Error('本机资料的 .env 须是普通文件。');
  const variables = local ? parseEnv(await readFile(filename, 'utf8')) : {};
  const env = { ...variables, ...process.env, REIMBURSEMENT_RUNNER_DATA_DIR: userData };
  if (workspace) {
    for (const name of Object.keys(process.env)) {
      if (name.endsWith('_API_KEY')) delete env[name];
    }
    for (const [name, value] of Object.entries(variables)) {
      if (name.endsWith('_API_KEY')) env[name] = value;
    }
    env.REIMBURSEMENT_WORKSPACE = JSON.stringify(publicWorkspace(workspace));
    delete env.REIMBURSEMENT_SOURCE_ROOT;
  } else {
    delete env.REIMBURSEMENT_WORKSPACE;
  }
  return { userData, env };
}

function run(command, args, message) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(message);
}

function canRun(command, args) {
  return spawnSync(command, args, { stdio: 'ignore', windowsHide: true }).status === 0;
}

function findPython(override) {
  const candidates = override ? [[override]]
    : windows ? [['py', '-3.12'], ['py', '-3.11'], ['py', '-3'], ['python']]
      : [['python3.12'], ['python3.11'], ['python3']];
  const checkVersion = 'import sys; sys.exit(not (sys.version_info >= (3, 10)))';
  const match = candidates.find(([command, ...args]) => canRun(command, [...args, '-c', checkVersion]));
  if (!match) throw new Error('请先安装 Python 3.10 或更新版本。建议使用 Python 3.11 或 3.12。');
  return match;
}

async function preparePython(userData, override) {
  const directory = join(userData, 'python');
  const python = windows ? join(directory, 'Scripts', 'python.exe') : join(directory, 'bin', 'python');
  const basicImports = 'import openpyxl, xlrd, pypdfium2';
  if (!existsSync(python)) {
    if (!installOcr && override && canRun(override, ['-c', basicImports])) return override;
    const [command, ...args] = findPython(override);
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

async function health(url) {
  try {
    const response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) });
    const payload = await response.json().catch(() => null);
    return response.ok && payload?.ok === true && payload.edition === 'community' ? payload : {};
  } catch { return null; }
}

function showPage(url) {
  if (!openBrowser) return;
  const command = windows ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log('请在浏览器打开 ' + url));
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 13) throw new Error('请先安装 Node.js 22.13 或更新版本。');
  const managed = !process.env.REIMBURSEMENT_RUNNER_DATA_DIR && !process.env.REIMBURSEMENT_SOURCE_ROOT;
  const preference = managed ? await workspacePreference(root) : null;
  let initial = null;
  if (managed) {
    const owners = await listWorkspaces(root);
    const available = owners.filter(({ years }) => years.length);
    const selected = available.find(({ name, years }) => name === preference?.owner && years.includes(preference?.year));
    if (!available.length) throw new Error('请选择或创建一个使用人目录，并在里面创建四位数字的年度目录。');
    initial = await resolveWorkspace(root, selected ? preference : { owner: available[0].name, year: available[0].years[0] });
  }
  const port = Number(process.env.PORT || (managed ? preference?.port : null) || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口应为 1 到 65535 的整数。');
  const url = `http://127.0.0.1:${port}`;
  const settings = await ownerEnvironment(initial);
  const current = await health(url);
  const sameLauncher = managed
    ? current?.program === profileId(root) && current?.workspaceManaged === true
    : current?.profile === profileId(settings.userData);
  if (current && !sameLauncher) throw new Error('本机端口已被其他程序或用户资料占用。请关闭旧助手，或设置另一个 PORT。');
  if (sameLauncher && !installOcr) {
    if (current.revision !== await serviceRevision(root)) {
      throw new Error(`报销助手 ${url} 仍在运行更新前的程序。请在原启动窗口按 Ctrl+C 停止服务，再双击打开报销助手。`);
    }
    const activePort = preference?.activePort;
    if (managed && preference?.port === port && Number.isInteger(activePort) && activePort > 0 && activePort <= 65535 && activePort !== port) {
      const activeUrl = `http://127.0.0.1:${activePort}`;
      const active = await health(activeUrl);
      if (active?.program === current.program && active?.workspaceManaged && active.profile === profileId(settings.userData) &&
          active.revision === current.revision) return showPage(activeUrl);
    }
    return showPage(url);
  }

  const tools = managed ? await privateDataDirectory(root, { REIMBURSEMENT_RUNNER_DATA_DIR: join(root, 'owner', '.tools') },
    { dataDirectory: join(root, 'owner', '.tools') }) : settings.userData;
  const python = await preparePython(tools, process.env.REIMBURSEMENT_PYTHON || settings.env.REIMBURSEMENT_PYTHON);
  if (installOcr) return console.log('OCR 组件已安装。请重新打开报销助手。');
  if (!existsSync(join(root, 'node_modules', 'playwright', 'package.json'))) {
    if (windows) run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm ci --no-audit --no-fund'], '安装 Node.js 依赖失败。');
    else run('npm', ['ci', '--no-audit', '--no-fund'], '安装 Node.js 依赖失败。');
  }

  const servers = new Map();
  async function startOrSelect(workspace, requestedPort, initialSettings = null) {
    const key = workspace?.dataDirectory ?? settings.userData;
    const running = servers.get(key);
    if (running) {
      const { child, location } = await running;
      if (workspace) await requestWorkspaceProcess(child, 'year', publicWorkspace(workspace));
      return location;
    }
    const starting = (async () => {
      const selected = initialSettings ?? await ownerEnvironment(workspace);
      const child = spawn(process.execPath, [join(root, 'server.mjs')], {
        cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
        env: { ...selected.env, PORT: String(requestedPort),
          REIMBURSEMENT_PYTHON: selected.env.REIMBURSEMENT_PYTHON || python },
      });
      child.on('error', (error) => console.error(error.message));
      child.once('exit', (code) => {
        servers.delete(key);
        if (!servers.size && code) process.exitCode = code;
      });
      if (managed) answerWorkspaceRequests(child, 'open', async (input) => {
        const workspace = await resolveWorkspace(root, input);
        const location = await startOrSelect(workspace, 0);
        await rememberWorkspace(root, { ...workspace, port, activePort: Number(new URL(location).port) })
          .catch((error) => console.error(`无法保存本机选择。${error.message}`));
        return { ...publicWorkspace(workspace), location };
      });
      try {
        const { port } = await requestWorkspaceProcess(child, 'ready');
        return { child, location: `http://127.0.0.1:${port}/` };
      } catch (error) {
        child.kill();
        throw error;
      }
    })();
    servers.set(key, starting);
    return (await starting).location;
  }
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) process.once(signal, async () => {
    for (const startup of servers.values()) (await startup.catch(() => null))?.child.kill();
    process.exit(0);
  });
  const location = await startOrSelect(initial, port, settings);
  console.log(`请在浏览器打开 ${location}`);
  showPage(location);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
