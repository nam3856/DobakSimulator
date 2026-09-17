import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SimulationConfig } from '../src/types';
import {
  analyzeOutcomes,
  computeBenchmark,
  createState,
  rollBatch,
  seededRandom,
  validateConfig,
  type RuleData,
} from '../src/engine';
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../public/rules/${name}.json`, import.meta.url), 'utf8'));
const data: RuleData = {
  potential: read('potential'),
  additional: read('additional-potential'),
  gold: read('gold'),
  ability: read('ability'),
  soul: read('soul'),
};
const cfg = (): SimulationConfig => ({
  mode: 'cube',
  cubeType: 'black',
  category: 'weapon',
  level: 200,
  start: { grade: 'legendary', lines: [], stage: 4, failures: 0 },
  lockedSlots: [],
  batchSize: 1,
  target: {
    mode: 'sum',
    minimumGrade: 'legendary',
    conditions: [{ type: 'attackPercent', minValue: 33 }],
    lines: [],
    stage: 4,
    match: 'all',
  },
  ruleVersion: 'official',
  unitPrices: {},
});
const freeze = (config: SimulationConfig) => {
  config.start.lines = createState(data, config, seededRandom('official-initial')).lines;
  return config;
};

describe('official rule integration and rare-target performance', () => {
  it('guarantees the reset after the published main/additional failure threshold', () => {
    for (const [cubeType, rules, thresholds] of [
      ['black', data.potential, [10, 42, 107]],
      ['additional', data.additional, [62, 152, 214]],
    ] as const) {
      for (const [index, failures] of thresholds.entries()) {
        const grade = rules.grades[index].grade;
        expect(rules.grades[index].guaranteedAfterFailures).toBe(failures);
        expect(rules.grades[index].pityThreshold).toBe(failures + 1);
        const config = cfg();
        config.cubeType = cubeType;
        config.start.grade = grade;
        config.start.failures = failures - 1;
        config.target.mode = 'grade';
        config.target.minimumGrade = rules.grades[index + 1].grade;
        freeze(config);
        const rng = seededRandom(`threshold-${cubeType}-${grade}`);
        let calls = 0;
        const lastFailure = rollBatch(data, config, createState(data, config), () =>
          calls++ === 0 ? 0.999999 : rng(),
        );
        expect(lastFailure.grade).toBe(grade);
        expect(lastFailure.failures).toBe(failures);
        config.start.failures = failures;
        expect(validateConfig(data, config)).toEqual([]);
        const guaranteed = rollBatch(data, config, lastFailure, seededRandom('guaranteed'));
        expect(guaranteed.grade).toBe(rules.grades[index + 1].grade);
        expect(guaranteed.failures).toBe(0);
        const benchmark = computeBenchmark(data, config, undefined, { sampleCount: 1000 });
        expect(benchmark.expectedAttempts).toBe(1);
      }
    }
  });
  it('calculates the full 0→4 amplification mean and bounded exact CDF', () => {
    const config = cfg();
    config.mode = 'soulAmplification';
    config.start.stage = 0;
    config.target.mode = 'stage';
    config.target.stage = 4;
    const result = computeBenchmark(data, config);
    expect(result.expectedCost).toBeCloseTo(98004135592.14827, 3);
    expect(result.method).toBe('analytic');
    expect(result.distribution.at(-1)).toEqual({ cost: 264250000000, cdf: 1 });
  });
  it('computes a very rare three-legendary soul-power target without iterating paid rolls', () => {
    const config = cfg();
    config.mode = 'soulPotential';
    config.target.conditions[0].minValue = 24;
    freeze(config);
    const result = computeBenchmark(data, config);
    expect(result.expectedAttempts).toBeGreaterThan(100000000);
    expect(result.expectedCost).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(result.status).toBe('ready');
    expect(result.method).toBe('analytic');
    expect(result.distribution.every((p) => Number.isFinite(p.cost))).toBe(true);
  });
  it('calculates rare-grade soul progression with the full 500,000 inverse-CDF samples', () => {
    const config = cfg();
    config.mode = 'soulPotential';
    config.start.grade = 'rare';
    config.target.conditions[0].minValue = 20;
    freeze(config);
    const result = computeBenchmark(data, config);
    expect(result.status).toBe('ready');
    expect(result.sampleCount).toBe(500000);
    expect(result.expectedCost).toBeGreaterThan(0);
    expect(result.quantiles.p90).toBeGreaterThan(result.quantiles.p50);
    expect(
      result.distribution.every(
        (p, i, a) => i === 0 || (p.cost >= a[i - 1].cost && p.cdf >= a[i - 1].cdf),
      ),
    ).toBe(true);
  });
  it('supports all three advanced legendary ability targets with full option weights', () => {
    const config = cfg();
    config.mode = 'ability';
    config.target.mode = 'ability';
    config.target.conditions = [
      { type: 'bossDamagePercent', minValue: 20, minGrade: 'legendary' },
      { type: 'buffDurationPercent', minValue: 50, minGrade: 'legendary' },
      { type: 'criticalRatePercent', minValue: 30, minGrade: 'legendary' },
    ];
    freeze(config);
    const result = computeBenchmark(data, config);
    expect(result.status).toBe('ready');
    expect(result.expectedAttempts).toBeGreaterThan(1000000);
    expect(result.method).toBe('analytic');
  });
  it('keeps real legendary gold attempts in item units and preserves unsuccessful outcomes', () => {
    const config = cfg();
    config.cubeType = 'gold';
    freeze(config);
    const benchmark = computeBenchmark(data, config);
    const state = createState(data, config);
    const next = rollBatch(data, config, state, seededRandom('gold-result'));
    expect(benchmark.unit).toBe('cubes');
    expect(next.spent.cubes).toBe(1n);
    expect(next.spent.meso).toBe(0n);
    if (!next.candidates[0].hit) expect(next.lines).toEqual(state.lines);
  });
  it('assigns zero probability to impossible three useful-skill lines', () => {
    const config = cfg();
    config.category = 'gloves';
    config.target.mode = 'exact';
    const pool = data.potential.optionPools.find(
      (p) =>
        p.grade === 'legendary' &&
        p.categories.includes('gloves') &&
        200 >= p.minimumLevel &&
        200 <= p.maximumLevel,
    )!;
    const skill = pool.options.find((o) => o.maxLines === 1)!;
    expect(skill).toBeDefined();
    const line = {
      id: skill.id,
      type: skill.type,
      value: skill.value,
      unit: skill.unit,
      text: skill.displayText!,
      grade: 'legendary' as const,
    };
    config.target.lines = [line, line, line];
    freeze(config);
    expect(analyzeOutcomes(data, config, 'legendary', false).targetProbability).toBe(0);
  });
});
