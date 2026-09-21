import type { CharacterSnapshot } from '../types';
import optimizerAvatars from './optimizer-avatars.json';

export const OPTIMIZER_WALK_SEQUENCE = [0, 1, 2, 1] as const;
export const OPTIMIZER_WALK_FRAME_MS = 160;

export const BUNDLED_OPTIMIZER_AVATARS: readonly {
  name: string;
  directory: string;
  job: string;
}[] = optimizerAvatars;

export interface OptimizerAvatarDescriptor {
  name: string;
  frames: readonly [string, string, string];
  fallbackSrc: string;
}

/** Walk1 supports frames 0–3; this UI deliberately uses the requested 1→2→3→2. */
export function buildOptimizerWalkUrl(baseUrl: string, frame: 1 | 2 | 3): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'open.api.nexon.com')
    throw new Error('넥슨에서 제공한 캐릭터 이미지 주소가 필요합니다.');
  for (const [key, value] of Object.entries({
    action: `A02.${frame}`,
    emotion: 'E00.0',
    width: '240',
    height: '200',
    x: '120',
    y: '150',
  }))
    url.searchParams.set(key, value);
  return url.toString();
}

/** Create once when calculation starts, so the random character stays stable. */
export function createOptimizerAvatar(
  character?: Pick<CharacterSnapshot, 'name' | 'imageUrl'>,
  random: () => number = Math.random,
  baseUrl = import.meta.env.BASE_URL,
): OptimizerAvatarDescriptor {
  const base = `${baseUrl.replace(/\/?$/, '/')}character/`;
  const fallbackSrc = `${base}neutral.png`;
  const matching = BUNDLED_OPTIMIZER_AVATARS.find((entry) => entry.name === character?.name);
  const bundled = character
    ? matching
    : BUNDLED_OPTIMIZER_AVATARS[Math.min(2, Math.max(0, Math.floor(random() * 3)))];
  if (bundled) {
    const prefix = `${base}optimizer/${bundled.directory}/walk-`;
    return {
      name: bundled.name,
      frames: [`${prefix}1.png`, `${prefix}2.png`, `${prefix}3.png`],
      fallbackSrc,
    };
  }
  try {
    return {
      name: character!.name,
      frames: [1, 2, 3].map((frame) =>
        buildOptimizerWalkUrl(character!.imageUrl, frame as 1 | 2 | 3),
      ) as [string, string, string],
      fallbackSrc,
    };
  } catch {
    return {
      name: character?.name ?? BUNDLED_OPTIMIZER_AVATARS[0].name,
      frames: [fallbackSrc, fallbackSrc, fallbackSrc],
      fallbackSrc,
    };
  }
}
