import type { SimulationConfig, TargetCondition } from '../types';
import {
  GRADES,
  canAppend,
  gradeRank,
  guaranteedAfterFailures,
  isPrime,
  lineIdentity,
  potentialRules,
  type Candidate,
  type RuleData,
} from '../engine/rules';
import { prepareDraw } from '../engine/simulation';
import { conditionMatchesLine, metricValue } from '../engine/target';

export interface PotentialConditionBounds {
  min: number;
  max: number;
}

const cache = new WeakMap<RuleData, Map<string, PotentialConditionBounds | undefined>>();
const rounded = (value: number) => Number(value.toFixed(10));

/**
 * Independent numeric bounds for a potential condition, not a joint goal probability.
 * The minimum is one attainable line's smallest positive contribution; zero would
 * turn an "at least" condition into an unconditional success. The maximum considers
 * all three lines, grade mixtures, duplicate restrictions, and the prime anchor.
 */
export function getPotentialConditionBounds(
  data: RuleData,
  config: SimulationConfig,
  condition: TargetCondition,
): PotentialConditionBounds | undefined {
  if (!['cube', 'soulPotential'].includes(config.mode) || config.target.mode !== 'sum')
    return undefined;
  const prime = isPrime(config);
  const key = JSON.stringify([
    config.mode,
    config.cubeType,
    config.category,
    config.level,
    config.start.grade,
    config.start.stage,
    config.target.minimumGrade,
    prime ? config.start.lines[0]?.grade : undefined,
    prime && config.start.lines[0] ? lineIdentity(config.start.lines[0]) : undefined,
    condition.type,
    condition.slot,
    condition.slots,
    condition.count,
    condition.minGrade,
  ]);
  let entries = cache.get(data);
  if (!entries) {
    entries = new Map();
    cache.set(data, entries);
  }
  if (entries.has(key)) return entries.get(key);
  let bounds: PotentialConditionBounds | undefined;
  try {
    bounds = calculate(data, config, condition);
  } catch {
    // Missing pools or an invalid prime anchor remain visible as setup errors.
    bounds = undefined;
  }
  if (entries.size >= 256) entries.delete(entries.keys().next().value!);
  entries.set(key, bounds);
  return bounds;
}

function calculate(
  data: RuleData,
  config: SimulationConfig,
  condition: TargetCondition,
): PotentialConditionBounds | undefined {
  const rules = potentialRules(data, config);
  const prime = isPrime(config);
  if (prime && config.start.grade !== 'legendary') return undefined;
  const aggregate =
    condition.count === undefined &&
    condition.slot === undefined &&
    condition.slots === undefined &&
    condition.minGrade === undefined;
  const unconstrained = { ...condition, minValue: -Infinity, maxValue: undefined };
  const contribution = (candidate: Candidate, slot: number) =>
    aggregate
      ? metricValue([candidate.line], condition.type)
      : conditionMatchesLine(unconstrained, candidate.line, slot)
        ? candidate.line.value
        : 0;
  let minimum = Infinity;
  let maximum = 0;

  for (const grade of GRADES.slice(GRADES.indexOf(config.start.grade))) {
    const rule = rules.grades.find((entry) => entry.grade === grade);
    if (!rule) break;
    if (gradeRank(grade) >= gradeRank(config.target.minimumGrade)) {
      const prepared = prepareDraw(data, config, grade, config.start.lines);
      const restrictedGroups = new Set(
        prepared.candidates
          .flat()
          .filter((row) => row.maxLines < 3)
          .map((row) => row.limitGroup),
      );
      // Unrestricted unrelated options are equivalent for this numeric condition.
      // Restricted groups keep their identity so, for example, boss/IED caps survive.
      const compressed = prepared.candidates.map((rows, slot) => {
        const classes = new Map<string, Candidate>();
        for (const row of rows) {
          const group = restrictedGroups.has(row.limitGroup) ? row.limitGroup : '';
          const classKey = JSON.stringify([group, row.maxLines, contribution(row, slot)]);
          if (!classes.has(classKey)) classes.set(classKey, row);
        }
        return [...classes.values()];
      });
      const prefix = [...prepared.fixed.values()];
      const chosen = new Map(prepared.fixed);
      const slots = [0, 1, 2].filter((slot) => !prepared.fixed.has(slot));

      function visit(depth: number) {
        if (depth === slots.length) {
          const selected = [0, 1, 2].map((slot) => chosen.get(slot)!);
          const values = selected.map(contribution).filter((value) => value > 0);
          if (!values.length) return;
          const total = aggregate
            ? metricValue(
                selected.map((candidate) => candidate.line),
                condition.type,
              )
            : values.sort((a, b) => b - a)[(condition.count ?? 1) - 1];
          if (total === undefined || !(total > 0)) return;
          minimum = Math.min(minimum, ...values);
          maximum = Math.max(maximum, total);
          return;
        }
        const slot = slots[depth];
        // The engine selects a grade before excluding types. A prefix that empties
        // an entire positive-probability grade cannot produce a valid draw.
        const availableGrades = new Set(
          prepared.candidates[slot]
            .filter((row) => canAppend(prefix, row))
            .map((row) => row.line.grade),
        );
        if (prepared.candidates[slot].some((row) => !availableGrades.has(row.line.grade))) return;
        for (const row of compressed[slot]) {
          if (!canAppend(prefix, row)) continue;
          prefix.push(row);
          chosen.set(slot, row);
          visit(depth + 1);
          prefix.pop();
          chosen.delete(slot);
        }
      }
      visit(0);
    }
    if (prime || (rule.gradeUpChance <= 0 && guaranteedAfterFailures(rule) === undefined)) break;
  }
  return Number.isFinite(minimum) && maximum > 0
    ? { min: rounded(minimum), max: rounded(maximum) }
    : undefined;
}
