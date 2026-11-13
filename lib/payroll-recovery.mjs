import { setTimeout as delay } from 'node:timers/promises';

const recoverable = (error) => ['PAYROLL_RECEIPT_PENDING', 'SCHOOL_BROWSER_STALLED'].includes(error?.code) ||
  error?.name === 'TimeoutError' ||
  /target page.*closed|browser.*disconnected|connection closed|execution context was destroyed|frame was detached|ERR_CONNECTION|ECONN|Windows 浏览器.*(?:响应|连接)|无法连接 Windows 上的学校|报销专用 Chrome 暂时没有响应/i.test(error?.message || '');

async function within(task, milliseconds, message) {
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); });
    return await Promise.race([Promise.resolve().then(task), deadline]);
  } finally { clearTimeout(timer); }
}

async function attempt(execute, options, { idleMs, waiting }) {
  const watchdog = new AbortController();
  const signal = AbortSignal.any([options.signal, watchdog.signal]);
  let session;
  let timer;
  let detaching;
  let rejectStall;
  const stalled = new Promise((_, reject) => { rejectStall = reject; });
  function heartbeat() {
    clearTimeout(timer);
    if (!session?.disconnect || signal.aborted) return;
    timer = setTimeout(() => {
      if (waiting()) { heartbeat(); return; }
      const error = Object.assign(new Error('学校网页长时间没有响应。'), { code: 'SCHOOL_BROWSER_STALLED' });
      detaching = (async () => {
        if (options.captureSchoolError && session.page && !session.page.isClosed()) {
          await within(() => options.captureSchoolError(session.page), 5000, '学校页面暂时无法截图。').catch(() => undefined);
        }
        await within(() => session.disconnect(), 5000, '学校网页无响应，暂时无法安全断开原连接。');
      })();
      watchdog.abort(error);
      detaching.then(() => rejectStall(error), rejectStall);
    }, idleMs);
  }
  const activity = (fn) => (...args) => {
    if (signal.aborted) return;
    heartbeat();
    return fn?.(...args);
  };
  const whileActive = (fn) => async (...args) => {
    signal.throwIfAborted();
    heartbeat();
    return fn(...args);
  };
  try {
    return await Promise.race([stalled, execute({
      ...options, signal,
      async openSession() {
        session = await options.openSession(signal);
        if (signal.aborted) {
          await session.cleanup?.();
          signal.throwIfAborted();
        }
        heartbeat();
        return session;
      },
      stage: activity(options.stage), log: activity(options.log), onAccess: activity(options.onAccess),
      validate: whileActive(options.validate), persist: whileActive(options.persist), record: whileActive(options.record),
    })]);
  } finally {
    clearTimeout(timer);
    if (detaching) await detaching;
  }
}

export async function runPayrollWithRecovery(execute, options, { waiting, onRetry, idleMs = 35000, retryMs = 1200 }) {
  for (;;) {
    try { return await attempt(execute, options, { idleMs, waiting }); }
    catch (error) {
      const { signal, control } = options;
      const used = control.payrollRecoveryAttempts || 0;
      if (signal.aborted || control.cancelled || control.paused || used >= 3 || !recoverable(error)) throw error;
      control.payrollRecoveryAttempts = used + 1;
      await onRetry(control.payrollRecoveryAttempts, error);
      await delay(retryMs, undefined, { signal });
    }
  }
}
