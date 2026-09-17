import { test, expect, type Page } from '@playwright/test';
import type { StarforceConfig, StarforceState } from '../../src/engine/starforce';
import { deserialize, type StoredSession } from '../../src/ui/storage';

interface SavedStarforce {
  config: StarforceConfig;
  state: StarforceState;
  preset: string;
  itemId: string;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  await page.addInitScript(() => {
    Math.random = () => 0;
    const random = Number(new URL(location.href).searchParams.get('draw') ?? '0');
    crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint32Array).fill(Math.floor(random * 4294967296));
      return array;
    };
  });
  const time = new Date('2026-09-17T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
});

async function saved(page: Page): Promise<SavedStarforce> {
  return deserialize<SavedStarforce>(
    await page.evaluate(() => localStorage.getItem('isekai:starforce:v1:깽미니')!),
  );
}

async function mainSaved(page: Page): Promise<StoredSession> {
  return deserialize<StoredSession>(
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem('isekai-jikjak:session:v1')!;
    }),
  );
}

async function ready(page: Page) {
  await expect(
    page.getByRole('heading', { name: '스타포스 시뮬레이터', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.sf-stats .expected-stat')).not.toContainText('계산 중');
  await expect(page.locator('.sf-error')).toHaveCount(0);
}

async function bootManual(page: Page, startStars = 0, targetStars = 2, draw = 0) {
  await page.goto(`./?draw=${draw}#starforce`);
  await ready(page);
  await page.getByRole('combobox', { name: '스타포스 장비', exact: true }).selectOption('manual');
  await page
    .getByRole('combobox', { name: '시작 스타포스', exact: true })
    .selectOption(String(startStars));
  await page
    .getByRole('combobox', { name: '목표 스타포스', exact: true })
    .selectOption(String(targetStars));
  await ready(page);
}

async function expectAttempts(page: Page, count: bigint) {
  await expect.poll(async () => (await saved(page)).state.attempts).toBe(count);
  await expect(page.locator('.sf-stats .stat-card').first().locator('strong')).toHaveText(
    `${count}회`,
  );
}

test('the sixth tab and starforce banner support mouse and keyboard without changing the main challenge', async ({
  page,
}) => {
  await page.goto('./#soulAmplification');
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toBeVisible();
  await page.clock.fastForward(300);
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중');
  await page.getByRole('button', { name: '증폭 시도하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  const original = await mainSaved(page);
  // Navigating away pauses a paid manual result without changing its progress.
  original.state.status = 'paused';
  const navigation = page.getByRole('navigation');
  await expect(navigation.getByRole('button')).toHaveCount(6);
  await expect(navigation.getByRole('button').nth(5)).toHaveText('스타포스');
  const banner = page.getByRole('button', { name: '스타포스 시뮬레이터로 이동', exact: true });
  await expect(banner.locator('img')).toHaveAttribute('src', /ad-2\.png/);

  for (const action of ['click', 'Enter', 'Space']) {
    if (action === 'click') await banner.click();
    else {
      await banner.focus();
      await page.keyboard.press(action);
    }
    await expect(page).toHaveURL(/#starforce$/);
    await ready(page);
    await expect(page.locator('.fake-ad-toast')).toHaveCount(0);
    expect((await mainSaved(page)).config).toEqual(original.config);
    expect((await mainSaved(page)).state).toEqual(original.state);
    await navigation.getByRole('button', { name: '소울 증폭', exact: true }).click();
    await page.clock.fastForward(300);
    await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
    expect((await mainSaved(page)).state).toEqual(original.state);
  }
  await navigation.getByRole('button', { name: '스타포스', exact: true }).click();
  await expect(page).toHaveURL(/#starforce$/);
  await ready(page);
  expect(page.context().pages()).toHaveLength(1);
});

test('automatic enhancement is paced, resumes paid progress and restarts from the original stage at zero cost', async ({
  page,
}) => {
  await bootManual(page);
  const initial = await saved(page);
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
  await expect(page.getByRole('combobox', { name: '시작 스타포스', exact: true })).toBeDisabled();
  await page.clock.fastForward(899);
  await expectAttempts(page, 0n);
  await page.clock.fastForward(1);
  await expectAttempts(page, 1n);
  await expect(page.locator('.sf-stars')).toHaveAttribute('aria-label', '현재 1성 / 목표 2성');
  const paid = await saved(page);
  expect(paid.state.spentMeso).toBeGreaterThan(0n);
  await page.getByRole('button', { name: '중지', exact: true }).click();
  await page.clock.fastForward(5000);
  expect((await saved(page)).state).toEqual(paid.state);
  await expect(page.getByRole('button', { name: '자동 강화', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.clock.fastForward(900);
  await expectAttempts(page, 2n);
  await expect(page.locator('.sf-outcome')).toContainText('목표 강화 달성!');
  await page.clock.fastForward(1100);
  await expect(page.getByRole('button', { name: '다시 자동 강화', exact: true })).toBeEnabled();
  const completed = await saved(page);
  expect(completed.config).toEqual(initial.config);
  expect(completed.state.status).toBe('success');

  // A completed saved run offers the same one-click retry after a fresh page load.
  await page.reload();
  await ready(page);
  expect((await saved(page)).state).toEqual(completed.state);
  await page.getByRole('button', { name: '다시 자동 강화', exact: true }).click();
  await expectAttempts(page, 0n);
  expect((await saved(page)).state.stars).toBe(initial.config.startStars);
  expect((await saved(page)).state.spentMeso).toBe(0n);
  await page.clock.fastForward(900);
  await expectAttempts(page, 1n);
  await page.clock.fastForward(1099);
  await expectAttempts(page, 1n);
  await page.clock.fastForward(1);
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
  await page.clock.fastForward(899);
  await expectAttempts(page, 1n);
  await page.clock.fastForward(1);
  await expectAttempts(page, 2n);
  await page.clock.fastForward(1100);
  const restarted = await saved(page);
  expect(restarted.config).toEqual(initial.config);
  expect(restarted.state).toEqual(completed.state);
});

test('destruction is saved before restoration and original-stage restoration charges four copies exactly once', async ({
  page,
}) => {
  await bootManual(page, 22, 23, 0.999999);
  await page
    .getByRole('combobox', { name: '파괴 후 복구 방식', exact: true })
    .selectOption('original');
  await page.getByLabel('복구용 동일 장비 가격 (메소)', { exact: true }).fill('12345');
  await ready(page);
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(900);
  await expectAttempts(page, 1n);
  await expect(page.locator('.sf-outcome')).toContainText('장비 파괴 · 흔적 복구 대기');
  const destroyed = await saved(page);
  expect(destroyed.state.status).toBe('destroyed');
  expect(destroyed.state.destructions).toBe(1n);
  expect(destroyed.state.replacementCopies).toBe(0n);
  expect(destroyed.state.restorationMeso).toBe(0n);
  expect(destroyed.state.spentMeso).toBe(destroyed.state.enhancementMeso);
  expect(destroyed.state.pendingRestoration).toMatchObject({
    toStars: 22,
    equipmentCount: 4n,
    mesoCost: 24200000000n,
    replacementCost: 49380n,
  });
  await page.reload();
  await ready(page);
  expect((await saved(page)).state).toEqual(destroyed.state);
  await expect(page.locator('.sf-quote')).toContainText('동일 장비 4개');
  await page.getByRole('button', { name: '장비 복구하기', exact: true }).click();
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-restoring/);
  await page.clock.fastForward(899);
  expect((await saved(page)).state).toEqual(destroyed.state);
  await page.clock.fastForward(1);
  await expect(page.locator('.sf-outcome')).toContainText('22성 복구 완료');
  const restored = await saved(page);
  expect(restored.state.stars).toBe(22);
  expect(restored.state.status).toBe('ready');
  expect(restored.state.attempts).toBe(1n);
  expect(restored.state.restorations).toBe(1n);
  expect(restored.state.replacementCopies).toBe(4n);
  expect(restored.state.spentMeso).toBe(
    destroyed.state.spentMeso + destroyed.state.pendingRestoration!.totalCost,
  );
  expect(restored.state.history[0].restored).toBe(true);
  expect(restored.state.pendingRestoration).toBeUndefined();
  await page.clock.fastForward(1100);
  await expect(page.getByRole('button', { name: '강화하기', exact: true })).toBeEnabled();
  await expect(page.locator('.sf-stage')).not.toHaveClass(/outcome-destroy/);
  await expect(page.locator('.sf-outcome')).toContainText('22성 복구 완료');
  await page.reload();
  await ready(page);
  expect((await saved(page)).state).toEqual(restored.state);
  await expect(page.locator('.sf-outcome')).toContainText('22성 복구 완료');
  await page.getByText('강화 기록 · 최근 1회', { exact: true }).click();
  await expect(page.locator('.sf-history')).toContainText('장비 파괴 · 22성 복구');
});

test('stopping a charging attempt and leaving the tab cancel timers without hidden costs', async ({
  page,
}) => {
  await bootManual(page);
  const initial = await saved(page);
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(400);
  await page.getByRole('button', { name: '중지', exact: true }).click();
  await page.clock.fastForward(5000);
  expect((await saved(page)).state).toEqual(initial.state);
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.clock.fastForward(900);
  await expectAttempts(page, 1n);
  const paid = await saved(page);
  const navigation = page.getByRole('navigation');
  await navigation.getByRole('button', { name: '큐브', exact: true }).click();
  await page.clock.fastForward(10000);
  expect((await saved(page)).state).toEqual(paid.state);
  await navigation.getByRole('button', { name: '스타포스', exact: true }).click();
  await ready(page);
  expect((await saved(page)).state).toEqual(paid.state);
  await expect(page.getByRole('button', { name: '자동 강화', exact: true })).toBeEnabled();
  await page.clock.fastForward(5000);
  expect((await saved(page)).state).toEqual(paid.state);
});

test('the 360px layout stays within both themes and reduced motion preserves outcomes and controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bootManual(page, 0, 1);
  for (const theme of ['dark', 'light']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page
        .getByRole('button', { name: theme === 'light' ? '밝은 테마' : '어두운 테마', exact: true })
        .click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    const roll = (await page.locator('.sf-actions .roll-button').boundingBox())!;
    const auto = (await page.locator('.sf-actions .auto-button').boundingBox())!;
    expect(roll.width).toBeCloseTo(auto.width, 0);
    expect(roll.x).toBeGreaterThanOrEqual(0);
    expect(auto.x + auto.width).toBeLessThanOrEqual(360);
  }
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
  expect(
    await page.locator('.sf-item').evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('none');
  await page.clock.fastForward(900);
  await expect(page.locator('.sf-outcome')).toContainText('목표 강화 달성!');
  await expectAttempts(page, 1n);
  await page.clock.fastForward(1100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.getByRole('combobox', { name: '시작 스타포스', exact: true }).selectOption('1');
  await ready(page);
  await expectAttempts(page, 0n);
  await expect(page.locator('.sf-outcome')).toContainText('이미 목표 단계입니다');
  await expect(page.getByRole('button', { name: '다시 자동 강화', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '강화하기', exact: true })).toBeDisabled();
});
