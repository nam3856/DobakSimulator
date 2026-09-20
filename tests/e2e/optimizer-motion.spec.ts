import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const ability = JSON.parse(
  readFileSync(new URL('../../public/rules/ability.json', import.meta.url), 'utf8'),
);
const wizard = (page: Page) => page.locator('.optimizer-wizard');

async function openManualStart(page: Page) {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: 'https://fixture-api.example/api' } }),
  );
  await page.goto('./#abilityOptimizer');
  await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'character');
  await page.getByRole('button', { name: '직접 입력할게요', exact: true }).click();
  const types = ['passiveSkillLevel', 'bossDamagePercent', 'criticalRatePercent'];
  for (const [index, type] of types.entries()) {
    const option = ability.grades.legendary.options.find(
      (row: { type: string }) => row.type === type,
    );
    await page.getByLabel(`${index + 1}번째 시작 옵션`, { exact: true }).selectOption({
      label: `[레전드리] ${option.values[0].label}`,
    });
  }
}

async function next(page: Page, step: string) {
  await wizard(page).getByRole('button', { name: '다음', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', step);
}

test('step transitions remount with the chosen direction while keeping entered values', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openManualStart(page);
  const originalLines = await page
    .locator('.optimizer-manual select')
    .evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).value));
  const oldStep = await wizard(page).elementHandle();
  await next(page, 'target');
  await expect(wizard(page)).toHaveAttribute('data-direction', 'next');
  expect(await oldStep!.evaluate((element) => element.isConnected)).toBe(false);
  expect(await wizard(page).evaluate((element) => getComputedStyle(element).animationName)).toBe(
    'optimizer-step-in',
  );
  await next(page, 'prices');
  await page.getByLabel('현재 보유 명성치', { exact: true }).fill('123456');
  await page.getByLabel('명예의 훈장 가격', { exact: true }).fill('3456789');
  await page.getByLabel('심연의 서큘레이터 가격', { exact: true }).fill('198765432');

  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'target');
  await expect(wizard(page)).toHaveAttribute('data-direction', 'back');
  expect(
    await wizard(page).evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--optimizer-enter-x').trim(),
    ),
  ).toBe('-12px');
  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'character');
  expect(
    await page
      .locator('.optimizer-manual select')
      .evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).value)),
  ).toEqual(originalLines);
  await next(page, 'target');
  await next(page, 'prices');
  await expect(page.getByLabel('현재 보유 명성치', { exact: true })).toHaveValue('123456');
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toHaveValue('3456789');
  await expect(page.getByLabel('심연의 서큘레이터 가격', { exact: true })).toHaveValue('198765432');
});

test('reduced motion removes entry and press animations without disrupting navigation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openManualStart(page);
  await next(page, 'target');
  expect(
    await wizard(page).evaluate((element) =>
      [element, ...element.querySelectorAll('*')].every((node) => {
        const style = getComputedStyle(node);
        return style.animationName === 'none' && style.transitionDuration === '0s';
      }),
    ),
  ).toBe(true);
  const nextButton = wizard(page).getByRole('button', { name: '다음', exact: true });
  const bounds = (await nextButton.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  expect(await nextButton.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
  await page.mouse.up();
  await expect(wizard(page)).toHaveAttribute('data-step', 'prices');
  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'target');
  await expect(wizard(page)).toHaveAttribute('data-direction', 'back');
});

test('intro keeps one static local character through theme changes and returning from setup', async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/(?:maplestory\/v1|api\/character)(?:[/?]|$)/.test(request.url()))
      apiRequests.push(request.url());
  });
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: 'https://fixture-api.example/api' } }),
  );
  await page.goto('./#abilityOptimizer');
  await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
  await expect(
    page.getByRole('heading', { name: '내 어빌리티, 어떻게 완성할까요?', exact: true }),
  ).toBeVisible();
  await expect(wizard(page).getByRole('button')).toHaveCount(1);
  await expect(
    page.getByRole('list', { name: '어빌리티 최적화 진행 순서' }).getByRole('listitem'),
  ).toHaveText(['현재 어빌리티', '목표 옵션', '보유 재화']);
  const portrait = page.locator('.optimizer-intro-portrait img');
  await expect(portrait).toHaveCount(1);
  const source = (await portrait.getAttribute('src'))!;
  expect(source).toMatch(/character\/optimizer\/(kkangmini|kkangkun|rennae)\/walk-2\.png$/);
  await expect
    .poll(() => portrait.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBe(300);
  expect(await portrait.evaluate((image) => getComputedStyle(image).animationName)).toBe('none');
  await page.getByRole('button', { name: /^(밝은|어두운) 테마$/ }).click();
  await expect(portrait).toHaveAttribute('src', source);
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'character');
  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
  await expect(portrait).toHaveAttribute('src', source);
  expect(apiRequests).toEqual([]);
});

for (const width of [360, 390]) {
  test(`intro title, steps and start button fit the first mobile screen at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/app-config.json', (route) =>
      route.fulfill({ json: { characterApiBaseUrl: 'https://fixture-api.example/api' } }),
    );
    await page.goto('./#abilityOptimizer');
    await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
    const start = wizard(page).getByRole('button', { name: '시작하기', exact: true });
    await expect(start).toBeVisible();
    const bounds = (await start.boundingBox())!;
    expect(bounds.y).toBeGreaterThan(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    expect(
      await wizard(page).evaluate((element) =>
        [element, ...element.querySelectorAll('*')].every(
          (node) => getComputedStyle(node).animationName === 'none',
        ),
      ),
    ).toBe(true);
  });
}
