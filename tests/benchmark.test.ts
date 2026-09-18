import { describe, expect, it } from 'vitest';
import {
  computeBenchmark,
  evaluateLuck,
  analyzeOutcomes,
  createState,
  rollBatch,
  seededRandom,
} from '../src/engine';
import { geometric, geometricCdf } from '../src/engine/math';
import { fixture, config, line } from './engine.test';

describe('benchmark probability and distributions', () => {
  it('computes the exact keep-before geometric correction', () => {
    const data = fixture(),
      cfg = config();
    const space = analyzeOutcomes(data, cfg, 'legendary', false);
    expect(space.targetProbability).toBeCloseTo(1 / 8, 12);
    expect(space.currentProbability).toBeCloseTo(1 / 8, 12);
    const result = computeBenchmark(data, cfg, 40);
    expect(result.expectedAttempts).toBeCloseTo(7, 12);
    expect(result.expectedCost).toBeCloseTo(280, 10);
    expect(result.cdfAtActual).toBeCloseTo(1 / 7, 12);
    expect(result.method).toBe('analytic');
  });
  it('uses batch stopping cost rather than the cost of the first successful candidate', () => {
    const cfg = config();
    cfg.batchSize = 3;
    const result = computeBenchmark(fixture(), cfg, 120);
    const p = 1 - (6 / 7) ** 3;
    expect(result.expectedAttempts).toBeCloseTo(3 / p, 12);
    expect(result.cdfAtActual).toBeCloseTo(p, 12);
    expect(computeBenchmark(fixture(), cfg, 119).cdfAtActual).toBe(0);
  });
  it('computes all-grade bounded upgrade means and reproducible sampled costs', () => {
    const cfg = config();
    cfg.start.grade = 'rare';
    cfg.start.lines = [line('b', 'rare'), line('b', 'rare'), line('b', 'rare')];
    cfg.target.mode = 'grade';
    const first = computeBenchmark(fixture(), cfg, 100, { sampleCount: 20000, seed: 'repeat' });
    const second = computeBenchmark(fixture(), cfg, 100, { sampleCount: 20000, seed: 'repeat' });
    expect(first.expectedAttempts).toBeCloseTo(5.25, 12);
    expect(first.expectedCost).toBeCloseTo(105, 12);
    expect(first.successProbability).toBeCloseTo(1, 12);
    expect(first).toEqual(second);
    expect(first.quantiles.p10).toBeGreaterThanOrEqual(60);
    expect(first.quantiles.p90).toBeLessThanOrEqual(180);
  });
  it('accounts for imported failure progress rather than replaying from zero', () => {
    const cfg = config();
    cfg.start.grade = 'unique';
    cfg.start.failures = 2;
    cfg.start.lines = [line('b', 'unique'), line('b', 'unique'), line('b', 'unique')];
    cfg.target.mode = 'grade';
    const result = computeBenchmark(fixture(), cfg, 30, { sampleCount: 1000 });
    expect(result.expectedAttempts).toBe(1);
    expect(result.expectedCost).toBe(30);
    expect(result.cdfAtActual).toBe(1);
  });
  it('agrees with actual keep-before play across tiers', () => {
    const cfg = config();
    cfg.start.grade = 'unique';
    cfg.start.lines = [line('b', 'unique'), line('b', 'unique'), line('b', 'unique')];
    cfg.target.minimumGrade = 'unique';
    const data = fixture(),
      result = computeBenchmark(data, cfg, 200, { sampleCount: 10000, seed: 'compound' });
    const rng = seededRandom('actual');
    let cost = 0,
      attempts = 0,
      hits = 0;
    for (let n = 0; n < 2500; n++) {
      let state = createState(data, cfg, rng);
      while (state.status !== 'success') state = rollBatch(data, cfg, state, rng);
      cost += Number(state.spent.meso);
      attempts += Number(state.attempts);
      if (state.spent.meso <= 200n) hits++;
    }
    expect(cost / 2500 / result.expectedCost).toBeGreaterThan(0.95);
    expect(cost / 2500 / result.expectedCost).toBeLessThan(1.05);
    expect(attempts / 2500 / result.expectedAttempts).toBeGreaterThan(0.95);
    expect(attempts / 2500 / result.expectedAttempts).toBeLessThan(1.05);
    expect(Math.abs(hits / 2500 - result.cdfAtActual!)).toBeLessThan(0.04);
  });
  it('computes exact bounded amplification cost CDF and conditional remaining cost', () => {
    const cfg = config();
    cfg.mode = 'soulAmplification';
    cfg.start.stage = 0;
    cfg.start.failures = 0;
    cfg.target.mode = 'stage';
    cfg.target.stage = 1;
    const result = computeBenchmark(fixture(), cfg, 500000000);
    expect(result.expectedAttempts).toBeCloseTo(9.178244212102667, 10);
    expect(result.cdfAtActual).toBeCloseTo(0.05, 12);
    expect(result.distribution.at(-1)).toEqual({ cost: 13000000000, cdf: 1 });
    cfg.start.failures = 25;
    const guaranteed = computeBenchmark(fixture(), cfg, 500000000);
    expect(guaranteed.expectedAttempts).toBe(1);
    expect(guaranteed.cdfAtActual).toBe(1);
  });
  it('handles impossible, already achieved, and paths which can lose access to the target', () => {
    const data = fixture(),
      cfg = config();
    cfg.target.conditions[0].minValue = 4;
    expect(computeBenchmark(data, cfg).status).toBe('impossible');
    cfg.target.conditions[0].minValue = 3;
    cfg.start.lines = [line('a'), line('a'), line('a')];
    expect(computeBenchmark(data, cfg).status).toBe('already');
    cfg.start.grade = 'unique';
    cfg.start.lines = [line('b', 'unique'), line('b', 'unique'), line('b', 'unique')];
    cfg.target.minimumGrade = 'unique';
    data.potential.optionPools
      .find((p) => p.grade === 'legendary')!
      .options.forEach((o) => {
        o.type = 'c';
        o.displayText = 'c +1';
      });
    data.potential.ruleId = 'partial-test';
    const partial = computeBenchmark(data, cfg, 100, { sampleCount: 1000 });
    expect(partial.status).toBe('partial');
    expect(partial.expectedCost).toBe(Infinity);
    expect(partial.successProbability).toBeGreaterThan(0);
    expect(partial.successProbability).toBeLessThan(1);
  });
  it('samples extraordinarily rare geometric waiting times directly with stable logarithms', () => {
    const n = geometric(1e-12, () => 0.5);
    expect(n).toBeGreaterThan(6e11);
    expect(n).toBeLessThan(7e11);
    expect(geometricCdf(1e-12, n)).toBeCloseTo(0.5, 10);
  });
  it('keeps top-ten-percent and mean-based reactions below P95', () => {
    const b = computeBenchmark(fixture(), config());
    expect(evaluateLuck({ ...b, cdfAtActual: 0.1 }, 260)).toBe('jackpot');
    expect(evaluateLuck({ ...b, cdfAtActual: 0.2 }, 250)).toBe('happy');
    expect(evaluateLuck({ ...b, cdfAtActual: 0.5 }, b.expectedCost * 0.9)).toBe('neutral');
    expect(evaluateLuck({ ...b, cdfAtActual: 0.5 }, b.expectedCost)).toBe('neutral');
    expect(evaluateLuck({ ...b, cdfAtActual: 0.9 }, b.expectedCost * 1.1)).toBe('neutral');
    expect(evaluateLuck({ ...b, cdfAtActual: 0.949999 }, b.expectedCost * 2)).toBe('cry');
    expect(evaluateLuck({ ...b, cdfAtActual: undefined }, b.expectedCost * 2)).toBe('cry');
  });
  it('turns P95 and higher into a ghost regardless of the expected-cost ratio', () => {
    const b = computeBenchmark(fixture(), config());
    expect(evaluateLuck({ ...b, cdfAtActual: 0.95 }, b.expectedCost * 2)).toBe('ghost');
    expect(evaluateLuck({ ...b, cdfAtActual: 0.99 }, b.expectedCost * 2)).toBe('ghost');
    expect(evaluateLuck({ ...b, cdfAtActual: 1 }, b.expectedCost * 2)).toBe('ghost');
    expect(evaluateLuck({ ...b, cdfAtActual: 0.95 }, b.expectedCost * 0.8)).toBe('ghost');
    expect(evaluateLuck({ ...b, cdfAtActual: 1 }, b.expectedCost)).toBe('ghost');
  });
  it('does not judge already completed, impossible, partial, or invalid benchmarks', () => {
    const b = { ...computeBenchmark(fixture(), config()), cdfAtActual: 1 };
    expect(evaluateLuck({ ...b, status: 'already' }, 0)).toBeUndefined();
    expect(evaluateLuck({ ...b, status: 'impossible' }, b.expectedCost * 2)).toBeUndefined();
    expect(evaluateLuck({ ...b, status: 'partial' }, b.expectedCost * 2)).toBeUndefined();
    expect(evaluateLuck({ ...b, expectedCost: Infinity }, 1000)).toBeUndefined();
    expect(evaluateLuck({ ...b, expectedCost: 0 }, 1)).toBeUndefined();
  });
});
