import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStarforceRunner, type StarforceRunResponse } from '../src/engine/starforce-runner';
import {
  createStarforceState,
  restoreStarforce,
  rollStarforce,
  type StarforceConfig,
  type StarforceRules,
  type StarforceState,
} from '../src/engine/starforce';

function fixture(): { rules: StarforceRules; config: StarforceConfig } {
  return {
    rules: {
      ruleId: 'runner-independent-two-stage',
      minimumLevel: 1,
      maximumLevel: 250,
      maximumStarBands: [{ minimumLevel: 1, maximumLevel: 250, maximumStar: 2 }],
      costFormula: {
        baseCost: 9,
        levelExponent: 0,
        starOffset: 1,
        starExponent: 0,
        roundTo: 1,
        denominators: [{ minimumStar: 0, maximumStar: 1, denominator: 1 }],
      },
      transitions: [
        {
          star: 0,
          successStar: 1,
          successProbability: 0.5,
          maintainProbability: 0.5,
          decreaseProbability: 0,
          destroyProbability: 0,
        },
        {
          star: 1,
          successStar: 2,
          successProbability: 0.5,
          maintainProbability: 0.25,
          decreaseProbability: 0,
          destroyProbability: 0.25,
          traceStar: 1,
        },
      ],
      safeguard: {
        eligibleStars: [1],
        additionalBaseCostMultiplier: 2,
        destroyProbabilityMultiplier: 0,
      },
      restoration: {
        restoreToBase: { restoredStar: 0, mesoCost: '30', equipmentCount: 2 },
        fullRestoreBands: [
          {
            minimumLevel: 1,
            maximumLevel: 250,
            minimumTraceStar: 1,
            maximumTraceStar: 1,
            mesoCost: '100',
            equipmentCount: 3,
          },
        ],
      },
      events: [
        {
          id: 'shiningWithout1516',
          attemptCostMultiplier: 0.7,
          destroyProbabilityMultiplier: 0.7,
          maximumDestroyReductionStarInclusive: 21,
          fullRestoreCostMultiplier: 0.8,
          guaranteedSuccessStars: [],
        },
      ],
    },
    config: {
      level: 200,
      startStars: 0,
      targetStars: 2,
      safeguard: false,
      restoration: 'trace12',
      replacementPrice: 10,
      equipmentType: 'normal',
    },
  };
}
function harness(random: () => number, options: { maxActions?: number; now?: () => number } = {}) {
  const messages: StarforceRunResponse[] = [];
  const queued = new Map<number, () => void>();
  let next = 0;
  const runner = createStarforceRunner((message) => messages.push(structuredClone(message)), {
    random,
    now: () => 0,
    ...options,
    schedule: (callback) => {
      const id = ++next;
      queued.set(id, callback);
      return id;
    },
    cancel: (handle) => {
      queued.delete(handle as number);
    },
  });
  return {
    runner,
    messages,
    queued,
    tick() {
      const entry = queued.entries().next().value;
      if (entry) {
        queued.delete(entry[0]);
        entry[1]();
      }
    },
    latest() {
      const last = messages.at(-1)!;
      if (last.type !== 'state') throw new Error('Expected state response');
      return last;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('paced-free Star Force Worker runner', () => {
  it('matches the same manual RNG sequence including destruction, restoration and all charges', () => {
    const { rules, config } = fixture();
    const sequence = [0.6, 0, 0.9, 0, 0.1];
    let manual = createStarforceState(rules, config);
    let manualDraws = 0;
    while (manual.status !== 'success')
      manual =
        manual.status === 'destroyed'
          ? restoreStarforce(rules, config, manual)
          : rollStarforce(rules, config, manual, () => sequence[manualDraws++]).state;
    let draws = 0;
    const h = harness(() => sequence[draws++], { maxActions: 2 });
    h.runner.handle({
      type: 'run',
      id: 'same-path',
      rules,
      config,
      state: createStarforceState(rules, config),
    });
    while (h.queued.size) h.tick();
    expect(h.latest()).toMatchObject({
      id: 'same-path',
      done: true,
      state: {
        status: 'success',
        attempts: 5n,
        destructions: 1n,
        restorations: 1n,
        enhancementMeso: 50n,
        restorationMeso: 30n,
        replacementMeso: 20n,
        spentMeso: 100n,
      },
    });
    expect(h.latest().state).toEqual(manual);
    expect(draws).toBe(manualDraws);
    expect(draws).toBe(5);
    expect(h.messages).toHaveLength(3);
  });

  it('keeps the supplied event and per-stage policy when it restores the first destroyed state', () => {
    const { rules, config: base } = fixture();
    const config: StarforceConfig = {
      ...base,
      event: 'shiningNoGuarantee',
      policy: [
        { stars: 0, safeguard: false, restoration: 'trace12' },
        { stars: 1, safeguard: false, restoration: 'original' },
      ],
    };
    let state = createStarforceState(rules, config);
    state = rollStarforce(rules, config, state, () => 0).state;
    state = rollStarforce(rules, config, state, () => 0.99).state;
    expect(state.status).toBe('destroyed');
    const random = vi.fn(() => 0);
    const h = harness(random, { maxActions: 1 });
    h.runner.handle({ type: 'run', id: 'pending-repair', rules, config, state });
    expect(random).not.toHaveBeenCalled();
    expect(h.latest().state).toMatchObject({
      status: 'ready',
      stars: 1,
      attempts: 2n,
      restorationMeso: 80n,
      replacementMeso: 30n,
      spentMeso: 124n,
    });
    h.tick();
    expect(random).toHaveBeenCalledTimes(1);
    expect(h.latest()).toMatchObject({
      done: true,
      state: { status: 'success', attempts: 3n, spentMeso: 131n },
    });
  });

  it('acknowledges stop with the exact latest state, cancels even a stale queued callback and resumes with a new ID', () => {
    const { rules, config } = fixture();
    const h = harness(() => 0.9, { maxActions: 1 });
    h.runner.handle({
      type: 'run',
      id: 'paused',
      rules,
      config,
      state: createStarforceState(rules, config),
    });
    const paid = h.latest().state;
    const stale = h.queued.values().next().value!;
    h.runner.handle({ type: 'stop', id: 'paused' });
    expect(h.latest()).toEqual({ type: 'state', id: 'paused', state: paid, done: true });
    expect(h.queued.size).toBe(0);
    const count = h.messages.length;
    stale();
    expect(h.messages).toHaveLength(count);
    h.runner.handle({ type: 'run', id: 'resumed', rules, config, state: paid });
    expect(h.latest().state.attempts).toBe(2n);
    expect(h.latest().state.spentMeso).toBe(20n);
    h.runner.handle({ type: 'stop', id: 'paused' });
    expect(h.latest().state).toEqual(paid);
    expect(h.queued.size).toBe(1);
    h.tick();
    expect(h.latest()).toMatchObject({ id: 'resumed', done: false, state: { attempts: 3n } });
    h.runner.dispose();
    expect(h.queued.size).toBe(0);
  });

  it('can stop at a destroyed boundary without charging restoration or losing its pending quote', () => {
    const { rules, config } = fixture();
    const state = rollStarforce(rules, config, createStarforceState(rules, config), () => 0).state;
    const h = harness(() => 0.99, { maxActions: 1 });
    h.runner.handle({ type: 'run', id: 'broken-stop', rules, config, state });
    expect(h.latest().state.status).toBe('destroyed');
    h.runner.handle({ type: 'stop', id: 'broken-stop' });
    const stopped = h.latest().state;
    expect(stopped).toMatchObject({
      attempts: 2n,
      restorations: 0n,
      spentMeso: 20n,
      pendingRestoration: { totalCost: 50n },
    });
    h.runner.handle({ type: 'run', id: 'repair-resume', rules, config, state: stopped });
    expect(h.latest().state).toMatchObject({
      attempts: 2n,
      restorations: 1n,
      spentMeso: 70n,
      stars: 0,
    });
    h.runner.dispose();
  });

  it('bounds each chunk by actions or elapsed time and keeps only 100 history records', () => {
    const { rules, config } = fixture();
    const initial = createStarforceState(rules, config);
    initial.enhancementMeso = 1000000000000000000n;
    initial.spentMeso = initial.enhancementMeso;
    const h = harness(() => 0.9);
    h.runner.handle({ type: 'run', id: 'action-budget', rules, config, state: initial });
    expect(h.latest().state.attempts).toBe(1000n);
    expect(h.latest().state.spentMeso).toBe(1000000000000010000n);
    expect(h.latest().state.history).toHaveLength(100);
    expect(h.latest().state.history[0].sequence).toBe(901n);
    expect(h.queued.size).toBe(1);
    h.runner.dispose();
    let elapsed = 0;
    const timed = harness(() => 0.9, { now: () => (elapsed += 11) });
    timed.runner.handle({ type: 'run', id: 'time-budget', rules, config, state: initial });
    expect(timed.latest().state.attempts).toBe(2n);
    expect(timed.queued.size).toBe(1);
    timed.runner.dispose();
  });

  it('finishes the first chunk immediately and acknowledges a stop that races completion without another charge', () => {
    const { rules, config } = fixture();
    const random = vi.fn(() => 0);
    const h = harness(random);
    h.runner.handle({
      type: 'run',
      id: 'won',
      rules,
      config,
      state: createStarforceState(rules, config),
    });
    expect(h.latest()).toMatchObject({ done: true, state: { status: 'success', attempts: 2n } });
    expect(h.queued.size).toBe(0);
    const completed = h.latest().state;
    h.runner.handle({ type: 'stop', id: 'won' });
    expect(h.latest().state).toEqual(completed);
    h.runner.handle({
      type: 'run',
      id: 'won',
      rules,
      config,
      state: createStarforceState(rules, config),
    });
    expect(h.latest().state).toEqual(completed);
    h.runner.handle({ type: 'run', id: 'already', rules, config, state: completed });
    expect(h.latest()).toMatchObject({ id: 'already', done: true, state: completed });
    expect(random).toHaveBeenCalledTimes(2);
  });

  it('sends the last paid state on errors and finalizes an old run before starting another', () => {
    const { rules, config } = fixture();
    let draws = 0;
    const h = harness(() => (draws++ === 0 ? 0.9 : NaN));
    h.runner.handle({
      type: 'run',
      id: 'error',
      rules,
      config,
      state: createStarforceState(rules, config),
    });
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({
      type: 'error',
      id: 'error',
      state: { attempts: 1n, spentMeso: 10n },
    });
    expect(h.queued.size).toBe(0);
    h.runner.handle({ type: 'stop', id: 'error' });
    expect(h.latest()).toMatchObject({ done: true, state: { attempts: 1n } });
    const swap = harness(() => 0.9, { maxActions: 1 });
    const initial = createStarforceState(rules, config);
    swap.runner.handle({ type: 'run', id: 'old', rules, config, state: initial });
    swap.runner.handle({ type: 'run', id: 'new', rules, config, state: initial });
    expect(swap.messages).toMatchObject([
      { id: 'old', done: false },
      { id: 'old', done: true },
      { id: 'new', done: false },
    ]);
    expect(swap.queued.size).toBe(1);
    swap.runner.dispose();
  });

  it('the separate Worker entrypoint forwards BigInt states and stop acknowledgements through the real controller', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const { rules, config } = fixture();
    const messages: StarforceRunResponse[] = [];
    const worker = {
      postMessage: (message: StarforceRunResponse) => messages.push(structuredClone(message)),
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    };
    vi.stubGlobal('self', worker);
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint32Array) => array.fill(0xffffffff) });
    vi.spyOn(performance, 'now').mockReturnValue(0);
    await import('../src/workers/starforce-run.worker');
    worker.onmessage!({
      data: {
        type: 'run',
        id: 'worker',
        rules,
        config,
        state: createStarforceState(rules, config),
      },
    } as MessageEvent);
    expect(messages[0]).toMatchObject({
      type: 'state',
      id: 'worker',
      done: false,
      state: { attempts: 1000n },
    });
    worker.onmessage!({ data: { type: 'stop', id: 'worker' } } as MessageEvent);
    await vi.runAllTimersAsync();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      type: 'state',
      id: 'worker',
      done: true,
      state: { attempts: 1000n, spentMeso: 10000n },
    });
  });
});
