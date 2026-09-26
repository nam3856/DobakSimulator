import { describe, expect, it } from 'vitest';
import type { Grade, OptionLine, SimulationConfig } from '../src/types';
import {
  createState,
  getLineOptions,
  matchTarget,
  rollBatch,
  seededRandom,
  validateConfig,
  type RuleData,
  type PotentialRules,
} from '../src/engine';

const grades: Grade[] = ['rare', 'epic', 'unique', 'legendary'];
const line = (type = 'b', grade: Grade = 'legendary'): OptionLine => ({
  id: type,
  type,
  value: 1,
  unit: 'flat',
  text: `${type} +1`,
  grade,
});
function fixture(): RuleData {
  const potential: PotentialRules = {
    ruleId: 'test',
    costBands: [
      {
        minimumLevel: 1,
        maximumLevel: 300,
        resetCosts: { rare: '10', epic: '20', unique: '30', legendary: '40' },
      },
    ],
    grades: grades.map((grade, index) => ({
      grade,
      rank: index + 1,
      gradeUpChance: grade === 'legendary' ? 0 : 0.5,
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
        unit: 'flat',
        probability: 0.5,
        displayText: `${type} +1`,
      })),
    })),
  };
  return {
    potential,
    additional: potential,
    gold: { ...potential, grades: potential.grades.map((g) => ({ ...g, pityThreshold: null })) },
    ability: {
      ruleId: 'ability',
      version: 'test',
      sourceUrl: 'test',
      advancedLineGrades: [{ legendary: 1 }, { legendary: 1 }, { legendary: 1 }],
      grades: {
        legendary: {
          options: ['a', 'b', 'c', 'd'].map((id) => ({
            id,
            label: id,
            weight: 1,
            values: [{ value: 1, label: `${id} +1`, weight: 1 }],
          })),
        },
      },
      costs: [
        { locked: 0, honor: 20000, meso: '2000000' },
        { locked: 1, honor: 30000, meso: '6000000' },
        { locked: 2, honor: 40000, meso: '15000000' },
      ],
    },
    soul: {
      ruleId: 'soul',
      version: 'test',
      amplificationStages: [
        {
          stage: 1,
          initialSuccessProbability: 0.05,
          successProbabilityIncreasePerFailure: 0.01,
          guaranteedAfterFailures: 25,
          systemCostPerAttempt: '500000000',
        },
      ],
      potentialGrades: potential.grades,
      potentialResetCosts: potential.costBands[0].resetCosts,
      optionStages: [{ stage: 1, optionPools: potential.optionPools }],
    },
  };
}
function config(): SimulationConfig {
  return {
    mode: 'cube',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'legendary', lines: [line(), line(), line()], stage: 1, failures: 0 },
    lockedSlots: [],
    batchSize: 1,
    target: {
      mode: 'sum',
      minimumGrade: 'legendary',
      conditions: [{ type: 'a', minValue: 3 }],
      lines: [],
      stage: 1,
      match: 'all',
    },
    ruleVersion: 'test',
    unitPrices: {},
  };
}

describe('pure simulation rules', () => {
  it('rejects the identical tuple without charging a second attempt and keeps unsuccessful results', () => {
    const data = fixture(),
      cfg = config(),
      state = createState(data, cfg);
    const values = [0.9, 0.9, 0.9, 0.1, 0.9, 0.9];
    const next = rollBatch(data, cfg, state, () => values.shift() ?? 0.1);
    expect(next.candidates[0].lines.map((l) => l.type)).toEqual(['a', 'b', 'b']);
    expect(next.lines.map((l) => l.type)).toEqual(['b', 'b', 'b']);
    expect(next.spent.meso).toBe(40n);
    expect(next.attempts).toBe(1n);
    expect(state.spent.meso).toBe(0n);
  });
  it.each(['cube', 'soulPotential'] as const)(
    '%s charges all three same-base candidates even when the first succeeds',
    (mode) => {
      const data = fixture(),
        cfg = { ...config(), mode, batchSize: 3 as const };
      const next = rollBatch(data, cfg, createState(data, cfg), () => 0.1);
      expect(next.status).toBe('success');
      expect(next.attempts).toBe(3n);
      expect(next.spent.meso).toBe(120n);
      expect(next.candidates).toHaveLength(3);
      expect(next.spent.cubes).toBe(mode === 'cube' ? 3n : 0n);
    },
  );
  it.each(['cube', 'soulPotential'] as const)(
    '%s stops its sequential batch on promotion and compares three on the next legendary action',
    (mode) => {
      const data = fixture();
      const cfg = { ...config(), mode, batchSize: 3 as const };
      cfg.start = {
        ...cfg.start,
        grade: 'unique',
        lines: [line('b', 'unique'), line('b', 'unique'), line('b', 'unique')],
        failures: 2,
      };
      expect(validateConfig(data, cfg)).toEqual([]);
      const promoted = rollBatch(data, cfg, createState(data, cfg), () => 0.9);
      expect(promoted).toMatchObject({
        grade: 'legendary',
        attempts: 1n,
        status: 'running',
        failures: 0,
      });
      expect(promoted.candidates).toHaveLength(1);
      expect(promoted.spent.meso).toBe(30n);
      const finished = rollBatch(data, cfg, promoted, () => 0.1);
      expect(finished.status).toBe('success');
      expect(finished.attempts).toBe(4n);
      expect(finished.candidates).toHaveLength(3);
      expect(finished.spent.meso).toBe(150n);

      cfg.target.mode = 'grade';
      const promotedAndDone = rollBatch(data, cfg, createState(data, cfg), () => 0.9);
      expect(promotedAndDone.status).toBe('success');
      expect(promotedAndDone.attempts).toBe(1n);
      expect(promotedAndDone.spent.meso).toBe(30n);
    },
  );
  it('accepts promotion automatically and applies the cost of the old grade', () => {
    const cfg = config();
    cfg.start = {
      ...cfg.start,
      grade: 'rare',
      lines: [line('b', 'rare'), line('b', 'rare'), line('b', 'rare')],
      failures: 2,
    };
    cfg.target.minimumGrade = 'legendary';
    const next = rollBatch(fixture(), cfg, createState(fixture(), cfg), () => 0.9);
    expect(next.grade).toBe('epic');
    expect(next.failures).toBe(0);
    expect(next.spent.meso).toBe(10n);
    expect(next.candidates[0].promoted).toBe(true);
  });
  it('normalizes option exclusions within grade, preserving the grade lottery', () => {
    const data = fixture();
    for (const pool of data.potential.optionPools)
      pool.options[0] = { ...pool.options[0], maxLines: 1, limitGroup: 'a' };
    const cfg = config();
    cfg.target = { ...cfg.target, mode: 'grade', minimumGrade: 'legendary' };
    const rows = getLineOptions(data, cfg, 0);
    expect(rows).toHaveLength(2);
    cfg.target = { ...config().target };
    const next = rollBatch(data, cfg, createState(data, cfg), seededRandom('limits'));
    expect(next.candidates[0].lines.filter((l) => l.type === 'a').length).toBeLessThanOrEqual(1);
  });
  it('locks ability types before drawing other lines and charges both currencies', () => {
    const data = fixture(),
      cfg = config();
    cfg.mode = 'ability';
    cfg.lockedSlots = [0, 1];
    cfg.start.lines = [line('a'), line('b'), line('c')];
    cfg.target = { ...cfg.target, mode: 'ability', conditions: [{ type: 'd', minValue: 1 }] };
    const next = rollBatch(data, cfg, createState(data, cfg), () => 0.9);
    expect(next.lines.map((l) => l.type)).toEqual(['a', 'b', 'd']);
    expect(next.spent.honor).toBe(40000n);
    expect(next.spent.meso).toBe(15000000n);
  });
  it('initializes prime from one imported anchor without charging a reset', () => {
    const data = fixture(),
      cfg = config();
    cfg.cubeType = 'prime';
    cfg.start.lines = [line('a')];
    const state = createState(data, cfg, () => 0.9);
    expect(state.lines.map((l) => l.type)).toEqual(['a', 'b', 'b']);
    expect(state.attempts).toBe(0n);
    expect(state.spent.cubes).toBe(0n);
    cfg.start.lines = state.lines;
    const next = rollBatch(data, cfg, state, () => 0.1);
    expect(next.lines.map((l) => l.type)).toEqual(['a', 'a', 'a']);
    expect(next.spent.meso).toBe(0n);
    expect(next.spent.credits).toBe(10000n);
  });
  it('guarantees amplification after the published number of failures', () => {
    const data = fixture(),
      cfg = config();
    cfg.mode = 'soulAmplification';
    cfg.start.stage = 0;
    cfg.start.failures = 25;
    cfg.target.mode = 'stage';
    cfg.target.stage = 1;
    const next = rollBatch(data, cfg, createState(data, cfg), () => 0.9999);
    expect(next.stage).toBe(1);
    expect(next.failures).toBe(0);
    expect(next.spent.ethers).toEqual([1n, 0n, 0n, 0n]);
    expect(next.status).toBe('success');
  });
  it('keeps market prices separate from system cost', () => {
    const data = fixture(),
      cfg = config();
    cfg.cubeType = 'gold';
    cfg.unitPrices.gold = '999999999999999999999999';
    const next = rollBatch(data, cfg, createState(data, cfg), () => 0.1);
    expect(next.spent.meso).toBe(0n);
    expect(next.spent.cubes).toBe(1n);
  });
  it('reports ordinary configuration errors without throwing', () => {
    const cfg = config();
    cfg.mode = 'ability';
    cfg.start.grade = 'rare';
    cfg.lockedSlots = [0, 1, 2];
    expect(validateConfig(fixture(), cfg).length).toBeGreaterThan(0);
  });
  it('retains only the latest 100 results while keeping lifetime spend and attempts', () => {
    const data = fixture(),
      cfg = config();
    cfg.target.conditions = [{ type: 'unavailable', minValue: 1 }];
    let state = createState(data, cfg);
    const rng = seededRandom('history-cap');
    for (let attempt = 0; attempt < 120; attempt++) state = rollBatch(data, cfg, state, rng);
    expect(state.history).toHaveLength(100);
    expect(state.history[0].sequence).toBe(21n);
    expect(state.attempts).toBe(120n);
    expect(state.spent.meso).toBe(4800n);
  });
  it('rejects cube equipment levels outside the collected official range', () => {
    const cfg = config();
    cfg.level = 251;
    expect(validateConfig(fixture(), cfg).some((error) => error.includes('1~250'))).toBe(true);
  });
  it('requires a level-200 primary weapon for both soul modes', () => {
    for (const mode of ['soulAmplification', 'soulPotential'] as const) {
      const cfg = config();
      cfg.mode = mode;
      cfg.level = 199;
      expect(
        validateConfig(fixture(), cfg).some((error) => error.includes('200 이상의 주무기')),
      ).toBe(true);
      cfg.level = 200;
      cfg.category = 'secondaryWeapon';
      expect(
        validateConfig(fixture(), cfg).some((error) => error.includes('200 이상의 주무기')),
      ).toBe(true);
    }
  });
});

describe('target predicates', () => {
  it('matches exact lines without order while preserving multiplicity', () => {
    const target = {
      ...config().target,
      mode: 'exact' as const,
      lines: [line('a'), line('a'), line('b')],
    };
    expect(
      matchTarget(target, {
        grade: 'legendary',
        stage: 1,
        lines: [line('a'), line('b'), line('a')],
      }),
    ).toBe(true);
    expect(
      matchTarget(target, {
        grade: 'legendary',
        stage: 1,
        lines: [line('a'), line('b'), line('b')],
      }),
    ).toBe(false);
  });
  it('uses at-least grades, sum thresholds, all-stat contributions and multiplicative ignore defense', () => {
    const target = {
      ...config().target,
      minimumGrade: 'unique' as Grade,
      conditions: [{ type: 'strPercent', minValue: 15 }],
    };
    const lines = [
      { ...line('strPercent'), value: 9 },
      { ...line('allStatPercent'), value: 6 },
      line(),
    ];
    expect(matchTarget(target, { grade: 'legendary', stage: 1, lines })).toBe(true);
    target.conditions = [{ type: 'ignoreDefensePercent', minValue: 50 }];
    const defense = [
      { ...line('ignoreDefensePercent'), value: 30 },
      { ...line('ignoreDefensePercent'), value: 30 },
      line(),
    ];
    expect(matchTarget(target, { grade: 'legendary', stage: 1, lines: defense })).toBe(true);
    target.conditions[0].minValue = 60;
    expect(matchTarget(target, { grade: 'legendary', stage: 1, lines: defense })).toBe(false);
  });
  it('supports any/all and a bounded lower-is-better ability target', () => {
    const target = {
      ...config().target,
      mode: 'ability' as const,
      conditions: [
        { type: 'interval', minValue: 0, maxValue: 12 },
        { type: 'a', minValue: 1 },
      ],
      match: 'any' as const,
    };
    const state = {
      grade: 'legendary' as Grade,
      stage: 1,
      lines: [{ ...line('interval'), value: 10 }, line(), line()],
    };
    expect(matchTarget(target, state)).toBe(true);
    expect(matchTarget({ ...target, match: 'all' }, state)).toBe(false);
  });
});

describe('sequential potential batches before legendary', () => {
  const modes = ['cube', 'soulPotential'] as const;
  const lowerConfig = (mode: (typeof modes)[number]) => {
    const cfg = { ...config(), mode, batchSize: 3 as const };
    cfg.start = {
      grade: 'unique',
      lines: [line('b', 'unique'), line('b', 'unique'), line('b', 'unique')],
      stage: 1,
      failures: 0,
    };
    return cfg;
  };

  it.each(modes)('%s pays for three misses and increments failure progress three times', (mode) => {
    const data = fixture(),
      cfg = lowerConfig(mode);
    data.potential.grades[2].pityThreshold = 11;
    data.potential.grades[2].gradeUpChance = 0.1;
    cfg.miracleTime = true;
    const draws = Array.from({ length: 3 }, () => [0.9, 0.1, 0.1, 0.1]).flat();
    const before = createState(data, cfg);
    const after = rollBatch(data, cfg, before, () => draws.shift()!);
    expect(after).toMatchObject({ grade: 'unique', failures: 3, attempts: 3n, status: 'running' });
    expect(after.spent.meso).toBe(90n);
    expect(after.candidates).toHaveLength(3);
    expect(after.history).toHaveLength(3);
    expect(after.lines).toEqual(before.lines);
    expect(draws).toHaveLength(0);
  });

  it.each([1, 2, 3])(
    'stops on natural promotion number %i without spending the remainder',
    (promotion) => {
      const data = fixture(),
        cfg = lowerConfig('cube');
      data.potential.grades[2].pityThreshold = 11;
      const draws = [
        ...Array.from({ length: promotion - 1 }, () => [0.9, 0.1, 0.1, 0.1]).flat(),
        0.1,
        0.9,
        0.9,
        0.9,
      ];
      const after = rollBatch(data, cfg, createState(data, cfg), () => {
        if (!draws.length) throw Error('The batch continued beyond its promotion.');
        return draws.shift()!;
      });
      expect(after).toMatchObject({
        grade: 'legendary',
        failures: 0,
        attempts: BigInt(promotion),
        status: 'running',
      });
      expect(after.spent.meso).toBe(BigInt(30 * promotion));
      expect(after.candidates).toHaveLength(promotion);
      expect(after.candidates.at(-1)?.promoted).toBe(true);
    },
  );

  it.each([1, 2, 3])('stops when the guaranteed promotion is attempt %i', (promotion) => {
    const data = fixture(),
      cfg = lowerConfig('soulPotential');
    data.soul.potentialGrades[2].gradeUpChance = 0;
    cfg.start.failures = 3 - promotion;
    const after = rollBatch(data, cfg, createState(data, cfg), () => 0.1);
    expect(after.grade).toBe('legendary');
    expect(after.failures).toBe(0);
    expect(after.attempts).toBe(BigInt(promotion));
    expect(after.spent.meso).toBe(BigInt(30 * promotion));
    expect(after.candidates).toHaveLength(promotion);
  });

  it.each([1, 2, 3])('stops at lower-grade target success number %i', (success) => {
    const data = fixture(),
      cfg = lowerConfig('cube');
    data.potential.grades[2].pityThreshold = 11;
    cfg.target.minimumGrade = 'unique';
    const draws = [
      ...Array.from({ length: success - 1 }, () => [0.9, 0.1, 0.1, 0.9]).flat(),
      0.9,
      0.1,
      0.1,
      0.1,
    ];
    const after = rollBatch(data, cfg, createState(data, cfg), () => {
      if (!draws.length) throw Error('The batch continued beyond its target.');
      return draws.shift()!;
    });
    expect(after).toMatchObject({
      grade: 'unique',
      failures: success,
      attempts: BigInt(success),
      status: 'success',
    });
    expect(after.spent.meso).toBe(BigInt(30 * success));
    expect(after.candidates).toHaveLength(success);
  });

  it.each(modes)('%s matches the same random stream executed one attempt at a time', (mode) => {
    const data = fixture();
    for (const rule of data.potential.grades.slice(0, 3)) {
      rule.gradeUpChance = 0.1;
      rule.pityThreshold = 5;
    }
    for (const grade of ['rare', 'epic', 'unique'] as Grade[]) {
      for (let sample = 0; sample < 20; sample++) {
        const cfg = lowerConfig(mode);
        cfg.miracleTime = sample % 2 === 0;
        cfg.start = {
          ...cfg.start,
          grade,
          lines: [line('b', grade), line('b', grade), line('b', grade)],
          failures: sample % 4,
        };
        const initial = createState(data, cfg);
        const seed = `${mode}-${grade}-${sample}`;
        const grouped = rollBatch(data, cfg, initial, seededRandom(seed));
        const rng = seededRandom(seed);
        let singles = initial;
        for (let count = 0; count < 3; count++) {
          singles = rollBatch(data, { ...cfg, batchSize: 1 }, singles, rng);
          if (singles.grade !== initial.grade || singles.status === 'success') break;
        }
        const {
          candidates: groupedCandidates,
          startedAt: _groupStart,
          finishedAt: _groupEnd,
          ...groupState
        } = grouped;
        const {
          candidates: _singleCandidates,
          startedAt: _singleStart,
          finishedAt: _singleEnd,
          ...singleState
        } = singles;
        expect(groupState).toEqual(singleState);
        expect(groupedCandidates).toEqual(singles.history);
      }
    }
  });
});

export { fixture, config, line };
