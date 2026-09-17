import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { seededRandom } from '../src/engine/math';
import {
  benchmarkStarforce,
  createStarforceState,
  maxStarforceStars,
  quoteStarforce,
  restoreStarforce,
  rollStarforce,
  validateStarforceConfig,
  type StarforceConfig,
  type StarforceRules,
} from '../src/engine/starforce';

const official = JSON.parse(
  readFileSync(new URL('../public/rules/starforce.json', import.meta.url), 'utf8'),
) as StarforceRules;
function config(patch: Partial<StarforceConfig> = {}): StarforceConfig {
  return {
    level: 150,
    startStars: 0,
    targetStars: 2,
    safeguard: false,
    restoration: 'trace12',
    replacementPrice: 1000,
    equipmentType: 'normal',
    ...patch,
  };
}
function fixture(max = 5): StarforceRules {
  return {
    ruleId: 'small-starforce',
    minimumLevel: 1,
    maximumLevel: 250,
    maximumStarBands: [{ minimumLevel: 1, maximumLevel: 250, maximumStar: max }],
    costFormula: {
      baseCost: 99,
      levelExponent: 0,
      starOffset: 1,
      starExponent: 0,
      roundTo: 100,
      denominators: [{ minimumStar: 0, maximumStar: max - 1, denominator: 1 }],
    },
    transitions: Array.from({ length: max }, (_, star) => ({
      star,
      successProbability: 0.5,
      maintainProbability: 0.5,
      decreaseProbability: 0,
      destroyProbability: 0,
      successStar: star + 1,
      traceStar: star,
    })),
    safeguard: {
      eligibleStars: [1],
      additionalBaseCostMultiplier: 2,
      destroyProbabilityMultiplier: 0,
    },
    restoration: {
      restoreToBase: { restoredStar: 0, mesoCost: '0', equipmentCount: 1 },
      fullRestoreBands: [
        {
          minimumLevel: 1,
          maximumLevel: 250,
          minimumTraceStar: 0,
          maximumTraceStar: max - 1,
          mesoCost: '500',
          equipmentCount: 2,
        },
      ],
    },
  };
}

describe('starforce rule application and individual attempts', () => {
  it('uses official normal caps, includes the automatic success bonus once, and rounds beta cost to 100 meso', () => {
    for (const [level, maximum] of [
      [1, 5],
      [94, 5],
      [95, 8],
      [107, 8],
      [108, 10],
      [118, 15],
      [128, 20],
      [138, 30],
      [250, 30],
    ])
      expect(maxStarforceStars(official, level)).toBe(maximum);
    expect(official.transitions).toHaveLength(30);
    for (const row of official.transitions) {
      expect(
        row.successProbability +
          row.maintainProbability +
          row.decreaseProbability +
          row.destroyProbability,
      ).toBeCloseTo(1, 12);
      expect(row.decreaseProbability).toBe(0);
    }
    const quote = quoteStarforce(official, config(), { stars: 0 });
    expect(quote.successProbability).toBe(0.9975);
    expect(quote.baseCost).toBe(136000n);
    expect(quote.cost).toBe(136000n);
    expect(quote.safeguardAllowed).toBe(false);
    expect(quoteStarforce(official, config(), { stars: 9 }).cost).toBe(1351000n);
    expect(() => maxStarforceStars(official, 251)).toThrow('1~250');
    expect(() => maxStarforceStars(official, 150, 'superior')).toThrow('슈페리얼');
  });

  it('safeguard adds twice the original cost, transfers only destruction to maintenance, and applies only at 15–17', () => {
    for (const star of [15, 16, 17]) {
      const cfg = config({ startStars: star, targetStars: star + 1, safeguard: true });
      const safe = quoteStarforce(official, cfg, { stars: star });
      const plain = quoteStarforce(official, { ...cfg, safeguard: false }, { stars: star });
      expect(safe.cost).toBe(plain.cost * 3n);
      expect(safe.successProbability).toBe(plain.successProbability);
      expect(safe.maintainProbability).toBeCloseTo(
        plain.maintainProbability + plain.destroyProbability,
        12,
      );
      expect(safe.destroyProbability).toBe(0);
      expect(safe.restoration).toBeUndefined();
      expect(
        rollStarforce(official, cfg, createStarforceState(official, cfg), () => 0.99999).result
          .outcome,
      ).toBe('stay');
    }
    const quote = quoteStarforce(
      official,
      config({ startStars: 18, targetStars: 19, safeguard: true }),
      { stars: 18 },
    );
    expect(quote.safeguardAllowed).toBe(false);
    expect(quote.safeguardActive).toBe(false);
    expect(quote.cost).toBe(quote.baseCost);
    expect(quote.destroyProbability).toBe(0.0674);
  });

  it('charges each outcome exactly once and leaves a destruction pending until explicit restoration', () => {
    const rules = fixture();
    rules.transitions[1] = {
      star: 1,
      successProbability: 0.25,
      maintainProbability: 0.25,
      decreaseProbability: 0.25,
      destroyProbability: 0.25,
      successStar: 2,
      traceStar: 1,
    };
    const cfg = config({ startStars: 1 });
    const start = createStarforceState(rules, cfg);
    for (const [random, outcome, to] of [
      [0, 'success', 2],
      [0.25, 'stay', 1],
      [0.5, 'down', 0],
      [0.75, 'destroy', null],
    ] as const) {
      const { state, result } = rollStarforce(rules, cfg, start, () => random);
      expect(result.outcome).toBe(outcome);
      expect(result.toStars).toBe(to);
      expect(state.attempts).toBe(1n);
      expect(state.enhancementMeso).toBe(100n);
      expect(state.spentMeso).toBe(100n);
      expect(state.replacementCopies).toBe(0n);
      if (outcome === 'destroy') {
        expect(state.status).toBe('destroyed');
        expect(state.destructions).toBe(1n);
        expect(state.pendingRestoration?.replacementCost).toBe(1000n);
        expect(() => rollStarforce(rules, cfg, state, () => 0)).toThrow('먼저 복구');
        const restored = restoreStarforce(rules, { ...cfg, replacementPrice: 9999 }, state);
        expect(restored.stars).toBe(0);
        expect(restored.status).toBe('ready');
        expect(restored.attempts).toBe(1n);
        expect(restored.restorations).toBe(1n);
        expect(restored.replacementCopies).toBe(1n);
        expect(restored.replacementMeso).toBe(1000n);
        expect(restored.spentMeso).toBe(1100n);
        expect(restored.history[0].restored).toBe(true);
        expect(state.history[0].restored).toBe(false);
        expect(() => restoreStarforce(rules, cfg, restored)).toThrow('복구할');
      }
    }
    expect(start.attempts).toBe(0n);
    expect(start.history).toEqual([]);
  });

  it('caps original-stage traces at 22 and charges the configured restoration meso and all replacement copies', () => {
    const cfg = config({
      level: 200,
      startStars: 29,
      targetStars: 30,
      restoration: 'original',
      replacementPrice: 12345,
    });
    const quote = quoteStarforce(official, cfg, { stars: 29 });
    expect(quote.restoration?.traceStars).toBe(22);
    expect(quote.restoration?.toStars).toBe(22);
    expect(quote.restoration?.equipmentCount).toBe(4n);
    expect(quote.restoration?.mesoCost).toBe(24200000000n);
    const broken = rollStarforce(
      official,
      cfg,
      createStarforceState(official, cfg),
      () => 0.999999,
    ).state;
    const restored = restoreStarforce(official, cfg, broken);
    expect(restored.stars).toBe(22);
    expect(restored.replacementCopies).toBe(4n);
    expect(restored.replacementMeso).toBe(49380n);
    expect(restored.restorationMeso).toBe(24200000000n);
    expect(restored.spentMeso).toBe(quote.cost + 24200000000n + 49380n);
    const basic = quoteStarforce(official, { ...cfg, restoration: 'trace12' }, { stars: 29 });
    expect(basic.restoration?.toStars).toBe(12);
    expect(basic.restoration?.equipmentCount).toBe(1n);
    expect(basic.restoration?.mesoCost).toBe(0n);
    expect(() =>
      quoteStarforce(
        official,
        config({ level: 155, startStars: 18, targetStars: 19, restoration: 'original' }),
        { stars: 18 },
      ),
    ).toThrow('복구 비용 자료');
  });

  it('keeps BigInt totals and only the latest 100 paid attempts without mutating old history', () => {
    const rules = fixture();
    const cfg = config();
    let state = createStarforceState(rules, cfg);
    const initial = state;
    state = { ...state, spentMeso: 1000000000000000000n, enhancementMeso: 1000000000000000000n };
    for (let n = 0; n < 105; n++) state = rollStarforce(rules, cfg, state, () => 0.75).state;
    expect(state.attempts).toBe(105n);
    expect(state.spentMeso).toBe(1000000000000010500n);
    expect(state.history).toHaveLength(100);
    expect(state.history[0].sequence).toBe(6n);
    expect(initial.history).toHaveLength(0);
    expect(() => rollStarforce(rules, cfg, state, () => 1)).toThrow('추첨값');
  });

  it('validates level caps and unit prices, and treats a satisfied start as a free completion', () => {
    expect(
      validateStarforceConfig(official, config({ level: 94, targetStars: 6 })).join(),
    ).toContain('0~5');
    expect(validateStarforceConfig(official, config({ replacementPrice: -1 })).join()).toContain(
      '가격',
    );
    expect(validateStarforceConfig(official, config({ replacementPrice: 1.5 })).join()).toContain(
      '가격',
    );
    const cfg = config({ level: 250, startStars: 30, targetStars: 30 });
    const state = createStarforceState(official, cfg);
    expect(state.status).toBe('success');
    expect(state.attempts).toBe(0n);
    expect(benchmarkStarforce(official, cfg)).toMatchObject({
      status: 'already',
      expectedMeso: 0,
      expectedAttempts: 0,
      expectedDestructions: 0,
    });
    expect(() => rollStarforce(official, cfg, state)).toThrow('이미 목표');
  });
});

describe('starforce analytic expected rewards', () => {
  it('solves retained-stage and destruction-return loops with separate enhancement, repair and item costs', () => {
    const rules = fixture();
    rules.transitions[1] = {
      star: 1,
      successProbability: 0.5,
      maintainProbability: 0,
      decreaseProbability: 0,
      destroyProbability: 0.5,
      successStar: 2,
      traceStar: 1,
    };
    // E0=2+E1; E1=1+0.5E0 gives six attempts and one destroyed item.
    expect(benchmarkStarforce(rules, config())).toMatchObject({
      status: 'ready',
      expectedAttempts: 6,
      expectedDestructions: 1,
      expectedEnhancementMeso: 600,
      expectedRestorationMeso: 0,
      expectedReplacementCopies: 1,
      expectedReplacementMeso: 1000,
      expectedMeso: 1600,
    });
    // Full repair keeps star1, so E1=2 and total attempts are four.
    expect(benchmarkStarforce(rules, config({ restoration: 'original' }))).toMatchObject({
      expectedAttempts: 4,
      expectedDestructions: 1,
      expectedEnhancementMeso: 400,
      expectedRestorationMeso: 500,
      expectedReplacementCopies: 2,
      expectedReplacementMeso: 2000,
      expectedMeso: 2900,
    });
    expect(benchmarkStarforce(rules, config({ safeguard: true }))).toMatchObject({
      expectedAttempts: 4,
      expectedDestructions: 0,
      expectedEnhancementMeso: 800,
      expectedMeso: 800,
    });
  });

  it('matches independent small-model trials including downgrade and destruction recovery', () => {
    const rules = fixture();
    rules.transitions[1] = {
      star: 1,
      successProbability: 0.4,
      maintainProbability: 0.2,
      decreaseProbability: 0.2,
      destroyProbability: 0.2,
      successStar: 2,
      traceStar: 1,
    };
    rules.transitions[2] = {
      star: 2,
      successProbability: 0.3,
      maintainProbability: 0.2,
      decreaseProbability: 0.3,
      destroyProbability: 0.2,
      successStar: 3,
      traceStar: 2,
    };
    const result = benchmarkStarforce(rules, config({ targetStars: 3 }));
    const rng = seededRandom('independent-starforce-model');
    let attempts = 0,
      destroyed = 0;
    const trials = 15000;
    for (let n = 0; n < trials; n++) {
      let star = 0;
      while (star < 3) {
        const r = rng();
        attempts++;
        if (star === 0) {
          if (r < 0.5) star++;
        } else if (star === 1) {
          if (r < 0.4) star++;
          else if (r < 0.6) {
          } else if (r < 0.8) star--;
          else {
            star = 0;
            destroyed++;
          }
        } else {
          if (r < 0.3) star++;
          else if (r < 0.5) {
          } else if (r < 0.8) star--;
          else {
            star = 0;
            destroyed++;
          }
        }
      }
    }
    expect(Math.abs(attempts / trials / result.expectedAttempts - 1)).toBeLessThan(0.03);
    expect(Math.abs(destroyed / trials / result.expectedDestructions - 1)).toBeLessThan(0.04);
    expect(
      Math.abs((attempts * 100 + destroyed * 1000) / trials / result.expectedMeso - 1),
    ).toBeLessThan(0.04);
  });

  it('retains finite exact means even for 30 consecutive rare successes', () => {
    const rules = fixture(30);
    for (const row of rules.transitions) {
      row.successProbability = 0.1;
      row.maintainProbability = 0;
      row.destroyProbability = 0.9;
    }
    const result = benchmarkStarforce(rules, config({ targetStars: 30, replacementPrice: 0 }));
    const expected = (1 - 0.1 ** 30) / (0.9 * 0.1 ** 30);
    expect(result.status).toBe('ready');
    expect(result.expectedAttempts / expected).toBeCloseTo(1, 12);
    expect(result.expectedDestructions / result.expectedAttempts).toBeCloseTo(0.9, 12);
    expect(result.expectedMeso / result.expectedAttempts).toBeCloseTo(100, 10);
  });

  it('does not display finite means for a reachable closed failure class', () => {
    const rules = fixture();
    rules.transitions[1] = {
      star: 1,
      successProbability: 0,
      maintainProbability: 1,
      decreaseProbability: 0,
      destroyProbability: 0,
      successStar: 2,
    };
    const result = benchmarkStarforce(rules, config({ replacementPrice: 0 }));
    expect(result.status).toBe('impossible');
    expect(result.expectedAttempts).toBe(Infinity);
    expect(result.expectedMeso).toBe(Infinity);
  });

  it('calculates the current official 30-star graph quickly for both restoration policies', () => {
    const began = performance.now();
    for (const restoration of ['trace12', 'original'] as const) {
      const result = benchmarkStarforce(
        official,
        config({ level: 250, targetStars: 30, restoration, replacementPrice: 1000000000 }),
      );
      expect(result.status).toBe('ready');
      expect(result.expectedMeso).toBeGreaterThan(1e12);
      expect(Number.isFinite(result.expectedMeso)).toBe(true);
      expect(result.expectedDestructions).toBeGreaterThan(1);
      expect(result.expectedMeso).toBeCloseTo(
        result.expectedEnhancementMeso +
          result.expectedRestorationMeso +
          result.expectedReplacementMeso,
        0,
      );
    }
    expect(performance.now() - began).toBeLessThan(1000);
  });
});
