import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildAvatarUrl,
  CharacterApiError,
  getCharacter,
  getDefaultAvatarPath,
  normalizeCharacter,
  normalizeEquipmentCategory,
  parsePotentialLine,
  resolveCharacterProfile,
  suggestPotentialTargets,
} from '../src/character/index.ts';
import type { CharacterSnapshot, EquipmentSnapshot } from '../src/types.ts';
import { matchTarget } from '../src/engine/target';

const basic = {
  character_name: '테스트캐릭터',
  character_class: '메카닉',
  character_level: 292,
  world_name: '오로라',
  character_image: 'https://open.api.nexon.com/static/maplestory/character/look/test',
};
const weapon = {
  item_name: '테스트 무기',
  item_equipment_part: '건',
  item_equipment_slot: '무기',
  item_base_option: { base_equipment_level: 200 },
  potential_option_grade: '레전드리',
  potential_option_1: '공격력 : +12%',
  potential_option_2: '보스 몬스터 공격 시 데미지 : +40%',
  potential_option_3: '공격력 : +9%',
  soul_name: '위대한 소울',
  soul_active: '1',
  soul_potential_amplified_grade: 3,
  soul_potential_grade: '유니크',
  soul_potential_option_1: '보스 몬스터 공격 시 데미지 : +10%',
};

afterEach(() => vi.unstubAllGlobals());

describe('character normalization', () => {
  it('keeps selected equipment and ability presets distinct, including new soul fields and legendary later lines', () => {
    const snapshot = normalizeCharacter(
      basic,
      {
        preset_no: 2,
        item_equipment: [weapon],
        item_equipment_preset_1: [{ ...weapon, item_name: '프리셋1' }],
        item_equipment_preset_3: [{ ...weapon, item_name: '프리셋3' }],
      },
      {
        preset_no: 3,
        remain_fame: 555,
        ability_grade: '레전드리',
        ability_info: [
          { ability_no: '3', ability_grade: '레전드리', ability_value: '메소 획득량 20% 증가' },
          {
            ability_no: '1',
            ability_grade: '레전드리',
            ability_value: '보스 몬스터 공격 시 데미지 20% 증가',
          },
          {
            ability_no: '2',
            ability_grade: '레전드리',
            ability_value: '버프 스킬의 지속 시간 50% 증가',
          },
        ],
      },
      '2026-09-17T00:00:00Z',
    );
    expect(snapshot.activeEquipmentPreset).toBe('2');
    expect(snapshot.equipmentPresets['1'][0].name).toBe('프리셋1');
    expect(snapshot.equipmentPresets['2'][0].category).toBe('weapon');
    expect(snapshot.equipmentPresets['3'][0].name).toBe('프리셋3');
    expect(snapshot.equipmentPresets['2'][0].soul).toMatchObject({
      active: true,
      stage: 3,
      grade: 'unique',
    });
    expect(snapshot.abilityPresets['1'].lines).toEqual([]);
    expect(snapshot.abilityPresets['3'].lines.map((line) => line.grade)).toEqual([
      'legendary',
      'legendary',
      'legendary',
    ]);
    expect(snapshot.abilityPresets['3'].lines[2].type).toBe('mesoRatePercent');
    expect(snapshot.abilityPresets['3'].honor).toBe(555);
  });

  it('accepts partially missing API data without inventing presets or soul potential', () => {
    const snapshot = normalizeCharacter(
      basic,
      {
        item_equipment: [
          {
            ...weapon,
            soul_potential_grade: null,
            soul_potential_option_1: null,
            soul_potential_amplified_grade: null,
          },
        ],
      },
      null,
    );
    expect(snapshot.equipmentPresets['2']).toEqual([]);
    expect(snapshot.abilityPresets['1'].lines).toEqual([]);
    expect(snapshot.equipmentPresets['1'][0].soul).toMatchObject({
      stage: 0,
      grade: undefined,
      lines: [],
    });
    expect(() => normalizeCharacter(null, null, null)).toThrow('준비');
  });

  it('keeps API OCIDs, keys and unknown raw fields out of normalized snapshots', () => {
    const result = JSON.stringify(
      normalizeCharacter(
        { ...basic, ocid: 'private-ocid', apiKey: 'private-key' },
        { ocid: 'private-ocid', item_equipment: [weapon] },
        {},
      ),
    );
    expect(result).not.toContain('private-ocid');
    expect(result).not.toContain('private-key');
  });

  it('preserves reported stars and superior or amazing-scroll exclusions per preset', () => {
    const snapshot = normalizeCharacter(
      basic,
      {
        preset_no: 2,
        item_equipment_preset_1: [
          {
            ...weapon,
            starforce: '0',
            item_description: '일반 장비',
            starforce_scroll_flag: '미사용',
          },
        ],
        item_equipment: [
          {
            ...weapon,
            starforce: '15',
            item_description: '슈페리얼 장비입니다.',
            starforce_scroll_flag: '미사용',
          },
        ],
        item_equipment_preset_3: [
          { ...weapon, starforce: 12, item_description: null, starforce_scroll_flag: '사용' },
        ],
      },
      {},
    );
    expect(snapshot.equipmentPresets['1'][0]).toMatchObject({
      starforce: 0,
      superiorEquipment: false,
      extraordinaryStarforce: false,
    });
    expect(snapshot.equipmentPresets['2'][0]).toMatchObject({
      starforce: 15,
      superiorEquipment: true,
      extraordinaryStarforce: false,
    });
    expect(snapshot.equipmentPresets['3'][0]).toMatchObject({
      starforce: 12,
      extraordinaryStarforce: true,
    });
    expect(snapshot.equipmentPresets['3'][0]).not.toHaveProperty('superiorEquipment');
  });

  it('does not invent or clamp stars when API fields are missing or malformed', () => {
    const invalid = [
      undefined,
      null,
      '',
      ' ',
      '12.5',
      12.5,
      -1,
      '31',
      NaN,
      Infinity,
      true,
      [],
      '0x10',
    ];
    for (const value of invalid) {
      const item = normalizeCharacter(
        basic,
        { item_equipment: [{ ...weapon, starforce: value }] },
        {},
      ).equipmentPresets['1'][0];
      expect(item).not.toHaveProperty('starforce');
      expect(item).not.toHaveProperty('superiorEquipment');
      expect(item).not.toHaveProperty('extraordinaryStarforce');
    }
    const item = normalizeCharacter(
      basic,
      { item_equipment: [{ ...weapon, starforce: ' 30 ', item_name: '슈페리얼 테스트' }] },
      {},
    ).equipmentPresets['1'][0];
    expect(item.starforce).toBe(30);
    expect(item.superiorEquipment).toBe(true);
  });

  it('distinguishes shield/force-shield pools and numbered accessory slots', () => {
    expect(normalizeEquipmentCategory('포스실드', '보조무기')).toBe('forceShieldSoulRing');
    expect(normalizeEquipmentCategory('방패', '보조무기')).toBe('shield');
    expect(normalizeEquipmentCategory('리스트레인트 링', '반지2')).toBe('ring');
    expect(normalizeEquipmentCategory('한벌옷', '상의')).toBe('overall');
  });
  it('accepts eligible magnificent souls while rejecting low-level, expiring, sealed and secondary weapons', () => {
    const eligible = (changes: Record<string, unknown>) =>
      normalizeCharacter(basic, { item_equipment: [{ ...weapon, ...changes }] }, {})
        .equipmentPresets['1'][0].eligibleSoul;
    expect(eligible({})).toBe(true);
    expect(eligible({ item_base_option: { base_equipment_level: 199 } })).toBe(false);
    expect(eligible({ item_equipment_slot: '보조무기' })).toBe(false);
    expect(eligible({ soul_name: '기운찬 칼로스의 소울 적용' })).toBe(false);
    expect(eligible({ soul_name: null })).toBe(false);
    expect(eligible({ date_expire: '2026-12-31T00:00+09:00' })).toBe(false);
    expect(eligible({ date_expire: 'expired' })).toBe(false);
    expect(eligible({ date_expire: 'permanent' })).toBe(true);
    expect(eligible({ item_name: '기간제 아케인셰이드 피스톨' })).toBe(false);
    expect(eligible({ item_name: '봉인된 제네시스 피스톨' })).toBe(false);
    expect(eligible({ item_name: '제네시스 라즐리' })).toBe(true);
    expect(
      eligible({ item_name: '데스티니 피스톨', item_base_option: { base_equipment_level: 250 } }),
    ).toBe(true);
  });
});

describe('potential inputs and recommendations', () => {
  it('parses flat/percent/level/cooldown options separately and retains unknown text', () => {
    expect(parsePotentialLine('DEX : +12%')).toMatchObject({
      type: 'dexPercent',
      value: 12,
      unit: 'percent',
    });
    expect(parsePotentialLine('마력 : +12')).toMatchObject({ type: 'magicAttackFlat', value: 12 });
    expect(parsePotentialLine('캐릭터 기준 9레벨 당 DEX +2')).toMatchObject({
      type: 'dexPerLevel',
      value: 2,
      unit: 'level',
    });
    expect(parsePotentialLine('모든 스킬의 재사용 대기시간 : -2초')).toMatchObject({
      type: 'cooldownReductionSecond',
      value: 2,
      unit: 'second',
    });
    expect(parsePotentialLine('STR과 DEX 5 증가')).toMatchObject({
      type: 'unknown',
      text: 'STR과 DEX 5 증가',
    });
  });

  it('recommends weapon power/boss/IED for the actual class using effective stat metrics', () => {
    const item = normalizeCharacter(basic, { item_equipment: [weapon] }, {}).equipmentPresets[
      '1'
    ][0];
    const profile = resolveCharacterProfile('메카닉');
    expect(suggestPotentialTargets(item, 'potential', profile)).toEqual([
      { type: 'attackPercent', minValue: 21 },
      { type: 'bossDamagePercent', minValue: 40 },
    ]);
    const armor: EquipmentSnapshot = {
      ...item,
      category: 'hat',
      slot: '모자',
      potential: ['DEX : +12%', '올스탯 : +6%', 'STR : +9%'].map((value) =>
        parsePotentialLine(value),
      ),
      additional: ['STR : +5%', 'DEX : +5%', '공격력 : +12'].map((value) =>
        parsePotentialLine(value),
      ),
    };
    expect(suggestPotentialTargets(armor, 'potential', profile)).toEqual([
      { type: 'dexPercent', minValue: 18 },
      { type: 'strPercent', minValue: 15 },
    ]);
    expect(suggestPotentialTargets(armor, 'additional', profile)).toEqual([
      { type: 'dexPercent', minValue: 5 },
      { type: 'attackFlat', minValue: 12 },
    ]);
    expect(
      suggestPotentialTargets(item, 'potential', resolveCharacterProfile('미확인직업')),
    ).toEqual([]);
    expect(resolveCharacterProfile('데몬 어벤져').mainStats).toEqual(['hp']);
    expect(resolveCharacterProfile('제논').mainStats).toEqual(['str', 'dex', 'luk']);
  });

  it('produces attainable imported IED goals using the same compound metric as simulation', () => {
    const item = normalizeCharacter(basic, { item_equipment: [weapon] }, {}).equipmentPresets[
      '1'
    ][0];
    item.potential = ['몬스터 방어율 무시 : +40%', '몬스터 방어율 무시 : +30%', '공격력 : +9%'].map(
      (value) => parsePotentialLine(value),
    );
    const conditions = suggestPotentialTargets(
      item,
      'potential',
      resolveCharacterProfile('메카닉'),
    );
    expect(
      conditions.find((condition) => condition.type === 'ignoreDefensePercent')?.minValue,
    ).toBeCloseTo(58);
    expect(
      matchTarget(
        { mode: 'sum', minimumGrade: 'legendary', conditions, lines: [], stage: 1, match: 'all' },
        {
          grade: 'legendary',
          lines: item.potential,
          stage: 1,
        },
      ),
    ).toBe(true);
  });

  it('allows equivalent main-stat replacements for imported all-stat and ignores it for HP classes', () => {
    const item = normalizeCharacter(basic, { item_equipment: [weapon] }, {}).equipmentPresets[
      '1'
    ][0];
    item.category = 'hat';
    item.slot = '모자';
    item.potential = ['DEX : +12%', '올스탯 : +6%', '방어력 : +100'].map((value) =>
      parsePotentialLine(value),
    );
    const conditions = suggestPotentialTargets(
      item,
      'potential',
      resolveCharacterProfile('메카닉'),
    );
    expect(conditions).toEqual([{ type: 'dexPercent', minValue: 18 }]);
    const replacement = ['DEX : +9%', 'DEX : +9%', '방어력 : +100'].map((value) =>
      parsePotentialLine(value),
    );
    expect(
      matchTarget(
        { mode: 'sum', minimumGrade: 'legendary', conditions, lines: [], stage: 1, match: 'all' },
        {
          grade: 'legendary',
          lines: replacement,
          stage: 1,
        },
      ),
    ).toBe(true);
    item.potential = ['HP : +12%', '올스탯 : +6%', '방어력 : +100'].map((value) =>
      parsePotentialLine(value),
    );
    expect(
      suggestPotentialTargets(item, 'potential', resolveCharacterProfile('데몬 어벤져')),
    ).toEqual([{ type: 'hpPercent', minValue: 12 }]);
  });
});

describe('Nexon client', () => {
  it('fetches latest basic/equipment/ability after OCID, using the key only in headers', async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes('/id?') ? { ocid: 'test-ocid' } : url.includes('/basic?') ? basic : {},
          ),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const snapshot = await getCharacter(' 테스트캐릭터 ', 'test-key');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(snapshot.name).toBe('테스트캐릭터');
    for (const [url, options] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).not.toContain('date=');
      expect(url).not.toContain('test-key');
      expect(options.headers).toEqual({ 'x-nxopen-api-key': 'test-key' });
      expect(options.credentials).toBe('omit');
    }
  });

  it('reports API errors without echoing provider messages or credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { name: 'OPENAPI00005', message: 'leaked-provider-message' } }),
            { status: 400 },
          ),
      ),
    );
    const error = await getCharacter('테스트', 'test-key').catch((error) => error);
    expect(error).toBeInstanceOf(CharacterApiError);
    expect(error.message).toContain('유효하지 않은');
    expect(error.message).not.toContain('leaked-provider-message');
  });

  it('propagates cancellation so a previous nickname cannot replace a newer result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );
    const controller = new AbortController();
    const request = getCharacter('테스트', 'test-key', controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('default avatar and snapshot', () => {
  it('preserves an imported character while replacing its pose with the official ghost action', () => {
    const base = `${basic.character_image}?action=A06.0&emotion=E02.0&wmotion=W02`;
    const ghost = new URL(buildAvatarUrl(base, 'ghost'));
    expect(ghost.pathname).toBe(new URL(base).pathname);
    expect(ghost.searchParams.getAll('action')).toEqual(['A35.0']);
    expect(ghost.searchParams.getAll('emotion')).toEqual(['E00.0']);
    expect(ghost.searchParams.get('wmotion')).toBe('W02');
    expect(getDefaultAvatarPath('ghost', '/DobakSimulator/')).toBe(
      '/DobakSimulator/character/ghost.png',
    );
  });

  it('replaces existing image query parameters for the official cry/jump poses', () => {
    const base = `${basic.character_image}?action=A01&emotion=E04`;
    const cry = new URL(buildAvatarUrl(base, 'cry'));
    expect(cry.searchParams.getAll('action')).toEqual(['A04.0']);
    expect(cry.searchParams.get('emotion')).toBe('E03.0');
    expect(new URL(buildAvatarUrl(base, 'jackpot')).searchParams.get('action')).toBe('A06.0');
    expect(() => buildAvatarUrl('https://example.com/image', 'neutral')).toThrow();
    expect(getDefaultAvatarPath('happy', '/DobakSimulator/')).toBe(
      '/DobakSimulator/character/happy.png',
    );
  });

  it('ships the real default character with presets, source date and valid PNG poses', () => {
    const snapshotText = readFileSync(
      new URL('../public/character/snapshot.json', import.meta.url),
      'utf8',
    );
    const snapshot = JSON.parse(snapshotText) as CharacterSnapshot;
    expect(snapshot.name).toBe('깽미니');
    expect(Object.keys(snapshot.equipmentPresets)).toEqual(['1', '2', '3']);
    expect(snapshot.profile.mainStats).toEqual(['dex']);
    expect(Date.parse(snapshot.fetchedAt)).toBeGreaterThan(0);
    expect(Date.parse(snapshot.starforceFetchedAt ?? '')).toBeGreaterThan(0);
    for (const equipment of Object.values(snapshot.equipmentPresets).flat()) {
      expect(Number.isInteger(equipment.starforce)).toBe(true);
      expect(equipment.starforce).toBeGreaterThanOrEqual(0);
      expect(equipment.starforce).toBeLessThanOrEqual(30);
    }
    expect(snapshot.sourceUrl).toContain('openapi.nexon.com');
    expect(snapshotText.toLowerCase()).not.toMatch(/ocid|api_key|apikey|x-nxopen/);
    const neutralPng = readFileSync(new URL('../public/character/neutral.png', import.meta.url));
    for (const reaction of ['cry', 'neutral', 'happy', 'jackpot', 'ghost']) {
      const png = readFileSync(new URL(`../public/character/${reaction}.png`, import.meta.url));
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(png.readUInt32BE(16)).toBe(neutralPng.readUInt32BE(16));
      expect(png.readUInt32BE(20)).toBe(neutralPng.readUInt32BE(20));
    }
  });
});
