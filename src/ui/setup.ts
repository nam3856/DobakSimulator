import type {
  CharacterSnapshot,
  CubeType,
  EquipmentSnapshot,
  Goal,
  OptionLine,
  SimulationConfig,
  SimulatorMode,
} from '../types';
import { suggestPotentialTargets } from '../character';
import { getLineOptions } from '../engine';
import type { RuleData } from '../engine/rules';
import { isPrime, RULE_VERSION } from './constants';
const norm = (x: string) =>
  x
    .normalize('NFKC')
    .replace(/[\s:：+]/g, '')
    .toUpperCase();

export function lowerFirstGoal(target: Goal): Goal | undefined {
  if (
    target.mode !== 'ability' ||
    target.match !== 'all' ||
    target.conditions.length !== 3 ||
    new Set(target.conditions.map((c) => c.type)).size !== 3 ||
    target.conditions.some((c) => (c.count ?? 1) !== 1)
  )
    return undefined;
  return {
    ...target,
    conditions: target.conditions.map((condition, index) => ({
      ...condition,
      slot: index === 0 ? 0 : undefined,
      slots: index === 0 ? undefined : [1, 2],
    })),
  };
}
export function reconcileLines(
  data: RuleData,
  config: SimulationConfig,
  lines: OptionLine[],
): OptionLine[] {
  return lines.map((line, slot) => {
    try {
      const pool = getLineOptions(data, config, slot);
      return (
        pool.find((x) => norm(x.text) === norm(line.text) && x.grade === line.grade) ??
        pool.find((x) => norm(x.text) === norm(line.text)) ??
        (line.type !== 'unknown'
          ? (pool.find(
              (x) => x.type === line.type && x.value === line.value && x.grade === line.grade,
            ) ?? pool.find((x) => x.type === line.type && x.value === line.value))
          : undefined) ??
        line
      );
    } catch {
      return line;
    }
  });
}
export function makeConfig(
  data: RuleData,
  character: CharacterSnapshot,
  item: EquipmentSnapshot | undefined,
  mode: SimulatorMode,
  cubeType: CubeType,
  playMode: 'recreate' | 'upgrade',
  abilityPreset: string,
): SimulationConfig {
  const side =
    cubeType === 'additional' || cubeType === 'primeAdditional' ? 'additional' : 'potential';
  const currentGrade =
    mode === 'ability'
      ? 'legendary'
      : mode === 'soulPotential'
        ? (item?.soul?.grade ?? 'rare')
        : (item?.[side === 'potential' ? 'potentialGrade' : 'additionalGrade'] ?? 'legendary');
  const target: Goal = {
    mode: mode === 'soulAmplification' ? 'stage' : mode === 'ability' ? 'ability' : 'sum',
    minimumGrade:
      mode === 'ability'
        ? 'legendary'
        : mode === 'soulPotential'
          ? (item?.soul?.grade ?? 'legendary')
          : currentGrade,
    conditions: [],
    lines: [],
    stage: Math.max(1, item?.soul?.stage ?? 4),
    match: 'all',
  };
  if (mode === 'soulAmplification' && !item?.soul?.stage) target.stage = 4;
  const config: SimulationConfig = {
    mode,
    cubeType,
    category: item?.category ?? 'weapon',
    level: item?.level ?? 200,
    start: {
      grade: isPrime(cubeType) && mode === 'cube' ? 'legendary' : currentGrade,
      lines: [],
      stage:
        mode === 'soulAmplification'
          ? playMode === 'upgrade'
            ? (item?.soul?.stage ?? 0)
            : 0
          : Math.max(1, item?.soul?.stage ?? 1),
      failures: 0,
    },
    lockedSlots: [],
    abilityStrategy: mode === 'ability' ? 'lowerFirst' : undefined,
    batchSize: mode === 'soulAmplification' ? 1 : 3,
    target,
    unitPrices: {},
    ruleVersion: RULE_VERSION,
  };
  if (mode === 'soulAmplification') return config;
  if (mode === 'ability') {
    const ability =
      character.abilityPresets[abilityPreset] ?? Object.values(character.abilityPresets)[0];
    const lines = reconcileLines(data, config, ability?.lines ?? []);
    config.target.lines = lines;
    config.target.conditions = lines.map((line, slot) => {
      const type = line.type === 'unknown' ? (line.abilityTypeId ?? line.type) : line.type;
      const lower = Object.values(data.ability.grades).some((g) =>
        g?.options.some((o) => (o.id === type || o.type === type) && o.valueDirection === 'lower'),
      );
      return {
        type,
        minValue: lower ? 0 : line.value,
        ...(lower ? { maxValue: line.value } : {}),
        minGrade: line.grade === 'normal' ? 'rare' : line.grade,
        ...(slot === 0 ? { slot: 0 } : { slots: [1, 2] }),
      };
    });
    if (playMode === 'upgrade') config.start.lines = lines;
    if (lines.length !== 3 || new Set(config.target.conditions.map((c) => c.type)).size !== 3)
      config.abilityStrategy = 'fixed';
  } else {
    const raw = mode === 'soulPotential' ? (item?.soul?.lines ?? []) : (item?.[side] ?? []);
    const lines = reconcileLines(
      data,
      { ...config, start: { ...config.start, grade: target.minimumGrade } },
      raw,
    );
    config.target.lines = lines;
    if (item)
      config.target.conditions = suggestPotentialTargets(
        item,
        mode === 'soulPotential' ? 'soul' : side,
        character.profile,
      );
    if (mode === 'soulPotential' && !raw.length)
      config.target.conditions = [
        { type: `${character.profile.attackType}Percent`, minValue: config.start.stage * 5 },
      ];
    if (!item && mode === 'cube')
      config.target.conditions = [{ type: `${character.profile.attackType}Percent`, minValue: 21 }];
    if (playMode === 'upgrade') config.start.lines = lines;
    else if (mode === 'cube' && isPrime(cubeType) && lines[0]) config.start.lines = [lines[0]];
  }
  return config;
}
