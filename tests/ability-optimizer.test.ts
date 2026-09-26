import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  optimizeAbilityCost,
  type AbilityOptimizerInput,
  type AbilityOptimizerTarget,
} from '../src/engine/ability-optimizer';
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

/** Tiny, independent full-tuple oracle: no production candidates, compression or phase caches. */
function mixedDirectOracle(
  rules: RuleData,
  cfg: AbilityOptimizerInput,
  targets: AbilityOptimizerTarget[],
) {
  const rank = { normal: 0, rare: 1, epic: 2, unique: 3, legendary: 4 };
  const goals = targets.map((target) => {
    const option = rules.ability.grades[target.grade]!.options.find(
      (row) => row.type === target.type,
    )!;
    const best = option.values.reduce((a, b) =>
      (option.valueDirection === 'lower' ? b.value < a.value : b.value > a.value) ? b : a,
    );
    return { ...target, threshold: best.value, lower: option.valueDirection === 'lower' };
  });
  const matches = (value: OptionLine) =>
    goals.some(
      (goal) =>
        value.type === goal.type &&
        rank[value.grade] >= rank[goal.grade] &&
        (goal.lower ? value.value <= goal.threshold : value.value >= goal.threshold),
    );
  const identity = (lines: OptionLine[]) =>
    lines.map((line) => line.text.replace(/\s/g, '')).join('|');
  const cache = new Map<string, { resets: number; meso: number; honor: number }>();
  function solve(lines: OptionLine[]): { resets: number; meso: number; honor: number } {
    const locks = [0, 1, 2].filter((slot) => matches(lines[slot]));
    if (locks.length === goals.length) return { resets: 0, meso: 0, honor: 0 };
    const key = JSON.stringify(lines.map((line) => [line.type, line.grade, line.value]));
    const cached = cache.get(key);
    if (cached) return cached;
    const outcomes: { lines: OptionLine[]; p: number; rank: number }[] = [];
    function draw(slot: number, next: OptionLine[], used: string[], p: number) {
      if (slot === 3) {
        if (identity(next) !== identity(lines))
          outcomes.push({ lines: [...next], p, rank: next.filter(matches).length });
        return;
      }
      if (locks.includes(slot)) {
        draw(slot + 1, next, used, p);
        return;
      }
      for (const [grade, gradeP] of Object.entries(rules.ability.advancedLineGrades[slot])) {
        const eligible = rules.ability.grades[grade as OptionLine['grade']]!.options.filter(
          (option) => !used.includes(option.type!),
        );
        const optionTotal = eligible.reduce((sum, option) => sum + option.weight, 0);
        for (const option of eligible) {
          const valueTotal = option.values.reduce((sum, value) => sum + value.weight, 0);
          for (const value of option.values) {
            const row: OptionLine = {
              id: option.id,
              abilityTypeId: option.id,
              type: option.type!,
              grade: grade as OptionLine['grade'],
              value: value.value,
              text: value.label,
              unit: 'flat',
            };
            next[slot] = row;
            draw(
              slot + 1,
              next,
              [...used, option.type!],
              (((p * gradeP! * option.weight) / optionTotal) * value.weight) / valueTotal,
            );
          }
        }
      }
    }
    draw(
      0,
      [...lines],
      locks.map((slot) => lines[slot].type),
      1,
    );
    const total = outcomes.reduce((sum, outcome) => sum + outcome.p, 0);
    const progress = outcomes.filter((outcome) => outcome.rank > locks.length);
    const leave =
      1 - (1 - progress.reduce((sum, outcome) => sum + outcome.p / total, 0)) ** cfg.batchSize;
    const price = rules.ability.costs.find((price) => price.locked === locks.length)!;
    const result = {
      resets: cfg.batchSize,
      meso: cfg.batchSize * Number(price.meso),
      honor: cfg.batchSize * price.honor,
    };
    for (const outcome of progress) {
      const below = outcomes
        .filter((row) => row.rank < outcome.rank)
        .reduce((sum, row) => sum + row.p / total, 0);
      const same = outcomes
        .filter((row) => row.rank === outcome.rank)
        .reduce((sum, row) => sum + row.p / total, 0);
      const chance =
        (((below + same) ** cfg.batchSize - below ** cfg.batchSize) * (outcome.p / total)) / same;
      const future = solve(outcome.lines);
      result.resets += chance * future.resets;
      result.meso += chance * future.meso;
      result.honor += chance * future.honor;
    }
    for (const field of ['resets', 'meso', 'honor'] as const) result[field] /= leave;
    cache.set(key, result);
    return result;
  }
  return solve(cfg.start);
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
  it.each([1, 3] as const)(
    'solves one and two unrestricted-slot goals analytically with %i comparisons',
    (batchSize) => {
      const rules = fixture();
      const cfg = input(
        ['c', 'd', 'e'].map((type) => line(type)),
        batchSize,
      );
      const one = optimizeAbilityCost(rules, {
        ...cfg,
        targets: [{ type: 'a', grade: 'legendary' }],
      });
      const directOne = one.strategies.find((row) => row.id === 'direct-1')!;
      const oneAttempts = batchSize / (1 - (23 / 59) ** batchSize);
      expect(directOne.expectedResets).toBeCloseTo(oneAttempts, 10);
      expect(directOne.expectedMeso).toBeCloseTo(oneAttempts * 2, 10);
      expect(directOne.expectedHonor).toBeCloseTo(oneAttempts * 20, 10);
      expect(directOne.policy).toMatchObject({ kind: 'acquire', lockSlots: [0, 1, 2] });
      const two = optimizeAbilityCost(rules, {
        ...cfg,
        targets: [
          { type: 'a', grade: 'legendary' },
          { type: 'b', grade: 'legendary' },
        ],
      });
      const directTwo = two.strategies.find((row) => row.id === 'direct-3')!;
      const firstAttempts = batchSize / (1 - (5 / 59) ** batchSize);
      const remainingChance =
        ((41 / 59) ** batchSize - (5 / 59) ** batchSize) / (1 - (5 / 59) ** batchSize);
      const finalAttempts = batchSize / (1 - (5 / 11) ** batchSize);
      expect(directTwo.expectedResets).toBeCloseTo(
        firstAttempts + remainingChance * finalAttempts,
        10,
      );
      expect(directTwo.expectedMeso).toBeCloseTo(
        firstAttempts * 2 + remainingChance * finalAttempts * 6,
        10,
      );
      expect(directTwo.expectedHonor).toBeCloseTo(
        firstAttempts * 20 + remainingChance * finalAttempts * 30,
        10,
      );
      expect(two.strategies.some((row) => row.id.startsWith('lower-'))).toBe(false);
    },
  );

  it('includes ignored lines in circulation exclusion for one and two selected goals', () => {
    const rules = fixture(true);
    const one = optimizeAbilityCost(rules, {
      ...input([line('a'), line('d'), line('e', 2)]),
      targets: [{ type: 'a', grade: 'legendary' }],
    });
    const oneCurrent = one.strategies.find((row) => row.id === 'current-types-circulator')!;
    expect(oneCurrent.expectedCirculators).toBeCloseTo(1.6, 12);
    expect(oneCurrent.expectedResets).toBe(0);
    const two = optimizeAbilityCost(rules, {
      ...input([line('a'), line('b'), line('e', 2)]),
      targets: [
        { type: 'a', grade: 'legendary' },
        { type: 'b', grade: 'legendary' },
      ],
    });
    expect(
      two.strategies.find((row) => row.id === 'current-types-circulator')!.expectedCirculators,
    ).toBeCloseTo(5, 12);
  });

  it('accepts stronger grades for unique goals only when their values also meet the threshold', () => {
    const rules = fixture();
    rules.ability.grades.unique = structuredClone(rules.ability.grades.legendary!);
    rules.ability.advancedLineGrades = [
      { legendary: 1 },
      { unique: 0.5, legendary: 0.5 },
      { unique: 0.5, legendary: 0.5 },
    ];
    rules.ability.grades.unique.options[0].values = [
      { value: 1, label: 'a 1', weight: 0.75 },
      { value: 2, label: 'a 2', weight: 0.25 },
    ];
    const legendary = rules.ability.grades.legendary!.options[0];
    legendary.values = [
      { value: 2, label: 'a 2', weight: 0.5 },
      { value: 3, label: 'a 3', weight: 0.5 },
    ];
    const targets = [{ type: 'a', grade: 'unique' }] as AbilityOptimizerTarget[];
    const cfg = {
      ...input([line('c'), { ...line('d'), grade: 'unique' }, { ...line('e'), grade: 'unique' }]),
      targets,
    };
    expect(
      optimizeAbilityCost(rules, cfg).strategies.find((row) => row.id === 'direct-1')!
        .expectedResets,
    ).toBeCloseTo(59 / 27, 10);
    const lowerValues = structuredClone(rules);
    lowerValues.ability.grades.legendary!.options[0].values[0] = {
      value: 1,
      label: 'a 1',
      weight: 0.5,
    };
    expect(
      optimizeAbilityCost(lowerValues, cfg).strategies.find((row) => row.id === 'direct-1')!
        .expectedResets,
    ).toBeCloseTo(59 / 15, 10);
    const incomplete = optimizeAbilityCost(lowerValues, {
      ...cfg,
      start: [line('a'), line('d'), line('e')],
    });
    expect(incomplete.strategies.every((row) => row.status !== 'already')).toBe(true);
    expect(
      incomplete.strategies.find((row) => row.id === 'current-types-circulator')!
        .expectedCirculators,
    ).toBeCloseTo(1, 12);
    const completed = optimizeAbilityCost(lowerValues, {
      ...cfg,
      start: [line('a', 3), line('d'), line('e')],
    });
    expect(
      completed.strategies.every((row) => row.status === 'already' && row.totalCost === 0),
    ).toBe(true);
  });

  it('removes same-visible successes as well as repeats when different grades share displayed text', () => {
    const rules = fixture();
    rules.ability.grades.epic = structuredClone(rules.ability.grades.legendary!);
    rules.ability.grades.unique = structuredClone(rules.ability.grades.legendary!);
    rules.ability.advancedLineGrades = [
      { legendary: 1 },
      { epic: 0.5, unique: 0.5 },
      { epic: 0.5, unique: 0.5 },
    ];
    const cfg = {
      ...input([line('c'), { ...line('a'), grade: 'epic' }, { ...line('e'), grade: 'epic' }]),
      targets: [{ type: 'a', grade: 'unique' }] as AbilityOptimizerTarget[],
    };
    expect(
      optimizeAbilityCost(rules, cfg).strategies.find((row) => row.id === 'direct-1')!
        .expectedResets,
    ).toBeCloseTo(118 / 47, 10);
  });

  it.each([1, 3] as const)(
    'matches an independent full-state oracle for three mixed-grade goals with %i comparisons',
    (batchSize) => {
      const rules = fixture();
      rules.ability.grades.unique = structuredClone(rules.ability.grades.legendary!);
      for (const grade of ['unique', 'legendary'] as const)
        for (const option of rules.ability.grades[grade]!.options.slice(0, 3))
          option.values =
            grade === 'unique'
              ? [
                  { value: 1, label: `${option.type} 1`, weight: 0.5 },
                  { value: 2, label: `${option.type} 2`, weight: 0.5 },
                ]
              : [
                  { value: 2, label: `${option.type} 2`, weight: 0.5 },
                  { value: 3, label: `${option.type} 3`, weight: 0.5 },
                ];
      rules.ability.advancedLineGrades = [
        { legendary: 1 },
        { unique: 0.5, legendary: 0.5 },
        { unique: 0.5, legendary: 0.5 },
      ];
      const targets = [
        { type: 'a', grade: 'legendary' },
        { type: 'b', grade: 'unique' },
        { type: 'c', grade: 'unique' },
      ] as AbilityOptimizerTarget[];
      const cfg = {
        ...input(
          [line('d'), { ...line('e'), grade: 'unique' }, { ...line('a'), grade: 'unique' }],
          batchSize,
        ),
        targets,
      };
      const expected = mixedDirectOracle(rules, cfg, targets);
      const row = optimizeAbilityCost(rules, cfg).strategies.find((row) => row.id === 'direct-7')!;
      expect(row.expectedResets).toBeCloseTo(expected.resets, 8);
      expect(row.expectedMeso).toBeCloseTo(expected.meso, 8);
      expect(row.expectedHonor).toBeCloseTo(expected.honor, 8);
    },
    30000,
  );

  it('keeps the legacy three-legendary path and honors the new goal grades in cached calculations', () => {
    const rules = fixture(true),
      cfg = input([line('a'), line('d'), line('e', 2)]);
    const legacy = optimizeAbilityCost(rules, cfg);
    expect(
      optimizeAbilityCost(rules, {
        ...cfg,
        targets: cfg.targetTypes!.map((type) => ({ type, grade: 'legendary' })),
      }),
    ).toEqual(legacy);
    rules.ability.grades.unique = structuredClone(rules.ability.grades.legendary!);
    rules.ability.grades.unique.options[0].values = [{ value: 1, label: 'a 1', weight: 1 }];
    const unique = optimizeAbilityCost(rules, {
      ...cfg,
      targets: [{ type: 'a', grade: 'unique' }],
    });
    const legendary = optimizeAbilityCost(rules, {
      ...cfg,
      targets: [{ type: 'a', grade: 'legendary' }],
    });
    expect(unique.strategies.every((row) => row.status === 'already')).toBe(true);
    expect(legendary.strategies.every((row) => row.status !== 'already')).toBe(true);
    const repriced = optimizeAbilityCost(rules, {
      ...cfg,
      targets: [{ type: 'a', grade: 'legendary' }],
      availableHonor: 999999999,
      medalPrice: 0,
      circulatorPrice: 123,
    });
    for (const row of repriced.strategies) {
      const before = legendary.strategies.find((old) => old.id === row.id)!;
      expect(row.expectedHonor).toBe(before.expectedHonor);
      expect(row.expectedResets).toBe(before.expectedResets);
      expect(row.expectedCirculators).toBe(before.expectedCirculators);
      expect(row.totalCost).toBe(row.expectedMeso + 123 * row.expectedCirculators);
    }
  });

  it('validates optional goal counts, grades and duplicate kinds', () => {
    for (const targets of [
      [],
      [{ type: 'a', grade: 'epic' }],
      [
        { type: 'a', grade: 'unique' },
        { type: 'a', grade: 'legendary' },
      ],
      ['a', 'b', 'c', 'd'].map((type) => ({ type, grade: 'legendary' })),
    ])
      expect(() =>
        optimizeAbilityCost(fixture(), {
          ...input(),
          targets: targets as AbilityOptimizerTarget[],
        }),
      ).toThrow('서로 다른');
  });

  it('handles lower-is-better mixed thresholds, existing first locks and unreachable partial goals', () => {
    const rules = fixture();
    rules.ability.grades.unique = structuredClone(rules.ability.grades.legendary!);
    rules.ability.advancedLineGrades = [
      { legendary: 1 },
      { unique: 0.5, legendary: 0.5 },
      { unique: 0.5, legendary: 0.5 },
    ];
    const unique = rules.ability.grades.unique.options[0];
    unique.valueDirection = 'lower';
    unique.values = [
      { value: 2, label: 'a 2', weight: 0.5 },
      { value: 1, label: 'a 1', weight: 0.5 },
    ];
    const legendary = rules.ability.grades.legendary!.options[0];
    legendary.valueDirection = 'lower';
    legendary.values = [
      { value: 1, label: 'a 1', weight: 0.5 },
      { value: 0, label: 'a 0', weight: 0.5 },
    ];
    const cfg = {
      ...input([line('c'), { ...line('d'), grade: 'unique' }, { ...line('e'), grade: 'unique' }]),
      targets: [{ type: 'a', grade: 'unique' }] as AbilityOptimizerTarget[],
    };
    const result = optimizeAbilityCost(rules, cfg);
    expect(result.strategies.find((row) => row.id === 'direct-1')!.expectedResets).toBeCloseTo(
      59 / 30,
      10,
    );
    expect(
      optimizeAbilityCost(rules, {
        ...cfg,
        start: [line('a', 0), line('d'), line('e')],
      }).strategies.every((row) => row.status === 'already'),
    ).toBe(true);
    const kept = optimizeAbilityCost(fixture(), {
      ...input([line('a'), line('d'), line('e')]),
      targets: [
        { type: 'a', grade: 'legendary' },
        { type: 'b', grade: 'legendary' },
      ],
    });
    const keeper = kept.strategies.find((row) => row.id === 'keep-first-max')!;
    expect(keeper.expectedResets).toBeCloseTo(11 / 6, 10);
    expect(keeper.expectedMeso).toBeCloseTo(11, 10);
    const impossible = fixture();
    impossible.ability.grades.unique = structuredClone(impossible.ability.grades.legendary!);
    impossible.ability.grades.unique.options[0].values = [{ value: 2, label: 'a 2', weight: 1 }];
    const unreachable = optimizeAbilityCost(impossible, {
      ...input(),
      targets: [{ type: 'a', grade: 'unique' }],
      medalPrice: 0,
      circulatorPrice: 0,
      availableHonor: 999999999,
    });
    expect(unreachable.bestStrategyId).toBeUndefined();
    expect(
      unreachable.strategies.every(
        (row) => row.status === 'impossible' && row.totalCost === Infinity,
      ),
    ).toBe(true);
  });

  it('finishes an official three-target mixed-grade calculation without replaying failures', () => {
    const rules = fixture();
    rules.ability = JSON.parse(
      readFileSync(new URL('../public/rules/ability.json', import.meta.url), 'utf8'),
    );
    const start = ['strFlat', 'dexFlat', 'intFlat'].map(
      (type, slot) =>
        allCandidates(rules, { mode: 'ability' } as SimulationConfig, 'legendary', slot).find(
          (row) => row.line.type === type,
        )!.line,
    );
    const began = performance.now();
    const result = optimizeAbilityCost(rules, {
      ...input(start, 3),
      targets: [
        { type: 'passiveSkillLevel', grade: 'legendary' },
        { type: 'bossDamagePercent', grade: 'unique' },
        { type: 'statusAilmentDamagePercent', grade: 'unique' },
      ],
    });
    expect(result.strategies).toHaveLength(21);
    expect(result.strategies.every((row) => row.status === 'ready' && row.totalCost > 0)).toBe(
      true,
    );
    expect(performance.now() - began).toBeLessThan(30000);
  }, 35000);

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
    const result = optimizeAbilityCost(rules, {
      ...cfg,
      medalPrice: 0,
      circulatorPrice: 0,
      availableHonor: 999999999,
    });
    expect(
      result.strategies.every(
        (row) =>
          row.status === 'impossible' &&
          row.totalCost === Infinity &&
          row.estimatedAdditionalHonor === Infinity &&
          row.estimatedHonorPurchaseCost === Infinity,
      ),
    ).toBe(true);
    expect(result.bestStrategyId).toBeUndefined();
  });

  it('prices zero, partial, and sufficient available honor while retaining cached resource means', () => {
    const rules = fixture(true);
    const cfg = input([line('a', 2), line('b', 2), line('c')], 3);
    const original = optimizeAbilityCost(rules, cfg);
    expect(optimizeAbilityCost(rules, { ...cfg, availableHonor: 0 })).toEqual(original);
    const attempts = 3 / (1 - (1 - 3 / 11) ** 3);
    const partial = optimizeAbilityCost(rules, { ...cfg, availableHonor: 20 });
    const keeper = partial.strategies.find((row) => row.id === 'keep-first-max')!;
    expect(keeper.expectedHonor).toBeCloseTo(attempts * 40, 10);
    expect(keeper.estimatedAdditionalHonor).toBeCloseTo(attempts * 40 - 20, 10);
    expect(keeper.estimatedHonorPurchaseCost).toBeCloseTo(attempts * 40 - 20, 10);
    expect(keeper.totalCost).toBeCloseTo(attempts * 55 - 20, 10);
    const enough = optimizeAbilityCost(rules, { ...cfg, availableHonor: 999999999 });
    for (const result of [partial, enough]) {
      for (const row of result.strategies) {
        const old = original.strategies.find((previous) => previous.id === row.id)!;
        expect(row.expectedHonor).toBe(old.expectedHonor);
        expect(row.expectedMeso).toBe(old.expectedMeso);
        expect(row.expectedResets).toBe(old.expectedResets);
        expect(row.expectedCirculators).toBe(old.expectedCirculators);
      }
    }
    for (const row of enough.strategies) {
      expect(row.estimatedAdditionalHonor).toBe(0);
      expect(row.estimatedHonorPurchaseCost).toBe(0);
      expect(row.totalCost).toBe(row.expectedMeso + row.expectedCirculators * cfg.circulatorPrice);
    }
    // Repricing does not change the stored zero-balance result or pollute later calls.
    expect(optimizeAbilityCost(rules, cfg)).toEqual(original);
  });

  it('can prefer a reset strategy over circulation after accounting for existing honor', () => {
    const rules = fixture(true);
    const cfg = input([line('a', 2), line('b', 2), line('c')]);
    const buyingHonor = optimizeAbilityCost(rules, cfg);
    const usingHonor = optimizeAbilityCost(rules, { ...cfg, availableHonor: 999999999 });
    expect(buyingHonor.bestStrategyId).toBe('current-types-circulator');
    expect(usingHonor.bestStrategyId).not.toBe(buyingHonor.bestStrategyId);
    expect(usingHonor.strategies[0].expectedCirculators).toBe(0);
    expect(usingHonor.strategies[0].totalCost).toBeLessThan(
      usingHonor.strategies.find((row) => row.id === 'current-types-circulator')!.totalCost,
    );
  });

  it.each([-1, 0.5, 1000000000, NaN, Infinity, -Infinity, null, '5000'])(
    'rejects invalid available honor %s before reusing a cached calculation',
    (availableHonor) => {
      const rules = fixture();
      const cfg = input();
      optimizeAbilityCost(rules, cfg);
      expect(() =>
        optimizeAbilityCost(rules, { ...cfg, availableHonor: availableHonor as number }),
      ).toThrow('보유 명성치');
    },
  );

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

  it('describes first-lock alternatives with actual option names and explicit acquisition policies', () => {
    const rules = fixture(true);
    const labels = ['공격력 증가', '보스 데미지 증가', '상태 이상 데미지 증가'];
    for (const [index, label] of labels.entries())
      rules.ability.grades.legendary!.options[index].label = label;
    const result = optimizeAbilityCost(rules, input([line('d'), line('e', 2), line('a')]));
    expect(result.strategies).toHaveLength(21);
    const names = {
      direct: '재설정만으로 세 줄 완성',
      lower: '아랫줄 두 줄부터 서큘레이터로 완성',
      all: '세 종류를 갖춘 뒤 서큘레이터로 완성',
    };
    for (const row of result.strategies) {
      const timing = row.id.split('-')[0] as keyof typeof names;
      const mask = Number(row.id.split('-')[1]);
      const accepted = ['a', 'b', 'c'].filter((_, index) => mask & (1 << index));
      expect(row.policy).toEqual({ kind: 'acquire', timing, firstAcceptedTargets: accepted });
      expect(row.name).toBe(names[timing]);
      expect([row.name, row.description, ...row.steps].join(' ')).not.toMatch(/[ABC]/);
      if (accepted.length === 3) expect(row.steps[0]).toContain('목표 옵션 중 무엇이든');
      else {
        for (const [index, label] of labels.entries()) {
          if (mask & (1 << index)) expect(row.steps[0]).toContain(label);
          else expect(row.steps[0]).not.toContain(label);
        }
        if (accepted.length > 1) expect(row.steps[0]).toContain(' 또는 ');
      }
      if (timing === 'direct') expect(row.steps[0]).toContain('레전드리 최대치');
      else {
        expect(row.steps[0]).toContain('수치와 무관하게');
        expect(row.steps[0]).not.toContain('최대치');
        expect(row.steps.some((step) => step.includes('필요하면 심연의 서큘레이터'))).toBe(true);
      }
    }
  });

  it('distinguishes current-type and first-line policies without claiming a fixed passive value changes', () => {
    const rules = fixture(true);
    const passive = rules.ability.grades.legendary!.options[4];
    passive.id = 'passive';
    passive.type = 'passiveSkillLevel';
    passive.label = '패시브 스킬 레벨 증가';
    passive.values = [{ value: 1, label: '패시브 스킬 레벨 1 증가', weight: 1 }];
    const result = optimizeAbilityCost(rules, {
      ...input([line('passiveSkillLevel'), line('b'), line('c')]),
      targetTypes: ['passiveSkillLevel', 'b', 'c'],
    });
    expect(result.strategies).toHaveLength(16);
    const current = result.strategies.find((row) => row.id === 'current-types-circulator')!;
    expect(current.policy).toEqual({ kind: 'current-types' });
    expect(current.name).toBe('지금 옵션 그대로, 수치만 완성');
    expect(current.description).toContain('이미 목표 세 종류가 모두 레전드리');
    expect(current.steps.join(' ')).toContain('값이 하나뿐인 옵션은 그대로 유지');
    expect(current.expectedResets).toBe(0);
    expect(current.expectedCirculators).toBeCloseTo((1 - 0.75 * 0.25) / (0.25 * 0.75), 12);
    const keeper = result.strategies.find((row) => row.id === 'keep-first-max')!;
    expect(keeper.policy).toEqual({ kind: 'keep-first', targetType: 'passiveSkillLevel' });
    expect(keeper.name).toBe('완성된 첫 줄을 잠그고 나머지 완성');
    expect(keeper.description).toContain('패시브 스킬 레벨 1 증가');
    expect(keeper.steps[0]).toContain('패시브 스킬 레벨 1 증가');
    expect(keeper.expectedCirculators).toBe(0);
    expect(result.notes.join(' ')).toContain(
      '값이 하나뿐인 옵션은 서큘레이터를 사용해도 수치가 바뀌지 않습니다',
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
    expect(performance.now() - began).toBeLessThan(30000);
  }, 35000);
});
