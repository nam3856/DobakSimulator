import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { optimizeAbilityCost, type AbilityOptimizerInput } from '../src/engine/ability-optimizer';
import { allCandidates, type RuleData } from '../src/engine/rules';
import { seededRandom } from '../src/engine/math';
import type { OptionLine, SimulationConfig } from '../src/types';

const empty = { ruleId: 'unused', grades: [], optionPools: [], costBands: [] };
function fixture(variable = false): RuleData {
  const maxima = [0.5, 0.25, 0.75, 0.6, 1];
  return {
    potential: empty,
    additional: empty,
    gold: empty,
    soul: {
      ruleId: 'unused',
      version: 'test',
      amplificationStages: [],
      potentialGrades: [],
      potentialResetCosts: { rare: '0', epic: '0', unique: '0', legendary: '0' },
      optionStages: [],
    },
    ability: {
      ruleId: 'optimizer-test',
      version: 'test',
      sourceUrl: 'test',
      advancedLineGrades: [{ legendary: 1 }, { legendary: 1 }, { legendary: 1 }],
      grades: {
        legendary: {
          options: ['a', 'b', 'c', 'd', 'e'].map((type, index) => ({
            id: type,
            type,
            label: type,
            weight: 1,
            values: variable
              ? [
                  ...(maxima[index] < 1
                    ? [{ value: 1, label: `${type} 1`, weight: 1 - maxima[index] }]
                    : []),
                  { value: 2, label: `${type} 2`, weight: maxima[index] },
                ]
              : [{ value: 1, label: `${type} 1`, weight: 1 }],
          })),
        },
      },
      costs: [
        { locked: 0, honor: 20, meso: '2' },
        { locked: 1, honor: 30, meso: '6' },
        { locked: 2, honor: 40, meso: '15' },
      ],
    },
  };
}
const line = (type: string, value = 1): OptionLine => ({
  id: type,
  abilityTypeId: type,
  type,
  value,
  text: `${type} ${value}`,
  unit: 'flat',
  grade: 'legendary',
});
function input(
  start = ['a', 'd', 'e'].map((type) => line(type)),
  batchSize: 1 | 3 = 1,
): AbilityOptimizerInput {
  return { start, targetTypes: ['a', 'b', 'c'], medalPrice: 5000, circulatorPrice: 10, batchSize };
}

/** Independent tiny model: ordered tuple and batch enumeration, fixed first-subset
 * acquisition, success priority, earliest ties, and retained-baseline rejection. */
function oracle(batchSize: number, mask: number, start: string[]) {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const cache = new Map<string, { resets: number; meso: number; honor: number }>();
  const win = (lines: string[]) => ['a', 'b', 'c'].every((type) => lines.includes(type));
  const locksFor = (lines: string[], firstMask: number) => {
    const slots = [1, 2].filter((slot) => ['a', 'b', 'c'].includes(lines[slot]));
    return slots.some((slot) => firstMask & (1 << names.indexOf(lines[slot]))) ? slots : [];
  };
  function solve(
    lines: string[],
    locks: number[],
    firstMask: number,
  ): { resets: number; meso: number; honor: number } {
    if (win(lines)) return { resets: 0, meso: 0, honor: 0 };
    const key = `${lines.join(',')}:${locks.join(',')}:${firstMask}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const tuples: string[][] = [];
    function draw(index: number, current: string[], used: string[]) {
      if (index === 3) {
        if (current.join(',') !== lines.join(',')) tuples.push(current);
        return;
      }
      if (locks.includes(index)) {
        draw(index + 1, current, used);
        return;
      }
      for (const name of names.filter((type) => !used.includes(type))) {
        const next = [...current];
        next[index] = name;
        draw(index + 1, next, [...used, name]);
      }
    }
    draw(
      0,
      [...lines],
      locks.map((slot) => lines[slot]),
    );
    const rank = (tuple: string[]) => (win(tuple) ? 3 : locksFor(tuple, firstMask).length);
    const transitions = new Map<string, { lines: string[]; count: number }>();
    function batch(index: number, best: string[]) {
      if (index === batchSize) {
        const key = best.join(',');
        const old = transitions.get(key);
        if (old) old.count++;
        else transitions.set(key, { lines: best, count: 1 });
        return;
      }
      for (const tuple of tuples) batch(index + 1, rank(tuple) > rank(best) ? tuple : best);
    }
    batch(0, lines);
    const result = {
      resets: batchSize,
      meso: batchSize * [2, 6, 15][locks.length],
      honor: batchSize * [20, 30, 40][locks.length],
    };
    const total = tuples.length ** batchSize;
    let leave = 0;
    for (const [to, transition] of transitions) {
      if (to === lines.join(',')) continue;
      const p = transition.count / total;
      leave += p;
      const nextLocks = locksFor(transition.lines, firstMask);
      const future = solve(transition.lines, nextLocks, 7);
      result.resets += p * future.resets;
      result.meso += p * future.meso;
      result.honor += p * future.honor;
    }
    result.resets /= leave;
    result.meso /= leave;
    result.honor /= leave;
    cache.set(key, result);
    return result;
  }
  return solve(start, locksFor(start, mask), mask);
}

describe('ability acquisition and circulator strategy optimizer', () => {
  it('matches independently drawn variable-value full paths including lower circulation and ordered batches', () => {
    const rules = fixture(true);
    const cfg = input([line('d'), line('e', 2), line('a')], 3);
    const result = optimizeAbilityCost(rules, cfg);
    const names = ['a', 'b', 'c', 'd', 'e'];
    const maxima = [0.5, 0.25, 0.75, 0.6, 1];
    type Tuple = { type: string; value: number }[];
    const trials = 6000;
    for (const [timing, mask] of [
      ['direct', 7],
      ['lower', 7],
      ['all', 7],
      ['lower', 4],
    ] as const) {
      const rng = seededRandom(`optimizer-independent-${timing}-${mask}`);
      const sums = { resets: 0, meso: 0, honor: 0, circles: 0 };
      const types = (tuple: Tuple) =>
        ['a', 'b', 'c'].every((type) => tuple.some((line) => line.type === type));
      const win = (tuple: Tuple) => types(tuple) && tuple.every((line) => line.value === 2);
      const locks = (tuple: Tuple, accepted: number) => {
        const slots = [1, 2].filter(
          (slot) =>
            names.indexOf(tuple[slot].type) < 3 && (timing !== 'direct' || tuple[slot].value === 2),
        );
        return slots.some((slot) => accepted & (1 << names.indexOf(tuple[slot].type))) ? slots : [];
      };
      const identity = (tuple: Tuple) => tuple.map((line) => `${line.type}${line.value}`).join(',');
      const value = (type: string) => (rng() < maxima[names.indexOf(type)] ? 2 : 1);
      for (let n = 0; n < trials; n++) {
        let current: Tuple = cfg.start.map((line) => ({ type: line.type, value: line.value }));
        let accepted = mask;
        let fixed = locks(current, accepted);
        if (fixed.length) accepted = 7;
        let iterations = 0;
        while (!win(current)) {
          if (++iterations > 10000) throw new Error('small independent model failed to terminate');
          const circulation =
            (timing === 'all' && types(current)) ||
            (timing === 'lower' &&
              fixed.length === 2 &&
              fixed.some((slot) => current[slot].value !== 2));
          if (circulation) {
            let next: Tuple;
            do next = current.map((line) => ({ type: line.type, value: value(line.type) }));
            while (identity(next) === identity(current));
            sums.circles++;
            if (timing === 'all' ? win(next) : fixed.every((slot) => next[slot].value === 2))
              current = next;
            continue;
          }
          sums.resets += 3;
          sums.meso += 3 * [2, 6, 15][fixed.length];
          sums.honor += 3 * [20, 30, 40][fixed.length];
          const rank = (tuple: Tuple) =>
            win(tuple)
              ? 4
              : timing === 'all' && types(tuple)
                ? 3
                : timing === 'lower' && types(tuple)
                  ? 2
                  : locks(tuple, accepted).length;
          let best = current;
          for (let i = 0; i < 3; i++) {
            let next: Tuple;
            do {
              next = current.map((line) => ({ ...line }));
              const used = fixed.map((slot) => current[slot].type);
              for (const slot of [0, 1, 2].filter((slot) => !fixed.includes(slot))) {
                const pool = names.filter((type) => !used.includes(type));
                const type = pool[Math.floor(rng() * pool.length)];
                next[slot] = { type, value: value(type) };
                used.push(type);
              }
            } while (identity(next) === identity(current));
            if (rank(next) > rank(best)) best = next;
          }
          current = best;
          fixed = timing === 'lower' && types(current) ? [1, 2] : locks(current, accepted);
          if (fixed.length) accepted = 7;
        }
      }
      const row = result.strategies.find((row) => row.id === `${timing}-${mask}`)!;
      for (const [actual, expected] of [
        [sums.resets / trials, row.expectedResets],
        [sums.meso / trials, row.expectedMeso],
        [sums.honor / trials, row.expectedHonor],
        [sums.circles / trials, row.expectedCirculators],
      ]) {
        if (expected === 0) expect(actual).toBe(0);
        else expect(Math.abs(actual / expected - 1)).toBeLessThan(0.06);
      }
    }
  });

  it('compares preserving an existing maximum first line and reprices cached resource expectations', () => {
    const rules = fixture(true);
    const cfg = input([line('a', 2), line('b', 2), line('c')], 3);
    const result = optimizeAbilityCost(rules, cfg);
    const keeper = result.strategies.find((row) => row.id === 'keep-first-max')!;
    const attempts = 3 / (1 - (1 - 3 / 11) ** 3);
    expect(result.strategies).toHaveLength(16);
    expect(keeper.expectedResets).toBeCloseTo(attempts, 10);
    expect(keeper.expectedMeso).toBeCloseTo(attempts * 15, 10);
    expect(keeper.expectedHonor).toBeCloseTo(attempts * 40, 10);
    expect(keeper.expectedCirculators).toBe(0);
    const inexpensive = optimizeAbilityCost(rules, { ...cfg, circulatorPrice: 1 });
    expect(inexpensive.bestStrategyId).toBe('current-types-circulator');
    const circulator = inexpensive.strategies[0];
    // Even a maximum a/b value must be drawn again, and the entire current tuple is excluded.
    const expectedCirculators = (1 - 0.5 * 0.25 * 0.25) / (0.5 * 0.25 * 0.75);
    expect(circulator.expectedCirculators).toBeCloseTo(expectedCirculators, 12);
    expect(circulator.totalCost).toBeCloseTo(expectedCirculators, 12);
    const expensive = optimizeAbilityCost(rules, {
      ...cfg,
      medalPrice: 25000,
      circulatorPrice: 1e15,
    });
    expect(expensive.strategies[0].expectedCirculators).toBe(0);
    for (const row of expensive.strategies) {
      const original = result.strategies.find((old) => old.id === row.id)!;
      expect(row.expectedResets).toBe(original.expectedResets);
      expect(row.expectedMeso).toBe(original.expectedMeso);
      expect(row.expectedHonor).toBe(original.expectedHonor);
      expect(row.expectedCirculators).toBe(original.expectedCirculators);
      expect(row.totalCost).toBe(
        row.expectedMeso + (row.expectedHonor / 5000) * 25000 + row.expectedCirculators * 1e15,
      );
    }
  });

  it('reports unreachable legendary lower goals as Infinity even when both item prices are zero', () => {
    const rules = fixture();
    rules.ability.grades.unique = structuredClone(rules.ability.grades.legendary!);
    rules.ability.advancedLineGrades = [{ legendary: 1 }, { unique: 1 }, { unique: 1 }];
    const cfg = input([
      line('d'),
      { ...line('a'), grade: 'unique' },
      { ...line('e'), grade: 'unique' },
    ]);
    const result = optimizeAbilityCost(rules, { ...cfg, medalPrice: 0, circulatorPrice: 0 });
    expect(
      result.strategies.every((row) => row.status === 'impossible' && row.totalCost === Infinity),
    ).toBe(true);
    expect(result.bestStrategyId).toBeUndefined();
  });

  it.each([1, 3] as const)(
    'matches an independent ordered reset model with %i comparisons and each first-acceptance subset',
    (batchSize) => {
      const result = optimizeAbilityCost(fixture(), input(undefined, batchSize));
      expect(result.strategies).toHaveLength(22);
      for (const mask of [1, 2, 3, 4, 5, 6, 7]) {
        const expected = oracle(batchSize, mask, ['a', 'd', 'e']);
        for (const timing of ['direct', 'lower', 'all']) {
          const row = result.strategies.find((row) => row.id === `${timing}-${mask}`)!;
          expect(row.expectedResets).toBeCloseTo(expected.resets, 9);
          expect(row.expectedMeso).toBeCloseTo(expected.meso, 9);
          expect(row.expectedHonor).toBeCloseTo(expected.honor, 9);
          expect(row.expectedCirculators).toBe(0);
          expect(row.totalCost).toBeCloseTo(expected.meso + expected.honor, 9);
        }
      }
    },
  );

  it.each([1, 3] as const)(
    'offers one circulation-only path for current types in any order, independent of %i-reset comparisons',
    (batchSize) => {
      const rules = fixture(true);
      const expected = (1 - 0.5 * 0.75 * 0.25) / (0.5 * 0.25 * 0.75);
      for (const types of [
        ['a', 'b', 'c'],
        ['c', 'a', 'b'],
      ]) {
        const result = optimizeAbilityCost(
          rules,
          input(
            types.map((type) => line(type)),
            batchSize,
          ),
        );
        expect(result.strategies).toHaveLength(15);
        expect(result.strategies.filter((row) => row.id.startsWith('all-'))).toHaveLength(0);
        expect(result.strategies.filter((row) => row.id.startsWith('direct-'))).toHaveLength(7);
        expect(result.strategies.filter((row) => row.id.startsWith('lower-'))).toHaveLength(7);
        const rows = result.strategies.filter((row) => row.id === 'current-types-circulator');
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.status).toBe('ready');
        expect(row.expectedResets).toBe(0);
        expect(row.expectedHonor).toBe(0);
        expect(row.expectedMeso).toBe(0);
        expect(row.expectedCirculators).toBeCloseTo(expected, 12);
        expect(row.totalCost).toBeCloseTo(expected * 10, 12);
      }
    },
  );

  it('requires every current target type to be legendary before offering circulation alone', () => {
    const rules = fixture(true);
    rules.ability.grades.unique = structuredClone(rules.ability.grades.legendary!);
    rules.ability.advancedLineGrades = [
      { legendary: 1 },
      { legendary: 0.5, unique: 0.5 },
      { legendary: 0.5, unique: 0.5 },
    ];
    for (const start of [
      [line('a'), line('b'), { ...line('c'), grade: 'unique' as const }],
      [line('a'), line('b'), line('d')],
    ]) {
      const result = optimizeAbilityCost(rules, input(start));
      expect(result.strategies.some((row) => row.id === 'current-types-circulator')).toBe(false);
      expect(result.strategies.filter((row) => row.id.startsWith('all-'))).toHaveLength(7);
    }
  });

  it('uses the best value direction for a lower-is-better target without charging completed starts', () => {
    const rules = fixture(true);
    rules.ability.grades.legendary!.options[0].valueDirection = 'lower';
    const result = optimizeAbilityCost(rules, input(['a', 'b', 'c'].map((type) => line(type, 2))));
    const row = result.strategies.find((row) => row.id === 'current-types-circulator')!;
    expect(row.expectedResets).toBe(0);
    expect(row.expectedCirculators).toBeCloseTo((1 - 0.5 * 0.25 * 0.75) / (0.5 * 0.25 * 0.75), 12);
    const completed = optimizeAbilityCost(rules, input([line('a'), line('b', 2), line('c', 2)]));
    expect(completed.strategies.some((row) => row.id === 'current-types-circulator')).toBe(false);
    expect(
      completed.strategies.every((row) => row.status === 'already' && row.totalCost === 0),
    ).toBe(true);
  });

  it.each([1, 3] as const)(
    'circulates both lower values together then averages the changed first value for %i-comparison resets',
    (batchSize) => {
      const result = optimizeAbilityCost(
        fixture(true),
        input(
          ['d', 'b', 'c'].map((type) => line(type)),
          batchSize,
        ),
      );
      const row = result.strategies.find((row) => row.id === 'lower-7')!;
      const q = 1 / 6;
      const attempts = (repeat: number) => batchSize / (1 - (1 - q / (1 - repeat)) ** batchSize);
      const resets = 0.4 * attempts(0.4 / 3) + 0.6 * attempts(0.6 / 3);
      expect(row.expectedCirculators).toBeCloseTo((1 - 0.4 * 0.75 * 0.25) / (0.25 * 0.75), 10);
      expect(row.expectedResets).toBeCloseTo(resets, 10);
      expect(row.expectedMeso).toBeCloseTo(resets * 15, 10);
      expect(row.expectedHonor).toBeCloseTo(resets * 40, 10);
    },
  );

  it('recognizes free completion in any order, validates target and prices, and ranks only its explicit comparisons', () => {
    const rules = fixture(true);
    const result = optimizeAbilityCost(rules, input(['c', 'a', 'b'].map((type) => line(type, 2))));
    expect(result.strategies).toHaveLength(22);
    expect(result.strategies.some((row) => row.id === 'current-types-circulator')).toBe(false);
    expect(result.strategies.every((row) => row.status === 'already' && row.totalCost === 0)).toBe(
      true,
    );
    expect(result.bestStrategyId).toBe(result.strategies[0].id);
    expect(result.notes[0]).toContain('전역 최적해는 아닙니다');
    expect(() => optimizeAbilityCost(rules, { ...input(), medalPrice: NaN })).toThrow('가격');
    expect(() => optimizeAbilityCost(rules, { ...input(), circulatorPrice: -1 })).toThrow('가격');
    expect(() => optimizeAbilityCost(rules, { ...input(), targetTypes: ['a', 'a', 'c'] })).toThrow(
      '서로 다른',
    );
  });

  it('handles official three-grade pools without replaying rare failures', () => {
    const rules = fixture();
    rules.ability = JSON.parse(
      readFileSync(new URL('../public/rules/ability.json', import.meta.url), 'utf8'),
    );
    const cfg = { mode: 'ability' } as SimulationConfig;
    const start = ['strFlat', 'dexFlat', 'intFlat'].map(
      (type, slot) =>
        allCandidates(rules, cfg, 'legendary', slot).find((row) => row.line.type === type)!.line,
    );
    const began = performance.now();
    const result = optimizeAbilityCost(rules, {
      ...input(start, 3),
      targetTypes: ['passiveSkillLevel', 'bossDamagePercent', 'statusAilmentDamagePercent'],
    });
    expect(result.strategies).toHaveLength(21);
    expect(result.strategies.every((row) => row.status === 'ready' && row.totalCost > 0)).toBe(
      true,
    );
    expect(result.bestStrategyId).toBe(result.strategies[0].id);
    expect(performance.now() - began).toBeLessThan(25000);
  }, 30000);
});
