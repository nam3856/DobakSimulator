import type { OptionLine, SimulationConfig } from '../types';
import type { AbilityOptimizerTarget } from './ability-optimizer';
import {
  allCandidates,
  eligibleCandidates,
  gradeRank,
  lineIdentity,
  NORMAL_ABILITY_COSTS,
  normalizeText,
  resolveOptionLine,
  type AbilityRules,
  type Candidate,
  type RuleData,
} from './rules';

export interface NormalAbilityOptimizerInput {
  start: OptionLine[];
  targets: AbilityOptimizerTarget[];
  miracleRules?: Pick<AbilityRules, 'grades'>;
}
export interface NormalAbilityOptimizerStrategy {
  id: string;
  name: string;
  description: string;
  status: 'ready' | 'already' | 'impossible' | 'unavailable';
  expectedHonor: number | null;
  expectedResets: number | null;
  expectedMiracle: number | null;
  expectedBlack: number | null;
  expectedChaos: number | null;
  steps: string[];
  notes: string[];
}
export interface NormalAbilityOptimizerResult {
  strategies: NormalAbilityOptimizerStrategy[];
  notes: string[];
}
interface Cost {
  honor: number;
  resets: number;
  miracle: number;
  black: number;
  chaos: number;
}
interface Lock {
  row: Candidate;
  // Type acquisition is independent of the value draw. Preserve its full
  // distribution analytically instead of branching once for every value.
  origin: 'current' | 'drawn';
}
type Locks = Array<Lock | undefined>;
const zero = (): Cost => ({ honor: 0, resets: 0, miracle: 0, black: 0, chaos: 0 });
const add = (a: Cost, b: Cost, p = 1) => {
  if (!(p > 0)) return;
  for (const key of ['honor', 'resets', 'miracle', 'black', 'chaos'] as const)
    a[key] += p * b[key];
};
const independentNote =
  '일반 재설정·미라클 단계는 동일한 직전 세 줄을 제외하는 보정만 생략한 독립 추첨 근사입니다. 줄 등급, 종류 중복 제외, 잠금별 명성치와 목표 잠금은 반영합니다.';

/**
 * Resource-vector comparison of explicit policies, not a cross-currency optimum.
 * Ordinary resets adopt failures; our acquisition approximation forgets only the
 * previous unlocked tuple. It does not use the advanced keep-before geometric
 * correction. Black's retained baseline and Chaos's changing baseline have
 * separate exact value-only formulas below.
 */
export function optimizeNormalAbility(
  data: RuleData,
  input: NormalAbilityOptimizerInput,
): NormalAbilityOptimizerResult {
  if (input.start.length !== 3) throw new Error('현재 어빌리티 세 줄을 불러와 주세요.');
  if (
    !Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 3 ||
    input.targets.filter((goal) => goal.grade === 'legendary').length !== 1 ||
    input.targets.some((goal) => !goal.type || !['unique', 'legendary'].includes(goal.grade)) ||
    new Set(input.targets.map((goal) => goal.type)).size !== input.targets.length
  ) throw new Error('일반 최적화는 레전드리 목표 1개와 서로 다른 유니크 목표 0~2개를 선택해 주세요.');
  const goals = input.targets.map((goal) => {
    const option = data.ability.grades[goal.grade]?.options.find((row) => (row.type ?? row.id) === goal.type);
    if (!option?.values.length) throw new Error(`목표 '${goal.type}'의 확률 자료가 없습니다.`);
    const best = option.values.reduce((a, b) =>
      (option.valueDirection === 'lower' ? b.value < a.value : b.value > a.value) ? b : a);
    return { ...goal, option, best };
  });
  const config = {
    mode: 'ability', abilityResetMode: 'normal', cubeType: 'black', category: 'weapon', level: 200,
    start: { grade: 'legendary', lines: input.start, stage: 0, failures: 0 },
    lockedSlots: [], batchSize: 1, ruleVersion: data.ability.ruleId, unitPrices: {},
    target: { mode: 'ability', minimumGrade: 'legendary', conditions: [], lines: [], stage: 0, match: 'all' },
  } as SimulationConfig;
  // Do not reinterpret an existing legendary lower line as a unique line with
  // the same display text: such a line cannot be locked by ordinary resets.
  const start = input.start.map((line, slot) => slot > 0 && line.grade === 'legendary'
    ? line : resolveOptionLine(data, config, line, slot));
  const goalFor = (line: OptionLine, slot: number) => goals.find((goal) =>
    (slot === 0 ? goal.grade === 'legendary' : goal.grade === 'unique') &&
    (goal.type === line.type || goal.option.id === line.abilityTypeId) &&
    gradeRank(line.grade) >= gradeRank(goal.grade));
  const meets = (line: OptionLine, goal: typeof goals[number]) =>
    goal.option.valueDirection === 'lower' ? line.value <= goal.best.value : line.value >= goal.best.value;
  const complete = (lines: OptionLine[]) => goals.every((goal) => lines.some((line) =>
    (line.type === goal.type || line.abilityTypeId === goal.option.id) &&
    gradeRank(line.grade) >= gradeRank(goal.grade) && meets(line, goal)));
  const already = complete(start);
  const optionFor = (line: OptionLine) => data.ability.grades[line.grade]?.options.find((option) =>
    option.id === line.abilityTypeId || (option.type ?? option.id) === line.type);
  const raw = [0, 1, 2].map((slot) => allCandidates(data, config, 'legendary', slot));
  const currentRows = start.map((line, slot) => {
    const row = raw[slot].find((candidate) => candidate.line.grade === line.grade &&
      (candidate.line.type === line.type || candidate.limitGroup === line.abilityTypeId));
    return row ? { ...row, line } : undefined;
  });
  const resultRow = (
    id: string, name: string, description: string, cost: Cost | undefined,
    steps: string[], notes: string[] = [independentNote],
  ): NormalAbilityOptimizerStrategy => {
    const actual = already ? zero() : cost;
    return {
      id, name, description, steps, notes,
      status: already ? 'already' : !actual ? 'unavailable' : Object.values(actual).every(Number.isFinite) ? 'ready' : 'impossible',
      expectedHonor: actual?.honor ?? null,
      expectedResets: actual?.resets ?? null,
      expectedMiracle: actual?.miracle ?? null,
      expectedBlack: actual?.black ?? null,
      expectedChaos: actual?.chaos ?? null,
    };
  };

  function compress(rows: Candidate[], slot: number, typesOnly: boolean) {
    const groups = new Map<string, Candidate>();
    for (const row of rows) {
      const goal = goalFor(row.line, slot);
      const key = `${row.line.grade}:${row.limitGroup}:${typesOnly || !goal ? '' : meets(row.line, goal)}`;
      const previous = groups.get(key);
      if (previous) {
        previous.optionProbability += row.optionProbability;
        previous.probability += row.probability;
      } else groups.set(key, { ...row });
    }
    return [...groups.values()];
  }
  const optionsCache = new Map<string, Array<{ p: number; good: boolean; label: string }>>();
  function valuesFor(lock: Lock, slot: number) {
    const option = optionFor(lock.row.line);
    if (!option) throw new Error(`현재 ${slot + 1}번째 옵션의 수치 확률 자료가 없습니다.`);
    const key = `${lock.row.line.grade}:${option.id}:${slot}`;
    let values = optionsCache.get(key);
    if (!values) {
      const total = option.values.reduce((sum, value) => sum + value.weight, 0);
      const goal = goalFor(lock.row.line, slot);
      const groups = new Map<string, { p: number; good: boolean; label: string }>();
      for (const value of option.values) {
        const label = normalizeText(value.label);
        const good = !goal || meets({ ...lock.row.line, value: value.value }, goal);
        const existing = groups.get(label);
        if (existing) existing.p += value.weight / total;
        else groups.set(label, { p: value.weight / total, good, label });
      }
      values = [...groups.values()];
      optionsCache.set(key, values);
    }
    return values;
  }

  // A fixed-type value draw has tuple masses p_i. Black rejects every miss and
  // costs (1-p_current)/q. Chaos adopts every miss and costs
  // (1-sum_{i in failure} p_i^2)/q-p_current. Averaging these formulas over each
  // acquired line's value distribution also skips already-complete outcomes.
  function circulation(locks: Locks, kind: 'black' | 'chaos'): Cost {
    let q = 1, squares = 1, goodSquares = 1, currentComplete = 1, old = 1, goodOld = 1;
    locks.forEach((lock, slot) => {
      if (!lock) throw new Error('서큘레이터 준비에 필요한 옵션이 없습니다.');
      const values = valuesFor(lock, slot);
      const good = values.filter((value) => value.good);
      q *= good.reduce((sum, value) => sum + value.p, 0);
      squares *= values.reduce((sum, value) => sum + value.p * value.p, 0);
      goodSquares *= good.reduce((sum, value) => sum + value.p * value.p, 0);
      if (lock.origin === 'drawn') {
        currentComplete *= good.reduce((sum, value) => sum + value.p, 0);
        old *= values.reduce((sum, value) => sum + value.p * value.p, 0);
        goodOld *= good.reduce((sum, value) => sum + value.p * value.p, 0);
      } else {
        const current = values.find((value) => value.label === lineIdentity(lock.row.line));
        if (!current) throw new Error(`현재 ${slot + 1}번째 옵션의 수치를 확률 자료에서 찾지 못했습니다.`);
        currentComplete *= Number(current.good);
        old *= current.p;
        goodOld *= current.good ? current.p : 0;
      }
    });
    const cost = zero();
    cost[kind] = q > 0 ? Math.max(0, kind === 'black'
      ? ((1 - currentComplete) - (old - goodOld)) / q
      : (1 - currentComplete) * (1 - squares + goodSquares) / q - (old - goodOld)) : Infinity;
    return cost;
  }
  function goalCompleteChance(locks: Locks) {
    let result = 1;
    for (const goal of goals) {
      const slot = locks.findIndex((lock, index) => lock && goalFor(lock.row.line, index)?.type === goal.type);
      if (slot < 0) return 0;
      const lock = locks[slot]!;
      result *= lock.origin === 'current' ? Number(meets(lock.row.line, goal)) :
        valuesFor(lock, slot).filter((value) => value.good).reduce((sum, value) => sum + value.p, 0);
    }
    return result;
  }

  function ordinaryPolicy(kind: 'honor' | 'black' | 'chaos', priority: 'any' | 'lower' = 'any') {
    const typesOnly = kind !== 'honor';
    const candidates = raw.map((rows, slot) => compress(rows, slot, typesOnly));
    const cache = new Map<string, Cost>();
    const choices = new Map<string, Candidate[]>();
    const goalCount = (locks: Locks) => locks.filter((lock, slot) => lock && goalFor(lock.row.line, slot)).length;
    const keyFor = (locks: Locks) => locks.map((lock) => !lock ? '-' :
      `${lock.row.line.grade}:${lock.row.limitGroup}:${typesOnly ? lock.origin === 'current' ? lineIdentity(lock.row.line) : '*' : ''}`).join('|');
    function acquire(previous: Locks, rows: Array<Candidate | undefined>, origin: Lock['origin']): Locks {
      const locks = [...previous];
      for (const slot of priority === 'lower' ? [1, 2, 0] : [0, 1, 2]) {
        if (locks[slot]) continue;
        if (slot === 0 && priority === 'lower' &&
          locks.filter((lock, index) => index > 0 && lock && goalFor(lock.row.line, index)).length < goals.length - 1) continue;
        const row = rows[slot];
        if (!row || (slot > 0 && row.line.grade === 'legendary')) continue;
        const goal = goalFor(row.line, slot);
        if (goal && (typesOnly || meets(row.line, goal))) locks[slot] = { row, origin };
      }
      if (typesOnly && goalCount(locks) === goals.length) {
        for (const slot of [1, 2]) if (!locks[slot] && rows[slot] && rows[slot]!.line.grade !== 'legendary')
          locks[slot] = { row: rows[slot]!, origin };
      }
      return locks;
    }
    function mean(locks: Locks): Cost {
      const key = keyFor(locks);
      const saved = cache.get(key);
      if (saved) return saved;
      const locked = locks.filter(Boolean).length;
      if (!typesOnly && goalCount(locks) === goals.length) return zero();
      if (locked === 3) return circulation(locks, kind as 'black' | 'chaos');
      const active = typesOnly ? 1 - goalCompleteChance(locks) : 1;
      if (active <= 0) return zero();
      const slots = [0, 1, 2].filter((slot) => !locks[slot]);
      const fixed = locks.filter((lock): lock is Lock => !!lock).map((lock) => lock.row);
      const rows = locks.map((lock) => lock?.row);
      const transitions = new Map<string, { probability: number; locks: Locks }>();
      function visit(depth: number, prefix: Candidate[], probability: number) {
        if (depth === slots.length) {
          const next = acquire(locks, rows, 'drawn');
          if (next.filter(Boolean).length === locked) return;
          const nextKey = keyFor(next);
          const item = transitions.get(nextKey);
          if (item) item.probability += probability;
          else transitions.set(nextKey, { probability, locks: next });
          return;
        }
        const slot = slots[depth];
        const choiceKey = `${slot}:${prefix.map((row) => row.limitGroup).sort().join(',')}`;
        let eligible = choices.get(choiceKey);
        if (!eligible) {
          eligible = eligibleCandidates(candidates[slot], prefix);
          choices.set(choiceKey, eligible);
        }
        for (const row of eligible) {
          rows[slot] = row;
          prefix.push(row);
          visit(depth + 1, prefix, probability * row.probability);
          prefix.pop();
        }
      }
      visit(0, [...fixed], 1);
      const progress = [...transitions.values()].reduce((sum, item) => sum + item.probability, 0);
      if (!(progress > 0)) return { ...zero(), honor: Infinity, resets: Infinity };
      const result = { ...zero(), honor: active * NORMAL_ABILITY_COSTS[locked].honor / progress, resets: active / progress };
      for (const transition of transitions.values()) add(result, mean(transition.locks), transition.probability / progress);
      cache.set(key, result);
      return result;
    }
    return { acquire, mean, initial: acquire([undefined, undefined, undefined], currentRows, 'current') };
  }
  const direct = ordinaryPolicy('honor');
  const directCost = already ? zero() : direct.mean(direct.initial);
  const strategies: NormalAbilityOptimizerStrategy[] = [resultRow(
    'normal-honor', '일반 재설정만 사용', '목표 수치까지 맞춘 줄을 잠그고, 일반 재설정으로 남은 목표를 완성합니다.', directCost,
    ['첫 줄은 레전드리 목표, 아랫줄은 유니크 목표의 최상위 수치가 나오면 잠급니다.',
      '현재 목표를 만족한 줄부터 유지합니다. 일반 재설정의 실패 결과도 즉시 적용됩니다.',
      '잠금 0 / 1 / 2개일 때 1회당 명성치 8,000 / 11,000 / 16,000을 사용합니다.'],
  )];
  if (goals.length > 1) {
    const lowerFirst = ordinaryPolicy('honor', 'lower');
    strategies.push(resultRow(
      'normal-honor-lower-first', '일반 재설정: 아랫줄부터 완성',
      '유니크 목표 아랫줄을 먼저 잠그고, 마지막에 레전드리 첫 줄을 완성합니다.',
      already ? zero() : lowerFirst.mean(lowerFirst.initial),
      ['유니크 목표 아랫줄이 목표 수치에 도달하면 잠급니다. 아랫줄 목표가 모두 완성되기 전에는 첫 줄을 잠그지 않습니다.',
        '필요한 아랫줄을 모두 완성한 뒤 잠금을 유지하며 첫 줄의 레전드리 목표 수치를 맞춥니다.',
        '현재 완성된 첫 줄도 재설정될 수 있는 방법입니다. 첫 줄을 유지하는 방식은 일반 재설정만 사용 전략과 비교하세요.'],
    ));
  }
  for (const kind of ['black', 'chaos'] as const) {
    const policy = ordinaryPolicy(kind);
    const label = kind === 'black' ? '블랙' : '카오스';
    strategies.push(resultRow(
      `normal-${kind}`, `일반 재설정 → ${label} 서큘레이터`,
      `목표 종류를 갖춘 뒤 ${label} 서큘레이터로 수치를 완성합니다. 목표가 없는 아랫줄은 에픽이어도 되며, 현재 조건이 갖춰져 있으면 바로 수치를 맞춥니다.`,
      already ? zero() : policy.mean(policy.initial),
      ['목표 수치와 무관하게 첫 줄의 레전드리 목표 종류, 아랫줄의 유니크 목표 종류를 확보하면 잠급니다.',
        '목표가 없는 아랫줄은 에픽/유니크 모두 그대로 둡니다. 아랫줄 레전드리가 있으면 일반 재설정으로 바꾼 뒤 진행합니다. 목표 수치가 이미 완성되면 추가 준비를 생략합니다.',
        `${label} 서큘레이터는 등급과 종류를 유지하고 세 줄 수치를 함께 재설정합니다. 옵션 잠금은 사용할 수 없습니다.`,
        kind === 'black' ? '모든 목표 수치가 완성된 결과만 적용하며, 미달 결과는 기존 수치를 유지합니다.' : '매 결과를 즉시 적용하고, 모든 목표 수치가 완성되면 멈춥니다.'],
      [independentNote, '고정된 종류에서 수치를 바꾸는 단계는 동일 결과 제외와 블랙의 이전 결과 유지 / 카오스의 강제 적용을 각각 반영한 해석식입니다. 모든 수치가 고정값이면 사용을 생략합니다.'],
    ));
  }

  const unverifiedMiracleStart = start.slice(1).some((line) => line.grade === 'legendary');
  if (input.miracleRules && !unverifiedMiracleStart) {
    const miracleData = { ...data, ability: { ...data.ability, grades: input.miracleRules.grades } };
    const candidates = [0, 1, 2].map((slot) => allCandidates(miracleData, config, 'legendary', slot));
    const rows: Candidate[] = [];
    let allProbability = 0, prepareProbability = 0;
    const future = zero();
    const lowerGoals = goals.filter((goal) => goal.grade === 'unique');
    const alreadyPrepared = direct.initial.some((lock, slot) => slot > 0 && !!lock);
    const nextPhases = new Map<string, { probability: number; locks: Locks }>();
    function visit(slot: number, probability: number) {
      if (slot === 3) {
        const locks = direct.acquire([undefined, undefined, undefined], rows, 'current');
        const hit = locks.filter(Boolean).length === goals.length;
        if (hit) allProbability += probability;
        if (hit || (lowerGoals.length > 0 && locks.some((lock, index) => index > 0 && !!lock))) {
          prepareProbability += probability;
          const key = locks.map((lock) => lock ? `${lock.row.line.grade}:${lock.row.limitGroup}` : '-').join('|');
          const item = nextPhases.get(key);
          if (item) item.probability += probability;
          else nextPhases.set(key, { probability, locks });
        }
        return;
      }
      for (const row of eligibleCandidates(candidates[slot], rows)) {
        rows.push(row);
        visit(slot + 1, probability * row.probability);
        rows.pop();
      }
    }
    if (!already) visit(0, 1);
    for (const phase of nextPhases.values()) add(future, direct.mean(phase.locks), phase.probability / prepareProbability);
    strategies.push(resultRow(
      'normal-miracle', '미라클 서큘레이터만 사용', '잠금 없이 세 줄을 다시 뽑아 목표 등급과 최상위 수치 조합을 한 번에 완성합니다.',
      { ...zero(), miracle: allProbability > 0 ? 1 / allProbability : Infinity },
      ['미라클 전용 옵션 종류 확률을 사용합니다. 각 등급에서 나오는 수치는 최상위 값입니다.',
        '목표를 만족할 때까지 미라클 서큘레이터를 사용합니다. 옵션 잠금은 사용할 수 없습니다.'],
    ));
    strategies.push(resultRow(
      'normal-miracle-honor', '미라클로 아랫줄 확보 → 일반 재설정',
      lowerGoals.length ? '미라클로 유니크 목표 아랫줄 하나를 확보한 뒤, 확보한 목표를 잠그고 명성치로 나머지를 완성합니다.' : '미라클로 레전드리 목표 첫 줄을 확보합니다. 유니크 목표가 없으므로 추가 재설정은 필요 없습니다.',
      alreadyPrepared ? directCost : { ...future, miracle: prepareProbability > 0 ? 1 / prepareProbability : Infinity },
      [lowerGoals.length ? '이미 목표 수치의 유니크 아랫줄이 있으면 미라클 단계를 생략합니다.' : '레전드리 목표가 나오면 미라클 단계를 마칩니다.',
        '미라클 사용 중에는 잠금 없이 세 줄 전체를 재설정합니다.',
        '유니크 목표 중 하나를 얻으면 함께 완성된 목표도 잠그고, 일반 재설정으로 나머지를 완성합니다.'],
    ));
  } else {
    for (const id of ['normal-miracle', 'normal-miracle-honor']) strategies.push(resultRow(
      id, id === 'normal-miracle' ? '미라클 서큘레이터만 사용' : '미라클로 아랫줄 확보 → 일반 재설정',
      unverifiedMiracleStart
        ? '하위 레전드리 옵션이 있을 때 미라클 사용 조건을 공식 자료에서 확인하지 못해 비교에서 제외합니다.'
        : '미라클 전용 확률 자료를 불러오면 사용 개수 기댓값을 비교할 수 있습니다.', undefined, [],
      [unverifiedMiracleStart
        ? '실제 게임에서 사용할 수 없다는 판정이 아닙니다. 일반 재설정으로 하위 레전드리를 정리한 상태에서는 미라클 전략을 비교할 수 있습니다.'
        : '미라클은 일반 재설정과 옵션 종류 확률이 다르므로 일반 확률로 대신 계산하지 않습니다.'],
    ));
  }
  return {
    strategies,
    notes: [
      '레전드리 목표 1개는 일반 재설정으로 비교합니다. 목표는 선택한 등급의 최상위 수치이며, 목표가 없는 줄은 완성 조건에서 제외합니다.',
      '명성치와 미라클·블랙·카오스 서큘레이터 사용 개수는 서로 다른 자원입니다. 메소 환산이나 자원을 합산한 종합 순위는 제공하지 않습니다.',
      '제시한 잠금·준비 전략의 기댓값 비교이며, 모든 가능한 전략의 전역 최적해는 아닙니다. 명성치 할인 이벤트는 적용하지 않습니다.',
      independentNote,
      '블랙·카오스는 전체 어빌리티 등급이 유니크 이상이면 사용할 수 있어 목표가 없는 에픽 아랫줄도 허용합니다. 아랫줄 레전드리는 사용할 수 없고, 일반 재설정에서 잠글 수 없어 다시 뽑으면 에픽/유니크가 됩니다.',
      '심연의 서큘레이터는 일반 비교에서 제외합니다. 현재 옵션을 마련하는 데 이미 사용한 자원은 포함하지 않습니다.',
    ],
  };
}
