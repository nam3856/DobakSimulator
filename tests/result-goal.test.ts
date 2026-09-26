import { describe, expect, it } from 'vitest';
import type { Grade, OptionLine, RollResult, SimulationConfig } from '../src/types';
import { resolveCharacterProfile } from '../src/character/profiles';
import { matchTarget } from '../src/engine/target';
import { METRIC_LABELS } from '../src/ui/constants';
import { makeResultGoal } from '../src/ui/result-goal';

function config(): SimulationConfig {
  return {
    mode: 'cube',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'rare', lines: [], stage: 2, failures: 0 },
    lockedSlots: [],
    batchSize: 3,
    target: {
      mode: 'grade',
      minimumGrade: 'legendary',
      conditions: [],
      lines: [],
      stage: 2,
      match: 'all',
    },
    ruleVersion: 'test',
    unitPrices: {},
  };
}

function line(type: string, value: number): OptionLine {
  return {
    id: `${type}:${value}`,
    type,
    value,
    unit: type.endsWith('Percent')
      ? 'percent'
      : type.endsWith('PerLevel')
        ? 'level'
        : type.endsWith('Second')
          ? 'second'
          : 'flat',
    text: `${type} +${value}`,
    grade: 'unique',
  };
}

function result(lines: OptionLine[], grade: Grade = 'unique'): RollResult {
  return {
    sequence: 3n,
    grade,
    lines,
    stage: 2,
    promoted: false,
    amplified: false,
    hit: false,
    cost: { meso: 30n, honor: 0n, cubes: 0n, credits: 0n, ethers: [] },
  };
}

describe('goals derived from a potential result', () => {
  it.each(['cube', 'soulPotential'] as const)(
    '%s requires each useful total or better, independent of order or the configured target',
    (mode) => {
      const cfg = { ...config(), mode };
      const selected = result([
        line('attackPercent', 9),
        line('bossDamagePercent', 30),
        line('attackPercent', 6),
      ]);
      const profile = resolveCharacterProfile('히어로');
      const before = structuredClone({ cfg, selected, profile });
      const goal = makeResultGoal(cfg, selected, profile)!;
      expect(goal).toEqual({
        mode: 'sum',
        minimumGrade: 'unique',
        conditions: [
          { type: 'attackPercent', minValue: 15 },
          { type: 'bossDamagePercent', minValue: 30 },
        ],
        lines: [],
        stage: 2,
        match: 'all',
      });
      expect(matchTarget(goal, selected)).toBe(true);
      expect(matchTarget(goal, { ...selected, lines: [...selected.lines].reverse() })).toBe(true);
      const stronger = result(
        [line('bossDamagePercent', 40), line('attackPercent', 9), line('attackPercent', 9)],
        'legendary',
      );
      expect(matchTarget(goal, stronger)).toBe(true);
      expect(matchTarget(goal, { ...stronger, grade: 'epic' })).toBe(false);
      expect(
        matchTarget(goal, result([line('attackPercent', 30), line('bossDamagePercent', 20)])),
      ).toBe(false);
      expect(
        matchTarget(goal, result([line('attackPercent', 12), line('bossDamagePercent', 60)])),
      ).toBe(false);
      expect({ cfg, selected, profile }).toEqual(before);
    },
  );

  it('retains useful flat main-stat and attack lines on weapons, without secondary stats', () => {
    const goal = makeResultGoal(
      config(),
      result([line('strFlat', 20), line('attackFlat', 12), line('dexFlat', 40)]),
      resolveCharacterProfile('히어로'),
    )!;
    expect(goal.conditions).toEqual([
      { type: 'strFlat', minValue: 20 },
      { type: 'attackFlat', minValue: 12 },
    ]);
    expect(matchTarget(goal, result([line('strPercent', 12), line('attackPercent', 12)]))).toBe(
      false,
    );
  });

  it.each(['Percent', 'Flat'] as const)(
    'combines all-stat %s with a main stat using the same automatic-target semantics',
    (suffix) => {
      const selected = result([
        line(`str${suffix}`, 9),
        line(`allStat${suffix}`, 6),
        line(`dex${suffix}`, 12),
      ]);
      const goal = makeResultGoal(config(), selected, resolveCharacterProfile('히어로'))!;
      expect(goal.conditions).toEqual([{ type: `str${suffix}`, minValue: 15 }]);
      expect(matchTarget(goal, selected)).toBe(true);
      expect(matchTarget(goal, result([line(`str${suffix}`, 15)]))).toBe(true);
      expect(matchTarget(goal, result([line(`allStat${suffix}`, 15)]))).toBe(true);
      expect(matchTarget(goal, result([line(`str${suffix}`, 14)]))).toBe(false);
    },
  );

  it('requires all three Xenon stats and credits all-stat to each of them', () => {
    const selected = result([
      line('allStatPercent', 6),
      line('strPercent', 9),
      line('dexPercent', 9),
    ]);
    const goal = makeResultGoal(config(), selected, resolveCharacterProfile('제논'))!;
    expect(goal.conditions).toEqual([
      { type: 'strPercent', minValue: 15 },
      { type: 'dexPercent', minValue: 15 },
      { type: 'lukPercent', minValue: 6 },
    ]);
    expect(matchTarget(goal, result([line('allStatPercent', 15)]))).toBe(true);
    expect(
      matchTarget(
        goal,
        result([line('strPercent', 30), line('dexPercent', 30), line('lukPercent', 5)]),
      ),
    ).toBe(false);
  });

  it('uses HP for Demon Avenger without crediting all-stat or its STR secondary stat', () => {
    const profile = resolveCharacterProfile('데몬어벤져');
    const goal = makeResultGoal(
      config(),
      result([line('hpPercent', 9), line('hpFlat', 150), line('allStatPercent', 6)]),
      profile,
    )!;
    expect(goal.conditions).toEqual([
      { type: 'hpPercent', minValue: 9 },
      { type: 'hpFlat', minValue: 150 },
    ]);
    expect(
      matchTarget(
        goal,
        result([line('allStatPercent', 99), line('allStatFlat', 999), line('strFlat', 999)]),
      ),
    ).toBe(false);
    expect(
      makeResultGoal(
        config(),
        result([line('allStatPercent', 6), line('allStatFlat', 20), line('strFlat', 20)]),
        profile,
      ),
    ).toBeUndefined();
  });

  it('selects magic attack for mage classes and keeps per-level INT separate from flat INT', () => {
    const goal = makeResultGoal(
      config(),
      result([line('intPerLevel', 2), line('magicAttackPercent', 9), line('attackPercent', 12)]),
      resolveCharacterProfile('비숍'),
    )!;
    expect(goal.conditions).toEqual([
      { type: 'intPerLevel', minValue: 2 },
      { type: 'magicAttackPercent', minValue: 9 },
    ]);
    expect(matchTarget(goal, result([line('intFlat', 300), line('magicAttackPercent', 12)]))).toBe(
      false,
    );
  });

  it.each([
    ['히어로', 'attack'],
    ['비숍', 'magicAttack'],
  ])('keeps all three %s attack units distinct and displayable', (job, attack) => {
    const goal = makeResultGoal(
      config(),
      result([
        line(`${attack}Percent`, 9),
        line(`${attack}Flat`, 12),
        line(`${attack}PerLevel`, 1),
      ]),
      resolveCharacterProfile(job),
    )!;
    expect(goal.conditions).toEqual([
      { type: `${attack}Percent`, minValue: 9 },
      { type: `${attack}Flat`, minValue: 12 },
      { type: `${attack}PerLevel`, minValue: 1 },
    ]);
    for (const condition of goal.conditions) expect(METRIC_LABELS[condition.type]).toBeTruthy();
  });

  it('combines ignore-defense multiplicatively instead of summing percentages', () => {
    const selected = result([line('ignoreDefensePercent', 30), line('ignoreDefensePercent', 40)]);
    const goal = makeResultGoal(config(), selected, resolveCharacterProfile('히어로'))!;
    expect(goal.conditions).toHaveLength(1);
    expect(goal.conditions[0].minValue).toBeCloseTo(58, 10);
    expect(matchTarget(goal, selected)).toBe(true);
    expect(matchTarget(goal, result([line('ignoreDefensePercent', 60)]))).toBe(true);
    expect(matchTarget(goal, result([line('ignoreDefensePercent', 57)]))).toBe(false);
    expect(
      matchTarget(
        goal,
        result([line('ignoreDefensePercent', 50), line('ignoreDefensePercent', 10)]),
      ),
    ).toBe(false);
  });

  it('includes offensive, cooldown, and farming metrics regardless of equipment category', () => {
    for (const type of [
      'bossDamagePercent',
      'damagePercent',
      'criticalDamagePercent',
      'criticalRatePercent',
      'cooldownReductionSecond',
      'dropRatePercent',
      'mesoRatePercent',
    ]) {
      const goal = makeResultGoal(
        { ...config(), category: 'hat' },
        result([line(type, 2), line(type, 1), line('unknown', 999)]),
        resolveCharacterProfile('비숍'),
      )!;
      expect(goal.conditions).toEqual([{ type, minValue: 3 }]);
      expect(METRIC_LABELS[type]).toBeTruthy();
      expect(matchTarget(goal, result([line(type, 4)]))).toBe(true);
      expect(matchTarget(goal, result([line(type, 2)]))).toBe(false);
    }
  });

  it('does not invent a goal for empty, junk, wrong-class, or nonpositive results', () => {
    const profile = resolveCharacterProfile('히어로');
    for (const lines of [
      [],
      [line('unknown', 999), line('mpFlat', 300), line('dexPercent', 12)],
      [line('magicAttackPercent', 12), line('armorPercent', 12), line('speedFlat', 12)],
      [line('attackPercent', 0), line('damagePercent', -1), line('strPercent', NaN)],
    ])
      expect(makeResultGoal(config(), result(lines), profile)).toBeUndefined();
  });

  it.each(['ability', 'soulAmplification'] as const)(
    'does not analyze unsupported %s results',
    (mode) => {
      expect(
        makeResultGoal(
          { ...config(), mode },
          result([line('attackFlat', 30)]),
          resolveCharacterProfile('히어로'),
        ),
      ).toBeUndefined();
    },
  );
});
