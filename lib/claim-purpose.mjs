import { allocateProjects } from '../public/project-allocation.js';

const genericWords = /\d+\s*[年月日]|第\s*\d+\s*批|大语言模型|人工智能|大模型|科研工作|教学工作|教研活动|课程建设|实验案例|案例建设|打印装订|装订打印|复印打印|办公用品|办公耗材|办公经费|办公费|资料费|打印费|装订费|信息技术服务|技术服务|软件订阅|使用|采购|购买|支付|报销|支出|用于|项目|课题|教学|科研|相关|具体|实际|本笔|本次|本批|工作|任务|需要|需求|日常|常规|打印|复印|装订|文印|资料|课程|调用|服务|费用|模型|等|AI|API|Tokens?/gi;
const restrictedMealProjects = /内涵建设|跃升计划|重服务强贡献计划/;

export function normalizeClaimReason(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function enteredPurpose(input) {
  if (input?.reason === undefined) {
    const matter = normalizeClaimReason(input?.matter);
    const use = normalizeClaimReason(input?.use);
    return { reason: [matter, use].filter(Boolean).join('：'), warning: purposeInputWarning(matter, use) };
  }
  const reason = normalizeClaimReason(input.reason);
  const parts = reason.match(/^(.*?)(?:[：:]|[，,]\s*(?=用于))(.+)$/);
  if (parts) return { reason, warning: purposeInputWarning(normalizeClaimReason(parts[1]), normalizeClaimReason(parts[2])) };
  const use = reason.match(/^(.+?)(?:所需|所用).+$/)?.[1] || reason.match(/用于(.+)$/)?.[1];
  return { reason, warning: use && hasSpecificText(use) ? '' : '建议写清本笔费用的具体用途，如课程资料备份所需硬盘' };
}

function hasSpecificText(value, matter = '') {
  const text = matter ? value.replaceAll(matter, '') : value;
  return text.normalize('NFKC').replace(genericWords, '').replace(/[^\p{Letter}]/gu, '').length >= 2;
}

function purposeInputWarning(matter, use) {
  if (!hasSpecificText(matter)) return '建议填写具体的课程、科研项目或建设事项名称';
  if (!hasSpecificText(use, matter)) return '建议写清本笔费用用于哪个具体环节或成果，例如调试金融文本分析实训程序';
  return '';
}

function scope(plan) {
  return {
    folder: plan.folder,
    fingerprint: plan.fingerprint,
    subject: plan.subject,
    funding: plan.funding,
    projectNo: normalizeClaimReason(plan.project?.projectNo),
    projectName: normalizeClaimReason(plan.project?.projectName),
    ...(plan.projectAllocationDraft ? { projects: JSON.stringify(plan.projectAllocationDraft.map(({ projectNo, projectName }) => [projectNo, projectName])) } : {}),
  };
}

export function mentionsMealExpense(value) {
  return /误\s*餐/.test(String(value ?? '').replace(/(?:不含|不涉及|不得报销|不得支出)\s*误\s*餐(?:费|补助|补贴)?/g, ''));
}

function assessPurpose(plan, candidate) {
  const binding = scope(plan);
  const { reason, warning } = enteredPurpose(candidate);
  const purpose = candidate && reason && Object.entries(binding).every(([key, value]) => candidate[key] === value)
    ? { ...binding, reason }
    : null;
  const blockers = [];
  const warnings = [];
  if (!binding.projectNo || !binding.projectName) blockers.push('请选择经费项目，或填写完整的项目编号和名称');
  if (!purpose) blockers.push('请在报销事项中写清具体用途，匹配经费后保存或更新事由');
  if (purpose && warning) warnings.push(warning);
  if (plan.mealExpense || mentionsMealExpense(purpose?.reason)) {
    warnings.push(restrictedMealProjects.test(binding.projectName) || plan.projectAllocationDraft?.some(({ projectName }) => restrictedMealProjects.test(projectName))
      ? '所选经费项目不得支出误餐费'
      : '误餐费请核对所选项目的开支依据');
  }
  return { purpose, reason: purpose?.reason || '', blockers, warnings };
}

export function applyClaimPurpose(plan, candidate = plan.purpose) {
  const assessment = assessPurpose(plan, candidate);
  const blockers = [...new Set([...plan.materialBlockers, ...assessment.blockers])];
  if (plan.projectAllocationDraft) {
    const { error } = allocateProjects(plan.projectAllocationDraft, plan.totalCny);
    if (error) blockers.push(error);
  }
  const warnings = [...new Set([...plan.materialWarnings, ...assessment.warnings])];
  return { ...plan, purpose: assessment.purpose, reason: assessment.reason, blockers, warnings, status: blockers.length ? 'blocked' : 'ready' };
}

export function confirmClaimPurpose(plan, input) {
  if (input.confirmed !== true) throw new Error('请确认本批票据属于同一事项，且实际用途与所选经费项目相符');
  const binding = scope(plan);
  if (!binding.projectNo || !binding.projectName) throw new Error('请先匹配经费项目，再确认报销事由');
  const { reason } = enteredPurpose(input);
  if (!reason) throw new Error('请填写报销事由');
  return applyClaimPurpose(plan, { ...binding, reason });
}

export function validateClaimPurpose(plan) {
  const assessment = assessPurpose(plan, plan.purpose);
  if (assessment.blockers.length) throw new Error(assessment.blockers.join('；'));
  if (plan.reason !== assessment.reason) throw new Error('报销事由与本笔确认的实际用途不一致，请重新核对');
}
