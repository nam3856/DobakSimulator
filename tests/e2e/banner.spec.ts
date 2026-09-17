import { test, expect, type Page } from '@playwright/test';

const AD_NOTICE = '가짜 광고입니다. 실제 광고나 외부 링크가 아니에요.';

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  await page.addInitScript(() => {
    const random = Number(new URL(location.href).searchParams.get('bannerRandom') ?? '0');
    Math.random = () => random;
  });
});

async function openBanner(
  page: Page,
  random = 0,
  hash = '#soulAmplification',
  clockPaused = false,
) {
  await page.goto(`./?bannerRandom=${random}${hash}`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toBeVisible();
  await expect(page.locator('.fake-ad-banner')).toBeVisible();
  if (clockPaused) await page.clock.fastForward(300);
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중');
}

async function pauseClock(page: Page) {
  const time = new Date('2026-09-17T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
}

async function simulationSnapshot(page: Page) {
  return {
    stats: await page.locator('.stat-card strong').allTextContents(),
    options: await page.locator('.current-result').allTextContents(),
    status: await page.locator('.status-badge').textContent(),
    ledger: await page.locator('.resource-ledger').allTextContents(),
    inputs: await page.locator('main input, main select').evaluateAll((elements) =>
      elements.map((element) => ({
        label: element.getAttribute('aria-label'),
        value: (element as HTMLInputElement | HTMLSelectElement).value,
      })),
    ),
  };
}

test('each equal random half loads an enabled banner under the Pages subpath', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (let index = 0; index < 2; index++) {
    await openBanner(page, (index + 0.5) / 2);
    const image = page.locator('.fake-ad-banner img');
    await expect(image).toHaveAttribute(
      'src',
      new RegExp(`banners/ad-${index + 2}\\.png(?:\\?|$)`),
    );
    await expect(image).toHaveJSProperty('naturalWidth', 1028);
    await expect(image).toHaveJSProperty('naturalHeight', 382);
    await expect(image).toHaveAttribute('alt', /\S/);
    const resource = await image.evaluate((element: HTMLImageElement) => element.currentSrc);
    expect(new URL(resource).pathname).toBe(`/DobakSimulator/banners/ad-${index + 2}.png`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/이세계 직작/);
    await expect(page.getByRole('heading', { name: '같은 목표, 다른 세계의 나.' })).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('minute rotation excludes the current banner and survives rerolls, theme and tab changes', async ({
  page,
}) => {
  await pauseClock(page);
  await openBanner(page, 0, '#soulAmplification', true);
  const image = page.locator('.fake-ad-banner img');
  await expect(image).toHaveAttribute('src', /banners\/ad-[23]\.png(?:\?|$)/);
  const first = await image.getAttribute('src');
  await page.clock.fastForward(29700);
  await page.getByRole('button', { name: '증폭 시도하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  await expect(image).toHaveAttribute('src', first!);
  await page.getByRole('button', { name: '밝은 테마', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: '큐브', exact: true }).click();
  await expect(image).toHaveAttribute('src', first!);
  await page.clock.fastForward(300);
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중');
  const state = await simulationSnapshot(page);
  await page.clock.fastForward(29699);
  await expect(image).toHaveAttribute('src', first!);
  await page.clock.fastForward(1);
  await expect(image).not.toHaveAttribute('src', first!);
  await expect(image).toHaveAttribute('src', /banners\/ad-[23]\.png(?:\?|$)/);
  let previous = await image.getAttribute('src');
  for (let index = 0; index < 3; index++) {
    await page.clock.fastForward(60000);
    await expect(image).not.toHaveAttribute('src', previous!);
    await expect(image).toHaveAttribute('src', /banners\/ad-[23]\.png(?:\?|$)/);
    previous = await image.getAttribute('src');
  }
  expect(await simulationSnapshot(page)).toEqual(state);
});

test('banner mouse and keyboard actions show a resettable three-second notice without changing the challenge', async ({
  page,
}) => {
  await pauseClock(page);
  await openBanner(page, 0.75, '#soulAmplification', true);
  await page.getByRole('button', { name: '증폭 시도하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  const state = await simulationSnapshot(page);
  const banner = page.locator('.fake-ad-banner');
  const toast = page.locator('.fake-ad-toast');
  const url = page.url();
  await banner.click();
  await expect(page.locator('.fake-ad-status')).toHaveAttribute('role', 'status');
  await expect(toast).toHaveText(AD_NOTICE);
  await page.clock.fastForward(2000);
  await banner.click();
  await page.clock.fastForward(2999);
  await expect(toast).toBeVisible();
  await page.clock.fastForward(1);
  await expect(toast).toBeHidden();
  for (const key of ['Enter', 'Space']) {
    await banner.focus();
    await page.keyboard.press(key);
    await expect(toast).toHaveText(AD_NOTICE);
    await page.clock.fastForward(3000);
    await expect(toast).toBeHidden();
  }
  expect(await simulationSnapshot(page)).toEqual(state);
  expect(page.url()).toBe(url);
  expect(page.context().pages()).toHaveLength(1);
});

test('banners preserve their full image and layout in both themes, on mobile and on image failure', async ({
  page,
}) => {
  await openBanner(page, 0.75);
  const banner = page.locator('.fake-ad-banner');
  const image = banner.locator('img');
  for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const theme of ['dark', 'light']) {
      const current = await page.locator('html').getAttribute('data-theme');
      if (current !== theme)
        await page
          .getByRole('button', { name: theme === 'light' ? '밝은 테마' : '어두운 테마' })
          .click();
      await expect(image).toHaveJSProperty('naturalWidth', 1028);
      const bounds = (await banner.boundingBox())!;
      const imageBounds = (await image.boundingBox())!;
      expect(bounds.width).toBeLessThanOrEqual(593);
      expect(bounds.height).toBeLessThanOrEqual(221);
      expect(imageBounds.width / imageBounds.height).toBeCloseTo(1028 / 382, 2);
      expect(imageBounds.x).toBeGreaterThanOrEqual(bounds.x);
      expect(imageBounds.y).toBeGreaterThanOrEqual(bounds.y);
      expect(imageBounds.x + imageBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      expect(imageBounds.y + imageBounds.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      const character = (await page
        .getByRole('button', { name: '캐릭터 검색 열기' })
        .boundingBox())!;
      if (width === 360) expect(character.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
      else expect(character.x).toBeGreaterThanOrEqual(bounds.x + bounds.width);
    }
  }
  const before = await banner.boundingBox();
  await page.route('**/banners/ad-*.png', (route) => route.abort());
  await page.reload();
  await expect(page.locator('.fake-ad-fallback')).toBeVisible();
  expect(await banner.boundingBox()).toEqual(before);
  await banner.click();
  await expect(page.locator('.fake-ad-toast')).toHaveText(AD_NOTICE);
});
