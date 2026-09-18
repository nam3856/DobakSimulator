import {
  restoreStarforce,
  rollStarforce,
  type StarforceConfig,
  type StarforceRules,
  type StarforceState,
} from './starforce';

export type StarforceRunRequest =
  | {
      type: 'run';
      id: string;
      rules: StarforceRules;
      config: StarforceConfig;
      state: StarforceState;
    }
  | { type: 'stop'; id: string };
export type StarforceRunResponse =
  | { type: 'state'; id: string; state: StarforceState; done: boolean }
  | { type: 'error'; id: string; message: string; state?: StarforceState };

interface RunnerOptions {
  random?: () => number;
  now?: () => number;
  /** Schedule asynchronously, after queued Worker messages can be handled. */
  schedule?: (callback: () => void) => unknown;
  cancel?: (handle: unknown) => void;
  maxActions?: number;
  timeBudgetMs?: number;
}
interface Job {
  id: string;
  rules: StarforceRules;
  config: StarforceConfig;
  state: StarforceState;
  scheduled: boolean;
  timer?: unknown;
}

/** Runs real paid actions in bounded chunks. A restoration is one action but does
 * not consume RNG or increment attempts; both behaviors belong to the shared engine.
 * Only the Worker calls this controller in production. Injectable scheduling and
 * randomness let tests verify cancellation and exact accounting without real timers. */
export function createStarforceRunner(
  send: (response: StarforceRunResponse) => void,
  options: RunnerOptions = {},
) {
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((callback: () => void) => setTimeout(callback, 0));
  const cancel =
    options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const maxActions = options.maxActions ?? 1000;
  const timeBudgetMs = options.timeBudgetMs ?? 20;
  if (
    !Number.isInteger(maxActions) ||
    maxActions < 1 ||
    !Number.isFinite(timeBudgetMs) ||
    timeBudgetMs <= 0
  )
    throw new Error('강화 실행 청크 설정이 올바르지 않습니다.');
  let active: Job | undefined;
  // Retain a few final snapshots so a stop racing the final success still gets an
  // acknowledgement, and a stale stop never cancels a newer run with a different ID.
  const recent = new Map<string, StarforceState>();
  function remember(job: Job) {
    recent.delete(job.id);
    recent.set(job.id, job.state);
    if (recent.size > 8) recent.delete(recent.keys().next().value!);
  }
  function detach(job: Job) {
    if (job.scheduled) cancel(job.timer);
    job.scheduled = false;
    if (active === job) active = undefined;
    remember(job);
  }
  function finish(job: Job) {
    detach(job);
    send({ type: 'state', id: job.id, state: job.state, done: true });
  }
  function chunk(job: Job) {
    if (active !== job) return;
    job.scheduled = false;
    try {
      const began = now();
      for (let actions = 0; actions < maxActions && job.state.status !== 'success'; actions++) {
        job.state =
          job.state.status === 'destroyed'
            ? restoreStarforce(job.rules, job.config, job.state)
            : rollStarforce(job.rules, job.config, job.state, options.random).state;
        if (now() - began >= timeBudgetMs) break;
      }
    } catch (error) {
      detach(job);
      send({
        type: 'error',
        id: job.id,
        message: error instanceof Error ? error.message : String(error),
        state: job.state,
      });
      return;
    }
    if (job.state.status === 'success') {
      finish(job);
      return;
    }
    remember(job);
    send({ type: 'state', id: job.id, state: job.state, done: false });
    if (active !== job) return;
    job.scheduled = true;
    job.timer = schedule(() => chunk(job));
  }
  function handle(request: StarforceRunRequest) {
    if (request.type === 'stop') {
      if (active?.id === request.id) finish(active);
      else {
        const state = recent.get(request.id);
        if (state) send({ type: 'state', id: request.id, state, done: true });
        else
          send({ type: 'error', id: request.id, message: '중지할 강화 도전을 찾을 수 없습니다.' });
      }
      return;
    }
    // IDs identify a single run, not a command to replay already paid attempts.
    if (active?.id === request.id) return;
    const previous = recent.get(request.id);
    if (previous) {
      send({ type: 'state', id: request.id, state: previous, done: true });
      return;
    }
    if (active) finish(active);
    const job: Job = { ...request, scheduled: false };
    active = job;
    chunk(job);
  }
  return {
    handle,
    /** Final-state acknowledgement is sent before canceling this controller. */
    dispose() {
      if (active) finish(active);
    },
  };
}
