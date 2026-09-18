import { test, expect, type Page } from '@playwright/test';
import type { StarforceConfig, StarforceState } from '../../src/engine/starforce';
import type { StarforceOptimization } from '../../src/engine/starforce-optimizer';
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
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event) => {
          if (event.data?.result?.steps && event.data.result.config)
            (window as unknown as { starforceOptimization: unknown }).starforceOptimization =
              event.data.result;
        });
      }
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

async function optimize(page: Page): Promise<StarforceOptimization> {
  await page.getByRole('button', { name: '강화 루트 최적화', exact: true }).click();
  await expect(page.locator('.sf-route-result')).toContainText('최적 루트 적용 중');
  await ready(page);
  return page.evaluate(
    () =>
      (window as unknown as { starforceOptimization: StarforceOptimization }).starforceOptimization,
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
  await page.clock.fastForward(149);
  await expectAttempts(page, 0n);
  await page.clock.fastForward(1);
  await expectAttempts(page, 1n);
  await expect(page.locator('.sf-stars')).toHaveAttribute('aria-label', '현재 1성 / 목표 2성');
  const paid = await saved(page);
  expect(paid.state.spentMeso).toBeGreaterThan(0n);
  await page.getByRole('button', { name: '중단', exact: true }).click();
  await page.clock.fastForward(5000);
  expect((await saved(page)).state).toEqual(paid.state);
  await expect(page.getByRole('button', { name: '자동 강화', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.clock.fastForward(600);
  await expectAttempts(page, 2n);
  await expect(page.locator('.sf-outcome')).toContainText('목표 강화 달성!');
  await page.clock.fastForward(733);
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
  await page.clock.fastForward(150);
  await expectAttempts(page, 1n);
  await page.clock.fastForward(182);
  await expectAttempts(page, 1n);
  await page.clock.fastForward(1);
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
  await page.clock.fastForward(599);
  await expectAttempts(page, 1n);
  await page.clock.fastForward(1);
  await expectAttempts(page, 2n);
  await page.clock.fastForward(733);
  const restarted = await saved(page);
  expect(restarted.config).toEqual(initial.config);
  expect(restarted.state).toEqual(completed.state);
});

test('early, high-star and final-stage pacing use distinct boundaries without exposing speed controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 1000 });
  await bootManual(page, 12, 15);
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  const actions = page.locator('.sf-actions');
  await expect(actions.getByRole('button')).toHaveCount(2);
  await expect(actions.getByRole('button', { name: '연출 스킵', exact: true })).toBeEnabled();
  await expect(actions.getByRole('button', { name: '중단', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /2배 빠르게|기본 속도로/ })).toHaveCount(0);
  await expect(page.locator('.sf-outcome')).not.toContainText(/초|속도|배속/);
  for (const theme of ['dark', 'light']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page
        .getByRole('button', { name: theme === 'light' ? '밝은 테마' : '어두운 테마', exact: true })
        .click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    for (const button of await actions.getByRole('button').all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
    }
  }

  // 12→13 uses the early-stage 150/183ms cadence.
  await page.clock.fastForward(149);
  await expectAttempts(page, 0n);
  await page.clock.fastForward(1);
  await expectAttempts(page, 1n);
  await expect(page.locator('.sf-stars')).toHaveAttribute('aria-label', '현재 13성 / 목표 15성');
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-result/);

  await page.clock.fastForward(182);
  await expectAttempts(page, 1n);
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-result/);
  await page.clock.fastForward(1);
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
  // At 13 stars the next attempt switches to the 225/275ms cadence.
  await page.clock.fastForward(224);
  await expectAttempts(page, 1n);
  await page.clock.fastForward(1);
  await expectAttempts(page, 2n);
  await expect(page.locator('.sf-stars')).toHaveAttribute('aria-label', '현재 14성 / 목표 15성');

  await page.clock.fastForward(274);
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-result/);
  await expectAttempts(page, 2n);
  await page.clock.fastForward(1);
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
  // The final 14→15 attempt takes priority over the high-star cadence: 600/733ms.
  await page.clock.fastForward(599);
  await expectAttempts(page, 2n);
  await page.clock.fastForward(1);
  await expectAttempts(page, 3n);
  const completed = await saved(page);
  expect(completed.state.history.map((row) => row.fromStars)).toEqual([12, 13, 14]);
  expect(completed.state.status).toBe('success');
  await page.clock.fastForward(732);
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-result/);
  await page.clock.fastForward(1);
  await expect(page.getByRole('button', { name: '다시 자동 강화', exact: true })).toBeEnabled();
  await page.clock.fastForward(10000);
  expect((await saved(page)).state).toEqual(completed.state);
});

for (const finalAttempt of [false, true]) {
  test(`safeguard protection ${finalAttempt ? 'preserves final-stage priority' : 'extends only its result phase and restores normal pacing'}`, async ({
    page,
  }) => {
    await bootManual(page, 15, finalAttempt ? 16 : 17);
    await page.getByRole('checkbox', { name: /^파괴 방지/ }).check();
    await ready(page);
    await page.evaluate(() => {
      const draws = [0.999999, 0.5];
      crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
        (array as unknown as Uint32Array).fill(Math.floor((draws.shift() ?? 0.5) * 4294967296));
        return array;
      };
    });
    const charge = finalAttempt ? 600 : 225;
    const protectedResult = finalAttempt ? 733 : 550;
    const ordinaryResult = finalAttempt ? 733 : 275;
    await page.getByRole('button', { name: '자동 강화', exact: true }).click();
    await page.clock.fastForward(charge - 1);
    await expectAttempts(page, 0n);
    await page.clock.fastForward(1);
    await expectAttempts(page, 1n);
    const protectedState = (await saved(page)).state;
    expect(protectedState.history[0].safeguardPrevented).toBe(true);
    expect(protectedState.stars).toBe(15);
    await expect(page.locator('.sf-stage')).toHaveClass(/phase-result.*outcome-protected/);
    await expect(page.locator('.sf-outcome')).toContainText('파괴 방지 성공!');
    await expect(page.locator('.sf-protection')).toBeVisible();
    await expect(page.locator('.sf-stage')).toHaveCSS(
      '--sf-result-duration',
      `${protectedResult}ms`,
    );

    // Protection changes only this result's hold. A final-stage attempt retains its longer hold.
    await page.clock.fastForward(protectedResult - 1);
    await expect(page.locator('.sf-stage')).toHaveClass(/phase-result/);
    await expectAttempts(page, 1n);
    await page.clock.fastForward(1);
    await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
    await page.clock.fastForward(charge - 1);
    await expectAttempts(page, 1n);
    await page.clock.fastForward(1);
    await expectAttempts(page, 2n);
    const ordinaryState = (await saved(page)).state;
    expect(ordinaryState.history[1].safeguardPrevented).not.toBe(true);
    expect(ordinaryState.history[1].outcome).toBe('stay');
    expect(ordinaryState.spentMeso).toBe(protectedState.spentMeso * 2n);
    await expect(page.locator('.sf-stage')).not.toHaveClass(/outcome-protected/);
    await expect(page.locator('.sf-outcome')).toContainText('강화 실패 · 단계 유지');
    await expect(page.locator('.sf-stage')).toHaveCSS(
      '--sf-result-duration',
      `${ordinaryResult}ms`,
    );
    await page.clock.fastForward(ordinaryResult - 1);
    await expect(page.locator('.sf-stage')).toHaveClass(/phase-result/);
    await page.clock.fastForward(1);
    await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
    await expectAttempts(page, 2n);
    await page.getByRole('button', { name: '중단', exact: true }).click();
    await page.clock.fastForward(5000);
    expect((await saved(page)).state).toEqual(ordinaryState);
  });
}

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
  await page.clock.fastForward(600);
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
  await page.clock.fastForward(224);
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
  await page.clock.fastForward(275);
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

test('shining uses discounted normal attempts without granting a guaranteed 15-to-16 success', async ({
  page,
}) => {
  await bootManual(page, 15, 16, 0.98);
  await expect(page.locator('.sf-quote')).toContainText('성공 31.50%');
  await expect(page.locator('.sf-quote')).toContainText('파괴 2.05%');
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(600);
  const normal = await saved(page);
  expect(normal.state.status).toBe('destroyed');
  expect(normal.state.destructions).toBe(1n);
  await page.clock.fastForward(733);

  await page.getByRole('checkbox', { name: /샤이닝 스타포스/ }).check();
  await ready(page);
  await expectAttempts(page, 0n);
  expect((await saved(page)).config.event).toBe('shiningNoGuarantee');
  await expect(page.locator('.sf-quote')).toContainText('성공 31.50%');
  await expect(page.locator('.sf-quote')).toContainText('파괴 1.44%');
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(600);
  const shining = await saved(page);
  expect(shining.state.status).toBe('ready');
  expect(shining.state.stars).toBe(15);
  expect(shining.state.history[0].outcome).toBe('stay');
  expect(shining.state.destructions).toBe(0n);
  expect(shining.state.enhancementMeso).toBe(
    ((normal.state.enhancementMeso * 7n + 500n) / 1000n) * 100n,
  );
  await page.reload();
  await ready(page);
  await expect(page.getByRole('checkbox', { name: /샤이닝 스타포스/ })).toBeChecked();
  expect((await saved(page)).state).toEqual(shining.state);
});

test('optimized routes apply real safeguard costs, survive retry and reload, and clear after settings change', async ({
  page,
}) => {
  await bootManual(page, 16, 18, 0.999999);
  await page.getByLabel('복구용 동일 장비 가격 (메소)', { exact: true }).fill('1000000000000');
  await ready(page);
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(225);
  const normal = await saved(page);
  expect(normal.state.status).toBe('destroyed');
  await page.clock.fastForward(275);
  await page.getByRole('checkbox', { name: /샤이닝 스타포스/ }).check();
  await ready(page);
  const optimized = await optimize(page);
  expect(optimized.status).toBe('ready');
  expect(optimized.savedMeso).toBeGreaterThan(0);
  expect(optimized.benchmark.expectedMeso).toBeLessThan(optimized.baselineBenchmark!.expectedMeso);
  const applied = await saved(page);
  expect(applied.config.policy).toEqual(optimized.steps);
  expect(applied.config.policy?.[16].safeguard).toBe(true);
  expect(applied.state.attempts).toBe(0n);
  expect(applied.state.spentMeso).toBe(0n);
  await expect(page.locator('.sf-quote')).toContainText('파괴 0.00%');
  await page.getByText('단계별 강화 루트 보기', { exact: true }).click();
  await expect(page.locator('.sf-route-details tbody tr')).toHaveCount(2);
  await expect(
    page.locator('.sf-route-details tbody tr').filter({ hasText: '16→17성' }),
  ).toContainText('사용');
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(225);
  const paid = await saved(page);
  expect(paid.state.attempts).toBe(1n);
  expect(paid.state.stars).toBe(16);
  expect(paid.state.destructions).toBe(0n);
  expect(paid.state.history[0].safeguardPrevented).toBe(true);
  await expect(page.locator('.sf-stage')).toHaveClass(/outcome-protected/);
  await expect(page.locator('.sf-outcome')).toContainText('파괴 방지 성공!');
  expect(paid.state.enhancementMeso).toBe(
    ((normal.state.enhancementMeso * 27n + 500n) / 1000n) * 100n,
  );
  await page.clock.fastForward(550);
  await page.reload();
  await ready(page);
  expect((await saved(page)).config.policy).toEqual(optimized.steps);
  expect((await saved(page)).state).toEqual(paid.state);
  await expect(page.locator('.sf-route-result')).toContainText('최적 루트 적용 중');

  // Canceling a pending optimization preserves the existing paid challenge and route.
  const workerRoute = '**/assets/starforce.worker-*.js';
  let pendingWorkers = 0;
  await page.route(workerRoute, (route) => {
    pendingWorkers++;
    return route.fulfill({
      contentType: 'application/javascript',
      body: 'self.onmessage = () => {};',
    });
  });
  await page.getByRole('button', { name: '강화 루트 최적화', exact: true }).click();
  await expect.poll(() => pendingWorkers).toBe(1);
  await page.getByRole('button', { name: '최적화 중단', exact: true }).click();
  await page.clock.fastForward(5000);
  expect((await saved(page)).state).toEqual(paid.state);
  expect((await saved(page)).config.policy).toEqual(optimized.steps);
  await page.unroute(workerRoute);
  await page.getByRole('button', { name: '처음부터 다시', exact: true }).click();
  await expectAttempts(page, 0n);
  expect((await saved(page)).config.policy).toEqual(optimized.steps);
  expect((await saved(page)).state.spentMeso).toBe(0n);

  await page.getByLabel('복구용 동일 장비 가격 (메소)', { exact: true }).fill('12345');
  await ready(page);
  expect((await saved(page)).config.policy).toBeUndefined();
  await expect(page.locator('.sf-route-result')).toHaveCount(0);
  await optimize(page);
  await page.getByRole('button', { name: '수동 설정으로 돌아가기', exact: true }).click();
  await ready(page);
  expect((await saved(page)).config.policy).toBeUndefined();
  await expect(page.locator('.sf-route-result')).toHaveCount(0);
});

test('stopping a charging attempt and leaving the tab cancel timers without hidden costs', async ({
  page,
}) => {
  await bootManual(page);
  const initial = await saved(page);
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(100);
  await page.getByRole('button', { name: '중단', exact: true }).click();
  await page.clock.fastForward(5000);
  expect((await saved(page)).state).toEqual(initial.state);
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.clock.fastForward(150);
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
  await page.clock.fastForward(599);
  await expectAttempts(page, 0n);
  await page.clock.fastForward(1);
  await expect(page.locator('.sf-outcome')).toContainText('목표 강화 달성!');
  await expectAttempts(page, 1n);
  await page.clock.fastForward(733);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.getByRole('combobox', { name: '시작 스타포스', exact: true }).selectOption('1');
  await ready(page);
  await expectAttempts(page, 0n);
  await expect(page.locator('.sf-outcome')).toContainText('이미 목표 단계입니다');
  await expect(page.getByRole('button', { name: '다시 자동 강화', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '강화하기', exact: true })).toBeDisabled();
});
