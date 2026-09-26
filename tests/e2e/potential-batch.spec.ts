import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { deserialize, type StoredSession } from '../../src/ui/storage';
import type { ResourceCost } from '../../src/types';
import { selectSimulator } from './helpers/navigation';

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
});

async function stored(page: Page): Promise<StoredSession> {
  return deserialize<StoredSession>(
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem('isekai-jikjak:session:v1')!;
    }),
  );
}

async function boot(page: Page, mode: string) {
  await page.goto(`./#${mode}`);
  await expect(page.getByRole('heading', { name: '도전 설정', exact: true })).toBeVisible();
}

async function promotionGoal(page: Page) {
  await page.getByLabel('시작 등급', { exact: true }).selectOption('unique');
  await page.getByLabel('성공 기준', { exact: true }).selectOption('grade');
  await page.getByLabel('목표 등급', { exact: true }).selectOption('legendary');
  await expect(page.getByRole('button', { name: '3회 연속', exact: true })).toHaveClass(/selected/);
}

async function fixedGameplayDraw(page: Page, draw = 0xffffffff) {
  // Fix only gameplay draws; official probabilities, guarantees and billing remain real.
  await page.evaluate((value) => {
    Object.defineProperty(globalThis.crypto, 'getRandomValues', {
      configurable: true,
      value: (values: Uint32Array) => {
        values.fill(value);
        return values;
      },
    });
  }, draw);
}

function expectCharged(cost: ResourceCost, single: ResourceCost, count: number) {
  for (const resource of ['meso', 'honor', 'cubes', 'credits'] as const)
    expect(cost[resource]).toBe(single[resource] * BigInt(count));
  expect(cost.ethers).toEqual(single.ethers.map((value) => value * BigInt(count)));
  expect(single.meso + single.cubes + single.honor + single.credits).toBeGreaterThan(0n);
}

for (const [mode, cube] of [
  ['cube', '블랙큐브'],
  ['cube', '에디셔널큐브'],
  ['cube', '골드큐브'],
  ['soulPotential', '소울 잠재'],
] as const) {
  test(`${cube} lower-grade batch runs three paid attempts and counts each failure`, async ({
    page,
  }) => {
    await boot(page, mode);
    if (mode === 'cube')
      await page
        .locator('.cube-picker')
        .getByRole('button', { name: new RegExp(`^${cube}`) })
        .click();
    await promotionGoal(page);
    await fixedGameplayDraw(page);
    await expect(page.locator('.control-hint')).toContainText('최대 3회');
    await expect(page.locator('.control-hint')).toContainText(/등급 상승|등업/);
    await page.getByRole('button', { name: '최대 3회 재설정하기', exact: true }).click();
    await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('3회');
    const paid = (await stored(page)).state;
    expect(paid.attempts).toBe(3n);
    expect(paid.failures).toBe(3);
    expect(paid.grade).toBe('unique');
    expect(paid.candidates).toHaveLength(3);
    expect(paid.history.map((result) => result.sequence)).toEqual([1n, 2n, 3n]);
    expect(paid.candidates.every((result) => !result.promoted && !result.hit)).toBe(true);
    expectCharged(paid.spent, paid.candidates[0].cost, 3);
    await expect(page.locator('.candidate-card')).toHaveCount(3);
    await page.reload();
    await expect(page.getByRole('button', { name: '3회 연속', exact: true })).toHaveClass(
      /selected/,
    );
    expect((await stored(page)).state.spent).toEqual(paid.spent);
    expect((await stored(page)).state.failures).toBe(3);

    await page.getByRole('button', { name: '1회', exact: true }).click();
    await expect(page.getByRole('button', { name: '1회', exact: true })).toHaveClass(/selected/);
    await fixedGameplayDraw(page);
    await page.getByRole('button', { name: '1회 재설정하기', exact: true }).click();
    const single = (await stored(page)).state;
    expect(single.attempts).toBe(1n);
    expect(single.failures).toBe(4);
    expect(single.candidates).toHaveLength(1);
    expectCharged(single.spent, single.candidates[0].cost, 1);
    await page.getByRole('button', { name: '3회 연속', exact: true }).click();
    await expect(page.getByRole('button', { name: '3회 연속', exact: true })).toHaveClass(
      /selected/,
    );
    await expect(
      page.getByRole('button', { name: '최대 3회 재설정하기', exact: true }),
    ).toBeEnabled();
  });
}

for (const mode of ['cube', 'soulPotential'] as const) {
  test(`${mode} guaranteed promotion on roll two stops billing and unlocks legendary comparison`, async ({
    page,
  }) => {
    await boot(page, mode);
    await promotionGoal(page);
    const guarantee = Number(await page.locator('.pity-area progress').getAttribute('max'));
    expect(guarantee).toBeGreaterThan(1);
    await page.getByLabel('등급 상승 누적 실패', { exact: true }).fill(String(guarantee - 1));
    await fixedGameplayDraw(page);
    await page.getByRole('button', { name: '최대 3회 재설정하기', exact: true }).click();
    await expect(page.locator('.current-result .grade-badge')).toHaveText('레전드리');
    await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('2회');
    const promoted = (await stored(page)).state;
    expect(promoted.attempts).toBe(2n);
    expect(promoted.failures).toBe(0);
    expect(promoted.candidates).toHaveLength(2);
    expect(promoted.candidates.map((result) => result.promoted)).toEqual([false, true]);
    expect(promoted.candidates.map((result) => result.hit)).toEqual([false, false]);
    expectCharged(promoted.spent, promoted.candidates[0].cost, 2);
    await expect(page.getByRole('button', { name: '3회 연속', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '3회 비교', exact: true })).toHaveClass(
      /selected/,
    );
    await expect(page.getByRole('button', { name: '3회 재설정하기', exact: true })).toBeEnabled();

    // Begin a new option goal from the actually promoted lines, then compare all three rolls.
    await page.getByLabel('성공 기준', { exact: true }).selectOption('sum');
    await page.getByLabel('목표 조건 1 옵션', { exact: true }).selectOption('attackPercent');
    const value = page.getByLabel('목표 조건 1 수치', { exact: true });
    await value.fill((await value.getAttribute('max'))!);
    await value.press('Tab');
    await expect(page.getByLabel('시작 등급', { exact: true })).toHaveValue('legendary');
    await expect(page.getByRole('button', { name: '3회 재설정하기', exact: true })).toBeEnabled();
    await fixedGameplayDraw(page, 0);
    await page.getByRole('button', { name: '3회 재설정하기', exact: true }).click();
    const compared = (await stored(page)).state;
    expect(compared.attempts).toBe(3n);
    expect(compared.grade).toBe('legendary');
    expect(compared.candidates).toHaveLength(3);
    expect(compared.candidates.every((result) => result.grade === 'legendary')).toBe(true);
    expectCharged(compared.spent, compared.candidates[0].cost, 3);
    await expect(page.locator('.candidate-card')).toHaveCount(3);
  });
}

test.describe('mobile sequential potential batches', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('390px shows a touch-sized sequential action and fits all three results', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await boot(page, 'cube');
    await mkdir('.cache/potential-batch', { recursive: true });
    for (const name of ['큐브', '소울 잠재']) {
      await fixedGameplayDraw(page, 0);
      if (name !== '큐브') await selectSimulator(page, name);
      await promotionGoal(page);
      await fixedGameplayDraw(page);
      const action = page.getByRole('button', { name: '최대 3회 재설정하기', exact: true });
      await action.scrollIntoViewIfNeeded();
      const bounds = (await action.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
      await action.tap();
      await expect(page.locator('.candidate-card')).toHaveCount(3);
      await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('3회');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      await expect(page.locator('.expected-stat')).not.toContainText('계산 중', { timeout: 30000 });
      await page.screenshot({
        path: `.cache/potential-batch/${name === '큐브' ? 'cube' : 'soul'}-mobile.png`,
        fullPage: true,
      });
    }
  });
});
