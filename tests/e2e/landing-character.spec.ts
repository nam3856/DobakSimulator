import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CharacterSnapshot } from '../../src/types';

const sharedApi = 'https://fixture-api.example/api';
const modes = ['cube', 'ability', 'soulAmplification', 'soulPotential', 'abilityOptimizer'];

async function expectLaunchUrl(link: Locator, mode: string, nickname?: string) {
  const url = new URL(await link.evaluate((element) => (element as HTMLAnchorElement).href));
  expect(url.pathname).toBe('/DobakSimulator/');
  expect(url.hash).toBe(`#${mode}`);
  expect([...url.searchParams]).toEqual(nickname ? [['character', nickname]] : []);
}

async function mockCharacter(page: Page, name: string) {
  const character = JSON.parse(
    readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
  ) as CharacterSnapshot;
  character.name = name;
  character.bundledAvatars = false;
  character.fetchedAt = new Date().toISOString();
  character.imageUrl = 'http://127.0.0.1:4173/DobakSimulator/character/neutral.png';
  for (const equipment of Object.values(character.equipmentPresets)) {
    for (const item of equipment) item.imageUrl = character.imageUrl;
  }
  const requests: string[] = [];
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: sharedApi } }),
  );
  await page.route(`${sharedApi}/character?*`, (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: character });
  });
  await page.route('https://open.api.nexon.com/maplestory/v1/**', (route) => route.abort());
  return { requests, character };
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('optional nickname is trimmed and encoded in every launch link and survives card changes', async ({
  page,
}) => {
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '캐릭터 닉네임' });
  const launch = page.locator('#selected-launch');
  await expect(input).toHaveAttribute('id', 'character-name');
  expect(await input.evaluate((element) => (element as HTMLInputElement).required)).toBe(false);
  await expectLaunchUrl(launch, 'cube');

  const nickname = '별&+#?=';
  await input.fill(`  ${nickname}  `);
  for (const mode of modes) {
    const card = page.locator(`.simulator-card[data-simulator="${mode}"]`);
    await card.getByRole('button', { name: /선택$/ }).tap();
    await expect(input).toHaveValue(`  ${nickname}  `);
    await expectLaunchUrl(launch, mode, nickname);
    await expectLaunchUrl(card.locator('.card-start'), mode, nickname);
  }
  // A query value cannot introduce another parameter or replace the intended fragment.
  expect(await launch.getAttribute('href')).toContain('%26%2B%23%3F%3D');
  for (const mode of modes) {
    await expectLaunchUrl(
      page.locator(`.simulator-card[data-simulator="${mode}"] .card-start`),
      mode,
      nickname,
    );
  }
  await input.fill('   ');
  await expectLaunchUrl(launch, 'abilityOptimizer');
  for (const mode of modes) {
    await expectLaunchUrl(
      page.locator(`.simulator-card[data-simulator="${mode}"] .card-start`),
      mode,
    );
  }
  await input.fill('');
  await expectLaunchUrl(launch, 'abilityOptimizer');
});

test('Enter waits for Korean composition to end, then launches the selected mode and loads the nickname', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const nickname = '랜딩재설정캐릭터';
  const { requests } = await mockCharacter(page, nickname);
  await page.goto('/');
  await page
    .getByRole('button', { name: '어빌리티 고급 재설정 시뮬레이터 선택', exact: true })
    .tap();
  const input = page.getByRole('textbox', { name: '캐릭터 닉네임' });
  await input.fill(`  ${nickname}  `);
  const composingEnterWasAllowed = await input.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(composingEnterWasAllowed).toBe(false);
  expect(new URL(page.url()).pathname).toBe('/');
  expect(requests).toHaveLength(0);

  await input.press('Enter');
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/DobakSimulator/' &&
      url.hash === '#ability' &&
      url.searchParams.get('character') === nickname,
  );
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기', exact: true })).toContainText(
    nickname,
  );
  await expect(
    page.getByRole('navigation', { name: '시뮬레이터', exact: true }).getByRole('button', {
      name: '고급 재설정',
      exact: true,
    }),
  ).toHaveAttribute('aria-current', 'page');
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).searchParams.get('name')).toBe(nickname);
  expect(errors).toEqual([]);
});

test('optimizer card direct launch carries the nickname and looks it up only after starting', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const nickname = '랜딩최적화캐릭터';
  const { requests, character } = await mockCharacter(page, nickname);
  await page.goto('/');
  await page.getByRole('textbox', { name: '캐릭터 닉네임' }).fill(nickname);
  // The native start link must follow its own destination even while another card is selected.
  await page.locator('.simulator-card[data-simulator="abilityOptimizer"] .card-start').tap();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/DobakSimulator/' &&
      url.hash === '#abilityOptimizer' &&
      url.searchParams.get('character') === nickname,
  );
  const wizard = page.locator('.optimizer-wizard');
  await expect(wizard).toHaveAttribute('data-step', 'intro');
  expect(requests).toHaveLength(0);
  await wizard.getByRole('button', { name: '시작하기', exact: true }).tap();
  await expect(wizard).toHaveAttribute('data-step', 'character');
  await expect(page.getByLabel('최적화 캐릭터 닉네임', { exact: true })).toHaveValue(nickname);
  await expect(wizard.getByRole('button', { name: '다음', exact: true })).toBeEnabled();
  await expect(page.getByLabel('최적화 어빌리티 프리셋', { exact: true })).toHaveValue(
    character.activeAbilityPreset,
  );
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).searchParams.get('name')).toBe(nickname);
  expect(errors).toEqual([]);
});
