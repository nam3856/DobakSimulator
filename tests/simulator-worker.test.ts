import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SimulationConfig,
  SimulationState,
  WorkerRequest,
  WorkerResponse,
} from '../src/types';

const engine = vi.hoisted(() => ({
  loadRuleData: vi.fn(),
  rollBatch: vi.fn(),
  computeBenchmark: vi.fn(),
}));
vi.mock('../src/engine', () => engine);

const config: SimulationConfig = {
  mode: 'cube',
  cubeType: 'black',
  category: 'weapon',
  level: 200,
  start: { grade: 'legendary', lines: [], stage: 0, failures: 0 },
  lockedSlots: [],
  batchSize: 3,
  target: {
    mode: 'sum',
    minimumGrade: 'legendary',
    conditions: [],
    lines: [],
    stage: 0,
    match: 'all',
  },
  unitPrices: {},
  ruleVersion: 'worker-test',
};

function state(): SimulationState {
  return {
    ...config.start,
    attempts: 0n,
    spent: { meso: 0n, cubes: 0n, honor: 0n, credits: 0n, ethers: [0n, 0n, 0n, 0n] },
    status: 'running',
    history: [],
    candidates: [],
    startedAt: '2026-09-17T00:00:00.000Z',
  };
}

function advance(
  previous: SimulationState,
  count: bigint,
  status: SimulationState['status'] = 'running',
) {
  const cost = { ...previous.spent, meso: count * 10n };
  const result = {
    sequence: previous.attempts + count,
    grade: previous.grade,
    lines: previous.lines,
    stage: previous.stage,
    promoted: false,
    amplified: false,
    hit: status === 'success',
    cost,
  };
  return {
    ...previous,
    attempts: previous.attempts + count,
    status,
    spent: { ...previous.spent, meso: previous.spent.meso + cost.meso },
    history: [result, ...previous.history],
    candidates: [result],
  } satisfies SimulationState;
}

let worker: {
  location: { origin: string };
  postMessage: ReturnType<typeof vi.fn<(response: WorkerResponse) => void>>;
  onmessage?: (event: MessageEvent<WorkerRequest>) => Promise<void>;
};
const dispatch = (request: WorkerRequest) =>
  worker.onmessage!({ data: request } as MessageEvent<WorkerRequest>);
const runRequest = (id: string, initial = state()): WorkerRequest => ({
  type: 'run',
  id,
  config,
  state: initial,
  baseUrl: 'https://fixture.example/rules/',
});
const responses = () => worker.postMessage.mock.calls.map(([response]) => response);

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  worker = { location: { origin: 'https://fixture.example' }, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (elapsed += 25));
  engine.loadRuleData.mockResolvedValue({});
  await import('../src/workers/simulator.worker');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('unlimited automatic Worker execution', () => {
  it('keeps yielding progress beyond 100,000 attempts until the goal is reached', async () => {
    // Fast-forward the counter without drawing hundreds of thousands of random outcomes.
    engine.rollBatch.mockImplementation((_data, _config, previous: SimulationState) =>
      advance(previous, 50001n, previous.attempts >= 100002n ? 'success' : 'running'),
    );
    const running = dispatch(runRequest('long-run'));
    await vi.runAllTimersAsync();
    await running;
    expect(engine.rollBatch).toHaveBeenCalledTimes(3);
    expect(responses()).toMatchObject([
      { type: 'state', done: false, state: { attempts: 50001n } },
      { type: 'state', done: false, state: { attempts: 100002n } },
      { type: 'state', done: true, state: { attempts: 150003n, status: 'success' } },
    ]);
    const final = responses().at(-1)!;
    expect(final.type).toBe('state');
    if (final.type !== 'state') throw new Error('Expected final state');
    expect(final.state.spent.meso).toBe(1500030n);
    expect(final.state.history).toHaveLength(3);
    expect(final.state.candidates[0].sequence).toBe(150003n);
  });

  it('processes stop between chunks and resumes with the same accumulated cost and history', async () => {
    engine.rollBatch.mockImplementation((_data, _config, previous: SimulationState) =>
      advance(previous, 3n),
    );
    const running = dispatch(runRequest('before-stop'));
    await Promise.resolve();
    await Promise.resolve();
    expect(responses()).toMatchObject([{ type: 'state', done: false, state: { attempts: 3n } }]);
    await dispatch({ type: 'stop', id: 'before-stop' });
    await vi.runAllTimersAsync();
    await running;
    expect(engine.rollBatch).toHaveBeenCalledTimes(1);
    const paused = responses().at(-1)!;
    expect(paused).toMatchObject({
      type: 'state',
      done: true,
      state: { status: 'paused', attempts: 3n },
    });
    if (paused.type !== 'state') throw new Error('Expected paused state');
    expect(paused.state.spent.meso).toBe(30n);
    expect(paused.state.history).toHaveLength(1);
    engine.rollBatch.mockImplementation((_data, _config, previous: SimulationState) =>
      advance(previous, 3n, 'success'),
    );
    await dispatch(runRequest('resumed', paused.state));
    expect(responses().at(-1)).toMatchObject({
      type: 'state',
      id: 'resumed',
      done: true,
      state: { status: 'success', attempts: 6n, spent: { meso: 60n } },
    });
    const final = responses().at(-1)!;
    if (final.type !== 'state') throw new Error('Expected final state');
    expect(final.state.history[1]).toEqual(paused.state.history[0]);
  });

  it('stops as soon as a roll makes the target impossible', async () => {
    engine.rollBatch.mockImplementation((_data, _config, previous: SimulationState) =>
      advance(previous, 3n, 'impossible'),
    );
    await dispatch(runRequest('unreachable'));
    expect(engine.rollBatch).toHaveBeenCalledTimes(1);
    expect(responses()).toMatchObject([
      { type: 'state', done: true, state: { status: 'impossible', attempts: 3n } },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'impossible'] as const)(
    'reports an already %s state without charging a roll',
    async (status) => {
      await dispatch(runRequest('already-terminal', { ...state(), status }));
      expect(engine.rollBatch).not.toHaveBeenCalled();
      expect(responses()).toMatchObject([
        { type: 'state', done: true, state: { status, attempts: 0n, spent: { meso: 0n } } },
      ]);
    },
  );
});
