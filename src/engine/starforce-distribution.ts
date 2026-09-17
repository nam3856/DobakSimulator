import type { BenchmarkResult } from '../types';
import { seededRandom, upperBound } from './math';
import {
  quoteStarforce,
  validateStarforceConfig,
  type StarforceConfig,
  type StarforceRules,
} from './starforce';

export interface StarforceDistributionOptions {
  sampleCount?: number;
  seed?: string | number;
}

export interface StarforceDistributionSummary {
  method: 'sampled';
  sampleCount: number;
  distribution: BenchmarkResult['distribution'];
  quantiles: BenchmarkResult['quantiles'];
  cdfAtActual?: number;
  note: string;
}

interface AggregateStep {
  attemptCost: number;
  restoreCost: number;
  nonMaintain: number;
  successInSuccessOrDestroy: number;
  successOrDestroyInNonMaintain: number;
  restoreStar: number;
  decreaseStar: number;
}

const COUNT_LIMIT = Number.MAX_SAFE_INTEGER;
function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('스타포스 분포 집계 횟수가 안전한 계산 범위를 초과했습니다.');
  return value;
}

/** Gamma–Poisson mixing for negative-binomial counts, ported from JIJAKBI's
 * StarforceAggregateSampler.cs. Neither sampler iterates over the requested count.
 * Gamma: Marsaglia–Tsang (2000); Poisson: Hörmann PTRS (1993).
 * Acceptance/rejection preserves the full distribution, without normal approximation. */
class AggregateVariates {
  private spareNormal: number | undefined;
  constructor(private readonly random: () => number) {}

  negativeBinomial(successes: number, probability: number): number {
    if (successes === 0 || probability >= 1) return 0;
    count(successes);
    if (!(probability > 0) || !Number.isFinite(probability))
      throw new Error('스타포스 분포를 계산할 수 있는 성공 확률이 아닙니다.');
    if (successes === 1)
      return count(Math.floor(Math.log(this.random()) / Math.log1p(-probability)));
    return this.poisson(this.gamma(successes) * ((1 - probability) / probability));
  }

  private normal(): number {
    if (this.spareNormal !== undefined) {
      const spare = this.spareNormal;
      this.spareNormal = undefined;
      return spare;
    }
    for (;;) {
      const x = 2 * this.random() - 1;
      const y = 2 * this.random() - 1;
      const radius = x * x + y * y;
      if (radius >= 1 || radius === 0) continue;
      const multiplier = Math.sqrt((-2 * Math.log(radius)) / radius);
      this.spareNormal = y * multiplier;
      return x * multiplier;
    }
  }

  private gamma(shape: number): number {
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const normal = this.normal();
      const root = 1 + c * normal;
      if (root <= 0) continue;
      const volume = root * root * root;
      const uniform = this.random();
      const squared = normal * normal;
      if (
        uniform < 1 - 0.0331 * squared * squared ||
        Math.log(uniform) < 0.5 * squared + d * (1 - volume + Math.log(volume))
      )
        return d * volume;
    }
  }

  private poisson(mean: number): number {
    if (!Number.isFinite(mean) || mean < 0 || mean > COUNT_LIMIT)
      throw new Error('스타포스 분포 집계 횟수가 안전한 계산 범위를 초과했습니다.');
    if (mean < 10) {
      const threshold = Math.exp(-mean);
      let product = this.random();
      let result = 0;
      while (product > threshold) {
        result++;
        product *= this.random();
      }
      return result;
    }
    const b = 0.931 + 2.53 * Math.sqrt(mean);
    const a = -0.059 + 0.02483 * b;
    const inverseAlpha = 1.1239 + 1.1328 / (b - 3.4);
    const squeeze = 0.9277 - 3.6224 / (b - 2);
    for (;;) {
      const u = this.random() - 0.5;
      const v = this.random();
      const distance = 0.5 - Math.abs(u);
      const proposed = Math.floor(((2 * a) / distance + b) * u + mean + 0.43);
      if (proposed < 0 || (distance < 0.013 && v > distance)) continue;
      if (
        (distance >= 0.07 && v <= squeeze) ||
        Math.log((v * inverseAlpha) / (a / (distance * distance) + b)) <=
          this.poissonLogMass(proposed, mean)
      )
        return count(proposed);
    }
  }

  /** Stable log Poisson mass, avoiding cancellation between terms of order k log k. */
  private poissonLogMass(value: number, mean: number): number {
    if (value === 0) return -mean;
    const inverse = 1 / value;
    const inverseSquared = inverse * inverse;
    let stirlingError: number;
    if (value < 32) {
      let logFactorial = 0;
      for (let n = 2; n <= value; n++) logFactorial += Math.log(n);
      stirlingError =
        logFactorial - (value + 0.5) * Math.log(value) + value - 0.5 * Math.log(2 * Math.PI);
    } else {
      stirlingError =
        inverse *
        (1 / 12 -
          inverseSquared *
            (1 / 360 -
              inverseSquared * (1 / 1260 - inverseSquared * (1 / 1680 - inverseSquared / 1188))));
    }
    let deviance: number;
    if (Math.abs(value - mean) < 0.1 * (value + mean)) {
      const ratio = (value - mean) / (value + mean);
      let term = 2 * value * ratio;
      const ratioSquared = ratio * ratio;
      deviance = (value - mean) * ratio;
      for (let divisor = 3; ; divisor += 2) {
        term *= ratioSquared;
        const next = deviance + term / divisor;
        if (next === deviance) break;
        deviance = next;
      }
    } else {
      deviance = value * Math.log(value / mean) + mean - value;
    }
    return -stirlingError - deviance - 0.5 * Math.log(2 * Math.PI * value);
  }
}

/** Sorted full-path costs, sampled by counts of transitions rather than individual
 * attempts. Going from s back to r adds one necessary upward crossing for r..s−1.
 * Processing stars from high to low thus accounts for every reset, including
 * destruction restored to the same star, and 23+ restored to 22.
 * The exact expectation is still benchmarkStarforce; this array is only a sampled CDF. */
export function sampleStarforceCosts(
  rules: StarforceRules,
  config: StarforceConfig,
  options: StarforceDistributionOptions = {},
): Float64Array {
  const errors = validateStarforceConfig(rules, config);
  if (errors.length) throw new Error(errors.join('\n'));
  const sampleCount = options.sampleCount ?? 500_000;
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 1_000_000)
    throw new Error('스타포스 분포 표본 수는 1~1,000,000이어야 합니다.');
  const totals = new Float64Array(sampleCount);
  if (config.startStars >= config.targetStars) return totals;
  const steps: AggregateStep[] = Array.from({ length: config.targetStars }, (_, star) => {
    const quote = quoteStarforce(rules, config, { stars: star });
    const {
      successProbability: success,
      maintainProbability: maintain,
      decreaseProbability: decrease,
      destroyProbability: destroy,
    } = quote;
    const restoreStar = quote.restoration?.toStars ?? star;
    if (
      !(success > 0) ||
      quote.successStar !== star + 1 ||
      (decrease > 0 && (quote.decreaseStar < 0 || quote.decreaseStar > star)) ||
      (destroy > 0 && (restoreStar < 0 || restoreStar > star))
    )
      throw new Error(
        '스타포스 분포는 한 단계 성공과 현재 이하 단계로 돌아가는 실패만 지원합니다.',
      );
    // The runtime samples normalized weights. Normalize here as well so tiny decimal
    // addition errors do not create an extra outcome in the aggregate distribution.
    const mass = success + maintain + decrease + destroy;
    const successOrDestroy = success + destroy;
    const nonMaintain = successOrDestroy + decrease;
    return {
      attemptCost: Number(quote.cost),
      restoreCost: Number(quote.restoration?.totalCost ?? 0n),
      nonMaintain: nonMaintain / mass,
      successInSuccessOrDestroy: success / successOrDestroy,
      successOrDestroyInNonMaintain: successOrDestroy / nonMaintain,
      restoreStar,
      decreaseStar: quote.decreaseStar,
    };
  });
  const variates = new AggregateVariates(seededRandom(options.seed ?? 'starforce-aggregate-v1'));
  const needed = new Float64Array(steps.length);
  for (let sample = 0; sample < sampleCount; sample++) {
    needed.fill(0);
    needed.fill(1, config.startStars);
    let total = 0;
    for (let star = steps.length - 1; star >= 0; star--) {
      const successes = needed[star];
      if (!successes) continue;
      const step = steps[star];
      const destructions = variates.negativeBinomial(successes, step.successInSuccessOrDestroy);
      let exits = count(successes + destructions);
      const decreases = variates.negativeBinomial(exits, step.successOrDestroyInNonMaintain);
      exits = count(exits + decreases);
      const maintains = variates.negativeBinomial(exits, step.nonMaintain);
      const attempts = count(exits + maintains);
      total += attempts * step.attemptCost + destructions * step.restoreCost;
      if (destructions)
        for (let crossed = step.restoreStar; crossed < star; crossed++)
          needed[crossed] = count(needed[crossed] + destructions);
      if (decreases)
        for (let crossed = step.decreaseStar; crossed < star; crossed++)
          needed[crossed] = count(needed[crossed] + decreases);
    }
    if (!Number.isFinite(total)) throw new Error('스타포스 분포 비용이 계산 범위를 초과했습니다.');
    totals[sample] = total;
  }
  return totals.sort();
}

/** An inclusive empirical CDF: P(total cost <= actual cost). Keep the sorted samples
 * in the Worker to answer another actual-cost query without drawing them again. */
export function starforceCostCdf(sortedCosts: Float64Array, actualCost: number): number {
  if (!sortedCosts.length) throw new Error('스타포스 분포 표본이 없습니다.');
  if (Number.isNaN(actualCost)) throw new Error('스타포스 실제 비용을 확인해 주세요.');
  return upperBound(sortedCosts, actualCost) / sortedCosts.length;
}

export function summarizeStarforceDistribution(
  sortedCosts: Float64Array,
  actualCost?: number,
): StarforceDistributionSummary {
  if (!sortedCosts.length) throw new Error('스타포스 분포 표본이 없습니다.');
  const sampleCount = sortedCosts.length;
  const quantile = (probability: number) =>
    sortedCosts[Math.max(0, Math.ceil(probability * sampleCount) - 1)];
  const distribution: BenchmarkResult['distribution'] = [];
  for (let percentile = 0; percentile <= 100; percentile++) {
    const cost = quantile(percentile / 100);
    if (distribution.at(-1)?.cost === cost) continue;
    distribution.push({ cost, cdf: upperBound(sortedCosts, cost) / sampleCount });
  }
  return {
    method: 'sampled',
    sampleCount,
    distribution,
    quantiles: { p10: quantile(0.1), p50: quantile(0.5), p90: quantile(0.9) },
    ...(actualCost === undefined ? {} : { cdfAtActual: starforceCostCdf(sortedCosts, actualCost) }),
    note: '평균은 해석값, 비용 분포·백분위는 고정 시드 전이 횟수 집계 표본 추정입니다. 강화·복구 메소와 복구용 장비 비용을 모두 반영합니다.',
  };
}
