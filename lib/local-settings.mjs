import { projectNumberKey } from '../public/project-allocation.js';

export const FUNDING_TYPES = ['教学', '科研'];
export const DEFAULT_PREFERENCES = {
  signers: { 教学: null, 科研: null },
  researchProjectNos: [],
  campus: '松江',
  smartPaymentLabel: '教职工银行-建设银行',
  legacyPaymentLabel: '教职工银行卡-建设银行',
  autoPrint: false,
};

function field(value, label, limit = 80) {
  if (typeof value !== 'string' || value.length > limit || /\p{Cc}/u.test(value)) {
    throw new Error(`${label}应为 ${limit} 字以内的文字`);
  }
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

export function localSigner(input) {
  if (input == null) return null;
  const name = field(input.name ?? '', '加签人姓名');
  const employeeNo = field(input.employeeNo ?? '', '加签人工号', 30);
  if (employeeNo && (!name || !/^[\p{L}\p{N}-]+$/u.test(employeeNo))) throw new Error('请同时填写姓名和有效的加签人工号');
  return name ? { name, employeeNo } : null;
}

export function localPreferences(input = {}, previous = DEFAULT_PREFERENCES) {
  const signers = { ...previous.signers };
  if (input.signers !== undefined) {
    for (const type of FUNDING_TYPES) {
      if (Object.hasOwn(input.signers ?? {}, type)) signers[type] = localSigner(input.signers[type]);
    }
  }
  const campus = input.campus ?? previous.campus;
  if (!['松江', '长宁'].includes(campus)) throw new Error('请选择预约校区');
  const smartPaymentLabel = field(input.smartPaymentLabel ?? previous.smartPaymentLabel, '智能报销支付类型');
  const legacyPaymentLabel = field(input.legacyPaymentLabel ?? previous.legacyPaymentLabel, '线下预约支付类型');
  if (!smartPaymentLabel || !legacyPaymentLabel) throw new Error('请填写两套学校系统显示的支付类型');
  const autoPrint = input.autoPrint ?? previous.autoPrint;
  if (typeof autoPrint !== 'boolean') throw new Error('请选择是否使用自动打印');
  const numbers = input.researchProjectNos ?? previous.researchProjectNos;
  if (!Array.isArray(numbers) || numbers.length > 100) throw new Error('自动归为科研的项目编号最多填写 100 个');
  const researchProjectNos = [...new Set(numbers.map((number) => {
    const value = field(number, '科研项目编号', 100).toUpperCase();
    if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(value)) throw new Error('请填写有效的科研项目编号，每行一个');
    return value;
  }))];
  return { signers, researchProjectNos, campus, smartPaymentLabel, legacyPaymentLabel, autoPrint };
}

export function projectFunding(funding, projects, { researchProjectNos }) {
  return projects.some(({ projectNo }) => researchProjectNos.includes(projectNumberKey(projectNo)))
    ? '科研' : funding;
}

export function resolveClaimSigner(projects, signersByProject, fallback, override = null) {
  let signerDefault = null;
  let signerDefaultSource = 'none';
  for (const { projectNo } of projects) {
    const key = projectNumberKey(projectNo);
    const signer = Object.hasOwn(signersByProject, key) ? signersByProject[key] : null;
    if (!signer) continue;
    if (signerDefault && (signerDefault.name !== signer.name ||
        (signerDefault.employeeNo && signer.employeeNo && signerDefault.employeeNo !== signer.employeeNo))) {
      signerDefault = null;
      signerDefaultSource = 'conflict';
      break;
    }
    if (!signerDefault?.employeeNo) signerDefault = signer;
    signerDefaultSource = 'project';
  }
  if (signerDefaultSource === 'none' && fallback) {
    signerDefault = fallback;
    signerDefaultSource = 'funding';
  }
  return { signerDefault, signerDefaultSource, signerOverride: override, signer: override ?? signerDefault };
}
