import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ABILITY_JOB_PRESETS,
  makeAbilityPresetGoal,
  resolveAbilityPreset,
} from '../src/character/ability-presets';
import { allCandidates, type RuleData } from '../src/engine/rules';
import { matchTarget } from '../src/engine/target';
import { abilityProgress, abilityStrategyErrors } from '../src/engine/ability-strategy';
import { makeConfig, lowerFirstGoal } from '../src/ui/setup';
import type { CharacterSnapshot } from '../src/types';
const read = (file: string) =>
  JSON.parse(readFileSync(new URL(`../public/${file}.json`, import.meta.url), 'utf8'));
const data: RuleData = {
  potential: read('rules/potential'),
  additional: read('rules/additional-potential'),
  gold: read('rules/gold'),
  soul: read('rules/soul'),
  ability: read('rules/ability'),
};
const character: CharacterSnapshot = read('character/snapshot');

describe('user-supplied advanced ability endgame presets', () => {
  it('covers all 48 distinct jobs and resolves API job names', () => {
    expect(ABILITY_JOB_PRESETS).toHaveLength(48);
    expect(new Set(ABILITY_JOB_PRESETS.map((p) => p.job)).size).toBe(48);
    expect(resolveAbilityPreset('아크메이지 (불, 독)')?.job).toBe('아크메이지(불,독)');
    expect(resolveAbilityPreset('썬콜')?.job).toBe('아크메이지(썬,콜)');
    expect(resolveAbilityPreset('캐논마스터')?.job).toBe('캐논슈터');
    expect(resolveAbilityPreset('없는 직업')).toBeUndefined();
  });
  it('uses legendary maxima from the official draw pools for every job and slot', () => {
    const cfg = makeConfig(data, character, undefined, 'ability', 'black', 'recreate', '1');
    for (const preset of ABILITY_JOB_PRESETS) {
      const goal = makeAbilityPresetGoal(data, preset.job);
      const config = { ...cfg, target: goal };
      expect(abilityStrategyErrors(config)).toEqual([]);
      for (let slot = 0; slot < 3; slot++) {
        const line = goal.lines[slot];
        const pool = allCandidates(data, config, 'legendary', slot).filter(
          (c) => c.line.grade === 'legendary' && c.line.type === line.type,
        );
        expect(line.grade).toBe('legendary');
        expect(line.value).toBe(Math.max(...pool.map((c) => c.line.value)));
        expect(pool.some((c) => c.line.text === line.text && c.probability > 0)).toBe(true);
      }
      expect(abilityProgress(config, goal.lines).lockedSlots).toEqual([1, 2]);
    }
  });
  it('accepts both lower orders but rejects a misplaced first line or lower-grade secondary', () => {
    const target = makeAbilityPresetGoal(data, '데몬어벤져');
    const state = { grade: 'legendary' as const, stage: 0, lines: target.lines };
    expect(target.lines.map((line) => [line.type, line.value])).toEqual([
      ['cooldownSkipPercent', 20],
      ['bossDamagePercent', 20],
      ['passiveSkillLevel', 1],
    ]);
    expect(matchTarget(target, state)).toBe(true);
    expect(
      matchTarget(target, { ...state, lines: [target.lines[0], target.lines[2], target.lines[1]] }),
    ).toBe(true);
    expect(
      matchTarget(target, { ...state, lines: [target.lines[1], target.lines[0], target.lines[2]] }),
    ).toBe(false);
    expect(
      matchTarget(target, {
        ...state,
        lines: [target.lines[0], { ...target.lines[1], grade: 'unique' }, target.lines[2]],
      }),
    ).toBe(false);
  });
  it('selects attack for physical jobs and magic attack for magic jobs independently of the loaded character', () => {
    expect(makeAbilityPresetGoal(data, '나이트워커').lines[2]).toMatchObject({
      type: 'attackFlat',
      value: 30,
    });
    expect(makeAbilityPresetGoal(data, '비숍').lines[2]).toMatchObject({
      type: 'magicAttackFlat',
      value: 30,
    });
    expect(makeAbilityPresetGoal(data, '불독').lines[2].type).toBe('magicAttackFlat');
  });
  it('defaults imported ability challenges to lower-first and preserves target values', () => {
    const cfg = makeConfig(data, character, undefined, 'ability', 'black', 'upgrade', '1');
    expect(cfg.abilityStrategy).toBe('lowerFirst');
    expect(cfg.target.conditions[0].slot).toBe(0);
    expect(cfg.target.conditions.slice(1).map((c) => c.slots)).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(cfg.target.conditions.map((c) => c.minValue)).toEqual(
      cfg.start.lines.map((l) => l.value),
    );
    expect(lowerFirstGoal({ ...cfg.target, mode: 'exact' })).toBeUndefined();
    expect(
      lowerFirstGoal({ ...cfg.target, conditions: cfg.target.conditions.slice(0, 2) }),
    ).toBeUndefined();
  });
});
