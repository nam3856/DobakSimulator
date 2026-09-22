import { describe, expect, it } from 'vitest';
import { computeBenchmark } from '../src/engine/benchmark';
import { NORMAL_ABILITY_LINE_GRADES, type AbilityOption } from '../src/engine/rules';
import { config as baseConfig, fixture, line } from './engine.test';

function normalFixture(options: AbilityOption[], name: string) {
  const data = fixture();
  data.ability.ruleId = name;
  for (const grade of ['rare', 'epic', 'unique', 'legendary'] as const)
    data.ability.grades[grade] = { options: structuredClone(options) };
  const config = baseConfig();
  config.mode = 'ability';
  config.abilityResetMode = 'normal';
  config.abilityStrategy = 'fixed';
  config.start.stage = 0;
  config.target.mode = 'ability';
  config.target.conditions = [{ type: 'e', minValue: 1 }];
  return { data, config };
}

function option(id: string, weight = 1): AbilityOption {
  return { id, label: id, weight, values: [{ value: 1, label: `${id} +1`, weight: 1 }] };
}

describe('normal ability benchmark', () => {
  it('solves a nonuniform changing-current-state mean and measures honor only', () => {
    const { data, config } = normalFixture(
      ['a', 'b', 'c', 'd', 'e'].map((id, index) => option(id, Math.max(1, index - 1))),
      'normal-mean-nonuniform',
    );
    config.start.lines = [line('a'), line('b', 'epic'), line('c', 'epic')];
    config.lockedSlots = [0, 1];
    const result = computeBenchmark(data, config, 16000);
    // Remaining probabilities are c=1/6, d=2/6, e=3/6. The equations
    // E_c=1+(2/5)E_d and E_d=1+(1/4)E_c give E_c=14/9.
    expect(result.expectedAttempts).toBeCloseTo(14 / 9, 12);
    expect(result.unit).toBe('honor');
    expect(result.expectedCost).toBeCloseTo((14 / 9) * 16000, 9);
    expect(result.cdfAtActual).toBeCloseTo(3 / 5, 12);
    expect(result.note).toContain('평균은 동일 옵션 재등장 제외를 반영한 정확값');
    expect(result.note).toContain('분포·백분위·행운은');
    expect(result.note).toContain('근사');
  });

  it('uses a disclosed bounded-memory approximation for large unlocked spaces', () => {
    const { data, config } = normalFixture(
      Array.from({ length: 50 }, (_, index) => option(`option-${index}`)),
      'normal-mean-large',
    );
    config.start.lines = [
      line('option-1'),
      line('option-2', 'epic'),
      line('option-3', 'epic'),
    ];
    config.target.conditions = [{ type: 'option-0', minValue: 1, slot: 0 }];
    const result = computeBenchmark(data, config);
    expect(result.expectedAttempts).toBeCloseTo(50, 10);
    expect(result.expectedCost).toBeCloseTo(400000, 6);
    expect(result.unit).toBe('honor');
    expect(result.note).toContain('큰 옵션 공간');
    expect(result.note).toContain('기하분포 근사');
    expect(result.note).toContain('보정은 생략');
  });

  it('keeps successful and failing hidden grades of the same visible tuple separate', () => {
    const { data, config } = normalFixture(
      ['a', 'b', 'c', 'd'].map((id) => option(id)),
      'normal-mean-hidden-grade',
    );
    config.start.lines = [line('a'), line('b', 'epic'), line('c', 'epic')];
    config.lockedSlots = [0, 1];
    config.target.conditions = [{ type: 'd', minValue: 1, minGrade: 'unique' }];
    const result = computeBenchmark(data, config);
    // Each visible draw is c or d with equal mass. A reset must alternate them;
    // success occurs only on unique d. If u is the unique chance, then
    // E_c=1+(1-u)(1+E_c), hence 2/u-1 (not 1/u).
    const uniqueChance = NORMAL_ABILITY_LINE_GRADES[2].unique!;
    expect(result.expectedAttempts).toBeCloseTo(2 / uniqueChance - 1, 9);
    expect(result.cdfAtActual).toBeUndefined();
  });
});
