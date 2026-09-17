import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type {
  CharacterSnapshot,
  OptionLine,
  SimulationConfig,
  SimulationState,
} from '../../src/types';
import { deserialize, serialize, type StoredSession } from '../../src/ui/storage';

const SESSION_KEY = 'isekai-jikjak:session:v1';
const ARCHIVE_KEY = 'isekai-jikjak:archive:v1';
const SHARED_API = 'https://fixture-api.example/api';

function fixtureCharacter(name = '깽미니'): CharacterSnapshot {
  const character = JSON.parse(
    readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
  ) as CharacterSnapshot;
  character.name = name;
  character.imageUrl = 'http://127.0.0.1:4173/DobakSimulator/character/neutral.png';
  for (const [preset, items] of Object.entries(character.equipmentPresets)) {
    const weapon = items.find((item) => item.category === 'weapon')!;
    const stage = Number(preset) + 1;
    weapon.soul = {
      name: '조회한 소울',
      active: true,
      stage,
      grade: 'epic',
      lines: [
        { type: 'attackPercent', text: `공격력 +${stage}%` },
        { type: 'dexPercent', text: `DEX +${stage}%` },
        { type: 'intPercent', text: `INT +${stage}%` },
      ].map(({ type, text }) => ({
        id: text,
        type,
        text,
        value: stage,
        unit: 'percent',
        grade: 'epic',
      })),
    };
    for (const item of items) item.imageUrl = character.imageUrl;
  }
  return character;
}

async function stored(page: Page): Promise<StoredSession> {
  const raw = await page.evaluate((key) => {
    window.dispatchEvent(new Event('pagehide'));
    return localStorage.getItem(key)!;
  }, SESSION_KEY);
  return deserialize<StoredSession>(raw);
}

async function boot(page: Page, hash = '#cube') {
  await page.goto(`./${hash}`);
  await expect(page.locator('.mode-fixed')).toContainText('지금부터 업그레이드');
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중');
}

const lineValues = (lines: OptionLine[]) =>
  lines.map(({ type, value, unit }) => ({ type, value, unit }));

async function expectImportedStart(page: Page) {
  await expect(page.locator('.mode-fixed')).toContainText('지금부터 업그레이드');
  await expect(page.getByRole('button', { name: '현재 옵션 재현', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '지금부터 업그레이드', exact: true })).toHaveCount(
    0,
  );
  const session = await stored(page);
  const { config, character, state } = session;
  const item = character.equipmentPresets[session.equipmentPreset].find(
    (entry) => entry.id === session.equipmentId,
  )!;
  expect(session.playMode).toBe('upgrade');
  expect(state.attempts).toBe(0n);
  expect(state.spent.meso).toBe(0n);
  expect(config.start.failures).toBe(0);
  expect(state.lines).toEqual(config.start.lines);
  if (config.mode === 'ability') {
    // The API can mark a recognized ability as unknown; compare the preserved display options.
    const displayed = (lines: OptionLine[]) =>
      lines.map((line) => line.text.replace(/[\s:：+]/g, ''));
    expect(displayed(config.start.lines)).toEqual(
      displayed(character.abilityPresets[session.abilityPreset].lines),
    );
    expect(config.start.grade).toBe('legendary');
  } else if (config.mode === 'cube') {
    const additional = ['additional', 'primeAdditional'].includes(config.cubeType);
    expect(lineValues(config.start.lines)).toEqual(
      lineValues(additional ? item.additional : item.potential),
    );
    expect(config.start.grade).toBe(additional ? item.additionalGrade : item.potentialGrade);
    expect(config.category).toBe(item.category);
    expect(config.level).toBe(item.level);
  } else {
    expect(config.start.stage).toBe(item.soul!.stage);
    if (config.mode === 'soulPotential') {
      expect(config.start.grade).toBe(item.soul!.grade);
      expect(lineValues(config.start.lines)).toEqual(lineValues(item.soul!.lines));
    }
  }
  return session;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: SHARED_API } }),
  );
  await page.route('**/character/snapshot.json', (route) =>
    route.fulfill({ json: fixtureCharacter() }),
  );
});

test('all tabs, cube types, equipment and presets start from their imported options and stages', async ({
  page,
}) => {
  await boot(page);
  await expectImportedStart(page);
  for (const name of ['에디셔널큐브', '골드큐브', '프라임큐브', '프라임 에디셔널', '블랙큐브']) {
    await page
      .locator('.cube-picker')
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click();
    await expectImportedStart(page);
  }
  for (const name of ['어빌리티', '소울 증폭', '소울 잠재']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    await expectImportedStart(page);
    const preset = page.getByLabel(name === '어빌리티' ? '어빌리티 프리셋' : '장비 프리셋');
    await preset.selectOption('2');
    await expectImportedStart(page);
    await preset.selectOption('3');
    await expectImportedStart(page);
  }
  await page.getByRole('navigation').getByRole('button', { name: '큐브', exact: true }).click();
  const session = await stored(page);
  const hat = session.character.equipmentPresets[session.equipmentPreset].find(
    (item) => item.category === 'hat',
  )!;
  await page.getByLabel('장비 선택').selectOption(hat.id);
  await expectImportedStart(page);
  await page.getByLabel('장비 프리셋').selectOption('1');
  await expectImportedStart(page);
  await page.reload();
  await expectImportedStart(page);
});

test('nickname search loads the active equipment and soul state in every equipment simulator', async ({
  page,
}) => {
  const imported = fixtureCharacter('업그레이드조회');
  imported.activeEquipmentPreset = '2';
  await page.route(`${SHARED_API}/character?*`, (route) =>
    route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: imported }),
  );
  await boot(page);
  for (const name of ['큐브', '소울 증폭', '소울 잠재']) {
    await page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
    await page.getByLabel('장비 프리셋').selectOption('1');
    await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
    await page.getByLabel('캐릭터 닉네임').fill(imported.name);
    await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText(
      imported.name,
    );
    await expect(page.getByLabel('장비 프리셋')).toHaveValue('2');
    await expectImportedStart(page);
  }
});

function legacySession(seed: StoredSession): StoredSession {
  const previous = structuredClone(seed);
  previous.playMode = 'recreate';
  previous.config.category = 'hat';
  previous.config.level = 140;
  previous.config.start = { grade: 'rare', lines: [], stage: 0, failures: 9 };
  previous.config.batchSize = previous.config.mode === 'soulAmplification' ? 1 : 3;
  previous.config.unitPrices = { gold: '123456', ether3: '654321' };
  previous.config.target = {
    mode: previous.config.mode === 'soulAmplification' ? 'stage' : 'sum',
    minimumGrade: 'legendary',
    conditions: [{ type: 'attackPercent', minValue: 8 }],
    lines: [],
    match: 'all',
    stage: 4,
  };
  previous.state = {
    ...previous.state,
    ...previous.config.start,
    status: 'paused',
    attempts: 3n,
    spent: { meso: 123456789n, cubes: 0n, honor: 0n, credits: 0n, ethers: [0n, 1n, 0n, 0n] },
    history: [],
    candidates: [],
  };
  return previous;
}

async function installLegacy(page: Page, session: StoredSession) {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: SESSION_KEY,
    value: serialize(session),
  });
}

async function expectArchived(page: Page, previous: StoredSession) {
  const records = deserialize<{ config: SimulationConfig; state: SimulationState }[]>(
    await page.evaluate((key) => localStorage.getItem(key)!, ARCHIVE_KEY),
  );
  expect(records[0].config).toEqual(previous.config);
  expect(records[0].state).toEqual(previous.state);
}

for (const mode of ['cube', 'soulAmplification', 'soulPotential'] as const) {
  test(`legacy recreate ${mode} archives paid progress and keeps its goal and prices with the imported start`, async ({
    page,
  }) => {
    await boot(page, `#${mode}`);
    if (mode === 'cube')
      await page
        .locator('.cube-picker')
        .getByRole('button', { name: /^에디셔널큐브/ })
        .click();
    const previous = legacySession(await stored(page));
    await installLegacy(page, previous);
    await page.reload();
    const migrated = await expectImportedStart(page);
    expect(migrated.config.target).toEqual(previous.config.target);
    expect(migrated.config.batchSize).toBe(previous.config.batchSize);
    expect(migrated.config.unitPrices).toEqual(previous.config.unitPrices);
    expect(migrated.state.candidates).toEqual([]);
    expect(migrated.state.history).toEqual([]);
    await expectArchived(page, previous);
    await expect(page.locator('.luck-badge')).toHaveCount(0);
  });
}

test('opening another tab from a legacy recreate URL still archives its paid challenge', async ({
  page,
}) => {
  await boot(page);
  const previous = legacySession(await stored(page));
  await installLegacy(page, previous);
  await page.goto('./?legacy=1#soulAmplification');
  await expect(page.getByRole('heading', { name: '소울 증폭 시뮬레이터' })).toBeVisible();
  await expectImportedStart(page);
  await expectArchived(page, previous);
});
