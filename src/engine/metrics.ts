import type { OptionLine } from '../types.ts';

/** Shared by gameplay, benchmarks and the Node-based character import scripts. */
export function metricValue(lines: readonly OptionLine[], type: string): number {
  if (type === 'ignoreDefensePercent')
    return (
      (1 - lines.filter((l) => l.type === type).reduce((p, l) => p * (1 - l.value / 100), 1)) * 100
    );
  const allStat = ['strPercent', 'dexPercent', 'intPercent', 'lukPercent'].includes(type)
    ? 'allStatPercent'
    : ['strFlat', 'dexFlat', 'intFlat', 'lukFlat'].includes(type)
      ? 'allStatFlat'
      : undefined;
  if (allStat) {
    return lines.reduce(
      (sum, line) => sum + (line.type === type || line.type === allStat ? line.value : 0),
      0,
    );
  }
  return lines.reduce((sum, line) => sum + (line.type === type ? line.value : 0), 0);
}
