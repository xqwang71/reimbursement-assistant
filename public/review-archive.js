const reviewStatus = { complete: '材料齐全', incomplete: '材料缺项', needs_review: '待核对' };
const reviewTrigger = { scan: '首次或刷新审核', human_review: '补充说明后审核', human_confirmation: '人工确认', legacy_backfill: '历史补录' };
const materialStatus = { present: '已具备', missing: '缺项', uncertain: '待核对', not_applicable: '不适用' };
const questionStatus = { answered: '已回答', pending: '待核对', superseded: '已更新' };

function element(tag, value) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}

function appendTextList(parent, label, values) {
  if (!values.length) return;
  const list = element('ul', '');
  list.append(...values.map((value) => element('li', value)));
  parent.append(element('h4', label), list);
}

const readableTime = (value) => String(value || '').replace('T', ' ').slice(0, 16);
const nonempty = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];

export function bindReviewArchive(api) {
  const get = (id) => document.getElementById(id);
  const panel = get('reviewArchive');
  const status = get('reviewArchiveStatus');
  const search = get('reviewArchiveSearch');
  const list = get('reviewArchiveRows');
  const dialog = get('reviewArchiveDialog');
  const title = get('reviewArchiveTitle');
  const content = get('reviewArchiveContent');
  let batches = [];
  let viewRevision = 0;

  function renderList() {
    const terms = search.value.trim().normalize('NFKC').toLowerCase();
    const matches = batches.filter((batch) =>
      [batch.title, batch.folder, batch.subject, batch.year].join(' ').normalize('NFKC').toLowerCase().includes(terms));
    list.replaceChildren();
    for (const batch of matches) {
      const item = element('li', '');
      const button = element('button', batch.title || batch.folder || '未命名批次');
      button.type = 'button';
      button.className = 'text-button';
      button.dataset.batchId = batch.id;
      const notes = [batch.year, batch.subject, reviewStatus[batch.status] || batch.status, `${batch.reviewCount} 次审核`, readableTime(batch.lastReview)];
      if (batch.archived) notes.push('旧清单已移除');
      item.append(button, element('small', notes.filter(Boolean).join(' · ')));
      list.append(item);
    }
    status.textContent = matches.length || !terms ? `显示 ${matches.length} 个批次` : '没有匹配的批次。';
  }

  function renderBatch({ batch, reviews, questions, answers }) {
    title.textContent = batch.title || batch.folder || '旧审核批次';
    const location = element('p', [batch.year, batch.folder, batch.subject].filter(Boolean).join(' · '));
    location.className = 'muted';
    content.replaceChildren(location);
    const answersByQuestion = new Map();
    for (const answer of answers) {
      if (!answersByQuestion.has(answer.questionId)) answersByQuestion.set(answer.questionId, []);
      answersByQuestion.get(answer.questionId).push(answer);
    }

    for (const [index, review] of reviews.entries()) {
      const detail = element('details', '');
      detail.className = 'review-archive-entry';
      detail.open = index === 0;
      detail.append(element('summary', [readableTime(review.completedAt), reviewStatus[review.status] || review.status,
        reviewTrigger[review.trigger] || review.trigger].filter(Boolean).join(' · ')));
      const result = review.result || {};
      if (review.summary || result.summary || result.sentence) detail.append(element('p', review.summary || result.summary || result.sentence));
      if (review.error) detail.append(element('p', review.error));
      appendTextList(detail, '缺少的材料', nonempty(result.missing));
      if (Array.isArray(result.materials)) {
        appendTextList(detail, '材料核对', result.materials.filter((item) => item?.requirement).map((item) =>
          [item.requirement, materialStatus[item.state] || item.state, item.note].filter(Boolean).join(' · ')));
      }
      if (Array.isArray(result.issues)) {
        appendTextList(detail, '审核意见', result.issues.filter((item) => item?.title || item?.detail).map((item) =>
          [item.title, item.detail].filter(Boolean).join(' · ')));
      }
      appendTextList(detail, '当时建议', nonempty(result.next_actions));
      content.append(detail);
    }
    if (!reviews.length) content.append(element('p', '这个批次没有已保存的审核记录。'));

    if (questions.length) {
      const detail = element('details', '');
      detail.className = 'review-archive-entry';
      detail.append(element('summary', `人工核对与回答（${questions.length}）`));
      for (const question of questions) {
        const entry = element('section', '');
        entry.append(element('h4', question.question));
        const note = [questionStatus[question.status] || question.status, question.reason].filter(Boolean).join(' · ');
        if (note) entry.append(element('p', note));
        for (const answer of answersByQuestion.get(question.id) || []) {
          entry.append(element('p', `${readableTime(answer.answeredAt)}　${answer.text}`));
        }
        detail.append(entry);
      }
      content.append(detail);
    }
  }

  panel.addEventListener('toggle', async () => {
    if (!panel.open || panel.hidden) return;
    const revision = ++viewRevision;
    status.textContent = '正在读取旧审核档案…';
    try {
      const archive = await api('/api/review-archive');
      if (revision !== viewRevision) return;
      batches = archive.batches;
      get('reviewArchiveHeading').textContent = `旧审核档案（${batches.length} 个批次，${archive.reviewCount} 次审核）`;
      renderList();
    } catch (error) {
      if (revision === viewRevision) status.textContent = error.message;
    }
  });

  search.addEventListener('input', renderList);
  list.addEventListener('click', async (event) => {
    const id = event.target.closest('[data-batch-id]')?.dataset.batchId;
    if (!id) return;
    const revision = ++viewRevision;
    title.textContent = '旧审核批次';
    content.textContent = '正在读取审核记录…';
    dialog.showModal();
    try {
      const batch = await api(`/api/review-archive?batch=${encodeURIComponent(id)}`);
      if (revision === viewRevision && dialog.open) renderBatch(batch);
    } catch (error) {
      if (revision === viewRevision && dialog.open) content.textContent = error.message;
    }
  });
  get('closeReviewArchive').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => content.replaceChildren());

  return (available) => {
    panel.hidden = !available;
    if (available) return;
    viewRevision += 1;
    batches = [];
    panel.open = false;
    list.replaceChildren();
    content.replaceChildren();
    search.value = '';
    status.textContent = '';
    get('reviewArchiveHeading').textContent = '旧审核档案';
    if (dialog.open) dialog.close();
  };
}
