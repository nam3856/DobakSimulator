import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  sampleStarforceCosts,
  starforceCostCdf,
  summarizeStarforceDistribution,
} from '../src/engine/starforce-distribution';
import {
  benchmarkStarforce,
  type StarforceConfig,
  type StarforceRules,
} from '../src/engine/starforce';

const official = JSON.parse(
  readFileSync(new URL('../public/rules/starforce.json', import.meta.url), 'utf8'),
) as StarforceRules;
const config = (patch: Partial<StarforceConfig> = {}): StarforceConfig => ({
  level: 200,
  startStars: 0,
  targetStars: 2,
  safeguard: false,
  restoration: 'trace12',
  replacementPrice: 2,
  equipmentType: 'normal',
  ...patch,
});
function fixture(): StarforceRules {
  return {
    ruleId: 'independent-two-stage-distribution',
    minimumLevel: 1,
    maximumLevel: 250,
    maximumStarBands: [{ minimumLevel: 1, maximumLevel: 250, maximumStar: 2 }],
    costFormula: {
      baseCost: 0,
      levelExponent: 0,
      starOffset: 1,
      starExponent: 1,
      roundTo: 1,
      denominators: [{ minimumStar: 0, maximumStar: 1, denominator: 1 }],
    },
    transitions: [
      {
        star: 0,
        successStar: 1,
        successProbability: 0.5,
        maintainProbability: 0.5,
        decreaseProbability: 0,
        destroyProbability: 0,
        traceStar: 0,
      },
      {
        star: 1,
        successStar: 2,
        successProbability: 0.25,
        maintainProbability: 0.25,
        decreaseProbability: 0,
        destroyProbability: 0.5,
        traceStar: 1,
      },
    ],
    safeguard: {
      eligibleStars: [1],
      additionalBaseCostMultiplier: 2,
      destroyProbabilityMultiplier: 0,
    },
    restoration: {
      restoreToBase: { restoredStar: 0, mesoCost: '3', equipmentCount: 2 },
      fullRestoreBands: [
        {
          minimumLevel: 1,
          maximumLevel: 250,
          minimumTraceStar: 0,
          maximumTraceStar: 1,
          mesoCost: '5',
          equipmentCount: 3,
        },
      ],
    },
  };
}
interface Branch {
  next: number;
  probability: number;
  cost: number;
}
/** Independent forward propagation of probability mass by paid cost. No engine quote,
 * aggregate sampler, or analytic benchmark is used to construct this CDF. */
function exactCdf(branches: Branch[][], maximumCost: number, start = 0): number[] {
  const frontier = Array.from({ length: maximumCost + 1 }, () => new Float64Array(branches.length));
  const finished = new Float64Array(maximumCost + 1);
  frontier[0][start] = 1;
  for (let spent = 0; spent <= maximumCost; spent++)
    for (let state = 0; state < branches.length; state++)
      for (const branch of branches[state]) {
        const nextCost = spent + branch.cost;
        if (nextCost > maximumCost) continue;
        const mass = frontier[spent][state] * branch.probability;
        if (branch.next === branches.length) finished[nextCost] += mass;
        else frontier[nextCost][branch.next] += mass;
      }
  let sum = 0;
  return Array.from(finished, (mass) => (sum += mass));
}
function moments(samples: Float64Array) {
  let mean = 0,
    square = 0,
    n = 0;
  for (const value of samples) {
    const delta = value - mean;
    mean += delta / ++n;
    square += delta * (value - mean);
  }
  return { mean, standardError: Math.sqrt(square / (n - 1) / n) };
}

describe('starforce aggregate cost distribution', () => {
  it('matches an independently enumerated cost CDF and mean with destructive resets and replacement costs', () => {
    const rules = fixture();
    const samples = sampleStarforceCosts(rules, config(), {
      sampleCount: 100_000,
      seed: 'reset-to-zero',
    });
    const cdf = exactCdf(
      [
        [
          { next: 1, probability: 0.5, cost: 1 },
          { next: 0, probability: 0.5, cost: 1 },
        ],
        [
          { next: 2, probability: 0.25, cost: 2 },
          { next: 1, probability: 0.25, cost: 2 },
          { next: 0, probability: 0.5, cost: 9 },
        ],
      ],
      100,
    );
    expect(benchmarkStarforce(rules, config()).expectedMeso).toBe(28);
    const stats = moments(samples);
    expect(Math.abs(stats.mean - 28)).toBeLessThan(stats.standardError * 6);
    for (let cost = 0; cost <= 100; cost++)
      expect(
        Math.abs(summarizeStarforceDistribution(samples, cost).cdfAtActual! - cdf[cost]),
      ).toBeLessThan(0.008);
    const result = summarizeStarforceDistribution(samples, 2);
    expect(result.cdfAtActual).toBe(0);
    expect(result.method).toBe('sampled');
    expect(result.sampleCount).toBe(100_000);
    expect(result.distribution.length).toBeLessThanOrEqual(101);
    expect(result.distribution.at(-1)?.cdf).toBe(1);
    expect(result.note).toContain('평균은 해석값');
  });

  it('charges self-restoration without adding another required upward crossing and honors a per-star policy', () => {
    const rules = fixture();
    const cfg = config({
      policy: [
        { stars: 0, safeguard: false, restoration: 'trace12' },
        { stars: 1, safeguard: false, restoration: 'original' },
      ],
    });
    const samples = sampleStarforceCosts(rules, cfg, {
      sampleCount: 100_000,
      seed: 'same-star-restoration',
    });
    const cdf = exactCdf(
      [
        [
          { next: 1, probability: 0.5, cost: 1 },
          { next: 0, probability: 0.5, cost: 1 },
        ],
        [
          { next: 2, probability: 0.25, cost: 2 },
          { next: 1, probability: 0.25, cost: 2 },
          { next: 1, probability: 0.5, cost: 13 },
        ],
      ],
      100,
    );
    expect(benchmarkStarforce(rules, cfg).expectedMeso).toBe(32);
    const stats = moments(samples);
    expect(Math.abs(stats.mean - 32)).toBeLessThan(stats.standardError * 6);
    for (let cost = 0; cost <= 100; cost += 2)
      expect(
        Math.abs(summarizeStarforceDistribution(samples, cost).cdfAtActual! - cdf[cost]),
      ).toBeLessThan(0.008);
  });

  it('uses event-adjusted safeguard costs and starts only at the requested starting star', () => {
    const rules = fixture();
    rules.events = [
      {
        id: 'shiningWithout1516',
        attemptCostMultiplier: 0.5,
        destroyProbabilityMultiplier: 0.5,
        fullRestoreCostMultiplier: 0.5,
        maximumDestroyReductionStarInclusive: 1,
        guaranteedSuccessStars: [],
      },
    ];
    const cfg = config({ startStars: 1, event: 'shiningNoGuarantee', safeguard: true });
    const samples = sampleStarforceCosts(rules, cfg, {
      sampleCount: 50_000,
      seed: 'event-safeguard',
    });
    // 2 meso × (0.5 normal price + 2 safeguard surcharge) = 5 per attempt; success remains 1/4.
    expect(benchmarkStarforce(rules, cfg).expectedMeso).toBe(20);
    expect(samples.every((value) => value >= 5 && value % 5 === 0)).toBe(true);
    for (const attempts of [1, 2, 3, 5, 10])
      expect(summarizeStarforceDistribution(samples, attempts * 5).cdfAtActual).toBeCloseTo(
        1 - 0.75 ** attempts,
        2,
      );
    expect(summarizeStarforceDistribution(samples, 4).cdfAtActual).toBe(0);
  });

  it('is reproducible and reports inclusive duplicate CDF values and zero cost for an already complete start', () => {
    const rules = fixture();
    const options = { sampleCount: 2048, seed: 'reproducible-costs' };
    const first = sampleStarforceCosts(rules, config(), options);
    expect(first).toEqual(sampleStarforceCosts(rules, config(), options));
    expect(first).not.toEqual(
      sampleStarforceCosts(rules, config(), { ...options, seed: 'another-seed' }),
    );
    const same = summarizeStarforceDistribution(new Float64Array([3, 3, 3, 7]), 3);
    expect(same.cdfAtActual).toBe(0.75);
    expect(starforceCostCdf(new Float64Array([3, 3, 3, 7]), 3)).toBe(0.75);
    expect(same.quantiles).toEqual({ p10: 3, p50: 3, p90: 7 });
    expect(same.distribution).toEqual([
      { cost: 3, cdf: 0.75 },
      { cost: 7, cdf: 1 },
    ]);
    const completed = sampleStarforceCosts(rules, config({ startStars: 2 }), { sampleCount: 10 });
    expect([...completed]).toEqual(Array(10).fill(0));
    expect(summarizeStarforceDistribution(completed, 0).cdfAtActual).toBe(1);
    expect(() => sampleStarforceCosts(rules, config(), { sampleCount: 0 })).toThrow('표본 수');
    expect(() => summarizeStarforceDistribution(new Float64Array())).toThrow('표본');
  });

  it('samples official 30-star goals with both reset-to-12 and capped-original restoration without per-attempt loops', () => {
    const sampleCount = Number(process.env.STARFORCE_DISTRIBUTION_SAMPLES ?? 10_000);
    const report = [];
    for (const restoration of ['trace12', 'original'] as const) {
      const cfg = config({
        level: 250,
        targetStars: 30,
        restoration,
        replacementPrice: 1_000_000_000,
      });
      const exact = benchmarkStarforce(official, cfg);
      const started = performance.now();
      const samples = sampleStarforceCosts(official, cfg, {
        sampleCount,
        seed: 'official-30-star-audit',
      });
      const elapsedMs = performance.now() - started;
      const stats = moments(samples);
      expect(samples.every((value) => value > 0 && Number.isFinite(value))).toBe(true);
      expect(Math.abs(stats.mean - exact.expectedMeso)).toBeLessThan(stats.standardError * 6);
      report.push({
        restoration,
        sampleCount,
        elapsedMs,
        exactMean: exact.expectedMeso,
        sampledMean: stats.mean,
        standardError: stats.standardError,
        relativeDifference: stats.mean / exact.expectedMeso - 1,
        quantiles: summarizeStarforceDistribution(samples).quantiles,
      });
    }
    if (process.env.STARFORCE_DISTRIBUTION_SAMPLES) {
      mkdirSync('.cache', { recursive: true });
      writeFileSync('.cache/starforce-distribution-audit.json', JSON.stringify(report, null, 2));
    }
  }, 120_000);
});
