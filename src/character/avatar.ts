import type { LuckReaction } from '../types.ts';

/** Nexon's character_image action/emotion parameters, documented 2025-01-16. */
export type AvatarReaction = LuckReaction;

export const AVATAR_POSES: Record<AvatarReaction, { action: string; emotion: string }> = {
  cry: { action: 'A04.0', emotion: 'E03.0' },
  neutral: { action: 'A00.0', emotion: 'E00.0' },
  happy: { action: 'A00.0', emotion: 'E02.0' },
  jackpot: { action: 'A06.0', emotion: 'E02.0' },
};

export function buildAvatarUrl(baseUrl: string, reaction: AvatarReaction): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'open.api.nexon.com') {
    throw new Error('넥슨에서 제공한 캐릭터 이미지 주소가 필요합니다.');
  }
  const pose = AVATAR_POSES[reaction];
  url.searchParams.set('action', pose.action);
  url.searchParams.set('emotion', pose.emotion);
  url.searchParams.set('width', '240');
  url.searchParams.set('height', '200');
  url.searchParams.set('x', '120');
  url.searchParams.set('y', '150');
  return url.toString();
}

export const AVATAR_REACTION_LABELS: Record<AvatarReaction, string> = {
  cry: '기댓값보다 많이 써서 엎드려 우는 캐릭터',
  neutral: '기댓값 근처에서 담담하게 서 있는 캐릭터',
  happy: '기댓값보다 적게 써서 웃고 있는 캐릭터',
  jackpot: '행운의 상위 10% 결과에 신나게 점프하는 캐릭터',
};
