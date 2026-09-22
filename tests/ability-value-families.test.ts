import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../public/rules/${name}.json`, import.meta.url), 'utf8'));

describe('official ability percentage and flat value families', () => {
  it.each(['ability', 'abyss-circulator'])('%s separates HP/MP percentages from flat amounts', (name) => {
    const rule = read(name);
    for (const [grade, percent, flat] of [
      ['unique', [5, 6, 7, 8, 9, 10], [375, 390, 405, 420, 435, 450]],
      ['legendary', [15, 16, 17, 18, 19, 20], [525, 540, 555, 570, 585, 600]],
    ] as const) {
      for (const stat of ['hp', 'mp']) {
        const options = rule.grades[grade].options;
        expect(options.find((option: { type: string }) => option.type === `${stat}Percent`).values.map((value: { value: number }) => value.value)).toEqual(percent);
        expect(options.find((option: { type: string }) => option.type === `${stat}Flat`).values.map((value: { value: number }) => value.value)).toEqual(flat);
      }
    }
  });

  it('uses the dedicated miracle unique type weights and guarantees each best value', () => {
    const miracle = read('ability-miracle');
    const unique = miracle.grades.unique.options;
    expect(unique.find((option: { type: string }) => option.type === 'attackFlat').displayedProbabilityPercent).toBe('2.2624%');
    expect(unique.find((option: { type: string }) => option.type === 'criticalRatePercent').displayedProbabilityPercent).toBe('0.9050%');
    for (const [grade, maxPercent] of [['unique', 10], ['legendary', 20]] as const) {
      for (const stat of ['hp', 'mp']) {
        const option = miracle.grades[grade].options.find((entry: { type: string }) => entry.type === `${stat}Percent`);
        expect(option.values).toHaveLength(1);
        expect(option.values[0].value).toBe(maxPercent);
        expect(option.values[0].weight).toBe(1);
      }
    }
  });
});
