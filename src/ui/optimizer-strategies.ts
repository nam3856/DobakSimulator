import type { AbilityOptimizerStrategyResult } from '../engine/ability-optimizer';
import type { AbilityOption } from '../engine/rules';
import { abilityKindLabel } from '../engine/ability-labels';

export const OPTIMIZER_METHOD_TITLES = {
  direct: '재설정만으로 세 줄 완성',
  lower: '아랫줄 두 줄부터 서큘레이터로 완성',
  all: '세 종류를 갖춘 뒤 서큘레이터로 완성',
  'keep-first': '완성된 첫 줄을 잠그고 나머지 완성',
} as const;
export type OptimizerMethod = keyof typeof OPTIMIZER_METHOD_TITLES;

export function optimizerMethod(strategy: AbilityOptimizerStrategyResult): OptimizerMethod {
  const { policy } = strategy;
  return policy.kind === 'acquire'
    ? policy.timing
    : policy.kind === 'current-types'
      ? 'all'
      : 'keep-first';
}

export function groupOptimizerStrategies(strategies: AbilityOptimizerStrategyResult[]) {
  const groups = new Map<OptimizerMethod, AbilityOptimizerStrategyResult[]>();
  for (const strategy of strategies) {
    const method = optimizerMethod(strategy);
    const rows = groups.get(method) ?? [];
    rows.push(strategy);
    groups.set(method, rows);
  }
  return [...groups]
    .map(([method, rows]) => {
      const sorted = rows.sort((a, b) => a.totalCost - b.totalCost || a.id.localeCompare(b.id));
      return {
        method,
        title: OPTIMIZER_METHOD_TITLES[method],
        strategies: sorted,
        best: sorted[0],
      };
    })
    .sort((a, b) => a.best.totalCost - b.best.totalCost || a.method.localeCompare(b.method));
}

/** Option kinds describe the first lock; target maximum values belong in the goal summary. */
export function optimizerLockCondition(
  strategy: AbilityOptimizerStrategyResult,
  options: AbilityOption[],
) {
  const label = (type: string) =>
    abilityKindLabel(options.find((option) => option.type === type)?.label ?? '목표 옵션');
  const { policy } = strategy;
  if (strategy.status === 'already')
    return { label: '현재 상태', title: '목표 세 줄 완성', detail: '추가 재설정이 필요 없어요.' };
  if (policy.kind === 'current-types')
    return {
      label: '현재 상태',
      title: '이미 세 종류가 있어요',
      detail: '옵션 종류는 유지하고 수치만 완성해요.',
    };
  if (policy.kind === 'keep-first')
    return {
      label: '첫 잠금 조건',
      title: label(policy.targetType),
      detail: '이미 최대치인 첫 줄을 잠그고 시작해요.',
    };
  return {
    label: '첫 잠금 조건',
    title:
      policy.firstAcceptedTargets.length === 3
        ? '목표 옵션 중 무엇이든'
        : policy.firstAcceptedTargets.map(label).join(' 또는 '),
    detail:
      policy.timing === 'direct'
        ? '아랫줄에 레전드리 최대치로 나오면 잠가요.'
        : '아랫줄에 레전드리로 나오면 수치와 관계없이 잠가요.',
  };
}
