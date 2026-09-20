import { describe, expect, it } from 'vitest';
import api250Evidence from './fixtures/bonus-options-250-api.json';
import {
  bonusLineStats,
  bonusLuckPercentile,
  bonusOptionPool,
  bonusRollCost,
  bonusTierDistribution,
  defaultBonusWeights,
  evaluateBonusOptions,
  evaluateBonusReroll,
  rollBonusOptions,
  scoreBonusStats,
  validateBonusConfig,
  type BonusConfig,
} from '../src/engine/bonus-options';

const config: BonusConfig = {
  equipment: { kind: 'armor', level: 200, boss: true },
  flame: 'meso',
  weights: defaultBonusWeights('str'),
  targetScore: 120,
};
function seeded(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe('KMS bonus option rules', () => {
  it('uses current meso, black, blazing and abyss stage rates with the boss +2 offset', () => {
    expect(bonusTierDistribution(config)).toEqual([
      { tier: 4, probability: 0.29 },
      { tier: 5, probability: 0.45 },
      { tier: 6, probability: 0.25 },
      { tier: 7, probability: 0.01 },
    ]);
    expect(bonusTierDistribution({ ...config, flame: 'black' })).toEqual(
      bonusTierDistribution(config),
    );
    expect(bonusTierDistribution({ ...config, flame: 'blazing' })).toEqual([
      { tier: 3, probability: 0.2 },
      { tier: 4, probability: 0.3 },
      { tier: 5, probability: 0.36 },
      { tier: 6, probability: 0.14 },
    ]);
    expect(
      bonusTierDistribution({
        ...config,
        flame: 'abyss',
        equipment: { ...config.equipment, boss: false },
      }),
    ).toEqual([
      { tier: 3, probability: 0.63 },
      { tier: 4, probability: 0.34 },
      { tier: 5, probability: 0.03 },
    ]);
  });

  it('uses level-gated option pools and the different weapon options', () => {
    const pool = (level: number, kind: 'armor' | 'weapon' = 'armor') =>
      bonusOptionPool({ level, kind, boss: false });
    expect(pool(59)).toHaveLength(16);
    expect(pool(59)).not.toContain('attack');
    expect(pool(60)).toHaveLength(18);
    expect(pool(69)).not.toContain('allStat');
    expect(pool(70)).toHaveLength(19);
    expect(pool(89, 'weapon')).toHaveLength(18);
    expect(pool(89, 'weapon')).not.toContain('bossDamage');
    expect(pool(90, 'weapon')).toHaveLength(19);
    expect(pool(90, 'weapon')).not.toContain('speed');
  });

  it('matches the official level 200 single-stat, dual-stat and armor attack examples', () => {
    expect(bonusLineStats(config.equipment, 'str', 7)).toEqual({ str: 77 });
    expect(bonusLineStats(config.equipment, 'strDex', 7)).toEqual({ str: 42, dex: 42 });
    expect(bonusLineStats(config.equipment, 'attack', 7)).toEqual({ attack: 7 });
    expect(bonusLineStats(config.equipment, 'hp', 7)).toEqual({ hp: 4200 });
    expect(scoreBonusStats({ str: 77, allStat: 7, attack: 7 }, defaultBonusWeights('str'))).toBe(
      168,
    );
    expect(defaultBonusWeights('int')).toEqual({ int: 1, magicAttack: 3, allStat: 10 });
  });

  it('applies the documented generic weapon value model with ceil only at the end', () => {
    const weapon = {
      ...config.equipment,
      kind: 'weapon' as const,
      baseAttack: 340,
      baseMagicAttack: 0,
    };
    expect([3, 4, 5, 6, 7].map((tier) => bonusLineStats(weapon, 'attack', tier).attack)).toEqual([
      62, 90, 124, 163, 210,
    ]);
    expect(bonusLineStats(weapon, 'magicAttack', 7)).toEqual({ magicAttack: 0 });
    expect(bonusLineStats({ ...weapon, level: 160, baseAttack: 150 }, 'attack', 3)).toEqual({
      attack: 23,
    });
    expect(bonusLineStats({ ...weapon, boss: false, baseAttack: 100 }, 'attack', 2)).toEqual({
      attack: 14,
    });
  });

  it.each([
    ['에테르넬 파이렛햇', { str: 42, dex: 132, int: 42, allStat: 4 }, 0.29 ** 2 * 0.25 ** 2],
    ['에테르넬 파이렛코트', { dex: 125, int: 35, luk: 42, allStat: 5 }, 0.29 * 0.45 ** 2 * 0.25],
    ['에테르넬 파이렛팬츠', { str: 42, dex: 125, luk: 35, allStat: 4 }, 0.29 ** 2 * 0.45 * 0.25],
    ['에테르넬 파이렛글러브', { str: 28, dex: 130, int: 42, allStat: 5 }, 0.29 * 0.45 ** 2 * 0.25],
  ] as const)(
    'reconstructs official API level250 armor evidence: %s',
    (_name, current, tierProbability) => {
      const eternal = {
        ...config,
        equipment: { ...config.equipment, level: 250 },
        weights: defaultBonusWeights('dex'),
        targetScore: 200,
      };
      const result = evaluateBonusOptions(eternal, current);
      expect(bonusLineStats(eternal.equipment, 'dex', 7)).toEqual({ dex: 84 });
      expect(bonusLineStats(eternal.equipment, 'dexInt', 6)).toEqual({ dex: 42, int: 42 });
      // Every record has one unique four-line decomposition at the listed tiers.
      expect(result.excludedProbability).toBeCloseTo(tierProbability / 3876, 14);
      expect(result.excludedProbability).toBeGreaterThan(0);
      expect(result.maxScore).toBe(252);
    },
  );

  it('draws distinct types, legal independent tiers, and the nonboss count distribution', () => {
    const random = seeded(123);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 10_000; i++) {
      const roll = rollBonusOptions(
        { ...config, equipment: { ...config.equipment, boss: false } },
        random,
      );
      counts[roll.lines.length - 1]!++;
      expect(new Set(roll.lines.map((line) => line.option)).size).toBe(roll.lines.length);
      expect(roll.lines.every((line) => [2, 3, 4, 5].includes(line.tier))).toBe(true);
    }
    [0.4, 0.4, 0.16, 0.04].forEach((p, i) => expect(counts[i]! / 10_000).toBeCloseTo(p, 1));
    for (let i = 0; i < 50; i++) expect(rollBonusOptions(config, random).lines).toHaveLength(4);
  });

  it('redraws identical aggregate stats without counting another paid attempt', () => {
    const values = [0, 0, 0, 0, 0.06, 0];
    let used = 0;
    const roll = rollBonusOptions(
      { ...config, equipment: { ...config.equipment, boss: false } },
      () => values[used++]!,
      { str: 22 },
    );
    expect(used).toBe(6);
    expect(roll.stats.dex).toBe(22);
    expect(roll.stats.str).toBe(0);
  });
});

describe('always-replace benchmark approximation', () => {
  const nonboss: BonusConfig = {
    ...config,
    equipment: { ...config.equipment, boss: false },
    weights: { allStat: 1 },
    targetScore: 5,
  };

  it('uses the unconditional draw probability rather than freezing the initial exclusion', () => {
    const current = { allStat: 2 };
    const baseline = evaluateBonusReroll(nonboss, current);
    const fixedBefore = evaluateBonusOptions(nonboss, current);
    const p = (1.84 / 19) * 0.01;
    expect(baseline.method).toBe('independent-baseline');
    expect(baseline.baseProbability).toBeCloseTo(p, 14);
    expect(baseline.successProbability).toBe(baseline.baseProbability);
    expect(baseline.excludedProbability).toBe(0);
    expect(baseline.expectedRolls).toBeCloseTo(1 / p, 10);
    expect(baseline.expectedCost).toBeCloseTo(3_000_000 / p, 3);
    expect(baseline.expectedRolls).toBeGreaterThan(fixedBefore.expectedRolls);
    expect(baseline).toEqual(evaluateBonusReroll(nonboss, { str: 22 }));
  });

  it('keeps geometric quantiles consistent with the displayed baseline probability', () => {
    const baseline = evaluateBonusReroll(nonboss, { allStat: 2 });
    expect(
      bonusLuckPercentile(baseline.successProbability, baseline.medianRolls),
    ).toBeGreaterThanOrEqual(50);
    expect(bonusLuckPercentile(baseline.successProbability, baseline.medianRolls - 1)).toBeLessThan(
      50,
    );
    expect(
      bonusLuckPercentile(baseline.successProbability, baseline.p90Rolls),
    ).toBeGreaterThanOrEqual(90);
  });

  it('preserves already-satisfied, unknown-start and impossible goal handling', () => {
    const satisfied = evaluateBonusReroll(nonboss, { allStat: 5 });
    expect(satisfied.alreadySatisfied).toBe(true);
    expect(satisfied.expectedRolls).toBe(0);
    expect(satisfied.expectedCost).toBe(0);
    expect(satisfied.medianRolls).toBe(0);
    expect(satisfied.p90Rolls).toBe(0);
    expect(evaluateBonusReroll(nonboss).alreadySatisfied).toBe(false);
    const impossible = evaluateBonusReroll({ ...nonboss, targetScore: 6 });
    expect(impossible.successProbability).toBe(0);
    expect(impossible.expectedRolls).toBe(Infinity);
    expect(impossible.expectedCost).toBe(Infinity);
  });
});

describe('exact goal probabilities and fixed-before stopping time', () => {
  it.each(api250Evidence.observations)(
    'reconstructs API HP/MP/DEF evidence: $name $retrievedAt',
    (observation) => {
      const eternal = {
        ...config,
        equipment: { ...config.equipment, level: observation.level },
        weights: { hp: 1 },
        targetScore: 5000,
      };
      const result = evaluateBonusOptions(eternal, observation.stats);
      const probabilities: Record<number, number> = { 4: 0.29, 5: 0.45, 6: 0.25, 7: 0.01 };
      const tierProbability = observation.tiers.reduce(
        (product, tier) => product * probabilities[tier]!,
        1,
      );
      expect(bonusLineStats(eternal.equipment, 'hp', 7)).toEqual({ hp: 4900 });
      expect(bonusLineStats(eternal.equipment, 'mp', 6)).toEqual({ mp: 4200 });
      expect(bonusLineStats(eternal.equipment, 'armor', 6)).toEqual({ armor: 72 });
      expect(result.excludedProbability).toBeCloseTo(tierProbability / 3876, 14);
      expect(result.excludedProbability).toBeGreaterThan(0);
      expect(result.maxScore).toBe(4900);
      expect(result.successProbability).toBe(0);
    },
  );

  it('matches a closed-form 7% allstat oracle: inclusion 4/19 times tier chance', () => {
    const allStatGoal = { ...config, weights: { allStat: 1 }, targetScore: 7 };
    const meso = evaluateBonusOptions(allStatGoal);
    expect(meso.successProbability).toBeCloseTo((4 / 19) * 0.01, 14);
    expect(meso.expectedRolls).toBeCloseTo(475, 9);
    expect(meso.expectedCost).toBeCloseTo(1_425_000_000, 3);
    expect(meso.maxScore).toBe(7);
    expect(evaluateBonusOptions({ ...allStatGoal, flame: 'abyss' }).successProbability).toBeCloseTo(
      (4 / 19) * 0.03,
      14,
    );
    expect(evaluateBonusOptions({ ...allStatGoal, flame: 'blazing' }).expectedRolls).toBe(Infinity);
  });

  it('integrates all possible nonboss option counts instead of assuming four', () => {
    const actual = evaluateBonusOptions({
      ...config,
      equipment: { ...config.equipment, boss: false },
      weights: { allStat: 1 },
      targetScore: 5,
    });
    expect(actual.successProbability).toBeCloseTo((1.84 / 19) * 0.01, 14);
  });

  it('requires independent top tiers on two distinct weapon options', () => {
    const actual = evaluateBonusOptions({
      ...config,
      equipment: { ...config.equipment, kind: 'weapon', baseAttack: 340, baseMagicAttack: 0 },
      weights: { bossDamage: 1, allStat: 1 },
      targetScore: 21,
    });
    // The 4-of-19 pool must contain both types; each separately needs tier 7.
    expect(actual.successProbability).toBeCloseTo(((4 * 3) / (19 * 18)) * 0.01 ** 2, 14);
    expect(actual.expectedRolls).toBeCloseTo(285_000, 7);
  });

  it('preserves extremely rare four-top-tier tail probabilities', () => {
    const actual = evaluateBonusOptions({ ...config, targetScore: 231 });
    // STR +77, allstat 7%, and any two of the three STR-pair lines at +42.
    expect(actual.maxScore).toBe(231);
    expect(actual.successProbability / ((3 * 0.01 ** 4) / 3876)).toBeCloseTo(1, 12);
    expect(evaluateBonusOptions({ ...config, targetScore: 231.01 }).successProbability).toBe(0);
  });

  it('conditions on keeping the current options, with multiple hidden decompositions counted', () => {
    const nonboss = {
      ...config,
      equipment: { ...config.equipment, boss: false },
      weights: { allStat: 1 },
      targetScore: 5,
    };
    // Three different two-line pairings yield exactly STR/DEX/INT/LUK +12.
    const current = { str: 12, dex: 12, int: 12, luk: 12 };
    const evaluated = evaluateBonusOptions(nonboss, current);
    const identical = (0.4 * 3 * 0.29 ** 2) / 171;
    expect(evaluated.excludedProbability).toBeCloseTo(identical, 14);
    expect(evaluated.successProbability).toBeCloseTo(((1.84 / 19) * 0.01) / (1 - identical), 14);
    expect(evaluated.expectedRolls).toBeCloseTo((1 - identical) / ((1.84 / 19) * 0.01), 10);
  });

  it('correctly excludes an existing single line and accepts an out-of-support imported roll', () => {
    const nonboss = {
      ...config,
      equipment: { ...config.equipment, boss: false },
      weights: { allStat: 1 },
      targetScore: 5,
    };
    expect(evaluateBonusOptions(nonboss, { allStat: 2 }).excludedProbability).toBeCloseTo(
      (0.4 / 19) * 0.29,
      14,
    );
    expect(evaluateBonusOptions(nonboss, { allStat: 999 }).excludedProbability).toBe(0);
    expect(evaluateBonusOptions(nonboss, { str: 1 }).excludedProbability).toBe(0);
  });

  it('counts invisible zero-base weapon lines when excluding an aggregate result', () => {
    const weapon = {
      ...config,
      equipment: {
        level: 200,
        kind: 'weapon' as const,
        boss: false,
        baseAttack: 340,
        baseMagicAttack: 0,
      },
      weights: { allStat: 1 },
      targetScore: 5,
    };
    const result = evaluateBonusOptions(weapon, { allStat: 2 });
    // One allstat line, or allstat plus a zero-magic line at any possible tier.
    expect(result.excludedProbability).toBeCloseTo((0.4 * 0.29) / 19 + (0.4 * 0.29) / 171, 14);
  });

  it('returns zero remaining work when the current item already meets the goal', () => {
    const evaluated = evaluateBonusOptions(config, { str: 100, allStat: 7 });
    expect(evaluated.alreadySatisfied).toBe(true);
    expect(evaluated.expectedRolls).toBe(0);
    expect(evaluated.expectedCost).toBe(0);
    expect(evaluated.medianRolls).toBe(0);
    expect(evaluated.p90Rolls).toBe(0);
  });

  it('handles impossible, certain, fractional-weight and explicit fixed-tier targets', () => {
    const impossible = evaluateBonusOptions({
      ...config,
      weights: { allStat: 0.5 },
      targetScore: 3.51,
    });
    expect(impossible.successProbability).toBe(0);
    expect(impossible.expectedCost).toBe(Infinity);
    expect(evaluateBonusOptions({ ...config, targetScore: 0 }).successProbability).toBe(1);
    expect(
      evaluateBonusOptions({ ...config, weights: { allStat: 0.5 }, targetScore: 3.5 })
        .successProbability,
    ).toBeCloseTo((4 / 19) * 0.01, 14);
    expect(
      evaluateBonusOptions({
        ...config,
        equipment: { ...config.equipment, fixedTier: 3 },
        weights: { allStat: 1 },
        targetScore: 3,
      }).successProbability,
    ).toBeCloseTo(4 / 19, 14);
  });

  it('reports geometric quantiles, success percentile and explicit flame valuations', () => {
    const result = evaluateBonusOptions({ ...config, weights: { allStat: 1 }, targetScore: 7 });
    expect(
      bonusLuckPercentile(result.successProbability, result.medianRolls),
    ).toBeGreaterThanOrEqual(50);
    expect(bonusLuckPercentile(result.successProbability, result.medianRolls - 1)).toBeLessThan(50);
    expect(bonusLuckPercentile(result.successProbability, result.p90Rolls)).toBeGreaterThanOrEqual(
      90,
    );
    expect(bonusLuckPercentile(0, 10)).toBe(0);
    expect(bonusLuckPercentile(1, 1)).toBe(100);
    expect(bonusRollCost({ ...config, costPerRoll: 123 })).toBe(3_000_000);
    expect(bonusRollCost({ ...config, flame: 'abyss', costPerRoll: 12_000_000 })).toBe(12_000_000);
  });

  it('rejects missing weapon bases and nonfinite or negative configuration values', () => {
    expect(
      validateBonusConfig({ ...config, equipment: { ...config.equipment, kind: 'weapon' } }),
    ).toHaveLength(3);
    expect(validateBonusConfig({ ...config, targetScore: NaN })).not.toEqual([]);
    expect(validateBonusConfig({ ...config, weights: { allStat: -1 } })).not.toEqual([]);
    expect(validateBonusConfig({ ...config, weights: { str: 1e308 } })).not.toEqual([]);
    expect(() => rollBonusOptions({ ...config, weights: { str: 1e308 } })).toThrow('환산 비율');
    expect(validateBonusConfig({ ...config, targetScore: 1_000_000_001 })).not.toEqual([]);
    expect(validateBonusConfig({ ...config, costPerRoll: -1 })).not.toEqual([]);
    expect(validateBonusConfig({ ...config, costPerRoll: 1.5 })).not.toEqual([]);
    expect(
      validateBonusConfig({ ...config, costPerRoll: Number.MAX_SAFE_INTEGER + 1 }),
    ).not.toEqual([]);
    expect(() => rollBonusOptions({ ...config, targetScore: Infinity })).toThrow('목표 점수');
  });
});
