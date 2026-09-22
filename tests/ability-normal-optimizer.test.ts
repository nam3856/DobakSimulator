import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { optimizeNormalAbility } from '../src/engine/ability-normal-optimizer';
import type { AbilityRules, RuleData } from '../src/engine/rules';
import type { LineGrade, OptionLine } from '../src/types';

const high: Record<string, number> = { epic: 2, unique: 4, legendary: 20 };
const line = (type: string, grade: LineGrade, maximum = false): OptionLine => {
  const value = high[grade] / (maximum ? 1 : 2);
  return { id: `${type}:${grade}:${value}`, abilityTypeId: type, type, value, unit: 'flat', text: `${type} +${value}`, grade };
};
function fixture(): RuleData {
  const unused = { ruleId: 'unused', grades: [], optionPools: [], costBands: [] };
  return {
    potential: unused, additional: unused, gold: unused,
    soul: { ruleId: 'unused', version: 'test', amplificationStages: [], potentialGrades: [], potentialResetCosts: { rare: '0', epic: '0', unique: '0', legendary: '0' }, optionStages: [] },
    ability: {
      ruleId: 'normal-optimizer-fixture', version: 'test', sourceUrl: 'test',
      advancedLineGrades: [{ legendary: 1 }, { epic: .83, unique: .15, legendary: .02 }, { epic: .83, unique: .15, legendary: .02 }],
      costs: [{ locked: 0, honor: 20000, meso: '2000000' }, { locked: 1, honor: 30000, meso: '6000000' }, { locked: 2, honor: 40000, meso: '15000000' }],
      grades: Object.fromEntries(['epic', 'unique', 'legendary'].map((grade) => [grade, {
        options: ['a', 'b', 'c', 'd', 'e'].map((type) => ({ id: type, type, label: type, weight: 1,
          values: [{ value: high[grade] / 2, label: `${type} +${high[grade] / 2}`, weight: 4 }, { value: high[grade], label: `${type} +${high[grade]}`, weight: 1 }],
        })),
      }])),
    },
  };
}
const targets = [{ type: 'a', grade: 'legendary' as const }, { type: 'b', grade: 'unique' as const }, { type: 'c', grade: 'unique' as const }];
const byId = (result: ReturnType<typeof optimizeNormalAbility>, id: string) => result.strategies.find((row) => row.id === id)!;
function miracle(data: RuleData): Pick<AbilityRules, 'grades'> {
  return { grades: Object.fromEntries(Object.entries(data.ability.grades).map(([grade, table]) => [grade, { options: table.options.map((option) => ({
    ...option, weight: grade === 'legendary' && option.type === 'a' ? 4 : 1,
    values: [{ ...option.values[1], weight: 1 }],
  })) }])) };
}

describe('ordinary ability resource optimizer', () => {
  it('uses ordinary honor costs and a per-roll approximation for a single legendary goal', () => {
    const result = optimizeNormalAbility(fixture(), { start: [line('d', 'legendary'), line('e', 'epic'), line('c', 'unique')], targets: targets.slice(0, 1) });
    const direct = byId(result, 'normal-honor');
    expect(direct.status).toBe('ready');
    expect(direct.expectedResets).toBeCloseTo(25, 10);
    expect(direct.expectedHonor).toBeCloseTo(200000, 6);
    expect(direct.expectedMiracle).toBe(0);
    expect(direct).not.toHaveProperty('expectedMeso');
    expect(direct).not.toHaveProperty('totalCost');
    expect(result.notes.join(' ')).toContain('근사');
  });

  it('keeps Black misses but adopts Chaos misses using different exact value expectations', () => {
    const result = optimizeNormalAbility(fixture(), { start: [line('a', 'legendary'), line('b', 'unique'), line('c', 'unique')], targets });
    const black = byId(result, 'normal-black');
    const chaos = byId(result, 'normal-chaos');
    // Independent two-value draws: q=.2^3; current tuple mass=.8^3.
    expect(black.expectedHonor).toBe(0);
    expect(chaos.expectedHonor).toBe(0);
    expect(black.expectedBlack).toBeCloseTo((1 - .8 ** 3) / .2 ** 3, 10);
    expect(chaos.expectedChaos).toBeCloseTo((1 - (.8 ** 2 + .2 ** 2) ** 3 + .2 ** 6) / .2 ** 3 - .8 ** 3, 10);
    expect(chaos.expectedChaos!).toBeGreaterThan(black.expectedBlack!);
  });

  it('allows epic filler lines for Black and Chaos without unnecessary honor preparation', () => {
    const result = optimizeNormalAbility(fixture(), { start: [line('a', 'legendary'), line('b', 'epic'), line('c', 'epic')], targets: targets.slice(0, 1) });
    for (const id of ['normal-black', 'normal-chaos']) {
      expect(byId(result, id).status).toBe('ready');
      expect(byId(result, id).expectedHonor).toBe(0);
      expect(byId(result, id).expectedResets).toBe(0);
    }
  });

  it('retains already completed ordinary goal lines and skips every cost when finished', () => {
    const result = optimizeNormalAbility(fixture(), { start: [line('a', 'legendary', true), line('b', 'unique', true), line('c', 'epic')], targets: targets.slice(0, 2) });
    for (const row of result.strategies) {
      expect(row.status).toBe('already');
      expect([row.expectedHonor, row.expectedResets, row.expectedMiracle, row.expectedBlack, row.expectedChaos]).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it('does not retain an existing legendary lower line during ordinary preparation', () => {
    const result = optimizeNormalAbility(fixture(), { start: [line('a', 'legendary'), line('b', 'legendary', true), line('c', 'unique', true)], targets: targets.slice(0, 2) });
    expect(byId(result, 'normal-black').expectedHonor!).toBeGreaterThan(0);
    expect(byId(result, 'normal-honor').expectedHonor!).toBeGreaterThan(0);
  });

  it('uses Miracle-specific type weights and counts items without meso prices', () => {
    const data = fixture();
    const result = optimizeNormalAbility(data, { start: [line('d', 'legendary'), line('e', 'epic'), line('c', 'unique')], targets: targets.slice(0, 1), miracleRules: miracle(data) });
    const row = byId(result, 'normal-miracle');
    expect(row.expectedMiracle).toBeCloseTo(2, 10);
    expect(row.expectedHonor).toBe(0);
    expect(byId(result, 'normal-miracle-honor').expectedMiracle).toBeCloseTo(2, 10);
    expect(byId(result, 'normal-miracle-honor').expectedHonor).toBe(0);
    expect(byId(result, 'normal-honor').expectedHonor).toBeCloseTo(200000, 6);
  });

  it('skips Miracle preparation when a requested unique maximum is already secured', () => {
    const data = fixture();
    const result = optimizeNormalAbility(data, { start: [line('d', 'legendary'), line('b', 'unique', true), line('e', 'epic')], targets: targets.slice(0, 2), miracleRules: miracle(data) });
    expect(byId(result, 'normal-miracle-honor').expectedMiracle).toBe(0);
    expect(byId(result, 'normal-miracle-honor').expectedHonor).toBe(byId(result, 'normal-honor').expectedHonor);
  });

  it('compares lower-first honor use while offering retention of an already finished first line', () => {
    const result = optimizeNormalAbility(fixture(), {
      start: [line('a', 'legendary', true), line('b', 'unique'), line('e', 'epic')],
      targets: targets.slice(0, 2),
    });
    expect(byId(result, 'normal-honor').expectedHonor!).toBeLessThan(byId(result, 'normal-honor-lower-first').expectedHonor!);
    expect(byId(result, 'normal-honor-lower-first').expectedMiracle).toBe(0);
    expect(byId(result, 'normal-honor-lower-first').expectedBlack).toBe(0);
    expect(byId(result, 'normal-honor-lower-first').expectedChaos).toBe(0);
  });

  it('does not silently replace missing Miracle rules with honor probabilities', () => {
    const result = optimizeNormalAbility(fixture(), { start: [line('d', 'legendary'), line('e', 'epic'), line('c', 'unique')], targets: targets.slice(0, 1) });
    expect(byId(result, 'normal-miracle').status).toBe('unavailable');
    expect(byId(result, 'normal-miracle').expectedMiracle).toBeNull();
  });

  it('discloses unverified Miracle use with a legendary lower line instead of inventing legality', () => {
    const data = fixture();
    const result = optimizeNormalAbility(data, {
      start: [line('a', 'legendary'), line('b', 'legendary'), line('c', 'epic')],
      targets: targets.slice(0, 1), miracleRules: miracle(data),
    });
    expect(byId(result, 'normal-miracle').status).toBe('unavailable');
    expect(byId(result, 'normal-miracle').description).toContain('확인하지 못해');
    expect(byId(result, 'normal-miracle-honor').status).toBe('unavailable');
    expect(byId(result, 'normal-black').status).toBe('ready');
    expect(byId(result, 'normal-black').expectedHonor!).toBeGreaterThan(0);
  });

  it('rejects multiple legendary targets for ordinary optimization', () => {
    expect(() => optimizeNormalAbility(fixture(), { start: [line('d', 'legendary'), line('e', 'epic'), line('c', 'unique')], targets: [{ type: 'a', grade: 'legendary' }, { type: 'b', grade: 'legendary' }] })).toThrow('레전드리 목표 1개');
  });

  it('produces finite vectors for official legendary + two unique targets', () => {
    const data = fixture();
    data.ability = JSON.parse(readFileSync(new URL('../public/rules/ability.json', import.meta.url), 'utf8'));
    const getLine = (type: string, grade: LineGrade) => {
      const option = data.ability.grades[grade]!.options.find((option) => (option.type ?? option.id) === type)!;
      const value = option.values[0];
      return { id: option.id, abilityTypeId: option.id, type, value: value.value, text: value.label, grade, unit: 'percent' as const };
    };
    const selected = data.ability.grades.legendary!.options.filter((option) => data.ability.grades.unique!.options.some((other) => other.type === option.type));
    const types = selected.slice(0, 3).map((option) => option.type ?? option.id);
    const result = optimizeNormalAbility(data, {
      start: [getLine(types[0], 'legendary'), getLine(types[1], 'epic'), getLine(types[2], 'epic')],
      targets: [{ type: types[0], grade: 'legendary' }, { type: types[1], grade: 'unique' }, { type: types[2], grade: 'unique' }],
      miracleRules: JSON.parse(readFileSync(new URL('../public/rules/ability-miracle.json', import.meta.url), 'utf8')),
    });
    for (const row of result.strategies) {
      expect(row.status).toBe('ready');
      expect([row.expectedHonor, row.expectedResets, row.expectedMiracle, row.expectedBlack, row.expectedChaos].every((value) => Number.isFinite(value) && value! >= 0)).toBe(true);
    }
  }, 15000);
});
