import { describe, expect, it } from 'vitest';
import type {
  AbilityOptimizerPolicy,
  AbilityOptimizerStrategyResult,
} from '../src/engine/ability-optimizer';
import type { AbilityOption } from '../src/engine/rules';
import { abilityKindLabel } from '../src/engine/ability-labels';
import { groupOptimizerStrategies, optimizerLockCondition } from '../src/ui/optimizer-strategies';

const options: AbilityOption[] = [
  {
    id: 'boss',
    type: 'boss',
    label: '보스 몬스터 데미지 증가',
    values: [{ value: 20, label: '보스 몬스터 데미지 20% 증가', weight: 1 }],
    weight: 1,
  },
  {
    id: 'passive',
    type: 'passive',
    label: '패시브 스킬 레벨 증가',
    values: [{ value: 1, label: '패시브 스킬 레벨 1 증가', weight: 1 }],
    weight: 1,
  },
  {
    id: 'attack',
    type: 'attack',
    label: '공격력 증가',
    values: [{ value: 30, label: '공격력 30 증가', weight: 1 }],
    weight: 1,
  },
];
function row(
  id: string,
  policy: AbilityOptimizerPolicy,
  totalCost = 100,
): AbilityOptimizerStrategyResult {
  return {
    id,
    policy,
    totalCost,
    name: '이름은 분류에 사용하지 않음',
    description: '',
    steps: [],
    status: 'ready',
    expectedMeso: 1,
    expectedHonor: 2,
    expectedResets: 3,
    expectedCirculators: 4,
    estimatedAdditionalHonor: 0,
    estimatedHonorPurchaseCost: 0,
  };
}
const acquire = (
  timing: 'direct' | 'lower' | 'all',
  firstAcceptedTargets = ['boss', 'passive', 'attack'],
): AbilityOptimizerPolicy => ({ kind: 'acquire', timing, firstAcceptedTargets });

describe('optimizer strategy presentation', () => {
  it('removes empty percentage placeholders while preserving meaningful option names', () => {
    expect(abilityKindLabel('보스 몬스터 공격 시 데미지 % 증가')).toBe(
      '보스 몬스터 공격 시 데미지 증가',
    );
    expect(abilityKindLabel('AP를 직접 투자한 STR의 % 만큼 DEX 증가')).toBe(
      'AP를 직접 투자한 STR에 비례한 DEX 증가',
    );
    expect(abilityKindLabel('스킬 사용 시 % 확률로 재사용 대기시간이 미적용')).toBe(
      '스킬 사용 시 일정 확률로 재사용 대기시간이 미적용',
    );
    expect(abilityKindLabel('일정 레벨마다 공격력 1 증가')).toBe('일정 레벨마다 공격력 1 증가');
    const withPlaceholder = [
      { ...options[0], label: '보스 몬스터 데미지 % 증가' },
      ...options.slice(1),
    ];
    expect(
      optimizerLockCondition(row('boss', acquire('all', ['boss'])), withPlaceholder).title,
    ).toBe('보스 몬스터 데미지 증가');
  });
  it('groups every row by explicit policy without changing the input or its expectations', () => {
    const rows = [
      row('opaque-1', acquire('direct'), 80),
      row('opaque-2', acquire('lower'), 50),
      row('opaque-3', acquire('all'), 60),
      row('opaque-4', { kind: 'current-types' }, 30),
      row('opaque-5', { kind: 'keep-first', targetType: 'passive' }, 70),
      row('opaque-6', acquire('direct', ['boss']), 40),
    ];
    const original = structuredClone(rows);
    const groups = groupOptimizerStrategies(rows);
    expect(groups.map((group) => group.method)).toEqual(['all', 'direct', 'lower', 'keep-first']);
    expect(groups[0].strategies.map((strategy) => strategy.id)).toEqual(['opaque-4', 'opaque-3']);
    expect(groups[1].best.id).toBe('opaque-6');
    expect(groups.flatMap((group) => group.strategies)).toHaveLength(rows.length);
    expect(
      new Set(groups.flatMap((group) => group.strategies.map((strategy) => strategy.id))).size,
    ).toBe(rows.length);
    expect(rows).toEqual(original);
    expect(
      groups.flatMap((group) => group.strategies).every((strategy) => rows.includes(strategy)),
    ).toBe(true);
  });

  it('reorders methods after repricing and keeps impossible costs last', () => {
    const direct = row('d', acquire('direct'), 80);
    const lower = row('l', acquire('lower'), 10);
    const impossible = { ...row('a', acquire('all'), Infinity), status: 'impossible' as const };
    expect(
      groupOptimizerStrategies([direct, lower, impossible]).map((group) => group.method),
    ).toEqual(['lower', 'direct', 'all']);
    expect(
      groupOptimizerStrategies([direct, { ...lower, totalCost: 90 }, impossible]).map(
        (group) => group.method,
      ),
    ).toEqual(['direct', 'lower', 'all']);
    expect(groupOptimizerStrategies([])).toEqual([]);
  });

  it('describes allowed kinds as alternatives and reserves maximum values for direct resets', () => {
    const one = optimizerLockCondition(row('one', acquire('direct', ['boss'])), options);
    expect(one.title).toBe('보스 몬스터 데미지 증가');
    expect(one.detail).toContain('레전드리 최대치');
    for (const timing of ['lower', 'all'] as const) {
      const two = optimizerLockCondition(row('two', acquire(timing, ['boss', 'passive'])), options);
      expect(two.title).toBe('보스 몬스터 데미지 증가 또는 패시브 스킬 레벨 증가');
      expect(two.title).not.toMatch(/20%|1 증가|A·B/);
      expect(two.detail).toContain('수치와 관계없이');
      expect(optimizerLockCondition(row('any', acquire(timing)), options).title).toBe(
        '목표 옵션 중 무엇이든',
      );
    }
  });

  it('separates existing kinds, first-line locks and an already complete result', () => {
    const current = optimizerLockCondition(row('current', { kind: 'current-types' }), options);
    expect(current.label).toBe('현재 상태');
    expect(current.title).toBe('이미 세 종류가 있어요');
    const first = optimizerLockCondition(
      row('first', { kind: 'keep-first', targetType: 'passive' }),
      options,
    );
    expect(first.title).toBe('패시브 스킬 레벨 증가');
    expect(first.detail).toContain('첫 줄을 잠그고');
    const done = optimizerLockCondition(
      { ...row('done', acquire('all')), status: 'already', totalCost: 0 },
      options,
    );
    expect(done.label).toBe('현재 상태');
    expect(done.detail).toBe('추가 재설정이 필요 없어요.');
  });
});
