import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { CharacterSnapshot } from '../../src/types';
import { deserialize, type StoredSession } from '../../src/ui/storage';

const character = JSON.parse(
  readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
) as CharacterSnapshot;
for (const items of Object.values(character.equipmentPresets))
  for (const item of items) if (item.eligibleSoul && item.soul) item.soul.stage = 0;

async function boot(page: Page, draws: number[]) {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  await page.route('**/character/snapshot.json', (route) => route.fulfill({ json: character }));
  await page.addInitScript((values) => {
    const remaining = [...values];
    crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint32Array).fill(Math.floor((remaining.shift() ?? 0) * 4294967296));
      return array;
    };
  }, draws);
  const time = new Date('2026-09-18T12:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.goto('./#soulAmplification');
  await expect(page.getByRole('button', { name: '증폭 시도하기', exact: true })).toBeEnabled();
  await expect(page.locator('.soul-amplification')).toHaveAttribute('data-phase', 'idle');
}

async function stored(page: Page) {
  return deserialize<StoredSession>(
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem('isekai-jikjak:session:v1')!;
    }),
  );
}

test('manual misses finish in one second, successes in two, and rapid clicks pay only once', async ({
  page,
}) => {
  await boot(page, [0.99, 0]);
  const display = page.locator('.soul-amplification');
  const roll = page.getByRole('button', { name: '증폭 시도하기', exact: true });
  const auto = page.getByRole('button', { name: '자동 재설정', exact: true });

  // Dispatch within one browser task to exercise the guard before React can
  // repaint the disabled button. The actual engine still determines each roll.
  await roll.evaluate((button) => {
    for (let i = 0; i < 3; i++) button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect(display).toHaveAttribute('data-phase', 'charging');
  await expect(roll).toBeDisabled();
  await expect(auto).toBeDisabled();
  const miss = (await stored(page)).state;
  expect(miss.attempts).toBe(1n);
  expect(miss.stage).toBe(0);
  expect(miss.failures).toBe(1);
  expect(miss.spent.meso).toBe(500_000_000n);
  expect(miss.spent.ethers).toEqual([1n, 0n, 0n, 0n]);
  expect(miss.history).toHaveLength(1);

  await page.clock.fastForward(549);
  await expect(display).toHaveAttribute('data-phase', 'charging');
  await page.clock.fastForward(1);
  await expect(display).toHaveAttribute('data-phase', 'failure');
  await page.clock.fastForward(449);
  await expect(roll).toBeDisabled();
  await page.clock.fastForward(1);
  await expect(display).toHaveAttribute('data-phase', 'idle');
  await expect(roll).toBeEnabled();
  await expect(auto).toBeEnabled();
  expect((await stored(page)).state).toEqual(miss);

  await roll.click();
  await expect(display).toHaveAttribute('data-phase', 'charging');
  await expect(display.locator('.amp-stage')).toHaveText(/^0\s*단계/);
  const success = (await stored(page)).state;
  expect(success.attempts).toBe(2n);
  expect(success.stage).toBe(1);
  expect(success.failures).toBe(0);
  expect(success.spent.meso).toBe(1_000_000_000n);
  expect(success.spent.ethers).toEqual([2n, 0n, 0n, 0n]);
  expect(success.history.map((result) => result.amplified)).toEqual([false, true]);
  await page.clock.fastForward(550);
  await expect(display).toHaveAttribute('data-phase', 'success');
  await expect(display.locator('.amp-stage')).toHaveText(/^1\s*단계/);
  await page.clock.fastForward(1449);
  await expect(display).toHaveAttribute('data-phase', 'success');
  await expect(roll).toBeDisabled();
  await expect(auto).toBeDisabled();
  await page.clock.fastForward(1);
  await expect(display).toHaveAttribute('data-phase', 'idle');
  await expect(roll).toBeEnabled();
  expect((await stored(page)).state).toEqual(success);
});

test('a new challenge cancels old timers without changing the next paid attempt', async ({
  page,
}) => {
  await boot(page, [0, 0.99]);
  const display = page.locator('.soul-amplification');
  const roll = page.getByRole('button', { name: '증폭 시도하기', exact: true });

  await roll.click();
  await expect(display).toHaveAttribute('data-phase', 'charging');
  expect((await stored(page)).state.stage).toBe(1);
  await page.clock.fastForward(200);
  await page.getByRole('button', { name: '새 도전', exact: true }).click();
  await expect(display).toHaveAttribute('data-phase', 'idle');
  await expect(roll).toBeEnabled();
  const reset = (await stored(page)).state;
  expect(reset.attempts).toBe(0n);
  expect(reset.stage).toBe(0);
  expect(reset.spent.meso).toBe(0n);
  expect(reset.history).toEqual([]);

  await roll.click();
  const next = (await stored(page)).state;
  expect(next.attempts).toBe(1n);
  expect(next.stage).toBe(0);
  expect(next.failures).toBe(1);
  expect(next.spent.meso).toBe(500_000_000n);
  expect(next.spent.ethers).toEqual([1n, 0n, 0n, 0n]);
  // Cross the canceled charge deadline while the new miss is still charging.
  await page.clock.fastForward(350);
  await expect(display).toHaveAttribute('data-phase', 'charging');
  await page.clock.fastForward(200);
  await expect(display).toHaveAttribute('data-phase', 'failure');
  await page.clock.fastForward(250);
  await expect(display).toHaveAttribute('data-phase', 'failure');
  await expect(roll).toBeDisabled();
  await page.clock.fastForward(200);
  await expect(display).toHaveAttribute('data-phase', 'idle');
  await expect(roll).toBeEnabled();
  // The canceled success would have ended at 2000 ms; it must not replay or mutate state.
  await page.clock.fastForward(800);
  await expect(display).toHaveAttribute('data-phase', 'idle');
  await expect(roll).toBeEnabled();
  expect((await stored(page)).state).toEqual(next);
});

test('reduced motion unlocks on mobile and reload keeps the result without replaying it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, [0]);
  const display = page.locator('.soul-amplification');
  const roll = page.getByRole('button', { name: '증폭 시도하기', exact: true });
  await roll.click();
  await expect(display).toHaveAttribute('data-phase', 'charging');
  await page.clock.fastForward(550);
  await expect(display).toHaveAttribute('data-phase', 'success');
  expect(
    await display.evaluate((element) =>
      [...element.querySelectorAll('*')].every(
        (child) => getComputedStyle(child).animationName === 'none',
      ),
    ),
  ).toBe(true);
  await page.clock.fastForward(1450);
  await expect(display).toHaveAttribute('data-phase', 'idle');
  await expect(roll).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const before = (await stored(page)).state;
  await page.reload();
  await expect(display).toHaveAttribute('data-phase', 'idle');
  await expect(roll).toBeEnabled();
  await expect(display.locator('.amp-stage')).toHaveText(/^1\s*단계/);
  await page.clock.fastForward(1000);
  await expect(display).toHaveAttribute('data-phase', 'idle');
  const after = (await stored(page)).state;
  expect(after).toEqual({ ...before, status: 'paused' });
});
