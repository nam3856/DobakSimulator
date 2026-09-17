import type { Goal, Grade, OptionLine, SimulationState, TargetCondition } from '../types';
import { gradeRank, lineIdentity } from './rules';

export type TargetState = Pick<SimulationState, 'grade' | 'lines' | 'stage'>;

export function conditionMatchesLine(
  condition: TargetCondition,
  line: OptionLine,
  index: number,
): boolean {
  if (condition.slot !== undefined && condition.slot !== index) return false;
  if (condition.slots !== undefined && !condition.slots.includes(index)) return false;
  if (condition.minGrade && gradeRank(line.grade) < gradeRank(condition.minGrade)) return false;
  const identityMatches =
    line.type === condition.type ||
    line.abilityTypeId === condition.type ||
    line.id === condition.type;
  return (
    identityMatches &&
    line.value >= condition.minValue &&
    (condition.maxValue === undefined || line.value <= condition.maxValue)
  );
}

export function metricValue(lines: readonly OptionLine[], type: string): number {
  if (type === 'ignoreDefensePercent')
    return (
      (1 - lines.filter((l) => l.type === type).reduce((p, l) => p * (1 - l.value / 100), 1)) * 100
    );
  if (['strPercent', 'dexPercent', 'intPercent', 'lukPercent'].includes(type)) {
    return lines.reduce(
      (sum, line) => sum + (line.type === type || line.type === 'allStatPercent' ? line.value : 0),
      0,
    );
  }
  return lines.reduce((sum, line) => sum + (line.type === type ? line.value : 0), 0);
}

export function matchTarget(target: Goal, state: TargetState): boolean {
  if (target.mode === 'stage') return state.stage >= target.stage;
  if (gradeRank(state.grade) < gradeRank(target.minimumGrade)) return false;
  if (target.mode === 'grade') return true;
  if (target.mode === 'exact') {
    if (target.lines.length !== 3 || state.lines.length !== 3) return false;
    const wanted = target.lines.map(lineIdentity).sort();
    const actual = state.lines.map(lineIdentity).sort();
    return wanted.every((line, index) => line === actual[index]);
  }
  if (!target.conditions.length) return false;
  if (target.mode === 'ability' && target.match === 'all') {
    const requirements = target.conditions.flatMap((condition) =>
      Array.from({ length: condition.count ?? 1 }, () => condition),
    );
    function assign(index: number, used: number[]): boolean {
      if (index === requirements.length) return true;
      return state.lines.some(
        (line, slot) =>
          !used.includes(slot) &&
          conditionMatchesLine(requirements[index], line, slot) &&
          assign(index + 1, [...used, slot]),
      );
    }
    return assign(0, []);
  }
  const matched = target.conditions.map((condition) => {
    if (
      target.mode === 'ability' ||
      condition.count !== undefined ||
      condition.slot !== undefined ||
      condition.slots !== undefined ||
      condition.minGrade !== undefined
    ) {
      return (
        state.lines.filter((line, index) => conditionMatchesLine(condition, line, index)).length >=
        (condition.count ?? 1)
      );
    }
    const total = metricValue(state.lines, condition.type);
    return (
      total + 1e-10 >= condition.minValue &&
      (condition.maxValue === undefined || total <= condition.maxValue + 1e-10)
    );
  });
  return target.match === 'any' ? matched.some(Boolean) : matched.every(Boolean);
}

export function matchesLines(target: Goal, grade: Grade, lines: OptionLine[], stage = 0): boolean {
  return matchTarget(target, { grade, lines, stage });
}
