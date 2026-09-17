import type { CubeType, Grade, SimulatorMode } from '../types';
export const RULE_VERSION = 'kms-2026-09-17';
export const GRADE_NAMES = {
  normal: '노멀',
  rare: '레어',
  epic: '에픽',
  unique: '유니크',
  legendary: '레전드리',
};
export const GRADES: Grade[] = ['rare', 'epic', 'unique', 'legendary'];
export const MODES: { id: SimulatorMode; name: string; caption: string }[] = [
  { id: 'ability', name: '어빌리티', caption: '나의 또 다른 가능성' },
  { id: 'cube', name: '큐브', caption: '세 줄에 담긴 다른 운명' },
  { id: 'soulAmplification', name: '소울 증폭', caption: '한 단계 더, 한 번만 더' },
  { id: 'soulPotential', name: '소울 잠재', caption: '깨어나는 소울의 힘' },
];
export type AppTab = SimulatorMode | 'abilityOptimizer' | 'starforce';
export function isStandaloneTab(tab: AppTab): tab is 'abilityOptimizer' | 'starforce' {
  return tab === 'abilityOptimizer' || tab === 'starforce';
}
export const TABS: { id: AppTab; name: string }[] = [
  ...MODES,
  { id: 'abilityOptimizer', name: '어빌리티 최적화' },
  { id: 'starforce', name: '스타포스' },
];
export function getTabFromHash(): AppTab {
  const tab = location.hash.slice(1) as AppTab;
  return TABS.some((item) => item.id === tab) ? tab : getModeFromHash();
}
export const CUBES: {
  id: CubeType;
  name: string;
  short: string;
  description: string;
  color: string;
}[] = [
  {
    id: 'black',
    name: '블랙큐브',
    short: '윗잠재',
    description: '윗잠재 · 메소 재설정',
    color: '#b5bbcf',
  },
  {
    id: 'additional',
    name: '에디셔널큐브',
    short: '아랫잠재',
    description: '아랫잠재 · 메소 재설정',
    color: '#a199ef',
  },
  {
    id: 'gold',
    name: '골드큐브',
    short: '명장의 확률',
    description: '명장의 확률 · 등급 상승 보장 없음',
    color: '#e2bd6a',
  },
  {
    id: 'prime',
    name: '프라임큐브',
    short: '첫 줄 고정',
    description: '윗잠재 첫 줄 고정 · 10,000 크레딧',
    color: '#a3dca0',
  },
  {
    id: 'primeAdditional',
    name: '프라임 에디셔널',
    short: '첫 줄 고정',
    description: '아랫잠재 첫 줄 고정 · 20,000 크레딧',
    color: '#84cee2',
  },
];
export const CATEGORIES = [
  ['weapon', '무기'],
  ['emblem', '엠블렘'],
  ['secondaryWeapon', '보조무기'],
  ['forceShieldSoulRing', '포스실드·소울링'],
  ['shield', '방패'],
  ['hat', '모자'],
  ['top', '상의'],
  ['overall', '한벌옷'],
  ['bottom', '하의'],
  ['shoes', '신발'],
  ['gloves', '장갑'],
  ['cape', '망토'],
  ['belt', '벨트'],
  ['shoulder', '어깨장식'],
  ['faceAccessory', '얼굴장식'],
  ['eyeAccessory', '눈장식'],
  ['earring', '귀고리'],
  ['ring', '반지'],
  ['pendant', '펜던트'],
  ['heart', '기계심장'],
] as const;
export const METRIC_LABELS: Record<string, string> = {
  strPercent: 'STR %',
  dexPercent: 'DEX %',
  intPercent: 'INT %',
  lukPercent: 'LUK %',
  strFlat: 'STR',
  dexFlat: 'DEX',
  intFlat: 'INT',
  lukFlat: 'LUK',
  allStatPercent: '올스탯 %',
  allStatFlat: '올스탯',
  attackPercent: '공격력 %',
  magicAttackPercent: '마력 %',
  attackFlat: '공격력',
  magicAttackFlat: '마력',
  bossDamagePercent: '보스 데미지 %',
  ignoreDefensePercent: '방어율 무시 % 합계',
  criticalDamagePercent: '크리티컬 데미지 %',
  criticalRatePercent: '크리티컬 확률 %',
  cooldownReductionSecond: '쿨타임 감소(초)',
  dropRatePercent: '아이템 드롭률 %',
  mesoRatePercent: '메소 획득량 %',
  hpPercent: '최대 HP %',
  mpPercent: '최대 MP %',
  hpFlat: '최대 HP',
  mpFlat: '최대 MP',
  damagePercent: '데미지 %',
  strPerLevel: '9레벨당 STR',
  dexPerLevel: '9레벨당 DEX',
  intPerLevel: '9레벨당 INT',
  lukPerLevel: '9레벨당 LUK',
};
export function isItemCube(cube: CubeType) {
  return ['gold', 'prime', 'primeAdditional'].includes(cube);
}
export function isPrime(cube: CubeType) {
  return cube === 'prime' || cube === 'primeAdditional';
}
export function getModeFromHash(): SimulatorMode {
  const hash = location.hash.slice(1);
  return MODES.some((x) => x.id === hash) ? (hash as SimulatorMode) : 'cube';
}
