export function formatAmount(value: bigint | number, compact = true): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return value === Infinity ? '∞' : '—';
  const int = typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.round(value)));
  if (!compact) return int.toLocaleString('ko-KR');
  if (int < 10000n) return int.toLocaleString('ko-KR');
  const bands: [bigint, string][] = [
    [100000000000000000000n, '해'],
    [10000000000000000n, '경'],
    [1000000000000n, '조'],
    [100000000n, '억'],
    [10000n, '만'],
  ];
  for (const [size, label] of bands)
    if (int >= size) {
      const whole = int / size;
      const decimals = ((int % size) * 100n) / size;
      return (
        whole.toLocaleString('ko-KR') +
        (decimals ? '.' + decimals.toString().padStart(2, '0').replace(/0$/, '') : '') +
        label
      );
    }
  return int.toString();
}
export function formatPercent(value: number | undefined) {
  return value === undefined || !Number.isFinite(value)
    ? '—'
    : value < 0.01 && value > 0
      ? '<0.01'
      : value.toFixed(2);
}
export function safePrice(value: string | undefined) {
  try {
    return BigInt(value || '0');
  } catch {
    return 0n;
  }
}
