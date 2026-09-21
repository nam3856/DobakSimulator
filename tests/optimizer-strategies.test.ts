import { describe, expect, it } from 'vitest';
import type {
  AbilityOptimizerPolicy,
  AbilityOptimizerStrategyResult,
  AbilityOptimizerTarget,
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
  lockSlots?: Array<0 | 1 | 2>,
): AbilityOptimizerPolicy => ({
  kind: 'acquire',
  timing,
  firstAcceptedTargets,
  ...(lockSlots ? { lockSlots } : {}),
});

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

  it('uses one- and two-goal method names without claiming three required lines', () => {
    for (const [targets, count] of [
      [[{ type: 'boss', grade: 'legendary' }], '한'],
      [
        [
          { type: 'boss', grade: 'legendary' },
          { type: 'attack', grade: 'unique' },
        ],
        '두',
      ],
    ] as const) {
      const rows = [
        row(
          'direct',
          acquire(
            'direct',
            targets.map((target) => target.type),
          ),
        ),
        row(
          'lower',
          acquire(
            'lower',
            targets.map((target) => target.type),
          ),
        ),
        row('all', { kind: 'current-types' }),
        row('keep', { kind: 'keep-first', targetType: 'boss' }),
      ];
      const groups = groupOptimizerStrategies(rows, targets);
      expect(groups.find((group) => group.method === 'direct')?.title).toBe(
        `재설정만으로 ${count} 줄 완성`,
      );
      expect(groups.find((group) => group.method === 'all')?.title).toBe(
        `${count} 종류를 갖춘 뒤 서큘레이터로 완성`,
      );
      expect(groups.every((group) => !/세 줄|세 종류/.test(group.title))).toBe(true);
      const current = optimizerLockCondition(rows[2], options, targets);
      expect(current.title).toBe(`이미 목표 ${count} 종류가 있어요`);
      expect(current.detail).toContain('목표 등급');
      expect(
        optimizerLockCondition({ ...rows[0], status: 'already' }, options, targets).title,
      ).toBe(`목표 ${count} 줄 완성`);
    }
  });

  it('uses each chosen grade threshold for mixed goals and allows stronger legendary results', () => {
    const targets: AbilityOptimizerTarget[] = [
      { type: 'boss', grade: 'legendary' },
      { type: 'attack', grade: 'unique' },
      { type: 'passive', grade: 'legendary' },
    ];
    const direct = optimizerLockCondition(
      row('direct', acquire('direct', ['boss', 'attack'])),
      options,
      targets,
    );
    expect(direct.title).toBe('보스 몬스터 데미지 증가 또는 공격력 증가');
    expect(direct.detail).toContain('각 옵션의 목표 등급');
    expect(direct.detail).toContain('선택 등급의 최대치 기준');
    expect(direct.detail).toContain('목표 수치를 충족한 레전드리도 인정');
    for (const timing of ['lower', 'all'] as const) {
      const circulator = optimizerLockCondition(
        row(timing, acquire(timing, ['boss', 'attack'])),
        options,
        targets,
      );
      expect(circulator.detail).toContain('각 옵션의 목표 등급 이상');
      expect(circulator.detail).toContain('현재 수치와 관계없이');
      expect(circulator.detail).not.toContain('최대치');
      expect(circulator.detail).toContain('유니크 목표는 레전드리도 인정');
    }
  });

  it('explains the selected first-lock subset rather than the other target grades', () => {
    const targets: AbilityOptimizerTarget[] = [
      { type: 'boss', grade: 'legendary' },
      { type: 'attack', grade: 'unique' },
    ];
    const unique = optimizerLockCondition(
      row('unique', acquire('direct', ['attack'])),
      options,
      targets,
    );
    expect(unique.title).toBe('공격력 증가');
    expect(unique.detail).toContain('유니크 최대치');
    expect(unique.detail).not.toContain('레전드리 최대치');
    const legendary = optimizerLockCondition(
      row('legendary', acquire('direct', ['boss'])),
      options,
      targets,
    );
    expect(legendary.detail).toBe('아랫줄에 레전드리 최대치로 나오면 잠가요.');
    expect(
      optimizerLockCondition(row('any', acquire('all', ['boss', 'attack'])), options, targets)
        .title,
    ).toBe('목표 옵션 중 무엇이든');
    expect(
      optimizerLockCondition(
        row('single', acquire('direct', ['boss'])),
        options,
        targets.slice(0, 1),
      ).title,
    ).toBe('보스 몬스터 데미지 증가');
  });

  it('describes a retained first line by the chosen goal rather than its own grade maximum', () => {
    const targets: AbilityOptimizerTarget[] = [
      { type: 'boss', grade: 'legendary' },
      { type: 'attack', grade: 'unique' },
    ];
    const condition = optimizerLockCondition(
      row('keep', { kind: 'keep-first', targetType: 'attack' }),
      options,
      targets,
    );
    expect(condition.title).toBe('공격력 증가');
    expect(condition.detail).toContain('목표 등급과 선택 등급의 최대치 기준');
    expect(condition.detail).toContain('첫 줄을 잠그고');
    expect(condition.detail).toContain('유니크 목표는 목표 수치를 충족한 레전드리도 인정');
    expect(condition.detail).not.toContain('이미 최대치인');
    expect(
      groupOptimizerStrategies(
        [row('keep', { kind: 'keep-first', targetType: 'attack' })],
        targets,
      )[0].title,
    ).toBe('완성된 첫 줄을 잠그고 나머지 한 줄 완성');
  });

  it('uses policy lock slots to distinguish all-line generalized strategies from lower-line locks', () => {
    const targets: AbilityOptimizerTarget[] = [
      { type: 'boss', grade: 'legendary' },
      { type: 'attack', grade: 'unique' },
    ];
    for (const timing of ['direct', 'all'] as const) {
      const condition = optimizerLockCondition(
        row('any-slot', acquire(timing, ['boss', 'attack'], [0, 1, 2])),
        options,
        targets,
      );
      expect(condition.detail).toMatch(/^어느 줄이든/);
      expect(condition.detail).not.toContain('아랫줄');
    }
    const lower = optimizerLockCondition(
      row('lower', acquire('lower', ['attack'], [1, 2])),
      options,
      targets,
    );
    expect(lower.detail).toMatch(/^아랫줄에 유니크 이상/);
    const first = optimizerLockCondition(
      row('first-only', acquire('direct', ['boss'], [0])),
      options,
      targets,
    );
    expect(first.detail).toBe('첫째 줄에 레전드리 최대치로 나오면 잠가요.');
  });
});
