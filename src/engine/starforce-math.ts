export interface Fraction {
  n: bigint;
  d: bigint;
}
export const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a;
};
export function fraction(n: bigint, d = 1n): Fraction {
  if (d === 0n) throw new Error('스타포스 기댓값 방정식이 특이합니다.');
  if (n === 0n) return { n: 0n, d: 1n };
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
export function decimal(value: number): Fraction {
  const [mantissa, exponent = '0'] = value.toString().split('e');
  const digits = (mantissa.split('.')[1] ?? '').length - Number(exponent);
  const n = BigInt(mantissa.replace('.', ''));
  return digits >= 0 ? fraction(n, 10n ** BigInt(digits)) : fraction(n * 10n ** BigInt(-digits));
}
export const plus = (a: Fraction, b: Fraction) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
export const minus = (a: Fraction, b: Fraction) => fraction(a.n * b.d - b.n * a.d, a.d * b.d);
export const multiply = (a: Fraction, b: Fraction) => fraction(a.n * b.n, a.d * b.d);
export const divide = (a: Fraction, b: Fraction) => fraction(a.n * b.d, a.d * b.n);
export function numberFromFraction(value: Fraction): number {
  const numerator = Number(value.n),
    denominator = Number(value.d);
  if (Number.isFinite(numerator) && Number.isFinite(denominator)) return numerator / denominator;
  const n = value.n.toString(),
    d = value.d.toString();
  return (Number(n.slice(0, 15)) / Number(d.slice(0, 15))) * 10 ** (n.length - d.length);
}
/** Exact rational elimination avoids subtractive cancellation for remote targets.
 * Probabilities and rewards are rational; only the final display means become floats. */
export function solve(matrix: Fraction[][], count: number): Fraction[][] | undefined {
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
