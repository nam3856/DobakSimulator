import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { selectSimulator } from './helpers/navigation';
import {
  quoteStarforce,
  rollStarforce,
  type StarforceRules,
  type StarforceState,
} from '../../src/engine/starforce';
import type { StarforceRunRequest, StarforceRunResponse } from '../../src/engine/starforce-runner';
import { formatAmount } from '../../src/ui/format';

const rules = JSON.parse(
  readFileSync(new URL('../../public/rules/starforce.json', import.meta.url), 'utf8'),
) as StarforceRules;
type Run = Extract<StarforceRunRequest, { type: 'run' }>;
interface Observed {
  runRequests: StarforceRunRequest[];
  runResponses: StarforceRunResponse[];
  runTerminations: number;
  releaseRunTerminals: (() => void)[];
  storageWrites: string[];
}

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  await page.addInitScript(() => {
    const observed = window as unknown as Observed;
    observed.runRequests = [];
    observed.runResponses = [];
    observed.runTerminations = 0;
    observed.releaseRunTerminals = [];
    observed.storageWrites = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === localStorage && key.startsWith('isekai:starforce:'))
        observed.storageWrites.push(key);
      setItem.call(this, key, value);
    };
    crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint32Array).fill(0);
      return array;
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private readonly isRunWorker: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.isRunWorker = String(url).includes('starforce-run.worker-');
        if (this.isRunWorker) {
          // Keep the real Worker and all progress messages. Hold only its final
          // acknowledgement until the test has inspected the transitional UI.
          let released = false;
          const pending: StarforceRunResponse[] = [];
          this.addEventListener('message', (event) => {
            const response = event.data as StarforceRunResponse;
            if (!released && response.type === 'state' && response.done) {
              pending.push(response);
              event.stopImmediatePropagation();
            }
          });
          observed.releaseRunTerminals.push(() => {
            released = true;
            for (const response of pending.splice(0))
              this.dispatchEvent(new MessageEvent('message', { data: response }));
          });
          this.addEventListener('message', ({ data }) => observed.runResponses.push(data));
        }
      }
      postMessage(message: unknown) {
        if (this.isRunWorker)
          observed.runRequests.push(structuredClone(message) as StarforceRunRequest);
        super.postMessage(message);
      }
      terminate() {
        if (this.isRunWorker) observed.runTerminations++;
        super.terminate();
      }
    };
  });
  const time = new Date('2026-09-18T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
});

async function expectNoSavedProgress(page: Page) {
  expect(
    await page.evaluate(() => ({
      writes: (window as unknown as Observed).storageWrites,
      keys: Object.keys(localStorage).filter((key) => key.startsWith('isekai:starforce:')),
    })),
  ).toEqual({ writes: [], keys: [] });
}
async function expectVisibleState(page: Page, state: StarforceState, target: number) {
  await expect(page.locator('.sf-stats .stat-card').first().locator('strong')).toHaveText(
    `${formatAmount(state.attempts)}회`,
  );
  await expect(page.locator('.sf-stats .spent-stat strong')).toHaveText(
    `${formatAmount(state.spentMeso)}메소`,
  );
  await expect(page.locator('.sf-stars')).toHaveAttribute(
    'aria-label',
    `현재 ${state.stars}성 / 목표 ${target}성`,
  );
  await expect(page.locator('.resource-ledger b')).toHaveText([
    `${formatAmount(state.enhancementMeso)} 메소`,
    `${formatAmount(state.restorationMeso)} 메소`,
    `${formatAmount(state.replacementMeso)} 메소`,
  ]);
  await expect(page.locator('.history-panel summary')).toHaveText(
    `강화 기록 · 최근 ${state.history.length}회`,
  );
  await expect(page.locator('.sf-history > div > span:first-child')).toHaveText(
    [...state.history].reverse().map((row) => `${row.sequence}회 · ${row.fromStars}성`),
  );
}
async function lastWorkerState(page: Page, terminal = false): Promise<StarforceState> {
  const response = await page.evaluate(
    (terminal) =>
      (window as unknown as Observed).runResponses
        .filter((row) => row.type === 'state' && (!terminal || row.done))
        .at(-1),
    terminal,
  );
  if (response?.type !== 'state') throw new Error('Missing Worker state');
  return response.state;
}
async function boot(page: Page, target = 3) {
  await page.goto('./#starforce');
  await expect(
    page.getByRole('heading', { name: '스타포스 시뮬레이터', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.sf-stats .expected-stat')).not.toContainText('계산 중');
  const initialStars = await page.locator('.sf-stars').getAttribute('aria-label');
  await page.getByRole('combobox', { name: '스타포스 장비', exact: true }).selectOption('manual');
  await page.getByRole('combobox', { name: '시작 스타포스', exact: true }).selectOption('0');
  await page
    .getByRole('combobox', { name: '목표 스타포스', exact: true })
    .selectOption(String(target));
  await expect(page.getByRole('button', { name: '자동 강화', exact: true })).toBeEnabled();
  return initialStars!;
}
async function runRequest(page: Page): Promise<Run> {
  return page.evaluate(
    () => (window as unknown as Observed).runRequests.find((row) => row.type === 'run') as Run,
  );
}
async function releaseTerminal(page: Page) {
  await page.evaluate(() => (window as unknown as Observed).releaseRunTerminals.at(-1)!());
}
async function deterministicWorker(page: Page, random: number) {
  await page.route('**/assets/starforce-run.worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `
      self.crypto.getRandomValues = array => { array.fill(${Math.floor(random * 4294967296)}); return array; };
      ${await response.text()}
    `,
    });
  });
}

for (const phase of ['charging', 'result'] as const) {
  test(`skipping during ${phase} runs the real engine once per paid attempt and retries with normal animation`, async ({
    page,
  }) => {
    await deterministicWorker(page, 0);
    await boot(page);
    await page.getByRole('button', { name: '자동 강화', exact: true }).click();
    await page.clock.fastForward(phase === 'charging' ? 100 : 150);
    await expect(page.locator('.sf-stage')).toHaveClass(new RegExp(`phase-${phase}`));
    await page.getByRole('button', { name: '연출 스킵', exact: true }).click();
    await expect(page.getByRole('button', { name: '연출 스킵 중', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '중단', exact: true })).toBeEnabled();
    await releaseTerminal(page);
    await expect(page.getByRole('button', { name: '다시 자동 강화', exact: true })).toBeEnabled();
    const request = await runRequest(page);
    expect(request.state.attempts).toBe(phase === 'charging' ? 0n : 1n);
    const completed = await lastWorkerState(page, true);
    expect(completed.status).toBe('success');
    expect(completed.attempts).toBe(3n);
    expect(completed.history.map((row) => row.fromStars)).toEqual([0, 1, 2]);
    expect(completed.history.map((row) => row.sequence)).toEqual([1n, 2n, 3n]);
    const expectedCost = [0, 1, 2].reduce(
      (sum, stars) => sum + quoteStarforce(rules, request.config, { stars }).cost,
      0n,
    );
    expect(completed.spentMeso).toBe(expectedCost);
    expect(completed.enhancementMeso).toBe(expectedCost);
    await expectVisibleState(page, completed, request.config.targetStars);
    await page.clock.fastForward(10_000);
    await expectVisibleState(page, completed, request.config.targetStars);
    await page.getByRole('button', { name: '다시 자동 강화', exact: true }).click();
    await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
    await expect(page.getByRole('button', { name: '연출 스킵', exact: true })).toBeEnabled();
    const attempts = page.locator('.sf-stats .stat-card').first().locator('strong');
    await expect(attempts).toHaveText('0회');
    await page.clock.fastForward(149);
    await expect(attempts).toHaveText('0회');
    await page.clock.fastForward(1);
    await expect(attempts).toHaveText('1회');
    await expect(page.locator('.sf-stars')).toHaveAttribute('aria-label', '현재 1성 / 목표 3성');
    await page.getByRole('button', { name: '중단', exact: true }).click();
    await expectNoSavedProgress(page);
  });
}

test('stopping a real skipped run waits for its final paid snapshot and resumes ordinary animation', async ({
  page,
}) => {
  const slow = structuredClone(rules);
  slow.transitions[0] = {
    ...slow.transitions[0],
    successProbability: 0.000001,
    maintainProbability: 0.999999,
  };
  await page.route('**/rules/starforce.json', (route) => route.fulfill({ json: slow }));
  await deterministicWorker(page, 0.5);
  await boot(page);
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.getByRole('button', { name: '연출 스킵', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as Observed).runResponses.some(
          (row) => row.type === 'state' && row.state.attempts > 0n,
        ),
      ),
    )
    .toBe(true);
  const observedBeforeStop = await lastWorkerState(page);
  await page.getByRole('button', { name: '중단', exact: true }).click();
  await expect(page.getByRole('button', { name: '중단 중', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '연출 스킵 중', exact: true })).toBeDisabled();
  await releaseTerminal(page);
  await expect(page.getByRole('button', { name: '자동 강화', exact: true })).toBeEnabled();
  const request = await runRequest(page);
  const paused = await lastWorkerState(page, true);
  expect(paused.attempts).toBeGreaterThanOrEqual(observedBeforeStop.attempts);
  expect(paused.spentMeso).toBe(
    paused.attempts * quoteStarforce(slow, request.config, { stars: 0 }).cost,
  );
  expect(paused.history).toHaveLength(100);
  expect(paused.history.at(-1)?.sequence).toBe(paused.attempts);
  await expectVisibleState(page, paused, request.config.targetStars);
  await page.clock.fastForward(10_000);
  await expectVisibleState(page, paused, request.config.targetStars);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Observed).runTerminations))
    .toBe(1);
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await expect(page.locator('.sf-stage')).toHaveClass(/phase-charging/);
  await page.clock.fastForward(149);
  await expectVisibleState(page, paused, request.config.targetStars);
  await page.clock.fastForward(1);
  const resumed = rollStarforce(slow, request.config, paused, () => 0).state;
  expect(resumed.attempts).toBe(paused.attempts + 1n);
  expect(resumed.stars).toBe(1);
  await expectVisibleState(page, resumed, request.config.targetStars);
  await page.getByRole('button', { name: '중단', exact: true }).click();
  await expectNoSavedProgress(page);
});

for (const departure of ['tab', 'pagehide'] as const) {
  test(`${departure} stops a skipped run, rejects queued stale callbacks and never saves progress`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      const controls = window as unknown as {
        controlledRuns: {
          request?: Run;
          onmessage: ((event: MessageEvent<StarforceRunResponse>) => void) | null;
          staleHandler?: ((event: MessageEvent<StarforceRunResponse>) => void) | null;
          terminated: boolean;
        }[];
      };
      controls.controlledRuns = [];
      window.Worker = function (url: string | URL, options?: WorkerOptions) {
        if (!String(url).includes('starforce-run.worker-')) return new NativeWorker(url, options);
        const fake = {
          onmessage: null as ((event: MessageEvent<StarforceRunResponse>) => void) | null,
          onerror: null,
          staleHandler: null as ((event: MessageEvent<StarforceRunResponse>) => void) | null,
          terminated: false,
          request: undefined as Run | undefined,
          addEventListener() {},
          removeEventListener() {},
          postMessage(message: StarforceRunRequest) {
            if (message.type === 'run') {
              this.request = message;
              this.staleHandler = this.onmessage;
            }
          },
          terminate() {
            this.terminated = true;
          },
        };
        controls.controlledRuns.push(fake);
        return fake as unknown as Worker;
      } as unknown as typeof Worker;
    });
    const initialStars = await boot(page, 5);
    await page.getByRole('button', { name: '자동 강화', exact: true }).click();
    await page.getByRole('button', { name: '연출 스킵', exact: true }).click();
    const request = await page.evaluate(
      () => (window as unknown as { controlledRuns: { request: Run }[] }).controlledRuns[0].request,
    );
    const progressed = rollStarforce(request.rules, request.config, request.state, () => 0).state;
    await page.evaluate(
      ({ id, state }) => {
        const worker = (
          window as unknown as { controlledRuns: { onmessage: (event: MessageEvent) => void }[] }
        ).controlledRuns[0];
        worker.onmessage(
          new MessageEvent('message', { data: { type: 'state', id, state, done: false } }),
        );
      },
      { id: request.id, state: progressed },
    );
    await expectVisibleState(page, progressed, request.config.targetStars);
    await expectNoSavedProgress(page);
    if (departure === 'tab') await selectSimulator(page, '큐브');
    else await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { controlledRuns: { terminated: boolean }[] }).controlledRuns[0]
            .terminated,
      ),
    ).toBe(true);
    let completed = progressed;
    while (completed.status !== 'success')
      completed = rollStarforce(request.rules, request.config, completed, () => 0).state;
    // A message callback already queued before terminate must still be rejected by the run identity.
    await page.evaluate(
      ({ id, state }) => {
        const worker = (
          window as unknown as { controlledRuns: { staleHandler: (event: MessageEvent) => void }[] }
        ).controlledRuns[0];
        worker.staleHandler(
          new MessageEvent('message', { data: { type: 'state', id, state, done: true } }),
        );
      },
      { id: request.id, state: completed },
    );
    await page.clock.fastForward(10_000);
    await expectNoSavedProgress(page);
    if (departure === 'tab') {
      await selectSimulator(page, '스타포스');
      await expect(page.locator('.sf-stats .stat-card').first().locator('strong')).toHaveText(
        '0회',
      );
      await expect(page.locator('.sf-stars')).toHaveAttribute('aria-label', initialStars);
      await expect(page.locator('.history-panel summary')).toHaveText('강화 기록 · 최근 0회');
    } else {
      await expectVisibleState(page, progressed, request.config.targetStars);
    }
    await expect(page.getByRole('button', { name: '자동 강화', exact: true })).toBeEnabled();
    await expectNoSavedProgress(page);
    await page.reload();
    await expect(page.getByRole('button', { name: '자동 강화', exact: true })).toBeEnabled();
    await page.clock.fastForward(10_000);
    await expect(page.locator('.sf-stats .stat-card').first().locator('strong')).toHaveText('0회');
    await expect(page.locator('.sf-stats .spent-stat strong')).toHaveText('0메소');
    await expect(page.locator('.sf-stars')).toHaveAttribute('aria-label', initialStars);
    await expect(page.locator('.history-panel summary')).toHaveText('강화 기록 · 최근 0회');
    await expect(page.getByRole('button', { name: '연출 스킵 중', exact: true })).toHaveCount(0);
    await expectNoSavedProgress(page);
  });
}
