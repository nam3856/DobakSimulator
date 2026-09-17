import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterSnapshot, ResourceCost, SimulationConfig } from '../src/types';
import type { RuleData } from '../src/engine/rules';
import { computeBenchmark } from '../src/engine/benchmark';
import { createState, rollBatch } from '../src/engine/simulation';
import {
  DEFAULT_ETHER_PRICES,
  etherMarketValue,
  paidBenchmarkCost,
  withDefaultEtherPrices,
} from '../src/engine/soul-cost';
import { makeConfig } from '../src/ui/setup';
import { readSession, saveSession, type StoredSession } from '../src/ui/storage';

const character = JSON.parse(
  readFileSync(new URL('../public/character/snapshot.json', import.meta.url), 'utf8'),
) as CharacterSnapshot;
const empty = { ruleId: 'unused', grades: [], optionPools: [], costBands: [] };
const rules: RuleData = {
  potential: empty,
  additional: empty,
  gold: empty,
  ability: {
    ruleId: 'unused',
    version: 'test',
    sourceUrl: '',
    grades: {},
    advancedLineGrades: [],
    costs: [],
  },
  soul: {
    ruleId: 'two-stage-cost-model',
    version: 'test',
    amplificationStages: [
      {
        stage: 1,
        initialSuccessProbability: 0.5,
        successProbabilityIncreasePerFailure: 0.25,
        guaranteedAfterFailures: 1,
        systemCostPerAttempt: '5',
      },
      {
        stage: 2,
        initialSuccessProbability: 0.25,
        successProbabilityIncreasePerFailure: 0.25,
        guaranteedAfterFailures: 2,
        systemCostPerAttempt: '10',
      },
    ],
    potentialGrades: [],
    potentialResetCosts: { rare: '0', epic: '0', unique: '0', legendary: '0' },
    optionStages: [],
  },
};
function config(prices: Record<string, string> = { ether1: '7', ether2: '8' }): SimulationConfig {
  return {
    mode: 'soulAmplification',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'rare', lines: [], stage: 0, failures: 0 },
    lockedSlots: [],
    batchSize: 1,
    target: {
      mode: 'stage',
      minimumGrade: 'rare',
      conditions: [],
      lines: [],
      stage: 2,
      match: 'all',
    },
    unitPrices: prices,
    ruleVersion: rules.soul.ruleId,
  };
}

// Independent ordered full paths: first stage is 1/2, second stage is 1/4 then1/2 then guaranteed.
function enumerate(firstCost: number, secondCost: number) {
  const masses = new Map<number, number>();
  for (const [firstAttempts, firstMass] of [
    [1, 0.5],
    [2, 0.5],
  ])
    for (const [secondAttempts, secondMass] of [
      [1, 0.25],
      [2, 0.375],
      [3, 0.375],
    ]) {
      const cost = firstAttempts * firstCost + secondAttempts * secondCost;
      masses.set(cost, (masses.get(cost) ?? 0) + firstMass * secondMass);
    }
  let cdf = 0;
  return [...masses]
    .sort(([a], [b]) => a - b)
    .map(([cost, mass]) => ({ cost, mass, cdf: (cdf += mass) }));
}
afterEach(() => vi.unstubAllGlobals());

describe('soul amplification ether market costs', () => {
  it('starts with the four requested prices without changing other simulators', () => {
    expect(DEFAULT_ETHER_PRICES).toEqual({
      ether1: '1500000000',
      ether2: '2000000000',
      ether3: '1200000000',
      ether4: '4000000000',
    });
    expect(
      makeConfig(rules, character, undefined, 'soulAmplification', 'black', '1').unitPrices,
    ).toEqual(DEFAULT_ETHER_PRICES);
    const old = { ether1: '0', ether2: '99', ether3: ' ', gold: '123' };
    expect(withDefaultEtherPrices(old)).toEqual({
      ...DEFAULT_ETHER_PRICES,
      ether1: '0',
      ether2: '99',
      gold: '123',
    });
    expect(old).toEqual({ ether1: '0', ether2: '99', ether3: ' ', gold: '123' });
  });

  it('migrates old blank prices while preserving explicit zero, custom prices and all paid progress', () => {
    const cfg = config({ ether1: '0', ether2: '123', ether3: '', gold: '88' });
    const state = rollBatch(rules, cfg, createState(rules, cfg), () => 0.9);
    const session: StoredSession = {
      version: 1,
      character,
      config: cfg,
      state,
      equipmentPreset: '1',
      abilityPreset: '1',
      equipmentId: '',
      playMode: 'upgrade',
    };
    let saved: string | null = null;
    vi.stubGlobal('localStorage', {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    });
    expect(saveSession(session)).toBe(true);
    const restored = readSession()!;
    expect(restored.config.unitPrices).toEqual({
      ...DEFAULT_ETHER_PRICES,
      ether1: '0',
      ether2: '123',
      gold: '88',
    });
    expect(restored.state).toEqual(state);
    expect(restored.config.start).toEqual(cfg.start);
    expect(restored.config.target).toEqual(cfg.target);
    expect(saveSession(restored)).toBe(true);
    expect(readSession()).toEqual(restored);
  });

  it('values actual ethers by stage with BigInt and leaves every raw cost and attempt unchanged', () => {
    const cfg = config({ ether1: '900719925474099312345', ether2: '3' });
    let state = createState(rules, cfg);
    for (const random of [0.9, 0, 0]) state = rollBatch(rules, cfg, state, () => random);
    expect(state.status).toBe('success');
    expect(state.attempts).toBe(3n);
    expect(state.spent.meso).toBe(20n);
    expect(state.spent.ethers).toEqual([2n, 1n, 0n, 0n]);
    const before = structuredClone(state);
    expect(etherMarketValue(cfg, state.spent)).toBe(2n * 900719925474099312345n + 3n);
    expect(paidBenchmarkCost(cfg, state.spent)).toBe(2n * 900719925474099312345n + 23n);
    expect(
      paidBenchmarkCost({ ...cfg, unitPrices: { ether1: '0', ether2: '3' } }, state.spent),
    ).toBe(23n);
    expect(state).toEqual(before);
    const cost: ResourceCost = { ...state.spent, cubes: 7n };
    expect(paidBenchmarkCost({ ...cfg, mode: 'cube', cubeType: 'gold' }, cost)).toBe(7n);
    expect(paidBenchmarkCost({ ...cfg, mode: 'soulPotential' }, cost)).toBe(20n);
  });

  it('matches independently enumerated total-cost mean, quantiles and every inclusive CDF boundary', () => {
    const cfg = config();
    const paths = enumerate(12, 18);
    const result = computeBenchmark(rules, cfg);
    expect(result.method).toBe('analytic');
    expect(result.sampleCount).toBe(0);
    expect(result.expectedAttempts).toBe(3.625);
    expect(result.expectedCost).toBe(paths.reduce((sum, row) => sum + row.cost * row.mass, 0));
    expect(result.expectedCost).toBe(56.25);
    expect(result.distribution).toEqual(paths.map(({ cost, cdf }) => ({ cost, cdf })));
    expect(result.quantiles).toEqual({ p10: 30, p50: 60, p90: 78 });
    for (const row of paths) {
      expect(computeBenchmark(rules, cfg, row.cost).cdfAtActual).toBe(row.cdf);
      expect(computeBenchmark(rules, cfg, row.cost - 1).cdfAtActual).toBe(row.cdf - row.mass);
    }
  });

  it('uses only remaining stage attempts and their proper ether price after saved failures', () => {
    const cfg = config();
    cfg.start.stage = 1;
    cfg.start.failures = 1;
    const result = computeBenchmark(rules, cfg, 18);
    expect(result.expectedAttempts).toBe(1.5);
    expect(result.expectedCost).toBe(27);
    expect(result.distribution).toEqual([
      { cost: 18, cdf: 0.5 },
      { cost: 36, cdf: 1 },
    ]);
    expect(result.cdfAtActual).toBe(0.5);
  });

  it('uses bounded reproducible inverse-CDF sampling for incommensurate prices, with an exact mean', () => {
    const cfg = config({ ether1: '1000000002', ether2: '1000000023' });
    const paths = enumerate(1_000_000_007, 1_000_000_033);
    const actual = paths[3].cost;
    const options = { sampleCount: 32768, seed: 'independent-soul-price-distribution' };
    const result = computeBenchmark(rules, cfg, actual, options);
    expect(result).toEqual(computeBenchmark(rules, cfg, actual, options));
    expect(result.method).toBe('sampled');
    expect(result.sampleCount).toBe(32768);
    expect(result.distribution.length).toBeLessThanOrEqual(101);
    expect(result.expectedCost).toBe(paths.reduce((sum, row) => sum + row.cost * row.mass, 0));
    expect(result.expectedAttempts).toBe(3.625);
    expect(Math.abs(result.cdfAtActual! - paths[3].cdf)).toBeLessThan(0.02);
    const costs = new Set(paths.map((row) => row.cost));
    for (const point of result.distribution) expect(costs.has(point.cost)).toBe(true);
    expect(result.distribution.at(-1)?.cdf).toBe(1);
    expect(result.note).toContain('평균은 해석값');
  });

  it('preserves the meso-only benchmark when every ether price is explicitly zero', () => {
    const zero = config({ ether1: '0', ether2: '0', ether3: '0', ether4: '0' });
    expect(computeBenchmark(rules, zero)).toEqual(computeBenchmark(rules, config({})));
    expect(computeBenchmark(rules, zero).expectedCost).toBe(1.5 * 5 + 2.125 * 10);
  });
});
