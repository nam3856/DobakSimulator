import type { CharacterSnapshot, EquipmentSnapshot } from '../types';
import type { BonusConfig, BonusEquipment, BonusStats } from '../engine/bonus-options';
import { BONUS_STAT_LABELS, defaultBonusWeights, scoreBonusStats } from '../engine/bonus-options';

export function completeBonusStats(stats?: Partial<BonusStats>): BonusStats | undefined {
  return stats &&
    Object.keys(BONUS_STAT_LABELS).every((key) => Number.isFinite(stats[key as keyof BonusStats]))
    ? (stats as BonusStats)
    : undefined;
}

const categories = new Set([
  'weapon',
  'hat',
  'top',
  'overall',
  'bottom',
  'shoes',
  'gloves',
  'cape',
  'belt',
  'faceAccessory',
  'eyeAccessory',
  'earring',
  'pendant',
  'pocket',
]);
export function isBonusEquipment(item: EquipmentSnapshot) {
  return (
    item.level > 0 &&
    item.level <= 300 &&
    (categories.has(item.category) || item.slot.replace(/\s/g, '') === '포켓아이템') &&
    !/봉인된\s*제네시스/.test(item.name)
  );
}

// Suggested starting value only: the API has no boss-advantage flag. In particular,
// Utgard is field gear (official Update/357), so it must not default to boss tiers.
const bossNames =
  /에테르넬|아케인셰이드|앱솔랩스|파프니르|하이네스|이글아이|트릭스터|제네시스|데스티니|네크로|반\s*레온|여제|라이온하트|드래곤테일|팔콘윙|레이븐혼|샤크투스|블랙빈\s*마크|파풀라투스\s*마크|아쿠아틱\s*레터|응축된\s*힘|데아\s*시두스|지옥의\s*불꽃|골든\s*클로버|분노한\s*자쿰|혼테일의\s*목걸이|카오스\s*혼테일|도미네이터|매커네이터|핑크빛\s*성배|영생의\s*돌|성배|컨트롤\s*머신|마력이\s*깃든\s*안대|커맨더\s*포스|고통의\s*근원|몽환의\s*벨트|마도서|데이브레이크|트와일라이트|에스텔라|컴플리트\s*언더컨트롤|근원의\s*속삭임/;

export function bonusEquipmentFromItem(item?: EquipmentSnapshot): BonusEquipment {
  return {
    level: item?.level ?? 200,
    kind: item?.category === 'weapon' ? 'weapon' : 'armor',
    boss: item ? bossNames.test(item.name) : true,
    baseAttack: item?.baseOptions?.attack,
    baseMagicAttack: item?.baseOptions?.magicAttack,
  };
}

export function initialBonusConfig(
  character: CharacterSnapshot,
  item?: EquipmentSnapshot,
): BonusConfig {
  const main = character.profile.mainStats[0];
  const mainStat =
    main === 'str' || main === 'dex' || main === 'int' || main === 'luk' ? main : 'str';
  const weights = defaultBonusWeights(mainStat, character.profile.attackType);
  if (character.profile.mainStats.includes('hp')) {
    for (const key of Object.keys(weights)) delete weights[key as keyof typeof weights];
    Object.assign(weights, { hp: 1, attack: 100 });
  } else if (character.profile.mainStats.length > 1) {
    weights.allStat = 20;
    for (const stat of character.profile.mainStats)
      if (stat === 'str' || stat === 'dex' || stat === 'int' || stat === 'luk') weights[stat] = 1;
  }
  const initialScore = scoreBonusStats(item?.bonusOptions ?? {}, weights);
  return {
    equipment: bonusEquipmentFromItem(item),
    flame: 'meso',
    weights,
    targetScore: Math.max(
      character.profile.mainStats.includes('hp') ? 5000 : 120,
      Math.ceil(initialScore / 10) * 10 + 10,
    ),
  };
}

export type ImportedBonusStats = Partial<BonusStats>;
