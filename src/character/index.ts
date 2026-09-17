import type { CharacterSnapshot, LuckReaction } from '../types.ts';

export { getCharacter, CharacterApiError } from './client.ts';
export { normalizeCharacter, normalizeEquipmentCategory, normalizeGrade } from './normalize.ts';
export { parsePotentialLine, suggestPotentialTargets } from './potential.ts';
export { resolveCharacterProfile } from './profiles.ts';
export { buildAvatarUrl, AVATAR_POSES, AVATAR_REACTION_LABELS } from './avatar.ts';

export function getDefaultAvatarPath(reaction: LuckReaction, baseUrl = './'): string {
  return `${baseUrl.replace(/\/?$/, '/')}character/${reaction}.png`;
}

export async function loadDefaultCharacter(baseUrl = './'): Promise<CharacterSnapshot> {
  const response = await fetch(`${baseUrl.replace(/\/?$/, '/')}character/snapshot.json`);
  if (!response.ok)
    throw new Error('기본 캐릭터를 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
  const snapshot = (await response.json()) as CharacterSnapshot;
  if (!snapshot.name || !snapshot.equipmentPresets || !snapshot.abilityPresets)
    throw new Error('기본 캐릭터 정보가 올바르지 않습니다.');
  return { ...snapshot, bundledAvatars: true };
}
