import type { Grade, LineGrade, OptionLine, OptionUnit, SimulationConfig } from '../types';
import { normalized } from './math';

export interface RawOption {
  id: string;
  type: string;
  value: number;
  unit: OptionUnit;
  probability: number;
  maxLines?: number;
  limitGroup?: string;
  displayText?: string;
}
export interface OptionPool {
  grade: LineGrade;
  slot?: number | null;
  minimumLevel: number;
  maximumLevel: number;
  categories: string[];
  options: RawOption[];
}
export interface GradeRule {
  grade: Grade;
  rank: number;
  gradeUpChance: number;
  /** Published event probability, preserving rounding from the official table. */
  miracleTimeGradeUpChance?: number;
  pityThreshold?: number | null;
  guaranteedAfterFailures?: number | null;
  lineGrades: { slot: number; chances: { grade: LineGrade; probability: number }[] }[];
}
export interface PotentialRules {
  ruleId: string;
  grades: GradeRule[];
  optionPools: OptionPool[];
  costBands: { minimumLevel: number; maximumLevel: number; resetCosts: Record<Grade, string> }[];
  primeCube?: { unitCreditCost: number } | null;
}
export interface AbilityOption {
  id: string;
  type?: string;
  label: string;
  weight: number;
  valueDirection?: 'lower' | 'higher';
  values: { value: number; secondaryValue?: number; label: string; weight: number }[];
}
export interface AbilityRules {
  ruleId: string;
  version: string;
  sourceUrl: string;
  grades: Partial<Record<LineGrade, { options: AbilityOption[] }>>;
  advancedLineGrades: Partial<Record<LineGrade, number>>[];
  costs: { locked: number; honor: number; meso: string }[];
}
export interface AmplificationRule {
  stage: number;
  initialSuccessProbability: number;
  successProbabilityIncreasePerFailure: number;
  guaranteedAfterFailures: number;
  systemCostPerAttempt: string;
}
export interface SoulRules {
  ruleId: string;
  version: string;
  amplificationStages: AmplificationRule[];
  potentialGrades: GradeRule[];
  potentialResetCosts: Record<Grade, string>;
  optionStages: { stage: number; optionPools: OptionPool[] }[];
}
export interface RuleData {
  potential: PotentialRules;
  additional: PotentialRules;
  gold: PotentialRules;
  ability: AbilityRules;
  soul: SoulRules;
}
export interface Candidate {
  line: OptionLine;
  probability: number;
  optionProbability: number;
  gradeProbability: number;
  maxLines: number;
  limitGroup: string;
}
export const GRADES: Grade[] = ['rare', 'epic', 'unique', 'legendary'];
export const gradeRank = (grade: LineGrade): number => ['normal', ...GRADES].indexOf(grade);
export const normalizeText = (value: string): string =>
  value
    .normalize('NFKC')
    .replace(/[\s:：]/g, '')
    .toUpperCase();
export const lineIdentity = (line: OptionLine): string =>
  normalizeText(line.text || `${line.type}|${line.value}|${line.unit}`);
/** Overall grade is compared separately; visible ordered options define repeat exclusion. */
export const tupleIdentity = (lines: readonly OptionLine[]): string =>
  lines
    .map(lineIdentity)
    .map((x) => `${x.length}:${x}`)
    .join('');

export async function loadRuleData(baseUrl = '/'): Promise<RuleData> {
  const prefix = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const names = ['potential', 'additional-potential', 'gold', 'ability', 'soul'];
  const values = await Promise.all(
    names.map(async (name) => {
      const response = await fetch(`${prefix}rules/${name}.json`);
      if (!response.ok)
        throw new Error(`확률 자료를 불러올 수 없습니다: ${name} (${response.status})`);
      return response.json();
    }),
  );
  return {
    potential: values[0],
    additional: values[1],
    gold: values[2],
    ability: values[3],
    soul: values[4],
  };
}

export function potentialRules(data: RuleData, config: SimulationConfig): PotentialRules {
  if (config.mode === 'soulPotential') {
    const stage = data.soul.optionStages.find((s) => s.stage === config.start.stage);
    if (!stage) throw new Error('소울 증폭 단계를 1~4에서 선택해주세요.');
    return {
      ruleId: `${data.soul.ruleId}:${stage.stage}`,
      grades: data.soul.potentialGrades,
      optionPools: stage.optionPools,
      costBands: [
        { minimumLevel: 1, maximumLevel: 300, resetCosts: data.soul.potentialResetCosts },
      ],
    };
  }
  if (config.cubeType === 'gold') return data.gold;
  return config.cubeType === 'additional' || config.cubeType === 'primeAdditional'
    ? data.additional
    : data.potential;
}

export function selectPool(
  rules: PotentialRules,
  grade: LineGrade,
  slot: number,
  config: SimulationConfig,
): OptionPool {
  const category = config.mode === 'soulPotential' ? 'weapon' : config.category;
  const level = config.mode === 'soulPotential' ? 200 : config.level;
  const pools = rules.optionPools.filter(
    (pool) =>
      pool.grade === grade &&
      level >= pool.minimumLevel &&
      level <= pool.maximumLevel &&
      (pool.slot == null || pool.slot === slot + 1) &&
      (pool.categories.length === 0 || pool.categories.includes(category)),
  );
  const specificity = (pool: OptionPool) =>
    (pool.slot == null ? 0 : 2) + (pool.categories.length ? 1 : 0);
  pools.sort((a, b) => specificity(b) - specificity(a));
  if (!pools.length)
    throw new Error(`${level}레벨 ${category}의 ${grade} ${slot + 1}번째 줄 확률 자료가 없습니다.`);
  if (pools.length > 1 && specificity(pools[0]) === specificity(pools[1]))
    throw new Error('중복되는 옵션 확률 자료가 있습니다.');
  return pools[0];
}

/** KMS ordinary honor reset, for the simulator's legendary starting grade.
 * Sources: official ability game guide /Articles/392 and ability/reputevalue.
 */
export const NORMAL_ABILITY_COSTS = [
  { locked: 0, honor: 8000, meso: '0' },
  { locked: 1, honor: 11000, meso: '0' },
  { locked: 2, honor: 16000, meso: '0' },
];
export const NORMAL_ABILITY_LINE_GRADES: Partial<Record<LineGrade, number>>[] = [
  { legendary: 1 },
  { epic: 0.85, unique: 0.15 },
  { epic: 0.85, unique: 0.15 },
];

export function isNormalAbility(
  config: Pick<SimulationConfig, 'mode' | 'abilityResetMode'>,
): boolean {
  return config.mode === 'ability' && config.abilityResetMode === 'normal';
}

export function abilityResetCosts(data: RuleData, config: SimulationConfig) {
  return isNormalAbility(config) ? NORMAL_ABILITY_COSTS : data.ability.costs;
}

function abilityCandidates(data: RuleData, config: SimulationConfig, slot: number): Candidate[] {
  const grades = (isNormalAbility(config)
    ? NORMAL_ABILITY_LINE_GRADES
    : data.ability.advancedLineGrades)[slot];
  const results: Candidate[] = [];
  for (const [grade, chance] of Object.entries(grades)) {
    if (!(chance! > 0)) continue;
    const options = data.ability.grades[grade as LineGrade]?.options;
    if (!options?.length) throw new Error(`${grade} 어빌리티 확률 자료가 없습니다.`);
    const total = options.reduce((n, o) => n + o.weight, 0);
    for (const option of options) {
      const totalValues = option.values.reduce((n, v) => n + v.weight, 0);
      const aggregated = new Map<string, { line: OptionLine; probability: number }>();
      for (const value of option.values) {
        const label = value.label || `${option.label} ${value.value}`;
        const key = normalizeText(label);
        const old = aggregated.get(key);
        if (old) old.probability += value.weight / totalValues;
        else
          aggregated.set(key, {
            line: {
              id: `${option.id}:${grade}:${value.value}:${value.secondaryValue ?? ''}`,
              abilityTypeId: option.id,
              type: option.type ?? option.id,
              value: value.value,
              unit: label.includes('%') ? 'percent' : 'flat',
              text: label,
              grade: grade as LineGrade,
            },
            probability: value.weight / totalValues,
          });
      }
      for (const value of aggregated.values()) {
        const optionProbability = (option.weight / total) * value.probability;
        results.push({
          line: value.line,
          probability: chance! * optionProbability,
          optionProbability,
          gradeProbability: chance!,
          maxLines: 1,
          limitGroup: option.id,
        });
      }
    }
  }
  return results;
}

export function allCandidates(
  data: RuleData,
  config: SimulationConfig,
  grade: Grade,
  slot: number,
): Candidate[] {
  if (config.mode === 'ability') return abilityCandidates(data, config, slot);
  const rules = potentialRules(data, config);
  const rule = rules.grades.find((r) => r.grade === grade);
  const lineGrades = rule?.lineGrades.find((r) => r.slot === slot + 1)?.chances;
  if (!lineGrades) throw new Error('해당 등급의 줄별 확률 자료가 없습니다.');
  const candidates: Candidate[] = [];
  for (const chance of normalized(lineGrades)) {
    if (!(chance.probability > 0)) continue;
    for (const option of normalized(selectPool(rules, chance.grade, slot, config).options)) {
      if (!(option.probability > 0)) continue;
      const line: OptionLine = {
        id: option.id,
        type: option.type,
        value: option.value,
        unit: option.unit,
        text: option.displayText ?? `${option.type} ${option.value}`,
        grade: chance.grade,
      };
      candidates.push({
        line,
        probability: chance.probability * option.probability,
        optionProbability: option.probability,
        gradeProbability: chance.probability,
        maxLines: option.maxLines ?? 3,
        limitGroup: option.limitGroup ?? option.id,
      });
    }
  }
  return candidates;
}

export function canAppend(prefix: readonly Candidate[], candidate: Candidate): boolean {
  const matches = prefix.filter((p) => p.limitGroup === candidate.limitGroup);
  return matches.length + 1 <= Math.min(candidate.maxLines, ...matches.map((p) => p.maxLines));
}

/** Line grade is selected before type exclusions: only re-normalize within each grade. */
export function eligibleCandidates(
  candidates: readonly Candidate[],
  prefix: readonly Candidate[],
): Candidate[] {
  const rows = candidates.filter((c) => canAppend(prefix, c));
  const totals = new Map<LineGrade, number>();
  for (const row of rows)
    totals.set(row.line.grade, (totals.get(row.line.grade) ?? 0) + row.optionProbability);
  for (const row of candidates)
    if (!(totals.get(row.line.grade)! > 0))
      throw new Error('잠금과 중복 제한으로 추첨 가능한 옵션이 없습니다.');
  return rows.map((row) => ({
    ...row,
    probability: (row.gradeProbability * row.optionProbability) / totals.get(row.line.grade)!,
  }));
}

export function getLineOptions(
  data: RuleData,
  config: SimulationConfig,
  slot: number,
  grade?: LineGrade,
): OptionLine[] {
  const rows = allCandidates(data, config, config.start.grade, slot)
    .map((c) => c.line)
    .filter((l) => !grade || l.grade === grade);
  const unique = new Map<string, OptionLine>();
  for (const line of rows) unique.set(`${line.grade}:${lineIdentity(line)}`, line);
  return [...unique.values()];
}

export function resolveOptionLine(
  data: RuleData,
  config: SimulationConfig,
  line: OptionLine,
  slot: number,
): OptionLine {
  // Imported advanced-reset lines remain legendary until an ordinary reset actually
  // replaces them. Equal visible text in a lower grade must not downgrade the import.
  const preserveLowerLegendary = isNormalAbility(config) && slot > 0 && line.grade === 'legendary';
  const rows = preserveLowerLegendary
    ? getLineOptions(data, { ...config, abilityResetMode: 'advanced' }, slot, 'legendary')
    : getLineOptions(data, config, slot);
  return (
    rows.find(
      (candidate) =>
        lineIdentity(candidate) === lineIdentity(line) && candidate.grade === line.grade,
    ) ??
    rows.find((candidate) => lineIdentity(candidate) === lineIdentity(line)) ??
    rows.find(
      (candidate) =>
        candidate.type === line.type &&
        candidate.value === line.value &&
        candidate.grade === line.grade &&
        line.type !== 'unknown',
    ) ??
    line
  );
}

export function guaranteedAfterFailures(rule: GradeRule): number | undefined {
  if (rule.guaranteedAfterFailures != null) return rule.guaranteedAfterFailures;
  return rule.pityThreshold != null ? rule.pityThreshold - 1 : undefined;
}

/** Event eligibility is independent of the currently selected potential grade. */
export function supportsMiracleTime(config: Pick<SimulationConfig, 'mode' | 'cubeType'>): boolean {
  return (
    config.mode === 'soulPotential' ||
    (config.mode === 'cube' && ['black', 'additional', 'gold'].includes(config.cubeType))
  );
}

/** The September 2026 event doubles natural promotions; pity still advances once per failure. */
export function effectiveGradeUpChance(
  config: Pick<SimulationConfig, 'mode' | 'cubeType' | 'miracleTime'>,
  rule: GradeRule,
): number {
  return config.miracleTime === true && supportsMiracleTime(config)
    ? Math.min(1, rule.miracleTimeGradeUpChance ?? rule.gradeUpChance * 2)
    : rule.gradeUpChance;
}

export function isPrime(config: SimulationConfig): boolean {
  return (
    config.mode === 'cube' && (config.cubeType === 'prime' || config.cubeType === 'primeAdditional')
  );
}
export function benchmarkUnit(config: SimulationConfig): 'meso' | 'cubes' | 'honor' {
  if (isNormalAbility(config)) return 'honor';
  return config.mode === 'cube' && ['gold', 'prime', 'primeAdditional'].includes(config.cubeType)
    ? 'cubes'
    : 'meso';
}

/** Lower potential grades run sequentially and stop at a promotion or target hit. */
export function isSequentialPotentialBatch(
  config: Pick<SimulationConfig, 'mode' | 'batchSize'>,
  grade: Grade,
): boolean {
  return (
    config.batchSize === 3 &&
    (config.mode === 'cube' || config.mode === 'soulPotential') &&
    grade !== 'legendary'
  );
}

/** Maximum attempts per action; lower potential grades can stop before all three. */
export function effectiveBatchSize(
  config: Pick<SimulationConfig, 'mode' | 'batchSize' | 'abilityResetMode'>,
  grade: Grade,
): 1 | 3 {
  if (isSequentialPotentialBatch(config, grade)) return 3;
  return !isNormalAbility(config) && config.batchSize === 3 &&
    (config.mode === 'ability' ||
      ((config.mode === 'cube' || config.mode === 'soulPotential') && grade === 'legendary'))
    ? 3
    : 1;
}
