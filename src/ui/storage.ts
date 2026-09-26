import type { CharacterSnapshot, SimulationConfig, SimulationState } from '../types';
import { abilityProgress, usesAbilityProgression } from '../engine/ability-strategy';
import { withDefaultEtherPrices } from '../engine/soul-cost';
export interface StoredSession {
  version: 1;
  character: CharacterSnapshot;
  config: SimulationConfig;
  state: SimulationState;
  equipmentPreset: string;
  abilityPreset: string;
  equipmentId: string;
  playMode: 'recreate' | 'upgrade';
}
const KEY = 'isekai-jikjak:session:v1';
const validGrade = (x: unknown) =>
  ['normal', 'rare', 'epic', 'unique', 'legendary'].includes(String(x));
const validLocks = (x: unknown) =>
  Array.isArray(x) &&
  x.length <= 2 &&
  new Set(x).size === x.length &&
  x.every((slot) => [0, 1, 2].includes(slot));
const validLines = (x: unknown) =>
  Array.isArray(x) &&
  x.every(
    (line) =>
      line &&
      typeof line.text === 'string' &&
      typeof line.type === 'string' &&
      Number.isFinite(line.value) &&
      validGrade(line.grade),
  );
const validCost = (x: unknown) => {
  if (!x || typeof x !== 'object') return false;
  const cost = x as SimulationState['spent'];
  return (
    [cost.meso, cost.cubes, cost.honor, cost.credits].every(
      (value) => typeof value === 'bigint' && value >= 0n,
    ) &&
    Array.isArray(cost.ethers) &&
    cost.ethers.length === 4 &&
    cost.ethers.every((value) => typeof value === 'bigint' && value >= 0n)
  );
};
export function serialize(value: unknown) {
  return JSON.stringify(value, (_key, value) =>
    typeof value === 'bigint' ? { $bigint: value.toString() } : value,
  );
}
export function deserialize<T>(value: string): T {
  return JSON.parse(value, (_key, value) =>
    value &&
    typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    typeof value.$bigint === 'string'
      ? BigInt(value.$bigint)
      : value,
  ) as T;
}
export function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const x = deserialize<StoredSession>(raw);
    if (
      x.version !== 1 ||
      !x.character?.name ||
      !['cube', 'ability', 'soulAmplification', 'soulPotential'].includes(x.config?.mode) ||
      !['black', 'additional', 'gold', 'prime', 'primeAdditional'].includes(x.config?.cubeType) ||
      !validLines(x.config?.start?.lines) ||
      !validGrade(x.config?.start?.grade) ||
      (x.config.retryStart !== undefined &&
        (!x.config.retryStart ||
          !validLines(x.config.retryStart.lines) ||
          x.config.retryStart.lines.length !== 3 ||
          !['rare', 'epic', 'unique', 'legendary'].includes(x.config.retryStart.grade) ||
          !Number.isInteger(x.config.retryStart.stage) ||
          x.config.retryStart.stage < 0 ||
          x.config.retryStart.stage > 4 ||
          !Number.isInteger(x.config.retryStart.failures) ||
          x.config.retryStart.failures < 0)) ||
      !Array.isArray(x.config?.lockedSlots) ||
      (x.config.miracleTime !== undefined && typeof x.config.miracleTime !== 'boolean') ||
      (x.config.abilityResetMode !== undefined &&
        !['normal', 'advanced'].includes(x.config.abilityResetMode)) ||
      (x.config.abilityStrategy !== undefined &&
        !['lowerFirst', 'firstLocked', 'fixed'].includes(x.config.abilityStrategy)) ||
      (x.state?.lockedSlots !== undefined && !validLocks(x.state.lockedSlots)) ||
      !x.config?.unitPrices ||
      !Array.isArray(x.config?.target?.conditions) ||
      !validLines(x.config?.target?.lines) ||
      !x.character.equipmentPresets ||
      !x.character.abilityPresets ||
      !x.character.profile?.mainStats ||
      !validLines(x.state?.lines) ||
      !validGrade(x.state?.grade) ||
      !Array.isArray(x.state?.history) ||
      !Array.isArray(x.state?.candidates) ||
      ![...x.state.history, ...x.state.candidates].every(
        (r) => r && validLines(r.lines) && validCost(r.cost) && typeof r.sequence === 'bigint',
      ) ||
      typeof x.state?.attempts !== 'bigint' ||
      !validCost(x.state?.spent)
    )
      return null;
    if (x.config.mode === 'soulAmplification')
      x.config.unitPrices = withDefaultEtherPrices(x.config.unitPrices);
    if (usesAbilityProgression(x.config))
      x.state.lockedSlots = abilityProgress(x.config, x.state.lines).lockedSlots;
    return x;
  } catch {
    return null;
  }
}
export function saveSession(value: StoredSession): boolean {
  try {
    localStorage.setItem(KEY, serialize(value));
    return true;
  } catch {
    return false;
  }
}
export function archiveSession(config: SimulationConfig, state: SimulationState) {
  if (state.attempts === 0n) return;
  try {
    const key = 'isekai-jikjak:archive:v1';
    const raw = localStorage.getItem(key);
    const records = raw ? deserialize<unknown[]>(raw) : [];
    localStorage.setItem(
      key,
      serialize(
        [
          {
            config,
            state: { ...state, history: state.history.slice(0, 10) },
            savedAt: new Date().toISOString(),
          },
          ...records,
        ].slice(0, 8),
      ),
    );
  } catch {
    /* The active challenge always continues when storage is unavailable. */
  }
}
