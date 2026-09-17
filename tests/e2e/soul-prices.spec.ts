import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { BenchmarkResult, CharacterSnapshot } from '../../src/types';
import { deserialize, type StoredSession } from '../../src/ui/storage';

const character = JSON.parse(
  readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
) as CharacterSnapshot;
for (const items of Object.values(character.equipmentPresets))
  for (const item of items) if (item.eligibleSoul && item.soul) item.soul.stage = 0;
const soul = JSON.parse(
  readFileSync(new URL('../../public/rules/soul.json', import.meta.url), 'utf8'),
);
soul.amplificationStages[0] = {
  stage: 1,
  initialSuccessProbability: 0.5,
  successProbabilityIncreasePerFailure: 0.25,
  guaranteedAfterFailures: 1,
  systemCostPerAttempt: '500000000',
};
soul.amplificationStages[1] = {
  stage: 2,
  initialSuccessProbability: 0.25,
  successProbabilityIncreasePerFailure: 0.25,
  guaranteedAfterFailures: 2,
  systemCostPerAttempt: '1000000000',
};

async function stored(page: Page) {
  return deserialize<StoredSession>(
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem('isekai-jikjak:session:v1')!;
    }),
  );
}
async function benchmark(page: Page) {
  return page.evaluate(
    () => (window as unknown as { soulBenchmark?: BenchmarkResult }).soulBenchmark,
  );
}

test('ether defaults and repricing update total cost, expectation and reaction without resetting the paid challenge', async ({
  page,
}) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  await page.route('**/character/snapshot.json', (route) => route.fulfill({ json: character }));
  await page.route('**/rules/soul.json', (route) => route.fulfill({ json: soul }));
  // Keep the real engine and Worker; choose one success in stage1, then two misses before stage2 pity.
  await page.route('**/assets/simulator.worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `const draws = [0, 0.9, 0.9];
      self.crypto.getRandomValues = array => { array.fill(Math.floor((draws.shift() ?? 0) * 4294967296)); return array; };
      ${await response.text()}`,
    });
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event) => {
          if (event.data?.type === 'benchmark')
            (window as unknown as { soulBenchmark: unknown }).soulBenchmark = event.data.result;
        });
      }
    };
  });
  await page.goto('./#soulAmplification');
  await expect(page.getByRole('button', { name: '증폭 시도하기', exact: true })).toBeEnabled();
  await page.getByText('재료 단가 (선택)', { exact: true }).click();
  for (const [index, value] of ['1500000000', '2000000000', '1200000000', '4000000000'].entries())
    await expect(
      page.getByLabel(`${index + 1}단계 에테르 단가 (메소)`, { exact: true }),
    ).toHaveValue(value);
  await page.getByRole('combobox', { name: '목표 증폭 단계', exact: true }).selectOption('2');
  const originalMean =
    1.5 * (500_000_000 + 1_500_000_000) + 2.125 * (1_000_000_000 + 2_000_000_000);
  await expect.poll(async () => (await benchmark(page))?.expectedCost).toBe(originalMean);
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('4회');
  await expect(page.locator('.reaction-stage')).toHaveClass(/is-cry/);
  const before = await stored(page);
  expect(before.state.spent.meso).toBe(3_500_000_000n);
  expect(before.state.spent.ethers).toEqual([1n, 3n, 0n, 0n]);
  expect(before.state.status).toBe('success');
  await expect(page.locator('.spent-stat strong')).toHaveAttribute('title', '11,000,000,000');
  await expect(page.locator('.resource-ledger')).toContainText('강화 메소 35억 메소');
  expect((await benchmark(page))?.cdfAtActual).toBe(0.8125);

  await page.getByLabel('1단계 에테르 단가 (메소)', { exact: true }).fill('15000000000');
  const updatedMean =
    1.5 * (500_000_000 + 15_000_000_000) + 2.125 * (1_000_000_000 + 2_000_000_000);
  await expect.poll(async () => (await benchmark(page))?.expectedCost).toBe(updatedMean);
  await expect(page.locator('.spent-stat strong')).toHaveAttribute('title', '24,500,000,000');
  await expect(page.locator('.reaction-stage')).toHaveClass(/is-happy/);
  expect((await benchmark(page))?.cdfAtActual).toBe(0.5);
  expect((await stored(page)).state).toEqual(before.state);
  await page.getByLabel('4단계 에테르 단가 (메소)', { exact: true }).fill('0');
  const repriced = await stored(page);
  expect(repriced.state).toEqual(before.state);
  await page.reload();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('4회');
  await expect(page.locator('.reaction-stage')).toHaveClass(/is-happy/);
  await page.getByText('재료 단가 (선택)', { exact: true }).click();
  await expect(page.getByLabel('1단계 에테르 단가 (메소)', { exact: true })).toHaveValue(
    '15000000000',
  );
  await expect(page.getByLabel('4단계 에테르 단가 (메소)', { exact: true })).toHaveValue('0');
  expect((await stored(page)).state).toEqual(before.state);
  expect((await stored(page)).config.unitPrices).toEqual(repriced.config.unitPrices);
});
