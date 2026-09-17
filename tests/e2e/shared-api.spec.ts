import { test, expect, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CharacterSnapshot } from '../../src/types.ts';

const SHARED_API = 'https://fixture-api.example/api';
const SHARED_ROUTE = `${SHARED_API}/character?*`;
const PERSONAL_KEY = 'personal-test-memory-only-key';

function characterFixture(name = '공용테스트'): CharacterSnapshot {
  const character = JSON.parse(
    readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
  ) as CharacterSnapshot;
  character.name = name;
  character.imageUrl = 'http://127.0.0.1:4173/DobakSimulator/character/neutral.png';
  character.fetchedAt = new Date().toISOString();
  for (const items of Object.values(character.equipmentPresets))
    for (const item of items) item.imageUrl = character.imageUrl;
  return character;
}

async function openSharedSearch(page: Page) {
  const directApiRequests: string[] = [];
  await page.route('https://open.api.nexon.com/maplestory/v1/**', async (route) => {
    directApiRequests.push(route.request().url());
    await route.abort();
  });
  await page.route('**/DobakSimulator/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: SHARED_API } }),
  );
  await page.goto('./#cube');
  await expect(page.getByRole('heading', { name: '같은 목표, 다른 세계의 나.' })).toBeVisible();
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
  await expect(page.getByRole('button', { name: '개인 키로 전환', exact: true })).toBeVisible();
  await expect(page.getByLabel('개인 Nexon Open API 키')).toHaveCount(0);
  return directApiRequests;
}

async function expectPublicRequest(request: Request, nickname: string) {
  const url = new URL(request.url());
  expect(url.origin + url.pathname).toBe(`${SHARED_API}/character`);
  expect([...url.searchParams]).toEqual([['name', nickname]]);
  expect(request.method()).toBe('GET');
  expect(request.postData()).toBeNull();
  const headers = await request.allHeaders();
  for (const header of ['authorization', 'cookie', 'x-nxopen-api-key'])
    expect(headers).not.toHaveProperty(header);
  expect(JSON.stringify(headers)).not.toContain(PERSONAL_KEY);
  expect(request.url()).not.toContain(PERSONAL_KEY);
}

test('runtime configuration enables nickname-only lookup through the shared server', async ({
  page,
}) => {
  const requests: Request[] = [];
  await page.route(SHARED_ROUTE, async (route) => {
    requests.push(route.request());
    await route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      json: characterFixture(),
    });
  });
  const directApiRequests = await openSharedSearch(page);
  await page.getByLabel('캐릭터 닉네임').fill('공용테스트');
  const submit = page.getByRole('button', { name: '캐릭터 불러오기', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('공용테스트');
  await expect(page.locator('.reaction-stage')).toContainText('공용테스트');
  expect(requests).toHaveLength(1);
  await expectPublicRequest(requests[0], '공용테스트');
  expect(directApiRequests).toEqual([]);
});

test('personal keys appear only after switching modes and stay out of shared searches and storage', async ({
  page,
}) => {
  let sharedRequest: Request | undefined;
  await page.route(SHARED_ROUTE, async (route) => {
    sharedRequest = route.request();
    await route.fulfill({
      headers: { 'Access-Control-Allow-Origin': '*' },
      json: characterFixture(),
    });
  });
  const directApiRequests = await openSharedSearch(page);
  await page.getByRole('button', { name: '개인 키로 전환', exact: true }).click();
  await expect(page.getByLabel('개인 Nexon Open API 키')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: '캐릭터 불러오기', exact: true })).toBeDisabled();
  await page.getByLabel('개인 Nexon Open API 키').fill(PERSONAL_KEY);
  await page.getByRole('button', { name: '공용 검색으로 전환', exact: true }).click();
  await expect(page.getByLabel('개인 Nexon Open API 키')).toHaveCount(0);
  await page.getByLabel('캐릭터 닉네임').fill('공용테스트');
  await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('공용테스트');
  expect(sharedRequest).toBeDefined();
  await expectPublicRequest(sharedRequest!, '공용테스트');
  expect(await page.evaluate(() => JSON.stringify({ localStorage, sessionStorage }))).not.toContain(
    PERSONAL_KEY,
  );
  expect(directApiRequests).toEqual([]);
});

for (const scenario of [
  { status: 404, code: 'CHARACTER_NOT_FOUND', message: '캐릭터를 찾을 수 없습니다.' },
  { status: 429, code: 'RATE_LIMITED', message: '공용 검색의 호출 한도에 도달했습니다.' },
  { status: 503, code: 'SERVICE_UNAVAILABLE', message: '공용 검색을 잠시 사용할 수 없습니다.' },
  {
    status: 200,
    code: 'MALFORMED_SNAPSHOT',
    message: '공용 검색에서 올바른 캐릭터 정보를 받지 못했습니다.',
  },
]) {
  test(`shared lookup handles ${scenario.code} without replacing the current character or echoing provider text`, async ({
    page,
  }) => {
    await page.route(SHARED_ROUTE, (route) =>
      route.fulfill({
        status: scenario.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
        json: {
          error: {
            code: scenario.code,
            message: 'private-provider-message private-ocid secret-key',
          },
        },
      }),
    );
    const directApiRequests = await openSharedSearch(page);
    await page.getByLabel('캐릭터 닉네임').fill('조회테스트');
    await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(scenario.message);
    await expect(page.getByRole('alert')).not.toContainText(
      /private-provider-message|private-ocid|secret-key/,
    );
    await expect(page.getByRole('button', { name: '캐릭터 불러오기', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '캐릭터 검색 닫기' }).click();
    await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
    expect(directApiRequests).toEqual([]);
  });
}

test('closing an in-flight shared search cancels it and retains the previous character', async ({
  page,
}) => {
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await page.route(SHARED_ROUTE, async (route) => {
    await responseGate;
    await route
      .fulfill({
        headers: { 'Access-Control-Allow-Origin': '*' },
        json: characterFixture('취소된캐릭터'),
      })
      .catch(() => {});
  });
  const directApiRequests = await openSharedSearch(page);
  await page.getByLabel('캐릭터 닉네임').fill('취소된캐릭터');
  const sent = page.waitForRequest((request) =>
    request.url().startsWith(`${SHARED_API}/character?`),
  );
  const cancelled = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url().startsWith(`${SHARED_API}/character?`),
  });
  try {
    await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
    await sent;
    await page.getByRole('button', { name: '캐릭터 검색 닫기' }).click();
    await cancelled;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
    expect(directApiRequests).toEqual([]);
  } finally {
    releaseResponse();
  }
});
