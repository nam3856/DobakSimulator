import { describe, expect, it } from 'vitest';
import type { OptionLine, SimulationConfig, SimulationState } from '../src/types';
import {
  abilityConfigForState,
  abilityProgress,
  usesAbilityProgression,
  usesFirstLockedAbility,
  usesLowerFirstAbility,
} from '../src/engine/ability-strategy';
import { eligibleCandidates, type RuleData } from '../src/engine/rules';
import { createState, prepareDraw, rollBatch, validateConfig } from '../src/engine/simulation';

const option = (type: string): OptionLine => ({
  id: type,
  type,
  abilityTypeId: type,
  value: 1,
  unit: 'flat',
  text: `${type} +1`,
  grade: 'legendary',
});
const data: RuleData = {
  potential: { ruleId: 'unused', grades: [], optionPools: [], costBands: [] },
  additional: { ruleId: 'unused', grades: [], optionPools: [], costBands: [] },
  gold: { ruleId: 'unused', grades: [], optionPools: [], costBands: [] },
  soul: {
    ruleId: 'unused',
    version: 'test',
    amplificationStages: [],
    potentialGrades: [],
    potentialResetCosts: { rare: '0', epic: '0', unique: '0', legendary: '0' },
    optionStages: [],
  },
  ability: {
    ruleId: 'test',
    version: 'test',
    sourceUrl: 'test',
    advancedLineGrades: [{ legendary: 1 }, { legendary: 1 }, { legendary: 1 }],
    grades: {
      legendary: {
        options: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
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
};
function config(): SimulationConfig {
  return {
    mode: 'ability',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'legendary', lines: ['a', 'd', 'e'].map(option), stage: 0, failures: 0 },
    lockedSlots: [0],
    abilityStrategy: 'firstLocked',
    batchSize: 1,
    target: {
      mode: 'ability',
      minimumGrade: 'legendary',
      conditions: [
        { type: 'a', minValue: 1, minGrade: 'legendary', slot: 0 },
        { type: 'b', minValue: 1, minGrade: 'legendary', slots: [1, 2] },
        { type: 'c', minValue: 1, minGrade: 'legendary', slots: [1, 2] },
      ],
      lines: [],
      stage: 0,
      match: 'all',
    },
    ruleVersion: 'test',
    unitPrices: {},
  };
}

function draw(config: SimulationConfig, state: SimulationState, ...tuples: string[][]) {
  const prepared = prepareDraw(
    data,
    abilityConfigForState(config, state),
    state.grade,
    state.lines,
  );
  const values: number[] = [];
  for (const tuple of tuples) {
    const prefix = [...prepared.fixed.values()];
    for (let slot = 0; slot < 3; slot++) {
      if (prepared.fixed.has(slot)) {
        expect(tuple[slot]).toBe(prepared.fixed.get(slot)!.line.type);
        continue;
      }
      const rows = eligibleCandidates(prepared.candidates[slot], prefix);
      const index = rows.findIndex((candidate) => candidate.line.type === tuple[slot]);
      if (index < 0) throw new Error('Fixture requested an excluded option');
      values.push(
        rows.slice(0, index).reduce((p, row) => p + row.probability, 0) +
          rows[index].probability / 2,
      );
      prefix.push(rows[index]);
    }
  }
  return rollBatch(data, config, state, () => {
    const value = values.shift();
    if (value === undefined) throw new Error('Unexpected additional draw');
    return value;
  });
}

describe('ability first-line-locked progression', () => {
  it.each([1, 2])(
    'preserves the first line, secures lower slot %i, then pursues the remaining goal',
    (slot) => {
      const cfg = config();
      expect(validateConfig(data, cfg)).toEqual([]);
      const tuple = (other: string) => (slot === 1 ? ['a', 'b', other] : ['a', other, 'b']);
      let state = createState(data, cfg);
      const fixedFirst = state.lines[0];
      expect(state.lockedSlots).toEqual([0]);
      state = draw(cfg, state, tuple('e'));
      expect(state.lockedSlots).toEqual([0, slot]);
      expect(abilityProgress(cfg, state.lines)).toMatchObject({
        matchedLower: 1,
        requiredLower: 2,
      });
      expect(state.candidates[0]).toMatchObject({ progressed: true, adopted: true, hit: false });
      state = draw(cfg, state, tuple('d'));
      expect(state.lines.map((line) => line.type)).toEqual(tuple('e'));
      expect(state.candidates[0].adopted).toBe(false);
      state = draw(cfg, state, tuple('c'));
      expect(state.status).toBe('success');
      expect(state.lines[0]).toEqual(fixedFirst);
      expect(state.lines.map((line) => line.type)).toEqual(tuple('c'));
      expect(state.lockedSlots).toHaveLength(2);
      expect(abilityProgress(cfg, state.lines).matchedLower).toBe(2);
      expect(state.spent.meso).toBe(36000000n);
      expect(state.spent.honor).toBe(110000n);
      expect(state.attempts).toBe(3n);
    },
  );

  it('automatically locks a matching lower starting line and restores its two-lock price', () => {
    const cfg = config();
    cfg.start.lines = ['a', 'd', 'c'].map(option);
    const state = createState(data, cfg);
    expect(state.lockedSlots).toEqual([0, 2]);
    expect(state.spent.meso).toBe(0n);
    const restored = structuredClone({ ...state, status: 'paused' as const });
    const result = draw(cfg, restored, ['a', 'b', 'c']);
    expect(result.status).toBe('success');
    expect(result.spent.meso).toBe(15000000n);
    expect(result.spent.honor).toBe(40000n);
    expect(result.lines[0]).toEqual(state.lines[0]);
  });

  it('charges all three candidates using the baseline locks and retains the earliest equal progress', () => {
    const cfg = config();
    cfg.batchSize = 3;
    let state = draw(
      cfg,
      createState(data, cfg),
      ['a', 'b', 'e'],
      ['a', 'd', 'c'],
      ['a', 'd', 'f'],
    );
    expect(state.lines.map((line) => line.type)).toEqual(['a', 'b', 'e']);
    expect(state.lockedSlots).toEqual([0, 1]);
    expect(state.candidates.map((candidate) => candidate.adopted)).toEqual([true, false, false]);
    expect(state.spent.meso).toBe(18000000n);
    expect(state.spent.honor).toBe(90000n);
    state = draw(cfg, state, ['a', 'b', 'd'], ['a', 'b', 'c'], ['a', 'b', 'f']);
    expect(state.status).toBe('success');
    expect(state.candidates.map((candidate) => candidate.adopted)).toEqual([false, true, false]);
    expect(state.candidates.every((candidate) => candidate.lines[0].type === 'a')).toBe(true);
    expect(state.spent.meso).toBe(63000000n);
    expect(state.spent.honor).toBe(210000n);
    expect(state.attempts).toBe(6n);
  });

  it('prioritizes a complete hit over one acquired secondary line and never creates three locks', () => {
    const cfg = config();
    cfg.batchSize = 3;
    const result = draw(
      cfg,
      createState(data, cfg),
      ['a', 'b', 'd'],
      ['a', 'c', 'b'],
      ['a', 'f', 'c'],
    );
    expect(result.status).toBe('success');
    expect(result.lines.map((line) => line.type)).toEqual(['a', 'c', 'b']);
    expect(result.candidates.map((candidate) => candidate.adopted)).toEqual([false, true, false]);
    expect(result.candidates.every((candidate) => candidate.lockedSlots!.length <= 2)).toBe(true);
    expect(result.lockedSlots).toEqual([0, 1]);
    expect(result.spent.meso).toBe(18000000n);
  });

  it.each([1, 2])(
    'completes a two-goal challenge when its one secondary lands in slot %i',
    (slot) => {
      const cfg = config();
      cfg.target.conditions = cfg.target.conditions.slice(0, 2);
      const tuple = slot === 1 ? ['a', 'b', 'f'] : ['a', 'f', 'b'];
      const result = draw(cfg, createState(data, cfg), tuple);
      expect(result.status).toBe('success');
      expect(result.lockedSlots).toEqual([0, slot]);
      expect(result.lines.map((line) => line.type)).toEqual(tuple);
      expect(result.spent.meso).toBe(6000000n);
      expect(result.spent.honor).toBe(30000n);
    },
  );

  it('recognizes an already complete first-locked starting state without charging or locking three rows', () => {
    const cfg = config();
    cfg.start.lines = ['a', 'c', 'b'].map(option);
    const state = createState(data, cfg);
    expect(state.status).toBe('success');
    expect(state.lockedSlots).toEqual([0, 1]);
    expect(state.attempts).toBe(0n);
    expect(state.spent.meso).toBe(0n);
  });

  it('rejects a nonmatching first target and conflicting manual locks', () => {
    const cfg = config();
    for (const locks of [[], [1], [0, 1]]) {
      cfg.lockedSlots = locks;
      expect(validateConfig(data, cfg).join(' ')).toContain('첫째 줄만 고정');
    }
    cfg.lockedSlots = [0];
    cfg.target.conditions[0].minValue = 2;
    expect(validateConfig(data, cfg).join(' ')).toContain('첫 줄 목표를 만족하지 않습니다');
    cfg.target.conditions[0].minValue = 1;
    cfg.target.conditions[1].slots = [0, 1, 2];
    expect(validateConfig(data, cfg).join(' ')).toContain('보조 목표 한 개 또는 두 개');
  });

  it('identifies both automatic strategies without changing the existing lower-first or fixed strategies', () => {
    const cfg = config();
    expect(usesAbilityProgression(cfg)).toBe(true);
    expect(usesFirstLockedAbility(cfg)).toBe(true);
    expect(usesLowerFirstAbility(cfg)).toBe(false);
    cfg.abilityStrategy = 'lowerFirst';
    cfg.lockedSlots = [];
    expect(usesAbilityProgression(cfg)).toBe(true);
    expect(usesFirstLockedAbility(cfg)).toBe(false);
    expect(usesLowerFirstAbility(cfg)).toBe(true);
    expect(createState(data, cfg).lockedSlots).toEqual([]);
    cfg.abilityStrategy = 'fixed';
    cfg.lockedSlots = [0];
    expect(usesAbilityProgression(cfg)).toBe(false);
    expect(createState(data, cfg).lockedSlots).toEqual([0]);
  });
});
