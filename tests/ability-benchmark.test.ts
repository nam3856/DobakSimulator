import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OptionLine, RollResult, SimulationConfig } from '../src/types';
import { makeAbilityPresetGoal } from '../src/character/ability-presets';
import { abilityProgress, pickAbilityCandidate } from '../src/engine/ability-strategy';
import { computeBenchmark } from '../src/engine/benchmark';
import { seededRandom } from '../src/engine/math';
import {
  allCandidates,
  eligibleCandidates,
  tupleIdentity,
  type RuleData,
} from '../src/engine/rules';
import {
  attemptCost,
  createState,
  emptyCost,
  prepareDraw,
  rollBatch,
} from '../src/engine/simulation';
import { matchTarget } from '../src/engine/target';

function fixture(values = false): { data: RuleData; config: SimulationConfig } {
  const unused = { ruleId: 'unused', grades: [], optionPools: [], costBands: [] };
  const data: RuleData = {
    potential: unused,
    additional: unused,
    gold: unused,
    soul: {
      ruleId: 'unused',
      version: 'test',
      amplificationStages: [],
      potentialGrades: [],
      potentialResetCosts: { rare: '0', epic: '0', unique: '0', legendary: '0' },
      optionStages: [],
    },
    ability: {
      ruleId: 'ability-benchmark',
      version: 'test',
      sourceUrl: 'test',
      advancedLineGrades: [{ legendary: 1 }, { legendary: 1 }, { legendary: 1 }],
      grades: {
        legendary: {
          options: ['a', 'b', 'c', 'd'].map((id, index) => ({
            id,
            label: id,
            weight: index + 1,
            values: (values ? [1, 2] : [1]).map((value) => ({
              value,
              label: `${id} ${value}`,
              weight: value === 1 ? 1 : index + 2,
            })),
          })),
        },
      },
      costs: [
        { locked: 0, honor: 20, meso: '2' },
        { locked: 1, honor: 30, meso: '6' },
        { locked: 2, honor: 40, meso: '15' },
      ],
    },
  };
  const config: SimulationConfig = {
    mode: 'ability',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'legendary', lines: [], stage: 0, failures: 0 },
    lockedSlots: [],
    abilityStrategy: 'lowerFirst',
    batchSize: 1,
    target: {
      mode: 'ability',
      minimumGrade: 'legendary',
      match: 'all',
      stage: 0,
      lines: [],
      conditions: [
        { type: 'a', minValue: values ? 2 : 1, slot: 0, minGrade: 'legendary' },
        { type: 'b', minValue: values ? 2 : 1, slots: [1, 2], minGrade: 'legendary' },
        { type: 'c', minValue: 1, slots: [1, 2], minGrade: 'legendary' },
      ],
    },
    ruleVersion: 'test',
    unitPrices: {},
  };
  config.start.lines = ['b', 'a', 'd'].map(
    (type, slot) =>
      allCandidates(data, config, 'legendary', slot).find((row) => row.line.type === type)!.line,
  );
  return { data, config };
}

/** Independent small-state solution: enumerate every actual batch, including tie order. */
function fullStateMean(
  data: RuleData,
  config: SimulationConfig,
): { cost: number; attempts: number } {
  const cache = new Map<string, { cost: number; attempts: number }>();
  function solve(lines: OptionLine[]): { cost: number; attempts: number } {
    if (matchTarget(config.target, { grade: 'legendary', lines, stage: 0 }))
      return { cost: 0, attempts: 0 };
    const identity = tupleIdentity(lines);
    const stateKey = `${identity}:${lines.map((line) => line.grade).join(',')}`;
    const cached = cache.get(stateKey);
    if (cached) return cached;
    const lockedSlots = abilityProgress(config, lines).lockedSlots;
    const current = { ...config, lockedSlots };
    const prepared = prepareDraw(data, current, 'legendary', lines);
    const slots = [0, 1, 2].filter((slot) => !prepared.fixed.has(slot));
    const prefix = [...prepared.fixed.values()];
    const chosen = [...lines];
    const outcomes: { result: RollResult; probability: number }[] = [];
    function visit(depth: number, probability: number) {
      if (depth === slots.length) {
        if (tupleIdentity(chosen) !== identity)
          outcomes.push({
            probability,
            result: {
              sequence: 0n,
              grade: 'legendary',
              lines: [...chosen],
              stage: 0,
              promoted: false,
              amplified: false,
              hit: matchTarget(config.target, { grade: 'legendary', lines: chosen, stage: 0 }),
              cost: emptyCost(),
            },
          });
        return;
      }
      const slot = slots[depth];
      for (const row of eligibleCandidates(prepared.candidates[slot], prefix)) {
        chosen[slot] = row.line;
        prefix.push(row);
        visit(depth + 1, probability * row.probability);
        prefix.pop();
      }
    }
    visit(0, 1);
    const total = outcomes.reduce((sum, row) => sum + row.probability, 0);
    const batch: RollResult[] = [];
    let leave = 0,
      cost = 0,
      attempts = 0;
    function compare(depth: number, probability: number) {
      if (depth === config.batchSize) {
        const selected = pickAbilityCandidate(config, lines, batch);
        if (!selected) return;
        leave += probability;
        const future = selected.hit ? { cost: 0, attempts: 0 } : solve(selected.lines);
        cost += probability * future.cost;
        attempts += probability * future.attempts;
        return;
      }
      for (const outcome of outcomes) {
        batch.push(outcome.result);
        compare(depth + 1, (probability * outcome.probability) / total);
        batch.pop();
      }
    }
    compare(0, 1);
    const result = {
      cost:
        (config.batchSize * Number(attemptCost(data, current, 'legendary', 0).meso) + cost) / leave,
      attempts: (config.batchSize + attempts) / leave,
    };
    cache.set(stateKey, result);
    return result;
  }
  return solve(config.start.lines);
}

describe('lower-first ability expected cost', () => {
  it.each([1, 3] as const)(
    'matches complete ordered finite-state enumeration for batch size %i',
    (batchSize) => {
      const { data, config } = fixture();
      config.batchSize = batchSize;
      const exact = fullStateMean(data, config);
      const result = computeBenchmark(data, config, 35, {
        sampleCount: 3000,
        seed: 'ordered-batches',
      });
      expect(result.status).toBe('ready');
      expect(result.expectedCost).toBeCloseTo(exact.cost, 9);
      expect(result.expectedAttempts).toBeCloseTo(exact.attempts, 9);
      expect(result.successProbability).toBeCloseTo(1, 12);
    },
  );

  it('preserves different acquired values and baseline exclusion in its analytic mean', () => {
    const { data, config } = fixture(true);
    const exact = fullStateMean(data, config);
    const result = computeBenchmark(data, config, 60, { sampleCount: 3000 });
    expect(result.expectedCost).toBeCloseTo(exact.cost, 9);
    expect(result.expectedAttempts).toBeCloseTo(exact.attempts, 9);
  });

  it('uses already acquired lower lines and handles free completion or impossible lower targets', () => {
    const { data, config } = fixture();
    const rows = allCandidates(data, config, 'legendary', 0);
    config.start.lines = ['d', 'c', 'b'].map(
      (type) => rows.find((row) => row.line.type === type)!.line,
    );
    const result = computeBenchmark(data, config, 15, { sampleCount: 1000 });
    // Only a/d remain; rejecting the retained d guarantees a on this reduced table.
    expect(result.expectedCost).toBeCloseTo(15, 10);
    expect(result.expectedAttempts).toBeCloseTo(1, 10);
    expect(result.cdfAtActual).toBe(1);
    config.start.lines[0] = rows.find((row) => row.line.type === 'a')!.line;
    expect(computeBenchmark(data, config).status).toBe('already');
    config.target.conditions[1].type = 'unavailable';
    expect(computeBenchmark(data, config, undefined, { sampleCount: 1000 }).status).toBe(
      'impossible',
    );
  });

  it('matches actual draws and gives repeatable inverse-CDF distributions after cache reuse', () => {
    const { data, config } = fixture(true);
    const options = { sampleCount: 20000, seed: 'lower-first-distribution' };
    const result = computeBenchmark(data, config, 60, options);
    const again = computeBenchmark(data, config, 60, options);
    expect(result).toEqual(again);
    expect(computeBenchmark(data, config, 0, options).cdfAtActual).toBe(0);
    const rng = seededRandom('actual-lower-first');
    let cost = 0,
      hits = 0;
    for (let n = 0; n < 5000; n++) {
      let state = createState(data, config, rng);
      while (state.status !== 'success') state = rollBatch(data, config, state, rng);
      cost += Number(state.spent.meso);
      if (state.spent.meso <= 60n) hits++;
    }
    expect(cost / 5000 / result.expectedCost).toBeGreaterThan(0.96);
    expect(cost / 5000 / result.expectedCost).toBeLessThan(1.04);
    expect(Math.abs(hits / 5000 - result.cdfAtActual!)).toBeLessThan(0.025);
  });

  it('rejects grade-sensitive display collisions and preserves grade-agnostic exclusion', () => {
    const { data, config } = fixture();
    data.ability.grades.unique = structuredClone(data.ability.grades.legendary!);
    data.ability.advancedLineGrades = [
      { legendary: 1 },
      { unique: 0.8, legendary: 0.2 },
      { unique: 0.8, legendary: 0.2 },
    ];
    expect(() => computeBenchmark(data, config)).toThrow('같은 표시 옵션');
    for (const condition of config.target.conditions) delete condition.minGrade;
    const exact = fullStateMean(data, config);
    const result = computeBenchmark(data, config, undefined, { sampleCount: 500 });
    expect(result.expectedCost).toBeCloseTo(exact.cost, 8);
    expect(result.expectedAttempts).toBeCloseTo(exact.attempts, 8);
  });

  it('reports infinite unconditional cost when a custom automatic lock can block the first target', () => {
    const { data, config } = fixture();
    for (const option of data.ability.grades.legendary!.options)
      if (option.id === 'a' || option.id === 'c') option.type = 'flex';
    config.target.conditions[2].type = 'flex';
    config.start.lines = ['b', 'd', 'a'].map(
      (id, slot) =>
        allCandidates(data, config, 'legendary', slot).find((row) => row.line.abilityTypeId === id)!
          .line,
    );
    // Start without a free matching secondary: the custom first target can itself be locked.
    config.start.lines = [
      config.start.lines[2],
      config.start.lines[1],
      { ...config.start.lines[0], value: 0, text: 'imported lower value' },
    ];
    const result = computeBenchmark(data, config, 100, { sampleCount: 1000 });
    expect(result.status).toBe('partial');
    expect(result.successProbability).toBeGreaterThan(0);
    expect(result.successProbability).toBeLessThan(1);
    expect(result.expectedCost).toBe(Infinity);
  });

  it('evaluates official legendary maximum presets with 500,000 samples without replaying rare failures', () => {
    const { data, config } = fixture();
    data.ability = JSON.parse(
      readFileSync(new URL('../public/rules/ability.json', import.meta.url), 'utf8'),
    );
    config.target = makeAbilityPresetGoal(data, '나이트로드');
    config.start.lines = [0, 1, 2].map(
      (slot) =>
        allCandidates(data, config, 'legendary', slot).find(
          (row) => row.line.type === ['strFlat', 'dexFlat', 'intFlat'][slot],
        )!.line,
    );
    const started = performance.now();
    const result = computeBenchmark(data, config);
    expect(result.status).toBe('ready');
    expect(result.sampleCount).toBe(500000);
    expect(result.expectedCost).toBeGreaterThan(1e9);
    expect(result.expectedAttempts).toBeGreaterThan(1000);
    expect(result.quantiles.p10).toBeLessThan(result.quantiles.p50);
    expect(result.quantiles.p50).toBeLessThan(result.quantiles.p90);
    expect(performance.now() - started).toBeLessThan(15000);
  }, 20000);
});
