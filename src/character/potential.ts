import type {
  CharacterProfile,
  EquipmentSnapshot,
  LineGrade,
  OptionLine,
  TargetCondition,
} from '../types.ts';
import { metricValue } from '../engine/metrics.ts';

export function parsePotentialLine(raw: string, grade: LineGrade = 'rare'): OptionLine {
  const text = raw.trim();
  const compact = text.normalize('NFKC').replace(/[\s:]/g, '').toUpperCase();
  const perLevel = compact.match(
    /(?:캐릭터기준)?(\d+)레벨당(STR|DEX|INT|LUK|공격력|마력)\+?(\d+(?:\.\d+)?)/,
  );
  const number = perLevel?.[3] ?? compact.match(/[+-]?\d+(?:\.\d+)?/)?.[0];
  let value = number ? Number(number) : 0;
  const percent = compact.includes('%');
  let type = 'unknown';
  let unit: OptionLine['unit'] = percent ? 'percent' : 'flat';
  if (perLevel) {
    const stat =
      perLevel[2] === '공격력'
        ? 'attack'
        : perLevel[2] === '마력'
          ? 'magicAttack'
          : perLevel[2].toLowerCase();
    type = `${stat}PerLevel`;
    unit = 'level';
  } else if (compact.includes('보스') && compact.includes('데미지')) type = 'bossDamagePercent';
  else if (compact.includes('일반몬스터') && compact.includes('데미지'))
    type = 'normalMonsterDamagePercent';
  else if (compact.includes('상태이상') && compact.includes('데미지'))
    type = 'statusAilmentDamagePercent';
  else if ((compact.includes('방어율') || compact.includes('방어력')) && compact.includes('무시'))
    type = 'ignoreDefensePercent';
  else if (compact.includes('크리티컬데미지')) type = 'criticalDamagePercent';
  else if (compact.includes('크리티컬확률')) type = 'criticalRatePercent';
  else if (compact.includes('재사용') && compact.includes('미적용')) type = 'cooldownSkipPercent';
  else if (compact.includes('재사용') && compact.includes('대기시간') && compact.includes('초')) {
    type = 'cooldownReductionSecond';
    value = Math.abs(value);
    unit = 'second';
  } else if (compact.includes('버프') && compact.includes('지속시간')) type = 'buffDurationPercent';
  else if (compact.includes('아이템드롭')) type = 'dropRatePercent';
  else if (compact.includes('메소획득')) type = 'mesoRatePercent';
  else if (compact.includes('경험치')) type = 'experiencePercent';
  else if (compact.includes('공격속도')) type = 'attackSpeedStep';
  else if (compact.includes('패시브스킬레벨')) type = 'passiveSkillLevel';
  else if (compact.includes('다수공격스킬') && compact.includes('공격대상'))
    type = 'extraAttackTargets';
  else if (compact.includes('올스탯') || compact.includes('모든능력치'))
    type = percent ? 'allStatPercent' : 'allStatFlat';
  else if (/^(STR|DEX|INT|LUK)[+-]?\d+(?:\.\d+)?%?(?:증가)?$/.test(compact)) {
    type = compact.slice(0, 3).toLowerCase() + (percent ? 'Percent' : 'Flat');
  } else if (/^(?:최대)?HP[+-]?\d+(?:\.\d+)?%?(?:증가)?$/.test(compact))
    type = percent ? 'hpPercent' : 'hpFlat';
  else if (/^(?:최대)?MP[+-]?\d+(?:\.\d+)?%?(?:증가)?$/.test(compact))
    type = percent ? 'mpPercent' : 'mpFlat';
  else if (/^마력[+-]?\d+(?:\.\d+)?%?(?:증가)?$/.test(compact))
    type = percent ? 'magicAttackPercent' : 'magicAttackFlat';
  else if (/^공격력[+-]?\d+(?:\.\d+)?%?(?:증가)?$/.test(compact))
    type = percent ? 'attackPercent' : 'attackFlat';
  else if (/^데미지[+-]?\d+(?:\.\d+)?%?(?:증가)?$/.test(compact)) type = 'damagePercent';
  if (type === 'unknown' || !Number.isFinite(value)) {
    type = 'unknown';
    value = 0;
    unit = 'text';
  }
  return { id: `${grade}:${text}`, type, value, unit, text, grade };
}

const WEAPON_CATEGORIES = new Set([
  'weapon',
  'secondaryWeapon',
  'forceShieldSoulRing',
  'shield',
  'emblem',
  '무기',
  '보조무기',
  '방패',
  '블레이드',
  '포스실드',
  '포스쉴드',
  '소울링',
  '소울실드',
  '엠블렘',
]);

/** JIJAKBI's option-family policy, expressed in the simulator's effective metrics. */
export function suggestPotentialTargets(
  item: EquipmentSnapshot,
  side: 'potential' | 'additional' | 'soul',
  profile: CharacterProfile,
): TargetCondition[] {
  if (profile.mainStats.length === 0) return [];
  const lines = side === 'soul' ? (item.soul?.lines ?? []) : item[side];
  const weapon = WEAPON_CATEGORIES.has(item.category) || WEAPON_CATEGORIES.has(item.slot);
  const metrics = new Set<string>();
  for (const line of lines) {
    if (line.type === 'unknown' || line.value <= 0) continue;
    const power = `${profile.attackType}Percent`;
    let allowed = false;
    if (side === 'soul' || weapon) {
      allowed = [power, 'bossDamagePercent', 'ignoreDefensePercent'].includes(line.type);
      if (['emblem', '엠블렘'].includes(item.category) && line.type === 'bossDamagePercent')
        allowed = false;
    } else {
      const stats =
        side === 'additional'
          ? profile.mainStats
          : [...profile.mainStats, ...profile.secondaryStats];
      allowed = stats.some(
        (stat) =>
          line.type === `${stat}Percent` ||
          (side === 'additional' && [`${stat}Flat`, `${stat}PerLevel`].includes(line.type)),
      );
      allowed ||= [
        'allStatPercent',
        'criticalDamagePercent',
        'cooldownReductionSecond',
        'dropRatePercent',
        'mesoRatePercent',
      ].includes(line.type);
      if (side === 'additional')
        allowed ||= [`${profile.attackType}Flat`, 'allStatFlat'].includes(line.type);
    }
    if (!allowed) continue;
    // STR/DEX/INT/LUK goals already include all-stat. An extra all-stat goal
    // would prevent an equally effective replacement by the character's stat.
    if (line.type === 'allStatPercent' || line.type === 'allStatFlat') {
      const suffix = line.type === 'allStatPercent' ? 'Percent' : 'Flat';
      for (const stat of profile.mainStats) {
        if (['str', 'dex', 'int', 'luk'].includes(stat)) metrics.add(`${stat}${suffix}`);
      }
    } else metrics.add(line.type);
  }
  return [...metrics].map((type) => ({ type, minValue: metricValue(lines, type) }));
}
