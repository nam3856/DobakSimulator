import { describe, expect, it } from 'vitest';
import { computeBenchmark } from '../src/engine/benchmark';
import type { RuleData } from '../src/engine/rules';
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
    ruleId: 'weighted-ability-oracle',
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
function config(batchSize: 1 | 3, lowerTargets = ['b', 'c']): SimulationConfig {
  return {
    mode: 'ability',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'legendary', lines: ['c', 'a', 'd'].map(line), stage: 0, failures: 0 },
    abilityStrategy: 'lowerFirst',
    lockedSlots: [],
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
        ...lowerTargets.map((type) => ({ type, minValue: 1, slots: [1, 2] })),
      ],
    },
  };
}

/** Independent finite model: enumerate every ordered outcome AND every ordered batch,
 * directly selecting the earliest best candidate, then solve retained-miss self loops. */
function oracle(batchSize: number, initial: string[], lowerTargets = ['b', 'c']) {
  const cache = new Map<string, { cost: number; attempts: number }>();
  const progress = (tuple: string[]) =>
    tuple.slice(1).filter((type) => lowerTargets.includes(type)).length;
  const successRank = lowerTargets.length + 1;
  const rank = (tuple: string[]) =>
    tuple[0] === 'a' && progress(tuple) === lowerTargets.length ? successRank : progress(tuple);
  function visit(current: string[]): { cost: number; attempts: number } {
    const key = current.join(',');
    if (rank(current) === successRank) return { cost: 0, attempts: 0 };
    const saved = cache.get(key);
    if (saved) return saved;
    const fixed = [1, 2].filter((slot) => lowerTargets.includes(current[slot]));
    const used = fixed.map((slot) => current[slot]);
    const slots = [0, 1, 2].filter((slot) => !fixed.includes(slot));
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
    draw(0, [...current], used, 1);
    const total = tuples.reduce((sum, tuple) => sum + tuple.probability, 0);
    tuples.forEach((tuple) => {
      tuple.probability /= total;
    });
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
          probability * tuple.probability,
        );
    }
    batch(0, current, 1);
    let cost = batchSize * [2, 6, 15][fixed.length];
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

describe('sequential ability benchmark against a complete independent finite model', () => {
  for (const batchSize of [1, 3] as const)
    it(`${batchSize}-candidate ordering, conditional tuple exclusion, branch probabilities and phase prices agree exactly`, () => {
      const expected = oracle(batchSize, ['c', 'a', 'd']);
      const result = computeBenchmark(data, config(batchSize), undefined, {
        sampleCount: 2000,
        seed: 'oracle',
      });
      expect(result.status).toBe('ready');
      expect(result.expectedCost).toBeCloseTo(expected.cost, 9);
      expect(result.expectedAttempts).toBeCloseTo(expected.attempts, 9);
    });

  for (const batchSize of [1, 3] as const)
    for (const initial of [
      ['c', 'a', 'd'],
      ['d', 'b', 'c'],
      ['d', 'c', 'b'],
    ])
      it(`two goals, ${batchSize} candidates, starting ${initial.join('/')} agree with ordered enumeration`, () => {
        const cfg = config(batchSize, ['b']);
        cfg.start.lines = initial.map(line);
        const expected = oracle(batchSize, initial, ['b']);
        const result = computeBenchmark(data, cfg, undefined, {
          sampleCount: 2000,
          seed: 'two-goal-oracle',
        });
        expect(result.status).toBe('ready');
        expect(result.successProbability).toBeCloseTo(1, 12);
        expect(result.expectedCost).toBeCloseTo(expected.cost, 9);
        expect(result.expectedAttempts).toBeCloseTo(expected.attempts, 9);
      });

  for (const batchSize of [1, 3] as const)
    it(`two goals with an acquired lower lock have the geometric cost CDF for ${batchSize} candidates`, () => {
      const cfg = config(batchSize, ['b']);
      cfg.start.lines = ['d', 'b', 'c'].map(line);
      // With b fixed, P(first=a)=1/13. The excluded d/b/c tuple has mass
      // (4/13)*(3/9), giving P(hit | changed)=3/35. The other lower line
      // still rerolls, so an attempt costs 6 rather than the two-lock price 15.
      const chance = 3 / 35;
      const batchChance = 1 - (1 - chance) ** batchSize;
      const result = computeBenchmark(data, cfg, 18, {
        sampleCount: 100000,
        seed: `two-goal-cdf-${batchSize}`,
      });
      expect(result.expectedAttempts).toBeCloseTo(batchSize / batchChance, 10);
      expect(result.expectedCost).toBeCloseTo((6 * batchSize) / batchChance, 10);
      expect(result.cdfAtActual).toBeCloseTo(1 - (1 - chance) ** 3, 2);
      expect(result.note).not.toContain('나머지 아랫줄');
    });
});
