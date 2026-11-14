import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

export const reviewArchivePath = (runtimeDirectory) => join(runtimeDirectory, 'legacy-reviews.sqlite');

export async function hasReviewArchive(file) {
  try { return (await lstat(file)).isFile(); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function openReviewDatabase(file) {
  if (!await hasReviewArchive(file)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true });
}

export async function listArchivedBatches(file, year = null) {
  const db = await openReviewDatabase(file);
  if (!db) return null;
  try {
    const batches = db.prepare(`
      SELECT b.id, b.year, COALESCE(NULLIF(b.title, ''), b.folder_name) AS title,
        b.folder_path AS folder, b.expense_subject AS subject, b.material_status AS status,
        b.deleted_at IS NOT NULL AS archived, COUNT(r.id) AS reviewCount, MAX(r.completed_at) AS lastReview
      FROM batches b LEFT JOIN review_runs r ON r.batch_id = b.id
      WHERE (? IS NULL OR b.year = ?)
      GROUP BY b.id
      ORDER BY lastReview DESC, b.id
    `).all(year, year);
    return { batches, reviewCount: batches.reduce((total, batch) => total + batch.reviewCount, 0) };
  } finally {
    db.close();
  }
}

export async function readArchivedBatch(file, id, year = null) {
  const db = await openReviewDatabase(file);
  if (!db) return null;
  try {
    const batch = db.prepare(`
      SELECT id, year, COALESCE(NULLIF(title, ''), folder_name) AS title,
        folder_path AS folder, expense_subject AS subject, deleted_at IS NOT NULL AS archived
      FROM batches WHERE id = ? AND (? IS NULL OR year = ?)
    `).get(id, year, year);
    if (!batch) return null;
    const reviews = db.prepare(`
      SELECT id, trigger, status, summary, completed_at AS completedAt,
        error_message AS error, structured_result_json AS storedResult
      FROM review_runs WHERE batch_id = ? ORDER BY completed_at DESC, rowid DESC
    `).all(id).map(({ storedResult, ...review }) => {
      let result;
      try { result = JSON.parse(storedResult); } catch {}
      return { ...review, result: result && typeof result === 'object' ? result : null };
    });
    const questions = db.prepare(`
      SELECT id, question, reason, status
      FROM review_questions WHERE batch_id = ? ORDER BY created_at DESC, priority, id
    `).all(id);
    const answers = db.prepare(`
      SELECT a.question_id AS questionId, COALESCE(NULLIF(a.answer_text, ''), a.answer_value) AS text,
        a.answered_at AS answeredAt
      FROM review_answers a JOIN review_questions q ON q.id = a.question_id
      WHERE q.batch_id = ? ORDER BY a.answered_at DESC, a.id
    `).all(id);
    return { batch, reviews, questions, answers };
  } finally {
    db.close();
  }
}
