import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MODEL_USES = {
  attachments: '附件识别',
  travel: '差旅核对',
  interaction: '执行互动',
  recovery: '故障恢复',
};
const DEEPSEEK_URL = 'https://api.deepseek.com';
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const modelConfigFile = (appDir) => join(appDir, '.runtime', 'model-config.json');

function initialSettings(legacy) {
  return {
    version: 2,
    connections: [
      { id: 'deepseek', name: 'DeepSeek API', kind: 'api', baseUrl: DEEPSEEK_URL, keyEnv: 'DEEPSEEK_API_KEY' },
      { id: 'codex', name: 'ChatGPT / Codex', kind: 'codex' },
    ],
    models: [
      { id: 'deepseek', name: 'DeepSeek', connectionId: 'deepseek', model: typeof legacy.model === 'string' && legacy.model.trim() ? legacy.model.trim() : 'deepseek-chat', effort: '' },
      { id: 'codex', name: 'Codex 默认模型', connectionId: 'codex', model: '', effort: '' },
    ],
    assignments: Object.fromEntries(Object.keys(MODEL_USES).map((purpose) => [purpose, ''])),
  };
}

export async function readModelSettings(appDir) {
  const raw = await readFile(modelConfigFile(appDir), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  });
  let saved;
  try { saved = JSON.parse(raw); }
  catch { throw new Error('已保存的模型设置格式有误'); }
  return saved?.version === 2 ? normalizeModelSettings(saved, saved) : initialSettings(saved || {});
}

function apiAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写有效的 API 地址'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('API 请使用 HTTPS 地址。本机服务可使用 HTTP 回环地址。');
  }
  return url.href.replace(/\/+$/, '');
}

function namedItem(input) {
  const { id, name } = input || {};
  if (typeof id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(id) ||
      typeof name !== 'string' || !name.trim() || name.length > 80) {
    throw new Error('请填写连接或模型配置的名称');
  }
  return { id, name: name.trim() };
}

export function normalizeModelSettings(input, previous) {
  if (!Array.isArray(input?.connections) || !input.connections.length || input.connections.length > 20 ||
      !Array.isArray(input?.models) || !input.models.length || input.models.length > 40) {
    throw new Error('请至少保留一个连接和一个模型配置');
  }
  const connections = input.connections.map((item) => {
    const named = namedItem(item);
    if (item.kind === 'codex') return { ...named, kind: 'codex' };
    if (item.kind !== 'api') throw new Error('请选择有效的模型连接方式');
    const baseUrl = apiAddress(item.baseUrl);
    const saved = previous.connections.find(({ id }) => id === named.id);
    const keyEnv = String(item.keyEnv ?? saved?.keyEnv ?? '').trim();
    if (!/^[A-Z][A-Z0-9_]{0,100}_API_KEY$/.test(keyEnv)) throw new Error('请输入 API Key 环境变量名称，如 REIMBURSEMENT_API_KEY');
    if (saved?.keyEnv === keyEnv && saved.baseUrl !== baseUrl) throw new Error('更换 API 地址时请同时指定该服务的独立 API Key 环境变量');
    return { ...named, kind: 'api', baseUrl, keyEnv };
  });
  const byConnection = new Map(connections.map((item) => [item.id, item]));
  if (byConnection.size !== connections.length) throw new Error('模型连接重复');
  const models = input.models.map((item) => {
    const named = namedItem(item);
    const connection = byConnection.get(item.connectionId);
    const model = typeof item.model === 'string' ? item.model.trim() : '';
    const effort = item.effort ?? '';
    if (!connection) throw new Error('请选择模型使用的连接');
    if (model.length > 120 || /[\u0000-\u001f]/.test(model) || (!model && connection.kind === 'api')) {
      throw new Error('请填写有效的 API 模型名称');
    }
    if (!EFFORTS.has(effort)) throw new Error('请选择有效的思考深度');
    return { ...named, connectionId: connection.id, model, effort };
  });
  const ids = new Set(models.map(({ id }) => id));
  if (ids.size !== models.length) throw new Error('模型配置重复');
  const assignments = Object.fromEntries(Object.entries(MODEL_USES).map(([purpose, label]) => {
    const id = input.assignments?.[purpose] ?? '';
    if (id && !ids.has(id)) throw new Error(`请选择${label}使用的模型`);
    return [purpose, id];
  }));
  return { version: 2, connections, models, assignments };
}

function deepseekModel(connection, env) {
  return connection.id === 'deepseek' && connection.kind === 'api' && connection.baseUrl === DEEPSEEK_URL
    ? env.DEEPSEEK_MODEL?.trim() : '';
}

export function modelForPurpose(settings, purpose, env = process.env) {
  if (!settings.assignments[purpose]) throw new Error(`${MODEL_USES[purpose]}的外部模型已关闭`);
  const profile = settings.models.find(({ id }) => id === settings.assignments[purpose]);
  const connection = settings.connections.find(({ id }) => id === profile?.connectionId);
  if (!profile || !connection) throw new Error('请在设置中为此功能选择模型');
  return {
    name: profile.name,
    kind: connection.kind,
    baseUrl: connection.baseUrl,
    apiKey: connection.keyEnv ? env[connection.keyEnv]?.trim() : undefined,
    model: (profile.id === 'deepseek' && deepseekModel(connection, env)) || profile.model,
    effort: profile.effort,
  };
}

export function publicModelSettings(settings, env = process.env) {
  const { connections, models, assignments } = settings;
  return {
    connections: connections.map((connection) => ({ ...connection, keyConfigured: Boolean(connection.keyEnv && env[connection.keyEnv]?.trim()) })),
    models: models.map((profile) => {
      const connection = connections.find(({ id }) => id === profile.connectionId);
      const modelFromEnvironment = profile.id === 'deepseek' && deepseekModel(connection, env);
      return modelFromEnvironment ? { ...profile, modelFromEnvironment } : profile;
    }),
    assignments,
    uses: MODEL_USES,
  };
}
