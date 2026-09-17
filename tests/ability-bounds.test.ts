import { describe, expect, it } from 'vitest';
import type { OptionLine, TargetCondition } from '../src/types';
import {
  abilityConditionBounds,
  boundAbilityCondition,
  clampConditionValue,
} from '../src/ui/ability-bounds';

const option = (
  value: number,
  grade: OptionLine['grade'],
  type = 'bossDamagePercent',
): OptionLine => ({
  id: `${type}-${grade}-${value}`,
  abilityTypeId: `ability-${type}`,
  type,
  value,
  grade,
  unit: 'percent',
  text: `${type} ${value}%`,
});
const options = [
  option(5, 'epic'),
  option(10, 'unique'),
  option(15, 'legendary'),
  option(20, 'legendary'),
];
const condition: TargetCondition = { type: 'bossDamagePercent', minValue: 1 };

describe('ability condition ranges', () => {
  it('includes all grades above the selected grade and both secondary slots', () => {
    expect(
      abilityConditionBounds(options, { ...condition, minGrade: 'unique', slots: [1, 2] }),
    ).toEqual({ min: 10, max: 20 });
    expect(abilityConditionBounds(options, { ...condition, minGrade: 'legendary' })).toEqual({
      min: 15,
      max: 20,
    });
    expect(abilityConditionBounds(options, condition)).toEqual({ min: 5, max: 20 });
  });
  it('restricts a first-slot-only target to legendary even when a lower grade is selected', () => {
    expect(abilityConditionBounds(options, { ...condition, minGrade: 'epic', slot: 0 })).toEqual({
      min: 15,
      max: 20,
    });
    expect(abilityConditionBounds(options, { ...condition, slots: [0] })).toEqual({
      min: 15,
      max: 20,
    });
    expect(abilityConditionBounds(options, { ...condition, slots: [0, 1] })).toEqual({
      min: 5,
      max: 20,
    });
  });
  it('matches normalized types, option IDs, and ability type IDs', () => {
    expect(abilityConditionBounds(options, { type: options[0].id, minValue: 0 })).toEqual({
      min: 5,
      max: 5,
    });
    expect(
      abilityConditionBounds(options, { type: options[0].abilityTypeId!, minValue: 0 }),
    ).toEqual({ min: 5, max: 20 });
  });
  it('returns no range for missing options or mutually exclusive slot restrictions', () => {
    expect(abilityConditionBounds(options, { type: 'missing', minValue: 10 })).toBeUndefined();
    expect(
      abilityConditionBounds([option(10, 'unique')], { ...condition, slot: 0 }),
    ).toBeUndefined();
    expect(
      abilityConditionBounds(options, { ...condition, slot: 0, slots: [1, 2] }),
    ).toBeUndefined();
    expect(boundAbilityCondition([], { ...condition, minValue: 23 }, true).minValue).toBe(23);
  });
  it('defaults to the actual minimum and clamps after changing grades or slots', () => {
    expect(
      boundAbilityCondition(options, { ...condition, minGrade: 'legendary', minValue: 20 }, true)
        .minValue,
    ).toBe(15);
    expect(boundAbilityCondition(options, { ...condition, slot: 0, minValue: 10 }).minValue).toBe(
      15,
    );
    expect(boundAbilityCondition(options, { ...condition, minValue: 18 }).minValue).toBe(18);
    expect(boundAbilityCondition(options, { ...condition, minValue: 100 }).minValue).toBe(20);
  });
  it('preserves upper-bound semantics for options where a lower number is better', () => {
    const lowerOptions = [
      option(8, 'legendary', 'ability-lower'),
      option(10, 'legendary', 'ability-lower'),
    ];
    const lower = {
      type: 'ability-lower',
      minValue: 0,
      maxValue: 10,
      minGrade: 'legendary' as const,
    };
    expect(boundAbilityCondition(lowerOptions, lower, true)).toMatchObject({
      minValue: 0,
      maxValue: 8,
    });
    expect(boundAbilityCondition(lowerOptions, { ...lower, maxValue: 100 })).toMatchObject({
      minValue: 0,
      maxValue: 10,
    });
  });
  it('keeps zero-valued and fixed-value ranges', () => {
    expect(abilityConditionBounds([option(0, 'legendary')], condition)).toEqual({ min: 0, max: 0 });
    expect(boundAbilityCondition([option(0, 'legendary')], condition, true).minValue).toBe(0);
    const passive = { type: 'passiveSkillLevel', minValue: 100 };
    expect(
      boundAbilityCondition([option(1, 'legendary', 'passiveSkillLevel')], passive).minValue,
    ).toBe(1);
  });
  it('clamps committed high, low, empty, invalid, and zero inputs without losing valid numbers', () => {
    const bounds = { min: 15, max: 20 };
    expect(clampConditionValue('100', bounds)).toBe(20);
    expect(clampConditionValue('1', bounds)).toBe(15);
    expect(clampConditionValue('', bounds)).toBe(15);
    expect(clampConditionValue(' ', bounds)).toBe(15);
    expect(clampConditionValue('invalid', bounds)).toBe(15);
    expect(clampConditionValue('18', bounds)).toBe(18);
    expect(clampConditionValue('0', { min: 0, max: 20 })).toBe(0);
    expect(clampConditionValue('', undefined, 7)).toBe(7);
  });
});
