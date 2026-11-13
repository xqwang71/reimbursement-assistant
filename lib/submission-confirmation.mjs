export async function confirmSubmission({ control, ask, validate, checkpoint, question }) {
  if (control.skipSubmit) return false;
  if (!control.autoSubmit) {
    if (!ask) return false;
    const answer = await ask(question + '\n回复「确认提交」后提交本笔。', { kind: 'final_approval', required: true });
    if (answer.trim().replace(/\s/g, '') !== '确认提交' || control.skipSubmit) return false;
  }
  await validate();
  await checkpoint();
  return !control.skipSubmit;
}
