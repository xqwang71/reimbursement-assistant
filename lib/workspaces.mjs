import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isInsideDirectory, privateDataDirectory, receiptDirectory } from './platform.mjs';

export const EXAMPLE_OWNER = '示例';
export const isWorkspaceYear = (year) => typeof year === 'string' && /^20\d{2}$/.test(year);
export const ownerDirectory = (program) => join(program, 'owner');

function validOwner(name) {
  return typeof name === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u.test(name) &&
    name === name.trim() && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(name);
}

async function localDirectory(path) {
  const entry = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (entry && !entry.isDirectory()) throw new Error('使用人与年度目录须为本机的普通文件夹。');
  return entry ? realpath(path) : null;
}

async function directoriesByYear(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  return entries.filter((entry) => entry.isDirectory() && isWorkspaceYear(entry.name))
    .map(({ name }) => name).sort();
}

export async function readWorkspaceSources(dataDirectory) {
  const runtime = await localDirectory(join(dataDirectory, '.runtime'));
  if (!runtime) return new Map();
  const directory = join(runtime, 'annual-sources');
  if (!await localDirectory(directory)) return new Map();
  const files = await readdir(directory, { withFileTypes: true });
  const years = files.filter((file) => file.isFile() && /^20\d{2}\.json$/.test(file.name));
  return new Map(await Promise.all(years.map(async ({ name }) => {
    const { sourceRoot, previousRoots } = JSON.parse(await readFile(join(directory, name), 'utf8'));
    const absolute = (path) => typeof path === 'string' && isAbsolute(path);
    if (!absolute(sourceRoot) || !Array.isArray(previousRoots) || !previousRoots.every(absolute)) throw new Error('年度票据目录设置格式有误。');
    return [name.slice(0, 4), { sourceRoot, previousRoots }];
  })));
}

export async function saveWorkspaceSource(program, workspace, inputDirectory) {
  const { dataDirectory, year, sourceRoot: previous } = workspace;
  if (workspace.example || !isWorkspaceYear(year)) throw new Error('请选择自己的使用人和年度。');
  await privateDataDirectory(program, { REIMBURSEMENT_RUNNER_DATA_DIR: dataDirectory }, workspace);
  const input = typeof inputDirectory === 'string' ? inputDirectory.trim().replace(/^"(.*)"$/, '$1') : '';
  if (!isAbsolute(input)) throw new Error('请填写原票据文件夹的完整路径。');
  const sourceRoot = await receiptDirectory(input, await realpath(program), dataDirectory, workspace);
  if (sourceRoot === previous) return workspace;
  if (sourceRoot === dataDirectory || isInsideDirectory(dataDirectory, sourceRoot) || isInsideDirectory(sourceRoot, dataDirectory)) {
    throw new Error('请选择位于使用人资料目录之外的原票据文件夹。');
  }
  await readdir(sourceRoot).catch(() => { throw new Error('原票据文件夹不存在或不可读。'); });
  const current = await readWorkspaceSources(dataDirectory);
  const saved = current.get(year);
  if (saved && previous !== saved.sourceRoot) throw new Error('年度票据目录已变化，请刷新后重试。');
  for (const [otherYear, other] of current) {
    if (year !== otherYear && [other.sourceRoot, ...other.previousRoots].some((otherRoot) =>
      sourceRoot === otherRoot || isInsideDirectory(otherRoot, sourceRoot) || isInsideDirectory(sourceRoot, otherRoot))) {
      throw new Error('请选择独立于其他年度的原票据文件夹。');
    }
  }
  const previousRoots = [...new Set([...(saved?.previousRoots || []), previous].filter((path) => path && path !== sourceRoot))];
  const directory = join(dataDirectory, '.runtime', 'annual-sources');
  await mkdir(directory, { mode: 0o700, recursive: true });
  await localDirectory(directory);
  const temporary = join(directory, `${year}-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ sourceRoot, previousRoots }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, `${year}.json`));
  return { ...workspace, sourceRoot };
}

export function workspaceRecordRoot(sources, root) {
  for (const { sourceRoot, previousRoots } of sources.values()) {
    if (previousRoots.includes(root)) return sourceRoot;
  }
  return root;
}

export async function listWorkspaces(program) {
  const examples = join(program, 'examples');
  const exampleYears = await localDirectory(examples) ? (await directoriesByYear(examples)).filter((year) => year !== '2099') : [];
  const root = await localDirectory(ownerDirectory(program));
  const owners = [];
  for (const entry of root ? await readdir(root, { withFileTypes: true }) : []) {
    const name = entry.name.normalize('NFC');
    if (entry.isDirectory() && validOwner(name) && name !== EXAMPLE_OWNER) {
      const dataDirectory = join(root, entry.name);
      const sources = await readWorkspaceSources(dataDirectory);
      const years = [...new Set([...await directoriesByYear(dataDirectory), ...sources.keys()])].sort();
      owners.push({ name, years });
    }
  }
  owners.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return [...(exampleYears.length ? [{ name: EXAMPLE_OWNER, years: exampleYears, example: true }] : []), ...owners];
}

export async function resolveWorkspace(program, input) {
  const owner = typeof input?.owner === 'string' ? input.owner.trim().normalize('NFC') : '';
  const { year, create } = input ?? {};
  if (!validOwner(owner)) throw new Error('使用人名称请用 1–40 个字母、数字、汉字、空格、横线或下划线。');
  if (!isWorkspaceYear(year)) throw new Error('请输入 2000–2099 之间的四位年度。');
  if (owner === EXAMPLE_OWNER) {
    if (create) throw new Error('请选择其他名称来创建自己的使用人目录。');
    const example = (await listWorkspaces(program)).find(({ name }) => name === EXAMPLE_OWNER);
    if (!example?.years.includes(year)) throw new Error('没有这一年度的示例。');
    const root = await localDirectory(join(program, 'examples', year));
    const localRoot = ownerDirectory(program);
    await mkdir(localRoot, { mode: 0o700, recursive: true });
    await localDirectory(localRoot);
    const demo = join(localRoot, '.example');
    await mkdir(demo, { mode: 0o700, recursive: true });
    return { owner, year, dataDirectory: await localDirectory(demo), sourceRoot: root, example: true };
  }
  const directory = ownerDirectory(program);
  if (create) await mkdir(directory, { mode: 0o700, recursive: true });
  const root = await localDirectory(directory);
  if (!root) throw new Error('还没有本机使用人，请先新建。');
  const names = await readdir(root);
  const actual = names.find((name) => name.normalize('NFC').toLowerCase() === owner.toLowerCase()) ?? owner;
  const target = join(root, actual);
  if (create) await mkdir(target, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const dataDirectory = await localDirectory(target);
  if (!dataDirectory) throw new Error('本机使用人目录不存在，请刷新选择。');
  const sources = await readWorkspaceSources(dataDirectory);
  const saved = sources.get(year);
  const sourceRoot = saved ? await receiptDirectory(saved.sourceRoot, await realpath(program), dataDirectory) : await localDirectory(join(dataDirectory, year));
  const workspace = { owner: actual.normalize('NFC'), year, dataDirectory, sourceRoot, example: false };
  if (!sourceRoot && create) return saveWorkspaceSource(program, workspace, input.sourceRoot);
  if (!sourceRoot) throw new Error('这个年度还没有设置原票据目录。');
  if (create && input.sourceRoot !== undefined) throw new Error('这个年度已存在。可打开后在设置里修改原票据目录。');
  return workspace;
}

export function publicWorkspace(workspace) {
  if (!workspace) return null;
  const { owner, year, example } = workspace;
  return { owner, year, example };
}

export async function workspacePreference(program) {
  const directory = await localDirectory(ownerDirectory(program));
  if (!directory) return {};
  return readFile(join(directory, '.workspace.json'), 'utf8').then(JSON.parse, (error) => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
}

export async function rememberWorkspace(program, { owner, year, port, activePort }) {
  const directory = await localDirectory(ownerDirectory(program));
  if (!directory) return;
  const temporary = join(directory, `.workspace-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify({ owner, year, port, activePort }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, join(directory, '.workspace.json'));
}

export function requestWorkspaceProcess(peer, action, data, timeout = 22000) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      clearTimeout(timer);
      peer.removeListener('message', onMessage);
      peer.removeListener('disconnect', onDisconnect);
      if (error) reject(error);
      else resolve(result);
    };
    const onMessage = (message) => {
      if (message?.workspaceReply !== id) return;
      finish(message.error ? new Error(message.error) : null, message.result);
    };
    const onDisconnect = () => finish(new Error('本机启动器已退出，请重新打开报销助手。'));
    const timer = setTimeout(() => finish(new Error('本机资料切换超时，请重试。')), timeout);
    peer.on('message', onMessage);
    peer.once('disconnect', onDisconnect);
    peer.send({ workspaceRequest: id, action, data }, (error) => { if (error) finish(error); });
  });
}

export function answerWorkspaceRequests(peer, action, handle) {
  peer.on('message', (message) => {
    if (!message?.workspaceRequest || message.action !== action) return;
    const reply = (result) => {
      if (peer.connected) peer.send({ workspaceReply: message.workspaceRequest, ...result }, () => {});
    };
    Promise.resolve().then(() => handle(message.data)).then((result) => reply({ result }), (error) => reply({ error: error.message }));
  });
}
