export function bindFundingSummary({ api, money, escapeHtml, onPayrollSync }) {
  const field = (id) => document.getElementById(id);
  const status = field('fundingStatus');
  const refresh = field('fundingRefresh');
  const sync = field('fundingSync');
  const syncStop = field('fundingSyncStop');
  const projects = field('fundingProjects');
  const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 });
  let summary;
  let request = 0;
  let pollTimer;
  let syncRevision = '';
  const amount = (value) => money(value, '—');
  const rate = (value) => Number.isFinite(value) ? percent.format(value) : '—';
  const location = ({ file, sheet, row }) => [file, sheet, row ? `第 ${row} 行` : ''].filter(Boolean).join(' · ');
  const shown = (value) => summary.totals.hasSchoolData ? amount(value) : '—';
  const progressAmount = (value) => summary.totals.hasProgressData ? amount(value) : '—';

  function renderReceipts(receipts) {
    field('fundingReceipts').hidden = !receipts.length;
    if (!receipts.length) return;
    const states = { missing: '现有学校表未找到', booked: '学校已报销', pending: '学校已查到，待入账', excluded: '学校已排除', conflict: '同单号数据待核对' };
    const found = receipts.filter(({ state }) => ['booked', 'pending', 'excluded'].includes(state)).length;
    field('fundingReceiptsHeading').textContent = `执行器回执核对（学校已核对 ${found}/${receipts.length} 笔）`;
    field('fundingReceiptRows').innerHTML = `<div class="funding-table"><table>
      <thead><tr><th>单号</th><th>执行器金额</th><th>学校表金额</th><th>核对结果</th><th>来源</th></tr></thead>
      <tbody>${receipts.map((record) => `<tr><td>${escapeHtml(record.financeId)}</td><td>${amount(record.amountCny)}</td><td>${amount(record.schoolAmountCny)}</td>
        <td>${escapeHtml(states[record.state] || '')}${record.status ? `<small>${escapeHtml(record.status)}</small>` : ''}${record.amountMismatch ? '<small class="funding-pending">与执行器回执金额不同</small>' : ''}</td>
        <td>${record.source ? escapeHtml(location(record.source)) : '—'}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  function renderSync(job) {
    field('fundingSyncStatus').hidden = !job;
    sync.disabled = job?.active === true;
    syncStop.hidden = !job?.active;
    if (!job) return;
    const labels = { queued: '排队中', running: '同步中', waiting_login: '等待学校登录', waiting_network: '等待网络', completed: '已同步', partial: '部分完成', error: '同步未完成', stopped: '已停止' };
    field('fundingSyncMessage').textContent = `${job.year} 年学校执行表 · ${labels[job.status] || job.status}`;
    field('fundingSyncSources').innerHTML = Object.values(job.sources).map((source) => {
      const files = source.files.map(({ filename, category, rowCount, lastDate, fromMonth, throughMonth, skipped }) => {
        const period = fromMonth > 1 || throughMonth < 12 ? ` · ${fromMonth === throughMonth ? fromMonth : `${fromMonth}–${throughMonth}`} 月` : '';
        return `${filename || category || '年度查询'}${period} · ${skipped ? '无记录' : `${rowCount} 条${lastDate ? ` · 最晚 ${lastDate}` : ''}`}`;
      });
      const details = [...files, ...source.errors].map((line) => `<li>${escapeHtml(line)}</li>`).join('');
      return `<li><strong>${escapeHtml(source.name)}</strong>${source.computer ? ` · ${escapeHtml(source.computer)}` : ''} · ${escapeHtml(source.message || labels[source.status] || '')}${details ? `<ul>${details}</ul>` : ''}</li>`;
    }).join('');
    const current = `${job.id}:${job.revision}`;
    if (job.revision && current !== syncRevision) {
      load();
      if (job.sources.labor?.payrollStatuses?.checked) onPayrollSync?.().catch(() => undefined);
    }
    syncRevision = current;
  }

  async function readSync(method = 'GET') {
    clearTimeout(pollTimer);
    if (method === 'POST') sync.disabled = true;
    try {
      const { job } = await api('/api/funding-summary/sync', { method });
      renderSync(job);
      if (job?.active) pollTimer = setTimeout(readSync, 2300);
    } catch (error) {
      if (method === 'GET' && sync.disabled) {
        pollTimer = setTimeout(readSync, 3500);
      } else if (method !== 'GET') {
        field('fundingSyncStatus').hidden = false;
        field('fundingSyncMessage').textContent = error.message;
        sync.disabled = false;
      }
    }
  }

  function progress(project) {
    const known = summary.totals.hasProgressData && project.rate !== null;
    const categories = Object.entries(project.progressCategories);
    const positive = categories.reduce((sum, [, value]) => sum + Math.max(0, value), 0);
    const width = known ? Math.max(0, Math.min(1, project.rate)) * 100 : 0;
    const fill = positive && width ? categories.map(([key, value]) =>
      value > 0 ? `<span class="funding-${key}" style="width:${(value / positive * width).toFixed(4)}%"></span>` : '').join('') : '';
    return `<span class="funding-bar${known ? '' : ' funding-bar-unknown'}" aria-hidden="true">${fill}</span>`;
  }

  function recordRows(records, project) {
    if (!records.length) return '<p class="muted">当前执行表暂无该项目的支出记录。</p>';
    const canAttribute = project?.lines.length > 1;
    return `<div class="funding-table"><table>
      <thead><tr><th>日期</th><th>单据与事由</th><th>类别</th><th>金额</th><th>学校状态</th><th>来源</th>${canAttribute ? '<th>归属台账名目</th>' : ''}</tr></thead>
      <tbody>${records.map((record) => `<tr>
        <td>${escapeHtml(record.date || '—')}</td>
        <td><strong>${escapeHtml(record.financeId)}</strong>${record.reason ? `<small>${escapeHtml(record.reason)}</small>` : ''}${record.projectText ? `<small>${escapeHtml(record.projectText)}</small>` : ''}</td>
        <td>${escapeHtml(summary.categories[record.category])}</td><td>${amount(record.amountCny)}</td>
        <td>${escapeHtml(record.status || '—')}${record.state === 'pending' ? `<small class="funding-pending">${record.countsTowardProgress ? '已提交待入账' : '提交状态待核对'}</small>` : ''}</td>
        <td>${escapeHtml(location(record.source))}${record.allocationSource ? `<small>${escapeHtml(record.allocationSource)}</small>` : ''}</td>
        ${canAttribute ? `<td><select data-funding-record="${escapeHtml(record.key)}" data-saved-value="${escapeHtml(record.ledgerNo)}" aria-label="单据 ${escapeHtml(record.financeId)} 的台账名目">
          <option value="">待归属</option>${project.lines.map(({ ledgerNo, name }) => `<option value="${escapeHtml(ledgerNo)}"${record.ledgerNo === ledgerNo ? ' selected' : ''}>${escapeHtml(name)} · ${escapeHtml(ledgerNo)}</option>`).join('')}
        </select></td>` : ''}
      </tr>`).join('')}</tbody></table></div>`;
  }

  function ledgerLines(project) {
    if (!project.lines.length) return '';
    if (project.lines.length === 1) {
      const [line] = project.lines;
      return `<p class="muted">台账 ${escapeHtml(line.ledgerNo)} · ${escapeHtml(location(line))}</p>${line.budgetNote ? `<p class="muted">${escapeHtml(line.budgetNote)}</p>` : ''}`;
    }
    return `<p class="muted">${project.lines.length} 个台账名目共用此编号。可在明细中登记归属。计入进度的金额中还有 ${progressAmount(project.unassignedProgressCny)} 待归属。</p>
      <div class="funding-table"><table><thead><tr><th>台账名目</th><th>预算</th><th>已报销</th><th>已提交待入账</th><th>计入进度</th></tr></thead><tbody>
        ${project.lines.map((line) => `<tr>
          <td>${escapeHtml(line.name)}<small>${escapeHtml(line.ledgerNo)} · ${escapeHtml(location(line))}</small>${line.budgetNote ? `<small>${escapeHtml(line.budgetNote)}</small>` : ''}</td>
          <td>${amount(line.budgetCny)}</td><td>${shown(line.bookedCny)}</td><td>${progressAmount(line.submittedCny)}</td><td>${progressAmount(line.progressCny)}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
  }

  function projectRow(project, open) {
    const linked = Boolean(project.projectNo);
    const { handlingMode, handlingPerson, handlingStatus } = project.lines.length === 1 ? project.lines[0] : {};
    const entrustedCompleted = !linked && handlingStatus === '已完成';
    const handling = ['托人报销', '代人报销'].includes(handlingMode) ? [handlingMode, handlingPerson] : [];
    const subtitle = [project.projectNo, project.budgetSource, ...handling].filter(Boolean).join(' · ');
    const rateLabel = !linked ? (entrustedCompleted ? '已完成' : '进度待核对')
      : !(project.budgetCny > 0) ? '预算待补' : rate(summary.totals.hasProgressData ? project.rate : null);
    const pendingMessage = handlingMode === '托人报销' ? '待核对经办人的报销记录。' : '学校项目编号待补。';
    const budgetLabel = project.budgetCny === null ? '' : `预算 ${amount(project.budgetCny)}`;
    const moneyDetails = entrustedCompleted ? '' : `
      <span><small>计入进度</small> <strong>${linked ? progressAmount(project.progressCny) : '—'}</strong></span>
      <small>已报销 ${linked ? shown(project.bookedCny) : '—'}</small>
      ${project.submittedCny ? `<small>已提交待入账 ${amount(project.submittedCny)}</small>` : ''}`;
    const recordDetails = linked ? recordRows(project.records, project)
      : entrustedCompleted ? '' : `<p class="muted">${pendingMessage}</p>`;
    return `<details class="funding-project" data-funding-project="${escapeHtml(project.key)}"${open ? ' open' : ''}>
      <summary>
        <span class="funding-project-name"><strong>${escapeHtml(project.name || project.projectNo)}</strong><small>${escapeHtml(subtitle)}</small></span>
        <span class="funding-chart">${progress(project)}<small>${escapeHtml(budgetLabel)}</small></span>
        <span class="funding-project-money">${moneyDetails}</span>
        <strong class="funding-rate">${rateLabel}</strong>
      </summary>
      <div class="funding-project-details">
        ${linked ? `<div class="funding-legend">${Object.entries(summary.categories).map(([key, label]) => `<span><i class="funding-${key}"></i>${escapeHtml(label)} <strong>${progressAmount(project.progressCategories[key])}</strong></span>`).join('')}</div>` : ''}
        ${ledgerLines(project)}${recordDetails}
      </div>
    </details>`;
  }

  function render(result) {
    const newRoot = summary?.sourceRoot !== result.sourceRoot;
    const opened = new Set(summary?.sourceRoot === result.sourceRoot ? [...projects.querySelectorAll('[data-funding-project][open]')].map((node) => node.dataset.fundingProject) : []);
    summary = result;
    const { totals } = result;
    const latestSchoolDate = result.sources.filter(({ kind }) => kind !== 'runner').map(({ lastDate }) => lastDate || '').sort().at(-1);
    field('fundingPeriod').textContent = [result.demoMode ? '虚构示例' : '', result.year ? `${result.year} 年度` : '当前票据目录', latestSchoolDate ? `学校表最晚记录 ${latestSchoolDate}` : ''].filter(Boolean).join(' · ');
    field('fundingTotals').innerHTML = [
      ['项目执行率', rate(totals.hasProgressData ? totals.rate : null)],
      ['已关联预算', totals.budgetCny > 0 ? amount(totals.budgetCny) : '—'],
      ['学校已报销', shown(totals.bookedCny)],
      ['已提交待入账', progressAmount(totals.submittedCny)],
    ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
    field('fundingLegend').innerHTML = Object.entries(result.categories).map(([key, label]) =>
      `<span><i class="funding-${key}"></i>${escapeHtml(label)} <strong>${progressAmount(totals.progressCategories[key])}</strong></span>`).join('');
    const missingBudget = result.projects.filter(({ rate, projectNo, lines }) =>
      rate === null && (projectNo || lines[0]?.handlingMode !== '托人报销')).length;
    field('fundingScope').textContent = [
      totals.hasProgressData && totals.budgetCny > 0 ? `已关联学校编号的预算项目计入 ${amount(totals.coveredCny)}，包含已报销和已提交待入账。`
        : '执行率按已关联学校编号的预算项目计算，包含已报销和已提交待入账。',
      totals.localPendingCny ? `已提交待入账中有 ${amount(totals.localPendingCny)} 来自执行器回执，学校表待核对。` : '',
      totals.pendingCny !== totals.submittedCny ? `另有 ${amount(totals.pendingCny - totals.submittedCny)} 的提交状态待核对。` : '',
      missingBudget ? `${missingBudget} 个项目的预算或学校编号待补。` : '',
    ].filter(Boolean).join('');
    projects.innerHTML = result.projects.map((project) => projectRow(project, opened.has(project.key))).join('');
    renderReceipts(result.receipts || []);
    field('fundingChecks').innerHTML = [
      result.unassigned.length ? `<details class="funding-data"><summary>待确认学校项目（${result.unassigned.length} 条，已报销 ${shown(totals.unassignedCny)}）</summary>${recordRows(result.unassigned)}</details>` : '',
      result.issues.length ? `<details class="funding-data"><summary>待核对数据（${result.issues.length} 条）</summary><ul>${result.issues.map((issue) => `<li>${escapeHtml([issue.receipt, issue.message, ...issue.sources.map(location)].join(' · '))}</li>`).join('')}</ul></details>` : '',
    ].join('');
    field('fundingSources').innerHTML = result.sources.map((source) => {
      const info = source.state === 'read' ? `${source.rowCount} 条${source.lastDate ? ` · 最晚记录 ${source.lastDate}` : ''}${source.excludedYears ? ` · 略过 ${source.excludedYears} 条跨年记录` : ''}`
        : source.state === 'missing' ? '未在年度票据目录找到' : source.message;
      const downloadable = ['smart', 'legacy', 'labor'].includes(source.kind) || (result.demoMode && source.kind === 'budget');
      const link = source.state === 'read' && downloadable
        ? `　<a href="/api/funding-summary/source?file=${encodeURIComponent(source.file)}" download>${source.kind === 'budget' ? '下载台账模板' : result.demoMode ? '下载示例 Excel' : '下载原始 Excel'}</a>` : '';
      return `<li><strong>${escapeHtml(source.file)}</strong>　${escapeHtml(info)}${link}</li>`;
    }).join('');
    field('fundingContent').hidden = false;
    const missingSources = result.sources.filter(({ state }) => state !== 'read').length;
    status.textContent = missingSources ? `${missingSources} 份表格缺失或读取失败。文件放在当前年度票据目录，更新后点「重新读取执行表」。`
      : result.issues.length ? `${result.issues.length} 条数据需要核对，详见项目下方。` : '';
    if (newRoot) readSync();
  }

  async function load() {
    const sequence = ++request;
    refresh.disabled = true;
    status.textContent = '正在读取年度执行表…';
    try {
      const result = await api('/api/funding-summary');
      if (sequence === request) render(result);
    } catch (error) {
      if (sequence === request) {
        field('fundingContent').hidden = true;
        status.textContent = `读取报销汇总失败。${error.message}`;
      }
    } finally {
      if (sequence === request) refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', load);
  sync.addEventListener('click', () => readSync('POST'));
  syncStop.addEventListener('click', () => readSync('DELETE'));
  projects.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-funding-record]');
    if (!select) return;
    select.disabled = true;
    try {
      await api('/api/funding-summary/attribution', { method: 'POST', body: JSON.stringify({
        sourceRoot: summary.sourceRoot, recordKey: select.dataset.fundingRecord, ledgerNo: select.value,
      }) });
      await load();
    } catch (error) {
      select.value = select.dataset.savedValue;
      status.textContent = `保存归属失败。${error.message}`;
    } finally {
      select.disabled = false;
    }
  });
  return load;
}
