import { normalizeClaimReason } from './claim-purpose.mjs';
import { localSigner } from './local-settings.mjs';

export const PAYROLL_CATEGORIES = [
  '校外人员劳务费', '学生劳务费', '博士后工资', '长宁人事派遣工资', '地铁强生派遣工资', '返聘长聘人员工资',
];
export const PAYROLL_POSITIONS = ['正高', '副高', '其他'];
export const PAYROLL_EXPENSE_ITEMS = ['其他劳务费', '咨询费', '评审费', '讲座费', '科研津贴'];

const fundingByGrantType = new Map([
  ['科研项目', '科研'], ['科研', '科研'], ['非科研项目', '教学'], ['教学项目', '教学'], ['教学', '教学'],
]);

export function payrollSignerNames(signers) {
  return Object.fromEntries(Array.from(fundingByGrantType, ([type, funding]) => [type, signers[funding]?.name || '']));
}

export function payrollApproval(grantType, signers, override = null) {
  const funding = fundingByGrantType.get(normalizeClaimReason(grantType));
  return funding ? { funding, signer: override ?? signers[funding] } : null;
}

function required(value, label, maximum) {
  const text = normalizeClaimReason(value);
  if (!text || text.length > maximum) throw new Error(`请填写${label}（最多 ${maximum} 字）`);
  return text;
}

export function payrollIntake(input, { recipients, previousPeople = [] } = {}) {
  if (!PAYROLL_CATEGORIES.includes(input.category)) throw new Error('请选择薪酬套类');
  if (!Array.isArray(input.people) || !input.people.length || input.people.length > 200) throw new Error('请填写 1 至 200 条发放明细');
  const people = input.people.map((item, index) => {
    const name = required(item?.name, `第 ${index + 1} 条姓名`, 50);
    const recipient = item.recipientKey && recipients?.get(item.recipientKey);
    if (item.recipientKey && (recipient?.category !== input.category || recipient.name !== name)) {
      throw new Error(`请重新选择第 ${index + 1} 条人员。`);
    }
    const previous = previousPeople.find((person) => person.name === name && person.position === item.position);
    const position = required(item.position, `第 ${index + 1} 条职称职务`, 80);
    if (!PAYROLL_POSITIONS.includes(position) && !previous) throw new Error(`请选择第 ${index + 1} 条职称职务。`);
    const purpose = typeof item.purpose === 'string' ? item.purpose.trim() : '';
    if (!purpose) throw new Error(`请填写第 ${index + 1} 条用途，说明承担的具体工作。`);
    const hours = String(item.hours ?? '').trim();
    if (hours && !/^\d{1,5}(?:\.\d{1,2})?$/.test(hours)) throw new Error(`请核对第 ${index + 1} 条工作学时`);
    const amount = String(item.amount ?? '').trim();
    if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new Error(`第 ${index + 1} 条金额须大于零，精确到分`);
    const expenseItem = String(item.expenseItem ?? '').trim();
    if (expenseItem && (input.category !== '校外人员劳务费' || !PAYROLL_EXPENSE_ITEMS.includes(expenseItem))) {
      throw new Error(`请核对第 ${index + 1} 条明细的费用项。`);
    }
    const [yuan, fraction = ''] = amount.split('.');
    const oldIdentity = previousPeople.find((person) => person.name === name && person.identityTail && person.identityTail === item.identityTail);
    const identityTail = recipient?.identityTail || oldIdentity?.identityTail;
    return {
      name, position, purpose, hours, amountCny: Number(yuan) * 100 + Number(fraction.padEnd(2, '0')),
      ...(expenseItem ? { expenseItem } : {}),
      ...(identityTail ? { identityTail } : {}),
      ...(recipient ? { recipientKey: recipient.key } : {}),
    };
  });
  return {
    category: input.category,
    grantType: required(input.grantType, '发放类型', 100),
    signerOverride: localSigner(input.signerOverride),
    reason: required(input.reason, '发放内容（报销事由）', 100),
    people,
    totalCny: people.reduce((total, item) => total + item.amountCny, 0),
  };
}
