import type {
  Grade,
  OptionLine,
  ResourceCost,
  RollResult,
  SimulationConfig,
  SimulationState,
} from '../types';
import {
  allCandidates,
  benchmarkUnit,
  canAppend,
  eligibleCandidates,
  effectiveBatchSize,
  GRADES,
  gradeRank,
  guaranteedAfterFailures,
  isPrime,
  lineIdentity,
  potentialRules,
  resolveOptionLine,
  tupleIdentity,
  type Candidate,
  type RuleData,
} from './rules';
import { cryptoRandom, sampleWeighted } from './math';
import { matchTarget } from './target';
import {
  abilityConfigForState,
  abilityProgress,
  abilityStrategyErrors,
  pickAbilityCandidate,
  usesLowerFirstAbility,
} from './ability-strategy';

export const emptyCost = (): ResourceCost => ({
  meso: 0n,
  honor: 0n,
  cubes: 0n,
  credits: 0n,
  ethers: [0n, 0n, 0n, 0n],
});
export function addCost(a: ResourceCost, b: ResourceCost): ResourceCost {
  return {
    meso: a.meso + b.meso,
    honor: a.honor + b.honor,
    cubes: a.cubes + b.cubes,
    credits: a.credits + b.credits,
    ethers: a.ethers.map((n, i) => n + (b.ethers[i] ?? 0n)),
  };
}
export function costValue(config: SimulationConfig, cost: ResourceCost): bigint {
  return benchmarkUnit(config) === 'cubes' ? cost.cubes : cost.meso;
}

export function attemptCost(
  data: RuleData,
  config: SimulationConfig,
  grade: Grade,
  stage: number,
): ResourceCost {
  const result = emptyCost();
  if (config.mode === 'ability') {
    const costs = data.ability.costs.find((c) => c.locked === config.lockedSlots.length);
    if (!costs) throw new Error('어빌리티는 최대 두 줄까지 잠글 수 있습니다.');
    result.meso = BigInt(costs.meso);
    result.honor = BigInt(costs.honor);
  } else if (config.mode === 'soulAmplification') {
    const rule = data.soul.amplificationStages.find((s) => s.stage === stage + 1);
    if (!rule) throw new Error('소울은 4단계까지만 증폭할 수 있습니다.');
    result.meso = BigInt(rule.systemCostPerAttempt);
    result.ethers[stage] = 1n;
  } else if (
    config.mode === 'cube' &&
    ['gold', 'prime', 'primeAdditional'].includes(config.cubeType)
  ) {
    result.cubes = 1n;
    if (isPrime(config))
      result.credits = BigInt(potentialRules(data, config).primeCube?.unitCreditCost ?? 10000);
  } else {
    const rules = potentialRules(data, config);
    const band = rules.costBands.find(
      (b) => config.level >= b.minimumLevel && config.level <= b.maximumLevel,
    );
    if (!band?.resetCosts[grade]) throw new Error('해당 장비 레벨의 비용 자료가 없습니다.');
    result.meso = BigInt(band.resetCosts[grade]);
    if (config.mode === 'cube') result.cubes = 1n;
  }
  return result;
}

export interface PreparedDraw {
  candidates: Candidate[][];
  fixed: Map<number, Candidate>;
}
export function prepareDraw(
  data: RuleData,
  config: SimulationConfig,
  grade: Grade,
  current: readonly OptionLine[],
): PreparedDraw {
  const candidates = [0, 1, 2].map((slot) => allCandidates(data, config, grade, slot));
  const fixed = new Map<number, Candidate>();
  const locked = config.mode === 'ability' ? config.lockedSlots : isPrime(config) ? [0] : [];
  for (const slot of locked) {
    const line = current[slot];
    if (!line) throw new Error('고정할 현재 옵션을 먼저 선택해주세요.');
    const candidate =
      candidates[slot].find(
        (c) => lineIdentity(c.line) === lineIdentity(line) && c.line.grade === line.grade,
      ) ?? candidates[slot].find((c) => lineIdentity(c.line) === lineIdentity(line));
    if (!candidate)
      throw new Error('고정 옵션이 현재 확률표에 없습니다. 옵션을 다시 선택해주세요.');
    fixed.set(slot, candidate);
  }
  const fixedRows = [...fixed.values()];
  for (let i = 0; i < fixedRows.length; i++)
    if (!canAppend(fixedRows.slice(0, i), fixedRows[i]))
      throw new Error('중복된 어빌리티 종류를 잠글 수 없습니다.');
  return { candidates, fixed };
}

export function drawLines(prepared: PreparedDraw, rng: () => number): OptionLine[] {
  const chosen = new Map(prepared.fixed);
  const prefix = [...prepared.fixed.values()];
  for (let slot = 0; slot < 3; slot++) {
    if (chosen.has(slot)) continue;
    const pick = sampleWeighted(
      eligibleCandidates(prepared.candidates[slot], prefix),
      (c) => c.probability,
      rng,
    );
    chosen.set(slot, pick);
    prefix.push(pick);
  }
  return [0, 1, 2].map((slot) => ({ ...chosen.get(slot)!.line }));
}

export function drawDifferent(
  prepared: PreparedDraw,
  current: readonly OptionLine[],
  rng: () => number,
): OptionLine[] {
  const previous = current.length === 3 ? tupleIdentity(current) : null;
  for (let retry = 0; retry < 100000; retry++) {
    const result = drawLines(prepared, rng);
    if (!previous || tupleIdentity(result) !== previous) return result;
  }
  throw new Error('서로 다른 결과를 만들 수 없습니다. 고정 옵션을 확인해주세요.');
}

export function validateConfig(data: RuleData, config: SimulationConfig): string[] {
  const errors: string[] = abilityStrategyErrors(config);
  const maximumLevel = config.mode === 'cube' ? 250 : 300;
  if (!Number.isInteger(config.level) || config.level < 1 || config.level > maximumLevel)
    errors.push(`장비 레벨은 1~${maximumLevel} 정수로 입력해주세요.`);
  if (
    (config.mode === 'soulAmplification' || config.mode === 'soulPotential') &&
    (config.level < 200 || config.category !== 'weapon')
  )
    errors.push('소울 증폭과 소울 잠재능력은 요구 레벨 200 이상의 주무기에서 사용할 수 있습니다.');
  if (!Number.isInteger(config.start.failures) || config.start.failures < 0)
    errors.push('연속 실패 횟수는 0 이상의 정수여야 합니다.');
  if (
    new Set(config.lockedSlots).size !== config.lockedSlots.length ||
    config.lockedSlots.some((s) => ![0, 1, 2].includes(s))
  )
    errors.push('잠금 줄 설정이 올바르지 않습니다.');
  if (
    config.mode === 'ability' &&
    (config.start.grade !== 'legendary' || config.lockedSlots.length > 2)
  )
    errors.push('고급 어빌리티는 레전드리에서 최대 두 줄을 잠글 수 있습니다.');
  if (isPrime(config) && config.start.grade !== 'legendary')
    errors.push('프라임 큐브는 레전드리 전용입니다.');
  if (config.batchSize === 3 && !['ability', 'cube', 'soulPotential'].includes(config.mode))
    errors.push('3회 비교는 큐브·소울 잠재·고급 어빌리티에서 사용할 수 있습니다.');
  if (
    config.mode === 'soulAmplification' &&
    (!Number.isInteger(config.start.stage) ||
      config.start.stage < 0 ||
      config.start.stage > 4 ||
      config.target.stage < 1 ||
      config.target.stage > 4)
  )
    errors.push('소울 증폭 단계 설정이 올바르지 않습니다.');
  if (
    config.mode === 'soulPotential' &&
    (!Number.isInteger(config.start.stage) || config.start.stage < 1 || config.start.stage > 4)
  )
    errors.push('소울 잠재능력은 증폭 1~4단계에서만 사용할 수 있습니다.');
  if (config.target.mode === 'exact' && config.target.lines.length !== 3)
    errors.push('정확한 옵션 목표는 세 줄을 모두 선택해주세요.');
  if (['sum', 'ability'].includes(config.target.mode) && !config.target.conditions.length)
    errors.push('목표 옵션을 하나 이상 설정해주세요.');
  for (const condition of config.target.conditions) {
    if (
      (condition.slot !== undefined && ![0, 1, 2].includes(condition.slot)) ||
      (condition.slots !== undefined &&
        (!condition.slots.length ||
          new Set(condition.slots).size !== condition.slots.length ||
          condition.slots.some((slot) => ![0, 1, 2].includes(slot)) ||
          (condition.slot !== undefined && !condition.slots.includes(condition.slot))))
    )
      errors.push('목표 줄 설정은 첫째·둘째·셋째 줄 중에서 선택해 주세요.');
    if (!Number.isFinite(condition.minValue) || condition.minValue < 0)
      errors.push('목표 수치는 0 이상의 숫자여야 합니다.');
    if (condition.maxValue !== undefined && condition.maxValue < condition.minValue)
      errors.push('목표 최대 수치는 최소 수치 이상이어야 합니다.');
    if (
      condition.count !== undefined &&
      (!Number.isInteger(condition.count) || condition.count < 1 || condition.count > 3)
    )
      errors.push('목표 줄 수는 1~3입니다.');
  }
  if (
    config.start.lines.length !== 0 &&
    config.start.lines.length !== 3 &&
    !(isPrime(config) && config.start.lines.length === 1)
  )
    errors.push('현재 옵션은 세 줄을 모두 선택해주세요.');
  if (errors.length) return errors;
  try {
    if (config.mode === 'soulAmplification') {
      if (config.start.stage < 4) {
        const rule = data.soul.amplificationStages.find((s) => s.stage === config.start.stage + 1)!;
        if (config.start.failures > rule.guaranteedAfterFailures)
          errors.push(`현재 단계의 연속 실패 횟수는 ${rule.guaranteedAfterFailures} 이하입니다.`);
      }
    } else {
      prepareDraw(
        data,
        abilityConfigForState(config, { lines: config.start.lines }),
        config.start.grade,
        config.start.lines,
      );
      if (config.mode !== 'ability') {
        const rule = potentialRules(data, config).grades.find(
          (g) => g.grade === config.start.grade,
        )!;
        const max = guaranteedAfterFailures(rule);
        if (max !== undefined && config.start.failures > max)
          errors.push(`현재 등급의 연속 실패 횟수는 ${max} 이하입니다.`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return [...new Set(errors)];
}

export function createState(
  data: RuleData,
  config: SimulationConfig,
  rng: () => number = cryptoRandom,
): SimulationState {
  let lines = config.start.lines.map((line, slot) =>
    config.mode === 'soulAmplification' ? line : resolveOptionLine(data, config, line, slot),
  );
  if (isPrime(config) && lines.length === 1) {
    lines = drawLines(prepareDraw(data, config, config.start.grade, lines), rng);
  } else if (!lines.length && config.mode !== 'soulAmplification') {
    // The initial free setup is not a paid reset and is frozen by the caller before benchmarking.
    const initialConfig = {
      ...config,
      lockedSlots: [],
      cubeType: isPrime(config)
        ? ((config.cubeType === 'primeAdditional'
            ? 'additional'
            : 'black') as SimulationConfig['cubeType'])
        : config.cubeType,
    };
    lines = drawLines(prepareDraw(data, initialConfig, config.start.grade, []), rng);
  }
  const state: SimulationState = {
    grade: config.start.grade,
    lines,
    stage: config.start.stage,
    failures: config.start.failures,
    attempts: 0n,
    ...(config.mode === 'ability'
      ? {
          lockedSlots: usesLowerFirstAbility(config)
            ? abilityProgress(config, lines).lockedSlots
            : [...config.lockedSlots],
        }
      : {}),
    spent: emptyCost(),
    status: 'idle',
    history: [],
    candidates: [],
    startedAt: new Date().toISOString(),
  };
  if (matchTarget(config.target, state)) state.status = 'success';
  return state;
}

export function amplificationChance(data: RuleData, stage: number, failures: number): number {
  const rule = data.soul.amplificationStages.find((s) => s.stage === stage + 1);
  if (!rule) return 0;
  return failures >= rule.guaranteedAfterFailures
    ? 1
    : Math.min(
        1,
        rule.initialSuccessProbability + rule.successProbabilityIncreasePerFailure * failures,
      );
}

export function rollBatch(
  data: RuleData,
  config: SimulationConfig,
  state: SimulationState,
  rng: () => number = cryptoRandom,
): SimulationState {
  if (state.status === 'success' || state.status === 'impossible') return state;
  const next: SimulationState = {
    ...state,
    lines: [...state.lines],
    spent: { ...state.spent, ethers: [...state.spent.ethers] },
    history: [...state.history],
    candidates: [],
    ...(state.lockedSlots ? { lockedSlots: [...state.lockedSlots] } : {}),
  };
  if (config.mode === 'soulAmplification') {
    if (next.stage >= 4) return { ...next, status: 'success' };
    const cost = attemptCost(data, config, next.grade, next.stage);
    const amplified = rng() < amplificationChance(data, next.stage, next.failures);
    next.attempts++;
    next.spent = addCost(next.spent, cost);
    if (amplified) {
      next.stage++;
      next.failures = 0;
    } else next.failures++;
    const hit = matchTarget(config.target, next);
    const result: RollResult = {
      sequence: next.attempts,
      grade: next.grade,
      lines: [...next.lines],
      stage: next.stage,
      promoted: false,
      amplified,
      hit,
      cost,
    };
    next.candidates = [result];
    next.history.push(result);
    next.status = hit ? 'success' : 'running';
  } else {
    const baseline = [...state.lines];
    const baselineGrade = state.grade;
    const drawConfig = abilityConfigForState(config, state);
    const lowerFirst = usesLowerFirstAbility(config);
    const previousProgress = lowerFirst ? abilityProgress(config, baseline).matchedLower : 0;
    const count = effectiveBatchSize(config, baselineGrade);
    if (
      count === 3 &&
      !(
        config.mode === 'ability' ||
        ((config.mode === 'cube' || config.mode === 'soulPotential') &&
          baselineGrade === 'legendary')
      )
    )
      throw new Error('현재 등급에서는 3회 비교를 할 수 없습니다.');
    for (let i = 0; i < count; i++) {
      const cost = attemptCost(data, drawConfig, baselineGrade, state.stage);
      let grade = baselineGrade;
      let promoted = false;
      if (config.mode !== 'ability' && !isPrime(config) && grade !== 'legendary') {
        const rule = potentialRules(data, config).grades.find((r) => r.grade === grade)!;
        const guarantee = guaranteedAfterFailures(rule);
        const p = guarantee !== undefined && next.failures >= guarantee ? 1 : rule.gradeUpChance;
        if (rng() < p) {
          grade = GRADES[GRADES.indexOf(grade) + 1];
          promoted = true;
          next.failures = 0;
        } else next.failures++;
      }
      const prepared = prepareDraw(data, drawConfig, grade, baseline);
      const lines = promoted ? drawLines(prepared, rng) : drawDifferent(prepared, baseline, rng);
      const hit = matchTarget(config.target, { grade, lines, stage: state.stage });
      next.attempts++;
      next.spent = addCost(next.spent, cost);
      const result: RollResult = {
        sequence: next.attempts,
        grade,
        lines,
        stage: state.stage,
        promoted,
        amplified: false,
        hit,
        cost,
        ...(lowerFirst
          ? {
              lockedSlots: abilityProgress(config, lines).lockedSlots,
              progressed: abilityProgress(config, lines).matchedLower > previousProgress,
              adopted: false,
            }
          : {}),
      };
      next.candidates.push(result);
      next.history.push(result);
    }
    const selected = lowerFirst
      ? pickAbilityCandidate(config, baseline, next.candidates)
      : (next.candidates.find((r) => r.hit) ?? next.candidates.find((r) => r.promoted));
    if (selected) {
      next.grade = selected.grade;
      next.lines = selected.lines;
      if (lowerFirst) {
        selected.adopted = true;
        next.lockedSlots = [...selected.lockedSlots!];
      }
    }
    next.status = selected?.hit ? 'success' : 'running';
  }
  next.history = next.history.slice(-100);
  if (next.status === 'success') next.finishedAt = new Date().toISOString();
  return next;
}
