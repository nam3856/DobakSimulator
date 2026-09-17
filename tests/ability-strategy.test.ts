import { describe, expect, it } from 'vitest';
import type { OptionLine, SimulationConfig, SimulationState } from '../src/types';
import {
  abilityConfigForState,
  abilityProgress,
  usesLowerFirstAbility,
} from '../src/engine/ability-strategy';
import { eligibleCandidates, type RuleData } from '../src/engine/rules';
import { createState, prepareDraw, rollBatch, validateConfig } from '../src/engine/simulation';
import { matchTarget } from '../src/engine/target';

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
    lockedSlots: [],
    abilityStrategy: 'lowerFirst',
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

/** Select explicit legal outcomes; assertions test progression, retention and charging. */
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
      if (prepared.fixed.has(slot)) continue;
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

describe('lower-line-first ability progression', () => {
  it('adopts lower-line progress, retains misses, and only pursues the first line after both locks', () => {
    const cfg = config();
    let state = createState(data, cfg);
    expect(state.lockedSlots).toEqual([]);
    state = draw(cfg, state, ['d', 'b', 'e']);
    expect(state.lockedSlots).toEqual([1]);
    expect(state.lines.map((line) => line.type)).toEqual(['d', 'b', 'e']);
    expect(state.candidates[0]).toMatchObject({ progressed: true, adopted: true, hit: false });
    state = draw(cfg, state, ['e', 'b', 'd']);
    expect(state.lines.map((line) => line.type)).toEqual(['d', 'b', 'e']);
    expect(state.candidates[0].adopted).toBe(false);
    state = draw(cfg, state, ['d', 'b', 'c']);
    expect(state.lockedSlots).toEqual([1, 2]);
    state = draw(cfg, state, ['e', 'b', 'c']);
    expect(state.lines.map((line) => line.type)).toEqual(['d', 'b', 'c']);
    state = draw(cfg, state, ['a', 'b', 'c']);
    expect(state.status).toBe('success');
    expect(state.spent.meso).toBe(44000000n);
    expect(state.spent.honor).toBe(160000n);
    expect(state.attempts).toBe(5n);
    expect(cfg.lockedSlots).toEqual([]);
  });

  it('locks already matching secondary lines for free in either order, never the first line', () => {
    const cfg = config();
    cfg.start.lines = ['d', 'c', 'b'].map(option);
    const state = createState(data, cfg);
    expect(state.lockedSlots).toEqual([1, 2]);
    expect(state.spent.meso).toBe(0n);
    expect(state.attempts).toBe(0n);
    const next = draw(cfg, state, ['a', 'c', 'b']);
    expect(next.status).toBe('success');
    expect(next.spent.meso).toBe(15000000n);
    expect(next.lockedSlots).toEqual([1, 2]);
  });

  it('charges all three at the pre-batch lock count and adopts the earliest greatest progress', () => {
    const cfg = config();
    cfg.batchSize = 3;
    const state = draw(
      cfg,
      createState(data, cfg),
      ['d', 'b', 'e'],
      ['d', 'b', 'c'],
      ['e', 'c', 'b'],
    );
    expect(state.spent.meso).toBe(6000000n);
    expect(state.spent.honor).toBe(60000n);
    expect(state.attempts).toBe(3n);
    expect(state.lines.map((line) => line.type)).toEqual(['d', 'b', 'c']);
    expect(state.candidates.map((result) => result.adopted)).toEqual([false, true, false]);
    expect(state.lockedSlots).toEqual([1, 2]);
  });

  it('prioritizes a full goal over progress and still charges the other two comparisons', () => {
    const cfg = config();
    cfg.batchSize = 3;
    const state = draw(
      cfg,
      createState(data, cfg),
      ['d', 'b', 'c'],
      ['a', 'c', 'b'],
      ['e', 'b', 'c'],
    );
    expect(state.status).toBe('success');
    expect(state.lines.map((line) => line.type)).toEqual(['a', 'c', 'b']);
    expect(state.candidates.map((result) => result.adopted)).toEqual([false, true, false]);
    expect(state.spent.meso).toBe(6000000n);
  });

  it('keeps an early first-line success without lower progress from becoming a lock', () => {
    const cfg = config();
    cfg.start.lines = ['d', 'e', 'f'].map(option);
    const state = draw(cfg, createState(data, cfg), ['a', 'e', 'f']);
    expect(state.lines.map((line) => line.type)).toEqual(['d', 'e', 'f']);
    expect(state.lockedSlots).toEqual([]);
    expect(state.status).toBe('running');
  });

  it('respects secondary slot, grade, and value restrictions and cannot reuse one line twice', () => {
    const cfg = config();
    const low = { ...option('b'), grade: 'unique' as const };
    expect(abilityProgress(cfg, [option('a'), low, option('d')]).matchedLower).toBe(0);
    cfg.target.conditions[1].minValue = 2;
    expect(abilityProgress(cfg, [option('a'), option('b'), option('d')]).matchedLower).toBe(0);
    cfg.target.conditions[1].minValue = 1;
    cfg.target.conditions[1].slots = [1];
    expect(abilityProgress(cfg, [option('a'), option('d'), option('b')]).matchedLower).toBe(0);
    cfg.target.conditions[1].slots = [1, 2];
    cfg.target.conditions[2] = { ...cfg.target.conditions[1] };
    const lines = ['a', 'b', 'd'].map(option);
    expect(abilityProgress(cfg, lines).matchedLower).toBe(1);
    expect(matchTarget(cfg.target, { grade: 'legendary', lines, stage: 0 })).toBe(false);
  });

  it('rejects conflicting manual locks or malformed lower-first goals and keeps legacy fixed behavior', () => {
    const cfg = config();
    expect(validateConfig(data, cfg)).toEqual([]);
    cfg.lockedSlots = [0];
    expect(validateConfig(data, cfg).join(' ')).toContain('수동 잠금');
    cfg.lockedSlots = [];
    cfg.target.conditions[1].slots = [0, 1, 2];
    expect(validateConfig(data, cfg).join(' ')).toContain('목표 두 개');
    const legacy = config();
    delete legacy.abilityStrategy;
    expect(usesLowerFirstAbility(legacy)).toBe(false);
    const state = draw(legacy, createState(data, legacy), ['d', 'b', 'e']);
    expect(state.lines.map((line) => line.type)).toEqual(['a', 'd', 'e']);
    expect(state.lockedSlots).toEqual([]);
  });

  it('continues a restored challenge with its acquired locks and prices', () => {
    const cfg = config();
    const acquired = draw(cfg, createState(data, cfg), ['d', 'e', 'c']);
    const restored = structuredClone({ ...acquired, status: 'paused' as const });
    const next = draw(cfg, restored, ['d', 'b', 'c']);
    expect(next.lockedSlots).toEqual([1, 2]);
    expect(next.spent.meso).toBe(8000000n);
    expect(restored.lockedSlots).toEqual([2]);
  });
});
