import type { OptionLine, SimulationConfig } from '../types';
import { abilityKindLabel } from './ability-labels';
import type {
  AbilityOptimizerInput,
  AbilityOptimizerStrategyResult,
  AbilityOptimizerTarget,
} from './ability-optimizer';
import {
  allCandidates,
  eligibleCandidates,
  gradeRank,
  lineIdentity,
  normalizeText,
  resolveOptionLine,
  tupleIdentity,
  type AbilityOption,
  type Candidate,
  type RuleData,
} from './rules';

type Unpriced = Omit<
  AbilityOptimizerStrategyResult,
  'estimatedAdditionalHonor' | 'estimatedHonorPurchaseCost'
>;
type Timing = 'direct' | 'lower' | 'all';
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
  fixed: Candidate[];
  lines: OptionLine[];
  firstMask: number;
  groups?: Group[];
  means: Map<string, Cost>;
}
const zero = (): Cost => ({ resets: 0, honor: 0, meso: 0, circulators: 0 });
const impossible = (): Cost => ({
  resets: Infinity,
  honor: Infinity,
  meso: Infinity,
  circulators: Infinity,
});
const add = (to: Cost, value: Cost, weight = 1) => {
  if (!(weight > 0)) return;
  for (const key of ['resets', 'honor', 'meso', 'circulators'] as const)
    to[key] += value[key] * weight;
};

/** Exact expectations for explicit monotone-lock policies with one to three minimum-grade goals. */
export function calculateAbilityTargetStrategies(
  data: RuleData,
  input: AbilityOptimizerInput,
  requested: AbilityOptimizerTarget[],
): Unpriced[] {
  const goals = requested.map((goal) => {
    const option = data.ability.grades[goal.grade]?.options.find(
      (row) => (row.type ?? row.id) === goal.type,
    );
    if (!option?.values.length)
      throw new Error(
        `${goal.grade === 'unique' ? '유니크' : '레전드리'} 목표 '${goal.type}'의 확률 자료가 없습니다.`,
      );
    const best = option.values.reduce((a, b) =>
      (option.valueDirection === 'lower' ? b.value < a.value : b.value > a.value) ? b : a,
    );
    return { ...goal, option, best };
  });
  const count = goals.length;
  const fullMask = (1 << count) - 1;
  const masks = Array.from({ length: fullMask }, (_, i) => i + 1);
  const config = {
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
  } as SimulationConfig;
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
  for (const [grade, table] of Object.entries(data.ability.grades))
    for (const option of table.options) {
      options.set(`${grade}:${option.id}`, option);
      options.set(`${grade}:${option.type ?? option.id}`, option);
    }
  const lineOption = (line: OptionLine) =>
    options.get(`${line.grade}:${line.abilityTypeId ?? line.type}`) ??
    options.get(`${line.grade}:${line.type}`);
  const indexCache = new WeakMap<OptionLine, number>();
  const matchesCache = new WeakMap<OptionLine, boolean>();
  const valueChanceCache = new WeakMap<OptionLine, number>();
  const goalChanceCache = new WeakMap<OptionLine, number>();
  const identicalGoalChanceCache = new WeakMap<OptionLine, number>();
  const goalIndex = (line: OptionLine) => {
    const saved = indexCache.get(line);
    if (saved !== undefined) return saved;
    const index = goals.findIndex(
      (goal) => goal.type === line.type || goal.option.id === line.abilityTypeId,
    );
    indexCache.set(line, index);
    return index;
  };
  const meetsValue = (index: number, value: number) =>
    goals[index].option.valueDirection === 'lower'
      ? value <= goals[index].best.value
      : value >= goals[index].best.value;
  const matches = (line: OptionLine) => {
    const saved = matchesCache.get(line);
    if (saved !== undefined) return saved;
    const index = goalIndex(line);
    const result =
      index >= 0 &&
      gradeRank(line.grade) >= gradeRank(goals[index].grade) &&
      meetsValue(index, line.value);
    matchesCache.set(line, result);
    return result;
  };
  const valueChance = (line: OptionLine) => {
    const saved = valueChanceCache.get(line);
    if (saved !== undefined) return saved;
    const option = lineOption(line);
    if (!option) return 0;
    const total = option.values.reduce((sum, value) => sum + value.weight, 0);
    const visible = option.values.filter(
      (value) => normalizeText(value.label) === lineIdentity(line),
    );
    const values = visible.length
      ? visible
      : option.values.filter((value) => value.value === line.value);
    const result = values.reduce((sum, value) => sum + value.weight, 0) / total;
    valueChanceCache.set(line, result);
    return result;
  };
  const goalChance = (line: OptionLine, identicalOnly = false) => {
    const cache = identicalOnly ? identicalGoalChanceCache : goalChanceCache;
    const saved = cache.get(line);
    if (saved !== undefined) return saved;
    const index = goalIndex(line);
    if (index < 0) {
      cache.set(line, 0);
      return 0;
    }
    const option = lineOption(line);
    if (!option || gradeRank(line.grade) < gradeRank(goals[index].grade)) {
      cache.set(line, 0);
      return 0;
    }
    const total = option.values.reduce((sum, value) => sum + value.weight, 0);
    const result =
      option.values.reduce(
        (sum, value) =>
          sum +
          (meetsValue(index, value.value) &&
          (!identicalOnly || normalizeText(value.label) === lineIdentity(line))
            ? value.weight
            : 0),
        0,
      ) / total;
    cache.set(line, result);
    return result;
  };
  const supports = (line: OptionLine) => goalChance(line) > 0;
  const covered = (lines: OptionLine[], predicate: (line: OptionLine) => boolean) =>
    lines.reduce((mask, line) => (predicate(line) ? mask | (1 << goalIndex(line)) : mask), 0);
  const complete = (lines: OptionLine[]) => covered(lines, matches) === fullMask;
  const allTypes = (lines: OptionLine[]) => covered(lines, supports) === fullMask;
  const profiles = new WeakMap<OptionLine, string>();
  const canonicalProfiles = new Map<string, string>();
  const interned = new Map<string, string>();
  const profile = (line: OptionLine): string => {
    const saved = profiles.get(line);
    if (saved !== undefined) return saved;
    const key = `${line.grade}:${line.type}:${line.value}:${lineIdentity(line)}`;
    const canonical = canonicalProfiles.get(key);
    if (canonical !== undefined) {
      profiles.set(line, canonical);
      return canonical;
    }
    const signature = JSON.stringify([
      line.grade,
      goalIndex(line),
      matches(line),
      goalChance(line),
      valueChance(line),
      identities.map((map) =>
        (map.get(lineIdentity(line)) ?? []).map((row) => [
          row.limitGroup,
          row.line.grade,
          row.optionProbability,
          row.gradeProbability,
          matches(row.line),
          goalChance(row.line),
        ]),
      ),
    ]);
    let id = interned.get(signature);
    if (id === undefined) interned.set(signature, (id = String(interned.size)));
    profiles.set(line, id);
    canonicalProfiles.set(key, id);
    return id;
  };
  const compressed = raw.map((rows) => {
    const groups = new Map<string, Candidate>();
    for (const row of rows) {
      const key = profile(row.line),
        existing = groups.get(key);
      if (existing) {
        existing.optionProbability += row.optionProbability;
        existing.probability += row.probability;
      } else groups.set(key, { ...row });
    }
    return [...groups.values()];
  });
  const eligibleCache = new Map<string, Candidate[]>();
  const denominatorCache = new Map<string, Map<string, number>>();
  const exclusionKey = (slot: number, prefix: Candidate[]) =>
    `${slot}:${prefix
      .map((row) => row.limitGroup)
      .sort()
      .join(',')}`;
  const denominatorsFor = (slot: number, prefix: Candidate[]) => {
    const key = exclusionKey(slot, prefix);
    let totals = denominatorCache.get(key);
    if (!totals) {
      totals = new Map<string, number>();
      for (const row of compressed[slot])
        if (!prefix.some((fixed) => fixed.limitGroup === row.limitGroup))
          totals.set(row.line.grade, (totals.get(row.line.grade) ?? 0) + row.optionProbability);
      denominatorCache.set(key, totals);
    }
    return totals;
  };
  const eligible = (slot: number, prefix: Candidate[]) => {
    const key = exclusionKey(slot, prefix);
    let rows = eligibleCache.get(key);
    if (!rows) {
      rows = eligibleCandidates(compressed[slot], prefix);
      eligibleCache.set(key, rows);
    }
    return rows;
  };
  const candidateFor = (line: OptionLine, slot: number) => {
    const rows = identities[slot].get(lineIdentity(line)) ?? [];
    const candidate = rows.find((row) => row.line.grade === line.grade) ?? rows[0];
    if (!candidate)
      throw new Error(
        `현재 ${slot + 1}번째 옵션을 공식 확률에서 찾을 수 없습니다. 시작 옵션을 확인해 주세요.`,
      );
    return candidate;
  };
  start.forEach(candidateFor);
  const circulation = (lines: OptionLine[], slots: number[]) => {
    if (slots.every((slot) => matches(lines[slot]))) return { expected: 0, success: 1 };
    const success = slots.reduce((p, slot) => p * goalChance(lines[slot]), 1);
    const repeat = lines.reduce((p, line) => p * valueChance(line), 1);
    const repeatedSuccess = lines.reduce(
      (p, line, slot) => p * (slots.includes(slot) ? goalChance(line, true) : valueChance(line)),
      1,
    );
    const allowedSuccess = Math.max(0, success - repeatedSuccess);
    return {
      expected: allowedSuccess > 0 ? (1 - repeat) / allowedSuccess : Infinity,
      success: allowedSuccess,
    };
  };
  const goalSlots = (lines: OptionLine[]) => [0, 1, 2].filter((slot) => supports(lines[slot]));
  const rows: Unpriced[] = [];
  const currentTypes = allTypes(start) && !complete(start);
  if (currentTypes) {
    const expected = circulation(start, goalSlots(start)).expected;
    rows.push({
      id: 'current-types-circulator',
      policy: { kind: 'current-types' },
      name: '지금 옵션 그대로, 수치만 완성',
      description: `이미 목표 ${count}종류를 필요한 등급 이상으로 갖췄으므로 심연의 서큘레이터로 목표 수치를 맞춥니다.`,
      expectedMeso: 0,
      expectedHonor: 0,
      expectedResets: 0,
      expectedCirculators: expected,
      totalCost: 0,
      status: Number.isFinite(expected) ? 'ready' : 'impossible',
      steps: [
        `현재 목표 옵션 ${goals.map((goal) => abilityKindLabel(goal.option.label)).join(' / ')}의 등급과 종류를 유지합니다.`,
        '심연의 서큘레이터는 목표와 무관한 줄까지 세 줄의 수치를 함께 다시 뽑습니다. 값이 하나뿐인 옵션은 그대로 유지됩니다.',
        '모든 선택 목표의 등급과 수치 조건을 만족한 결과를 채택하고, 나머지 줄은 따로 맞추지 않습니다.',
      ],
    });
  }
  for (const timing of (count === 3 ? ['direct', 'lower', 'all'] : ['direct', 'all']) as Timing[]) {
    if (timing === 'all' && currentTypes) continue;
    const lockSlots = timing === 'lower' ? [1, 2] : [0, 1, 2];
    const qualifies = timing === 'direct' ? matches : supports;
    const qualifyingCache = new Map<string, Candidate[]>();
    const qualifying = (slot: number, prefix: Candidate[]) => {
      const key = exclusionKey(slot, prefix);
      let result = qualifyingCache.get(key);
      if (!result) {
        result = eligible(slot, prefix).filter((row) => qualifies(row.line));
        qualifyingCache.set(key, result);
      }
      return result;
    };
    const phases = new Map<string, Phase>();
    const terminalCache = new Map<string, Cost>();
    const repeats = new Map<string, { repeat: number; removesProgress: boolean }>();
    let initialGroups: Map<number, Group[]> | undefined;
    const phaseFor = (lines: OptionLine[], locks: number[], firstMask = fullMask): Phase => {
      const key = `${locks.length ? fullMask : firstMask}:${locks.map((slot) => `${slot}:${profile(lines[slot])}`).join('|')}`;
      const saved = phases.get(key);
      if (saved) return saved;
      const phase = {
        key,
        locks,
        lines: [...lines],
        fixed: locks.map((slot) => candidateFor(lines[slot], slot)),
        firstMask: locks.length ? fullMask : firstMask,
        means: new Map<string, Cost>(),
      };
      phases.set(key, phase);
      return phase;
    };
    const finishFirst = (lines: OptionLine[]) =>
      complete(lines) ? zero() : mean(phaseFor(lines, [1, 2]), lines);
    const circulateLower = (lines: OptionLine[]): Cost => {
      if ([1, 2].every((slot) => matches(lines[slot]))) return finishFirst(lines);
      const key = lines.map(profile).join('|');
      const saved = terminalCache.get(key);
      if (saved) return saved;
      const stats = circulation(lines, [1, 2]);
      if (!(stats.success > 0) || !Number.isFinite(stats.expected)) return impossible();
      const result = { ...zero(), circulators: stats.expected };
      const next = [...lines];
      const old = tupleIdentity(lines);
      const visit = (slot: number, probability: number) => {
        if (slot === 3) {
          if (tupleIdentity(next) !== old && [1, 2].every((i) => matches(next[i])))
            add(result, finishFirst(next), probability / stats.success);
          return;
        }
        const option = lineOption(lines[slot])!;
        const total = option.values.reduce((sum, value) => sum + value.weight, 0);
        for (const value of option.values) {
          next[slot] = {
            ...lines[slot],
            value: value.value,
            text: value.label,
            id: `${option.id}:${lines[slot].grade}:${value.value}:${value.secondaryValue ?? ''}`,
          };
          visit(slot + 1, (probability * value.weight) / total);
        }
      };
      visit(0, 1);
      terminalCache.set(key, result);
      return result;
    };
    const classify = (
      lines: OptionLine[],
      phase: Phase,
    ): { rank: number; future: () => Cost } | undefined => {
      if (complete(lines)) return { rank: count + 2, future: zero };
      if (timing === 'all' && allTypes(lines))
        return {
          rank: count + 1,
          future: () => ({ ...zero(), circulators: circulation(lines, goalSlots(lines)).expected }),
        };
      let locks = lockSlots.filter((slot) => qualifies(lines[slot]));
      if (!locks.some((slot) => phase.firstMask & (1 << goalIndex(lines[slot])))) locks = [];
      if (timing === 'lower' && allTypes(lines)) locks = [1, 2];
      if (locks.length <= phase.locks.length) return;
      if (timing === 'lower' && locks.length === 2)
        return { rank: count, future: () => circulateLower(lines) };
      return { rank: locks.length, future: () => mean(phaseFor(lines, locks), lines) };
    };
    const repeatInfo = (phase: Phase, baseline: OptionLine[]) => {
      const slots = [0, 1, 2].filter((slot) => !phase.locks.includes(slot));
      const key = `${phase.key}:${slots.map((slot) => profile(baseline[slot])).join('|')}`;
      const saved = repeats.get(key);
      if (saved) return saved;
      const lines = [...baseline],
        prefix = [...phase.fixed];
      let repeat = 0,
        removesProgress = false;
      const visit = (depth: number, probability: number) => {
        if (depth === slots.length) {
          repeat += probability;
          if (classify(lines, phase)) removesProgress = true;
          return;
        }
        const slot = slots[depth];
        const denominators = denominatorsFor(slot, prefix);
        for (const row of identities[slot].get(lineIdentity(baseline[slot])) ?? []) {
          if (prefix.some((fixed) => fixed.limitGroup === row.limitGroup)) continue;
          const denominator = denominators.get(row.line.grade) ?? 0;
          if (!(denominator > 0)) continue;
          lines[slot] = row.line;
          prefix.push(row);
          visit(
            depth + 1,
            (probability * row.gradeProbability * row.optionProbability) / denominator,
          );
          prefix.pop();
        }
      };
      visit(0, 1);
      const result = { repeat: Math.min(1, repeat), removesProgress };
      repeats.set(key, result);
      return result;
    };
    function collectGroups(phase: Phase, excluded?: string, shareInitial = false) {
      const byMask = new Map(
        (shareInitial ? masks : [phase.firstMask]).map((mask) => [mask, new Map<number, Group>()]),
      );
      const classificationPhase = shareInitial ? { ...phase, firstMask: fullMask } : phase;
      const slots = [0, 1, 2].filter((slot) => !phase.locks.includes(slot));
      const lines = [...phase.lines],
        prefix = [...phase.fixed];
      const visit = (depth: number, probability: number) => {
        if (depth === slots.length) {
          if (excluded !== undefined && tupleIdentity(lines) === excluded) return;
          const outcome = classify(lines, classificationPhase);
          if (!outcome) return;
          const accepted =
            outcome.rank >= count + 1 || (timing === 'lower' && allTypes(lines))
              ? fullMask
              : lockSlots.reduce(
                  (mask, slot) =>
                    qualifies(lines[slot]) ? mask | (1 << goalIndex(lines[slot])) : mask,
                  0,
                );
          const future = outcome.future();
          for (const [mask, groups] of byMask) {
            if (shareInitial && !(mask & accepted)) continue;
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
          !slots.slice(0, depth).some((other) => qualifies(lines[other]));
        // Unusual tables can share visible text across grades. Raw enumeration then removes
        // every identical visible result from both progress mass and repeat probability.
        const candidates =
          excluded === undefined
            ? needsLastGoal
              ? qualifying(slot, prefix)
              : eligible(slot, prefix)
            : eligibleCandidates(raw[slot], prefix);
        for (const row of candidates) {
          if (needsLastGoal && !qualifies(row.line)) continue;
          lines[slot] = row.line;
          prefix.push(row);
          visit(depth + 1, probability * row.probability);
          prefix.pop();
        }
      };
      visit(0, 1);
      return new Map(
        [...byMask].map(([mask, groups]) => [
          mask,
          [...groups.values()].sort((a, b) => a.rank - b.rank),
        ]),
      );
    }
    function mean(phase: Phase, baseline: OptionLine[]): Cost {
      const info = repeatInfo(phase, baseline);
      const key = info.removesProgress ? `visible:${tupleIdentity(baseline)}` : String(info.repeat);
      const saved = phase.means.get(key);
      if (saved) return saved;
      let groups: Group[];
      if (info.removesProgress)
        groups = collectGroups(phase, tupleIdentity(baseline)).get(phase.firstMask)!;
      else {
        if (!phase.groups) {
          if (!phase.locks.length) {
            initialGroups ??= collectGroups(phase, undefined, true);
            phase.groups = initialGroups.get(phase.firstMask)!;
          } else phase.groups = collectGroups(phase).get(phase.firstMask)!;
        }
        groups = phase.groups;
      }
      const mass = groups.reduce((sum, group) => sum + group.mass, 0);
      const p = info.repeat >= 1 ? 0 : Math.min(1, mass / (1 - info.repeat));
      const size = input.batchSize;
      const hazard = p >= 1 ? 1 : -Math.expm1(size * Math.log1p(-p));
      if (!(hazard > 0)) return impossible();
      const attempts = size / hazard;
      const price = data.ability.costs.find((row) => row.locked === phase.locks.length)!;
      const result = {
        resets: attempts,
        honor: attempts * price.honor,
        meso: attempts * Number(price.meso),
        circulators: 0,
      };
      let lower = Math.max(0, 1 - p);
      for (const group of groups) {
        const groupProbability = Math.min(1, group.mass / (1 - info.repeat));
        const through = Math.min(1, lower + groupProbability);
        let factor = 0;
        for (let earlier = 0; earlier < size; earlier++)
          factor += lower ** earlier * through ** (size - 1 - earlier);
        const chance = (groupProbability * factor) / hazard;
        add(result, group.future, chance / group.mass);
        lower = through;
      }
      phase.means.set(key, result);
      return result;
    }
    const resultRow = (
      id: string,
      expected: Cost,
      policy: Unpriced['policy'],
      name: string,
      description: string,
      steps: string[],
    ): Unpriced => ({
      id,
      policy,
      name,
      description,
      steps,
      expectedResets: expected.resets,
      expectedHonor: expected.honor,
      expectedMeso: expected.meso,
      expectedCirculators: expected.circulators,
      totalCost: 0,
      status: complete(start)
        ? 'already'
        : Number.isFinite(expected.resets) && Number.isFinite(expected.circulators)
          ? 'ready'
          : 'impossible',
    });
    for (const mask of masks) {
      const phase = phaseFor(start, [], mask);
      const progress = classify(start, phase);
      const expected = complete(start) ? zero() : progress ? progress.future() : mean(phase, start);
      const accepted = goals.filter((_, i) => mask & (1 << i));
      const first = accepted
        .map(
          (goal) =>
            `${abilityKindLabel(goal.option.label)} (${goal.grade === 'unique' ? '유니크' : '레전드리'} 이상)`,
        )
        .join(' / ');
      rows.push(
        resultRow(
          `${timing}-${mask}`,
          expected,
          {
            kind: 'acquire',
            timing,
            firstAcceptedTargets: accepted.map((goal) => goal.type),
            lockSlots: lockSlots as Array<0 | 1 | 2>,
          },
          timing === 'direct'
            ? `재설정만으로 목표 ${count}개 완성`
            : timing === 'lower'
              ? '아랫줄 두 줄부터 서큘레이터로 완성'
              : `목표 ${count}종류를 갖춘 뒤 서큘레이터로 완성`,
          timing === 'direct'
            ? '어느 줄이든 선택 목표의 등급과 수치를 만족하면 잠그고, 고급 재설정으로 나머지 목표를 완성합니다.'
            : timing === 'lower'
              ? '요구 등급 이상의 목표 아랫줄 두 종류를 확보해 수치를 완성한 뒤, 두 줄을 잠그고 남은 첫 줄 목표를 맞춥니다.'
              : `선택한 목표 ${count}종류를 요구 등급 이상으로 갖춘 뒤 심연의 서큘레이터로 목표 수치를 맞춥니다.`,
          [
            `${timing === 'lower' ? '둘째·셋째 줄' : '어느 줄이든'}에서 ${first}${accepted.length > 1 ? ' 중 하나를' : ' 옵션을'} ${timing === 'direct' ? '목표 수치를 충족하도록' : '서큘레이터로 목표 수치를 얻을 수 있는 등급으로'} 확보하면 잠급니다.`,
            ...(count > 1
              ? [
                  '잠근 목표를 유지하면서 나머지 선택 목표를 확보합니다. 선택하지 않은 종류의 줄은 완성 조건에 포함하지 않습니다.',
                ]
              : []),
            ...(timing === 'lower'
              ? [
                  '필요하면 세 줄의 수치를 함께 다시 뽑는 심연의 서큘레이터로 두 아랫줄이 목표 수치를 충족하도록 맞춥니다.',
                  '완성된 두 아랫줄을 잠그고 고급 재설정으로 첫 줄의 남은 목표를 완성합니다.',
                ]
              : timing === 'all'
                ? [
                    '필요하면 심연의 서큘레이터로 세 줄 수치를 함께 다시 뽑아, 선택한 목표들의 수치 조건을 모두 만족하는 결과를 채택합니다.',
                  ]
                : []),
          ],
        ),
      );
    }
    if (timing === 'direct' && matches(start[0])) {
      const locks = [0, ...[1, 2].filter((slot) => matches(start[slot])).slice(0, 1)];
      const expected = complete(start) ? zero() : mean(phaseFor(start, locks), start);
      rows.push(
        resultRow(
          'keep-first-max',
          expected,
          { kind: 'keep-first', targetType: goals[goalIndex(start[0])].type },
          '완성된 첫 줄을 잠그고 나머지 완성',
          `현재 첫 줄의 '${start[0].text}' 옵션이 목표를 만족하므로 잠그고 나머지 선택 목표를 완성합니다.`,
          [
            '목표를 만족한 첫 줄을 잠급니다.',
            '이미 만족한 목표 아랫줄도 함께 잠그고, 고급 재설정으로 남은 선택 목표의 등급과 수치 조건을 맞춥니다.',
          ],
        ),
      );
    }
  }
  return rows;
}
