import { expect, test, type Page } from '@playwright/test';
import type { SimulatorMode } from '../../src/types';
import { deserialize, serialize, type StoredSession } from '../../src/ui/storage';

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  // Isolate the shared UI contract at exactly P95. Engine boundary tests and the
  // starforce luck test independently verify how a completed run earns this CDF.
  await page.route('**/assets/simulator.worker-*.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `self.onmessage = ({ data }) => {
        if (data.type !== 'benchmark') return;
        self.postMessage({ type: 'benchmark', id: data.id, result: {
          status: 'ready', expectedCost: 1000, expectedAttempts: 1,
          successProbability: 1, unit: 'meso', method: 'analytic', sampleCount: 0,
          quantiles: { p10: 100, p50: 400, p90: 900 },
          distribution: [{ cost: 100, cdf: 0.1 }, { cost: 400, cdf: 0.5 },
            { cost: 900, cdf: 0.9 }, { cost: 1000, cdf: 0.95 }, { cost: 2000, cdf: 1 }],
          cdfAtActual: data.actualCost === undefined ? undefined : 0.95
        }});
      };`,
    }),
  );
});

async function restoreCompletedRun(page: Page, mode: SimulatorMode) {
  await page.goto(`./#${mode}`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toBeVisible();
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중');
  const session = deserialize<StoredSession>(
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem('isekai-jikjak:session:v1')!;
    }),
  );
  session.state = {
    ...session.state,
    attempts: 1n,
    status: 'success',
    spent: { ...session.state.spent, meso: 1000n },
    finishedAt: new Date().toISOString(),
  };
  // Install the saved result before hydration; the rest of the session comes
  // from the actual mode setup, including character assets and target options.
  await page.addInitScript((saved) => {
    localStorage.setItem('isekai-jikjak:session:v1', saved);
  }, serialize(session));
  await page.reload();
  await expect(page.locator('.reaction-stage')).toHaveClass(/is-ghost/);
}

for (const mode of ['cube', 'ability', 'soulAmplification', 'soulPotential'] as const) {
  test(`${mode}: P95 restores the ghost and falling tombstone, and a new challenge clears them`, async ({
    page,
  }) => {
    await restoreCompletedRun(page, mode);
    const ghost = page.locator('.stage-sprite.reaction-ghost');
    const tombstone = page.locator('.reaction-tombstone');
    await expect(page.locator('.luck-badge')).toContainText('P95');
    await expect(page.locator('.reaction-stage h3')).toHaveText('이세계여서 다행이다…');
    await expect(ghost).toHaveAttribute('src', /\/character\/ghost\.png$/);
    await expect(ghost).toHaveJSProperty('complete', true);
    expect(await ghost.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(
      0,
    );
    await expect(tombstone).toBeVisible();
    await expect(tombstone).toHaveAttribute('aria-hidden', 'true');
    const layerAndMotion = await page.locator('.reaction-scene').evaluate((scene) => {
      const sprite = getComputedStyle(scene.querySelector('.stage-sprite')!);
      const grave = getComputedStyle(scene.querySelector('.reaction-tombstone')!);
      const stone = getComputedStyle(scene.querySelector('.tombstone-stone')!);
      return {
        floating: sprite.animationName,
        repetitions: sprite.animationIterationCount,
        drop: stone.animationName,
        inFront: Number(sprite.zIndex) > Number(grave.zIndex),
      };
    });
    expect(layerAndMotion.floating).toBe('ghost-hover');
    expect(layerAndMotion.repetitions).toBe('infinite');
    expect(layerAndMotion.drop).toBe('tombstone-drop');
    expect(layerAndMotion.inFront).toBe(true);
    await page.reload();
    await expect(page.locator('.reaction-stage')).toHaveClass(/is-ghost/);
    await expect(tombstone).toBeVisible();
    await page.getByRole('button', { name: '새 도전', exact: true }).click();
    await expect(page.locator('.reaction-stage')).not.toHaveClass(/is-ghost/);
    await expect(tombstone).toHaveCount(0);
    await expect(page.locator('.luck-badge')).toHaveCount(0);
  });
}

test('ghost on mobile respects reduced motion and preserves the tombstone when the avatar fails', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await restoreCompletedRun(page, 'soulAmplification');
  for (const selector of ['.stage-sprite', '.tombstone-stone', '.tombstone-dust:first-of-type'])
    expect(
      await page.locator(selector).evaluate((element) => getComputedStyle(element).animationName),
    ).toBe('none');
  await page.route('**/character/ghost.png', (route) => route.abort());
  await page.reload();
  await expect(page.locator('.reaction-stage')).toHaveClass(/is-ghost/);
  await expect(page.locator('.reaction-tombstone')).toBeVisible();
  await expect(page.locator('.stage-sprite')).not.toHaveAttribute(
    'src',
    /\/character\/ghost\.png$/,
  );
  for (const theme of ['light', 'dark']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page
        .getByRole('button', { name: theme === 'dark' ? '어두운 테마' : '밝은 테마', exact: true })
        .click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    await expect(page.locator('.reaction-stage h3')).toHaveText('이세계여서 다행이다…');
  }
});
