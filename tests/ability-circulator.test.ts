import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { AbilityOption, AbilityRules } from '../src/engine/rules';

interface CirculatorOption extends Omit<AbilityOption, 'weight'> {
  bestValue: number;
  bestValueProbability: number;
}
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../public/rules/${name}.json`, import.meta.url), 'utf8'));
const ability = read('ability') as AbilityRules;
const circulator = read('abyss-circulator') as {
  ruleId: string;
  abilityValueRuleId: string;
  checkedAt: string;
  requiredGrade: string;
  honorPerMedal: number;
  costPerUse: {
    items: number;
    honor: number;
    meso: string;
    cashShopPrice: number;
    creditShopPrice: number;
  };
  sources: Record<string, { url: string; sha256: string; snapshot: string }>;
  mechanics: Record<string, boolean>;
  modelingBasis: Record<string, string>;
  grades: Record<string, { options: CirculatorOption[] }>;
};

function source(name: string): Buffer {
  const path = circulator.sources[name].snapshot;
  const bytes = readFileSync(new URL(`../public/rules/${path}`, import.meta.url));
  return path.endsWith('.gz') ? gunzipSync(bytes) : bytes;
}

describe('official Abyss Circulator data', () => {
  it('preserves the checked official sources and content hashes, including the item tooltip', () => {
    expect(Object.keys(circulator.sources).sort()).toEqual([
      'guide',
      'probability',
      'tooltip',
      'update',
    ]);
    expect(circulator.checkedAt).toBe('2026-09-18');
    for (const [name, entry] of Object.entries(circulator.sources)) {
      expect(entry.url).toMatch(
        /^https:\/\/(maplestory\.nexon\.com|dszw1qtcnsa5e\.cloudfront\.net)\//,
      );
      expect(createHash('sha256').update(source(name)).digest('hex')).toBe(entry.sha256);
    }
    const probability = source('probability')
      .toString('utf8')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ');
    expect(probability).toContain(
      '블랙, 심연의 서큘레이터 사용 시 등급과 옵션이 고정된 상태에서 수치만 재설정됩니다.',
    );
    expect(probability).toContain('기존과 완전히 동일한 옵션이 선택될 경우');
    expect(source('tooltip').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('matches all 108 shared ability value distributions and their best values', () => {
    expect(circulator.abilityValueRuleId).toBe(ability.ruleId);
    expect(
      Object.fromEntries(
        Object.entries(circulator.grades).map(([grade, pool]) => [grade, pool.options.length]),
      ),
    ).toEqual({ epic: 31, unique: 36, legendary: 41 });
    let count = 0;
    for (const [grade, pool] of Object.entries(circulator.grades)) {
      const shared = ability.grades[grade as keyof typeof ability.grades]!.options;
      expect(pool.options).toHaveLength(shared.length);
      for (const option of pool.options) {
        const original = shared.find((row) => row.id === option.id)!;
        expect(original, `${grade}/${option.type}`).toBeDefined();
        expect(option.type).toBe(original.type);
        expect(option.valueDirection).toBe(original.valueDirection);
        expect(option.values).toEqual(original.values);
        expect(
          option.values.every((value) => Number.isFinite(value.weight) && value.weight > 0),
        ).toBe(true);
        expect(option.values.reduce((sum, value) => sum + value.weight, 0)).toBeCloseTo(1, 12);
        const best = (option.valueDirection === 'lower' ? Math.min : Math.max)(
          ...option.values.map((value) => value.value),
        );
        expect(option.bestValue).toBe(best);
        expect(option.bestValueProbability).toBeCloseTo(
          option.values
            .filter((value) => value.value === best)
            .reduce((sum, value) => sum + value.weight, 0),
          12,
        );
        count++;
      }
    }
    expect(count).toBe(108);
  });

  it.each([
    ['passiveSkillLevel', 1, 1],
    ['bossDamagePercent', 20, 0.1],
    ['cooldownSkipPercent', 20, 0.1],
    ['criticalRatePercent', 30, 0.1],
    ['statusAilmentDamagePercent', 10, 0.6],
    ['attackFlat', 30, 0.4],
    ['magicAttackFlat', 30, 0.4],
    ['buffDurationPercent', 50, 0.1],
    ['dropRatePercent', 20, 0.25],
    ['attackPerLevels', 10, 0.1],
  ] as const)('combines identical published values for %s', (type, value, probability) => {
    const option = circulator.grades.legendary.options.find((row) => row.type === type)!;
    expect(option.bestValue).toBe(value);
    expect(option.bestValueProbability).toBeCloseTo(probability, 12);
  });

  it('keeps circulator value rerolls distinct from advanced-reset locks and user market-price conversion', () => {
    expect(circulator.requiredGrade).toBe('legendary');
    expect(circulator.mechanics).toEqual({
      preservesGrade: true,
      preservesOptionTypes: true,
      rerollsAllLineValues: true,
      supportsSelectiveValueLocks: false,
      canKeepPreviousWholeResult: true,
      individualValuesMayRemainUnchanged: true,
      excludesIdenticalCompleteResult: true,
      cannotUseWhenAllValuesAreFixed: true,
    });
    expect(circulator.costPerUse).toEqual({
      items: 1,
      honor: 0,
      meso: '0',
      cashShopPrice: 4900,
      creditShopPrice: 4900,
    });
    expect(circulator.honorPerMedal).toBe(5000);
    expect(circulator.modelingBasis.independence).toContain('no separate joint distribution');
    expect(circulator.modelingBasis.honorMedal).toContain('user-requested');
  });
});
