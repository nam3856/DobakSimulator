import type { CharacterProfile, Goal, RollResult, SimulationConfig } from '../types';
import { metricValue } from '../engine/target';

const COMMON_METRICS = [
  'bossDamagePercent',
  'ignoreDefensePercent',
  'damagePercent',
  'criticalDamagePercent',
  'criticalRatePercent',
  'cooldownReductionSecond',
  'dropRatePercent',
  'mesoRatePercent',
] as const;

/** A hypothetical goal for matching or improving every useful stat in this result. */
export function makeResultGoal(
  config: SimulationConfig,
  result: RollResult,
  profile: CharacterProfile,
): Goal | undefined {
  if (config.mode !== 'cube' && config.mode !== 'soulPotential') return undefined;

  // Keep distinct units separate: percent, flat and per-level values are not exchangeable.
  // All-stat lines contribute through the same metricValue used by automatic target checks.
  const stats = profile.mainStats.filter((stat) =>
    ['str', 'dex', 'int', 'luk', 'hp'].includes(stat),
  );
  const metrics = new Set([
    ...stats.flatMap((stat) =>
      stat === 'hp'
        ? ['hpPercent', 'hpFlat']
        : [`${stat}Percent`, `${stat}Flat`, `${stat}PerLevel`],
    ),
    `${profile.attackType}Percent`,
    `${profile.attackType}Flat`,
    `${profile.attackType}PerLevel`,
    ...COMMON_METRICS,
  ]);
  const conditions = [...metrics].flatMap((type) => {
    const minValue = metricValue(result.lines, type);
    return Number.isFinite(minValue) && minValue > 0 ? [{ type, minValue }] : [];
  });
  if (!conditions.length) return undefined;

  return {
    mode: 'sum',
    minimumGrade: result.grade,
    conditions,
    lines: [],
    stage: result.stage,
    match: 'all',
  };
}
