import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const VALID_EXPENSE_TYPES = ['设备', '办公费', '数据采集费', '其他材料费', '其他教学杂项费用'];
const emptyMemory = () => ({ expenseTypeBySubject: {}, expenseTypeRules: [], subjectByFolder: {}, travelProfileByFolder: {}, signerNames: [], signerByClaim: {} });
let memoryWrites = Promise.resolve();

export async function loadMemory(appDir) {
  try {
    const saved = JSON.parse(await readFile(join(appDir, '.runtime', 'memory.json'), 'utf8'));
    return {
      ...saved,
      expenseTypeBySubject: { ...(saved.expenseTypeBySubject || {}) },
      expenseTypeRules: Array.isArray(saved.expenseTypeRules) ? saved.expenseTypeRules : [],
      subjectByFolder: { ...(saved.subjectByFolder || {}) },
      travelProfileByFolder: { ...(saved.travelProfileByFolder || {}) },
      signerNames: Array.isArray(saved.signerNames) ? saved.signerNames.filter((name) => typeof name === 'string' && name) : [],
      signerByClaim: { ...(saved.signerByClaim || {}) },
    };
  } catch {
    return emptyMemory();
  }
}

export function saveMemory(appDir, memory) {
  const runtimeDir = join(appDir, '.runtime');
  const content = JSON.stringify(memory, null, 2);
  const saved = memoryWrites.then(async () => {
    await mkdir(runtimeDir, { recursive: true });
    const temporary = join(runtimeDir, 'memory.json.tmp');
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, join(runtimeDir, 'memory.json'));
  });
  memoryWrites = saved.catch(() => undefined);
  return saved;
}

export async function learnExpenseType(appDir, memory, subject, learned) {
  const defaultType = typeof learned === 'string' ? learned : learned?.defaultType;
  const rules = Array.isArray(learned?.rules) ? learned.rules : [];
  let changed = false;
  if (subject && defaultType && memory.expenseTypeBySubject[subject] !== defaultType) {
    memory.expenseTypeBySubject[subject] = defaultType;
    changed = true;
  }
  memory.expenseTypeRules ||= [];
  for (const rule of rules) {
    if (!rule?.keyword || !rule?.type) continue;
    const existing = memory.expenseTypeRules.find((item) => item.keyword === rule.keyword);
    if (existing) {
      if (existing.type !== rule.type) { existing.type = rule.type; changed = true; }
    } else {
      memory.expenseTypeRules.push({ keyword: rule.keyword, type: rule.type });
      changed = true;
    }
  }
  if (changed) await saveMemory(appDir, memory);
  return changed;
}

export const EXPENSE_TYPES = VALID_EXPENSE_TYPES;

export async function rememberPlanEdit(appDir, memory, { folder, subject, expenseType, travelProfile, signerChoice }) {
  const changes = [];
  memory.subjectByFolder ||= {};
  if (subject && memory.subjectByFolder[folder] !== subject) {
    memory.subjectByFolder[folder] = subject;
    changes.push(`“${folder}”报销科目→${subject}`);
  }
  if (expenseType && subject && VALID_EXPENSE_TYPES.includes(expenseType) && memory.expenseTypeBySubject[subject] !== expenseType) {
    memory.expenseTypeBySubject[subject] = expenseType;
    changes.push(`“${subject}”默认费用类型→${expenseType}`);
  }
  if (travelProfile?.role) {
    memory.travelProfileByFolder ||= {};
    const current = memory.travelProfileByFolder[folder];
    if (current?.role !== travelProfile.role || current?.fundType !== travelProfile.fundType) {
      memory.travelProfileByFolder[folder] = { role: travelProfile.role, fundType: travelProfile.fundType || 'budget' };
      changes.push(`“${folder}”差旅标准已记住`);
    }
  }
  if (signerChoice) {
    const { key, ...selection } = signerChoice;
    const { name } = selection.signer;
    const alreadyListed = memory.signerNames.includes(name);
    if (!alreadyListed) memory.signerNames.push(name);
    if (!alreadyListed || !isDeepStrictEqual(memory.signerByClaim[key], selection)) {
      memory.signerByClaim[key] = selection;
      changes.push('本笔加签人→' + name);
    }
  }
  if (changes.length || signerChoice) await saveMemory(appDir, memory);
  return changes;
}

export async function applyLearning(appDir, memory, learn) {
  const changes = [];
  for (const [subject, type] of Object.entries(learn?.expenseTypeBySubject || {})) {
    if (!VALID_EXPENSE_TYPES.includes(type)) continue;
    if (memory.expenseTypeBySubject[subject] !== type) {
      memory.expenseTypeBySubject[subject] = type;
      changes.push(`“${subject}”默认费用类型→${type}`);
    }
  }
  memory.expenseTypeRules ||= [];
  for (const rule of learn?.expenseTypeRules || []) {
    if (!rule?.keyword || !VALID_EXPENSE_TYPES.includes(rule.type)) continue;
    const existing = memory.expenseTypeRules.find((item) => item.keyword === rule.keyword);
    if (existing) {
      if (existing.type !== rule.type) { existing.type = rule.type; changes.push(`特例 ${rule.keyword}→${rule.type}（已更新）`); }
    } else {
      memory.expenseTypeRules.push({ keyword: rule.keyword, type: rule.type });
      changes.push(`特例 ${rule.keyword}→${rule.type}`);
    }
  }
  if (changes.length) await saveMemory(appDir, memory);
  return changes;
}
