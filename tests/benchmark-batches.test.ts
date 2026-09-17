import { describe, expect, it } from 'vitest';
import type { Grade, OptionLine, SimulationConfig } from '../src/types';
import { computeBenchmark } from '../src/engine/benchmark';
import { seededRandom } from '../src/engine/math';
import type { PotentialRules, RuleData } from '../src/engine/rules';
import { createState, rollBatch } from '../src/engine/simulation';

function option(type: string, grade: Grade): OptionLine {
  return { id: type, type, value: 1, unit: 'flat', text: `${type} +1`, grade };
}
function fixture(mode: 'cube' | 'soulPotential' = 'cube') {
  const grades: Grade[] = ['rare', 'epic', 'unique', 'legendary'];
  const potential: PotentialRules = {
    ruleId: 'automatic-legendary-comparisons',
    grades: grades.map((grade, index) => ({
      grade,
      rank: index + 1,
      gradeUpChance: 0,
      pityThreshold: grade === 'legendary' ? null : 3,
      lineGrades: [1, 2, 3].map((slot) => ({ slot, chances: [{ grade, probability: 1 }] })),
    })),
    optionPools: grades.map((grade) => ({
      grade,
      minimumLevel: 1,
      maximumLevel: 300,
      categories: [],
      options: ['a', 'b'].map((type) => ({
        id: type,
        type,
        value: 1,
        unit: 'flat' as const,
        probability: 0.5,
        displayText: `${type} +1`,
      })),
    })),
    costBands: [
      {
        minimumLevel: 1,
        maximumLevel: 300,
        resetCosts: { rare: '10', epic: '20', unique: '30', legendary: '40' },
      },
    ],
  };
  const data: RuleData = {
    potential,
    additional: potential,
    gold: potential,
    ability: {
      ruleId: 'unused',
      version: 'test',
      sourceUrl: 'test',
      grades: {},
      advancedLineGrades: [],
      costs: [],
    },
    soul: {
      ruleId: 'automatic-legendary-soul-comparisons',
      version: 'test',
      amplificationStages: [],
      potentialGrades: potential.grades,
      potentialResetCosts: potential.costBands[0].resetCosts,
      optionStages: [{ stage: 1, optionPools: potential.optionPools }],
    },
  };
  const config: SimulationConfig = {
    mode,
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: {
      grade: 'unique',
      lines: [0, 1, 2].map(() => option('b', 'unique')),
      stage: 1,
      failures: 2,
    },
    lockedSlots: [],
    batchSize: 3,
    target: {
      mode: 'sum',
      minimumGrade: 'legendary',
      conditions: [{ type: 'a', minValue: 3 }],
      lines: [],
      stage: 1,
      match: 'all',
    },
    ruleVersion: 'automatic-comparisons-test',
    unitPrices: {},
  };
  return { data, config };
}

describe('automatic legendary comparisons benchmark', () => {
  it.each(['cube', 'soulPotential'] as const)(
    'charges a single promotion then three candidates per legendary comparison for %s',
    (mode) => {
      const { data, config } = fixture(mode);
      const batchP = 1 - (6 / 7) ** 3;
      const result = computeBenchmark(data, config, 150, {
        sampleCount: 20000,
        seed: 'promotion-then-three',
      });
      expect(result.expectedCost).toBeCloseTo(30 + ((7 / 8) * 120) / batchP, 10);
      expect(result.expectedAttempts).toBeCloseTo(1 + ((7 / 8) * 3) / batchP, 10);
      expect(Math.abs(result.cdfAtActual! - (1 / 8 + (7 / 8) * batchP))).toBeLessThan(0.015);
      expect(result.quantiles.p10).toBe(30);
      expect(result.distribution.every(({ cost }) => cost === 30 || (cost - 30) % 120 === 0)).toBe(
        true,
      );

      const promoted = rollBatch(data, config, createState(data, config), () => 0.9);
      expect(promoted.grade).toBe('legendary');
      expect(promoted.attempts).toBe(1n);
      expect(promoted.spent.meso).toBe(30n);
      const completed = rollBatch(data, config, promoted, () => 0.1);
      expect(completed.status).toBe('success');
      expect(completed.attempts).toBe(4n);
      expect(completed.spent.meso).toBe(150n);
      expect(completed.candidates).toHaveLength(3);
    },
  );

  it('stops on a successful pity promotion without charging a legendary comparison', () => {
    const { data, config } = fixture();
    config.target.mode = 'grade';
    const result = computeBenchmark(data, config, 30, { sampleCount: 1000 });
    expect(result.expectedCost).toBe(30);
    expect(result.expectedAttempts).toBe(1);
    expect(result.cdfAtActual).toBe(1);
    const state = rollBatch(data, config, createState(data, config), () => 0.1);
    expect(state.status).toBe('success');
    expect(state.attempts).toBe(1n);
    expect(state.candidates).toHaveLength(1);
  });

  it('keeps lower-grade successes at one candidate and preserves missing pity progress', () => {
    const { data, config } = fixture();
    config.start.failures = 0;
    config.target.minimumGrade = 'unique';
    const result = computeBenchmark(data, config, 30, {
      sampleCount: 12000,
      seed: 'lower-success',
    });
    const rng = seededRandom('real-lower-success');
    let total = 0;
    for (let sample = 0; sample < 4000; sample++) {
      let state = createState(data, config, rng);
      while (state.status !== 'success') state = rollBatch(data, config, state, rng);
      total += Number(state.spent.meso);
    }
    expect(total / 4000 / result.expectedCost).toBeGreaterThan(0.95);
    expect(total / 4000 / result.expectedCost).toBeLessThan(1.05);
    const state = rollBatch(data, config, createState(data, config), () => 0.1);
    expect(state.status).toBe('success');
    expect(state.grade).toBe('unique');
    expect(state.attempts).toBe(1n);
    expect(state.spent.meso).toBe(30n);
  });

  it('uses three independent draws from the frozen baseline for legendary soul potential', () => {
    const { data, config } = fixture('soulPotential');
    config.start = {
      ...config.start,
      grade: 'legendary',
      failures: 0,
      lines: [0, 1, 2].map(() => option('b', 'legendary')),
    };
    const result = computeBenchmark(data, config, 120);
    const batchP = 1 - (6 / 7) ** 3;
    expect(result.method).toBe('analytic');
    expect(result.expectedCost).toBeCloseTo(120 / batchP, 10);
    expect(result.expectedAttempts).toBeCloseTo(3 / batchP, 10);
    expect(result.cdfAtActual).toBeCloseTo(batchP, 12);
    expect(computeBenchmark(data, config, 119).cdfAtActual).toBe(0);
  });

  it('retains impossible and partial outcomes when access can be lost after promotion', () => {
    const { data, config } = fixture();
    config.start.failures = 0;
    config.target.minimumGrade = 'unique';
    const legendary = data.potential.optionPools.find((pool) => pool.grade === 'legendary')!;
    for (const row of legendary.options) {
      row.type = 'unavailable';
      row.displayText = `missing ${row.id}`;
    }
    data.potential.ruleId = 'automatic-comparisons-partial';
    const partial = computeBenchmark(data, config, 100, { sampleCount: 1000 });
    expect(partial.status).toBe('partial');
    expect(partial.expectedCost).toBe(Infinity);
    expect(partial.successProbability).toBeGreaterThan(0);
    expect(partial.successProbability).toBeLessThan(1);
    config.target.minimumGrade = 'legendary';
    expect(computeBenchmark(data, config).status).toBe('impossible');
  });
});
