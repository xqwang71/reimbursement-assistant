import { closeSync, openSync } from 'node:fs';
import { link, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInsideDirectory, privateDataDirectory } from '../lib/platform.mjs';
import { hasReviewArchive, openReviewDatabase, reviewArchivePath } from '../lib/review-archive.mjs';

function validateSnapshot(database) {
  const counts = database.prepare(`
    SELECT (SELECT COUNT(*) FROM batches) AS batches,
      (SELECT COUNT(*) FROM review_runs) AS reviews,
      (SELECT COUNT(*) FROM review_questions) AS questions,
      (SELECT COUNT(*) FROM review_answers) AS answers
  `).get();
  const checks = database.prepare('PRAGMA integrity_check').all();
  if (checks.length !== 1 || checks[0].integrity_check !== 'ok' || database.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('审核数据库完整性检查未通过。');
  }
  return counts;
}

async function main() {
  if (process.argv.length !== 3) throw new Error('用法：npm run import-review-archive -- <旧版 reimbursement.sqlite 路径>');
  const program = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const data = await privateDataDirectory(program);
  const runtime = join(data, '.runtime');
  const destination = reviewArchivePath(runtime);
  if (await hasReviewArchive(destination)) throw new Error('当前用户资料已有审核档案。请备份并移走旧档案后再导入。');
  const source = await realpath(process.argv[2]);
  if (isInsideDirectory(program, source)) throw new Error('请先把旧审核数据库移到程序目录外。');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(runtime, 'review-import-'));
  const snapshot = join(staging, 'archive.sqlite');
  try {
    const database = await openReviewDatabase(source);
    if (!database) throw new Error('旧审核数据库不存在。');
    try {
      closeSync(openSync(snapshot, 'wx', 0o600));
      database.prepare('VACUUM INTO ?').run(snapshot);
    } finally {
      database.close();
    }
    const verification = await openReviewDatabase(snapshot);
    if (!verification) throw new Error('审核数据库快照未生成。');
    let counts;
    try { counts = validateSnapshot(verification); }
    finally { verification.close(); }
    await link(snapshot, destination);
    console.log(`已导入 ${counts.batches} 个批次、${counts.reviews} 次审核、${counts.questions} 条核对问题和 ${counts.answers} 条回答。`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.code ? `导入旧审核档案失败（${error.code}）。请核对数据库格式、目录权限及现有档案。` : error.message);
  process.exitCode = 1;
});
