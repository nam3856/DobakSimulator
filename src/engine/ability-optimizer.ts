import type { OptionLine, SimulationConfig } from '../types';
import { calculateAbilityTargetStrategies } from './ability-optimizer-targets';
import { abilityKindLabel } from './ability-labels';
import {
  allCandidates,
  eligibleCandidates,
  lineIdentity,
  normalizeText,
  resolveOptionLine,
  type AbilityOption,
  type Candidate,
  type RuleData,
} from './rules';

export interface AbilityOptimizerInput {
  start: OptionLine[];
  targetTypes?: [string, string, string];
  targets?: AbilityOptimizerTarget[];
  medalPrice: number;
  circulatorPrice: number;
  availableHonor?: number;
  batchSize: 1 | 3;
}
export interface AbilityOptimizerTarget {
  type: string;
  grade: 'unique' | 'legendary';
}
export type AbilityOptimizerPolicy =
  | {
      kind: 'acquire';
      timing: 'direct' | 'lower' | 'all';
      firstAcceptedTargets: string[];
      lockSlots?: Array<0 | 1 | 2>;
    }
  | { kind: 'current-types' }
  | { kind: 'keep-first'; targetType: string };
export interface AbilityOptimizerStrategyResult {
  id: string;
  policy: AbilityOptimizerPolicy;
  name: string;
  description: string;
  expectedMeso: number;
  expectedHonor: number;
  estimatedAdditionalHonor: number;
  estimatedHonorPurchaseCost: number;
  expectedResets: number;
  expectedCirculators: number;
  totalCost: number;
  status: 'ready' | 'impossible' | 'already';
  steps: string[];
}
export interface AbilityOptimizerResult {
  strategies: AbilityOptimizerStrategyResult[];
  bestStrategyId?: string;
  notes: string[];
}
type Timing = 'direct' | 'lower' | 'all';
type UnpricedStrategy = Omit<
  AbilityOptimizerStrategyResult,
  'estimatedAdditionalHonor' | 'estimatedHonorPurchaseCost'
>;
interface Cost {
  resets: number;
  honor: number;
  meso: number;
  circulators: number;
}
interface Group {
  rank: number;
  mass: number;
  future: Cost;
}
interface Phase {
  key: string;
  locks: number[];
  lines: OptionLine[];
  fixed: Candidate[];
  firstMask: number;
  groups?: Group[];
  means: Map<number, Cost>;
}
const calculationCache = new WeakMap<RuleData, Map<string, UnpricedStrategy[]>>();
const zero = (): Cost => ({ resets: 0, honor: 0, meso: 0, circulators: 0 });
const impossible = (): Cost => ({
  resets: Infinity,
  honor: Infinity,
  meso: Infinity,
  circulators: Infinity,
});
function add(target: Cost, value: Cost, weight = 1) {
  if (!(weight > 0)) return;
  for (const key of ['resets', 'honor', 'meso', 'circulators'] as const)
    target[key] += value[key] * weight;
}

function pricedResult(
  rows: UnpricedStrategy[],
  input: AbilityOptimizerInput,
): AbilityOptimizerResult {
  const availableHonor = input.availableHonor ?? 0;
  const strategies = rows
    .map((row) => {
      const finite = [
        row.expectedMeso,
        row.expectedHonor,
        row.expectedResets,
        row.expectedCirculators,
      ].every(Number.isFinite);
      const estimatedAdditionalHonor = Math.max(0, row.expectedHonor - availableHonor);
      const estimatedHonorPurchaseCost = Number.isFinite(estimatedAdditionalHonor)
        ? (estimatedAdditionalHonor / 5000) * input.medalPrice
        : Infinity;
      const totalCost = finite
        ? row.expectedMeso +
          estimatedHonorPurchaseCost +
          row.expectedCirculators * input.circulatorPrice
        : Infinity;
      return {
        ...row,
        estimatedAdditionalHonor,
        estimatedHonorPurchaseCost,
        totalCost,
        status:
          row.status === 'already'
            ? ('already' as const)
            : finite
              ? ('ready' as const)
              : ('impossible' as const),
      };
    })
    .sort((a, b) => a.totalCost - b.totalCost || a.id.localeCompare(b.id));
  return {
    strategies,
    bestStrategyId: strategies.find((row) => row.status !== 'impossible')?.id,
    notes: [
      `비교한 ${strategies.length}개 전략 중 예상 총비용이 가장 낮은 방법입니다. 모든 가능한 정책의 전역 최적해는 아닙니다.`,
      input.targets?.some((target) => target.grade !== 'legendary') ||
      (input.targets?.length !== undefined && input.targets.length !== 3)
        ? `선택한 목표 ${input.targets!.length}개의 등급과 수치 조건을 만족하면 완성입니다. 각 목표는 선택 등급의 최상위 수치를 기준으로 판정하며, 더 높은 등급도 수치 조건을 만족하면 인정합니다. 목표에 없는 줄과 최종 줄 순서는 무관합니다.`
        : '목표는 세 옵션 모두 레전드리 최대치이며 최종 줄 순서는 무관합니다. 목표 전체를 완성한 결과는 먼저 채택합니다.',
      '3회 비교는 같은 잠금에서 세 번 모두 과금합니다. 성공 또는 다음 단계 우선, 같은 단계는 먼저 나온 결과를 채택합니다.',
      '심연의 서큘레이터는 등급·종류를 유지하고 세 줄 수치를 함께 다시 뽑으며, 전체 동일 결과를 제외하고 미달 결과는 보관하지 않습니다.',
      '패시브 스킬 레벨 +1처럼 나올 수 있는 값이 하나뿐인 옵션은 서큘레이터를 사용해도 수치가 바뀌지 않습니다. 이미 필요한 수치가 완성된 단계는 건너뜁니다.',
      '명성치 구매비는 평균 필요 명성치에서 보유 명성치를 뺀 부족분을 5,000당 훈장 단가로 환산한 추정치입니다. 보유량이 평균 이상이어도 실제 도전에서 추가 구매가 필요할 수 있습니다.',
      '추정 구매비는 매 도전의 실제 부족분을 평균 낸 정확한 기댓값이 아닙니다. 이미 확보한 시작 옵션의 준비 비용은 포함하지 않습니다.',
    ],
  };
}

/** Compare explicit retained-result policies. Every mean is a finite-state analytic
 * expectation; neither reset attempts nor circulator failures are replayed. */
export function optimizeAbilityCost(
  data: RuleData,
  input: AbilityOptimizerInput,
): AbilityOptimizerResult {
  if (input.start.length !== 3) throw new Error('현재 어빌리티 세 줄을 불러와 주세요.');
  if (![1, 3].includes(input.batchSize))
    throw new Error('재설정 비교 횟수는 1회 또는 3회여야 합니다.');
  const requested =
    input.targets === undefined
      ? input.targetTypes?.map((type) => ({ type, grade: 'legendary' as const }))
      : input.targets;
  if (
    !Array.isArray(requested) ||
    requested.length < 1 ||
    requested.length > 3 ||
    (input.targets === undefined && requested.length !== 3) ||
    requested.some(
      (target) =>
        !target ||
        typeof target.type !== 'string' ||
        !target.type ||
        !['unique', 'legendary'].includes(target.grade),
    ) ||
    new Set(requested.map((target) => target.type)).size !== requested.length
  )
    throw new Error(
      '서로 다른 목표 옵션을 1개부터 3개까지 선택하고 유니크 또는 레전드리 등급을 지정해 주세요.',
    );
  if (
    ![input.medalPrice, input.circulatorPrice].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER,
    )
  )
    throw new Error('아이템 가격은 0 이상의 안전한 숫자로 입력해 주세요.');
  const availableHonor = input.availableHonor === undefined ? 0 : input.availableHonor;
  if (!Number.isInteger(availableHonor) || availableHonor < 0 || availableHonor > 999999999)
    throw new Error('보유 명성치는 0부터 999,999,999까지의 정수로 입력해 주세요.');
  const cacheKey = JSON.stringify({
    start: input.start,
    targets: requested,
    batchSize: input.batchSize,
  });
  const cached = calculationCache.get(data)?.get(cacheKey);
  if (cached) return pricedResult(cached, input);
  if (requested.length !== 3 || requested.some((target) => target.grade !== 'legendary')) {
    const rows = calculateAbilityTargetStrategies(data, input, requested);
    let cache = calculationCache.get(data);
    if (!cache) calculationCache.set(data, (cache = new Map()));
    if (cache.size >= 4) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, rows);
    return pricedResult(rows, input);
  }
  const targets = requested.map(({ type }) => {
    const option = data.ability.grades.legendary?.options.find(
      (row) => (row.type ?? row.id) === type,
    );
    if (!option?.values.length) throw new Error(`레전드리 목표 '${type}'의 확률 자료가 없습니다.`);
    const best = option.values.reduce((a, b) =>
      (option.valueDirection === 'lower' ? b.value < a.value : b.value > a.value) ? b : a,
    );
    return { type, option, best };
  });
  const config: SimulationConfig = {
    mode: 'ability',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'legendary', lines: input.start, stage: 0, failures: 0 },
    lockedSlots: [],
    batchSize: input.batchSize,
    ruleVersion: data.ability.ruleId,
    unitPrices: {},
    target: {
      mode: 'ability',
      minimumGrade: 'legendary',
      conditions: [],
      lines: [],
      stage: 0,
      match: 'all',
    },
  };
  const start = input.start.map((line, slot) => resolveOptionLine(data, config, line, slot));
  const raw = [0, 1, 2].map((slot) => allCandidates(data, config, 'legendary', slot));
  const identities = raw.map((rows) => {
    const map = new Map<string, Candidate[]>();
    for (const row of rows) {
      const key = lineIdentity(row.line);
      const group = map.get(key);
      if (group) group.push(row);
      else map.set(key, [row]);
    }
    return map;
  });
  const options = new Map<string, AbilityOption>();
  for (const [grade, rows] of Object.entries(data.ability.grades))
    for (const option of rows.options) {
      options.set(`${grade}:${option.id}`, option);
      options.set(`${grade}:${option.type ?? option.id}`, option);
    }
  const lineOption = (line: OptionLine) =>
    options.get(`${line.grade}:${line.abilityTypeId ?? line.type}`) ??
    options.get(`${line.grade}:${line.type}`);
  const valueChance = (line: OptionLine): number => {
    const option = lineOption(line);
    if (!option) return 0;
    const total = option.values.reduce((sum, value) => sum + value.weight, 0);
    const visible = option.values.filter(
      (value) => normalizeText(value.label) === lineIdentity(line),
    );
    const rows = visible.length
      ? visible
      : option.values.filter((value) => value.value === line.value);
    return rows.reduce((sum, value) => sum + value.weight, 0) / total;
  };
  const targetIndices = new WeakMap<OptionLine, number>();
  const targetIndex = (line: OptionLine) => {
    const saved = targetIndices.get(line);
    if (saved !== undefined) return saved;
    const index =
      line.grade === 'legendary'
        ? targets.findIndex(
            (target) => target.type === line.type || target.option.id === line.abilityTypeId,
          )
        : -1;
    targetIndices.set(line, index);
    return index;
  };
  const isMax = (line: OptionLine) => {
    const index = targetIndex(line);
    return index >= 0 && line.value === targets[index].best.value;
  };
  const allTypes = (lines: OptionLine[]) => {
    const a = targetIndex(lines[0]),
      b = targetIndex(lines[1]),
      c = targetIndex(lines[2]);
    return a >= 0 && b >= 0 && c >= 0 && a !== b && a !== c && b !== c;
  };
  const complete = (lines: OptionLine[]) => allTypes(lines) && lines.every(isMax);
  const profileCache = new Map<string, string>();
  const lineProfiles = new WeakMap<OptionLine, string>();
  const internedProfiles = new Map<string, string>();
  const profile = (line: OptionLine): string => {
    const saved = lineProfiles.get(line);
    if (saved !== undefined) return saved;
    const key = `${line.grade}:${lineIdentity(line)}`;
    let value = profileCache.get(key);
    if (value === undefined) {
      value = JSON.stringify([
        line.grade,
        valueChance(line),
        isMax(line),
        identities.map((map) =>
          (map.get(lineIdentity(line)) ?? []).map((row) => [
            row.limitGroup,
            row.line.grade,
            row.optionProbability,
            row.gradeProbability,
          ]),
        ),
      ]);
      let id = internedProfiles.get(value);
      if (!id) internedProfiles.set(value, (id = String(internedProfiles.size)));
      value = id;
      profileCache.set(key, value);
    }
    lineProfiles.set(line, value);
    return value;
  };
  const compressed = raw.map((rows) => {
    const groups = new Map<string, Candidate>();
    for (const candidate of rows) {
      const key = profile(candidate.line);
      const saved = groups.get(key);
      if (saved) {
        saved.optionProbability += candidate.optionProbability;
        saved.probability += candidate.probability;
      } else groups.set(key, { ...candidate });
    }
    return [...groups.values()];
  });
  const eligibleCache = new Map<string, Candidate[]>();
  const eligible = (slot: number, prefix: Candidate[]) => {
    const key = `${slot}:${prefix
      .map((candidate) => candidate.limitGroup)
      .sort()
      .join(',')}`;
    let rows = eligibleCache.get(key);
    if (!rows) {
      rows = eligibleCandidates(compressed[slot], prefix);
      eligibleCache.set(key, rows);
    }
    return rows;
  };
  const candidateFor = (line: OptionLine, slot: number): Candidate => {
    const rows = identities[slot].get(lineIdentity(line)) ?? [];
    const candidate = rows.find((row) => row.line.grade === line.grade) ?? rows[0];
    if (!candidate)
      throw new Error(
        `현재 ${slot + 1}번째 옵션의 공식 확률을 찾을 수 없습니다. 시작 옵션을 확인해 주세요.`,
      );
    return candidate;
  };
  // Unrecognized imported lines cannot safely be used for a type-preserving circulator.
  for (const [slot, line] of start.entries()) candidateFor(line, slot);
  const bestLine = (line: OptionLine): OptionLine => {
    const target = targets[targetIndex(line)];
    return {
      ...line,
      value: target.best.value,
      text: target.best.label,
      id: `${target.option.id}:legendary:${target.best.value}:${target.best.secondaryValue ?? ''}`,
    };
  };
  const maxChance = (line: OptionLine) => valueChance(bestLine(line));
  const circulation = (lines: OptionLine[], slots: number[]): number => {
    if (slots.every((slot) => isMax(lines[slot]))) return 0;
    const success = slots.reduce((probability, slot) => probability * maxChance(lines[slot]), 1);
    const repeat = lines.reduce((probability, line) => probability * valueChance(line), 1);
    return success > 0 ? (1 - repeat) / success : Infinity;
  };
  const repeatCache = new Map<string, number>();
  const repeatProbability = (phase: Phase, lines: OptionLine[]): number => {
    const slots = [0, 1, 2].filter((slot) => !phase.locks.includes(slot));
    const key = `${phase.key}:${slots.map((slot) => profile(lines[slot])).join('|')}`;
    const cached = repeatCache.get(key);
    if (cached !== undefined) return cached;
    const prefix = [...phase.fixed];
    const walk = (depth: number): number => {
      if (depth === slots.length) return 1;
      const slot = slots[depth];
      const denominators = new Map<string, number>();
      for (const row of compressed[slot])
        if (!prefix.some((fixed) => fixed.limitGroup === row.limitGroup))
          denominators.set(
            row.line.grade,
            (denominators.get(row.line.grade) ?? 0) + row.optionProbability,
          );
      let probability = 0;
      for (const row of identities[slot].get(lineIdentity(lines[slot])) ?? []) {
        if (prefix.some((fixed) => fixed.limitGroup === row.limitGroup)) continue;
        const denominator = denominators.get(row.line.grade) ?? 0;
        if (!(denominator > 0)) continue;
        prefix.push(row);
        probability +=
          ((row.gradeProbability * row.optionProbability) / denominator) * walk(depth + 1);
        prefix.pop();
      }
      return probability;
    };
    const probability = Math.min(1, walk(0));
    repeatCache.set(key, probability);
    return probability;
  };
  const outputs: UnpricedStrategy[] = [];
  const currentTypesNeedCirculation = allTypes(start) && !complete(start);
  if (currentTypesNeedCirculation) {
    const expectedCirculators = circulation(start, [0, 1, 2]);
    outputs.push({
      id: 'current-types-circulator',
      policy: { kind: 'current-types' },
      name: '지금 옵션 그대로, 수치만 완성',
      description:
        '이미 목표 세 종류가 모두 레전드리이므로 종류를 다시 뽑지 않고, 심연의 서큘레이터로 수치만 완성합니다.',
      expectedMeso: 0,
      expectedHonor: 0,
      expectedResets: 0,
      expectedCirculators,
      totalCost: 0,
      status: Number.isFinite(expectedCirculators) ? 'ready' : 'impossible',
      steps: [
        '현재 레전드리 목표 세 종류를 그대로 유지합니다.',
        '심연의 서큘레이터로 세 줄의 수치를 함께 다시 뽑습니다. 값이 하나뿐인 옵션은 그대로 유지됩니다.',
        '목표에 못 미치는 결과는 채택하지 않고 기존 세 줄을 보관합니다.',
        '세 줄 모두 목표 최대치인 결과를 채택합니다.',
      ],
    });
  }
  for (const timing of ['direct', 'lower', 'all'] as const) {
    // Once every type exists, the initial acceptance subset no longer matters.
    if (timing === 'all' && currentTypesNeedCirculation) continue;
    const phases = new Map<string, Phase>();
    const terminalCache = new Map<string, Cost>();
    let initialGroups: Map<number, Group[]> | undefined;
    const qualifies = (line: OptionLine) =>
      targetIndex(line) >= 0 && (timing !== 'direct' || isMax(line));
    const lowerLocks = (lines: OptionLine[], firstMask: number) => {
      const slots = [1, 2].filter((slot) => qualifies(lines[slot]));
      if (!slots.some((slot) => firstMask & (1 << targetIndex(lines[slot])))) return [];
      return slots;
    };
    const phaseFor = (lines: OptionLine[], locks: number[], firstMask = 7): Phase => {
      const key = `${timing}:${locks.length ? 7 : firstMask}:${locks.map((slot) => `${slot}:${profile(lines[slot])}`).join('|')}`;
      const cached = phases.get(key);
      if (cached) return cached;
      const phase: Phase = {
        key,
        locks,
        lines: [...lines],
        fixed: locks.map((slot) => candidateFor(lines[slot], slot)),
        firstMask: locks.length ? 7 : firstMask,
        means: new Map(),
      };
      phases.set(key, phase);
      return phase;
    };
    const finishFirst = (lines: OptionLine[]): Cost => {
      if (complete(lines)) return zero();
      const phase = phaseFor(lines, [1, 2]);
      return mean(phase, repeatProbability(phase, lines));
    };
    const circulateLower = (lines: OptionLine[]): Cost => {
      const key = lines.map(profile).join('|');
      const saved = terminalCache.get(key);
      if (saved) return saved;
      if ([1, 2].every((slot) => isMax(lines[slot]))) return finishFirst(lines);
      const result = zero();
      result.circulators = circulation(lines, [1, 2]);
      const fixed = [lines[0], bestLine(lines[1]), bestLine(lines[2])];
      const option = lineOption(lines[0])!;
      const total = option.values.reduce((sum, value) => sum + value.weight, 0);
      // A successful lower-max redraw cannot be the old tuple. Its first-line
      // value retains the unconditioned table distribution, including a free win.
      for (const value of option.values) {
        const first = { ...lines[0], value: value.value, text: value.label };
        add(result, finishFirst([first, fixed[1], fixed[2]]), value.weight / total);
      }
      terminalCache.set(key, result);
      return result;
    };
    const classify = (
      lines: OptionLine[],
      phase: Phase,
    ): { rank: number; future: () => Cost } | undefined => {
      if (complete(lines)) return { rank: 4, future: zero };
      if (timing === 'all' && allTypes(lines))
        return {
          rank: 3,
          future: () => ({ ...zero(), circulators: circulation(lines, [0, 1, 2]) }),
        };
      const locks = lowerLocks(lines, phase.firstMask);
      // A complete set of legendary types can proceed directly to its final stage.
      if (timing === 'lower' && allTypes(lines) && locks.length < 2)
        locks.splice(0, locks.length, 1, 2);
      if (locks.length <= phase.locks.filter((slot) => slot !== 0).length) return undefined;
      if (timing === 'lower' && locks.length === 2)
        return { rank: 2, future: () => circulateLower(lines) };
      return {
        rank: locks.length,
        future: () => {
          const next = phaseFor(lines, phase.locks.includes(0) ? [0, ...locks.slice(0, 1)] : locks);
          return mean(next, repeatProbability(next, lines));
        },
      };
    };
    function prepare(phase: Phase) {
      if (phase.groups) return;
      if (!phase.locks.length && initialGroups) {
        phase.groups = initialGroups.get(phase.firstMask)!;
        return;
      }
      const sharedInitial = !phase.locks.length;
      const masks = sharedInitial ? [1, 2, 3, 4, 5, 6, 7] : [phase.firstMask];
      const byMask = new Map(masks.map((mask) => [mask, new Map<number, Group>()]));
      const classificationPhase = sharedInitial ? { ...phase, firstMask: 7 } : phase;
      const slots = [0, 1, 2].filter((slot) => !phase.locks.includes(slot));
      const lines = [...phase.lines];
      const prefix = [...phase.fixed];
      const visit = (depth: number, probability: number) => {
        if (depth === slots.length) {
          const outcome = classify(lines, classificationPhase);
          if (!outcome) return;
          const accepted =
            outcome.rank >= 3 || (timing === 'lower' && allTypes(lines))
              ? 7
              : [1, 2].reduce(
                  (mask, slot) =>
                    qualifies(lines[slot]) ? mask | (1 << targetIndex(lines[slot])) : mask,
                  0,
                );
          const future = outcome.future();
          for (const [mask, groups] of byMask) {
            if (sharedInitial && !(mask & accepted)) continue;
            let group = groups.get(outcome.rank);
            if (!group)
              groups.set(outcome.rank, (group = { rank: outcome.rank, mass: 0, future: zero() }));
            group.mass += probability;
            add(group.future, future, probability);
          }
          return;
        }
        const slot = slots[depth];
        const needsLastGoal =
          depth === slots.length - 1 &&
          slot > 0 &&
          ![1, 2].some(
            (other) => other !== slot && !phase.locks.includes(other) && qualifies(lines[other]),
          );
        for (const row of eligible(slot, prefix)) {
          if (needsLastGoal && !qualifies(row.line)) continue;
          lines[slot] = row.line;
          prefix.push(row);
          visit(depth + 1, probability * row.probability);
          prefix.pop();
        }
      };
      visit(0, 1);
      const prepared = new Map(
        [...byMask].map(([mask, groups]) => [
          mask,
          [...groups.values()].sort((a, b) => a.rank - b.rank),
        ]),
      );
      if (sharedInitial) initialGroups = prepared;
      phase.groups = prepared.get(phase.firstMask)!;
    }
    function mean(phase: Phase, repeat: number): Cost {
      const saved = phase.means.get(repeat);
      if (saved) return saved;
      prepare(phase);
      const mass = phase.groups!.reduce((sum, group) => sum + group.mass, 0);
      const probability = repeat >= 1 ? 0 : Math.min(1, mass / (1 - repeat));
      const size = input.batchSize;
      const hazard = probability >= 1 ? 1 : -Math.expm1(size * Math.log1p(-probability));
      if (!(hazard > 0)) return impossible();
      const attempts = size / hazard;
      const price = data.ability.costs.find((cost) => cost.locked === phase.locks.length)!;
      const result: Cost = {
        resets: attempts,
        honor: attempts * price.honor,
        meso: attempts * Number(price.meso),
        circulators: 0,
      };
      let lower = Math.max(0, 1 - probability);
      for (const group of phase.groups!) {
        const p = Math.min(1, group.mass / (1 - repeat));
        const through = Math.min(1, lower + p);
        let factor = 0;
        for (let earlier = 0; earlier < size; earlier++)
          factor += lower ** earlier * through ** (size - 1 - earlier);
        const chance = (p * factor) / hazard;
        add(result, group.future, chance / group.mass);
        lower = through;
      }
      phase.means.set(repeat, result);
      return result;
    }
    for (const mask of [7, 6, 4, 3, 5, 1, 2]) {
      let expected: Cost;
      if (complete(start)) expected = zero();
      else {
        const initial = phaseFor(start, [], mask);
        const progress = classify(start, initial);
        expected = progress ? progress.future() : mean(initial, repeatProbability(initial, start));
      }
      const accepted = targets.filter((_, index) => mask & (1 << index));
      const firstOptions = accepted
        .map((target) => abilityKindLabel(target.option.label))
        .join(' 또는 ');
      const name =
        timing === 'direct'
          ? '재설정만으로 세 줄 완성'
          : timing === 'lower'
            ? '아랫줄 두 줄부터 서큘레이터로 완성'
            : '세 종류를 갖춘 뒤 서큘레이터로 완성';
      const description =
        timing === 'direct'
          ? '고급 재설정으로 둘째·셋째 줄을 목표 최대치로 하나씩 잠근 뒤, 첫 줄을 완성합니다.'
          : timing === 'lower'
            ? '레전드리 아랫줄 두 종류를 확보하고 서큘레이터로 수치를 맞춘 뒤, 두 줄을 잠그고 첫 줄을 완성합니다.'
            : '레전드리 목표 세 종류를 먼저 갖춘 뒤, 심연의 서큘레이터로 세 줄의 수치를 함께 완성합니다.';
      const totalCost =
        expected.meso +
        (expected.honor / 5000) * input.medalPrice +
        expected.circulators * input.circulatorPrice;
      const status = complete(start)
        ? 'already'
        : Number.isFinite(totalCost)
          ? 'ready'
          : 'impossible';
      outputs.push({
        id: `${timing}-${mask}`,
        policy: {
          kind: 'acquire',
          timing,
          firstAcceptedTargets: accepted.map((target) => target.type),
        },
        name,
        description,
        expectedMeso: expected.meso,
        expectedHonor: expected.honor,
        expectedResets: expected.resets,
        expectedCirculators: expected.circulators,
        totalCost,
        status,
        steps: [
          `둘째·셋째 줄에서 ${accepted.length === 3 ? '목표 옵션 중 무엇이든' : `${firstOptions}${accepted.length === 1 ? ' 옵션을' : ' 중 하나를'}`} ${timing === 'direct' ? '레전드리 최대치로 확보하고' : '레전드리로 확보하면 수치와 무관하게'} 잠급니다.`,
          `잠근 줄을 유지하면서 다른 목표 아랫줄도 ${timing === 'direct' ? '레전드리 최대치로' : '레전드리로'} 확보합니다. 한 결과에 목표 아랫줄 두 개가 있으면 함께 확보할 수 있습니다.`,
          ...(timing === 'lower'
            ? [
                '필요하면 심연의 서큘레이터로 세 줄 수치를 함께 다시 뽑아, 두 아랫줄이 모두 최대치인 결과를 채택합니다.',
                '완성된 아랫줄 두 개를 잠그고 고급 재설정으로 남은 첫 줄을 목표 최대치로 맞춥니다.',
              ]
            : timing === 'all'
              ? [
                  '아랫줄 두 개를 잠그고 고급 재설정으로 첫 줄에 남은 목표 종류를 확보합니다. 이때도 수치는 무관합니다.',
                  '필요하면 심연의 서큘레이터로 세 줄 수치를 함께 다시 뽑아, 세 줄 모두 최대치인 결과를 채택합니다.',
                ]
              : [
                  '완성된 아랫줄 두 개를 잠그고 고급 재설정으로 남은 첫 줄을 목표 최대치로 맞춥니다.',
                ]),
        ],
      });
    }
    if (timing === 'direct' && isMax(start[0])) {
      const locks = [0, ...lowerLocks(start, 7).slice(0, 1)];
      const phase = phaseFor(start, locks);
      const expected = complete(start) ? zero() : mean(phase, repeatProbability(phase, start));
      outputs.push({
        id: 'keep-first-max',
        policy: { kind: 'keep-first', targetType: targets[targetIndex(start[0])].type },
        name: '완성된 첫 줄을 잠그고 나머지 완성',
        description: `현재 첫 줄의 '${targets[targetIndex(start[0])].best.label}' 옵션을 잠그고, 고급 재설정으로 나머지 아랫줄을 목표 최대치로 완성합니다.`,
        expectedMeso: expected.meso,
        expectedHonor: expected.honor,
        expectedResets: expected.resets,
        expectedCirculators: expected.circulators,
        totalCost: 0,
        status: complete(start) ? 'already' : 'ready',
        steps: [
          `이미 완성된 첫 줄의 '${targets[targetIndex(start[0])].best.label}' 옵션을 잠급니다.`,
          '목표 아랫줄 하나를 최대치로 확보해 함께 잠급니다. 이미 완성된 목표 아랫줄이 있다면 그대로 잠급니다.',
          '고급 재설정으로 남은 아랫줄을 목표 최대치로 완성합니다.',
        ],
      });
    }
  }
  let cache = calculationCache.get(data);
  if (!cache) calculationCache.set(data, (cache = new Map()));
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, outputs);
  return pricedResult(outputs, input);
}
