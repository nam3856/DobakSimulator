import type { Goal, OptionLine } from '../types';
import type { RuleData } from '../engine/rules';
import { resolveCharacterProfile } from './profiles';

/** User-supplied endgame combinations, 2026-09-17. All three lines use advanced legendary. */
export const ABILITY_JOB_PRESETS = [
  ['나이트로드', '패보상'],
  ['나이트워커', '보상공'],
  ['다크나이트', '패보재'],
  ['데몬슬레이어', '보상공'],
  ['데몬어벤져', '재보패'],
  ['듀얼블레이드', '패보상'],
  ['라라', '패보상'],
  ['레테', '재보패'],
  ['렌', '패보상'],
  ['루미너스', '재보상'],
  ['메르세데스', '패보크'],
  ['메카닉', '보상공'],
  ['미하일', '보상공'],
  ['바이퍼', '패보상'],
  ['배틀메이지', '패보상'],
  ['보우마스터', '패보크'],
  ['블래스터', '보상공'],
  ['비숍', '보상공'],
  ['섀도어', '패보상'],
  ['소울마스터', '보상공'],
  ['스트라이커', '패보상'],
  ['신궁', '패보크'],
  ['아델', '패보재'],
  ['아란', '패보상'],
  ['아크', '패재보'],
  ['아크메이지(불,독)', '보상공'],
  ['아크메이지(썬,콜)', '보상공'],
  ['에반', '보재상'],
  ['엔젤릭버스터', '패보상'],
  ['와일드헌터', '패보크'],
  ['윈드브레이커', '패보크'],
  ['은월', '패보상'],
  ['일리움', '패보상'],
  ['제논', '보상공'],
  ['제로', '보상공'],
  ['카데나', '재보상'],
  ['카이저', '재보상'],
  ['카인', '패보크'],
  ['칼리', '재보상'],
  ['캐논슈터', '패보상'],
  ['캡틴', '재보상'],
  ['키네시스', '보상공'],
  ['팔라딘', '패보상'],
  ['패스파인더', '패보크'],
  ['팬텀', '재보상'],
  ['플레임위자드', '패보상'],
  ['호영', '패보상'],
  ['히어로', '패보상'],
].map(([job, code]) => ({ job, code }));

const normalizedJob = (job: string) => job.replace(/[\s,]/g, '');
const JOB_ALIASES: Record<string, string> = {
  불독: '아크메이지(불독)',
  썬콜: '아크메이지(썬콜)',
  캐논마스터: '캐논슈터',
};

export function resolveAbilityPreset(job: string) {
  const normalized = normalizedJob(job);
  const name = JOB_ALIASES[normalized] ?? normalized;
  return ABILITY_JOB_PRESETS.find((preset) => normalizedJob(preset.job) === name);
}

export function makeAbilityPresetGoal(
  data: RuleData,
  job: string,
  valueMode: 'minimum' | 'maximum' = 'maximum',
): Goal {
  const preset = resolveAbilityPreset(job);
  if (!preset) throw new Error('선택한 직업의 종결 어빌리티 프리셋이 없습니다.');
  const types: Record<string, string> = {
    패: 'passiveSkillLevel',
    재: 'cooldownSkipPercent',
    상: 'statusAilmentDamagePercent',
    보: 'bossDamagePercent',
    크: 'criticalRatePercent',
    공: `${resolveCharacterProfile(preset.job).attackType}Flat`,
  };
  const lines: OptionLine[] = [...preset.code].map((code) => {
    const option = data.ability.grades.legendary?.options.find((row) => row.type === types[code]);
    if (!option?.values.length) throw new Error(`종결 어빌리티 '${code}'의 공식 수치가 없습니다.`);
    const value = option.values.reduce((best, next) =>
      (valueMode === 'minimum' ? next.value < best.value : next.value > best.value) ? next : best,
    );
    return {
      id: `${option.id}:legendary:${value.value}:${value.secondaryValue ?? ''}`,
      abilityTypeId: option.id,
      type: option.type!,
      value: value.value,
      unit: value.label.includes('%') ? 'percent' : code === '패' ? 'level' : 'flat',
      text: value.label,
      grade: 'legendary',
    };
  });
  return {
    mode: 'ability',
    minimumGrade: 'legendary',
    match: 'all',
    stage: 0,
    lines,
    conditions: lines.map((line, index) => ({
      type: line.type,
      minValue: line.value,
      minGrade: 'legendary',
      ...(index === 0 ? { slot: 0 } : { slots: [1, 2] }),
    })),
  };
}
