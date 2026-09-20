import type { CharacterSnapshot } from '../types.ts';

/** Add newly shipped metadata to saved default characters without resetting a session. */
export function mergeMissingBundledBonusMetadata(
  stored: CharacterSnapshot,
  bundled: CharacterSnapshot,
): CharacterSnapshot {
  if (!stored.bundledAvatars || stored.name !== bundled.name || stored.world !== bundled.world)
    return stored;

  let changed = false;
  const equipmentPresets = { ...stored.equipmentPresets };
  for (const [preset, items] of Object.entries(stored.equipmentPresets)) {
    let presetChanged = false;
    const merged = items.map((item) => {
      const source = bundled.equipmentPresets[preset]?.find(
        (candidate) =>
          candidate.name === item.name &&
          candidate.slot === item.slot &&
          candidate.level === item.level,
      );
      if (!source) return item;
      const addBonus = item.bonusOptions === undefined && source.bonusOptions !== undefined;
      const addBase = item.baseOptions === undefined && source.baseOptions !== undefined;
      const addPocket =
        item.category === 'unsupported' &&
        source.category === 'pocket' &&
        item.slot.replace(/\s/g, '') === '포켓아이템';
      if (!addBonus && !addBase && !addPocket) return item;
      changed = true;
      presetChanged = true;
      return {
        ...item,
        ...(addBonus ? { bonusOptions: { ...source.bonusOptions } } : {}),
        ...(addBase ? { baseOptions: { ...source.baseOptions } } : {}),
        ...(addPocket ? { category: 'pocket' } : {}),
      };
    });
    if (presetChanged) equipmentPresets[preset] = merged;
  }
  if (!changed) return stored;
  return {
    ...stored,
    equipmentPresets,
    ...(stored.bonusOptionsFetchedAt === undefined && bundled.bonusOptionsFetchedAt !== undefined
      ? { bonusOptionsFetchedAt: bundled.bonusOptionsFetchedAt }
      : {}),
  };
}
