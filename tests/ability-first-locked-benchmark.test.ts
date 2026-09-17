import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeAbilityPresetGoal } from '../src/character/ability-presets';
import { computeBenchmark } from '../src/engine/benchmark';
import { allCandidates, type RuleData } from '../src/engine/rules';
import type { OptionLine, SimulationConfig } from '../src/types';

const names = ['a', 'b', 'c', 'd', 'e'];
const weights = [1, 2, 3, 4, 5];
const line = (type: string): OptionLine => ({
  id: type,
  abilityTypeId: type,
  type,
  value: 1,
  text: `${type} +1`,
  unit: 'flat',
  grade: 'legendary',
});
const emptyPotential = { ruleId: 'unused', grades: [], optionPools: [], costBands: [] };
const data: RuleData = {
  potential: emptyPotential,
  additional: emptyPotential,
  gold: emptyPotential,
  soul: {
    ruleId: 'unused',
    version: 'test',
    amplificationStages: [],
    potentialGrades: [],
    potentialResetCosts: { rare: '0', epic: '0', unique: '0', legendary: '0' },
    optionStages: [],
  },
  ability: {
    ruleId: 'first-locked-weighted-oracle',
    version: 'test',
    sourceUrl: 'test',
    advancedLineGrades: [{ legendary: 1 }, { legendary: 1 }, { legendary: 1 }],
    grades: {
      legendary: {
        options: names.map((name, index) => ({
          id: name,
          type: name,
          label: name,
          weight: weights[index],
          values: [{ value: 1, label: `${name} +1`, weight: 1 }],
        })),
      },
    },
    costs: [
      { locked: 0, honor: 2, meso: '2' },
      { locked: 1, honor: 3, meso: '6' },
      { locked: 2, honor: 4, meso: '15' },
    ],
  },
};

function config(batchSize: 1 | 3, initial = ['a', 'd', 'e'], goalCount = 3): SimulationConfig {
  return {
    mode: 'ability',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'legendary', lines: initial.map(line), stage: 0, failures: 0 },
    abilityStrategy: 'firstLocked',
    lockedSlots: [0],
    batchSize,
    unitPrices: {},
    ruleVersion: 'oracle',
    target: {
      mode: 'ability',
      minimumGrade: 'legendary',
      match: 'all',
      lines: [],
      stage: 0,
      conditions: [
        { type: 'a', minValue: 1, slot: 0 },
        ...['b', 'c'].slice(0, goalCount - 1).map((type) => ({
          type,
          minValue: 1,
          slots: [1, 2],
        })),
      ],
    },
  };
}

/** Independent exact model: enumerate legal tuples and ordered comparisons without
 * engine selection, lock helpers, probability helpers or target matching. */
function oracle(batchSize: number, initial: string[], lowerTargets: string[]) {
  const cache = new Map<string, { cost: number; attempts: number }>();
  const progress = (tuple: string[]) =>
    tuple.slice(1).filter((type) => lowerTargets.includes(type)).length;
  const rank = (tuple: string[]) => (progress(tuple) === lowerTargets.length ? 3 : progress(tuple));
  function visit(current: string[]): { cost: number; attempts: number } {
    if (rank(current) === 3) return { cost: 0, attempts: 0 };
    const key = current.join(',');
    const cached = cache.get(key);
    if (cached) return cached;
    const acquired = [1, 2].find((slot) => lowerTargets.includes(current[slot]));
    const fixed = acquired === undefined ? [0] : [0, acquired];
    const slots = [1, 2].filter((slot) => !fixed.includes(slot));
    const tuples: { lines: string[]; probability: number }[] = [];
    function draw(index: number, tuple: string[], selected: string[], probability: number) {
      if (index === slots.length) {
        if (tuple.join(',') !== key) tuples.push({ lines: tuple, probability });
        return;
      }
      const available = names.filter((name) => !selected.includes(name));
      const total = available.reduce((sum, name) => sum + weights[names.indexOf(name)], 0);
      for (const name of available) {
        const next = [...tuple];
        next[slots[index]] = name;
        draw(
          index + 1,
          next,
          [...selected, name],
          (probability * weights[names.indexOf(name)]) / total,
        );
      }
    }
    draw(
      0,
      [...current],
      fixed.map((slot) => current[slot]),
      1,
    );
    const total = tuples.reduce((sum, tuple) => sum + tuple.probability, 0);
    const transitions = new Map<string, { lines: string[]; probability: number }>();
    function batch(depth: number, best: string[], probability: number) {
      if (depth === batchSize) {
        const to = best.join(',');
        const previous = transitions.get(to);
        if (previous) previous.probability += probability;
        else transitions.set(to, { lines: best, probability });
        return;
      }
      for (const tuple of tuples)
        batch(
          depth + 1,
          rank(tuple.lines) > rank(best) ? tuple.lines : best,
          (probability * tuple.probability) / total,
        );
    }
    batch(0, current, 1);
    let cost = batchSize * (fixed.length === 1 ? 6 : 15);
    let attempts = batchSize;
    for (const [to, transition] of transitions) {
      if (to === key) continue;
      const future = visit(transition.lines);
      cost += transition.probability * future.cost;
      attempts += transition.probability * future.attempts;
    }
    const exit = 1 - (transitions.get(key)?.probability ?? 0);
    const answer = { cost: cost / exit, attempts: attempts / exit };
    cache.set(key, answer);
    return answer;
  }
  return visit(initial);
}

describe('first-line-locked ability benchmark', () => {
  for (const batchSize of [1, 3] as const)
    for (const initial of [
      ['a', 'd', 'e'],
      ['a', 'b', 'd'],
      ['a', 'd', 'b'],
    ])
      it(`matches ordered exact enumeration for ${batchSize} comparisons from ${initial.join('/')}`, () => {
        const cfg = config(batchSize, initial);
        const expected = oracle(batchSize, initial, ['b', 'c']);
        const result = computeBenchmark(data, cfg, undefined, { sampleCount: 2000 });
        expect(result.status).toBe('ready');
        expect(result.successProbability).toBeCloseTo(1, 12);
        expect(result.expectedCost).toBeCloseTo(expected.cost, 10);
        expect(result.expectedAttempts).toBeCloseTo(expected.attempts, 10);
        expect(result.note).toContain('첫째 줄을 고정');
      });

  for (const batchSize of [1, 3] as const)
    it(`two-goal ${batchSize}-comparison cost and CDF account for either lower slot and excluded baseline`, () => {
      const cfg = config(batchSize, ['a', 'd', 'e'], 2);
      // a is fixed. b may occur in either lower slot; the retained d/e suffix
      // has mass (4/14)*(5/10), and all changed outcomes are renormalized.
      const chance =
        (2 / 14 + (3 / 14) * (2 / 11) + (4 / 14) * (2 / 10) + (5 / 14) * (2 / 9)) /
        (1 - (4 / 14) * (5 / 10));
      const batchChance = 1 - (1 - chance) ** batchSize;
      const result = computeBenchmark(data, cfg, 18, {
        sampleCount: 50000,
        seed: `fixed-first-two-${batchSize}`,
      });
      const expected = oracle(batchSize, ['a', 'd', 'e'], ['b']);
      expect(result.status).toBe('ready');
      expect(result.expectedCost).toBeCloseTo(expected.cost, 10);
      expect(result.expectedCost).toBeCloseTo((6 * batchSize) / batchChance, 10);
      expect(result.expectedAttempts).toBeCloseTo(batchSize / batchChance, 10);
      expect(result.cdfAtActual).toBeCloseTo(1 - (1 - chance) ** 3, 2);
      expect(result.note).not.toContain('추가 잠금');
    });

  for (const batchSize of [1, 3] as const)
    it(`an existing lower goal uses the two-lock price for all ${batchSize} comparisons`, () => {
      // a and b are fixed, leaving c/d/e. Excluding retained d gives P(c)=3/(3+5).
      const chance = 3 / 8;
      const batchChance = 1 - (1 - chance) ** batchSize;
      const result = computeBenchmark(data, config(batchSize, ['a', 'b', 'd']), 45, {
        sampleCount: 50000,
        seed: `fixed-first-one-lower-${batchSize}`,
      });
      expect(result.expectedCost).toBeCloseTo((15 * batchSize) / batchChance, 10);
      expect(result.expectedAttempts).toBeCloseTo(batchSize / batchChance, 10);
      expect(result.cdfAtActual).toBeCloseTo(1 - (1 - chance) ** 3, 2);
    });

  it('rejects a fixed first line that does not match its goal and does not hide unreachable lower targets', () => {
    const mismatch = config(3, ['d', 'b', 'c']);
    expect(() => computeBenchmark(data, mismatch)).toThrow(/첫/);
    const unreachable = config(3);
    unreachable.target.conditions[1].type = 'unavailable';
    const result = computeBenchmark(data, unreachable, undefined, { sampleCount: 1000 });
    expect(result.status).toBe('impossible');
    expect(result.successProbability).toBe(0);
    expect(result.expectedCost).toBe(Infinity);
    expect(computeBenchmark(data, config(3, ['a', 'b', 'c'])).status).toBe('already');
  });

  it('handles official maximum lower goals with 500,000 inverse-CDF samples', () => {
    const rules = {
      ...data,
      ability: JSON.parse(
        readFileSync(new URL('../public/rules/ability.json', import.meta.url), 'utf8'),
      ),
    };
    const cfg = config(3);
    cfg.target = makeAbilityPresetGoal(rules, '나이트로드');
    cfg.start.lines = ['passiveSkillLevel', 'strFlat', 'dexFlat'].map(
      (type, slot) =>
        allCandidates(rules, cfg, 'legendary', slot).find(
          (candidate) => candidate.line.type === type,
        )!.line,
    );
    const started = performance.now();
    const result = computeBenchmark(rules, cfg);
    expect(result.status).toBe('ready');
    expect(result.sampleCount).toBe(500000);
    expect(result.expectedCost).toBeGreaterThan(1e9);
    expect(result.expectedAttempts).toBeGreaterThan(1000);
    expect(result.quantiles.p10).toBeLessThan(result.quantiles.p50);
    expect(result.quantiles.p50).toBeLessThan(result.quantiles.p90);
    expect(performance.now() - started).toBeLessThan(15000);
  }, 20000);
});
