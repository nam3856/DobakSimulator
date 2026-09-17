import {
  benchmarkStarforce,
  quoteStarforce,
  validateStarforceConfig,
  type StarforceBenchmark,
  type StarforceConfig,
  type StarforcePolicyStep,
  type StarforceQuote,
  type StarforceRules,
} from './starforce';
import {
  decimal,
  divide,
  fraction,
  minus,
  multiply,
  plus,
  solve,
  type Fraction,
} from './starforce-math';

export interface StarforceOptimization {
  status: StarforceBenchmark['status'];
  config: StarforceConfig;
  benchmark: StarforceBenchmark;
  baselineBenchmark: StarforceBenchmark | null;
  baselineError?: string;
  savedMeso: number | null;
  savedPercent: number | null;
  steps: StarforcePolicyStep[];
  scope: string;
}

interface Action {
  step: StarforcePolicyStep;
  quote: StarforceQuote;
  branches: { stars: number; probability: Fraction }[];
  reward: Fraction;
}
const less = (a: Fraction, b: Fraction) => a.n * b.d < b.n * a.d;

function action(step: StarforcePolicyStep, quote: StarforceQuote): Action {
  const probabilities = [
    quote.successProbability,
    quote.maintainProbability,
    quote.decreaseProbability,
    quote.destroyProbability,
  ].map(decimal);
  const mass = probabilities.reduce(plus, fraction(0n));
  const [success, stay, down, destroy] = probabilities.map((value) => divide(value, mass));
  return {
    step,
    quote,
    branches: [
      { stars: quote.successStar, probability: success },
      { stars: step.stars, probability: stay },
      { stars: quote.decreaseStar, probability: down },
      { stars: quote.restoration?.toStars ?? step.stars, probability: destroy },
    ].filter((branch) => branch.probability.n > 0n),
    reward: plus(
      fraction(quote.cost),
      multiply(destroy, fraction(quote.restoration?.totalCost ?? 0n)),
    ),
  };
}

function candidates(rules: StarforceRules, config: StarforceConfig, stars: number): Action[] {
  const rows: Action[] = [];
  for (const safeguard of rules.safeguard.eligibleStars.includes(stars) ? [false, true] : [false]) {
    const step: StarforcePolicyStep = { stars, safeguard, restoration: 'trace12' };
    const base = quoteStarforce(rules, { ...config, ...step, policy: undefined }, { stars });
    rows.push(action(step, base));
    if (base.destroyProbability === 0) continue;
    const trace = base.restoration!.traceStars;
    const available = rules.restoration.fullRestoreBands.some(
      (band) =>
        config.level >= band.minimumLevel &&
        config.level <= band.maximumLevel &&
        trace >= band.minimumTraceStar &&
        trace <= band.maximumTraceStar,
    );
    if (available) {
      const original: StarforcePolicyStep = { ...step, restoration: 'original' };
      rows.push(
        action(
          original,
          quoteStarforce(rules, { ...config, ...original, policy: undefined }, { stars }),
        ),
      );
    }
  }
  return rows;
}

function evaluate(policy: Action[]): Fraction[] | undefined {
  const count = policy.length;
  const matrix = policy.map((selected, star) => {
    const row = Array.from({ length: count + 1 }, () => fraction(0n));
    row[star] = fraction(1n);
    for (const branch of selected.branches)
      if (branch.stars < count) row[branch.stars] = minus(row[branch.stars], branch.probability);
    row[count] = selected.reward;
    return row;
  });
  return solve(matrix, count)?.map((row) => row[0]);
}

/** Expected total cost of repeating this action at its own stage before following V.
 * Removing the self loop before comparing is equivalent to the Bellman improvement
 * used by JIJAKBI. All decisions are rational, with no floating-point tolerance. */
function actionValue(selected: Action, values: Fraction[]): Fraction | undefined {
  let numerator = selected.reward;
  let self = fraction(0n);
  for (const branch of selected.branches) {
    if (branch.stars === selected.step.stars) self = plus(self, branch.probability);
    else if (branch.stars < values.length)
      numerator = plus(numerator, multiply(branch.probability, values[branch.stars]));
  }
  if (self.n >= self.d) return undefined;
  return divide(numerator, minus(fraction(1n), self));
}

/** Minimum mean total meso among stage-dependent safeguard and restoration policies.
 * Ordinary attempts are compulsory; waiting for another event, trading equipment,
 * scrolls and special equipment are outside this finite action set. */
export function optimizeStarforce(
  rules: StarforceRules,
  input: StarforceConfig,
): StarforceOptimization {
  const config = { ...input, policy: undefined };
  const errors = validateStarforceConfig(rules, config);
  if (errors.length) throw new Error(errors.join('\n'));
  let baselineBenchmark: StarforceBenchmark | null = null;
  let baselineError: string | undefined;
  try {
    baselineBenchmark = benchmarkStarforce(rules, config);
  } catch (error) {
    baselineError =
      error instanceof Error ? error.message : '수동 경로 기댓값을 계산할 수 없습니다.';
  }
  const finish = (next: StarforceConfig, benchmark: StarforceBenchmark): StarforceOptimization => {
    const comparable =
      baselineBenchmark &&
      Number.isFinite(baselineBenchmark.expectedMeso) &&
      Number.isFinite(benchmark.expectedMeso);
    const savedMeso = comparable
      ? Math.max(0, baselineBenchmark!.expectedMeso - benchmark.expectedMeso)
      : null;
    return {
      status: benchmark.status,
      config: next,
      benchmark,
      baselineBenchmark,
      ...(baselineError ? { baselineError } : {}),
      savedMeso,
      savedPercent:
        savedMeso === null
          ? null
          : baselineBenchmark!.expectedMeso > 0
            ? (savedMeso / baselineBenchmark!.expectedMeso) * 100
            : 0,
      steps: next.policy ?? [],
      scope:
        '현재 이벤트·장비 가격에서 단계별 파괴 방지와 12성/원래 단계 복구를 비교한 최소 평균 총비용',
    };
  };
  if (config.startStars >= config.targetStars)
    return finish(config, benchmarkStarforce(rules, config));
  const choices = Array.from({ length: config.targetStars }, (_, star) =>
    candidates(rules, config, star),
  );
  let policy = choices.map((rows) => rows[0]);
  const visited = new Set<string>();
  for (;;) {
    const key = JSON.stringify(policy.map((selected) => selected.step));
    if (visited.has(key))
      throw new Error('강화 루트 최적화가 수렴하지 않았습니다. 규칙 자료를 확인해 주세요.');
    visited.add(key);
    const values = evaluate(policy);
    if (!values) {
      const fallback = { ...config, policy: policy.map((row) => row.step) };
      return finish(fallback, benchmarkStarforce(rules, fallback));
    }
    let changed = false;
    const improved = policy.map((current, star) => {
      // Preserve the old policy on exact ties, so equivalent choices cannot cycle.
      let selected = current;
      let best = values[star];
      for (const candidate of choices[star]) {
        const value = actionValue(candidate, values);
        if (value && less(value, best)) {
          selected = candidate;
          best = value;
        }
      }
      changed ||= selected !== current;
      return selected;
    });
    if (!changed) {
      const optimal = { ...config, policy: policy.map((row) => row.step) };
      return finish(optimal, benchmarkStarforce(rules, optimal));
    }
    policy = improved;
  }
}
