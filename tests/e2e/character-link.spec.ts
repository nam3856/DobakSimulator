import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CharacterSnapshot } from '../../src/types';
import { deserialize, type StoredSession } from '../../src/ui/storage';

const SHARED_API = 'https://fixture-api.example/api';
const SHARED_ROUTE = `${SHARED_API}/character?*`;
const SESSION_KEY = 'isekai-jikjak:session:v1';

function characterFixture(name: string): CharacterSnapshot {
  const character = JSON.parse(
    readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
  ) as CharacterSnapshot;
  character.name = name;
  character.imageUrl = 'http://127.0.0.1:4173/DobakSimulator/character/neutral.png';
  for (const items of Object.values(character.equipmentPresets))
    for (const item of items) item.imageUrl = character.imageUrl;
  return character;
}

async function configureSharedApi(page: Page, characterApiBaseUrl = SHARED_API) {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl } }),
  );
  await page.route('https://open.api.nexon.com/maplestory/v1/**', (route) => route.abort());
}

async function readSavedSession(page: Page) {
  return deserialize<StoredSession>(
    await page.evaluate((key) => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem(key)!;
    }, SESSION_KEY),
  );
}

async function payForOneAmplification(page: Page) {
  await page.getByRole('button', { name: '증폭 시도하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  return readSavedSession(page);
}

test('a character link imports active presets, uses the returned name and preserves other URL fields', async ({
  page,
}) => {
  const character = characterFixture('주소응답캐릭터');
  character.activeEquipmentPreset = '2';
  character.activeAbilityPreset = '3';
  const requested: string[] = [];
  await configureSharedApi(page);
  await page.route(SHARED_ROUTE, (route) => {
    requested.push(new URL(route.request().url()).searchParams.get('name')!);
    return route.fulfill({ json: character });
  });

  await page.goto(`./?v=preview&character=${encodeURIComponent('주소요청캐릭터')}#cube`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText(
    character.name,
  );
  await expect(page.getByLabel('장비 프리셋')).toHaveValue('2');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(requested).toEqual(['주소요청캐릭터']);
  const url = new URL(page.url());
  expect([...url.searchParams]).toEqual([
    ['v', 'preview'],
    ['character', character.name],
  ]);
  expect(url.hash).toBe('#cube');

  await page.getByRole('navigation').getByRole('button', { name: '어빌리티', exact: true }).click();
  await expect(page.getByLabel('어빌리티 프리셋')).toHaveValue('3');
  expect(new URL(page.url()).searchParams.get('character')).toBe(character.name);
  expect(new URL(page.url()).searchParams.get('v')).toBe('preview');
  expect(new URL(page.url()).hash).toBe('#ability');
  expect(requested).toHaveLength(1);
});

test('reloading a matching character link restores paid progress without another lookup', async ({
  page,
}) => {
  const character = characterFixture('새로고침캐릭터');
  let requests = 0;
  await configureSharedApi(page);
  await page.route(SHARED_ROUTE, (route) => {
    requests += 1;
    return route.fulfill({ json: character });
  });
  await page.goto(`./?character=${encodeURIComponent(character.name)}#soulAmplification`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText(
    character.name,
  );
  const before = await payForOneAmplification(page);
  expect(before.state.spent.meso).toBeGreaterThan(0n);

  await page.reload();
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText(
    character.name,
  );
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  const after = await readSavedSession(page);
  expect(after.state.attempts).toBe(before.state.attempts);
  expect(after.state.spent).toEqual(before.state.spent);
  expect(after.state.stage).toBe(before.state.stage);
  expect(after.state.failures).toBe(before.state.failures);
  expect(requests).toBe(1);
  expect(new URL(page.url()).searchParams.get('character')).toBe(character.name);
});

test('opening another character link archives the previous paid challenge before starting fresh', async ({
  page,
}) => {
  const character = characterFixture('새링크캐릭터');
  await configureSharedApi(page);
  await page.route(SHARED_ROUTE, (route) => route.fulfill({ json: character }));
  await page.goto('./#soulAmplification');
  const before = await payForOneAmplification(page);
  expect(before.character.name).toBe('깽미니');

  await page.goto(`./?character=${encodeURIComponent(character.name)}#soulAmplification`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText(
    character.name,
  );
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('0회');
  const archived = deserialize<Array<Pick<StoredSession, 'config' | 'state'>>>(
    await page.evaluate(() => localStorage.getItem('isekai-jikjak:archive:v1')!),
  );
  expect(archived).toHaveLength(1);
  expect(archived[0].state.spent).toEqual(before.state.spent);
  expect(archived[0].state.attempts).toBe(before.state.attempts);
  expect((await readSavedSession(page)).character.name).toBe(character.name);
});

test('a matching character link to another tab archives paid progress without fetching again', async ({
  page,
}) => {
  let requests = 0;
  await configureSharedApi(page);
  await page.route(SHARED_ROUTE, (route) => {
    requests += 1;
    return route.abort();
  });
  await page.goto('./#soulAmplification');
  const before = await payForOneAmplification(page);

  await page.goto(`./?character=${encodeURIComponent(before.character.name)}#ability`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
  await expect(page.getByRole('heading', { name: '고급 어빌리티 시뮬레이터' })).toBeVisible();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('0회');
  const archived = deserialize<Array<Pick<StoredSession, 'config' | 'state'>>>(
    await page.evaluate(() => localStorage.getItem('isekai-jikjak:archive:v1')!),
  );
  expect(archived).toHaveLength(1);
  expect(archived[0].config.mode).toBe('soulAmplification');
  expect(archived[0].state.spent).toEqual(before.state.spent);
  expect(archived[0].state.attempts).toBe(before.state.attempts);
  expect(requests).toBe(0);
  expect((await readSavedSession(page)).config.mode).toBe('ability');
});

test('failed automatic lookup restores the default character and offers a prefilled retry', async ({
  page,
}) => {
  const character = characterFixture('재시도캐릭터');
  let requests = 0;
  await configureSharedApi(page);
  await page.route(SHARED_ROUTE, (route) => {
    requests += 1;
    return requests === 1
      ? route.fulfill({ status: 404, json: { error: { code: 'CHARACTER_NOT_FOUND' } } })
      : route.fulfill({ json: character });
  });
  await page.goto(`./?v=retry&character=${encodeURIComponent(character.name)}#ability`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
  await expect(page.getByLabel('캐릭터 닉네임')).toHaveValue(character.name);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '개인 키로 전환', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('character')).toBe(character.name);

  await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText(
    character.name,
  );
  expect(requests).toBe(2);
  expect(new URL(page.url()).hash).toBe('#ability');
  expect(new URL(page.url()).searchParams.get('v')).toBe('retry');
});

test('a character link without a shared server keeps saved progress and opens personal search', async ({
  page,
}) => {
  await configureSharedApi(page, '');
  await page.goto('./#soulAmplification');
  const before = await payForOneAmplification(page);

  await page.goto(`./?character=${encodeURIComponent('개인검색캐릭터')}#ability`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
  await expect(page.getByLabel('캐릭터 닉네임')).toHaveValue('개인검색캐릭터');
  await expect(page.getByLabel('개인 Nexon Open API 키')).toHaveValue('');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '캐릭터 불러오기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '캐릭터 검색 닫기' }).click();
  const after = await readSavedSession(page);
  expect(after.state.spent).toEqual(before.state.spent);
  expect(after.state.attempts).toBe(before.state.attempts);
  expect(after.config.mode).toBe('soulAmplification');
  expect(new URL(page.url()).hash).toBe('#soulAmplification');
  expect(new URL(page.url()).searchParams.get('character')).toBe('개인검색캐릭터');
  expect(await page.evaluate(() => localStorage.getItem('isekai-jikjak:archive:v1'))).toBeNull();
});

test('missing, empty and whitespace character parameters keep the normal saved-session startup', async ({
  page,
}) => {
  let requests = 0;
  await configureSharedApi(page);
  await page.route(SHARED_ROUTE, (route) => {
    requests += 1;
    return route.abort();
  });
  await page.goto('./#soulAmplification');
  const before = await payForOneAmplification(page);
  for (const search of ['', '?character=', '?v=keep&character=%20%20']) {
    await page.goto(`./${search}#soulAmplification`);
    await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
    expect((await readSavedSession(page)).state.spent).toEqual(before.state.spent);
  }
  expect(requests).toBe(0);
});
