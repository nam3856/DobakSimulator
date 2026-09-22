import { expect, test, type Page } from '@playwright/test';
import { deserialize, type StoredSession } from '../../src/ui/storage';
import { selectSimulator } from './helpers/navigation';

const tabs = [
  ['cube', '큐브', '장비 강화'],
  ['bonusOptions', '추가옵션', '장비 강화'],
  ['starforce', '스타포스', '장비 강화'],
  ['ability', '고급 재설정', '어빌리티'],
  ['abilityOptimizer', '어빌리티 최적화', '어빌리티'],
  ['soulAmplification', '소울 증폭', '소울'],
  ['soulPotential', '소울 잠재', '소울'],
  ['abilityNormal', '일반 재설정', '어빌리티'],
] as const;

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
});

async function saved(page: Page) {
  return deserialize<StoredSession>(
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem('isekai-jikjak:session:v1')!;
    }),
  );
}

for (const [hash, name, group] of tabs) {
  test(`${hash} deep link and reload select its simulator group`, async ({ page }) => {
    await page.goto(`./#${hash}`);
    const navigation = page.getByRole('navigation', { name: '시뮬레이터', exact: true });
    const groupButton = navigation.getByRole('button', { name: `${group} 분류`, exact: true });
    const tabButton = navigation.getByRole('button', { name, exact: true });
    await expect(groupButton).toHaveAttribute('aria-pressed', 'true');
    await expect(tabButton).toHaveAttribute('aria-current', 'page');
    await expect(navigation.locator('button[aria-current="page"]')).toHaveCount(1);
    await page.reload();
    await expect(groupButton).toHaveAttribute('aria-pressed', 'true');
    await expect(tabButton).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveURL(new RegExp(`#${hash}$`));
  });
}

test('browsing groups and clicking the current simulator preserve paid progress', async ({
  page,
}) => {
  await page.goto('./#soulAmplification');
  const roll = page.getByRole('button', { name: '증폭 시도하기', exact: true });
  await expect(roll).toBeEnabled();
  await roll.click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  await expect.poll(async () => (await saved(page)).state.attempts).toBe(1n);
  const before = await saved(page);
  const navigation = page.getByRole('navigation', { name: '시뮬레이터', exact: true });

  for (const group of ['장비 강화', '어빌리티', '소울', '소울']) {
    await navigation.getByRole('button', { name: `${group} 분류`, exact: true }).click();
    await expect(page).toHaveURL(/#soulAmplification$/);
    expect((await saved(page)).config).toEqual(before.config);
    expect((await saved(page)).state).toEqual(before.state);
  }
  await selectSimulator(page, '소울 증폭');
  expect((await saved(page)).state).toEqual(before.state);
  await selectSimulator(page, '어빌리티 최적화');
  await expect(page).toHaveURL(/#abilityOptimizer$/);
  const during = await saved(page);
  expect(during.config).toEqual(before.config);
  expect(during.state.attempts).toBe(before.state.attempts);
  expect(during.state.spent).toEqual(before.state.spent);
  await selectSimulator(page, '소울 증폭');
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
});

test('external hash changes reveal the destination group after browsing another group', async ({
  page,
}) => {
  await page.goto('./#cube');
  const navigation = page.getByRole('navigation', { name: '시뮬레이터', exact: true });
  await navigation.getByRole('button', { name: '소울 분류', exact: true }).click();
  for (const [hash, name, group] of [tabs[4], tabs[1], tabs[6]]) {
    await page.evaluate((value) => {
      location.hash = value;
    }, hash);
    await expect(
      navigation.getByRole('button', { name: `${group} 분류`, exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(navigation.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
});

test('both navigation rows fit on mobile and support keyboard selection', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 1000 });
  await page.goto('./#cube');
  const navigation = page.getByRole('navigation', { name: '시뮬레이터', exact: true });
  await expect(navigation).toBeVisible();

  for (const theme of ['dark', 'light']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page
        .getByRole('button', { name: theme === 'light' ? '밝은 테마' : '어두운 테마', exact: true })
        .click();
    for (const group of ['장비 강화', '어빌리티', '소울']) {
      const button = navigation.getByRole('button', { name: `${group} 분류`, exact: true });
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(/#cube$/);
      const bounds = (await navigation.boundingBox())!;
      for (const item of await navigation.getByRole('button').all()) {
        const box = (await item.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        360,
      );
    }
  }

  await navigation.getByRole('button', { name: '장비 강화 분류', exact: true }).click();
  await navigation.getByRole('button', { name: '추가옵션', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#bonusOptions$/);
  await expect(navigation.getByRole('button', { name: '추가옵션', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
