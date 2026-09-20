/** KMS bonus-option model. Evidence and value-formula boundaries: docs/bonus-option-sources.md. */
export const BONUS_STAT_LABELS = {
  str: 'STR',
  dex: 'DEX',
  int: 'INT',
  luk: 'LUK',
  hp: '최대 HP',
  mp: '최대 MP',
  attack: '공격력',
  magicAttack: '마력',
  armor: '방어력',
  speed: '이동속도',
  jump: '점프력',
  bossDamage: '보스 몬스터 데미지%',
  damage: '데미지%',
  allStat: '올스탯%',
  levelReduction: '착용 레벨 감소',
} as const;
export type BonusStat = keyof typeof BONUS_STAT_LABELS;
export type BonusStats = Record<BonusStat, number>;
export type BonusWeights = Partial<BonusStats>;
export type BonusMainStat = 'str' | 'dex' | 'int' | 'luk';
export type BonusFlame = 'meso' | 'blazing' | 'black' | 'abyss';
export const BONUS_FLAME_LABELS: Record<BonusFlame, string> = {
  meso: '메소 재설정',
  blazing: '타오르는 환생의 불꽃',
  black: '검은 환생의 불꽃',
  abyss: '심연의 환생의 불꽃',
};
export const BONUS_OPTION_LABELS = {
  ...BONUS_STAT_LABELS,
  strDex: 'STR + DEX',
  strInt: 'STR + INT',
  strLuk: 'STR + LUK',
  dexInt: 'DEX + INT',
  dexLuk: 'DEX + LUK',
  intLuk: 'INT + LUK',
} as const;
export type BonusOption = keyof typeof BONUS_OPTION_LABELS;
export interface BonusEquipment {
  level: number;
  kind: 'weapon' | 'armor';
  boss: boolean;
  baseAttack?: number;
  baseMagicAttack?: number;
  /** Actual final tier, only for an explicitly identified fixed-tier exception. */
  fixedTier?: number;
}
export interface BonusConfig {
  equipment: BonusEquipment;
  flame: BonusFlame;
  weights: BonusWeights;
  targetScore: number;
  /** User's meso valuation of one flame. Meso reset is always 3,000,000. */
  costPerRoll?: number;
}
export interface BonusLine {
  option: BonusOption;
  tier: number;
  stats: Partial<BonusStats>;
}
export interface BonusRoll {
  lines: BonusLine[];
  stats: BonusStats;
  score: number;
}
export interface BonusEvaluation {
  successProbability: number;
  baseProbability: number;
  excludedProbability: number;
  expectedRolls: number;
  expectedCost: number;
  medianRolls: number;
  p90Rolls: number;
  maxScore: number;
  alreadySatisfied: boolean;
}

const STATS = Object.keys(BONUS_STAT_LABELS) as BonusStat[];
const COMMON_OPTIONS: BonusOption[] = [
  'str',
  'dex',
  'int',
  'luk',
  'strDex',
  'strInt',
  'strLuk',
  'dexInt',
  'dexLuk',
  'intLuk',
  'hp',
  'mp',
  'levelReduction',
  'armor',
  'attack',
  'magicAttack',
];
const PAIRS: Partial<Record<BonusOption, [BonusMainStat, BonusMainStat]>> = {
  strDex: ['str', 'dex'],
  strInt: ['str', 'int'],
  strLuk: ['str', 'luk'],
  dexInt: ['dex', 'int'],
  dexLuk: ['dex', 'luk'],
  intLuk: ['int', 'luk'],
};
const STAGE_PROBABILITIES: Record<BonusFlame, readonly number[]> = {
  meso: [0, 0.29, 0.45, 0.25, 0.01],
  black: [0, 0.29, 0.45, 0.25, 0.01],
  blazing: [0.2, 0.3, 0.36, 0.14, 0],
  abyss: [0, 0, 0.63, 0.34, 0.03],
};
const COUNT_PROBABILITIES = [0.4, 0.4, 0.16, 0.04];

export function emptyBonusStats(): BonusStats {
  return Object.fromEntries(STATS.map((stat) => [stat, 0])) as BonusStats;
}

export function defaultBonusWeights(
  mainStat: BonusMainStat,
  attackStat: 'attack' | 'magicAttack' = mainStat === 'int' ? 'magicAttack' : 'attack',
): BonusWeights {
  return { [mainStat]: 1, [attackStat]: 3, allStat: 10 };
}

export function scoreBonusStats(stats: Partial<BonusStats>, weights: BonusWeights): number {
  return STATS.reduce((sum, stat) => sum + (stats[stat] ?? 0) * (weights[stat] ?? 0), 0);
}

export function bonusRollCost(config: BonusConfig): number {
  return config.flame === 'meso' ? 3_000_000 : (config.costPerRoll ?? 0);
}

export function validateBonusConfig(config: BonusConfig): string[] {
  const errors: string[] = [];
  const { equipment } = config;
  if (!Number.isInteger(equipment.level) || equipment.level < 1 || equipment.level > 300) {
    errors.push('장비의 원래 요구 레벨을 1~300 사이 정수로 입력해 주세요.');
  }
  if (equipment.kind !== 'weapon' && equipment.kind !== 'armor')
    errors.push('장비 분류를 선택해 주세요.');
  if (typeof equipment.boss !== 'boolean') errors.push('보스 장비 여부를 선택해 주세요.');
  if (!(config.flame in STAGE_PROBABILITIES)) errors.push('재설정 수단을 선택해 주세요.');
  if (
    !Number.isFinite(config.targetScore) ||
    config.targetScore < 0 ||
    config.targetScore > 1_000_000_000
  )
    errors.push('목표 점수는 0~10억 사이여야 합니다.');
  if (
    config.costPerRoll !== undefined &&
    (!Number.isSafeInteger(config.costPerRoll) || config.costPerRoll < 0)
  ) {
    errors.push('환생의 불꽃 1개 가격은 0 이상의 안전한 정수여야 합니다.');
  }
  if (
    Object.values(config.weights).some(
      (value) => !Number.isFinite(value) || value < 0 || value > 10_000,
    )
  ) {
    errors.push('스탯 환산 비율은 0~10,000 사이여야 합니다.');
  }
  if (
    equipment.fixedTier !== undefined &&
    (!Number.isInteger(equipment.fixedTier) || equipment.fixedTier < 1 || equipment.fixedTier > 7)
  ) {
    errors.push('고정 추가옵션 단계는 1~7 사이 정수여야 합니다.');
  }
  if (equipment.kind === 'weapon') {
    for (const [key, name] of [
      ['baseAttack', '기본 공격력'],
      ['baseMagicAttack', '기본 마력'],
    ] as const) {
      const value = equipment[key];
      if (value === undefined || !Number.isSafeInteger(value) || value < 0)
        errors.push(`무기의 ${name}을 0 이상의 정수로 입력해 주세요.`);
    }
    if (!equipment.baseAttack && !equipment.baseMagicAttack)
      errors.push('무기의 기본 공격력 또는 기본 마력 중 하나는 0보다 커야 합니다.');
  }
  return errors;
}

function assertConfig(config: BonusConfig): void {
  const errors = validateBonusConfig(config);
  if (errors.length) throw new Error(errors.join(' '));
}

export function bonusOptionPool(equipment: BonusEquipment): BonusOption[] {
  const pool = [...COMMON_OPTIONS];
  if (equipment.kind === 'weapon') {
    if (equipment.level >= 90) pool.push('bossDamage');
    pool.push('damage', 'allStat');
  } else {
    if (equipment.level < 60) pool.splice(pool.indexOf('attack'), 2);
    pool.push('speed', 'jump');
    if (equipment.level >= 70) pool.push('allStat');
  }
  return pool;
}

export function bonusTierDistribution(
  config: BonusConfig,
): { tier: number; probability: number }[] {
  if (config.equipment.fixedTier !== undefined)
    return [{ tier: config.equipment.fixedTier, probability: 1 }];
  return STAGE_PROBABILITIES[config.flame]
    .map((probability, i) => ({ tier: i + 1 + (config.equipment.boss ? 2 : 0), probability }))
    .filter(({ probability }) => probability > 0);
}

/** Generic value model; weapon bases are unenhanced base options, never total attack. */
export function bonusLineStats(
  equipment: BonusEquipment,
  option: BonusOption,
  tier: number,
): Partial<BonusStats> {
  const genericSingle = Math.floor(equipment.level / 20) + 1;
  // Official API Eternal armor records corroborate 12/tier for single stats/DEF
  // and 700/tier for HP/MP. These exceptions are scoped to level 250 armor.
  const isLevel250Armor = equipment.kind === 'armor' && equipment.level === 250;
  const single = isLevel250Armor ? 12 : genericSingle;
  const dual = Math.floor(equipment.level / 40) + 1;
  const pair = PAIRS[option];
  if (pair) return { [pair[0]]: dual * tier, [pair[1]]: dual * tier };
  switch (option) {
    case 'str':
    case 'dex':
    case 'int':
    case 'luk':
    case 'armor':
      return { [option]: single * tier };
    case 'hp':
    case 'mp':
      return { [option]: (isLevel250Armor ? 700 : equipment.level * 3) * tier };
    case 'levelReduction':
      return { levelReduction: tier * 5 };
    case 'bossDamage':
      return { bossDamage: tier * 2 };
    case 'attack':
    case 'magicAttack': {
      if (equipment.kind !== 'weapon') return { [option]: tier };
      const base = (option === 'attack' ? equipment.baseAttack : equipment.baseMagicAttack) ?? 0;
      const exponent = tier - (equipment.boss ? 3 : 1);
      // Rational powers avoid ceil(90.00000000000001) producing an extra point.
      const coefficient = Math.floor(equipment.level / 40) + 1;
      const numerator =
        base * coefficient * tier * 11 ** Math.max(0, exponent) * 10 ** Math.max(0, -exponent);
      const denominator = 100 * 10 ** Math.max(0, exponent) * 11 ** Math.max(0, -exponent);
      return { [option]: Math.ceil(numerator / denominator) };
    }
    default:
      return { [option]: tier };
  }
}

function drawIndex(probabilities: readonly number[], random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1)
    throw new Error('난수는 0 이상 1 미만이어야 합니다.');
  let accumulated = 0;
  for (let i = 0; i < probabilities.length; i++) {
    accumulated += probabilities[i]!;
    if (value < accumulated) return i;
  }
  return probabilities.length - 1;
}

function sameStats(left: Partial<BonusStats>, right: Partial<BonusStats>): boolean {
  return STATS.every((stat) => (left[stat] ?? 0) === (right[stat] ?? 0));
}

function reachesScore(score: number, target: number): boolean {
  return (
    score >= target ||
    target - score <= Number.EPSILON * 8 * Math.max(Math.abs(score), Math.abs(target))
  );
}

export function rollBonusOptions(
  config: BonusConfig,
  random: () => number = Math.random,
  previous?: Partial<BonusStats>,
): BonusRoll {
  assertConfig(config);
  const pool = bonusOptionPool(config.equipment);
  const tiers = bonusTierDistribution(config);
  for (let retry = 0; retry < 10_000; retry++) {
    const count = config.equipment.boss ? 4 : drawIndex(COUNT_PROBABILITIES, random) + 1;
    const remaining = [...pool];
    const lines: BonusLine[] = [];
    const stats = emptyBonusStats();
    for (let i = 0; i < count; i++) {
      const chosen = drawIndex(
        remaining.map(() => 1 / remaining.length),
        random,
      );
      const option = remaining.splice(chosen, 1)[0]!;
      const tier =
        tiers[
          drawIndex(
            tiers.map((entry) => entry.probability),
            random,
          )
        ]!.tier;
      const lineStats = bonusLineStats(config.equipment, option, tier);
      lines.push({ option, tier, stats: lineStats });
      for (const stat of STATS) stats[stat] += lineStats[stat] ?? 0;
    }
    if (!previous || !sameStats(stats, previous))
      return { lines, stats, score: scoreBonusStats(stats, config.weights) };
  }
  throw new Error('동일한 결과가 반복되어 재설정을 중단했습니다. 난수 생성기를 확인해 주세요.');
}

function choose(n: number, k: number): number {
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - i + 1)) / i;
  return result;
}

interface Outcome {
  stats: Partial<BonusStats>;
  score: number;
  probability: number;
}

function countDistribution(config: BonusConfig): { count: number; probability: number }[] {
  return config.equipment.boss
    ? [{ count: 4, probability: 1 }]
    : COUNT_PROBABILITIES.map((probability, i) => ({ count: i + 1, probability }));
}

function optionOutcomes(config: BonusConfig): Outcome[][] {
  const tiers = bonusTierDistribution(config);
  return bonusOptionPool(config.equipment).map((option) =>
    tiers.map(({ tier, probability }) => {
      const stats = bonusLineStats(config.equipment, option, tier);
      return { stats, probability, score: scoreBonusStats(stats, config.weights) };
    }),
  );
}

/** Sum every option-set / tier assignment that produces these *aggregate* stats. */
function matchingProbability(
  config: BonusConfig,
  outcomes: Outcome[][],
  previous: Partial<BonusStats>,
): number {
  if (STATS.some((stat) => !Number.isFinite(previous[stat] ?? 0) || (previous[stat] ?? 0) < 0))
    return 0;
  const remaining = STATS.map((stat) => previous[stat] ?? 0);
  const candidates = outcomes.map((rows) =>
    rows
      .map((row) => ({
        probability: row.probability,
        values: STATS.map((stat) => row.stats[stat] ?? 0),
      }))
      .filter((row) => row.values.every((value, i) => value <= remaining[i]!)),
  );
  function visit(start: number, left: number): number {
    if (!left) return remaining.every((value) => value === 0) ? 1 : 0;
    let probability = 0;
    for (let i = start; i <= candidates.length - left; i++) {
      for (const row of candidates[i]!) {
        if (row.values.some((value, index) => value > remaining[index]!)) continue;
        for (let j = 0; j < remaining.length; j++) remaining[j]! -= row.values[j]!;
        probability += row.probability * visit(i + 1, left - 1);
        for (let j = 0; j < remaining.length; j++) remaining[j]! += row.values[j]!;
      }
    }
    return probability;
  }
  return countDistribution(config).reduce(
    (sum, { count, probability }) =>
      sum + (probability * visit(0, count)) / choose(outcomes.length, count),
    0,
  );
}

/** Exact discrete enumeration for keeping the same BEFORE options until the goal. */
export function evaluateBonusOptions(
  config: BonusConfig,
  previous?: Partial<BonusStats>,
): BonusEvaluation {
  assertConfig(config);
  const outcomes = optionOutcomes(config);
  // Collapsing equal scores changes no probability and avoids enumerating irrelevant tiers.
  const distributions = outcomes.map((rows) => {
    const scores = new Map<number, number>();
    for (const row of rows) scores.set(row.score, (scores.get(row.score) ?? 0) + row.probability);
    return [...scores].map(([score, probability]) => ({ score, probability }));
  });
  const selected: typeof distributions = [];
  function tierTail(index: number, score: number): number {
    if (reachesScore(score, config.targetScore)) return 1;
    if (index === selected.length) return 0;
    return selected[index]!.reduce(
      (sum, outcome) => sum + outcome.probability * tierTail(index + 1, score + outcome.score),
      0,
    );
  }
  function subsets(start: number, left: number): number {
    if (!left) return tierTail(0, 0);
    let sum = 0;
    for (let i = start; i <= distributions.length - left; i++) {
      selected.push(distributions[i]!);
      sum += subsets(i + 1, left - 1);
      selected.pop();
    }
    return sum;
  }
  const counts = countDistribution(config);
  const baseProbability = Math.max(
    0,
    Math.min(
      1,
      counts.reduce(
        (sum, { count, probability }) =>
          sum + (probability * subsets(0, count)) / choose(outcomes.length, count),
        0,
      ),
    ),
  );
  const excludedProbability = previous ? matchingProbability(config, outcomes, previous) : 0;
  const alreadySatisfied =
    !!previous && reachesScore(scoreBonusStats(previous, config.weights), config.targetScore);
  const successProbability =
    excludedProbability < 1
      ? Math.max(
          0,
          Math.min(
            1,
            (baseProbability - (alreadySatisfied ? excludedProbability : 0)) /
              (1 - excludedProbability),
          ),
        )
      : 0;
  const expectedRolls = alreadySatisfied
    ? 0
    : successProbability > 0
      ? 1 / successProbability
      : Infinity;
  const maxScore = distributions
    .map((rows) => Math.max(...rows.map(({ score }) => score)))
    .sort((a, b) => b - a)
    .slice(0, 4)
    .reduce((sum, value) => sum + value, 0);
  const quantile = (p: number) =>
    alreadySatisfied
      ? 0
      : successProbability >= 1
        ? 1
        : successProbability <= 0
          ? Infinity
          : Math.ceil(Math.log1p(-p) / Math.log1p(-successProbability));
  return {
    successProbability,
    baseProbability,
    excludedProbability,
    expectedRolls,
    expectedCost: expectedRolls === Infinity ? Infinity : expectedRolls * bonusRollCost(config),
    medianRolls: quantile(0.5),
    p90Rolls: quantile(0.9),
    maxScore,
    alreadySatisfied,
  };
}

export interface BonusRerollEvaluation extends BonusEvaluation {
  method: 'independent-baseline';
}

/**
 * Always-replace simulator benchmark. Its base draw probability is enumerated
 * exactly, but stopping times are an independent-draw approximation: the actual
 * sampler excludes a different current outcome after every replacement.
 */
export function evaluateBonusReroll(
  config: BonusConfig,
  previous?: Partial<BonusStats>,
): BonusRerollEvaluation {
  // Deliberately omit previous here. Conditioning on the initial item forever
  // would describe the old keep-before strategy, not an always-replace run.
  const baseline = evaluateBonusOptions(config);
  const alreadySatisfied =
    !!previous && reachesScore(scoreBonusStats(previous, config.weights), config.targetScore);
  return {
    ...baseline,
    method: 'independent-baseline',
    alreadySatisfied,
    ...(alreadySatisfied ? { expectedRolls: 0, expectedCost: 0, medianRolls: 0, p90Rolls: 0 } : {}),
  };
}

/** Geometric-model completion percentile (approximate for always-replace runs). Lower is luckier. */
export function bonusLuckPercentile(probability: number, rolls: number): number {
  if (rolls <= 0 || probability <= 0) return 0;
  if (probability >= 1) return 100;
  return -Math.expm1(Math.floor(rolls) * Math.log1p(-probability)) * 100;
}
