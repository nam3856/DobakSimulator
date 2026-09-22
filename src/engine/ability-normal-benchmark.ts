import type { BenchmarkResult, OptionLine, SimulationConfig } from '../types';
import type { OutcomeAnalysis } from './benchmark';
import { benchmarkUnit, eligibleCandidates, tupleIdentity, type RuleData } from './rules';
import { attemptCost, costValue, prepareDraw } from './simulation';
import { matchTarget } from './target';

// Unlocked ability tables contain tens of millions of three-line outcomes. Only
// retain a complete visible-state model when locks make the draw tree small.
const MAX_EXACT_LEAVES = 100_000;
interface VisibleOutcome {
  probability: number;
  hit: number;
}

function exactMean(
  data: RuleData,
  config: SimulationConfig,
): { mean: number; firstSuccess: number } | undefined {
  const prepared = prepareDraw(data, config, config.start.grade, config.start.lines);
  const slots = [0, 1, 2].filter((slot) => !prepared.fixed.has(slot));
  const leafBound = slots.reduce((count, slot) => count * prepared.candidates[slot].length, 1);
  if (leafBound > MAX_EXACT_LEAVES) return undefined;
  const chosen: OptionLine[] = [0, 1, 2].map((slot) => prepared.fixed.get(slot)?.line!);
  const prefix = [...prepared.fixed.values()];
  const outcomes = new Map<string, VisibleOutcome>();
  let total = 0;
  const visit = (depth: number, probability: number) => {
    if (depth === slots.length) {
      const key = tupleIdentity(chosen);
      const outcome = outcomes.get(key) ?? { probability: 0, hit: 0 };
      outcome.probability += probability;
      if (matchTarget(config.target, { ...config.start, lines: chosen }))
        outcome.hit += probability;
      outcomes.set(key, outcome);
      total += probability;
      return;
    }
    const slot = slots[depth];
    for (const candidate of eligibleCandidates(prepared.candidates[slot], prefix)) {
      chosen[slot] = candidate.line;
      prefix.push(candidate);
      visit(depth + 1, probability * candidate.probability);
      prefix.pop();
    }
  };
  visit(0, 1);
  if (!(total > 0) || Math.abs(total - 1) > 1e-6)
    throw new Error(`일반 어빌리티 확률 합계 검증에 실패했습니다 (${total}).`);

  let numerator = 0;
  let denominator = 0;
  let success = 0;
  for (const outcome of outcomes.values()) {
    outcome.probability /= total;
    outcome.hit /= total;
    const { probability: p, hit: h } = outcome;
    success += h;
    // A visible tuple can contain both successful and unsuccessful hidden line
    // grades. Keep their masses separate: repeat exclusion applies to both.
    if (h >= 1) continue;
    const factor = (1 - p) / (1 - h);
    numerator += (p - h) * factor;
    denominator += h * factor;
  }
  const current = outcomes.get(tupleIdentity(config.start.lines));
  const p = current?.probability ?? 0;
  const h = current?.hit ?? 0;
  if (numerator === 0 && success > 0 && p < 1)
    return { mean: 1, firstSuccess: 1 };
  if (!(1 - p > 0) || !(denominator > 0))
    return { mean: Infinity, firstSuccess: 0 };
  return {
    mean: (1 - p + numerator / denominator) / (1 - h),
    firstSuccess: Math.min(1, Math.max(0, (success - h) / (1 - p))),
  };
}

/**
 * Normal resets adopt every miss, so the excluded visible tuple changes after
 * each roll. Applying the advanced keep-before q / (1 - r) geometric model here
 * would be wrong. Small spaces use the exact Markov mean; large spaces use an
 * explicitly identified independent-draw approximation without materializing
 * millions of states. Distribution approximations are always disclosed.
 */
export function abilityNormalBenchmark(
  data: RuleData,
  config: SimulationConfig,
  analysis: OutcomeAnalysis,
  actualCost?: number,
): BenchmarkResult {
  const q = analysis.targetProbability;
  const exact = q > 0 ? exactMean(data, config) : undefined;
  const mean = exact?.mean ?? (q > 0 ? 1 / q : Infinity);
  if (!Number.isFinite(mean))
    return {
      status: 'impossible',
      expectedCost: Infinity,
      expectedAttempts: Infinity,
      successProbability: 0,
      unit: benchmarkUnit(config),
      method: 'analytic',
      sampleCount: 0,
      quantiles: { p10: Infinity, p50: Infinity, p90: Infinity },
      distribution: [],
      note: '선택한 목표를 일반 재설정으로 얻을 수 없습니다.',
    };
  const cost = Number(
    costValue(config, attemptCost(data, config, config.start.grade, config.start.stage)),
  );
  const first = exact?.firstSuccess ?? q;
  const tail = first >= 1 ? 1 : Math.min(1, Math.max(0, (1 - first) / (mean - 1)));
  const cdfAttempts = (attempts: number) => {
    if (attempts < 1) return 0;
    if (first >= 1) return 1;
    if (attempts === 1) return first;
    return tail >= 1
      ? 1
      : Math.min(1, -Math.expm1(Math.log1p(-first) + (attempts - 1) * Math.log1p(-tail)));
  };
  const quantile = (percentile: number) => {
    if (percentile <= first) return cost;
    if (tail >= 1) return 2 * cost;
    const remaining = (Math.log1p(-percentile) - Math.log1p(-first)) / Math.log1p(-tail);
    return (1 + Math.max(1, Math.ceil(remaining))) * cost;
  };
  const cdf = (value: number) =>
    cdfAttempts(Math.floor((value + Math.abs(value) * Number.EPSILON) / cost));
  return {
    status: 'ready',
    expectedCost: mean * cost,
    expectedAttempts: mean,
    successProbability: 1,
    unit: benchmarkUnit(config),
    method: 'analytic',
    sampleCount: 0,
    quantiles: { p10: quantile(0.1), p50: quantile(0.5), p90: quantile(0.9) },
    distribution: Array.from({ length: 51 }, (_, index) => {
      const value = quantile(index === 0 ? 0.000001 : index / 51);
      return { cost: value, cdf: cdf(value) };
    }),
    cdfAtActual: actualCost === undefined ? undefined : cdf(actualCost),
    note: exact
      ? '일반 재설정은 실패 결과도 즉시 적용합니다. 평균은 동일 옵션 재등장 제외를 반영한 정확값이며, 비용 분포·백분위·행운은 첫 시도 확률과 평균에 맞춘 기하분포 근사입니다.'
      : '일반 재설정은 실패 결과도 즉시 적용합니다. 큰 옵션 공간의 평균·비용 분포·백분위·행운은 매회 독립 추첨으로 보는 기하분포 근사이며, 직전과 동일한 옵션을 제외하는 보정은 생략합니다.',
  };
}
