import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getBrowserSession, savedPlatformUrl } from './browser-session.mjs';
import { SCHOOL_REPORTS, downloadSchoolReports, schoolReportUrl } from './school-report-browser.mjs';
import { installSchoolRegister } from './school-report-files.mjs';

function detail(error) {
  return String(error?.message || error).split('\n')[0].replace(/https?:\/\/[^\s"']+/gi, '学校网页').slice(0, 180);
}

export function createSchoolFundingSync({ appDir, runtimeDir, currentRoot, syncPayrollStatuses }) {
  let job = null;
  let controller = null;
  const view = (sourceRoot) => job?.sourceRoot === sourceRoot ? structuredClone(job) : null;

  async function execute(job, signal) {
    let localPage;
    let directory;
    const guard = () => {
      signal.throwIfAborted();
      if (currentRoot() !== job.sourceRoot) throw new Error('票据目录已变化，请重新同步。');
    };
    try {
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(runtimeDir, 'school-sync-'));
      const smartUrl = process.env.SUIBE_REIMBURSEMENT_URL || await savedPlatformUrl(appDir);
      async function syncSource(kind) {
        guard();
        const state = job.sources[kind];
        const onState = (status, message) => Object.assign(state, { status, message });
        state.computer = '本机';
        onState('running', '正在本机打开学校系统。');
        try {
          if (!localPage || localPage.isClosed()) localPage = (await getBrowserSession(appDir, { temporary: true })).page;
          const page = localPage;
          await page.bringToFront();
          await downloadSchoolReports({
            page, kind, year: job.year, directory, signal, onState, url: schoolReportUrl(kind, smartUrl),
            async save(artifact) {
              guard();
              if (artifact.skipped) {
                state.files.push({ category: artifact.category, fromMonth: artifact.fromMonth, throughMonth: artifact.throughMonth, skipped: true, rowCount: 0 });
                return;
              }
              const result = await installSchoolRegister({ ...artifact, sourceRoot: job.sourceRoot, runtimeDir, year: job.year, kind, guard });
              state.files.push({ ...result, fromMonth: artifact.fromMonth, throughMonth: artifact.throughMonth });
              job.revision += 1;
            },
            onFileError(category, error) { state.errors.push(`${category} · ${detail(error)}`); },
            ...(kind === 'labor' && syncPayrollStatuses ? {
              async onReport(frame) {
                guard();
                onState('running', '正在按学校单号核对已申报状态。');
                try {
                  state.payrollStatuses = await syncPayrollStatuses(job.sourceRoot, frame, signal);
                  const { checked, total } = state.payrollStatuses;
                  if (checked) job.revision += 1;
                  if (checked !== total) state.errors.push(`${total - checked} 笔薪酬原单未确认最新状态。`);
                } catch (error) {
                  guard();
                  state.errors.push('薪酬申报状态 · ' + detail(error));
                }
              },
            } : {}),
          });
          const checked = state.payrollStatuses?.checked || 0;
          const statuses = checked ? `已核对 ${checked} 笔薪酬状态。` : '';
          if (state.errors.length) onState(state.files.length || checked ? 'partial' : 'error', `${statuses}有 ${state.errors.length} 项尚未同步。`);
          else {
            const empty = state.files.filter(({ skipped }) => skipped).length;
            onState('completed', `已核对 ${state.files.length - empty} 份执行表。${empty ? `另有 ${empty} 个查询为空。` : ''}${statuses}`);
          }
        } catch (error) {
          guard();
          onState(state.files.length ? 'partial' : 'error', detail(error));
        }
      }
      for (const kind of Object.keys(job.sources)) await syncSource(kind);
      job.status = Object.values(job.sources).every(({ status }) => status === 'completed') ? 'completed'
        : Object.values(job.sources).some(({ files, payrollStatuses }) => files.length || payrollStatuses?.checked) ? 'partial' : 'error';
    } catch (error) {
      job.status = signal.aborted ? 'stopped' : 'error';
      job.message = detail(error);
      for (const item of Object.values(job.sources).filter(({ status }) => ['queued', 'running', 'waiting_network', 'waiting_login'].includes(status))) {
        item.status = job.status;
        item.message = job.message;
      }
    } finally {
      try {
        await localPage?.close().catch(() => undefined);
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      } finally {
        job.active = false;
        job.finishedAt = new Date().toISOString();
      }
    }
  }

  return {
    view,
    start(sourceRoot, year) {
      if (job?.active) {
        if (job.sourceRoot !== sourceRoot) throw Object.assign(new Error('另一个目录的执行表同步正在结束，请稍候。'), { statusCode: 409 });
        return view(sourceRoot);
      }
      if (!/^20\d{2}$/.test(year)) throw Object.assign(new Error('请先选择带有报销年度或年度台账的票据目录。'), { statusCode: 400 });
      job = {
        id: randomUUID(), sourceRoot, year, status: 'running', active: true, revision: 0, startedAt: new Date().toISOString(),
        sources: Object.fromEntries(Object.entries(SCHOOL_REPORTS).map(([kind, name]) => [kind, { name, status: 'queued', message: '', files: [], errors: [] }])),
      };
      controller = new AbortController();
      execute(job, controller.signal);
      return view(sourceRoot);
    },
    stop(sourceRoot, reason = '同步已停止。') {
      if (job?.active && job.sourceRoot === sourceRoot) controller.abort(new Error(reason));
      return view(sourceRoot);
    },
  };
}
