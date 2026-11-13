export function bindModelSettings(api) {
  const field = (id) => document.getElementById(id);
  const form = field('modelSettingsForm');
  const status = field('modelSettingsStatus');
  const key = field('modelApiKey');
  const url = field('modelApiUrl');
  let draft;
  let connectionId;
  let modelId;
  let request = 0;

  const connection = () => draft.connections.find((item) => item.id === connectionId);
  const model = () => draft.models.find((item) => item.id === modelId);
  function options(select, items, selected) {
    select.replaceChildren(...items.map(({ id, name }) => new Option(name, id, false, id === selected)));
  }

  function collect() {
    const current = connection();
    current.name = field('modelConnectionName').value.trim();
    current.kind = field('modelConnectionKind').value;
    current.baseUrl = url.value.trim();
    current.keyEnv = key.value.trim();
    Object.assign(model(), {
      name: field('modelProfileName').value.trim(),
      connectionId: field('modelProfileConnection').value,
      model: field('modelProfileId').value.trim(),
      effort: field('modelEffort').value,
    });
  }

  function renderConnectionKind() {
    const current = connection();
    const isApi = field('modelConnectionKind').value === 'api';
    field('modelApiUrlField').hidden = field('modelApiKeyField').hidden = !isApi;
    url.disabled = key.disabled = !isApi;
    key.placeholder = '如 REIMBURSEMENT_API_KEY';
    field('modelConnectionStatus').textContent = isApi
      ? (current.keyConfigured ? '已读取本机环境变量中的 API Key。' : '需在启动助手前设置同名环境变量。')
      : '使用当前电脑上的 Codex 登录。';
  }

  function render() {
    const current = connection();
    const profile = model();
    options(field('modelConnectionChoice'), draft.connections, connectionId);
    field('modelConnectionName').value = current.name;
    field('modelConnectionKind').value = current.kind;
    url.value = current.baseUrl || '';
    key.value = current.keyEnv || '';
    renderConnectionKind();
    options(field('modelProfileChoice'), draft.models, modelId);
    options(field('modelProfileConnection'), draft.connections, profile.connectionId);
    field('modelProfileName').value = profile.name;
    field('modelProfileId').value = profile.model;
    field('modelProfileId').placeholder = draft.connections.find(({ id }) => id === profile.connectionId)?.kind === 'api' ? '输入服务商的模型名称' : '留空使用 Codex 默认模型';
    field('modelProfileStatus').textContent = profile.modelFromEnvironment ? `当前使用本机环境变量指定的 ${profile.modelFromEnvironment}。` : '';
    field('modelEffort').value = profile.effort;
    field('modelAssignments').replaceChildren(...Object.entries(draft.uses).map(([purpose, title]) => {
      const label = document.createElement('label');
      const select = document.createElement('select');
      select.name = purpose;
      options(select, [{ id: '', name: '关闭' }, ...draft.models], draft.assignments[purpose] || '');
      select.addEventListener('change', () => { draft.assignments[purpose] = select.value; });
      label.append(title, select);
      return label;
    }));
  }

  function display(settings) {
    draft = settings;
    if (!connection()) connectionId = draft.connections[0].id;
    if (!model()) modelId = draft.models[0].id;
    render();
    form.hidden = false;
  }

  field('modelConnectionChoice').addEventListener('change', (event) => {
    collect();
    connectionId = event.target.value;
    render();
  });
  field('modelProfileChoice').addEventListener('change', (event) => {
    collect();
    modelId = event.target.value;
    render();
  });
  field('modelConnectionKind').addEventListener('change', renderConnectionKind);
  field('addModelConnection').addEventListener('click', () => {
    collect();
    connectionId = `connection-${crypto.randomUUID()}`;
    draft.connections.push({ id: connectionId, name: '新连接', kind: 'api' });
    render();
    field('modelConnectionName').select();
  });
  field('addModelProfile').addEventListener('click', () => {
    collect();
    modelId = `model-${crypto.randomUUID()}`;
    draft.models.push({ id: modelId, name: '新模型', connectionId, model: '', effort: '' });
    render();
    field('modelProfileName').select();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    collect();
    const revision = ++request;
    form.inert = true;
    status.textContent = '正在保存模型设置…';
    try {
      const settings = await api('/api/model-settings', { method: 'POST', body: JSON.stringify(draft) });
      if (revision !== request) return;
      display(settings);
      status.textContent = '模型设置已保存。';
    } catch (error) {
      if (revision === request) status.textContent = error.message;
    } finally {
      if (revision === request) form.inert = false;
    }
  });
  field('settingsDialog').addEventListener('close', () => {
    request += 1;
    draft = undefined;
    key.value = '';
    form.inert = false;
    form.hidden = true;
  });

  return async function loadModelSettings() {
    const revision = ++request;
    status.textContent = '正在读取模型设置…';
    try {
      const settings = await api('/api/model-settings');
      if (revision !== request) return;
      display(settings);
      status.textContent = '';
    } catch (error) {
      if (revision === request) status.textContent = `读取模型设置失败。${error.message}`;
    }
  };
}
