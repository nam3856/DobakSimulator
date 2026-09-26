import type { BenchmarkResult, Grade, LuckReaction, OptionLine, SimulationConfig } from '../types';
import {
  allCandidates,
  benchmarkUnit,
  eligibleCandidates,
  effectiveBatchSize,
  effectiveGradeUpChance,
  GRADES,
  gradeRank,
  guaranteedAfterFailures,
  isPrime,
  isNormalAbility,
  isSequentialPotentialBatch,
  lineIdentity,
  potentialRules,
  tupleIdentity,
  type Candidate,
  type RuleData,
} from './rules';
import {
  amplificationChance,
  attemptCost,
  costValue,
  prepareDraw,
  validateConfig,
} from './simulation';
import { conditionMatchesLine, matchTarget, metricValue } from './target';
import { usesAbilityProgression } from './ability-strategy';
import { abilityStrategyBenchmark } from './ability-benchmark';
import { abilityNormalBenchmark } from './ability-normal-benchmark';
import { etherPrice } from './soul-cost';
import {
  finiteGeometricMean,
  gcd,
  geometric,
  geometricCdf,
  sampleWeighted,
  seededRandom,
  stableStringify,
  upperBound,
} from './math';

interface OutcomeGroup {
  probability: number;
  mass: number;
}
export interface OutcomeAnalysis {
  targetProbability: number;
  currentProbability: number;
  groups: OutcomeGroup[];
  totalProbability: number;
}
const outcomeCache = new Map<string, OutcomeAnalysis>();

function cacheKey(data: RuleData, config: SimulationConfig, grade: Grade, groups: boolean): string {
  return stableStringify({
    rule: config.ruleVersion,
    pot: data.potential.ruleId,
    add: data.additional.ruleId,
    gold: data.gold.ruleId,
    soul: data.soul.ruleId,
    ability: data.ability.ruleId,
    mode: config.mode,
    abilityResetMode: config.abilityResetMode ?? 'advanced',
    cubeType: config.cubeType,
    category: config.category,
    level: config.level,
    stage: config.start.stage,
    grade,
    target: config.target,
    current: config.start.lines,
    locks: config.lockedSlots,
    groups,
  });
}

/** Enumerate the three-line draw tree once, applying exclusions inside each line grade. */
export function analyzeOutcomes(
  data: RuleData,
  config: SimulationConfig,
  grade: Grade,
  includeGroups = true,
): OutcomeAnalysis {
  const key = cacheKey(data, config, grade, includeGroups);
  const cached = outcomeCache.get(key);
  if (cached) return cached;
  if (gradeRank(grade) < gradeRank(config.target.minimumGrade))
    return {
      targetProbability: 0,
      currentProbability: 0,
      groups: [{ probability: 0, mass: 1 }],
      totalProbability: 1,
    };
  if (config.target.mode === 'grade')
    return { targetProbability: 1, currentProbability: 0, groups: [], totalProbability: 1 };
  const prepared = prepareDraw(data, config, grade, config.start.lines);
  const fixed = prepared.fixed;
  const slots = [0, 1, 2].filter((slot) => !fixed.has(slot));
  const chosen: OptionLine[] = [0, 1, 2].map((slot) => fixed.get(slot)?.line as OptionLine);
  const prefix = [...fixed.values()];
  // Small integer line identities avoid retaining three large text strings for every outcome.
  const identities = new Map<string, number>();
  const id = (line: OptionLine) => {
    const text = lineIdentity(line);
    let value = identities.get(text);
    if (value === undefined) {
      value = identities.size;
      identities.set(text, value);
    }
    return value;
  };
  for (const list of prepared.candidates) for (const candidate of list) id(candidate.line);
  const lineIds = new WeakMap<OptionLine, number>();
  for (const list of prepared.candidates)
    for (const candidate of list) lineIds.set(candidate.line, id(candidate.line));
  const selectedIds = [0, 1, 2].map((slot) => (fixed.has(slot) ? id(fixed.get(slot)!.line) : -1));
  const currentIds = config.start.lines.map((line) => identities.get(lineIdentity(line)) ?? -2);
  const base = identities.size + 1;
  const outcomes = includeGroups ? new Map<number, { p: number; hit: boolean }>() : undefined;
  let total = 0,
    targetProbability = 0,
    currentProbability = 0;
  const currentWalk = (depth: number, probability: number) => {
    if (depth === slots.length) {
      currentProbability += probability;
      return;
    }
    const slot = slots[depth];
    for (const candidate of eligibleCandidates(prepared.candidates[slot], prefix)) {
      if (lineIds.get(candidate.line) !== currentIds[slot]) continue;
      prefix.push(candidate);
      currentWalk(depth + 1, probability * candidate.probability);
      prefix.pop();
    }
  };
  if (currentIds.length === 3 && [...fixed].every(([slot, c]) => id(c.line) === currentIds[slot]))
    currentWalk(0, 1);
  const conditionOnLine = conditionMatchesLine;
  const exactWanted = new Map<number, number>();
  if (config.target.mode === 'exact')
    for (const line of config.target.lines) {
      const identity = identities.get(lineIdentity(line)) ?? -2;
      exactWanted.set(identity, (exactWanted.get(identity) ?? 0) + 1);
    }
  const conditionPossibilities = config.target.conditions.map((condition) =>
    [0, 1, 2].map((slot) =>
      prepared.candidates[slot].some((c) => conditionOnLine(condition, c.line, slot)),
    ),
  );
  const conditionTypes = config.target.conditions.map(
    (condition) =>
      prepared.candidates
        .flat()
        .find(
          (c) =>
            c.line.type === condition.type ||
            c.line.abilityTypeId === condition.type ||
            c.line.id === condition.type,
        )?.line.abilityTypeId ?? condition.type,
  );
  const conditionMaxima = config.target.conditions.map((condition) =>
    [0, 1, 2].map((slot) =>
      Math.max(
        ...prepared.candidates[slot].map((candidate) =>
          metricValue([candidate.line], condition.type),
        ),
      ),
    ),
  );
  // Bounds prune the overwhelmingly common misses for very rare ability/exact goals.
  const bound = (depth: number): 'hit' | 'miss' | undefined => {
    if (includeGroups || depth === slots.length) return undefined;
    const selected = [...fixed.keys(), ...slots.slice(0, depth)];
    const remaining = slots.slice(depth);
    if (config.target.mode === 'exact') {
      const counts = new Map<number, number>();
      for (const slot of selected) {
        const identity = selectedIds[slot];
        counts.set(identity, (counts.get(identity) ?? 0) + 1);
        if (counts.get(identity)! > (exactWanted.get(identity) ?? 0)) return 'miss';
      }
      if (exactWanted.has(-2)) return 'miss';
    }
    if (config.target.mode === 'ability') {
      const results = config.target.conditions.map((condition, index) => {
        const count = selected.filter((slot) =>
          conditionOnLine(condition, chosen[slot], slot),
        ).length;
        const possible =
          count + remaining.filter((slot) => conditionPossibilities[index][slot]).length;
        return {
          met: count >= (condition.count ?? 1),
          possible: possible >= (condition.count ?? 1),
          missing: Math.max(0, (condition.count ?? 1) - count),
        };
      });
      if (config.target.match === 'all') {
        if (results.some((result) => !result.possible)) return 'miss';
        const needed = new Map<string, number>();
        results.forEach((result, index) => {
          const type = conditionTypes[index];
          needed.set(type, Math.max(needed.get(type) ?? 0, result.missing));
        });
        if ([...needed.values()].reduce((sum, n) => sum + n, 0) > remaining.length) return 'miss';
        // Overlapping requirements still need distinct assigned lines at the leaf.
      } else {
        if (results.some((result) => result.met)) return 'hit';
        if (results.every((result) => !result.possible)) return 'miss';
      }
    }
    if (
      config.target.mode === 'sum' &&
      config.target.conditions.every(
        (c) =>
          c.maxValue === undefined &&
          c.minGrade === undefined &&
          c.slot === undefined &&
          c.slots === undefined &&
          c.count === undefined,
      )
    ) {
      const partial = selected.map((slot) => chosen[slot]);
      if (matchTarget(config.target, { grade, lines: partial, stage: config.start.stage }))
        return 'hit';
      const possibilities = config.target.conditions.map((condition, index) => {
        if (condition.type === 'ignoreDefensePercent') return true;
        let maximum = metricValue(partial, condition.type);
        for (const slot of remaining) maximum += conditionMaxima[index][slot];
        return maximum + 1e-10 >= condition.minValue;
      });
      if (
        config.target.match === 'all'
          ? possibilities.some((p) => !p)
          : possibilities.every((p) => !p)
      )
        return 'miss';
    }
    return undefined;
  };
  const walk = (depth: number, probability: number) => {
    const decided = bound(depth);
    if (decided) {
      total += probability;
      if (decided === 'hit') targetProbability += probability;
      return;
    }
    if (depth === slots.length) {
      const hit = matchTarget(config.target, { grade, lines: chosen, stage: config.start.stage });
      if (outcomes) {
        const identity = (selectedIds[0] * base + selectedIds[1]) * base + selectedIds[2];
        const found = outcomes.get(identity);
        if (found) {
          found.p += probability;
          found.hit ||= hit;
        } else outcomes.set(identity, { p: probability, hit });
      } else {
        total += probability;
        if (hit) targetProbability += probability;
      }
      return;
    }
    const slot = slots[depth];
    for (const candidate of eligibleCandidates(prepared.candidates[slot], prefix)) {
      chosen[slot] = candidate.line;
      selectedIds[slot] = lineIds.get(candidate.line)!;
      prefix.push(candidate);
      walk(depth + 1, probability * candidate.probability);
      prefix.pop();
    }
  };
  walk(0, 1);
  const groups: OutcomeGroup[] = [];
  if (outcomes) {
    const bins = new Map<string, OutcomeGroup>();
    for (const outcome of outcomes.values()) {
      total += outcome.p;
      if (outcome.hit) {
        targetProbability += outcome.p;
        continue;
      }
      const groupKey = outcome.p.toPrecision(14);
      const bin = bins.get(groupKey);
      if (bin) bin.mass += outcome.p;
      else bins.set(groupKey, { probability: outcome.p, mass: outcome.p });
    }
    groups.push(...bins.values());
  }
  if (!(total > 0) || Math.abs(total - 1) > 1e-6)
    throw new Error(`옵션 확률 합계 검증에 실패했습니다 (${total}).`);
  const result: OutcomeAnalysis = {
    targetProbability: Math.min(1, targetProbability / total),
    currentProbability: currentProbability / total,
    groups: groups.map((group) => ({
      probability: group.probability / total,
      mass: group.mass / total,
    })),
    totalProbability: total,
  };
  if (outcomeCache.size >= 40) outcomeCache.delete(outcomeCache.keys().next().value!);
  outcomeCache.set(key, result);
  return result;
}

interface Phase {
  grade: Grade;
  analysis: OutcomeAnalysis;
  upgrade: number;
  guarantee?: number;
  cost: number;
  batchSize: 1 | 3;
}
interface PhaseEvents {
  attempts: number;
  upgradeProbability: number;
  localSuccess: number;
}
const effectiveTargetProbability = (q: number, r: number): number =>
  r >= 1 ? 0 : Math.min(1, Math.max(0, q / (1 - r)));
function events(phase: Phase, currentProbability: number, failures: number): PhaseEvents {
  const q = phase.analysis.targetProbability;
  const p = effectiveTargetProbability(q, currentProbability);
  if (phase.batchSize === 3) {
    const batchP = p >= 1 ? 1 : -Math.expm1(3 * Math.log1p(-p));
    return {
      attempts: batchP > 0 ? 3 / batchP : Infinity,
      upgradeProbability: 0,
      localSuccess: batchP > 0 ? 1 : 0,
    };
  }
  const u = phase.upgrade;
  const hazard = u + (1 - u) * p;
  if (phase.guarantee !== undefined) {
    const ordinary = Math.max(0, phase.guarantee - failures);
    const survival =
      hazard >= 1 ? (ordinary === 0 ? 1 : 0) : Math.exp(ordinary * Math.log1p(-hazard));
    const prefix = finiteGeometricMean(hazard, ordinary);
    return {
      attempts: prefix + survival,
      upgradeProbability: u * prefix + survival,
      localSuccess: (1 - u) * p * prefix,
    };
  }
  if (!(hazard > 0)) return { attempts: Infinity, upgradeProbability: 0, localSuccess: 0 };
  return {
    attempts: 1 / hazard,
    upgradeProbability: u / hazard,
    localSuccess: ((1 - u) * p) / hazard,
  };
}

function emptyResult(
  config: SimulationConfig,
  status: BenchmarkResult['status'],
  note?: string,
): BenchmarkResult {
  const zero = status === 'already';
  return {
    status,
    expectedCost: zero ? 0 : Infinity,
    expectedAttempts: zero ? 0 : Infinity,
    successProbability: zero ? 1 : 0,
    unit: benchmarkUnit(config),
    method: 'analytic',
    sampleCount: 0,
    quantiles: { p10: zero ? 0 : Infinity, p50: zero ? 0 : Infinity, p90: zero ? 0 : Infinity },
    distribution: zero ? [{ cost: 0, cdf: 1 }] : [],
    note,
  };
}

function geometricResult(
  config: SimulationConfig,
  p: number,
  cost: number,
  actualCost?: number,
): BenchmarkResult {
  if (!(p > 0)) return emptyResult(config, 'impossible', '선택한 목표를 얻을 수 없습니다.');
  const size = effectiveBatchSize(config, config.start.grade);
  const batchP = p >= 1 ? 1 : -Math.expm1(size * Math.log1p(-p));
  const quantile = (q: number) =>
    batchP >= 1
      ? size * cost
      : Math.max(1, Math.ceil(Math.log1p(-q) / Math.log1p(-batchP))) * size * cost;
  const cdf = (x: number) =>
    geometricCdf(batchP, Math.floor((x + Math.abs(x) * Number.EPSILON) / (cost * size)));
  const distribution = Array.from({ length: 51 }, (_, i) => {
    const c = quantile(i === 0 ? 0.000001 : i / 51);
    return { cost: c, cdf: cdf(c) };
  });
  return {
    status: 'ready',
    expectedCost: (size * cost) / batchP,
    expectedAttempts: size / batchP,
    successProbability: 1,
    unit: benchmarkUnit(config),
    method: 'analytic',
    sampleCount: 0,
    quantiles: { p10: quantile(0.1), p50: quantile(0.5), p90: quantile(0.9) },
    distribution,
    cdfAtActual: actualCost === undefined ? undefined : cdf(actualCost),
    note:
      size === 3 ? '같은 현재 옵션에서 3개 후보를 생성하며 항상 3회 비용을 계산합니다.' : undefined,
  };
}

function amplificationBenchmark(
  data: RuleData,
  config: SimulationConfig,
  actualCost?: number,
  options: BenchmarkOptions = {},
): BenchmarkResult {
  let divisor = 0n;
  const stages = [];
  let expectedAttempts = 0,
    expectedCost = 0;
  for (let stage = config.start.stage; stage < config.target.stage; stage++) {
    const rule = data.soul.amplificationStages.find((s) => s.stage === stage + 1)!;
    const cost = BigInt(rule.systemCostPerAttempt) + etherPrice(config, stage + 1);
    divisor = gcd(divisor, cost);
    let survival = 1,
      mean = 0;
    const pmf: number[] = [0];
    const startingFailure = stage === config.start.stage ? config.start.failures : 0;
    for (let failure = startingFailure; failure <= rule.guaranteedAfterFailures; failure++) {
      mean += survival;
      const p = amplificationChance(data, stage, failure);
      pmf.push(survival * p);
      survival *= 1 - p;
    }
    stages.push({ cost, pmf });
    expectedAttempts += mean;
    expectedCost += mean * Number(cost);
  }
  // Arbitrary user prices may have a gcd of one. Never allocate an array per meso.
  const latticeSize = stages.reduce(
    (sum, stage) => sum + Number(stage.cost / divisor) * (stage.pmf.length - 1),
    1,
  );
  if (latticeSize > 200_000) {
    const count = Math.max(1, Math.floor(options.sampleCount ?? 500_000));
    const rng = seededRandom(options.seed ?? 'soul-ether-distribution-v1');
    const samples = new Float64Array(count);
    const cumulativeStages = stages.map(({ cost, pmf }) => {
      let total = 0;
      return { cost: Number(cost), cdf: pmf.slice(1).map((p) => (total += p)) };
    });
    for (let index = 0; index < count; index++)
      for (const stage of cumulativeStages)
        samples[index] +=
          stage.cost * (Math.min(stage.cdf.length - 1, upperBound(stage.cdf, rng())) + 1);
    samples.sort();
    const quantile = (q: number) => samples[Math.max(0, Math.ceil(q * count) - 1)];
    return {
      status: 'ready',
      expectedCost,
      expectedAttempts,
      successProbability: 1,
      unit: 'meso',
      method: 'sampled',
      sampleCount: count,
      quantiles: { p10: quantile(0.1), p50: quantile(0.5), p90: quantile(0.9) },
      distribution: Array.from({ length: 101 }, (_, index) => {
        const cost = quantile(index / 100);
        return { cost, cdf: upperBound(samples, cost) / count };
      }),
      cdfAtActual: actualCost === undefined ? undefined : upperBound(samples, actualCost) / count,
      note: '강화 메소와 입력 단가로 환산한 에테르를 합산합니다. 평균은 해석값, 비용 분포·백분위는 고정 시드 역누적분포 표본 추정입니다.',
    };
  }
  let distribution = new Float64Array([1]);
  for (const stage of stages) {
    const stride = Number(stage.cost / divisor);
    const next = new Float64Array(distribution.length + (stage.pmf.length - 1) * stride);
    for (let before = 0; before < distribution.length; before++)
      if (distribution[before] > 0)
        for (let attempts = 1; attempts < stage.pmf.length; attempts++)
          next[before + attempts * stride] += distribution[before] * stage.pmf[attempts];
    distribution = next;
  }
  const points: { cost: number; cdf: number }[] = [];
  let cumulative = 0;
  for (let index = 0; index < distribution.length; index++) {
    cumulative += distribution[index];
    if (distribution[index] > 0)
      points.push({ cost: index * Number(divisor), cdf: Math.min(1, cumulative) });
  }
  if (points.length) points[points.length - 1].cdf = 1;
  const quantile = (q: number) => points.find((point) => point.cdf >= q)!.cost;
  const cdf = (cost: number) => {
    let answer = 0;
    for (const point of points) {
      if (point.cost > cost) break;
      answer = point.cdf;
    }
    return answer;
  };
  return {
    status: 'ready',
    expectedCost,
    expectedAttempts,
    successProbability: 1,
    unit: 'meso',
    method: 'analytic',
    sampleCount: 0,
    quantiles: { p10: quantile(0.1), p50: quantile(0.5), p90: quantile(0.9) },
    distribution: points,
    cdfAtActual: actualCost === undefined ? undefined : cdf(actualCost),
    note: '강화 메소와 입력 단가로 환산한 에테르를 합산하여 기댓값과 행운을 계산합니다.',
  };
}

interface PhaseMean {
  cost: number;
  attempts: number;
  success: number;
}
const weighted = (probability: number, value: number) =>
  probability <= 0 ? 0 : probability * value;

export interface BenchmarkOptions {
  sampleCount?: number;
  seed?: string;
}
/** Exact mean, inverse-CDF compound samples. Never simulates every failed reroll. */
export function computeBenchmark(
  data: RuleData,
  config: SimulationConfig,
  actualCost?: number,
  options: BenchmarkOptions = {},
): BenchmarkResult {
  const errors = validateConfig(data, config);
  if (errors.length) throw new Error(errors.join('\n'));
  if (matchTarget(config.target, config.start))
    return emptyResult(
      config,
      'already',
      '시작 옵션이 이미 목표를 만족합니다. 행운을 판정하지 않습니다.',
    );
  if (config.mode === 'soulAmplification')
    return amplificationBenchmark(data, config, actualCost, options);
  if (config.start.lines.length !== 3)
    throw new Error('초기 옵션 세 줄을 먼저 생성한 뒤 예상 비용을 계산해주세요.');
  if (isNormalAbility(config))
    return abilityNormalBenchmark(
      data,
      config,
      analyzeOutcomes(data, config, config.start.grade, false),
      actualCost,
    );
  if (usesAbilityProgression(config))
    return abilityStrategyBenchmark(data, config, actualCost, options);
  if (config.mode === 'ability' || isPrime(config) || config.start.grade === 'legendary') {
    const analysis = analyzeOutcomes(data, config, config.start.grade, false);
    return geometricResult(
      config,
      effectiveTargetProbability(analysis.targetProbability, analysis.currentProbability),
      Number(costValue(config, attemptCost(data, config, config.start.grade, config.start.stage))),
      actualCost,
    );
  }
  const rules = potentialRules(data, config);
  const phases: Phase[] = GRADES.slice(GRADES.indexOf(config.start.grade)).map((grade) => {
    const rule = rules.grades.find((r) => r.grade === grade)!;
    return {
      grade,
      analysis: analyzeOutcomes(data, config, grade, true),
      upgrade: effectiveGradeUpChance(config, rule),
      guarantee: guaranteedAfterFailures(rule),
      cost: Number(costValue(config, attemptCost(data, config, grade, config.start.stage))),
      // Grouping sequential attempts does not change their stopping time or paid distribution.
      batchSize: isSequentialPotentialBatch(config, grade) ? 1 : effectiveBatchSize(config, grade),
    };
  });
  const includedMeans: PhaseMean[] = new Array(phases.length);
  function fromState(index: number, r: number, failures: number): PhaseMean {
    const phase = phases[index],
      event = events(phase, r, failures);
    const future = includedMeans[index + 1] ?? { cost: Infinity, attempts: Infinity, success: 0 };
    const success = event.localSuccess + event.upgradeProbability * future.success;
    return {
      cost: event.attempts * phase.cost + weighted(event.upgradeProbability, future.cost),
      attempts: event.attempts + weighted(event.upgradeProbability, future.attempts),
      success: Math.min(1, success),
    };
  }
  for (let index = phases.length - 1; index >= 0; index--) {
    let cost = 0,
      attempts = 0,
      success = phases[index].analysis.targetProbability;
    for (const group of phases[index].analysis.groups) {
      const state = fromState(index, group.probability, 0);
      cost += weighted(group.mass, state.cost);
      attempts += weighted(group.mass, state.attempts);
      success += group.mass * state.success;
    }
    includedMeans[index] = { cost, attempts, success: Math.min(1, success) };
  }
  const mean = fromState(0, phases[0].analysis.currentProbability, config.start.failures);
  const successProbability = Math.min(1, mean.success);
  if (successProbability <= 0)
    return emptyResult(
      config,
      'impossible',
      '현재 상태와 등급 상승 경로에서는 목표를 얻을 수 없습니다.',
    );
  const sampleCount = options.sampleCount ?? 500_000;
  const rng = seededRandom(
    options.seed ??
      stableStringify({
        config: { ...config, unitPrices: {}, retryStart: undefined },
        engine: 'keep-before-v1',
      }),
  );
  const samples = new Float64Array(sampleCount);
  const groupCdfs = phases.map((phase) => {
    const groups = phase.analysis.groups,
      total = groups.reduce((sum, g) => sum + g.mass, 0);
    let cumulative = 0;
    return Float64Array.from(
      groups.map((group) => {
        cumulative += group.mass / total;
        return cumulative;
      }),
    );
  });
  for (let sample = 0; sample < sampleCount; sample++) {
    let index = 0,
      current = phases[0].analysis.currentProbability,
      failures = config.start.failures,
      total = 0;
    for (;;) {
      const phase = phases[index];
      const p = effectiveTargetProbability(phase.analysis.targetProbability, current);
      if (phase.batchSize === 3) {
        const batchP = p >= 1 ? 1 : -Math.expm1(3 * Math.log1p(-p));
        total += geometric(batchP, rng) * 3 * phase.cost;
        break;
      }
      const hazard = phase.upgrade + (1 - phase.upgrade) * p;
      const ordinary =
        phase.guarantee === undefined ? Infinity : Math.max(0, phase.guarantee - failures);
      const wait = geometric(hazard, rng);
      if (!Number.isFinite(wait) && !Number.isFinite(ordinary)) {
        total = Infinity;
        break;
      }
      const forced = wait > ordinary;
      const count = forced ? ordinary + 1 : wait;
      total += count * phase.cost;
      const upgrade = forced || (hazard > 0 && rng() < phase.upgrade / hazard);
      if (!upgrade) break;
      index++;
      if (index >= phases.length) {
        total = Infinity;
        break;
      }
      const next = phases[index].analysis;
      if (rng() < next.targetProbability) break;
      if (!next.groups.length) {
        total = Infinity;
        break;
      }
      current =
        next.groups[Math.min(next.groups.length - 1, upperBound(groupCdfs[index], rng()))]
          .probability;
      failures = 0;
    }
    samples[sample] = total;
  }
  samples.sort();
  const percentile = (p: number) =>
    samples[Math.min(samples.length - 1, Math.max(0, Math.ceil(p * samples.length) - 1))];
  const points: { cost: number; cdf: number }[] = [];
  for (let n = 0; n <= 100; n++) {
    const cost = percentile(n === 0 ? 1 / sampleCount : n / 100);
    if (!Number.isFinite(cost)) continue;
    const cdf = upperBound(samples, cost) / sampleCount;
    if (points.at(-1)?.cost === cost) points[points.length - 1].cdf = cdf;
    else points.push({ cost, cdf });
  }
  const partial = !Number.isFinite(mean.cost) || successProbability < 1 - 1e-10;
  return {
    status: partial ? 'partial' : 'ready',
    expectedCost: partial ? Infinity : mean.cost,
    expectedAttempts: partial ? Infinity : mean.attempts,
    successProbability,
    unit: benchmarkUnit(config),
    method: 'sampled',
    sampleCount,
    quantiles: { p10: percentile(0.1), p50: percentile(0.5), p90: percentile(0.9) },
    distribution: points,
    cdfAtActual:
      actualCost === undefined ? undefined : upperBound(samples, actualCost) / sampleCount,
    note: partial
      ? '등급 상승 후 목표를 얻을 수 없는 경로가 있어 무조건부 평균 비용은 무한대입니다.'
      : `평균은 해석 계산, 분포는 고정 시드 ${sampleCount.toLocaleString('ko-KR')}회 역누적분포 표본입니다. 기존 옵션 유지·등급 상승 적용 전략 기준입니다.${config.batchSize === 3 ? ' 레전드리 전에는 최대 3회 순차 진행하며 등급 상승·목표 달성 시 멈춥니다. 레전드리에서는 같은 보관 옵션으로 3회 비교하고 모두 과금합니다.' : ''}`,
  };
}

export function evaluateLuck(
  benchmark: BenchmarkResult,
  actualCost: number,
): LuckReaction | undefined {
  if (
    benchmark.status !== 'ready' ||
    !Number.isFinite(benchmark.expectedCost) ||
    benchmark.expectedCost <= 0
  )
    return undefined;
  if (benchmark.cdfAtActual !== undefined && benchmark.cdfAtActual >= 0.95) return 'ghost';
  if (benchmark.cdfAtActual !== undefined && benchmark.cdfAtActual <= 0.1) return 'jackpot';
  if (actualCost < benchmark.expectedCost * 0.9) return 'happy';
  if (actualCost <= benchmark.expectedCost * 1.1) return 'neutral';
  return 'cry';
}
