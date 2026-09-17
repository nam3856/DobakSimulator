import type {
  AbilitySnapshot,
  CharacterSnapshot,
  EquipmentSnapshot,
  Grade,
  LineGrade,
  OptionLine,
} from '../types.ts';
import { parsePotentialLine } from './potential.ts';
import { resolveCharacterProfile } from './profiles.ts';

type JsonObject = Record<string, unknown>;
const object = (input: unknown): JsonObject =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as JsonObject) : {};
const rows = (input: unknown): JsonObject[] => (Array.isArray(input) ? input.map(object) : []);
const string = (input: unknown): string => (typeof input === 'string' ? input.trim() : '');
const number = (input: unknown, fallback = 0): number => {
  if (input === null || input === undefined || input === '') return fallback;
  const value = Number(input);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const image = (input: unknown): string => {
  try {
    const value = new URL(string(input));
    return value.protocol === 'https:' ? value.toString() : '';
  } catch {
    return '';
  }
};

export function normalizeGrade(input: unknown): Grade | undefined {
  return (
    {
      레어: 'rare',
      에픽: 'epic',
      유니크: 'unique',
      레전드리: 'legendary',
      레전더리: 'legendary',
      rare: 'rare',
      epic: 'epic',
      unique: 'unique',
      legendary: 'legendary',
    } as Record<string, Grade>
  )[string(input).toLowerCase()];
}

const CATEGORIES: Record<string, string> = {
  무기: 'weapon',
  엠블렘: 'emblem',
  보조무기: 'secondaryWeapon',
  블레이드: 'secondaryWeapon',
  포스실드: 'forceShieldSoulRing',
  포스쉴드: 'forceShieldSoulRing',
  소울링: 'forceShieldSoulRing',
  방패: 'shield',
  모자: 'hat',
  상의: 'top',
  한벌옷: 'overall',
  하의: 'bottom',
  신발: 'shoes',
  장갑: 'gloves',
  망토: 'cape',
  벨트: 'belt',
  어깨장식: 'shoulder',
  얼굴장식: 'faceAccessory',
  눈장식: 'eyeAccessory',
  귀고리: 'earring',
  귀걸이: 'earring',
  반지: 'ring',
  펜던트: 'pendant',
  기계심장: 'heart',
  심장: 'heart',
};

export function normalizeEquipmentCategory(part: string, slot: string): string {
  const compactPart = part.replace(/\s/g, '');
  const compactSlot = slot.replace(/[\s\d]/g, '');
  // API uses the weapon class as part (e.g. 한손검), but its slot is 무기.
  if (compactSlot === '무기') return 'weapon';
  if (compactSlot === '엠블렘') return 'emblem';
  return CATEGORIES[compactPart] ?? CATEGORIES[compactSlot] ?? 'unsupported';
}

function optionLines(raw: JsonObject, prefix: string, grade: LineGrade): OptionLine[] {
  const values = [1, 2, 3].map((index) => string(raw[`${prefix}_${index}`]));
  if (values.every((value) => !value)) return [];
  return values.map((value) => parsePotentialLine(value, grade));
}

function equipmentItem(raw: JsonObject, preset: string, index: number): EquipmentSnapshot {
  const name = string(raw.item_name) || '알 수 없는 장비';
  const part = string(raw.item_equipment_part);
  const slot = string(raw.item_equipment_slot) || part;
  const category = normalizeEquipmentCategory(part, slot);
  const potentialGrade = normalizeGrade(raw.potential_option_grade);
  const additionalGrade = normalizeGrade(raw.additional_potential_option_grade);
  const soulGrade = normalizeGrade(raw.soul_potential_grade);
  const soulName = string(raw.soul_name);
  const baseLevel = number(object(raw.item_base_option).base_equipment_level);
  const expiration = string(raw.date_expire);
  const hasExpiration =
    expiration !== '' && !['permanent', '영구', '없음'].includes(expiration.toLowerCase());
  // Update 813 permits Zero/Genesis growth and Destiny transfer. Family names
  // alone are not exclusions. The API does not expose the Genesis quest flag.
  const sealedGenesis = name.replace(/\s/g, '').includes('봉인된제네시스');
  const eligibleSoul =
    category === 'weapon' &&
    baseLevel >= 200 &&
    soulName.startsWith('위대한 ') &&
    !hasExpiration &&
    !name.includes('기간제') &&
    !sealedGenesis;
  return {
    id: `${preset}:${slot}:${index}:${name}`,
    name,
    category,
    slot,
    level: baseLevel,
    imageUrl: image(raw.item_icon),
    potentialGrade,
    potential: optionLines(raw, 'potential_option', potentialGrade ?? 'rare'),
    additionalGrade,
    additional: optionLines(raw, 'additional_potential_option', additionalGrade ?? 'rare'),
    ...(soulName || soulGrade
      ? {
          soul: {
            name: soulName,
            active: String(raw.soul_active) === '1',
            stage: number(raw.soul_potential_amplified_grade),
            grade: soulGrade,
            lines: optionLines(raw, 'soul_potential_option', soulGrade ?? 'rare'),
          },
        }
      : {}),
    eligibleSoul,
  };
}

function abilityPreset(raw: JsonObject, fallbackGrade: unknown, honor: number): AbilitySnapshot {
  const grade =
    normalizeGrade(raw.ability_preset_grade ?? raw.ability_grade ?? fallbackGrade) ?? 'rare';
  const source = rows(raw.ability_info).sort((a, b) => number(a.ability_no) - number(b.ability_no));
  const lines: OptionLine[] = [];
  for (const entry of source) {
    const slot = number(entry.ability_no, lines.length + 1) - 1;
    if (slot < 0 || slot > 2) continue;
    while (lines.length < slot) lines.push(parsePotentialLine('', 'rare'));
    lines[slot] = parsePotentialLine(
      string(entry.ability_value),
      normalizeGrade(entry.ability_grade) ?? grade,
    );
  }
  return { grade, lines, honor };
}

/** Keep only simulator inputs. API keys and OCIDs are never included. */
export function normalizeCharacter(
  basicInput: unknown,
  equipmentInput: unknown,
  abilityInput: unknown,
  fetchedAt = new Date().toISOString(),
): CharacterSnapshot {
  const basic = object(basicInput);
  const equipment = object(equipmentInput);
  const ability = object(abilityInput);
  if (!string(basic.character_name))
    throw new Error('조회할 캐릭터 데이터가 아직 준비되지 않았습니다.');
  const presetNumber = (value: unknown): string =>
    [1, 2, 3].includes(Number(value)) ? String(value) : '1';
  const activeEquipmentPreset = presetNumber(equipment.preset_no);
  const activeAbilityPreset = presetNumber(ability.preset_no);
  const equipmentPresets: CharacterSnapshot['equipmentPresets'] = {};
  const abilityPresets: CharacterSnapshot['abilityPresets'] = {};
  for (const preset of ['1', '2', '3']) {
    const equipmentRows = rows(equipment[`item_equipment_preset_${preset}`]);
    const selectedEquipment = equipmentRows.length
      ? equipmentRows
      : preset === activeEquipmentPreset
        ? rows(equipment.item_equipment)
        : [];
    equipmentPresets[preset] = selectedEquipment.map((entry, index) =>
      equipmentItem(entry, preset, index),
    );
    const presetAbility = object(ability[`ability_preset_${preset}`]);
    const selectedAbility = rows(presetAbility.ability_info).length
      ? presetAbility
      : preset === activeAbilityPreset
        ? ability
        : {};
    abilityPresets[preset] = abilityPreset(
      selectedAbility,
      ability.ability_grade,
      number(ability.remain_fame),
    );
  }
  return {
    name: string(basic.character_name),
    world: string(basic.world_name),
    job: string(basic.character_class),
    level: number(basic.character_level),
    imageUrl: image(basic.character_image),
    fetchedAt,
    sourceUrl: 'https://openapi.nexon.com/game/maplestory/?id=14',
    equipmentPresets,
    abilityPresets,
    activeEquipmentPreset,
    activeAbilityPreset,
    profile: resolveCharacterProfile(string(basic.character_class)),
  };
}
