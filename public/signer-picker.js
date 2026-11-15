const signerKey = ({ name, employeeNo }) => JSON.stringify([name, employeeNo || '']);

export function mountSignerPicker(container, { label, roster, selected = null, defaultLabel, onChange }) {
  container.innerHTML = `
    <label><span></span><select></select></label>
    <div class="new-signer-fields" hidden>
      <label>加签人姓名<input data-signer-name maxlength="80" autocomplete="off"></label>
      <label>工号（可选）<input data-signer-code maxlength="30" autocomplete="off"></label>
    </div>`;
  container.querySelector('span').textContent = label;
  const select = container.querySelector('select');
  const fields = container.querySelector('.new-signer-fields');
  const name = fields.querySelector('[data-signer-name]');
  const code = fields.querySelector('[data-signer-code]');

  const people = new Map([...roster, selected].filter((signer) => signer?.name).map((signer) => [signerKey(signer), signer]));
  const options = [...people.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') ||
    (a.employeeNo || '').localeCompare(b.employeeNo || ''));
  const defaultOption = new Option(defaultLabel, 'default');
  select.add(defaultOption);
  options.forEach((signer, index) => {
    const text = signer.employeeNo ? signer.name + ' · ' + signer.employeeNo : signer.name;
    select.add(new Option(text, String(index)));
  });
  select.add(new Option('新增加签人…', 'new'));
  select.value = selected?.name ? String(options.findIndex((signer) => signerKey(signer) === signerKey(selected))) : 'default';

  const selection = () => select.value === 'new'
    ? { name: name.value.normalize('NFKC').trim().replace(/\s+/g, ' '), employeeNo: code.value.normalize('NFKC').trim() }
    : options[select.value] ?? null;
  const validateName = () => name.setCustomValidity(name.required && !selection()?.name ? '请填写加签人姓名。' : '');
  const update = () => {
    const adding = select.value === 'new';
    fields.hidden = !adding;
    name.disabled = code.disabled = !adding;
    name.required = adding;
    validateName();
  };
  select.addEventListener('change', () => {
    update();
    if (!fields.hidden) name.focus();
    onChange?.();
  });
  name.addEventListener('input', () => {
    validateName();
    onChange?.();
  });
  update();
  return {
    value: selection,
    reportValidity: () => name.reportValidity() && code.reportValidity(),
    setDefaultLabel: (text) => { defaultOption.textContent = text; },
  };
}
