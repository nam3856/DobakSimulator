import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CubeType, Grade, OptionLine, SimulationConfig } from '../src/types';
import { analyzeOutcomes, computeBenchmark } from '../src/engine/benchmark';
import {
  effectiveGradeUpChance,
  supportsMiracleTime,
  type PotentialRules,
  type RuleData,
} from '../src/engine/rules';
import { createState, rollBatch } from '../src/engine/simulation';

function option(type: string, grade: Grade): OptionLine {
  return { id: type, type, value: 1, unit: 'flat', text: `${type} +1`, grade };
}

function fixture() {
  const grades: Grade[] = ['rare', 'epic', 'unique', 'legendary'];
  const potential: PotentialRules = {
    ruleId: 'miracle-time-test',
    grades: grades.map((grade, index) => ({
      grade,
      rank: index + 1,
      gradeUpChance: grade === 'legendary' ? 0 : 0.1,
      guaranteedAfterFailures: grade === 'legendary' ? null : 4,
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
    gold: {
      ...potential,
      grades: potential.grades.map((grade) => ({ ...grade, guaranteedAfterFailures: null })),
    },
    ability: {
      ruleId: 'unused',
      version: 'test',
      sourceUrl: 'test',
      grades: {},
      advancedLineGrades: [],
      costs: [],
    },
    soul: {
      ruleId: 'miracle-time-soul-test',
      version: 'test',
      amplificationStages: [],
      potentialGrades: potential.grades,
      potentialResetCosts: potential.costBands[0].resetCosts,
      optionStages: [{ stage: 1, optionPools: potential.optionPools }],
    },
  };
  const config: SimulationConfig = {
    mode: 'cube',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: {
      grade: 'unique',
      lines: [0, 1, 2].map(() => option('b', 'unique')),
      stage: 1,
      failures: 0,
    },
    lockedSlots: [],
    batchSize: 3,
    target: {
      mode: 'grade',
      minimumGrade: 'legendary',
      conditions: [],
      lines: [],
      stage: 1,
      match: 'all',
    },
    ruleVersion: 'miracle-time-test',
    unitPrices: {},
  };
  return { data, config };
}

const eligible = [
  ['cube', 'black'],
  ['cube', 'additional'],
  ['soulPotential', 'black'],
] as const;

describe('Miracle Time potential promotions', () => {
  it.each([...eligible, ['cube', 'gold']] as const)(
    'doubles the paid promotion chance for %s / %s',
    (mode, cubeType) => {
      const { data, config } = fixture();
      Object.assign(config, { mode, cubeType, batchSize: 1 });
      const start = createState(data, config);
      const ordinary = rollBatch(data, config, start, () => 0.15);
      const event = rollBatch(data, { ...config, miracleTime: true }, start, () => 0.15);
      expect(ordinary.grade).toBe('unique');
      expect(ordinary.failures).toBe(1);
      expect(event.grade).toBe('legendary');
      expect(event.failures).toBe(0);
      expect(event.status).toBe('success');
      expect(event.attempts).toBe(1n);
      expect(event.spent.meso).toBe(ordinary.spent.meso);
      expect(data.potential.grades[2].gradeUpChance).toBe(0.1);
    },
  );

  it.each(eligible)(
    'keeps one pity count per failure and the same guarantee for %s / %s',
    (mode, cubeType) => {
      const { data, config } = fixture();
      Object.assign(config, { mode, cubeType, miracleTime: true, batchSize: 1 });
      config.start.failures = 2;
      let state = createState(data, config);
      for (const expected of [3, 4]) {
        let draws = 0;
        state = rollBatch(data, config, state, () => (draws++ === 0 ? 0.99 : 0.1));
        expect(state.grade).toBe('unique');
        expect(state.failures).toBe(expected);
      }
      const guaranteed = rollBatch(data, config, state, () => 0.99);
      expect(guaranteed.grade).toBe('legendary');
      expect(guaranteed.failures).toBe(0);
      expect(guaranteed.attempts).toBe(3n);
      expect(guaranteed.spent.meso).toBe(90n);
    },
  );

  it('preserves older saves, unsupported modes and the terminal grade', () => {
    const { data, config } = fixture();
    const rule = data.potential.grades[2];
    expect(effectiveGradeUpChance(config, rule)).toBe(0.1);
    expect(effectiveGradeUpChance({ ...config, miracleTime: false }, rule)).toBe(0.1);
    for (const cubeType of ['prime', 'primeAdditional'] as CubeType[]) {
      const excluded = { ...config, cubeType, miracleTime: true };
      expect(supportsMiracleTime(excluded)).toBe(false);
      expect(effectiveGradeUpChance(excluded, rule)).toBe(0.1);
    }
    for (const mode of ['ability', 'soulAmplification'] as const) {
      const excluded = { ...config, mode, miracleTime: true };
      expect(supportsMiracleTime(excluded)).toBe(false);
      expect(effectiveGradeUpChance(excluded, rule)).toBe(0.1);
    }
    const event = { ...config, miracleTime: true };
    expect(effectiveGradeUpChance(event, { ...rule, gradeUpChance: 0.8 })).toBe(1);
    expect(effectiveGradeUpChance(event, data.potential.grades[3])).toBe(0);
  });

  it('uses the published event rates, including rounding, without rewriting base odds', () => {
    for (const [file, mode, cubeType, rates] of [
      ['potential', 'cube', 'black', [0.30000000255, 0.07000002406, 0.028, 0]],
      ['additional-potential', 'cube', 'additional', [0.047619, 0.019608, 0.014, 0]],
      ['gold', 'cube', 'gold', [0.159989, 0.033917, 0.003992, 0]],
      ['soul', 'soulPotential', 'black', [0.03, 0.011751, 0.006645, 0]],
    ] as const) {
      const rules = JSON.parse(
        readFileSync(new URL(`../public/rules/${file}.json`, import.meta.url), 'utf8'),
      );
      const grades = (
        mode === 'soulPotential' ? rules.potentialGrades : rules.grades
      ) as PotentialRules['grades'];
      expect(grades.map((rule) => rule.miracleTimeGradeUpChance)).toEqual(rates);
      for (const [index, rule] of grades.entries()) {
        expect(effectiveGradeUpChance({ mode, cubeType, miracleTime: true }, rule)).toBe(
          rates[index],
        );
        expect(effectiveGradeUpChance({ mode, cubeType }, rule)).toBe(rule.gradeUpChance);
      }
      expect(rules.miracleTime.failureCountIncrement).toBe(1);
      expect(rules.miracleTime.sourceUrl).toBe(
        'https://maplestory.nexon.com/News/Event/Ongoing/1391',
      );
    }
  });

  it('uses an explicit event rate in gameplay and means, and keeps gold without pity', () => {
    const { data, config } = fixture();
    Object.assign(config, { cubeType: 'gold', miracleTime: true });
    data.gold.grades[2].miracleTimeGradeUpChance = 0.25;
    const next = rollBatch(data, config, createState(data, config), () => 0.22);
    expect(next.grade).toBe('legendary');
    expect(next.spent.cubes).toBe(1n);
    expect(next.spent.meso).toBe(0n);
    const result = computeBenchmark(data, config, 1, { sampleCount: 12000, seed: 'gold-event' });
    expect(result.unit).toBe('cubes');
    expect(result.expectedAttempts).toBe(4);
    expect(result.expectedCost).toBe(4);
    expect(result.cdfAtActual).toBeCloseTo(0.25, 1);
  });

  it.each(eligible)(
    'uses event odds in both the exact mean and cost distribution for %s / %s',
    (mode, cubeType) => {
      const { data, config } = fixture();
      Object.assign(config, { mode, cubeType });
      const options = { sampleCount: 12000, seed: 'miracle-time-bounded-promotion' };
      const ordinary = computeBenchmark(data, config, 30, options);
      const event = computeBenchmark(data, { ...config, miracleTime: true }, 30, options);
      const expectedOrdinary = 1 + 0.9 + 0.9 ** 2 + 0.9 ** 3 + 0.9 ** 4;
      const expectedEvent = 1 + 0.8 + 0.8 ** 2 + 0.8 ** 3 + 0.8 ** 4;
      expect(ordinary.expectedAttempts).toBeCloseTo(expectedOrdinary, 12);
      expect(event.expectedAttempts).toBeCloseTo(expectedEvent, 12);
      expect(event.expectedCost).toBeCloseTo(30 * expectedEvent, 10);
      expect(ordinary.cdfAtActual).toBeCloseTo(0.1, 1);
      expect(event.cdfAtActual).toBeCloseTo(0.2, 1);
      expect(event.cdfAtActual!).toBeGreaterThan(ordinary.cdfAtActual!);
      expect(event.distribution.at(-1)).toEqual({ cost: 150, cdf: 1 });
      expect(ordinary.distribution.at(-1)).toEqual({ cost: 150, cdf: 1 });
      expect(computeBenchmark(data, { ...config, miracleTime: false }, 30, options)).toEqual(
        ordinary,
      );
    },
  );

  it('leaves legendary option odds, triple costs and their cached analysis unchanged', () => {
    const { data, config } = fixture();
    config.start.grade = 'legendary';
    config.start.lines = [0, 1, 2].map(() => option('b', 'legendary'));
    config.target.mode = 'sum';
    config.target.conditions = [{ type: 'a', minValue: 3 }];
    const event = { ...config, miracleTime: true };
    expect(analyzeOutcomes(data, event, 'legendary')).toBe(
      analyzeOutcomes(data, config, 'legendary'),
    );
    expect(computeBenchmark(data, event)).toEqual(computeBenchmark(data, config));
    const result = rollBatch(data, event, createState(data, event), () => 0.1);
    expect(result.candidates).toHaveLength(3);
    expect(result.attempts).toBe(3n);
    expect(result.spent.meso).toBe(120n);
  });
});
