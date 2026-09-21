import type {
  AbilityOptimizerStrategyResult,
  AbilityOptimizerTarget,
} from '../engine/ability-optimizer';
import type { AbilityOption } from '../engine/rules';
import { abilityKindLabel } from '../engine/ability-labels';

export const OPTIMIZER_METHOD_TITLES = {
  direct: '재설정만으로 세 줄 완성',
  lower: '아랫줄 두 줄부터 서큘레이터로 완성',
  all: '세 종류를 갖춘 뒤 서큘레이터로 완성',
  'keep-first': '완성된 첫 줄을 잠그고 나머지 완성',
} as const;
export type OptimizerMethod = keyof typeof OPTIMIZER_METHOD_TITLES;

const targetCountWord = (targets?: readonly AbilityOptimizerTarget[]) =>
  ({ 1: '한', 2: '두', 3: '세' })[targets?.length as 1 | 2 | 3] ?? '세';

function methodTitle(method: OptimizerMethod, targets?: readonly AbilityOptimizerTarget[]) {
  if (!targets?.length || targets.length === 3) return OPTIMIZER_METHOD_TITLES[method];
  const count = targetCountWord(targets);
  switch (method) {
    case 'direct':
      return `재설정만으로 ${count} 줄 완성`;
    case 'lower':
      return `아랫줄부터 서큘레이터로 ${count} 줄 완성`;
    case 'all':
      return `${count} 종류를 갖춘 뒤 서큘레이터로 완성`;
    case 'keep-first':
      return targets.length === 1 ? '완성된 첫 줄 유지' : '완성된 첫 줄을 잠그고 나머지 한 줄 완성';
  }
}

export function optimizerMethod(strategy: AbilityOptimizerStrategyResult): OptimizerMethod {
  const { policy } = strategy;
  return policy.kind === 'acquire'
    ? policy.timing
    : policy.kind === 'current-types'
      ? 'all'
      : 'keep-first';
}

export function groupOptimizerStrategies(
  strategies: AbilityOptimizerStrategyResult[],
  targets?: readonly AbilityOptimizerTarget[],
) {
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
        title: methodTitle(method, targets),
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
  targets?: readonly AbilityOptimizerTarget[],
) {
  const label = (type: string) =>
    abilityKindLabel(options.find((option) => option.type === type)?.label ?? '목표 옵션');
  const { policy } = strategy;
  const count = targetCountWord(targets);
  const explicitTargets = !!targets?.length;
  if (strategy.status === 'already')
    return {
      label: '현재 상태',
      title: `목표 ${count} 줄 완성`,
      detail: '추가 재설정이 필요 없어요.',
    };
  if (policy.kind === 'current-types')
    return {
      label: '현재 상태',
      title: explicitTargets ? `이미 목표 ${count} 종류가 있어요` : '이미 세 종류가 있어요',
      detail: explicitTargets
        ? '목표 등급을 충족한 옵션 종류는 유지하고 수치만 완성해요.'
        : '옵션 종류는 유지하고 수치만 완성해요.',
    };
  if (policy.kind === 'keep-first') {
    const uniqueTarget = targets?.some(
      (target) => target.type === policy.targetType && target.grade === 'unique',
    );
    return {
      label: '첫 잠금 조건',
      title: label(policy.targetType),
      detail: explicitTargets
        ? `이미 목표 등급과 선택 등급의 최대치 기준을 충족한 첫 줄을 잠그고 시작해요.${uniqueTarget ? ' 유니크 목표는 목표 수치를 충족한 레전드리도 인정해요.' : ''}`
        : '이미 최대치인 첫 줄을 잠그고 시작해요.',
    };
  }
  const accepted = targets?.filter((target) => policy.firstAcceptedTargets.includes(target.type));
  const acceptsAnyTarget = explicitTargets
    ? targets!.length > 1 &&
      targets!.every((target) => policy.firstAcceptedTargets.includes(target.type))
    : policy.firstAcceptedTargets.length === 3;
  const hasUnique = accepted?.some((target) => target.grade === 'unique');
  const uniqueOnly = !!accepted?.length && accepted.every((target) => target.grade === 'unique');
  const lockSlots = [...new Set(policy.lockSlots?.length ? policy.lockSlots : [1, 2])].sort();
  const anywhere = lockSlots.length === 3;
  const location =
    lockSlots.length === 2 && lockSlots[0] === 1 && lockSlots[1] === 2
      ? '아랫줄'
      : `${lockSlots.map((slot) => ['첫째', '둘째', '셋째'][slot]).join('·')} 줄`;
  const appears = anywhere ? '어느 줄이든' : `${location}에`;
  const satisfies = anywhere ? '어느 줄이든' : `${location}에서`;
  const directDetail = hasUnique
    ? `${uniqueOnly ? `${appears} 유니크 이상으로 나오고, 선택한 유니크 최대치를 충족하면 잠가요.` : `${satisfies} 각 옵션의 목표 등급과 선택 등급의 최대치 기준을 모두 충족하면 잠가요.`} 유니크 목표는 목표 수치를 충족한 레전드리도 인정해요.`
    : `${appears} 레전드리 최대치로 나오면 잠가요.`;
  const circulatorDetail = hasUnique
    ? `${uniqueOnly ? `${appears} 유니크 이상으로 나오면 현재 수치와 관계없이 잠가요.` : `${appears} 각 옵션의 목표 등급 이상으로 나오면 현재 수치와 관계없이 잠가요.`} 유니크 목표는 레전드리도 인정해요.`
    : `${appears} 레전드리로 나오면 수치와 관계없이 잠가요.`;
  return {
    label: '첫 잠금 조건',
    title: acceptsAnyTarget
      ? '목표 옵션 중 무엇이든'
      : policy.firstAcceptedTargets.map(label).join(' 또는 '),
    detail: policy.timing === 'direct' ? directDetail : circulatorDetail,
  };
}
