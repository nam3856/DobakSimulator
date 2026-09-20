import { test, expect, type Page } from '@playwright/test';
import { selectSimulator } from './helpers/navigation';

const EXTERNAL_EVENT_URL = 'https://maplestory.nexon.com/News/Event/Ongoing/1389';
const AUCTION_URL = 'https://auction.maplestory.nexon.com/';

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

test('each equal random quarter loads an enabled banner under the Pages subpath', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (let index = 0; index < 4; index++) {
    await openBanner(page, (index + 0.5) / 4);
    const image = page.locator('.fake-ad-banner img');
    await expect(image).toHaveAttribute(
      'src',
      new RegExp(`banners/ad-${index + 1}\\.png(?:\\?|$)`),
    );
    await expect(image).toHaveJSProperty('naturalWidth', index === 0 ? 2057 : 1028);
    await expect(image).toHaveJSProperty('naturalHeight', index === 0 ? 764 : 382);
    await expect(image).toHaveAttribute('width', index === 0 ? '2057' : '1028');
    await expect(image).toHaveAttribute('height', index === 0 ? '764' : '382');
    await expect(image).toHaveAttribute('alt', /\S/);
    const resource = await image.evaluate((element: HTMLImageElement) => element.currentSrc);
    expect(new URL(resource).pathname).toBe(`/DobakSimulator/banners/ad-${index + 1}.png`);
    if (index === 0) expect(new URL(resource).searchParams.get('v')).toBe('2');
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
  await expect(image).toHaveAttribute('src', /banners\/ad-[1234]\.png(?:\?|$)/);
  const first = await image.getAttribute('src');
  await page.clock.fastForward(29700);
  await page.getByRole('button', { name: '증폭 시도하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  await expect(image).toHaveAttribute('src', first!);
  await page.getByRole('button', { name: '밝은 테마', exact: true }).click();
  await selectSimulator(page, '큐브');
  await expect(image).toHaveAttribute('src', first!);
  await page.clock.fastForward(300);
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중');
  const state = await simulationSnapshot(page);
  await page.clock.fastForward(29699);
  await expect(image).toHaveAttribute('src', first!);
  await page.clock.fastForward(1);
  await expect(image).not.toHaveAttribute('src', first!);
  await expect(image).toHaveAttribute('src', /banners\/ad-[1234]\.png(?:\?|$)/);
  let previous = await image.getAttribute('src');
  for (let index = 0; index < 3; index++) {
    await page.clock.fastForward(60000);
    await expect(image).not.toHaveAttribute('src', previous!);
    await expect(image).toHaveAttribute('src', /banners\/ad-[1234]\.png(?:\?|$)/);
    previous = await image.getAttribute('src');
  }
  expect(await simulationSnapshot(page)).toEqual(state);
});

test('the auction banner opens its isolated external tab by mouse and Enter without changing paid progress', async ({
  page,
  context,
}) => {
  await pauseClock(page);
  await context.route(AUCTION_URL, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>메이플스토리 경매장</title><h1>메이플 경매장</h1>',
    }),
  );
  await openBanner(page, 0.125, '#soulAmplification', true);
  await page.getByRole('button', { name: '증폭 시도하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  const state = await simulationSnapshot(page);
  const url = page.url();
  const banner = page.getByRole('link', {
    name: '메이플스토리 경매장 열기 (외부 링크, 새 탭)',
    exact: true,
  });
  await expect(banner).toHaveAttribute('href', AUCTION_URL);
  await expect(banner).toHaveAttribute('target', '_blank');
  await expect(banner).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(banner.locator('img')).toHaveAttribute('src', /banners\/ad-1\.png\?v=2$/);
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  for (const action of ['click', 'Enter']) {
    if (action === 'Enter') await banner.focus();
    const popupPromise = context.waitForEvent('page');
    if (action === 'click') await banner.click();
    else await page.keyboard.press('Enter');
    const popup = await popupPromise;
    await expect(popup).toHaveURL(AUCTION_URL);
    await expect(popup.getByRole('heading', { name: '메이플 경매장', exact: true })).toBeVisible();
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await popup.evaluate(() => document.referrer)).toBe('');
    expect(dialogs).toEqual([]);
    expect(page.url()).toBe(url);
    expect(await simulationSnapshot(page)).toEqual(state);
    await popup.close();
    expect(context.pages()).toHaveLength(1);
  }
});

test('the event banner warns before leaving and opens an isolated new tab only after confirmation', async ({
  page,
  context,
}) => {
  await pauseClock(page);
  await context.route(EXTERNAL_EVENT_URL, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>공식 메이플스토리 이벤트</title><h1>외부 이벤트</h1>',
    }),
  );
  await openBanner(page, 0.5, '#soulAmplification', true);
  await page.getByRole('button', { name: '증폭 시도하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  const state = await simulationSnapshot(page);
  const banner = page.locator('.fake-ad-banner');
  const url = page.url();
  const cancelledDialog = page.waitForEvent('dialog');
  const cancelClick = banner.click();
  const warning = await cancelledDialog;
  expect(warning.type()).toBe('confirm');
  expect(warning.message()).toContain('외부 링크');
  expect(warning.message()).toContain(EXTERNAL_EVENT_URL);
  await warning.dismiss();
  await cancelClick;
  expect(context.pages()).toHaveLength(1);
  expect(page.url()).toBe(url);
  expect(await simulationSnapshot(page)).toEqual(state);

  for (const action of ['click', 'Enter', 'Space']) {
    if (action !== 'click') await banner.focus();
    const dialogPromise = page.waitForEvent('dialog');
    const popupPromise = context.waitForEvent('page');
    const activation = action === 'click' ? banner.click() : page.keyboard.press(action);
    const dialog = await dialogPromise;
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain('외부 링크');
    expect(dialog.message()).toContain(EXTERNAL_EVENT_URL);
    await dialog.accept();
    await activation;
    const popup = await popupPromise;
    await expect(popup).toHaveURL(EXTERNAL_EVENT_URL);
    await expect(popup.getByRole('heading', { name: '외부 이벤트', exact: true })).toBeVisible();
    expect(await popup.evaluate(() => window.opener)).toBeNull();
    expect(await popup.evaluate(() => document.referrer)).toBe('');
    expect(page.url()).toBe(url);
    expect(await simulationSnapshot(page)).toEqual(state);
    await popup.close();
    expect(context.pages()).toHaveLength(1);
  }
});

test('banners preserve their full image and layout in both themes, on mobile and on image failure', async ({
  page,
}) => {
  const banner = page.locator('.fake-ad-banner');
  const image = banner.locator('img');
  for (const random of [0.125, 0.5]) {
    await openBanner(page, random);
    for (const width of [1440, 360]) {
      await page.setViewportSize({ width, height: 1050 });
      for (const theme of ['dark', 'light']) {
        const current = await page.locator('html').getAttribute('data-theme');
        if (current !== theme)
          await page
            .getByRole('button', { name: theme === 'light' ? '밝은 테마' : '어두운 테마' })
            .click();
        const naturalWidth = random === 0.125 ? 2057 : 1028;
        const naturalHeight = random === 0.125 ? 764 : 382;
        await expect(image).toHaveJSProperty('naturalWidth', naturalWidth);
        await expect(image).toHaveJSProperty('naturalHeight', naturalHeight);
        await expect(image).toHaveCSS('object-fit', 'contain');
        const bounds = (await banner.boundingBox())!;
        const imageBounds = (await image.boundingBox())!;
        expect(bounds.width).toBeLessThanOrEqual(593);
        expect(bounds.height).toBeLessThanOrEqual(221);
        expect(imageBounds.width / imageBounds.height).toBeCloseTo(naturalWidth / naturalHeight, 2);
        expect(imageBounds.x).toBeGreaterThanOrEqual(bounds.x);
        expect(imageBounds.y).toBeGreaterThanOrEqual(bounds.y);
        expect(imageBounds.x + imageBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
        expect(imageBounds.y + imageBounds.height).toBeLessThanOrEqual(
          bounds.y + bounds.height + 1,
        );
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
  }
  const before = await banner.boundingBox();
  await page.route('**/banners/ad-*.png', (route) => route.abort());
  await page.reload();
  await expect(page.locator('.fake-ad-fallback')).toBeVisible();
  expect(await banner.boundingBox()).toEqual(before);
  const url = page.url();
  const dialogPromise = page.waitForEvent('dialog');
  const activation = banner.click();
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('confirm');
  expect(dialog.message()).toContain('외부 링크');
  expect(dialog.message()).toContain(EXTERNAL_EVENT_URL);
  await dialog.dismiss();
  await activation;
  expect(page.url()).toBe(url);
  expect(page.context().pages()).toHaveLength(1);
});
