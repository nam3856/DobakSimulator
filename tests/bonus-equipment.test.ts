import { describe, expect, it } from 'vitest';
import type { EquipmentSnapshot } from '../src/types';
import { bonusEquipmentFromItem, isBonusEquipment } from '../src/ui/bonus-equipment';

const item: EquipmentSnapshot = {
  id: 'test',
  name: '제네시스 피스톨',
  category: 'weapon',
  slot: '무기',
  level: 200,
  imageUrl: '',
  potential: [],
  additional: [],
  eligibleSoul: false,
  baseOptions: { attack: 249, magicAttack: 0 },
  bonusOptions: { attack: 120 },
};

describe('imported additional-option equipment', () => {
  it('uses unenhanced weapon power and keeps field weapons on normal tiers', () => {
    expect(bonusEquipmentFromItem(item)).toEqual({
      level: 200,
      kind: 'weapon',
      boss: true,
      baseAttack: 249,
      baseMagicAttack: 0,
    });
    // Official Update/357 lists Utgard and Pensalir as field equipment.
    expect(bonusEquipmentFromItem({ ...item, name: '우트가르드 피스톨', level: 140 }).boss).toBe(
      false,
    );
    expect(
      bonusEquipmentFromItem({
        ...item,
        name: '펜살리르 스키퍼햇',
        category: 'hat',
        slot: '모자',
        level: 140,
      }).boss,
    ).toBe(false);
  });

  it('offers normal weapons, armor and pocket items while excluding unsupported slots', () => {
    expect(isBonusEquipment(item)).toBe(true);
    expect(isBonusEquipment({ ...item, category: 'pocket', slot: '포켓 아이템' })).toBe(true);
    expect(isBonusEquipment({ ...item, category: 'unsupported', slot: '포켓 아이템' })).toBe(true);
    for (const category of ['ring', 'secondaryWeapon', 'emblem', 'shoulder', 'heart'])
      expect(isBonusEquipment({ ...item, category, slot: category })).toBe(false);
    expect(isBonusEquipment({ ...item, name: '봉인된 제네시스 피스톨' })).toBe(false);
    expect(isBonusEquipment({ ...item, level: 0 })).toBe(false);
    expect(isBonusEquipment({ ...item, level: 301 })).toBe(false);
  });
});
