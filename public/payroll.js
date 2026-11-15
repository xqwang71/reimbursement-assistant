import { mountSignerPicker } from './signer-picker.js';

export function bindPayrollForm({ api, $, money, getContext, onSave }) {
  const dialog = $('payrollDialog');
  const form = $('payrollForm');
  const people = $('payrollPeople');
  const status = $('payrollStatus');
  const grantType = form.elements.namedItem('grantType');
  const category = $('payrollCategory');
  const rows = () => [...people.querySelectorAll('.payroll-person')];
  const personField = (row, name) => row.querySelector('[name="' + name + '"]');
  const normalized = (name) => name.trim().replace(/\s+/g, ' ');
  const localChoices = new WeakMap();
  let roster = { people: [], schoolSearch: false };
  let rosterRequest = 0;
  let editing = null;
  let formRoot = '';
  let opening = false;
  let signerPicker;

  function renderSigner() {
    if (!signerPicker) return;
    const { signerNames } = getContext();
    const type = grantType.value.trim();
    const fallback = editing?.projectSigner?.name || signerNames[type];
    signerPicker.setDefaultLabel(fallback ? `沿用默认（${fallback}）` : '沿用默认');
    const selected = signerPicker.value();
    $('payrollSigner').textContent = selected ? selected.name || '待填写姓名' : fallback || '待确认';
  }

  function renderTotal() {
    const details = rows();
    let total = 0;
    details.forEach((row, index) => {
      row.querySelector('legend').textContent = '第 ' + (index + 1) + ' 条';
      row.querySelector('.remove-payroll-person').disabled = details.length === 1;
      total += Math.round((personField(row, 'amount').valueAsNumber || 0) * 100);
    });
    $('payrollTotal').textContent = '应发合计 ' + money(total);
  }

  function candidates(row) {
    const name = normalized(personField(row, 'name').value);
    const found = localChoices.get(row);
    return found?.people || roster.people.filter((person) => !name || person.name.includes(name));
  }

  function renderChoices(row, message = '') {
    const selected = personField(row, 'recipientKey').value;
    const tail = personField(row, 'identityTail').value;
    const name = normalized(personField(row, 'name').value);
    const select = row.querySelector('.payroll-person-choice');
    const find = row.querySelector('.find-payroll-person');
    const available = candidates(row);
    select.replaceChildren(new Option('选择姓名和尾号', ''), ...available.map((person) => {
      const description = [person.name, '尾号 ' + person.identityTail, person.organization, person.confirmed ? '已确认' : person.paidAt || '学校查询'];
      return new Option(description.filter(Boolean).join(' · '), person.key);
    }));
    select.value = available.some((person) => person.key === selected) ? selected : '';
    select.disabled = !available.length || row.dataset.confirming === 'yes';
    find.hidden = !roster.schoolSearch;
    find.disabled = !name || row.dataset.searching === 'yes' || row.dataset.confirming === 'yes';
    const sameName = available.filter((person) => person.name === name).length;
    const found = localChoices.get(row);
    let notice = message;
    if (!notice) {
      if (selected) notice = '本机已确认 · 尾号 ' + tail;
      else if (sameName > 1) notice = '有 ' + sameName + ' 位同名人员，请按尾号和部门选择。';
      else if (found && !found.complete) notice = '学校返回了部分结果，可以输入完整姓名再查。';
      else if (found && !available.length) notice = '学校未找到这个姓名。';
      else if (tail) notice = '原草稿尾号 ' + tail + '，人员待核对。';
      else if (roster.historyAvailable === false && !available.length) notice = '历史执行表暂不可读。姓名可先保存到草稿。';
      else if (name && !available.length && !roster.schoolSearch) notice = '姓名可先保存到草稿，待学校端确认人员。';
    }
    row.querySelector('.payroll-person-status').textContent = notice;
  }

  async function refreshRoster() {
    const request = ++rosterRequest;
    const requestedCategory = category.value;
    roster = { people: [], schoolSearch: requestedCategory === '学生劳务费' };
    for (const row of rows()) renderChoices(row);
    if (!requestedCategory) return;
    try {
      const result = await api('/api/payroll-people?category=' + encodeURIComponent(requestedCategory));
      if (request !== rosterRequest || !dialog.open) return;
      if (result.sourceRoot !== formRoot) throw new Error('票据目录已变化，请重新打开申报表。');
      roster = result;
      for (const row of rows()) renderChoices(row);
    } catch (error) {
      if (request !== rosterRequest || !dialog.open) return;
      for (const row of rows()) renderChoices(row, error.message);
    }
  }

  function setExpenseItem(row, chosen = '') {
    const field = personField(row, 'expenseItem');
    const options = getContext().expenseItems;
    const available = category.value === '校外人员劳务费' && options.length > 0;
    field.closest('label').hidden = !available;
    field.disabled = !available;
    field.replaceChildren(...(available ? options.map((label) => new Option(label, label)) : []));
    if (available && options.includes(chosen)) field.value = chosen;
  }

  function addPerson(person = {}) {
    const content = $('payrollPersonTemplate').content.cloneNode(true);
    const row = content.querySelector('.payroll-person');
    const position = personField(row, 'position');
    const options = [...getContext().positions];
    if (person.position && !options.includes(person.position)) options.push(person.position);
    position.replaceChildren(new Option('请选择职称', ''), ...options.map((title) => new Option(title, title)));
    for (const control of row.querySelectorAll('[name]')) {
      control.value = control.name === 'amount' && person.amountCny ? (person.amountCny / 100).toFixed(2) : person[control.name] || '';
    }
    setExpenseItem(row, person.expenseItem);
    people.append(content);
    renderTotal();
    renderChoices(row);
  }

  async function confirmPerson(row, person) {
    const selectedCategory = category.value;
    const request = rosterRequest;
    const name = personField(row, 'name').value;
    row.dataset.confirming = 'yes';
    renderChoices(row, '正在确认人员…');
    let message = '';
    try {
      const { person: confirmed } = await api('/api/payroll-people/confirm', {
        method: 'POST', body: JSON.stringify({ sourceRoot: formRoot, category: selectedCategory, key: person.key, name: person.name }),
      });
      if (request !== rosterRequest || !row.isConnected || personField(row, 'name').value !== name) return;
      roster.people = [confirmed, ...roster.people.filter((item) => item.key !== confirmed.key)];
      const result = localChoices.get(row);
      if (result) localChoices.set(row, { ...result, people: result.people.map((item) => item.key === confirmed.key ? confirmed : item) });
      personField(row, 'name').value = confirmed.name;
      personField(row, 'recipientKey').value = confirmed.key;
      personField(row, 'identityTail').value = confirmed.identityTail;
    } catch (error) {
      message = error.message;
    } finally {
      delete row.dataset.confirming;
      if (request === rosterRequest && row.isConnected) renderChoices(row, message);
    }
  }

  async function searchSchool(row) {
    const name = normalized(personField(row, 'name').value);
    if (!name) return;
    const request = rosterRequest;
    const selectedCategory = category.value;
    row.dataset.searching = 'yes';
    renderChoices(row, '正在搜索学校人员…');
    let message = '';
    try {
      const result = await api('/api/payroll-people/search', {
        method: 'POST', body: JSON.stringify({ sourceRoot: formRoot, category: selectedCategory, name }),
      });
      if (request !== rosterRequest || !row.isConnected || normalized(personField(row, 'name').value) !== name) return;
      localChoices.set(row, result);
      const oldKey = personField(row, 'recipientKey').value;
      if (oldKey && result.complete && !result.people.some((person) => person.key === oldKey)) {
        personField(row, 'recipientKey').value = '';
        personField(row, 'identityTail').value = '';
        message = '本次结果未找到原先确认的人，请核对后重新选择。';
      }
      if (!oldKey && result.complete && result.people.length === 1 && result.people[0].name === name) {
        await confirmPerson(row, result.people[0]);
      }
    } catch (error) {
      message = error.message;
    } finally {
      delete row.dataset.searching;
      if (request === rosterRequest && row.isConnected) renderChoices(row, message);
    }
  }

  async function open(item = null) {
    if (opening || dialog.open) return;
    const { sourceRoot, categories } = getContext();
    opening = true;
    try {
      const draft = item ? await api('/api/payroll-claims/' + item.groupId) : null;
      if (getContext().sourceRoot !== sourceRoot) return;
      form.reset();
      people.replaceChildren();
      status.textContent = '';
      editing = draft ? { id: item.groupId, revision: draft.revision,
        projectSigner: draft.signerDefaultSource === 'project' ? draft.signerDefault : null,
      } : null;
      formRoot = sourceRoot;
      $('payrollTitle').textContent = editing ? '修改薪酬申报' : '新增薪酬申报';
      category.replaceChildren(...categories.map((label) => new Option(label, label)));
      $('savePayroll').textContent = editing ? '更新申报' : '保存申报';
      if (draft) {
        for (const name of ['category', 'grantType', 'reason']) form.elements.namedItem(name).value = draft[name];
      }
      signerPicker = mountSignerPicker($('payrollSignerPicker'), {
        label: '本笔加签人', roster: getContext().signerRoster, selected: draft?.signerOverride,
        defaultLabel: '沿用默认', onChange: renderSigner,
      });
      renderSigner();
      for (const person of draft?.people || [{}]) addPerson(person);
      dialog.showModal();
      refreshRoster();
    } finally {
      opening = false;
    }
  }

  $('addPayrollPerson').addEventListener('click', () => {
    addPerson();
    personField(people.lastElementChild, 'name').focus();
  });
  $('closePayroll').addEventListener('click', () => dialog.close());
  grantType.addEventListener('input', renderSigner);
  category.addEventListener('change', () => {
    for (const row of rows()) {
      setExpenseItem(row);
      localChoices.delete(row);
      personField(row, 'recipientKey').value = '';
      personField(row, 'identityTail').value = '';
    }
    refreshRoster();
  });
  dialog.addEventListener('close', () => {
    rosterRequest += 1;
    people.replaceChildren();
    form.reset();
  });
  people.addEventListener('input', (event) => {
    if (event.target.name === 'amount') renderTotal();
    if (event.target.name !== 'name') return;
    const row = event.target.closest('.payroll-person');
    localChoices.delete(row);
    personField(row, 'recipientKey').value = '';
    personField(row, 'identityTail').value = '';
    renderChoices(row);
  });
  people.addEventListener('change', (event) => {
    if (!event.target.matches('.payroll-person-choice')) return;
    const row = event.target.closest('.payroll-person');
    const person = candidates(row).find((item) => item.key === event.target.value);
    if (person) {
      confirmPerson(row, person);
    } else {
      personField(row, 'recipientKey').value = '';
      personField(row, 'identityTail').value = '';
      renderChoices(row);
    }
  });
  people.addEventListener('click', (event) => {
    if (event.target.closest('.remove-payroll-person')) {
      event.target.closest('.payroll-person').remove();
      renderTotal();
    } else if (event.target.closest('.find-payroll-person')) {
      searchSchool(event.target.closest('.payroll-person'));
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('savePayroll');
    if (button.disabled) return;
    if (rows().some((row) => row.dataset.confirming === 'yes' || row.dataset.searching === 'yes')) {
      status.textContent = '人员查询或确认正在进行，请稍后保存。';
      return;
    }
    const payload = { sourceRoot: formRoot, revision: editing?.revision };
    for (const name of ['category', 'grantType', 'reason']) payload[name] = form.elements.namedItem(name).value;
    payload.signerOverride = signerPicker.value();
    payload.people = rows().map((row) => Object.fromEntries([...row.querySelectorAll('[name]:not(:disabled)')].map((control) => [control.name, control.value])));
    button.disabled = true;
    status.textContent = '正在保存…';
    try {
      const result = await api(editing ? '/api/payroll-claims/' + editing.id : '/api/payroll-claims', {
        method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload),
      });
      dialog.close();
      await onSave(result);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  return open;
}
