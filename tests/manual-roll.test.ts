import { describe, expect, it } from 'vitest';
import type { Grade, OptionLine, SimulationConfig } from '../src/types';
import type { PotentialRules, RuleData } from '../src/engine/rules';
import {
  createState,
  rollBatch,
  rollManualBatch,
  validateConfig,
  validateManualConfig,
} from '../src/engine/simulation';

const option = (type: string, grade: Grade): OptionLine => ({
  id: type,
  type,
  value: 1,
  unit: 'flat',
  text: `${type} +1`,
  grade,
});

function fixture(mode: 'cube' | 'soulPotential' = 'cube') {
  const grades: Grade[] = ['rare', 'epic', 'unique', 'legendary'];
  const potential: PotentialRules = {
    ruleId: 'manual-potential-test',
    grades: grades.map((grade, index) => ({
      grade,
      rank: index + 1,
      gradeUpChance: 0,
      guaranteedAfterFailures: grade === 'legendary' ? null : 10,
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
      ruleId: 'manual-soul-test',
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
      failures: 0,
    },
    lockedSlots: [],
    batchSize: 3,
    target: {
      mode: 'sum',
      minimumGrade: 'unique',
      conditions: [{ type: 'a', minValue: 3 }],
      lines: [],
      stage: 1,
      match: 'all',
    },
    ruleVersion: 'manual-test',
    unitPrices: {},
  };
  return { data, config };
}

describe('target-independent manual potential rerolls', () => {
  it.each(['cube', 'soulPotential'] as const)(
    '%s keeps all three lower-grade draws even if they satisfy the automatic goal',
    (mode) => {
      const { data, config } = fixture(mode);
      const before = createState(data, config);
      const manual = rollManualBatch(data, config, before, () => 0.1);
      expect(manual).toMatchObject({
        grade: 'unique',
        status: 'running',
        attempts: 3n,
        failures: 3,
      });
      expect(manual.spent.meso).toBe(90n);
      expect(manual.candidates).toHaveLength(3);
      expect(manual.candidates.every((candidate) => !candidate.hit)).toBe(true);
      expect(manual.lines).toEqual(before.lines);
      expect(before.attempts).toBe(0n);
      const automatic = rollBatch(data, config, before, () => 0.1);
      expect(automatic.status).toBe('success');
      expect(automatic.attempts).toBe(1n);
      expect(automatic.spent.meso).toBe(30n);
    },
  );

  it.each(['success', 'impossible'] as const)(
    'rerolls a %s state without resetting paid resources or keeping a completion timestamp',
    (status) => {
      const { data, config } = fixture();
      config.start.grade = 'legendary';
      config.start.lines = [0, 1, 2].map(() => option('b', 'legendary'));
      const before = {
        ...createState(data, config),
        status,
        finishedAt: '2026-09-23T00:00:00Z',
        attempts: 2n,
      };
      before.spent.meso = 80n;
      const after = rollManualBatch(data, config, before, () => 0.1);
      expect(after.status).toBe('running');
      expect(after.finishedAt).toBeUndefined();
      expect(after.attempts).toBe(5n);
      expect(after.spent.meso).toBe(200n);
      expect(after.candidates).toHaveLength(3);
      expect(after.lines).toEqual(before.lines);
      expect(rollBatch(data, config, before, () => 0.1)).toBe(before);
    },
  );

  it('accepts absent, empty, incomplete and invalid goals without changing the saved goal', () => {
    const { data, config } = fixture();
    const before = createState(data, config);
    const targets = [
      undefined,
      { ...config.target, conditions: [] },
      { ...config.target, mode: 'exact', lines: [] },
      { ...config.target, conditions: [{ type: 'a', minValue: -1, slot: 99 }] },
    ];
    for (const target of targets) {
      const invalid = { ...config, target } as SimulationConfig;
      expect(validateManualConfig(data, invalid)).toEqual([]);
      const next = rollManualBatch(data, invalid, before, () => 0.1);
      expect(next.attempts).toBe(3n);
      expect(invalid.target).toBe(target);
    }
    expect(
      validateConfig(data, { ...config, target: { ...config.target, conditions: [] } }),
    ).not.toEqual([]);
  });

  it('stops at a natural promotion, applies it, then charges three legendary candidates on the next action', () => {
    const { data, config } = fixture();
    data.potential.grades[2].gradeUpChance = 0.2;
    const draws = [0.9, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9];
    const promoted = rollManualBatch(data, config, createState(data, config), () => {
      if (!draws.length) throw Error('Unexpected draw after promotion.');
      return draws.shift()!;
    });
    expect(promoted).toMatchObject({
      grade: 'legendary',
      status: 'running',
      attempts: 2n,
      failures: 0,
    });
    expect(promoted.spent.meso).toBe(60n);
    expect(promoted.candidates).toHaveLength(2);
    expect(promoted.lines).toEqual(promoted.candidates[1].lines);
    const after = rollManualBatch(data, config, promoted, () => 0.1);
    expect(after.attempts).toBe(5n);
    expect(after.spent.meso).toBe(180n);
    expect(after.candidates).toHaveLength(3);
  });

  it('uses the current failure count for pity and retains the explicit one-attempt option', () => {
    const { data, config } = fixture('soulPotential');
    const before = createState(data, config);
    before.failures = 9;
    const guaranteed = rollManualBatch(data, config, before, () => 0.1);
    expect(guaranteed).toMatchObject({ grade: 'legendary', failures: 0, attempts: 2n });
    expect(guaranteed.spent.meso).toBe(60n);
    const single = rollManualBatch(
      data,
      { ...config, batchSize: 1 },
      createState(data, config),
      () => 0.1,
    );
    expect(single.attempts).toBe(1n);
    expect(single.candidates).toHaveLength(1);
    expect(single.spent.meso).toBe(30n);
  });

  it('retains Miracle Time natural odds and gold cube resource costs', () => {
    const { data, config } = fixture();
    config.cubeType = 'gold';
    data.gold.grades[2].gradeUpChance = 0.1;
    data.gold.grades[2].miracleTimeGradeUpChance = 0.25;
    const before = createState(data, config);
    const ordinary = rollManualBatch(data, config, before, () => 0.2);
    expect(ordinary.attempts).toBe(3n);
    expect(ordinary.spent.cubes).toBe(3n);
    const event = rollManualBatch(data, { ...config, miracleTime: true }, before, () => 0.2);
    expect(event.grade).toBe('legendary');
    expect(event.spent.cubes).toBe(1n);
    expect(event.spent.meso).toBe(0n);
  });

  it('blocks invalid equipment, starting states and unsupported modes before consuming randomness', () => {
    const { data, config } = fixture();
    const invalidConfigs: SimulationConfig[] = [
      { ...config, level: 0 },
      { ...config, category: 'missing-category' },
      { ...config, cubeType: 'prime' },
      { ...config, lockedSlots: [3] },
      { ...config, start: { ...config.start, lines: config.start.lines.slice(0, 2) } },
      { ...config, start: { ...config.start, failures: 11 } },
      { ...config, mode: 'soulPotential', level: 199 },
      { ...config, mode: 'soulPotential', start: { ...config.start, stage: 0 } },
      { ...config, mode: 'ability' },
      { ...config, mode: 'soulAmplification' },
    ];
    // A bounded pool makes unavailable equipment combinations fail validation.
    for (const pool of data.potential.optionPools) pool.categories = ['weapon'];
    const initial = createState(data, config);
    for (const invalid of invalidConfigs) {
      expect(validateManualConfig(data, invalid)).not.toEqual([]);
      const before = { ...initial, ...invalid.start };
      let draws = 0;
      expect(() =>
        rollManualBatch(data, invalid, before, () => {
          draws++;
          return 0.1;
        }),
      ).toThrow();
      expect(draws).toBe(0);
      expect(before.attempts).toBe(0n);
    }
  });
});
