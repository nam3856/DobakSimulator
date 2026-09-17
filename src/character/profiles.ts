import type { CharacterProfile } from '../types.ts';

// Adapted from the user's JIJAKBI rules/potential-profiles.json (2026-09-04).
const GROUPS = {
  str: [
    '히어로',
    '팔라딘',
    '다크나이트',
    '소울마스터',
    '미하일',
    '블래스터',
    '데몬슬레이어',
    '아란',
    '카이저',
    '아델',
    '렌',
    '제로',
    '바이퍼',
    '캐논슈터',
    '캐논마스터',
    '스트라이커',
    '은월',
    '아크',
  ],
  dex: [
    '보우마스터',
    '신궁',
    '패스파인더',
    '윈드브레이커',
    '와일드헌터',
    '카인',
    '캡틴',
    '메카닉',
    '엔젤릭버스터',
    '메르세데스',
  ],
  int: [
    '아크메이지(불,독)',
    '아크메이지(불독)',
    '불독',
    '아크메이지(썬,콜)',
    '아크메이지(썬콜)',
    '썬콜',
    '비숍',
    '플레임위자드',
    '배틀메이지',
    '에반',
    '루미너스',
    '일리움',
    '라라',
    '키네시스',
    '레테',
  ],
  luk: ['나이트로드', '섀도어', '듀얼블레이드', '나이트워커', '팬텀', '카데나', '칼리', '호영'],
};

export function resolveCharacterProfile(job: string): CharacterProfile {
  const name = job.replace(/\s/g, '');
  if (name === '제논')
    return { mainStats: ['str', 'dex', 'luk'], secondaryStats: [], attackType: 'attack' };
  if (name === '데몬어벤져')
    return { mainStats: ['hp'], secondaryStats: ['str'], attackType: 'attack' };
  for (const [stat, names] of Object.entries(GROUPS)) {
    if (names.includes(name))
      return {
        mainStats: [stat],
        secondaryStats: [
          ({ str: 'dex', dex: 'str', int: 'luk', luk: 'dex' } as Record<string, string>)[stat],
        ],
        attackType: stat === 'int' ? 'magicAttack' : 'attack',
      };
  }
  // An empty profile deliberately prevents automatic recommendations.
  return { mainStats: [], secondaryStats: [], attackType: 'attack' };
}
