import type {
  OptionLine,
  RollResult,
  SimulationConfig,
  SimulationState,
  TargetCondition,
} from '../types';
import { conditionMatchesLine } from './target';

export interface AbilityProgress {
  lockedSlots: number[];
  matchedLower: number;
  requiredLower: number;
}

/** Older saved configurations retain their fixed-lock behavior. */
export function usesLowerFirstAbility(config: SimulationConfig): boolean {
  return (
    config.mode === 'ability' &&
    config.abilityStrategy === 'lowerFirst' &&
    config.target.mode === 'ability' &&
    config.target.match === 'all'
  );
}

export function usesFirstLockedAbility(config: SimulationConfig): boolean {
  return (
    config.mode === 'ability' &&
    config.abilityStrategy === 'firstLocked' &&
    config.target.mode === 'ability' &&
    config.target.match === 'all'
  );
}

export function usesAbilityProgression(config: SimulationConfig): boolean {
  return usesLowerFirstAbility(config) || usesFirstLockedAbility(config);
}

function allowsSlot(condition: TargetCondition, slot: number): boolean {
  return (
    (condition.slot === undefined || condition.slot === slot) &&
    (condition.slots === undefined || condition.slots.includes(slot))
  );
}

export function abilityLowerConditions(config: SimulationConfig): TargetCondition[] {
  return config.target.conditions.filter(
    (condition) => allowsSlot(condition, 1) || allowsSlot(condition, 2),
  );
}

/** Each secondary target must occupy a different line, including overlapping custom targets. */
export function abilityProgress(
  config: SimulationConfig,
  lines: readonly OptionLine[],
): AbilityProgress {
  const conditions = abilityLowerConditions(config);
  let lockedSlots: number[] = [];
  function visit(index: number, occupied: number[]) {
    if (index === conditions.length) {
      const sorted = [...occupied].sort((a, b) => a - b);
      if (
        sorted.length > lockedSlots.length ||
        (sorted.length === lockedSlots.length && sorted.join(',') < lockedSlots.join(','))
      )
        lockedSlots = sorted;
      return;
    }
    visit(index + 1, occupied);
    for (const slot of [1, 2]) {
      if (
        !occupied.includes(slot) &&
        lines[slot] &&
        conditionMatchesLine(conditions[index], lines[slot], slot)
      )
        visit(index + 1, [...occupied, slot]);
    }
  }
  visit(0, []);
  const matchedLower = lockedSlots.length;
  // A first-line lock leaves room for only one secondary lock, even on a complete result.
  if (usesFirstLockedAbility(config)) lockedSlots = [0, ...lockedSlots.slice(0, 1)];
  return { lockedSlots, matchedLower, requiredLower: conditions.length };
}

export function abilityConfigForState(
  config: SimulationConfig,
  state: Pick<SimulationState, 'lines' | 'lockedSlots'>,
): SimulationConfig {
  if (!usesAbilityProgression(config)) return config;
  const lockedSlots = state.lockedSlots ?? abilityProgress(config, state.lines).lockedSlots;
  return {
    ...config,
    lockedSlots: usesFirstLockedAbility(config)
      ? [0, ...lockedSlots.filter((slot) => slot !== 0).slice(0, 1)]
      : [...lockedSlots],
  };
}

/** Three comparisons share one baseline. Ties keep the earliest candidate. */
export function pickAbilityCandidate(
  config: SimulationConfig,
  baselineLines: readonly OptionLine[],
  candidates: readonly RollResult[],
): RollResult | undefined {
  const hit = candidates.find((candidate) => candidate.hit);
  if (hit) return hit;
  const previous = abilityProgress(config, baselineLines).matchedLower;
  let best: RollResult | undefined;
  let bestProgress = previous;
  for (const candidate of candidates) {
    const progress = abilityProgress(config, candidate.lines).matchedLower;
    if (progress > bestProgress) {
      bestProgress = progress;
      best = candidate;
    }
  }
  return best;
}

export function abilityStrategyErrors(config: SimulationConfig): string[] {
  if (!usesAbilityProgression(config)) return [];
  const firstLocked = usesFirstLockedAbility(config);
  const conditions = config.target.conditions;
  const first = conditions.filter(
    (condition) =>
      allowsSlot(condition, 0) && !allowsSlot(condition, 1) && !allowsSlot(condition, 2),
  );
  const lower = abilityLowerConditions(config);
  const errors: string[] = [];
  if (
    (conditions.length !== 2 && conditions.length !== 3) ||
    first.length !== 1 ||
    lower.length !== conditions.length - 1 ||
    lower.some((condition) => allowsSlot(condition, 0)) ||
    conditions.some((condition) => (condition.count ?? 1) !== 1)
  )
    errors.push(
      `${firstLocked ? '첫 줄 고정' : '아랫줄 우선'} 방식은 첫째 줄 목표 하나와 둘째·셋째 줄의 보조 목표 한 개 또는 두 개가 필요합니다.`,
    );
  if (firstLocked) {
    if (config.lockedSlots.length !== 1 || config.lockedSlots[0] !== 0)
      errors.push('첫 줄 고정 방식은 첫째 줄만 고정하고 보조 목표를 자동으로 잠급니다.');
    if (
      first.length === 1 &&
      (!config.start.lines[0] || !conditionMatchesLine(first[0], config.start.lines[0], 0))
    )
      errors.push(
        '고정할 첫째 줄이 첫 줄 목표를 만족하지 않습니다. 목표를 현재 첫째 줄에 맞춰 주세요.',
      );
  } else if (config.lockedSlots.length)
    errors.push(
      '아랫줄 우선 방식은 목표를 자동으로 잠급니다. 수동 잠금을 해제하거나 고정 잠금 방식으로 변경해 주세요.',
    );
  return errors;
}
