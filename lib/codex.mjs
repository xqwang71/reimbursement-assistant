import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { modelForPurpose, MODEL_USES, readModelSettings } from './model-settings.mjs';
import { redactModelText } from './model-input.mjs';

const promptFile = new URL('./agent-prompts/执行与互动.md', import.meta.url);

export function resolveCodexBinary(env = process.env) {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  const candidates = ['/Applications', join(homedir(), 'Applications')].flatMap((directory) =>
    ['ChatGPT.app', 'Codex.app'].flatMap((app) => [
      join(directory, app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
      join(directory, app, 'Contents/Resources/codex'),
    ]));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

export async function askCodex({ prompt, cwd, settingsDir = cwd, purpose, timeoutMs = 120000 }) {
  const profile = modelForPurpose(await readModelSettings(settingsDir), purpose);
  if (profile.kind === 'api' && !profile.apiKey) throw new Error(`请为${MODEL_USES[purpose]}配置所选连接的 API Key 环境变量`);
  const binary = resolveCodexBinary();
  const args = [
    'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only',
    '--disable', 'shell_tool', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
  ];
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  if (profile.kind === 'api') {
    env.REIMBURSEMENT_MODEL_API_KEY = profile.apiKey;
    args.push(
      '-c', 'model_provider="reimbursement_api"',
      '-c', 'model_providers.reimbursement_api.name="Reimbursement API"',
      '-c', `model_providers.reimbursement_api.base_url=${JSON.stringify(profile.baseUrl)}`,
      '-c', 'model_providers.reimbursement_api.env_key="REIMBURSEMENT_MODEL_API_KEY"',
      '-c', 'model_providers.reimbursement_api.wire_api="responses"',
    );
  }
  if (profile.model) args.push('--model', profile.model);
  if (profile.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(profile.effort)}`);
  const isolated = await mkdtemp(join(tmpdir(), 'reimbursement-model-'));
  args.push('-C', isolated, '-');
  try {
    return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: isolated, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const label = MODEL_USES[purpose];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${label}模型响应超时`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => undefined);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('无法启动 Codex，请检查本机 Codex 安装'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const diagnostic = `${stderr}\n${stdout}`;
        if (/\b(?:401|403)\b|unauthorized|not logged in/i.test(diagnostic)) return reject(new Error(`${label}模型认证失败，请检查设置中的 API Key 或 Codex 登录`));
        if (/\b429\b|rate limit/i.test(diagnostic)) return reject(new Error(`${label}模型请求过多，请稍后再试`));
        return reject(new Error(`${label}模型调用失败，请检查设置中的连接与模型名称`));
      }
      const messages = [];
      for (const line of stdout.split('\n')) {
        try {
          const event = JSON.parse(line);
          const text = event.type === 'item.completed' && event.item?.type === 'agent_message'
            ? event.item.text : event.msg?.message || event.message?.text;
          if (text && !/^\s*$/.test(text)) messages.push(text);
        } catch {}
      }
      if (!messages.length) return reject(new Error(`${label}模型没有返回可用结果`));
      resolve(messages.at(-1));
    });
    child.stdin.end(prompt);
    });
  } finally {
    await rm(isolated, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function askInteractionAgent({ mode, input, cwd, settingsDir = cwd, timeoutMs = 30000 }) {
  const instructions = await readFile(promptFile, 'utf8');
  return askCodex({
    prompt: `${instructions}\n\n当前模式为 ${mode}。输入数据如下。\n${JSON.stringify(input, (_, value) => typeof value === 'string' ? redactModelText(value) : value)}`,
    purpose: mode === 'recovery' ? 'recovery' : 'interaction', cwd, settingsDir, timeoutMs,
  });
}

export async function parseInstruction({ message, context, cwd, settingsDir }) {
  try {
    const text = await askInteractionAgent({ mode: 'instruction', input: { message, context }, cwd, settingsDir });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { action: 'chat' };
    const parsed = JSON.parse(match[0]);
    if (!['control', 'learn', 'chat'].includes(parsed?.action)) return { action: 'chat' };
    if (parsed.action === 'control' && !['pause', 'resume', 'retry', 'skip_submit', 'cancel'].includes(parsed.control)) return { action: 'chat' };
    return parsed;
  } catch {
    return { action: 'chat' };
  }
}
