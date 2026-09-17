import type { BenchmarkResult, OptionLine, SimulationConfig } from '../types';
import { abilityProgress } from './ability-strategy';
import { geometric, seededRandom, stableStringify, upperBound } from './math';
import {
  allCandidates,
  eligibleCandidates,
  lineIdentity,
  type Candidate,
  type RuleData,
} from './rules';
import { attemptCost } from './simulation';
import { conditionMatchesLine, matchTarget } from './target';

interface Transition {
  phase?: Phase;
  repeat: number;
  probability: number;
}
interface RankGroup {
  rank: number;
  mass: number;
  transitions: Transition[];
  cdf: Float64Array;
  futureCost: number;
  futureAttempts: number;
  futureSuccess: number;
}
interface Phase {
  key: string;
  locks: number[];
  lines: OptionLine[];
  fixed: Candidate[];
  cost: number;
  groups: RankGroup[];
  ready: boolean;
  events: Map<number, PhaseEvents>;
  means: Map<number, Mean>;
}
interface Mean {
  cost: number;
  attempts: number;
  success: number;
}
interface PhaseEvents {
  hazard: number;
  ranks: number[];
}
const resultCache = new WeakMap<
  RuleData,
  Map<string, { result: BenchmarkResult; samples: Float64Array }>
>();

/**
 * A retained miss changes only the excluded tuple probability r. The distribution of
 * strictly improving outcomes, conditional on their rank, does not depend on r.
 * This is a finite DAG (0 -> required lower locks -> success), not a reroll Monte Carlo.
 */
export function abilityStrategyBenchmark(
  data: RuleData,
  config: SimulationConfig,
  actualCost?: number,
  options: { sampleCount?: number; seed?: string } = {},
): BenchmarkResult {
  const resultKey = stableStringify({ config: { ...config, unitPrices: {} }, options });
  const cached = resultCache.get(data)?.get(resultKey);
  if (cached)
    return {
      ...cached.result,
      cdfAtActual:
        actualCost === undefined
          ? undefined
          : upperBound(cached.samples, actualCost) / cached.samples.length,
    };
  const raw = [0, 1, 2].map((slot) => allCandidates(data, config, 'legendary', slot));
  const byIdentity = raw.map((rows) => {
    const map = new Map<string, Candidate[]>();
    for (const candidate of rows) {
      const key = lineIdentity(candidate.line);
      const group = map.get(key);
      if (group) group.push(candidate);
      else map.set(key, [candidate]);
    }
    return map;
  });
  const signatures = new WeakMap<OptionLine, string>();
  const signature = (line: OptionLine) => {
    const cached = signatures.get(line);
    if (cached !== undefined) return cached;
    const value = config.target.conditions
      .flatMap((condition) => [0, 1, 2].map((slot) => +conditionMatchesLine(condition, line, slot)))
      .join('');
    signatures.set(line, value);
    return value;
  };
  for (const [slot, identities] of byIdentity.entries())
    for (const rows of identities.values()) {
      const outcomes = new Set(
        rows.map((row) =>
          config.target.conditions
            .map((condition) => +conditionMatchesLine(condition, row.line, slot))
            .join(''),
        ),
      );
      if (outcomes.size > 1)
        throw new Error(
          '같은 표시 옵션이 등급에 따라 목표 판정이 달라지는 확률표는 아랫줄 우선 계산에서 지원하지 않습니다. 현재 공식 어빌리티 표에는 이 중복이 없습니다.',
        );
    }
  // Lines with equal target behavior and equal per-result probabilities are exchangeable.
  // Include the entire visible-identity profile for grade-agnostic shared display values.
  const profiles = new Map<string, string>();
  const profile = (line: OptionLine) => {
    const identity = lineIdentity(line);
    let value = profiles.get(identity);
    if (value === undefined) {
      value = JSON.stringify(
        byIdentity.map((map) =>
          (map.get(identity) ?? []).map((candidate) => [
            candidate.limitGroup,
            candidate.line.grade,
            candidate.optionProbability,
            candidate.gradeProbability,
          ]),
        ),
      );
      profiles.set(identity, value);
    }
    return value;
  };
  const compressed = raw.map((rows) => {
    const groups = new Map<string, Candidate>();
    for (const candidate of rows) {
      const key = JSON.stringify([
        candidate.limitGroup,
        candidate.maxLines,
        candidate.line.grade,
        profile(candidate.line),
        signature(candidate.line),
      ]);
      const group = groups.get(key);
      if (group) {
        group.optionProbability += candidate.optionProbability;
        group.probability += candidate.probability;
      } else groups.set(key, { ...candidate });
    }
    return [...groups.values()];
  });
  const phases = new Map<string, Phase>();
  const eligibleCache = new Map<string, Candidate[]>();
  const relevantCandidates = new WeakMap<Candidate[], Candidate[]>();
  const probabilities = new Map<string, number>();
  const eligible = (slot: number, prefix: Candidate[]) => {
    const key = `${slot}:${prefix
      .map((candidate) => candidate.limitGroup)
      .sort()
      .join(',')}`;
    let rows = eligibleCache.get(key);
    if (!rows) {
      rows = eligibleCandidates(compressed[slot], prefix);
      eligibleCache.set(key, rows);
    }
    return rows;
  };
  const getPhase = (lines: readonly OptionLine[]): Phase => {
    const locks = abilityProgress(config, lines).lockedSlots;
    const fixed = locks.map((slot) => {
      const rows = byIdentity[slot].get(lineIdentity(lines[slot])) ?? [];
      const candidate = rows.find((row) => row.line.grade === lines[slot].grade) ?? rows[0];
      if (!candidate) throw new Error('자동 잠금 옵션이 현재 어빌리티 확률표에 없습니다.');
      return candidate;
    });
    const key = JSON.stringify(
      locks.map((slot, index) => [slot, fixed[index].limitGroup, signature(lines[slot])]),
    );
    const old = phases.get(key);
    if (old) return old;
    const phase: Phase = {
      key,
      locks,
      lines: [...lines],
      fixed,
      cost: Number(
        attemptCost(data, { ...config, lockedSlots: locks }, 'legendary', config.start.stage).meso,
      ),
      groups: [],
      ready: false,
      events: new Map(),
      means: new Map(),
    };
    phases.set(key, phase);
    return phase;
  };
  const repeatProbability = (phase: Phase, lines: readonly OptionLine[]): number => {
    const slots = [0, 1, 2].filter((slot) => !phase.locks.includes(slot));
    const key = `${phase.key}:${slots.map((slot) => profile(lines[slot])).join('|')}`;
    const old = probabilities.get(key);
    if (old !== undefined) return old;
    const prefix = [...phase.fixed];
    const walk = (depth: number): number => {
      if (depth === slots.length) return 1;
      const slot = slots[depth];
      const matching = byIdentity[slot].get(lineIdentity(lines[slot])) ?? [];
      let sum = 0;
      const denominators = new Map<string, number>();
      for (const row of compressed[slot])
        if (!prefix.some((p) => p.limitGroup === row.limitGroup))
          denominators.set(
            row.line.grade,
            (denominators.get(row.line.grade) ?? 0) + row.optionProbability,
          );
      for (const row of matching) {
        if (prefix.some((p) => p.limitGroup === row.limitGroup)) continue;
        const denominator = denominators.get(row.line.grade) ?? 0;
        if (!(denominator > 0)) continue;
        prefix.push(row);
        sum += ((row.gradeProbability * row.optionProbability) / denominator) * walk(depth + 1);
        prefix.pop();
      }
      return sum;
    };
    const result = Math.min(1, walk(0));
    probabilities.set(key, result);
    return result;
  };

  const events = (phase: Phase, repeat: number): PhaseEvents => {
    const cached = phase.events.get(repeat);
    if (cached) return cached;
    const mass = phase.groups.reduce((sum, group) => sum + group.mass, 0);
    const probability = repeat >= 1 ? 0 : Math.min(1, mass / (1 - repeat));
    const size = config.batchSize;
    const hazard = probability >= 1 ? 1 : -Math.expm1(size * Math.log1p(-probability));
    if (!(hazard > 0)) {
      const empty = { hazard: 0, ranks: [] };
      phase.events.set(repeat, empty);
      return empty;
    }
    let lower = Math.max(0, 1 - probability);
    const ranks = phase.groups.map((group) => {
      const p = Math.min(1, group.mass / (1 - repeat));
      const through = Math.min(1, lower + p);
      // Difference of powers factored to retain accuracy for very rare target ranks.
      let factor = 0;
      for (let earlier = 0; earlier < size; earlier++)
        factor += lower ** earlier * through ** (size - 1 - earlier);
      lower = through;
      return (p * factor) / hazard;
    });
    const total = ranks.reduce((sum, rank) => sum + rank, 0);
    const result = { hazard, ranks: ranks.map((rank) => rank / total) };
    phase.events.set(repeat, result);
    return result;
  };
  const mean = (phase: Phase, repeat: number): Mean => {
    prepare(phase);
    const cached = phase.means.get(repeat);
    if (cached) return cached;
    const event = events(phase, repeat);
    if (!(event.hazard > 0)) return { cost: Infinity, attempts: Infinity, success: 0 };
    let attempts = config.batchSize / event.hazard;
    let cost = attempts * phase.cost;
    let success = 0;
    phase.groups.forEach((group, index) => {
      const chance = event.ranks[index];
      if (!(chance > 0)) return;
      cost += chance * group.futureCost;
      attempts += chance * group.futureAttempts;
      success += chance * group.futureSuccess;
    });
    const result = { cost, attempts, success: Math.min(1, success) };
    phase.means.set(repeat, result);
    return result;
  };
  function prepare(phase: Phase): void {
    if (phase.ready) return;
    phase.ready = true;
    const slots = [0, 1, 2].filter((slot) => !phase.locks.includes(slot));
    const selected = [...phase.lines];
    const prefix = [...phase.fixed];
    const groups = new Map<number, Map<string, Transition>>();
    const blank: OptionLine = {
      id: '',
      type: '',
      value: -1,
      text: '',
      unit: 'flat',
      grade: 'normal',
    };
    for (const slot of slots) selected[slot] = blank;
    const visit = (depth: number, probability: number) => {
      if (depth === slots.length) {
        const hit = matchTarget(config.target, {
          grade: 'legendary',
          lines: selected,
          stage: config.start.stage,
        });
        const progress = abilityProgress(config, selected).matchedLower;
        if (!hit && progress <= phase.locks.length) return;
        const rank = hit ? 3 : progress;
        const destination = hit ? undefined : getPhase(selected);
        const repeat = destination ? repeatProbability(destination, selected) : 0;
        const key = destination ? `${destination.key}:${repeat}` : 'success';
        let group = groups.get(rank);
        if (!group) groups.set(rank, (group = new Map()));
        const old = group.get(key);
        if (old) old.probability += probability;
        else group.set(key, { phase: destination, repeat, probability });
        return;
      }
      const slot = slots[depth];
      let candidates = eligible(slot, prefix);
      if (
        depth === slots.length - 1 &&
        abilityProgress(config, selected).matchedLower <= phase.locks.length &&
        !matchTarget(config.target, {
          grade: 'legendary',
          lines: selected,
          stage: config.start.stage,
        })
      ) {
        let relevant = relevantCandidates.get(candidates);
        if (!relevant) {
          relevant = candidates.filter((candidate) =>
            config.target.conditions.some((condition) =>
              conditionMatchesLine(condition, candidate.line, slot),
            ),
          );
          relevantCandidates.set(candidates, relevant);
        }
        // These retain the probabilities of the full eligible pool; filtering only skips misses.
        candidates = relevant;
      }
      for (const candidate of candidates) {
        selected[slot] = candidate.line;
        // With one lower target, the remaining unlocked lower line may be irrelevant.
        // Still draw it to preserve its type exclusions and retained-tuple probability.
        // Skip only complete outcomes that neither improve the locks nor hit the goal.
        if (
          depth === slots.length - 1 &&
          abilityProgress(config, selected).matchedLower <= phase.locks.length &&
          !matchTarget(config.target, {
            grade: 'legendary',
            lines: selected,
            stage: config.start.stage,
          })
        )
          continue;
        prefix.push(candidate);
        visit(depth + 1, probability * candidate.probability);
        prefix.pop();
      }
      selected[slot] = blank;
    };
    visit(0, 1);
    phase.groups = [...groups]
      .sort(([a], [b]) => a - b)
      .map(([rank, outcomes]) => {
        const transitions = [...outcomes.values()];
        const mass = transitions.reduce((sum, transition) => sum + transition.probability, 0);
        let cumulative = 0;
        return {
          rank,
          mass,
          transitions,
          cdf: Float64Array.from(
            transitions.map((transition) => (cumulative += transition.probability / mass)),
          ),
          futureCost: 0,
          futureAttempts: 0,
          futureSuccess: 0,
        };
      });
    for (const group of phase.groups)
      for (const transition of group.transitions) {
        const future = transition.phase
          ? mean(transition.phase, transition.repeat)
          : { cost: 0, attempts: 0, success: 1 };
        const weight = transition.probability / group.mass;
        group.futureCost += weight * future.cost;
        group.futureAttempts += weight * future.attempts;
        group.futureSuccess += weight * future.success;
      }
  }

  const initial = getPhase(config.start.lines);
  const initialRepeat = repeatProbability(initial, config.start.lines);
  const expected = mean(initial, initialRepeat);
  const successProbability = Math.min(1, expected.success);
  if (!(successProbability > 0))
    return {
      status: 'impossible',
      expectedCost: Infinity,
      expectedAttempts: Infinity,
      successProbability: 0,
      unit: 'meso',
      method: 'analytic',
      sampleCount: 0,
      quantiles: { p10: Infinity, p50: Infinity, p90: Infinity },
      distribution: [],
      note: '아랫줄을 순서대로 잠그는 경로에서 목표를 달성할 수 없습니다.',
    };
  const sampleCount = options.sampleCount ?? 500_000;
  if (!Number.isInteger(sampleCount) || sampleCount < 1)
    throw new Error('분포 표본 수는 양의 정수여야 합니다.');
  const rng = seededRandom(
    options.seed ??
      stableStringify({ config: { ...config, unitPrices: {} }, engine: 'ability-lower-first-v1' }),
  );
  const samples = new Float64Array(sampleCount);
  for (let sample = 0; sample < sampleCount; sample++) {
    let phase: Phase | undefined = initial;
    let repeat = initialRepeat;
    let cost = 0;
    while (phase) {
      const event = events(phase, repeat);
      if (!(event.hazard > 0)) {
        cost = Infinity;
        break;
      }
      cost += geometric(event.hazard, rng) * config.batchSize * phase.cost;
      let draw = rng(),
        index = 0;
      while (index < event.ranks.length - 1 && draw >= event.ranks[index])
        draw -= event.ranks[index++];
      const group: RankGroup = phase.groups[index];
      const transition: Transition =
        group.transitions[Math.min(group.transitions.length - 1, upperBound(group.cdf, rng()))];
      phase = transition.phase;
      repeat = transition.repeat;
    }
    samples[sample] = cost;
  }
  samples.sort();
  const percentile = (p: number) =>
    samples[Math.min(sampleCount - 1, Math.max(0, Math.ceil(p * sampleCount) - 1))];
  const distribution: BenchmarkResult['distribution'] = [];
  for (let n = 0; n <= 100; n++) {
    const cost = percentile(n === 0 ? 1 / sampleCount : n / 100);
    if (!Number.isFinite(cost)) continue;
    const cdf = upperBound(samples, cost) / sampleCount;
    if (distribution.at(-1)?.cost === cost) distribution[distribution.length - 1].cdf = cdf;
    else distribution.push({ cost, cdf });
  }
  const partial = !Number.isFinite(expected.cost) || successProbability < 1 - 1e-10;
  const result: BenchmarkResult = {
    status: partial ? 'partial' : 'ready',
    expectedCost: partial ? Infinity : expected.cost,
    expectedAttempts: partial ? Infinity : expected.attempts,
    successProbability,
    unit: 'meso',
    method: 'sampled',
    sampleCount,
    quantiles: { p10: percentile(0.1), p50: percentile(0.5), p90: percentile(0.9) },
    distribution,
    cdfAtActual:
      actualCost === undefined ? undefined : upperBound(samples, actualCost) / sampleCount,
    note: partial
      ? '자동 잠금 이후 목표 달성에 실패할 수 있는 경로가 있어 무조건부 기댓값은 무한대입니다.'
      : `아랫줄 목표 확보 → 자동 잠금 → ${config.target.conditions.length === 3 ? '나머지 아랫줄 → ' : ''}첫째 줄 순서입니다. 평균은 해석 계산, 분포는 고정 시드 ${sampleCount.toLocaleString('ko-KR')}개 역누적분포 표본입니다.${config.batchSize === 3 ? ' 매 비교는 같은 잠금에서 3회 전부 과금하고, 목표 성공 우선·잠금 진척 우선으로 채택합니다.' : ''}`,
  };
  let cache = resultCache.get(data);
  if (!cache) resultCache.set(data, (cache = new Map()));
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  cache.set(resultKey, { result: { ...result, cdfAtActual: undefined }, samples });
  return result;
}
