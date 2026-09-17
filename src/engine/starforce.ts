import { cryptoRandom } from './math';

export interface StarforceTransition {
  star: number;
  successProbability: number;
  maintainProbability: number;
  decreaseProbability: number;
  destroyProbability: number;
  successStar: number;
  decreaseStar?: number;
  traceStar?: number;
}
export interface StarforceRules {
  ruleId: string;
  version?: string;
  sourceUrl?: string;
  checkedAt?: string;
  minimumLevel: number;
  maximumLevel: number;
  maximumStarBands: { minimumLevel: number; maximumLevel: number; maximumStar: number }[];
  costFormula: {
    baseCost: number;
    levelExponent: number;
    starOffset: number;
    starExponent: number;
    roundTo: number;
    denominators: {
      minimumStar: number;
      maximumStar: number;
      denominator: number;
      starExponentOverride?: number;
    }[];
  };
  transitions: StarforceTransition[];
  safeguard: {
    eligibleStars: number[];
    additionalBaseCostMultiplier: number;
    destroyProbabilityMultiplier: number;
  };
  restoration: {
    restoreToBase: { restoredStar: number; mesoCost: string; equipmentCount: number };
    fullRestoreBands: {
      minimumLevel: number;
      maximumLevel: number;
      minimumTraceStar: number;
      maximumTraceStar: number;
      mesoCost: string;
      equipmentCount: number;
    }[];
  };
}
export interface StarforceConfig {
  level: number;
  startStars: number;
  targetStars: number;
  safeguard: boolean;
  restoration: 'trace12' | 'original';
  replacementPrice: number;
  equipmentType: 'normal' | 'superior';
}
export interface StarforceRestoration {
  policy: StarforceConfig['restoration'];
  fromStars: number;
  traceStars: number;
  toStars: number;
  mesoCost: bigint;
  equipmentCount: bigint;
  replacementCost: bigint;
  totalCost: bigint;
}
export interface StarforceQuote {
  stars: number;
  maxStars: number;
  baseCost: bigint;
  cost: bigint;
  safeguardAllowed: boolean;
  safeguardActive: boolean;
  successProbability: number;
  maintainProbability: number;
  decreaseProbability: number;
  destroyProbability: number;
  successStar: number;
  decreaseStar: number;
  restoration?: StarforceRestoration;
}
export interface StarforceRollResult {
  sequence: bigint;
  fromStars: number;
  toStars: number | null;
  outcome: 'success' | 'stay' | 'down' | 'destroy';
  mesoCost: bigint;
  probability: number;
  safeguard: boolean;
  restoration?: StarforceRestoration;
  restored?: boolean;
}
export interface StarforceState {
  stars: number;
  status: 'ready' | 'success' | 'destroyed';
  attempts: bigint;
  destructions: bigint;
  restorations: bigint;
  enhancementMeso: bigint;
  restorationMeso: bigint;
  replacementMeso: bigint;
  replacementCopies: bigint;
  spentMeso: bigint;
  pendingRestoration?: StarforceRestoration;
  history: StarforceRollResult[];
}
export interface StarforceBenchmark {
  status: 'ready' | 'already' | 'impossible';
  expectedMeso: number;
  expectedEnhancementMeso: number;
  expectedRestorationMeso: number;
  expectedReplacementMeso: number;
  expectedAttempts: number;
  expectedDestructions: number;
  expectedReplacementCopies: number;
  method: 'analytic';
}

export function maxStarforceStars(
  rules: StarforceRules,
  level: number,
  equipmentType: StarforceConfig['equipmentType'] = 'normal',
): number {
  if (equipmentType !== 'normal')
    throw new Error('슈페리얼 장비의 별도 확률·비용 자료는 아직 지원하지 않습니다.');
  if (!Number.isInteger(level) || level < rules.minimumLevel || level > rules.maximumLevel)
    throw new Error(`${rules.minimumLevel}~${rules.maximumLevel}레벨 일반 장비를 선택해 주세요.`);
  const band = rules.maximumStarBands.find(
    (row) => level >= row.minimumLevel && level <= row.maximumLevel,
  );
  if (!band) throw new Error('해당 장비 레벨의 최대 강화 단계 자료가 없습니다.');
  return band.maximumStar;
}
export function validateStarforceConfig(rules: StarforceRules, config: StarforceConfig): string[] {
  const errors: string[] = [];
  let maximum: number;
  try {
    maximum = maxStarforceStars(rules, config.level, config.equipmentType);
  } catch (error) {
    return [error instanceof Error ? error.message : '장비 설정을 확인해 주세요.'];
  }
  if (
    ![config.startStars, config.targetStars].every(
      (star) => Number.isInteger(star) && star >= 0 && star <= maximum,
    )
  )
    errors.push(`시작·목표 단계는 0~${maximum}성 범위의 정수여야 합니다.`);
  if (!Number.isSafeInteger(config.replacementPrice) || config.replacementPrice < 0)
    errors.push('복구용 장비 가격은 0 이상의 안전한 정수로 입력해 주세요.');
  if (!['trace12', 'original'].includes(config.restoration))
    errors.push('복구 방식을 선택해 주세요.');
  return errors;
}
function assertConfig(rules: StarforceRules, config: StarforceConfig) {
  const errors = validateStarforceConfig(rules, config);
  if (errors.length) throw new Error(errors.join('\n'));
}

function restorationQuote(
  rules: StarforceRules,
  config: StarforceConfig,
  transition: StarforceTransition,
): StarforceRestoration {
  const traceStars = transition.traceStar ?? Math.min(transition.star, 22);
  const row =
    config.restoration === 'trace12'
      ? rules.restoration.restoreToBase
      : rules.restoration.fullRestoreBands.find(
          (band) =>
            config.level >= band.minimumLevel &&
            config.level <= band.maximumLevel &&
            traceStars >= band.minimumTraceStar &&
            traceStars <= band.maximumTraceStar,
        );
  if (!row)
    throw new Error(
      `${config.level}레벨 ${traceStars}성 원래 단계 복구 비용 자료가 없습니다. 12성 복구를 선택해 주세요.`,
    );
  const equipmentCount = BigInt(row.equipmentCount);
  const mesoCost = BigInt(row.mesoCost);
  const replacementCost = equipmentCount * BigInt(config.replacementPrice);
  return {
    policy: config.restoration,
    fromStars: transition.star,
    traceStars,
    toStars:
      config.restoration === 'trace12' ? rules.restoration.restoreToBase.restoredStar : traceStars,
    mesoCost,
    equipmentCount,
    replacementCost,
    totalCost: mesoCost + replacementCost,
  };
}

export function quoteStarforce(
  rules: StarforceRules,
  config: StarforceConfig,
  state: Pick<StarforceState, 'stars'>,
): StarforceQuote {
  assertConfig(rules, config);
  const maxStars = maxStarforceStars(rules, config.level, config.equipmentType);
  if (!Number.isInteger(state.stars) || state.stars < 0 || state.stars >= maxStars)
    throw new Error('더 이상 강화할 수 없는 단계입니다.');
  const transition = rules.transitions.find((row) => row.star === state.stars);
  const formula = rules.costFormula;
  const denominator = formula.denominators.find(
    (row) => state.stars >= row.minimumStar && state.stars <= row.maximumStar,
  );
  if (!transition || !denominator) throw new Error('해당 단계의 강화 확률·비용 자료가 없습니다.');
  const rawCost =
    formula.baseCost +
    (config.level ** formula.levelExponent *
      (state.stars + formula.starOffset) **
        (denominator.starExponentOverride ?? formula.starExponent)) /
      denominator.denominator;
  const rounded = Math.floor(rawCost / formula.roundTo + 0.5) * formula.roundTo;
  if (!Number.isSafeInteger(rounded) || rounded < 0)
    throw new Error('강화 비용을 안전하게 계산할 수 없습니다.');
  const safeguardAllowed = rules.safeguard.eligibleStars.includes(state.stars);
  const safeguardActive = config.safeguard && safeguardAllowed;
  const total =
    rounded * (1 + (safeguardActive ? rules.safeguard.additionalBaseCostMultiplier : 0));
  if (!Number.isSafeInteger(total))
    throw new Error('파괴 방지 비용을 안전하게 계산할 수 없습니다.');
  const probabilities = [
    transition.successProbability,
    transition.maintainProbability,
    transition.decreaseProbability,
    transition.destroyProbability,
  ];
  if (
    !probabilities.every((p) => Number.isFinite(p) && p >= 0 && p <= 1) ||
    Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-10
  )
    throw new Error('스타포스 확률 합이 올바르지 않습니다.');
  if (safeguardActive) {
    const destroy = probabilities[3] * rules.safeguard.destroyProbabilityMultiplier;
    probabilities[1] += probabilities[3] - destroy;
    probabilities[3] = destroy;
  }
  // Published probabilities use at most six decimal places; remove only binary
  // floating-point addition noise from safeguard's transfer to maintained results.
  const [successProbability, maintainProbability, decreaseProbability, destroyProbability] =
    probabilities.map((p) => Number(p.toFixed(12)));
  return {
    stars: state.stars,
    maxStars,
    baseCost: BigInt(rounded),
    cost: BigInt(total),
    safeguardAllowed,
    safeguardActive,
    successProbability,
    maintainProbability,
    decreaseProbability,
    destroyProbability,
    successStar: transition.successStar,
    decreaseStar: transition.decreaseStar ?? Math.max(0, state.stars - 1),
    ...(destroyProbability > 0 ? { restoration: restorationQuote(rules, config, transition) } : {}),
  };
}

export function createStarforceState(
  rules: StarforceRules,
  config: StarforceConfig,
): StarforceState {
  assertConfig(rules, config);
  if (config.startStars < config.targetStars)
    quoteStarforce(rules, config, { stars: config.startStars });
  return {
    stars: config.startStars,
    status: config.startStars >= config.targetStars ? 'success' : 'ready',
    attempts: 0n,
    destructions: 0n,
    restorations: 0n,
    enhancementMeso: 0n,
    restorationMeso: 0n,
    replacementMeso: 0n,
    replacementCopies: 0n,
    spentMeso: 0n,
    history: [],
  };
}

export function rollStarforce(
  rules: StarforceRules,
  config: StarforceConfig,
  state: StarforceState,
  rng: () => number = cryptoRandom,
): { state: StarforceState; result: StarforceRollResult } {
  if (state.status !== 'ready')
    throw new Error(
      state.status === 'destroyed'
        ? '파괴된 장비를 먼저 복구해 주세요.'
        : '이미 목표 단계에 도달했습니다.',
    );
  const quote = quoteStarforce(rules, config, state);
  const random = rng();
  if (!Number.isFinite(random) || random < 0 || random >= 1)
    throw new Error('추첨값은 0 이상 1 미만이어야 합니다.');
  const branches = [
    {
      outcome: 'success' as const,
      probability: quote.successProbability,
      stars: quote.successStar,
    },
    { outcome: 'stay' as const, probability: quote.maintainProbability, stars: state.stars },
    { outcome: 'down' as const, probability: quote.decreaseProbability, stars: quote.decreaseStar },
    { outcome: 'destroy' as const, probability: quote.destroyProbability, stars: state.stars },
  ];
  let draw = random * branches.reduce((sum, branch) => sum + branch.probability, 0);
  let selected = branches[branches.length - 1];
  for (const branch of branches) {
    if (draw < branch.probability) {
      selected = branch;
      break;
    }
    draw -= branch.probability;
  }
  const destroyed = selected.outcome === 'destroy';
  const result: StarforceRollResult = {
    sequence: state.attempts + 1n,
    fromStars: state.stars,
    toStars: destroyed ? null : selected.stars,
    outcome: selected.outcome,
    mesoCost: quote.cost,
    probability: selected.probability,
    safeguard: quote.safeguardActive,
    ...(destroyed ? { restoration: quote.restoration!, restored: false } : {}),
  };
  return {
    result,
    state: {
      ...state,
      stars: selected.stars,
      status: destroyed ? 'destroyed' : selected.stars >= config.targetStars ? 'success' : 'ready',
      attempts: state.attempts + 1n,
      destructions: state.destructions + (destroyed ? 1n : 0n),
      enhancementMeso: state.enhancementMeso + quote.cost,
      spentMeso: state.spentMeso + quote.cost,
      pendingRestoration: destroyed ? quote.restoration : undefined,
      history: [...state.history, result].slice(-100),
    },
  };
}

export function restoreStarforce(
  rules: StarforceRules,
  config: StarforceConfig,
  state: StarforceState,
): StarforceState {
  assertConfig(rules, config);
  if (state.status !== 'destroyed' || !state.pendingRestoration)
    throw new Error('복구할 파괴 장비가 없습니다.');
  const restoration = state.pendingRestoration;
  // Charge the quote created at destruction, never a subsequently edited price.
  return {
    ...state,
    stars: restoration.toStars,
    status: restoration.toStars >= config.targetStars ? 'success' : 'ready',
    restorations: state.restorations + 1n,
    restorationMeso: state.restorationMeso + restoration.mesoCost,
    replacementMeso: state.replacementMeso + restoration.replacementCost,
    replacementCopies: state.replacementCopies + restoration.equipmentCount,
    spentMeso: state.spentMeso + restoration.totalCost,
    pendingRestoration: undefined,
    history: state.history.map((row, index) =>
      index === state.history.length - 1 ? { ...row, restored: true } : row,
    ),
  };
}

interface Fraction {
  n: bigint;
  d: bigint;
}
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a;
};
function fraction(n: bigint, d = 1n): Fraction {
  if (d === 0n) throw new Error('스타포스 기댓값 방정식이 특이합니다.');
  if (n === 0n) return { n: 0n, d: 1n };
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
function decimal(value: number): Fraction {
  const [mantissa, exponent = '0'] = value.toString().split('e');
  const digits = (mantissa.split('.')[1] ?? '').length - Number(exponent);
  const n = BigInt(mantissa.replace('.', ''));
  return digits >= 0 ? fraction(n, 10n ** BigInt(digits)) : fraction(n * 10n ** BigInt(-digits));
}
const plus = (a: Fraction, b: Fraction) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const minus = (a: Fraction, b: Fraction) => fraction(a.n * b.d - b.n * a.d, a.d * b.d);
const multiply = (a: Fraction, b: Fraction) => fraction(a.n * b.n, a.d * b.d);
const divide = (a: Fraction, b: Fraction) => fraction(a.n * b.d, a.d * b.n);
function numberFromFraction(value: Fraction): number {
  const numerator = Number(value.n),
    denominator = Number(value.d);
  if (Number.isFinite(numerator) && Number.isFinite(denominator)) return numerator / denominator;
  const n = value.n.toString(),
    d = value.d.toString();
  return (Number(n.slice(0, 15)) / Number(d.slice(0, 15))) * 10 ** (n.length - d.length);
}
/** Exact rational elimination avoids subtractive cancellation for remote targets.
 * Probabilities and rewards are rational; only the final display means become floats. */
function solve(matrix: Fraction[][], count: number): Fraction[][] | undefined {
  const columns = matrix[0].length;
  for (let col = 0; col < count; col++) {
    const pivot = matrix.findIndex((row, index) => index >= col && row[col].n !== 0n);
    if (pivot < 0) return undefined;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    for (let row = col + 1; row < count; row++) {
      if (matrix[row][col].n === 0n) continue;
      const scale = divide(matrix[row][col], matrix[col][col]);
      for (let j = col + 1; j < columns; j++)
        matrix[row][j] = minus(matrix[row][j], multiply(scale, matrix[col][j]));
      matrix[row][col] = fraction(0n);
    }
  }
  const answers = Array.from({ length: count }, () =>
    Array.from({ length: columns - count }, () => fraction(0n)),
  );
  for (let row = count - 1; row >= 0; row--)
    for (let reward = 0; reward < columns - count; reward++) {
      let value = matrix[row][count + reward];
      for (let j = row + 1; j < count; j++)
        value = minus(value, multiply(matrix[row][j], answers[j][reward]));
      answers[row][reward] = divide(value, matrix[row][row]);
    }
  return answers;
}

export function benchmarkStarforce(
  rules: StarforceRules,
  config: StarforceConfig,
): StarforceBenchmark {
  assertConfig(rules, config);
  const empty = (status: 'already' | 'impossible'): StarforceBenchmark => {
    const value = status === 'already' ? 0 : Infinity;
    return {
      status,
      expectedMeso: value,
      expectedEnhancementMeso: value,
      expectedRestorationMeso: value,
      expectedReplacementMeso: value,
      expectedAttempts: value,
      expectedDestructions: value,
      expectedReplacementCopies: value,
      method: 'analytic',
    };
  };
  if (config.startStars >= config.targetStars) return empty('already');
  const states: number[] = [];
  const quotes = new Map<number, StarforceQuote>();
  const branches = new Map<number, { star: number; probability: Fraction }[]>();
  const pending = [config.startStars];
  while (pending.length) {
    const star = pending.pop()!;
    if (star >= config.targetStars || quotes.has(star)) continue;
    const quote = quoteStarforce(rules, config, { stars: star });
    quotes.set(star, quote);
    states.push(star);
    const raw = [
      { star: quote.successStar, probability: decimal(quote.successProbability) },
      { star, probability: decimal(quote.maintainProbability) },
      { star: quote.decreaseStar, probability: decimal(quote.decreaseProbability) },
      { star: quote.restoration?.toStars ?? star, probability: decimal(quote.destroyProbability) },
    ];
    const mass = raw.reduce((sum, row) => plus(sum, row.probability), fraction(0n));
    const normalized = raw
      .map((row) => ({ ...row, probability: divide(row.probability, mass) }))
      .filter((row) => row.probability.n > 0n);
    branches.set(star, normalized);
    for (const branch of normalized) pending.push(branch.star);
  }
  // Every reachable state must have a path to the target for almost-sure completion.
  const canFinish = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const star of states)
      if (
        !canFinish.has(star) &&
        branches
          .get(star)!
          .some((branch) => branch.star >= config.targetStars || canFinish.has(branch.star))
      ) {
        canFinish.add(star);
        changed = true;
      }
  }
  if (canFinish.size !== states.length) return empty('impossible');
  const indexes = new Map(states.map((star, index) => [star, index]));
  const matrix = states.map((star, index) => {
    const quote = quotes.get(star)!;
    const row = Array.from({ length: states.length + 5 }, () => fraction(0n));
    row[index] = fraction(1n);
    for (const branch of branches.get(star)!) {
      const destination = indexes.get(branch.star);
      if (destination !== undefined) row[destination] = minus(row[destination], branch.probability);
    }
    const sum = [
      quote.successProbability,
      quote.maintainProbability,
      quote.decreaseProbability,
      quote.destroyProbability,
    ]
      .map(decimal)
      .reduce(plus, fraction(0n));
    const destruction = divide(decimal(quote.destroyProbability), sum);
    row[states.length] = fraction(1n);
    row[states.length + 1] = destruction;
    row[states.length + 2] = fraction(quote.cost);
    row[states.length + 3] = multiply(destruction, fraction(quote.restoration?.mesoCost ?? 0n));
    row[states.length + 4] = multiply(
      destruction,
      fraction(quote.restoration?.equipmentCount ?? 0n),
    );
    return row;
  });
  const answer = solve(matrix, states.length)?.[indexes.get(config.startStars)!];
  if (!answer) return empty('impossible');
  const [
    expectedAttempts,
    expectedDestructions,
    expectedEnhancementMeso,
    expectedRestorationMeso,
    expectedReplacementCopies,
  ] = answer.map(numberFromFraction);
  const expectedReplacementMeso = expectedReplacementCopies * config.replacementPrice;
  return {
    status: 'ready',
    expectedAttempts,
    expectedDestructions,
    expectedEnhancementMeso,
    expectedRestorationMeso,
    expectedReplacementCopies,
    expectedReplacementMeso,
    expectedMeso: expectedEnhancementMeso + expectedRestorationMeso + expectedReplacementMeso,
    method: 'analytic',
  };
}
