import { test, expect, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { CharacterSnapshot } from '../../src/types.ts';
import { deserialize, type StoredSession } from '../../src/ui/storage';

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
  await expect(page.getByLabel('캐릭터 닉네임')).toHaveValue('');
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
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
  await expect(page.getByLabel('캐릭터 닉네임')).toHaveValue('');
});

test('nickname selection drags stay open while backdrop clicks and explicit close actions dismiss', async ({
  page,
}) => {
  await openSharedSearch(page);
  const dialog = page.getByRole('dialog');
  const input = page.getByLabel('캐릭터 닉네임');
  await expect(page.getByRole('button', { name: '캐릭터 불러오기', exact: true })).toBeDisabled();
  await input.fill('드래그할닉네임');
  const bounds = await input.boundingBox();
  expect(bounds).not.toBeNull();
  const outside = { x: 5, y: bounds!.y + bounds!.height / 2 };
  const inside = { x: bounds!.x + bounds!.width - 12, y: outside.y };
  await page.mouse.move(inside.x, inside.y);
  await page.mouse.down();
  await page.mouse.move(outside.x, outside.y, { steps: 12 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  expect(
    await input.evaluate((element: HTMLInputElement) =>
      Math.abs((element.selectionEnd ?? 0) - (element.selectionStart ?? 0)),
    ),
  ).toBeGreaterThan(0);
  await expect(input).toHaveValue('드래그할닉네임');

  await page.mouse.move(outside.x, outside.y);
  await page.mouse.down();
  await page.mouse.move(inside.x, inside.y, { steps: 12 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();

  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
  await input.fill('지울닉네임');
  await page.getByRole('button', { name: '캐릭터 검색 닫기' }).click();
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
  await expect(input).toHaveValue('');
});

test('searching a different job selects its endgame ability goal from the imported active preset and restores it', async ({
  page,
}) => {
  const character = characterFixture('비숍테스트');
  character.job = '비숍';
  character.profile = { mainStats: ['int'], secondaryStats: ['luk'], attackType: 'magicAttack' };
  character.activeAbilityPreset = '2';
  await page.route(SHARED_ROUTE, (route) =>
    route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: character }),
  );
  await openSharedSearch(page);
  await page.getByRole('button', { name: '캐릭터 검색 닫기' }).click();
  await page.getByRole('navigation').getByRole('button', { name: '어빌리티', exact: true }).click();
  await expect(page.getByLabel('직업별 종결 어빌리티')).toHaveValue('메카닉');
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
  await page.getByLabel('캐릭터 닉네임').fill(character.name);
  await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  async function expectImportedAbility() {
    await expect(page.getByLabel('직업별 종결 어빌리티')).toHaveValue('비숍');
    await expect(page.getByLabel('어빌리티 프리셋')).toHaveValue('2');
    await expect(page.locator('.mode-fixed')).toContainText('지금부터 업그레이드');
    await expect(page.getByRole('button', { name: '현재 옵션 재현', exact: true })).toHaveCount(0);
    for (const [index, type, value] of [
      [1, 'bossDamagePercent', '15'],
      [2, 'statusAilmentDamagePercent', '9'],
      [3, 'magicAttackFlat', '27'],
    ] as const) {
      await expect(page.getByLabel(`목표 조건 ${index} 옵션`)).toHaveValue(type);
      await expect(page.getByLabel(`목표 조건 ${index} 수치`)).toHaveValue(value);
      await expect(page.getByLabel(`목표 조건 ${index} 등급`)).toHaveValue('legendary');
    }
    for (const line of character.abilityPresets['2'].lines)
      await expect(page.locator('.current-result')).toContainText(line.text);
    await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('0회');
  }
  await expectImportedAbility();
  const raw = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    return localStorage.getItem('isekai-jikjak:session:v1')!;
  });
  const saved = deserialize<StoredSession>(raw);
  expect(saved.playMode).toBe('upgrade');
  expect(saved.config.abilityPresetJob).toBe('비숍');
  expect(saved.config.start.lines.map((line) => line.text)).toEqual(
    character.abilityPresets['2'].lines.map((line) => line.text),
  );
  await page.reload();
  await expectImportedAbility();
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
