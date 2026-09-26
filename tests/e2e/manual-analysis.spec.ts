import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { BenchmarkResult, SimulationConfig } from '../../src/types';
import { evaluateLuck } from '../../src/engine/benchmark';
import { eligibleCandidates, type Candidate, type RuleData } from '../../src/engine/rules';
import { createState, prepareDraw } from '../../src/engine/simulation';
import { paidBenchmarkCost } from '../../src/engine/soul-cost';
import { formatAmount } from '../../src/ui/format';
import { deserialize, serialize, type StoredSession } from '../../src/ui/storage';

const readRule = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../public/rules/${name}.json`, import.meta.url), 'utf8'));
const data: RuleData = {
  potential: readRule('potential'),
  additional: readRule('additional-potential'),
  gold: readRule('gold'),
  ability: readRule('ability'),
  soul: readRule('soul'),
};
type Observation = { config: SimulationConfig; actualCost?: number; result?: BenchmarkResult };

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  // Observe real requests and responses, preserving the calculation in the built Worker.
  await page.addInitScript(() => {
    const observed = window as unknown as { analysisBenchmarks: Observation[] };
    observed.analysisBenchmarks = [];
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message) {
      if (message?.type === 'benchmark') {
        const entry: Observation = {
          config: structuredClone(message.config),
          actualCost: message.actualCost,
        };
        observed.analysisBenchmarks.push(entry);
        const receive = (event: MessageEvent) => {
          if (event.data?.type !== 'benchmark' || event.data.id !== message.id) return;
          entry.result = structuredClone(event.data.result);
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

async function observations(page: Page): Promise<Observation[]> {
  return deserialize<Observation[]>(
    await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as { analysisBenchmarks: Observation[] }).analysisBenchmarks,
        (_key, value) => (typeof value === 'bigint' ? { $bigint: value.toString() } : value),
      ),
    ),
  );
}

/** Use real option pools; pick a useful attack result that differs from the kept baseline. */
async function scenario(page: Page, mode: 'cube' | 'soulPotential') {
  await page.goto(`./#${mode}`);
  await expect(page.getByRole('heading', { name: '도전 설정', exact: true })).toBeVisible();
  const saved = await stored(page);
  const config: SimulationConfig = {
    ...saved.config,
    mode,
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    batchSize: 3,
    start: { ...saved.config.start, grade: 'legendary', lines: [], failures: 0, stage: 1 },
    target: {
      ...saved.config.target,
      mode: 'sum',
      minimumGrade: 'legendary',
      conditions: [],
      lines: [],
      stage: 1,
    },
    retryStart: undefined,
  };
  const prepared = prepareDraw(data, config, 'legendary', []);
  const attackType = `${saved.character.profile.attackType}Percent`;
  const choose = (wanted: boolean) => {
    const prefix: Candidate[] = [];
    const draws: number[] = [];
    const lines = [0, 1, 2].map((slot) => {
      const rows = eligibleCandidates(prepared.candidates[slot], prefix);
      const index = rows.findIndex((row) =>
        wanted ? row.line.type === attackType : row.line.type !== attackType,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      const row = rows[index];
      draws.push(
        (rows.slice(0, index).reduce((sum, r) => sum + r.probability, 0) + row.probability / 2) /
          rows.reduce((sum, r) => sum + r.probability, 0),
      );
      prefix.push(row);
      return row.line;
    });
    return { lines, draws };
  };
  config.start.lines = choose(false).lines;
  config.retryStart = structuredClone(config.start);
  const desired = choose(true);
  const state = createState(data, config);
  await page.addInitScript(
    (value) => {
      localStorage.setItem('isekai-jikjak:session:v1', value);
    },
    serialize({ ...saved, config, state, playMode: 'upgrade' } satisfies StoredSession),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: '도전 설정', exact: true })).toBeVisible();
  // Repeat only gameplay draws. The kept baseline has no attack %, so rejection cannot loop.
  await page.evaluate((draws) => {
    let cursor = 0;
    Object.defineProperty(globalThis.crypto, 'getRandomValues', {
      configurable: true,
      value: (values: Uint32Array) => {
        values.fill(Math.floor(draws[cursor++ % draws.length] * 4294967296));
        return values;
      },
    });
  }, desired.draws);
  return { config, attackType, desired: desired.lines };
}

async function roll(page: Page, total: number) {
  await page.getByRole('button', { name: '3회 재설정하기', exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.attempts).toBe(BigInt(total));
  await expect(page.locator('.candidate-card')).toHaveCount(3);
}

async function cardBody(page: Page, touch = false) {
  const card = page.locator('.candidate-card').first();
  await card.scrollIntoViewIfNeeded();
  const options = (await card.locator('.option-lines').boundingBox())!;
  const x = options.x + Math.min(24, options.width / 2);
  const y = options.y + Math.min(16, options.height / 2);
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function analyzed(page: Page) {
  const panel = page.getByRole('region', { name: '선택 결과 분석', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.locator('.result-analysis-estimate strong')).toBeVisible();
  return panel;
}

for (const mode of ['cube', 'soulPotential'] as const) {
  test(`${mode} permits no-goal manual rolls and analyzes a result against the current challenge budget without changing it`, async ({
    page,
  }) => {
    const { config, attackType, desired } = await scenario(page, mode);
    await expect(page.getByRole('button', { name: '3회 재설정하기', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '자동 재설정', exact: true })).toBeDisabled();
    await roll(page, 3);
    await roll(page, 6);
    const before = await stored(page);
    expect(before.config.target.conditions).toEqual([]);
    expect(before.state.candidates[0].lines).toEqual(desired);
    const archiveBefore = await page.evaluate(() =>
      localStorage.getItem('isekai-jikjak:archive:v1'),
    );
    await cardBody(page);
    const panel = await analyzed(page);
    const report = (await observations(page)).at(-1)!;
    expect(report.config.start).toEqual(config.start);
    expect(report.config.target).toMatchObject({
      mode: 'sum',
      match: 'all',
      minimumGrade: 'legendary',
    });
    expect(report.config.target.conditions).toEqual([
      { type: attackType, minValue: desired.reduce((sum, row) => sum + row.value, 0) },
    ]);
    const paid = paidBenchmarkCost(before.config, before.state.spent);
    expect(report.actualCost).toBe(Number(paid));
    expect(report.result?.status).toBe('ready');
    expect(report.result!.expectedCost).toBeGreaterThan(0);
    expect(report.result!.cdfAtActual).toBeGreaterThanOrEqual(0);
    expect(report.result!.cdfAtActual).toBeLessThanOrEqual(1);
    await expect(panel.locator('.result-analysis-estimate strong')).toHaveAttribute(
      'title',
      formatAmount(report.result!.expectedCost, false),
    );
    await expect(panel.locator('.result-analysis-spent strong')).toHaveAttribute(
      'title',
      formatAmount(paid, false),
    );
    await expect(panel.locator('.result-analysis-spent')).toContainText('누적 6회');
    await expect(panel.locator('.result-analysis-luck')).toHaveClass(
      new RegExp(`luck-${evaluateLuck(report.result!, Number(paid))}`),
    );
    await expect(
      panel.getByRole('progressbar', { name: '현재 예산 이내 목표 달성 확률' }),
    ).toHaveAttribute('value', String(report.result!.cdfAtActual));
    expect(await stored(page)).toEqual(before);
    expect(await page.evaluate(() => localStorage.getItem('isekai-jikjak:archive:v1'))).toBe(
      archiveBefore,
    );
    await roll(page, 9);
    await expect(page.getByRole('region', { name: '선택 결과 분석' })).toHaveCount(0);
    await expect(page.locator('.candidate-analysis-button[aria-pressed="true"]')).toHaveCount(0);
  });
}

test('result analysis supports Enter, Space and closing without adopting options', async ({
  page,
}) => {
  await scenario(page, 'cube');
  await roll(page, 3);
  const before = await stored(page);
  const action = page.getByRole('button', {
    name: '재설정 1 결과 기댓값과 행운 분석',
    exact: true,
  });
  await action.focus();
  await page.keyboard.press('Enter');
  await analyzed(page);
  await expect(action).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '결과 분석 닫기', exact: true }).click();
  await expect(page.getByRole('region', { name: '선택 결과 분석' })).toHaveCount(0);
  await action.focus();
  await page.keyboard.press('Space');
  await analyzed(page);
  expect((await stored(page)).state.lines).toEqual(before.state.lines);
  expect((await stored(page)).config).toEqual(before.config);
});

for (const width of [320, 390]) {
  test.describe(`manual analysis at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true });
    test('opens through the card body with no horizontal overflow', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await scenario(page, 'cube');
      await roll(page, 3);
      await cardBody(page, true);
      const panel = await analyzed(page);
      const bounds = (await panel.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      for (const button of [
        page.locator('.candidate-analysis-button').first(),
        panel.getByRole('button', { name: '결과 분석 닫기' }),
      ]) {
        const box = (await button.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await mkdir('.cache/manual-analysis', { recursive: true });
      await page.screenshot({ path: `.cache/manual-analysis/cube-${width}.png`, fullPage: true });
      await panel.screenshot({ path: `.cache/manual-analysis/panel-${width}.png` });
    });
  });
}
