/** Deterministic, independent benchmark random stream. Gameplay uses cryptoRandom. */
export function seededRandom(seed: string | number): () => number {
  let h = 2166136261;
  for (const char of String(seed)) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  return () => ((next() >>> 5) * 67108864 + (next() >>> 6) + 1) / 9007199254740994;
}

export function cryptoRandom(): number {
  const values = new Uint32Array(2);
  globalThis.crypto.getRandomValues(values);
  return ((values[0] >>> 5) * 67108864 + (values[1] >>> 6) + 1) / 9007199254740994;
}

export function sampleWeighted<T>(
  values: readonly T[],
  weight: (value: T) => number,
  rng: () => number,
): T {
  let total = 0;
  for (const value of values) total += weight(value);
  if (!(total > 0) || !Number.isFinite(total)) throw new Error('추첨 가능한 옵션이 없습니다.');
  let remaining = Math.min(1 - Number.EPSILON, Math.max(0, rng())) * total;
  for (const value of values) {
    remaining -= weight(value);
    if (remaining < 0) return value;
  }
  return values[values.length - 1];
}

/** Number of trials including the first success; logarithms remain stable for rare targets. */
export function geometric(p: number, rng: () => number): number {
  if (!(p > 0)) return Infinity;
  if (p >= 1) return 1;
  const u = Math.min(1 - Number.EPSILON, Math.max(Number.MIN_VALUE, rng()));
  return Math.floor(Math.log1p(-u) / Math.log1p(-p)) + 1;
}

export function geometricCdf(p: number, trials: number): number {
  if (trials < 1 || !(p > 0)) return 0;
  if (p >= 1) return 1;
  return -Math.expm1(Math.floor(trials) * Math.log1p(-p));
}

export function normalized<T extends { probability: number }>(rows: readonly T[]): T[] {
  const sum = rows.reduce((total, row) => total + row.probability, 0);
  if (!(sum > 0)) throw new Error('확률 합계가 0입니다.');
  return rows.map((row) => ({ ...row, probability: row.probability / sum }));
}

export function lowerBound(values: ArrayLike<number>, x: number): number {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function upperBound(values: ArrayLike<number>, x: number): number {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sampleCdf(cdf: ArrayLike<number>, rng: () => number): number {
  return Math.min(cdf.length - 1, upperBound(cdf, rng()));
}

export function finiteGeometricMean(p: number, maximum: number): number {
  if (maximum <= 0) return 0;
  if (p <= 0) return maximum;
  if (p >= 1) return 1;
  return -Math.expm1(maximum * Math.log1p(-p)) / p;
}

export function safeBigInt(value: string | number | bigint | undefined): bigint {
  if (value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('재화는 0 이상의 정확한 정수로 입력해주세요.');
    return BigInt(value);
  }
  if (!/^\d+$/.test(value)) throw new Error('재화는 0 이상의 정수로 입력해주세요.');
  return BigInt(value);
}

export function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function stableStringify(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
