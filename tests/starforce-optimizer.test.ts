import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { optimizeStarforce } from '../src/engine/starforce-optimizer';
import {
  benchmarkStarforce,
  createStarforceState,
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
const config = (patch: Partial<StarforceConfig> = {}): StarforceConfig => ({
  level: 200,
  startStars: 15,
  targetStars: 22,
  safeguard: false,
  restoration: 'trace12',
  replacementPrice: 1000000000,
  equipmentType: 'normal',
  ...patch,
});
function smallRules(): StarforceRules {
  return {
    ...official,
    maximumStarBands: [{ minimumLevel: 1, maximumLevel: 250, maximumStar: 3 }],
    costFormula: {
      baseCost: 99,
      levelExponent: 0,
      starOffset: 1,
      starExponent: 0,
      roundTo: 100,
      denominators: [{ minimumStar: 0, maximumStar: 2, denominator: 1 }],
    },
    transitions: [0, 1, 2].map((star) => ({
      star,
      successProbability: 0.5,
      maintainProbability: star === 0 ? 0.5 : star === 1 ? 0.3 : 0.1,
      decreaseProbability: 0,
      destroyProbability: star === 0 ? 0 : star === 1 ? 0.2 : 0.4,
      successStar: star + 1,
      traceStar: star,
    })),
    safeguard: {
      eligibleStars: [1, 2],
      additionalBaseCostMultiplier: 2,
      destroyProbabilityMultiplier: 0,
    },
    restoration: {
      restoreToBase: { restoredStar: 0, mesoCost: '0', equipmentCount: 1 },
      fullRestoreBands: [1, 2].map((star) => ({
        minimumLevel: 1,
        maximumLevel: 250,
        minimumTraceStar: star,
        maximumTraceStar: star,
        mesoCost: star === 1 ? '150' : '500',
        equipmentCount: star,
      })),
    },
  };
}

/** Independent closed-form oracle. State0 costs 200 to reach1. For each later
 * stage E_s = (cost + d*repair + .5 E_{s+1} + d E_0)/(1-stay)
 * or E_s = cost/.5 + d*repair/.5 + E_{s+1} when restored to itself.
 * Enumerate all nine combinations; no production quote or solver is used. */
function enumerateSmall(price: number) {
  const rows: { cost: number; one: string; two: string }[] = [];
  for (const one of ['base', 'original', 'safe'])
    for (const two of ['base', 'original', 'safe']) {
      // E_s = a_s + b_s E_0, recurse backwards, then E_0=200+E_1.
      let a = 0,
        b = 0;
      for (const [star, choice] of [
        [2, two],
        [1, one],
      ] as const) {
        const destroy = choice === 'safe' ? 0 : star === 1 ? 0.2 : 0.4;
        const cost = choice === 'safe' ? 300 : 100;
        const repair = choice === 'original' ? (star === 1 ? 150 : 500) + star * price : price;
        const escape = choice === 'base' ? 0.5 + destroy : 0.5;
        a = (cost + destroy * repair + 0.5 * a) / escape;
        b = ((choice === 'base' ? destroy : 0) + 0.5 * b) / escape;
      }
      rows.push({ cost: (200 + a) / (1 - b), one, two });
    }
  return rows.sort((a, b) => a.cost - b.cost);
}

describe('Shining Star Force without guaranteed success', () => {
  it('keeps all success rates, reduces destruction only through21, and never discounts spare equipment', () => {
    for (const stars of [5, 10, 15, 21, 22, 29]) {
      const cfg = config({ startStars: stars, targetStars: stars + 1, restoration: 'original' });
      const plain = quoteStarforce(official, cfg, { stars });
      const shining = quoteStarforce(official, { ...cfg, event: 'shiningNoGuarantee' }, { stars });
      expect(shining.successProbability).toBe(plain.successProbability);
      expect(shining.successProbability).toBeLessThan(1);
      expect(shining.destroyProbability).toBeCloseTo(
        plain.destroyProbability * (stars <= 21 ? 0.7 : 1),
        12,
      );
      expect(shining.maintainProbability + shining.destroyProbability).toBeCloseTo(
        plain.maintainProbability + plain.destroyProbability,
        12,
      );
      expect(shining.cost).toBe(
        BigInt(Math.floor((Number(plain.baseCost) * 0.7) / 100 + 0.5) * 100),
      );
      if (plain.restoration) {
        expect(shining.restoration!.mesoCost * 5n).toBe(plain.restoration.mesoCost * 4n);
        expect(shining.restoration!.equipmentCount).toBe(plain.restoration.equipmentCount);
        expect(shining.restoration!.replacementCost).toBe(plain.restoration.replacementCost);
      }
    }
  });

  it('adds the undiscounted safeguard surcharge and shares the event quote with actual accounting', () => {
    const cfg = config({
      startStars: 15,
      targetStars: 16,
      event: 'shiningNoGuarantee',
      safeguard: true,
    });
    const quote = quoteStarforce(official, cfg, { stars: 15 });
    expect(quote.cost).toBe(BigInt(Math.floor((Number(quote.baseCost) * 2.7) / 100 + 0.5) * 100));
    expect(quote.destroyProbability).toBe(0);
    const miss = rollStarforce(
      official,
      cfg,
      createStarforceState(official, cfg),
      () => 0.999,
    ).state;
    expect(miss.spentMeso).toBe(quote.cost);
    expect(miss.stars).toBe(15);
    expect(miss.history[0].safeguard).toBe(true);
    expect(benchmarkStarforce(official, cfg).expectedMeso).toBeCloseTo(
      Number(quote.cost) / 0.315,
      5,
    );
  });

  it('matches an independent checked-in JIJAKBI production golden row', () => {
    // fixtures/starforce/production-golden.csv, L140-18to21. MVP/PC are inapplicable
    // at these stages, so the same full-restoration path needs no extra options.
    const cfg = config({
      level: 140,
      startStars: 18,
      targetStars: 21,
      event: 'shiningNoGuarantee',
      restoration: 'original',
    });
    const result = benchmarkStarforce(official, cfg);
    expect(quoteStarforce(official, cfg, { stars: 18 }).cost).toBe(77807700n);
    expect(Math.round(result.expectedEnhancementMeso)).toBe(1489911429);
    expect(Math.round(result.expectedRestorationMeso)).toBe(1748016000);
    expect(result.expectedDestructions).toBeCloseTo(0.902333333333, 10);
    expect(result.expectedReplacementCopies).toBeCloseTo(1.505111111111, 10);
    expect(Math.round(result.expectedMeso)).toBe(4743038540);
  });
});

describe('stage-dependent exact route optimization', () => {
  it('matches all nine independently enumerated routes and changes the route as equipment value changes', () => {
    const rules = smallRules();
    for (const price of [0, 200, 10000]) {
      const result = optimizeStarforce(
        rules,
        config({ startStars: 0, targetStars: 3, replacementPrice: price }),
      );
      const oracle = enumerateSmall(price);
      expect(result.status).toBe('ready');
      expect(result.benchmark.expectedMeso).toBeCloseTo(oracle[0].cost, 9);
      expect(result.config.policy).toHaveLength(3);
      const label = (star: number) =>
        result.config.policy![star].safeguard
          ? 'safe'
          : result.config.policy![star].restoration === 'original'
            ? 'original'
            : 'base';
      expect(oracle.find((row) => row.one === label(1) && row.two === label(2))!.cost).toBeCloseTo(
        oracle[0].cost,
        9,
      );
      expect(result.benchmark).toEqual(benchmarkStarforce(rules, result.config));
      expect(result.savedMeso).toBeCloseTo(
        result.baselineBenchmark!.expectedMeso - oracle[0].cost,
        8,
      );
    }
    const cheap = optimizeStarforce(
      rules,
      config({ startStars: 0, targetStars: 3, replacementPrice: 0 }),
    );
    const expensive = optimizeStarforce(
      rules,
      config({ startStars: 0, targetStars: 3, replacementPrice: 10000 }),
    );
    expect(cheap.config.policy).not.toEqual(expensive.config.policy);
    expect(expensive.config.policy!.slice(1).every((step) => step.safeguard)).toBe(true);
  });

  it('uses the applied stage policy in paid attempts and captures its selected repair at destruction', () => {
    const rules = smallRules();
    const cfg = config({ startStars: 0, targetStars: 3, replacementPrice: 10000 });
    const expensive = optimizeStarforce(rules, cfg);
    let state = createStarforceState(rules, expensive.config);
    state = rollStarforce(rules, expensive.config, state, () => 0).state;
    state = rollStarforce(rules, expensive.config, state, () => 0.99).state;
    expect(state.status).toBe('ready');
    expect(state.stars).toBe(1);
    expect(state.spentMeso).toBe(400n);
    expect(state.history[1].safeguard).toBe(true);
    const full = {
      ...cfg,
      replacementPrice: 0,
      policy: [
        { stars: 0, safeguard: false, restoration: 'trace12' as const },
        { stars: 1, safeguard: false, restoration: 'original' as const },
        { stars: 2, safeguard: false, restoration: 'trace12' as const },
      ],
    };
    state = rollStarforce(rules, full, createStarforceState(rules, full), () => 0).state;
    state = rollStarforce(rules, full, state, () => 0.99).state;
    expect(state.pendingRestoration?.policy).toBe('original');
    expect(state.pendingRestoration?.toStars).toBe(1);
    state = restoreStarforce(rules, full, state);
    expect(state.stars).toBe(1);
    expect(state.spentMeso).toBe(350n);
  });

  it('validates complete policies, preserves old configs, and handles missing original-level cost honestly', () => {
    expect(validateStarforceConfig(official, config())).toEqual([]);
    expect(validateStarforceConfig(official, config({ policy: [] })).join()).toContain('루트');
    const result = optimizeStarforce(official, config({ level: 155, restoration: 'original' }));
    expect(result.status).toBe('ready');
    expect(result.baselineBenchmark).toBeNull();
    expect(result.baselineError).toContain('복구 비용 자료');
    expect(result.savedMeso).toBeNull();
    expect(result.config.policy!.every((step) => step.restoration === 'trace12')).toBe(true);
    expect(validateStarforceConfig(official, result.config)).toEqual([]);
  });

  it('compares against manual choices even when the input already contains a route and is deterministic', () => {
    const cfg = config({ event: 'shiningNoGuarantee', replacementPrice: 10000000000 });
    const first = optimizeStarforce(official, cfg);
    const again = optimizeStarforce(official, first.config);
    expect(again).toEqual(first);
    expect(first.baselineBenchmark).toEqual(benchmarkStarforce(official, cfg));
    expect(first.benchmark.expectedMeso).toBeLessThanOrEqual(first.baselineBenchmark!.expectedMeso);
    expect(first.savedPercent).toBeGreaterThan(0);
  });

  it('completes the full official 30-stage optimization without simulating rare retries', () => {
    const began = performance.now();
    for (const event of ['none', 'shiningNoGuarantee'] as const) {
      const result = optimizeStarforce(official, config({ level: 250, targetStars: 30, event }));
      expect(result.status).toBe('ready');
      expect(Number.isFinite(result.benchmark.expectedMeso)).toBe(true);
      expect(result.benchmark.expectedMeso).toBeLessThan(result.baselineBenchmark!.expectedMeso);
      expect(result.config.policy).toHaveLength(30);
    }
    expect(performance.now() - began).toBeLessThan(2000);
    const already = optimizeStarforce(official, config({ startStars: 22, targetStars: 22 }));
    expect(already.status).toBe('already');
    expect(already.benchmark.expectedMeso).toBe(0);
  });
});
