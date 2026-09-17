import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SimulationConfig } from '../src/types';
import { computeBenchmark, type RuleData } from '../src/engine';
import { cryptoRandom, seededRandom } from '../src/engine/math';
import { amplificationChance, createState, rollBatch } from '../src/engine/simulation';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../public/rules/${name}.json`, import.meta.url), 'utf8'));
const data: RuleData = {
  potential: read('potential'),
  additional: read('additional-potential'),
  gold: read('gold'),
  ability: read('ability'),
  soul: read('soul'),
};

// Independently transcribed from the official September 17 update, checked September 18.
// https://maplestory.nexon.com/News/Update/813
// https://maplestory.nexon.com/Guide/N23GameInformation/Articles/416 (section 3)
// Probabilities are integer ten-thousandths; the guaranteed attempt follows the last failure.
const official = [
  { initial: 500, increase: 100, failures: 25, cost: 500_000_000 },
  { initial: 300, increase: 60, failures: 33, cost: 1_000_000_000 },
  { initial: 200, increase: 40, failures: 43, cost: 1_750_000_000 },
  { initial: 150, increase: 30, failures: 50, cost: 2_750_000_000 },
];
const config = (stage = 0, failures = 0): SimulationConfig => ({
  mode: 'soulAmplification',
  cubeType: 'black',
  category: 'weapon',
  level: 200,
  start: { grade: 'rare', lines: [], stage, failures },
  lockedSlots: [],
  batchSize: 1,
  target: {
    mode: 'stage',
    minimumGrade: 'rare',
    conditions: [],
    lines: [],
    stage: 4,
    match: 'all',
  },
  ruleVersion: 'official-soul-audit',
  unitPrices: {},
});

function referenceMoments(stage: number, startingFailures = 0) {
  const rule = official[stage];
  let survival = 1;
  let mean = 0;
  let secondMoment = 0;
  for (let failure = startingFailures; failure <= rule.failures; failure++) {
    const probability =
      failure === rule.failures ? 1 : (rule.initial + rule.increase * failure) / 10_000;
    const mass = survival * probability;
    const attempts = failure - startingFailures + 1;
    mean += mass * attempts;
    secondMoment += mass * attempts * attempts;
    survival *= 1 - probability;
  }
  return { mean, variance: secondMoment - mean * mean };
}

describe('official soul amplification runtime audit', () => {
  it.each(official.map((rule, stage) => ({ ...rule, stage })))(
    'checks every failure count and success boundary for stage $stage',
    ({ initial, increase, failures, cost, stage }) => {
      expect(data.soul.amplificationStages[stage]).toEqual({
        stage: stage + 1,
        initialSuccessProbability: initial / 10_000,
        successProbabilityIncreasePerFailure: increase / 10_000,
        guaranteedAfterFailures: failures,
        systemCostPerAttempt: String(cost),
      });
      for (let failure = 0; failure <= failures; failure++) {
        const probability = failure === failures ? 1 : (initial + increase * failure) / 10_000;
        expect(amplificationChance(data, stage, failure)).toBeCloseTo(probability, 14);
        const cfg = config(stage, failure);
        const state = createState(data, cfg);
        const success = rollBatch(data, cfg, state, () => probability - 1e-12);
        expect(success.stage).toBe(stage + 1);
        expect(success.failures).toBe(0);
        expect(success.attempts).toBe(1n);
        expect(success.spent.meso).toBe(BigInt(cost));
        expect(success.spent.ethers).toEqual(official.map((_, i) => (i === stage ? 1n : 0n)));
        if (failure < failures) {
          const miss = rollBatch(data, cfg, state, () => probability + 1e-12);
          expect(miss.stage).toBe(stage);
          expect(miss.failures).toBe(failure + 1);
          expect(miss.spent).toEqual(success.spent);
          expect(miss.status).toBe('running');
        }
      }
    },
  );

  it('guarantees exactly the next attempt, resets every stage, and charges all 155 worst-case attempts', () => {
    const cfg = config();
    let state = createState(data, cfg);
    for (const [stage, rule] of official.entries()) {
      expect(state.stage).toBe(stage);
      expect(state.failures).toBe(0);
      for (let failure = 1; failure <= rule.failures; failure++) {
        state = rollBatch(data, cfg, state, () => 1 - Number.EPSILON);
        expect(state.stage).toBe(stage);
        expect(state.failures).toBe(failure);
      }
      state = rollBatch(data, cfg, state, () => 1 - Number.EPSILON);
      expect(state.stage).toBe(stage + 1);
      expect(state.failures).toBe(0);
    }
    expect(state.status).toBe('success');
    expect(state.attempts).toBe(155n);
    expect(state.spent.meso).toBe(264_250_000_000n);
    expect(state.spent.ethers).toEqual([26n, 34n, 44n, 51n]);
    expect(rollBatch(data, cfg, state, () => 0)).toBe(state);
  });

  it('matches independent finite-outcome means from every possible saved failure state', () => {
    for (const [stage, rule] of official.entries()) {
      for (let failure = 0; failure <= rule.failures; failure++) {
        const cfg = config(stage, failure);
        cfg.target.stage = stage + 1;
        const result = computeBenchmark(data, cfg);
        const reference = referenceMoments(stage, failure);
        expect(result.expectedAttempts).toBeCloseTo(reference.mean, 10);
        expect(result.expectedCost! / rule.cost).toBeCloseTo(reference.mean, 10);
        expect(result.distribution.at(-1)).toEqual({
          cost: (rule.failures - failure + 1) * rule.cost,
          cdf: 1,
        });
      }
    }
  });

  it('takes two unsigned Web Crypto words and keeps even endpoint samples strictly between zero and one', () => {
    const values = [new Uint32Array([0, 0]), new Uint32Array([0xffffffff, 0xffffffff])];
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      expect(array).toBeInstanceOf(Uint32Array);
      expect((array as Uint32Array).length).toBe(2);
      (array as Uint32Array).set(values.shift()!);
      return array;
    });
    try {
      const low = cryptoRandom();
      const high = cryptoRandom();
      expect(low).toBeGreaterThan(0);
      expect(low).toBeLessThan(1e-15);
      expect(high).toBeLessThan(1);
      expect(high).toBeGreaterThan(1 - 1e-15);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('cross-checks complete paid runtime trials against independent means and the cost distribution', () => {
    const trials = Number(process.env.SOUL_AUDIT_TRIALS ?? 10_000);
    expect(Number.isSafeInteger(trials) && trials >= 10_000).toBe(true);
    const cfg = config();
    const benchmark = computeBenchmark(data, cfg);
    const rng = seededRandom('soul-amplification-audit-2026-09-18');
    const stageAttempts = [0, 0, 0, 0];
    const firstAttemptSuccesses = [0, 0, 0, 0];
    let costSum = 0;
    let atOrBelowMean = 0;
    for (let trial = 0; trial < trials; trial++) {
      let state = createState(data, cfg);
      while (state.status !== 'success') state = rollBatch(data, cfg, state, rng);
      costSum += Number(state.spent.meso);
      if (Number(state.spent.meso) <= benchmark.expectedCost!) atOrBelowMean++;
      for (let stage = 0; stage < 4; stage++) {
        const attempts = Number(state.spent.ethers[stage]);
        stageAttempts[stage] += attempts;
        if (attempts === 1) firstAttemptSuccesses[stage]++;
      }
    }
    const moments = official.map((_, stage) => referenceMoments(stage));
    const expectedCost = moments.reduce(
      (sum, value, stage) => sum + value.mean * official[stage].cost,
      0,
    );
    const costVariance = moments.reduce(
      (sum, value, stage) => sum + value.variance * official[stage].cost ** 2,
      0,
    );
    expect(Math.abs(costSum / trials - expectedCost)).toBeLessThan(
      6 * Math.sqrt(costVariance / trials),
    );
    for (let stage = 0; stage < 4; stage++) {
      expect(Math.abs(stageAttempts[stage] / trials - moments[stage].mean)).toBeLessThan(
        6 * Math.sqrt(moments[stage].variance / trials),
      );
      const p = official[stage].initial / 10_000;
      expect(Math.abs(firstAttemptSuccesses[stage] / trials - p)).toBeLessThan(
        6 * Math.sqrt((p * (1 - p)) / trials),
      );
    }
    const meanCdf = computeBenchmark(data, cfg, expectedCost).cdfAtActual!;
    expect(Math.abs(atOrBelowMean / trials - meanCdf)).toBeLessThan(
      6 * Math.sqrt((meanCdf * (1 - meanCdf)) / trials),
    );
    if (process.env.SOUL_AUDIT_TRIALS) {
      const report = JSON.stringify(
        {
          trials,
          expectedCost,
          actualMeanCost: costSum / trials,
          relativeDifference: costSum / trials / expectedCost - 1,
          meanCostStandardError: Math.sqrt(costVariance / trials),
          stageExpectedAttempts: moments.map((value) => value.mean),
          stageActualAttempts: stageAttempts.map((attempts) => attempts / trials),
          firstAttemptSuccessRates: firstAttemptSuccesses.map((hits) => hits / trials),
          probabilityAtOrBelowMean: meanCdf,
          sampleAtOrBelowMean: atOrBelowMean / trials,
          quantiles: benchmark.quantiles,
        },
        null,
        2,
      );
      mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
      writeFileSync(new URL('../.cache/soul-amplification-audit.json', import.meta.url), report);
    }
  }, 120_000);
});
