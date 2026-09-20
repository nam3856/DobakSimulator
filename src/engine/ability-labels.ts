/** Official kind labels contain blank percentage placeholders; value labels stay untouched. */
export function abilityKindLabel(label: string): string {
  return label
    .replace(/의 % 만큼/g, '에 비례한')
    .replace(/% 확률로/g, '일정 확률로')
    .replace(/\s+%/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
