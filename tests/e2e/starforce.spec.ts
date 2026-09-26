import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { selectSimulator } from './helpers/navigation';
import {
  createStarforceState,
  quoteStarforce,
  type StarforceConfig,
  type StarforceRules,
} from '../../src/engine/starforce';
import type { StarforceOptimization } from '../../src/engine/starforce-optimizer';
import { deserialize, serialize, type StoredSession } from '../../src/ui/storage';
import { formatAmount } from '../../src/ui/format';
const rules: StarforceRules = JSON.parse(
  readFileSync(new URL('../../public/rules/starforce.json', import.meta.url), 'utf8'),
);

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  await page.addInitScript(() => {
    // The second equal quarter selects the Star Force banner; enhancement draws use crypto below.
    Math.random = () => 0.375;
    const random = Number(new URL(location.href).searchParams.get('draw') ?? '0');
    crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint32Array).fill(Math.floor(random * 4294967296));
      return array;
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      readonly isStarforce: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.isStarforce = String(url).includes('starforce.worker');
        this.addEventListener('message', (event) => {
          if (event.data?.result?.steps && event.data.result.config)
            (window as unknown as { starforceOptimization: unknown }).starforceOptimization =
              event.data.result;
        });
      }
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const request = message as { type?: string; config?: StarforceConfig };
        if (this.isStarforce && request.type === 'benchmark')
          (window as unknown as { starforceConfig: unknown }).starforceConfig = structuredClone(
            request.config,
          );
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
    const setItem = Storage.prototype.setItem;
    (window as unknown as { starforceStorageWrites: string[] }).starforceStorageWrites = [];
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key.startsWith('isekai:starforce:'))
        (window as unknown as { starforceStorageWrites: string[] }).starforceStorageWrites.push(
          key,
        );
      return setItem.call(this, key, value);
    };
  });
  const time = new Date('2026-09-17T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
});

// Read progress from the rendered UI. Configuration is observed at the existing worker boundary.
async function current(page: Page) {
  return page.evaluate(() => {
    const text = (selector: string) => document.querySelector(selector)!.textContent!.trim();
    const config = (window as unknown as { starforceConfig: StarforceConfig }).starforceConfig;
    const stars = Number(
      document
        .querySelector('.sf-stars')!
        .getAttribute('aria-label')!
        .match(/현재 (\d+)성/)![1],
    );
    const counts = text('.sf-stats .stat-card:first-child > div').match(
      /파괴 ([\d,]+)회 · 복구 ([\d,]+)회/,
    )!;
    const amount = (selector: string) => text(selector).replace(/메소$/, '').trim();
    return {
      config,
      preset: (document.querySelector('.sf-settings select') as HTMLSelectElement).value,
      itemId: (document.querySelectorAll('.sf-settings select')[1] as HTMLSelectElement).value,
      state: {
        stars,
        status: text('.sf-stage-caption > strong').startsWith('파괴')
          ? 'destroyed'
          : stars >= config.targetStars
            ? 'success'
            : 'ready',
        attempts: BigInt(text('.sf-stats .stat-card:first-child > strong').replace(/[,회]/g, '')),
        destructions: BigInt(counts[1].replaceAll(',', '')),
        restorations: BigInt(counts[2].replaceAll(',', '')),
        replacementCopies: BigInt(
          text('.sf-stats .spent-stat > div')
            .match(/장비 ([\d,]+)개/)![1]
            .replaceAll(',', ''),
        ),
        spentMeso: amount('.sf-stats .spent-stat > strong'),
        enhancementMeso: amount('.resource-ledger > span:nth-child(1) > b'),
        restorationMeso: amount('.resource-ledger > span:nth-child(2) > b'),
        replacementMeso: amount('.resource-ledger > span:nth-child(3) > b'),
        history: [...document.querySelectorAll('.sf-history > div')].reverse().map((row) => ({
          fromStars: Number(row.querySelector('span')!.textContent!.match(/· (\d+)성/)![1]),
          outcome: row.querySelector('b')!.className.replace('sf-history-', ''),
          safeguardPrevented: row.querySelector('b')!.textContent!.includes('파괴 방지'),
          restored: row.querySelector('b')!.textContent!.includes('성 복구'),
        })),
      },
    };
  });
}

async function expectNoStarforceSave(page: Page) {
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('isekai:starforce:')),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => (window as unknown as { starforceStorageWrites: string[] }).starforceStorageWrites,
    ),
  ).toEqual([]);
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toHaveCount(0);
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

test('the equipment group and starforce banner support mouse and keyboard without changing the main challenge', async ({
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
  await expect(
    navigation.getByRole('group', { name: '시뮬레이터 분류', exact: true }).getByRole('button'),
  ).toHaveText(['장비 강화', '어빌리티', '소울']);
  await navigation.getByRole('button', { name: '장비 강화 분류', exact: true }).click();
  await expect(
    navigation
      .getByRole('group', { name: '장비 강화 시뮬레이터', exact: true })
      .getByRole('button'),
  ).toHaveText(['큐브', '추가옵션', '스타포스']);
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
    await selectSimulator(page, '소울 증폭');
    await page.clock.fastForward(300);
    await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
    expect((await mainSaved(page)).state).toEqual(original.state);
  }
  await selectSimulator(page, '스타포스');
  await expect(page).toHaveURL(/#starforce$/);
  await ready(page);
  expect(page.context().pages()).toHaveLength(1);
});

test('automatic enhancement is paced, resumes paid progress and restarts from the original stage at zero cost', async ({
  page,
}) => {
  await bootManual(page);
  const initial = await current(page);
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
  await expect(page.getByRole('combobox', { name: '시작 스타포스', exact: true })).toBeDisabled();
  await page.clock.fastForward(149);
  await expectAttempts(page, 0n);
  await page.clock.fastForward(1);
  await expectAttempts(page, 1n);
  await expect(page.locator('.sf-stars')).toHaveAttribute('aria-label', '현재 1성 / 목표 2성');
  const paid = await current(page);
  expect(paid.state.spentMeso).not.toBe('0');
  await page.getByRole('button', { name: '중단', exact: true }).click();
  await page.clock.fastForward(5000);
  expect((await current(page)).state).toEqual(paid.state);
  await expect(page.getByRole('button', { name: '자동 강화', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.clock.fastForward(600);
  await expectAttempts(page, 2n);
  await expect(page.locator('.sf-outcome')).toContainText('목표 강화 달성!');
  await page.clock.fastForward(733);
  await expect(page.getByRole('button', { name: '다시 자동 강화', exact: true })).toBeEnabled();
  const completed = await current(page);
  expect(completed.config).toEqual(initial.config);
  expect(completed.state.status).toBe('success');

  // A completed run can still be retried while this screen remains open.
  await page.getByRole('button', { name: '다시 자동 강화', exact: true }).click();
  await expectAttempts(page, 0n);
  expect((await current(page)).state.stars).toBe(initial.config.startStars);
  expect((await current(page)).state.spentMeso).toBe('0');
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
  const restarted = await current(page);
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
  const completed = await current(page);
  expect(completed.state.history.map((row) => row.fromStars)).toEqual([12, 13, 14]);
  expect(completed.state.status).toBe('success');
  await page.clock.fastForward(732);
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-result/);
  await page.clock.fastForward(1);
  await expect(page.getByRole('button', { name: '다시 자동 강화', exact: true })).toBeEnabled();
  await page.clock.fastForward(10000);
  expect((await current(page)).state).toEqual(completed.state);
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
    const protectedState = (await current(page)).state;
    const protectedCost = quoteStarforce(rules, (await current(page)).config, { stars: 15 }).cost;
    expect(protectedState.spentMeso).toBe(formatAmount(protectedCost));
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
    const ordinaryState = (await current(page)).state;
    expect(ordinaryState.history[1].safeguardPrevented).not.toBe(true);
    expect(ordinaryState.history[1].outcome).toBe('stay');
    expect(ordinaryState.spentMeso).toBe(formatAmount(protectedCost * 2n));
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
    expect((await current(page)).state).toEqual(ordinaryState);
  });
}

test('destruction waits for restoration and original-stage restoration charges four copies exactly once', async ({
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
  const destroyed = await current(page);
  expect(destroyed.state.status).toBe('destroyed');
  expect(destroyed.state.destructions).toBe(1n);
  expect(destroyed.state.replacementCopies).toBe(0n);
  expect(destroyed.state.restorationMeso).toBe('0');
  expect(destroyed.state.spentMeso).toBe(destroyed.state.enhancementMeso);
  const destroyedQuote = quoteStarforce(rules, destroyed.config, { stars: 22 });
  expect(destroyed.state.enhancementMeso).toBe(formatAmount(destroyedQuote.cost));
  expect(destroyedQuote.restoration).toMatchObject({
    toStars: 22,
    equipmentCount: 4n,
    mesoCost: 24200000000n,
    replacementCost: 49380n,
  });
  await expect(page.locator('.sf-quote')).toContainText('복구 단계 22성');
  await expect(page.locator('.sf-quote')).toContainText('동일 장비 4개');
  await expect(page.locator('.sf-quote')).toContainText(
    `복구 총비용 ${formatAmount(24200000000n + 49380n)} 메소`,
  );
  await page.clock.fastForward(733);
  await page.getByRole('button', { name: '장비 복구하기', exact: true }).click();
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-restoring/);
  await page.clock.fastForward(224);
  expect((await current(page)).state).toEqual(destroyed.state);
  await page.clock.fastForward(1);
  await expect(page.locator('.sf-outcome')).toContainText('22성 복구 완료');
  const restored = await current(page);
  expect(restored.state.stars).toBe(22);
  expect(restored.state.status).toBe('ready');
  expect(restored.state.attempts).toBe(1n);
  expect(restored.state.restorations).toBe(1n);
  expect(restored.state.replacementCopies).toBe(4n);
  expect(restored.state.spentMeso).toBe(formatAmount(destroyedQuote.cost + 24200000000n + 49380n));
  expect(restored.state.history[0].restored).toBe(true);
  expect(restored.state.restorationMeso).toBe(formatAmount(24200000000n));
  expect(restored.state.replacementMeso).toBe(formatAmount(49380n));
  await expect(page.locator('.sf-quote')).not.toContainText('복구 총비용');
  await page.clock.fastForward(275);
  await expect(page.getByRole('button', { name: '강화하기', exact: true })).toBeEnabled();
  await expect(page.locator('.sf-stage')).not.toHaveClass(/outcome-destroy/);
  await expect(page.locator('.sf-outcome')).toContainText('22성 복구 완료');
  await page.clock.fastForward(5000);
  expect((await current(page)).state).toEqual(restored.state);
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
  const normal = await current(page);
  const normalCost = quoteStarforce(rules, normal.config, { stars: normal.config.startStars }).cost;
  expect(normal.state.enhancementMeso).toBe(formatAmount(normalCost));
  expect(normal.state.status).toBe('destroyed');
  expect(normal.state.destructions).toBe(1n);
  await page.clock.fastForward(733);

  await page.getByRole('checkbox', { name: /샤이닝 스타포스/ }).check();
  await ready(page);
  await expectAttempts(page, 0n);
  expect((await current(page)).config.event).toBe('shiningNoGuarantee');
  await expect(page.locator('.sf-quote')).toContainText('성공 31.50%');
  await expect(page.locator('.sf-quote')).toContainText('파괴 1.44%');
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(600);
  const shining = await current(page);
  expect(shining.state.status).toBe('ready');
  expect(shining.state.stars).toBe(15);
  expect(shining.state.history[0].outcome).toBe('stay');
  expect(shining.state.destructions).toBe(0n);
  expect(shining.state.enhancementMeso).toBe(
    formatAmount(((normalCost * 7n + 500n) / 1000n) * 100n),
  );
  await page.clock.fastForward(733);
  await expect(page.getByRole('checkbox', { name: /샤이닝 스타포스/ })).toBeChecked();
  expect((await current(page)).state).toEqual(shining.state);
  await expectNoStarforceSave(page);
});

test('optimized routes apply real safeguard costs, survive retry, and clear after settings change', async ({
  page,
}) => {
  await bootManual(page, 16, 18, 0.999999);
  await page.getByLabel('복구용 동일 장비 가격 (메소)', { exact: true }).fill('1000000000000');
  await ready(page);
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(225);
  const normal = await current(page);
  const normalCost = quoteStarforce(rules, normal.config, { stars: normal.config.startStars }).cost;
  expect(normal.state.enhancementMeso).toBe(formatAmount(normalCost));
  expect(normal.state.status).toBe('destroyed');
  await page.clock.fastForward(275);
  await page.getByRole('checkbox', { name: /샤이닝 스타포스/ }).check();
  await ready(page);
  const optimized = await optimize(page);
  expect(optimized.status).toBe('ready');
  expect(optimized.savedMeso).toBeGreaterThan(0);
  expect(optimized.benchmark.expectedMeso).toBeLessThan(optimized.baselineBenchmark!.expectedMeso);
  const applied = await current(page);
  expect(applied.config.policy).toEqual(optimized.steps);
  expect(applied.config.policy?.[16].safeguard).toBe(true);
  expect(applied.state.attempts).toBe(0n);
  expect(applied.state.spentMeso).toBe('0');
  await expect(page.locator('.sf-quote')).toContainText('파괴 0.00%');
  await page.getByText('단계별 강화 루트 보기', { exact: true }).click();
  await expect(page.locator('.sf-route-details tbody tr')).toHaveCount(2);
  await expect(
    page.locator('.sf-route-details tbody tr').filter({ hasText: '16→17성' }),
  ).toContainText('사용');
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(225);
  const paid = await current(page);
  expect(paid.state.attempts).toBe(1n);
  expect(paid.state.stars).toBe(16);
  expect(paid.state.destructions).toBe(0n);
  expect(paid.state.history[0].safeguardPrevented).toBe(true);
  await expect(page.locator('.sf-stage')).toHaveClass(/outcome-protected/);
  await expect(page.locator('.sf-outcome')).toContainText('파괴 방지 성공!');
  expect(paid.state.enhancementMeso).toBe(formatAmount(((normalCost * 27n + 500n) / 1000n) * 100n));
  await page.clock.fastForward(550);
  expect((await current(page)).config.policy).toEqual(optimized.steps);
  expect((await current(page)).state).toEqual(paid.state);
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
  expect((await current(page)).state).toEqual(paid.state);
  expect((await current(page)).config.policy).toEqual(optimized.steps);
  await page.unroute(workerRoute);
  await page.getByRole('button', { name: '처음부터 다시', exact: true }).click();
  await expectAttempts(page, 0n);
  expect((await current(page)).config.policy).toEqual(optimized.steps);
  expect((await current(page)).state.spentMeso).toBe('0');

  await page.getByLabel('복구용 동일 장비 가격 (메소)', { exact: true }).fill('12345');
  await ready(page);
  expect((await current(page)).config.policy).toBeUndefined();
  await expect(page.locator('.sf-route-result')).toHaveCount(0);
  await optimize(page);
  await page.getByRole('button', { name: '수동 설정으로 돌아가기', exact: true }).click();
  await ready(page);
  expect((await current(page)).config.policy).toBeUndefined();
  await expect(page.locator('.sf-route-result')).toHaveCount(0);
});

test('stopping a charging attempt and leaving the tab cancel timers without hidden costs', async ({
  page,
}) => {
  await page.goto('./#starforce');
  await ready(page);
  const characterDefault = await current(page);
  expect(characterDefault.itemId).not.toBe('manual');
  await bootManual(page);
  const initial = await current(page);
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(100);
  await page.getByRole('button', { name: '중단', exact: true }).click();
  await page.clock.fastForward(5000);
  expect((await current(page)).state).toEqual(initial.state);
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.clock.fastForward(150);
  await expectAttempts(page, 1n);
  await expectNoStarforceSave(page);
  await selectSimulator(page, '큐브');
  await page.clock.fastForward(10000);
  await selectSimulator(page, '스타포스');
  await ready(page);
  expect(await current(page)).toEqual(characterDefault);
  await expect(page.getByRole('button', { name: '자동 강화', exact: true })).toBeEnabled();
  await page.clock.fastForward(5000);
  expect(await current(page)).toEqual(characterDefault);
  await expectNoStarforceSave(page);
});

test('reload starts from character equipment and never saves paid progress or settings', async ({
  page,
}) => {
  await page.goto('./#starforce');
  await ready(page);
  const characterDefault = await current(page);
  expect(characterDefault.itemId).not.toBe('manual');
  await expectNoStarforceSave(page);

  await bootManual(page, 0, 2);
  await page.getByRole('checkbox', { name: /샤이닝 스타포스/ }).check();
  await page.getByLabel('복구용 동일 장비 가격 (메소)', { exact: true }).fill('12345');
  await ready(page);
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.clock.fastForward(150);
  await expectAttempts(page, 1n);
  expect((await current(page)).state.spentMeso).not.toBe('0');
  await expectNoStarforceSave(page);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.clock.fastForward(5000);
  await expectAttempts(page, 1n);
  await expectNoStarforceSave(page);

  await page.reload();
  await ready(page);
  expect(await current(page)).toEqual(characterDefault);
  await expect(page.getByRole('checkbox', { name: /샤이닝 스타포스/ })).not.toBeChecked();
  await expect(page.getByLabel('복구용 동일 장비 가격 (메소)', { exact: true })).toHaveValue('0');
  await expectNoStarforceSave(page);
});

test('legacy local progress is ignored when opening a new starforce screen', async ({ page }) => {
  await page.goto('./#starforce');
  await ready(page);
  const characterDefault = await current(page);
  const legacyConfig: StarforceConfig = {
    level: 200,
    startStars: 0,
    targetStars: 2,
    safeguard: true,
    restoration: 'original',
    replacementPrice: 12345,
    equipmentType: 'normal',
    event: 'shiningNoGuarantee',
  };
  const legacyKey = 'isekai:starforce:v1:깽미니';
  const legacySave = serialize({
    version: 1,
    ruleId: rules.ruleId,
    preset: characterDefault.preset,
    itemId: 'manual',
    config: legacyConfig,
    state: {
      ...createStarforceState(rules, legacyConfig),
      status: 'success',
      stars: 2,
      attempts: 2n,
      enhancementMeso: 300000n,
      spentMeso: 300000n,
    },
  });
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: legacyKey,
    value: legacySave,
  });
  await page.reload();
  await ready(page);
  expect(await current(page)).toEqual(characterDefault);
  await page.getByRole('button', { name: '강화하기', exact: true }).click();
  await page.clock.fastForward(600);
  await expectAttempts(page, 1n);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate((key) => localStorage.getItem(key), legacyKey)).toBe(legacySave);
  expect(
    await page.evaluate(
      () => (window as unknown as { starforceStorageWrites: string[] }).starforceStorageWrites,
    ),
  ).toEqual([]);
  await expect(page.getByText('이 브라우저에 저장됨', { exact: true })).toHaveCount(0);
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
