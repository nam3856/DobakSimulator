import type { OptionLine, TargetCondition } from '../types';
import { gradeRank } from '../engine/rules';

export interface ConditionValueBounds {
  min: number;
  max: number;
}

export function abilityConditionBounds(
  options: readonly OptionLine[],
  condition: TargetCondition,
): ConditionValueBounds | undefined {
  const slots = (condition.slot === undefined ? [0, 1, 2] : [condition.slot]).filter(
    (slot) => slot >= 0 && slot <= 2 && (!condition.slots || condition.slots.includes(slot)),
  );
  if (!slots.length) return undefined;
  const firstOnly = slots.length === 1 && slots[0] === 0;
  const values = options
    .filter(
      (line) =>
        (line.type === condition.type ||
          line.id === condition.type ||
          line.abilityTypeId === condition.type) &&
        (!condition.minGrade || gradeRank(line.grade) >= gradeRank(condition.minGrade)) &&
        (!firstOnly || line.grade === 'legendary') &&
        Number.isFinite(line.value),
    )
    .map((line) => line.value);
  if (!values.length) return undefined;
  return { min: Math.min(...values), max: Math.max(...values) };
}

export function clampConditionValue(
  input: number | string | undefined,
  bounds: ConditionValueBounds | undefined,
  fallback = 0,
): number {
  const parsed = typeof input === 'string' && !input.trim() ? NaN : Number(input);
  const value = Number.isFinite(parsed) ? parsed : (bounds?.min ?? fallback);
  return bounds ? Math.min(bounds.max, Math.max(bounds.min, value)) : value;
}

export function boundAbilityCondition(
  options: readonly OptionLine[],
  condition: TargetCondition,
  useMinimum = false,
): TargetCondition {
  const bounds = abilityConditionBounds(options, condition);
  const current = condition.maxValue ?? condition.minValue;
  const value = clampConditionValue(useMinimum ? (bounds?.min ?? current) : current, bounds);
  return condition.maxValue === undefined
    ? { ...condition, minValue: value }
    : { ...condition, minValue: 0, maxValue: value };
}
