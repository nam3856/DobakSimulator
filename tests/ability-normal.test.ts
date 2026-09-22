import { describe, expect, it } from 'vitest';
import type { LineGrade, OptionLine, SimulationConfig, SimulationState } from '../src/types';
import {
  allCandidates,
  benchmarkUnit,
  effectiveBatchSize,
  eligibleCandidates,
  type RuleData,
} from '../src/engine/rules';
import {
  attemptCost,
  costValue,
  createState,
  prepareDraw,
  rollBatch,
  validateConfig,
} from '../src/engine/simulation';
import { usesAbilityProgression } from '../src/engine/ability-strategy';
import { paidBenchmarkCost } from '../src/engine/soul-cost';
import { seededRandom } from '../src/engine/math';

const line = (type: string, grade: LineGrade): OptionLine => {
  const value = grade === 'legendary' ? 3 : grade === 'unique' ? 2 : 1;
  return { id: type, abilityTypeId: type, type, value, unit: 'flat', text: `${type} +${value}`, grade };
};
const data: RuleData = {
  potential: { ruleId: 'unused', grades: [], optionPools: [], costBands: [] },
  additional: { ruleId: 'unused', grades: [], optionPools: [], costBands: [] },
  gold: { ruleId: 'unused', grades: [], optionPools: [], costBands: [] },
  soul: {
    ruleId: 'unused', version: 'test', amplificationStages: [], potentialGrades: [],
    potentialResetCosts: { rare: '0', epic: '0', unique: '0', legendary: '0' }, optionStages: [],
  },
  ability: {
    ruleId: 'ordinary-ability-fixture', version: 'test', sourceUrl: 'test',
    advancedLineGrades: [{ legendary: 1 }, { epic: 0.83, unique: 0.15, legendary: 0.02 }, { epic: 0.83, unique: 0.15, legendary: 0.02 }],
    grades: Object.fromEntries(['epic', 'unique', 'legendary'].map((grade) => [grade, {
      options: ['a', 'b', 'c', 'd', 'e'].map((type) => ({
        id: type, type, label: type, weight: 1,
        values: [{ value: line(type, grade as LineGrade).value, label: line(type, grade as LineGrade).text, weight: 1 }],
      })),
    }])),
    costs: [
      { locked: 0, honor: 20000, meso: '2000000' },
      { locked: 1, honor: 30000, meso: '6000000' },
      { locked: 2, honor: 40000, meso: '15000000' },
    ],
  },
};

function config(): SimulationConfig {
  return {
    mode: 'ability', abilityResetMode: 'normal', cubeType: 'black', category: 'weapon', level: 200,
    start: { grade: 'legendary', lines: [line('b', 'legendary'), line('c', 'epic'), line('d', 'unique')], stage: 0, failures: 0 },
    lockedSlots: [], abilityStrategy: 'fixed', batchSize: 1,
    target: { mode: 'ability', minimumGrade: 'legendary', conditions: [{ type: 'a', minValue: 3, minGrade: 'legendary', slot: 0 }], lines: [], stage: 0, match: 'all' },
    ruleVersion: data.ability.ruleId, unitPrices: {},
  };
}

function draw(cfg: SimulationConfig, state: SimulationState, ...tuples: OptionLine[][]) {
  const prepared = prepareDraw(data, cfg, state.grade, state.lines);
  const randoms: number[] = [];
  for (const tuple of tuples) {
    const prefix = [...prepared.fixed.values()];
    for (let slot = 0; slot < 3; slot++) {
      if (prepared.fixed.has(slot)) continue;
      const rows = eligibleCandidates(prepared.candidates[slot], prefix);
      const index = rows.findIndex((row) => row.line.type === tuple[slot].type && row.line.grade === tuple[slot].grade);
      if (index < 0) throw new Error('Requested excluded fixture option');
      randoms.push(rows.slice(0, index).reduce((sum, row) => sum + row.probability, 0) + rows[index].probability / 2);
      prefix.push(rows[index]);
    }
  }
  return rollBatch(data, cfg, state, () => {
    const value = randoms.shift();
    if (value === undefined) throw new Error('Unexpected extra roll');
    return value;
  });
}

describe('ordinary legendary ability reset', () => {
  it.each([[0, 8000], [1, 11000], [2, 16000]])('charges honor only with %i locks', (locks, honor) => {
    const cfg = { ...config(), lockedSlots: Array.from({ length: locks }, (_, slot) => slot) };
    expect(validateConfig(data, cfg)).toEqual([]);
    const cost = attemptCost(data, cfg, 'legendary', 0);
    expect(cost.honor).toBe(BigInt(honor));
    expect(cost.meso).toBe(0n);
    expect(benchmarkUnit(cfg)).toBe('honor');
    expect(costValue(cfg, cost)).toBe(BigInt(honor));
    expect(paidBenchmarkCost(cfg, cost)).toBe(BigInt(honor));
  });

  it('draws a legendary first line and only epic/unique lower lines at 85/15', () => {
    const cfg = config();
    expect(allCandidates(data, cfg, 'legendary', 0).every((row) => row.line.grade === 'legendary')).toBe(true);
    for (const slot of [1, 2]) {
      const rows = allCandidates(data, cfg, 'legendary', slot);
      expect(rows.filter((row) => row.line.grade === 'epic').reduce((sum, row) => sum + row.probability, 0)).toBeCloseTo(0.85, 12);
      expect(rows.filter((row) => row.line.grade === 'unique').reduce((sum, row) => sum + row.probability, 0)).toBeCloseTo(0.15, 12);
      expect(rows.some((row) => row.line.grade === 'legendary')).toBe(false);
    }
  });

  it('immediately adopts misses and excludes only the newly held complete result on the next reset', () => {
    const cfg = config();
    const start = createState(data, cfg);
    const miss = [line('e', 'legendary'), line('b', 'epic'), line('c', 'unique')];
    const next = draw(cfg, start, miss);
    expect(next.lines.map((row) => row.type)).toEqual(['e', 'b', 'c']);
    expect(next.status).toBe('running');
    expect(next.candidates[0].adopted).toBe(true);
    const afterRepeat = draw(cfg, next, miss, cfg.start.lines);
    expect(afterRepeat.lines.map((row) => row.type)).toEqual(['b', 'c', 'd']);
    expect(afterRepeat.attempts).toBe(2n);
    expect(afterRepeat.spent.honor).toBe(16000n);
    expect(afterRepeat.spent.meso).toBe(0n);
    expect(start.attempts).toBe(0n);
  });

  it('stops and adopts a matching first line', () => {
    const cfg = config();
    const next = draw(cfg, createState(data, cfg), [line('a', 'legendary'), line('b', 'epic'), line('c', 'epic')]);
    expect(next.status).toBe('success');
    expect(next.lines[0].type).toBe('a');
    expect(next.attempts).toBe(1n);
  });

  it('preserves locked values and excludes their types from all remaining draws', () => {
    const cfg = { ...config(), lockedSlots: [0, 1] };
    const state = createState(data, cfg);
    const next = draw(cfg, state, [state.lines[0], state.lines[1], line('e', 'unique')]);
    expect(next.lines.slice(0, 2)).toEqual(state.lines.slice(0, 2));
    expect(next.spent.honor).toBe(16000n);
    const prepared = prepareDraw(data, cfg, state.grade, state.lines);
    const rows = eligibleCandidates(prepared.candidates[2], [...prepared.fixed.values()]);
    expect(rows.some((row) => ['b', 'c'].includes(row.line.type))).toBe(false);
    expect(rows.filter((row) => row.line.grade === 'unique').reduce((sum, row) => sum + row.probability, 0)).toBeCloseTo(0.15, 12);
  });

  it('rejects lower legendary locks but allows them to be rerolled while unlocked', () => {
    const cfg = config();
    cfg.start.lines[1] = line('c', 'legendary');
    expect(validateConfig(data, { ...cfg, lockedSlots: [1] }).join(' ')).toContain('둘째·셋째 줄의 레전드리');
    expect(() => prepareDraw(data, { ...cfg, lockedSlots: [1] }, 'legendary', cfg.start.lines)).toThrow('잠글 수 없습니다');
    expect(validateConfig(data, cfg)).toEqual([]);
    const next = draw(cfg, createState(data, cfg), [line('e', 'legendary'), line('c', 'unique'), line('b', 'epic')]);
    expect(next.lines[1].grade).toBe('unique');
  });

  it('preserves imported lower legendary grades even when unique options display the same text', () => {
    const overlap = structuredClone(data);
    const unique = overlap.ability.grades.unique!.options.find((option) => option.type === 'c')!;
    unique.values = [{ value: 3, label: 'c +3', weight: 1 }];
    const cfg = config();
    cfg.start.lines[1] = line('c', 'legendary');
    const state = createState(overlap, cfg);
    expect(state.lines[1].grade).toBe('legendary');
    expect(state.lines[1].text).toBe('c +3');
    expect(() => prepareDraw(overlap, { ...cfg, lockedSlots: [1] }, 'legendary', state.lines)).toThrow('잠글 수 없습니다');
  });

  it('disables advanced progression and triple comparison for normal resets', () => {
    const cfg = { ...config(), batchSize: 3 as const, abilityStrategy: 'lowerFirst' as const };
    expect(effectiveBatchSize(cfg, 'legendary')).toBe(1);
    expect(validateConfig(data, cfg).join(' ')).toContain('1회씩');
    expect(usesAbilityProgression(cfg)).toBe(false);
    expect(usesAbilityProgression({ ...cfg, abilityStrategy: 'firstLocked' })).toBe(false);
  });

  it('keeps omitted mode identical to explicit advanced mode for legacy saves', () => {
    const legacy = { ...config(), abilityResetMode: undefined, batchSize: 3 as const };
    const advanced = { ...legacy, abilityResetMode: 'advanced' as const };
    const before = createState(data, legacy);
    const oldResult = rollBatch(data, legacy, before, seededRandom('advanced-compatibility'));
    const explicitResult = rollBatch(data, advanced, before, seededRandom('advanced-compatibility'));
    expect(oldResult.lines).toEqual(explicitResult.lines);
    expect(oldResult.candidates).toEqual(explicitResult.candidates);
    expect(oldResult.spent).toEqual(explicitResult.spent);
    expect(oldResult.attempts).toBe(3n);
    expect(oldResult.spent.meso).toBe(6000000n);
  });
});
