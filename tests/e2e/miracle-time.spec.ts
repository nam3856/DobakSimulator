import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { BenchmarkResult, SimulationConfig, SimulationState } from '../../src/types';
import { deserialize, type StoredSession } from '../../src/ui/storage';
import { selectSimulator } from './helpers/navigation';

type BenchmarkObservation = { config: SimulationConfig; result?: BenchmarkResult };

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  // Observe the real Worker; leave its probability calculation and response unchanged.
  await page.addInitScript(() => {
    const observed = window as unknown as { miracleBenchmarks: BenchmarkObservation[] };
    observed.miracleBenchmarks = [];
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message) {
      if (message?.type === 'benchmark') {
        const observation: BenchmarkObservation = { config: structuredClone(message.config) };
        observed.miracleBenchmarks.push(observation);
        const receive = (event: MessageEvent) => {
          if (event.data?.type !== 'benchmark' || event.data.id !== message.id) return;
          observation.result = structuredClone(event.data.result);
          this.removeEventListener('message', receive);
        };
        this.addEventListener('message', receive);
      }
      original.call(this, message, { transfer: [] });
    };
  });
});

async function stored(page: Page): Promise<StoredSession> {
  return deserialize<StoredSession>(
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem('isekai-jikjak:session:v1')!;
    }),
  );
}

async function archives(page: Page) {
  return deserialize<{ config: SimulationConfig; state: SimulationState }[]>(
    await page.evaluate(() => localStorage.getItem('isekai-jikjak:archive:v1') ?? '[]'),
  );
}

async function boot(page: Page, mode = 'cube') {
  await page.goto(`./#${mode}`);
  await expect(page.getByRole('heading', { name: '도전 설정', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '미라클타임', exact: true })).toBeEnabled();
}

async function promotionGoal(page: Page) {
  await page.getByLabel('시작 등급', { exact: true }).selectOption('unique');
  await page.getByLabel('성공 기준', { exact: true }).selectOption('grade');
  await page.getByLabel('목표 등급', { exact: true }).selectOption('legendary');
}

async function benchmark(page: Page, miracleTime: boolean) {
  const latest = () =>
    page.evaluate(() =>
      (window as unknown as { miracleBenchmarks: BenchmarkObservation[] }).miracleBenchmarks.at(-1),
    );
  await expect
    .poll(async () => {
      const observation = await latest();
      return observation &&
        Boolean(observation.config.miracleTime) === miracleTime &&
        observation.config.start.grade === 'unique' &&
        observation.config.target.mode === 'grade' &&
        observation.config.target.minimumGrade === 'legendary'
        ? observation.result?.status
        : undefined;
    })
    .toBe('ready');
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중');
  return (await latest())!.result!;
}

async function naturalRate(page: Page) {
  const text = await page.locator('.pity-area').innerText();
  const match = text.match(/자연 상승률\s*([\d.]+)%/);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

for (const mode of ['cube', 'soulPotential'] as const) {
  test(`${mode} miracle time doubles the shown promotion rate and lowers the real Worker estimate`, async ({
    page,
  }) => {
    await boot(page, mode);
    const checkbox = page.getByRole('checkbox', { name: '미라클타임', exact: true });
    await expect(checkbox).not.toBeChecked();
    expect(Boolean((await stored(page)).config.miracleTime)).toBe(false);
    await promotionGoal(page);
    const ordinary = await benchmark(page, false);
    const rate = await naturalRate(page);
    expect(rate).toBeGreaterThan(0);
    expect(ordinary.expectedCost).toBeGreaterThan(0);

    await checkbox.check();
    await expect(checkbox).toBeChecked();
    // The published event table rounds separately: soul unique is 0.6645%, not 0.6644%.
    expect(await naturalRate(page)).toBe(mode === 'cube' ? 2.8 : 0.6645);
    const event = await benchmark(page, true);
    expect(event.expectedAttempts).toBeGreaterThan(0);
    expect(event.expectedAttempts).toBeLessThan(ordinary.expectedAttempts);
    expect(event.expectedCost).toBeLessThan(ordinary.expectedCost);
    await expect(page.locator('.expected-stat strong')).not.toHaveText('0');

    await checkbox.uncheck();
    expect(await naturalRate(page)).toBeCloseTo(rate, 4);
    const restored = await benchmark(page, false);
    expect(restored.expectedCost).toBeCloseTo(ordinary.expectedCost, 5);
    expect(restored.expectedAttempts).toBeCloseTo(ordinary.expectedAttempts, 5);
  });

  test(`${mode} changing the event archives paid progress and preserves options and guarantee counts`, async ({
    page,
  }) => {
    await boot(page, mode);
    await promotionGoal(page);
    await page.getByRole('button', { name: '1회', exact: true }).click();
    await page.getByLabel('등급 상승 누적 실패', { exact: true }).fill('7');
    // Only gameplay draws are fixed. The real rule/cost/pity logic and Worker stay in use.
    await page.evaluate(() => {
      Object.defineProperty(globalThis.crypto, 'getRandomValues', {
        value: (values: Uint32Array) => {
          values.fill(0xffffffff);
          return values;
        },
      });
    });
    const checkbox = page.getByRole('checkbox', { name: '미라클타임', exact: true });
    const initial = await stored(page);
    for (const [index, enabled] of [true, false].entries()) {
      await page.getByRole('button', { name: '1회 재설정하기', exact: true }).click();
      await expect.poll(async () => (await stored(page)).state.attempts).toBe(1n);
      const previous = await stored(page);
      expect(previous.state.grade).toBe('unique');
      // The event doubles only the natural promotion rate: each failed roll still adds one.
      expect(previous.state.failures).toBe(8 + index);
      expect(previous.state.spent.meso).toBeGreaterThan(0n);

      await checkbox.setChecked(enabled);
      const restarted = await stored(page);
      expect(restarted.config.miracleTime).toBe(enabled);
      expect(restarted.state.grade).toBe(previous.state.grade);
      expect(restarted.state.lines).toEqual(previous.state.lines);
      expect(restarted.state.failures).toBe(previous.state.failures);
      expect(restarted.config.start.grade).toBe(previous.state.grade);
      expect(restarted.config.start.lines).toEqual(previous.state.lines);
      expect(restarted.config.start.failures).toBe(previous.state.failures);
      expect(restarted.state.attempts).toBe(0n);
      expect(restarted.state.spent).toEqual(initial.state.spent);
      expect(restarted.state.history).toEqual([]);
      expect(restarted.state.candidates).toEqual([]);
      const records = await archives(page);
      expect(records).toHaveLength(index + 1);
      expect(records[0].config).toEqual(previous.config);
      expect(records[0].state).toEqual(previous.state);
    }
  });
}

test('event selection survives cube types, equipment, simulator tabs and reloads', async ({
  page,
}) => {
  await boot(page);
  const checkbox = page.getByRole('checkbox', { name: '미라클타임', exact: true });
  await checkbox.check();
  for (const [name, supported] of [
    ['에디셔널큐브', true],
    ['골드큐브', true],
    ['프라임큐브', false],
    ['프라임 에디셔널', false],
    ['블랙큐브', true],
  ] as const) {
    await page
      .locator('.cube-picker')
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click();
    if (supported) {
      await expect(checkbox).toBeEnabled();
      await expect(checkbox).toBeChecked();
      if (name === '골드큐브') {
        await page.getByLabel('시작 등급', { exact: true }).selectOption('unique');
        expect(await naturalRate(page)).toBe(0.3992);
        await expect(page.locator('.pity-area')).toContainText('등급 상승 보장 없음');
        await expect(page.locator('.pity-area progress')).toHaveCount(0);
      }
    } else {
      await expect(checkbox).toBeDisabled();
    }
    expect((await stored(page)).config.miracleTime).toBe(true);
  }
  const session = await stored(page);
  const hat = session.character.equipmentPresets[session.equipmentPreset].find(
    (item) => item.category === 'hat',
  )!;
  await page.getByLabel('장비 선택', { exact: true }).selectOption(hat.id);
  await expect(checkbox).toBeChecked();
  await page.reload();
  await expect(checkbox).toBeChecked();
  await expect(page.getByLabel('장비 선택', { exact: true })).toHaveValue(hat.id);

  await selectSimulator(page, '소울 잠재');
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await page.reload();
  await expect(checkbox).toBeChecked();
  for (const name of ['고급 재설정', '소울 증폭']) {
    await selectSimulator(page, name);
    await expect(checkbox).toHaveCount(0);
    expect((await stored(page)).config.miracleTime).toBe(true);
  }
  await selectSimulator(page, '큐브');
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await page.reload();
  await expect(checkbox).not.toBeChecked();
});

test.describe('mobile miracle time control', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('390px touch and keyboard control is usable without horizontal overflow', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await boot(page);
    await mkdir('.cache/miracle-time', { recursive: true });
    for (const mode of ['큐브', '소울 잠재']) {
      if (mode !== '큐브') await selectSimulator(page, mode);
      await promotionGoal(page);
      const checkbox = page.getByRole('checkbox', { name: '미라클타임', exact: true });
      const label = checkbox.locator('xpath=ancestor::label[1]');
      await label.scrollIntoViewIfNeeded();
      const bounds = (await label.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
      await expect(checkbox).not.toBeChecked();
      await label.tap();
      await expect(checkbox).toBeChecked();
      expect((await stored(page)).config.miracleTime).toBe(true);
      await benchmark(page, true);
      await page.screenshot({
        path: `.cache/miracle-time/${mode === '큐브' ? 'cube' : 'soul'}-mobile.png`,
        fullPage: true,
      });
      await checkbox.focus();
      await expect(checkbox).toBeFocused();
      await page.keyboard.press('Space');
      await expect(checkbox).not.toBeChecked();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
    }
  });
});
