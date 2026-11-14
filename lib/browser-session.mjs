import { chromium } from 'playwright';
import { execFile, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { browserExecutable } from './platform.mjs';

const browserProfile = (appDir) => join(appDir, '.runtime', 'browser-chrome');

function run(command, args) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: 8000, windowsHide: true }, (error, stdout) => resolvePromise({ stdout: error ? '' : stdout }));
  });
}

let sessionPromise;
let sessionAppDir;

async function debugEndpoint(profileDir) {
  const portFile = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8').catch(() => '');
  const [port, endpoint] = portFile.trim().split(/\r?\n/);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[a-z\d-]+$/i.test(endpoint)) return null;
  return `ws://127.0.0.1:${port}${endpoint}`;
}

async function connectProfile(profileDir) {
  const endpoint = await debugEndpoint(profileDir);
  return endpoint ? chromium.connectOverCDP(endpoint, { timeout: 4000, noDefaults: true, isLocal: true }) : null;
}

async function runningChromeBrowsers() {
  const { stdout } = process.platform === 'win32'
    ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Where-Object { $_.Name -in @("chrome.exe","msedge.exe") } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'])
    : await run('pgrep', ['-fl', 'chrome|chromium']);
  return stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

async function openSession(appDir, existingOnly = false) {
  const localProfile = browserProfile(appDir);
  const previousProfile = await realpath(`${localProfile}-existing`).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  // A live Chrome window may still hold the original draft after moving the worklist.
  const previousBrowser = previousProfile ? await connectProfile(previousProfile).catch(() => null) : null;
  const profileDir = previousBrowser ? previousProfile : localProfile;
  const running = await runningChromeBrowsers();
  const managed = running.find((item) => {
    const profile = item.command.match(/--user-data-dir=(.*?)(?=\s+--|\s+about:blank|$)/)?.[1].replace(/^"|"$/g, '');
    return process.platform === 'win32' ? profile?.toLowerCase() === profileDir.toLowerCase() : profile === profileDir;
  });
  let browser = previousBrowser || await connectProfile(profileDir).catch(() => null);
  let pid = managed?.pid;
  if (!browser && managed) {
    for (let attempt = 0; attempt < 2 && !browser; attempt += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 350); });
      browser = await connectProfile(profileDir).catch(() => null);
    }
    if (!browser) throw new Error('报销专用 Chrome 暂时没有响应，请保留原标签后重试。');
  }
  if (!browser && existingOnly) throw new Error('找不到原报销专用浏览器，请保留原单并核对当前状态。');
  if (!browser) {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    const child = spawn(browserExecutable(), [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    let launchError;
    child.on('error', (error) => { launchError = error; });
    child.unref();
    pid = child.pid;
    const deadline = Date.now() + 20000;
    while (!browser && Date.now() < deadline) {
      if (launchError?.code === 'ENOENT') throw new Error('未找到 Chrome 或可用的 Chromium 浏览器，请安装后重试');
      if (launchError || child.exitCode !== null) throw new Error('报销专用 Chrome 启动失败，请重试');
      browser = await connectProfile(profileDir).catch(() => null);
      if (!browser) await new Promise((resolvePromise) => { setTimeout(resolvePromise, 350); });
    }
    if (!browser) throw new Error('未能连接报销专用 Chrome，请重试');
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error('报销专用 Chrome 没有可用的窗口');
  const pages = context.pages();
  const page = pages.find((item) => /\/microportalweb\//.test(new URL(item.url()).pathname)) ||
    pages.find((item) => new URL(item.url()).hostname === 'authserver.suibe.edu.cn') || pages[0];
  return { browser, context, pid, page };
}

export async function getBrowserSession(appDir, { temporary = false, existingOnly = false } = {}) {
  if (sessionAppDir !== resolve(appDir)) { sessionPromise = null; sessionAppDir = resolve(appDir); }
  if (sessionPromise) {
    try {
      const session = await sessionPromise;
      if (!session.browser.isConnected()) sessionPromise = null;
    } catch {}
  }
  sessionPromise ||= openSession(appDir, existingOnly);
  try {
    const session = await sessionPromise;
    if (existingOnly) return session;
    if (temporary) return { ...session, page: await session.context.newPage() };
    if (!session.page || session.page.isClosed()) session.page = await session.context.newPage();
    return session;
  } catch (error) {
    sessionPromise = null;
    throw error;
  }
}

export async function browserTargetId(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo');
    return targetInfo.targetId;
  } finally {
    await session.detach();
  }
}

export async function browserPageForTarget(context, targetId) {
  if (!targetId) return null;
  for (const page of context.pages()) {
    if (!page.isClosed() && await browserTargetId(page).catch(() => null) === targetId) return page;
  }
  return null;
}

export async function savePlatformSession(page, appDir) {
  const url = new URL(page.url());
  if (url.hostname !== 'znbx.suibe.edu.cn' || url.pathname !== '/microportalweb/') return;
  const runtimeDir = join(appDir, '.runtime');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, 'ego-platform-url.txt'), `${url.origin}${url.pathname}#/main`, { mode: 0o600 });
}

export async function savedPlatformUrl(appDir) {
  try { return await readFile(join(appDir, '.runtime', 'ego-platform-url.txt'), 'utf8'); } catch { return ''; }
}
