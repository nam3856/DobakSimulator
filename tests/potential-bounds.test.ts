import { describe, expect, it } from 'vitest';
import type { Grade, SimulationConfig, TargetCondition } from '../src/types';
import {
  GRADES,
  eligibleCandidates,
  type PotentialRules,
  type RawOption,
  type RuleData,
} from '../src/engine/rules';
import { prepareDraw } from '../src/engine/simulation';
import { metricValue } from '../src/engine/target';
import { getPotentialConditionBounds } from '../src/ui/potential-bounds';

function option(type: string, value: number, extra: Partial<RawOption> = {}): RawOption {
  return { id: `${type}:${value}`, type, value, unit: 'percent', probability: 1, ...extra };
}

function fixture() {
  const potential: PotentialRules = {
    ruleId: 'bounds',
    grades: GRADES.map((grade, index) => ({
      grade,
      rank: index + 1,
      gradeUpChance: grade === 'legendary' ? 0 : 0.1,
      lineGrades: [1, 2, 3].map((slot) => ({
        slot,
        chances:
          grade === 'legendary' && slot > 1
            ? [
                { grade, probability: 0.5 },
                { grade: 'unique' as const, probability: 0.5 },
              ]
            : [{ grade, probability: 1 }],
      })),
    })),
    optionPools: GRADES.map((grade, index) => ({
      grade,
      minimumLevel: 1,
      maximumLevel: 250,
      categories: [],
      options: [
        option('strPercent', (index + 1) * 3),
        option('allStatPercent', (index + 1) * 3 - 3 || 1),
        option('attackPercent', (index + 1) * 3),
        option('bossDamagePercent', (index + 1) * 10, { maxLines: 2, limitGroup: 'damage' }),
        option('ignoreDefensePercent', (index + 1) * 10, { maxLines: 2, limitGroup: 'damage' }),
        option('otherFlat', 1),
      ],
    })),
    costBands: [],
  };
  const data: RuleData = {
    potential,
    additional: structuredClone(potential),
    gold: {
      ...structuredClone(potential),
      optionPools: potential.optionPools.map((pool) => ({
        ...pool,
        options: [option('attackPercent', 8), option('otherFlat', 1)],
      })),
    },
    ability: {
      ruleId: '',
      version: '',
      sourceUrl: '',
      grades: {},
      advancedLineGrades: [],
      costs: [],
    },
    soul: {
      ruleId: 'soul-bounds',
      version: 'test',
      amplificationStages: [],
      potentialGrades: potential.grades,
      potentialResetCosts: { rare: '1', epic: '2', unique: '3', legendary: '4' },
      optionStages: [1, 4].map((stage) => ({
        stage,
        optionPools: potential.optionPools.map((pool) => ({
          ...pool,
          options: [option('attackPercent', stage * 5), option('otherFlat', 1)],
        })),
      })),
    },
  };
  const config: SimulationConfig = {
    mode: 'cube',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'legendary', lines: [], stage: 1, failures: 0 },
    lockedSlots: [],
    batchSize: 3,
    unitPrices: {},
    ruleVersion: 'test',
    target: {
      mode: 'sum',
      minimumGrade: 'legendary',
      conditions: [],
      lines: [],
      stage: 1,
      match: 'all',
    },
  };
  return { data, config };
}

const condition = (type: string): TargetCondition => ({ type, minValue: 1 });

/** Exhaustive small-pool oracle: no candidate compression. */
function exhaustive(
  data: RuleData,
  config: SimulationConfig,
  type: string,
  grade: Grade = 'legendary',
) {
  const prepared = prepareDraw(data, config, grade, config.start.lines);
  const chosen = new Map(prepared.fixed);
  const prefix = [...prepared.fixed.values()];
  let min = Infinity,
    max = 0;
  function visit(slot: number) {
    if (slot === 3) {
      const lines = [0, 1, 2].map((index) => chosen.get(index)!.line);
      const positive = lines.map((line) => metricValue([line], type)).filter((value) => value > 0);
      if (positive.length) {
        min = Math.min(min, ...positive);
        max = Math.max(max, metricValue(lines, type));
      }
      return;
    }
    if (chosen.has(slot)) return visit(slot + 1);
    for (const candidate of eligibleCandidates(prepared.candidates[slot], prefix)) {
      chosen.set(slot, candidate);
      prefix.push(candidate);
      visit(slot + 1);
      prefix.pop();
      chosen.delete(slot);
    }
  }
  visit(0);
  return { min, max };
}

describe('potential condition input bounds', () => {
  it('uses the three-line total and includes all-stat contributions in a main-stat target', () => {
    const { data, config } = fixture();
    expect(getPotentialConditionBounds(data, config, condition('strPercent'))).toEqual({
      min: 6,
      max: 36,
    });
    expect(getPotentialConditionBounds(data, config, condition('attackPercent'))).toEqual({
      min: 9,
      max: 36,
    });
  });

  it('matches an exhaustive oracle with grade mixtures and shared duplicate limits', () => {
    const { data, config } = fixture();
    for (const type of [
      'strPercent',
      'attackPercent',
      'bossDamagePercent',
      'ignoreDefensePercent',
    ]) {
      const result = getPotentialConditionBounds(data, config, condition(type))!;
      const expected = exhaustive(data, config, type);
      expect(result.min).toBeCloseTo(expected.min, 10);
      expect(result.max).toBeCloseTo(expected.max, 10);
    }
    expect(getPotentialConditionBounds(data, config, condition('bossDamagePercent'))).toEqual({
      min: 30,
      max: 80,
    });
    expect(getPotentialConditionBounds(data, config, condition('ignoreDefensePercent'))).toEqual({
      min: 30,
      max: 64,
    });
  });

  it('uses the selected equipment level and category rather than the largest global pool', () => {
    const { data, config } = fixture();
    data.potential.optionPools.push({
      grade: 'legendary',
      minimumLevel: 250,
      maximumLevel: 250,
      categories: ['weapon'],
      options: [option('attackPercent', 14), option('otherFlat', 1)],
    });
    expect(
      getPotentialConditionBounds(data, { ...config, level: 250 }, condition('attackPercent')),
    ).toEqual({ min: 9, max: 42 });
    expect(
      getPotentialConditionBounds(
        data,
        { ...config, category: 'hat', level: 250 },
        condition('attackPercent'),
      )!.max,
    ).toBe(36);
    expect(getPotentialConditionBounds(data, config, condition('attackPercent'))!.max).toBe(36);
  });

  it('keeps the prime first line and its shared restriction while varying the remaining two', () => {
    const { data, config } = fixture();
    config.cubeType = 'prime';
    config.start.lines = [
      {
        id: 'bossDamagePercent:40',
        type: 'bossDamagePercent',
        value: 40,
        unit: 'percent',
        text: 'bossDamagePercent 40',
        grade: 'legendary',
      },
    ];
    expect(getPotentialConditionBounds(data, config, condition('attackPercent'))).toEqual({
      min: 9,
      max: 24,
    });
    expect(getPotentialConditionBounds(data, config, condition('bossDamagePercent'))).toEqual({
      min: 30,
      max: 80,
    });
    expect(getPotentialConditionBounds(data, config, condition('ignoreDefensePercent'))).toEqual({
      min: 30,
      max: 40,
    });
    const expected = exhaustive(data, config, 'ignoreDefensePercent');
    expect(
      getPotentialConditionBounds(data, config, condition('ignoreDefensePercent'))!.max,
    ).toBeCloseTo(expected.max);
    config.start.lines = [];
    expect(getPotentialConditionBounds(data, config, condition('attackPercent'))).toBeUndefined();
  });

  it('uses additional, gold and soul stage pools independently', () => {
    const { data, config } = fixture();
    data.additional.optionPools = data.additional.optionPools.map((pool) => ({
      ...pool,
      options: [option('attackPercent', 7), option('otherFlat', 1)],
    }));
    expect(
      getPotentialConditionBounds(
        data,
        { ...config, cubeType: 'additional' },
        condition('attackPercent'),
      ),
    ).toEqual({ min: 7, max: 21 });
    expect(
      getPotentialConditionBounds(
        data,
        { ...config, cubeType: 'gold' },
        condition('attackPercent'),
      ),
    ).toEqual({ min: 8, max: 24 });
    const soul = { ...config, mode: 'soulPotential' as const };
    expect(getPotentialConditionBounds(data, soul, condition('attackPercent'))).toEqual({
      min: 5,
      max: 15,
    });
    expect(
      getPotentialConditionBounds(
        data,
        { ...soul, start: { ...soul.start, stage: 4 } },
        condition('attackPercent'),
      ),
    ).toEqual({ min: 20, max: 60 });
  });

  it('allows future promotions, honors unreachable grade barriers and includes guarantee-only promotions', () => {
    const { data, config } = fixture();
    config.start.grade = 'rare';
    expect(getPotentialConditionBounds(data, config, condition('attackPercent'))!.max).toBe(36);
    data.gold.grades[0].gradeUpChance = 0;
    const gold = { ...config, cubeType: 'gold' as const };
    expect(getPotentialConditionBounds(data, gold, condition('attackPercent'))).toBeUndefined();
    const guaranteed = structuredClone(data);
    guaranteed.gold.grades[0].pityThreshold = 3;
    expect(getPotentialConditionBounds(guaranteed, gold, condition('attackPercent'))!.max).toBe(24);
  });

  it('retains slot/line-grade/count semantics for imported per-line conditions', () => {
    const { data, config } = fixture();
    expect(
      getPotentialConditionBounds(data, config, { type: 'strPercent', minValue: 1, slot: 0 }),
    ).toEqual({ min: 12, max: 12 });
    expect(
      getPotentialConditionBounds(data, config, {
        type: 'strPercent',
        minValue: 1,
        minGrade: 'legendary',
        count: 2,
      }),
    ).toEqual({ min: 12, max: 12 });
    expect(
      getPotentialConditionBounds(data, config, {
        type: 'bossDamagePercent',
        minValue: 1,
        count: 3,
      }),
    ).toBeUndefined();
  });

  it('returns no fabricated range for unavailable metrics and caches threshold-only edits', () => {
    const { data, config } = fixture();
    expect(getPotentialConditionBounds(data, config, condition('missing'))).toBeUndefined();
    const initial = getPotentialConditionBounds(data, config, condition('attackPercent'));
    expect(
      getPotentialConditionBounds(data, config, { type: 'attackPercent', minValue: 999 }),
    ).toBe(initial);
    expect(
      getPotentialConditionBounds(
        data,
        { ...config, target: { ...config.target, mode: 'exact' } },
        condition('attackPercent'),
      ),
    ).toBeUndefined();
  });
});
