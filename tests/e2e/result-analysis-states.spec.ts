import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { parsePotentialLine } from '../../src/character/potential';
import type {
  BenchmarkResult,
  CharacterSnapshot,
  ResourceCost,
  RollResult,
  SimulationConfig,
  WorkerRequest,
  WorkerResponse,
} from '../../src/types';
import { formatAmount } from '../../src/ui/format';
import { deserialize, serialize, type StoredSession } from '../../src/ui/storage';

type BenchmarkRequest = Extract<WorkerRequest, { type: 'benchmark' }>;
type Reply = { type: 'benchmark'; result: BenchmarkResult } | { type: 'error'; message: string };
interface ControlledWorker {
  request?: BenchmarkRequest;
  receive: ((event: MessageEvent<WorkerResponse>) => void) | null;
  terminated: boolean;
}
type Harness = { resultWorkers: ControlledWorker[] };

function savedScenario(): StoredSession {
  const character = JSON.parse(
    readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
  ) as CharacterSnapshot;
  character.bundledAvatars = true;
  const item = character.equipmentPresets[character.activeEquipmentPreset].find(
    (item) => item.category === 'weapon' && item.potential.length === 3,
  )!;
  const start = { grade: 'legendary' as const, lines: item.potential, stage: 1, failures: 0 };
  const config: SimulationConfig = {
    mode: 'cube',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start,
    retryStart: structuredClone(start),
    lockedSlots: [],
    batchSize: 3,
    // An incomplete automatic goal isolates the result-analysis worker from the main estimate.
    target: {
      mode: 'sum',
      minimumGrade: 'legendary',
      conditions: [],
      lines: [],
      stage: 1,
      match: 'all',
    },
    ruleVersion: 'kms-2026-09-17',
    unitPrices: {},
  };
  const cost: ResourceCost = {
    meso: 20000000n,
    honor: 0n,
    cubes: 0n,
    credits: 0n,
    ethers: [0n, 0n, 0n, 0n],
  };
  const candidates: RollResult[] = [
    ['공격력 : +9%', '최대 MP : +300', '방어력 : +100'],
    ['공격력 : +12%', '최대 MP : +300', '방어력 : +100'],
    ['최대 MP : +300', '방어력 : +100', '이동속도 : +10'],
  ].map((lines, index) => ({
    sequence: BigInt(index + 1),
    grade: 'legendary',
    lines: lines.map((line) => parsePotentialLine(line, 'legendary')),
    stage: 1,
    promoted: false,
    amplified: false,
    hit: false,
    cost: structuredClone(cost),
  }));
  return {
    version: 1,
    character,
    config,
    state: {
      ...start,
      attempts: 3n,
      spent: { ...cost, meso: 60000000n },
      status: 'paused',
      history: candidates,
      candidates,
      startedAt: '2026-09-23T00:00:00.000Z',
    },
    equipmentPreset: character.activeEquipmentPreset,
    abilityPreset: character.activeAbilityPreset,
    equipmentId: item.id,
    playMode: 'upgrade',
  };
}

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((session) => {
    // Restore once before React starts, so a departing page's pagehide flush cannot win.
    if (!sessionStorage.getItem('result-analysis-fixture-loaded')) {
      localStorage.setItem('isekai-jikjak:session:v1', session);
      sessionStorage.setItem('result-analysis-fixture-loaded', 'true');
    }
    const NativeWorker = window.Worker;
    const controls = window as unknown as Harness;
    controls.resultWorkers = [];
    window.Worker = function (url: string | URL, options?: WorkerOptions) {
      if (!String(url).includes('simulator.worker')) return new NativeWorker(url, options);
      const fake = {
        onmessage: null as ((event: MessageEvent<WorkerResponse>) => void) | null,
        onerror: null,
        onmessageerror: null,
        receive: null as ((event: MessageEvent<WorkerResponse>) => void) | null,
        request: undefined as BenchmarkRequest | undefined,
        terminated: false,
        postMessage(message: WorkerRequest) {
          if (message.type !== 'benchmark')
            throw new Error('Unexpected automatic run in analysis boundary test');
          this.request = structuredClone(message);
          this.receive = this.onmessage;
        },
        terminate() {
          this.terminated = true;
        },
      };
      controls.resultWorkers.push(fake);
      return fake as unknown as Worker;
    } as unknown as typeof Worker;
  }, serialize(savedScenario()));
  await page.goto('./#cube');
  await expect(page.locator('.candidate-card')).toHaveCount(3);
});

const panelFor = (page: Page) => page.getByRole('region', { name: '선택 결과 분석', exact: true });
const candidate = (page: Page, sequence: number) =>
  page.getByRole('button', {
    name: `재설정 ${sequence} 결과 기댓값과 행운 분석`,
    exact: true,
  });

async function select(page: Page, sequence: number, requestCount: number) {
  await candidate(page, sequence).click();
  const panel = panelFor(page);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-busy', 'true');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as Harness).resultWorkers.filter((worker) => worker.request).length,
      ),
    )
    .toBe(requestCount);
  return panel;
}

async function deliver(page: Page, index: number, reply: Reply) {
  await page.evaluate(
    ({ index, reply }) => {
      const worker = (window as unknown as Harness).resultWorkers[index];
      if (!worker?.request || !worker.receive) throw new Error('No pending result analysis');
      // Deliberately deliver even after terminate: a queued old callback must still be ignored.
      worker.receive(new MessageEvent('message', { data: { ...reply, id: worker.request.id } }));
    },
    { index, reply },
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

function benchmark(status: BenchmarkResult['status'], expectedCost = 900000000): BenchmarkResult {
  const already = status === 'already';
  const partial = status === 'partial';
  return {
    status,
    expectedCost: already ? 0 : partial ? Infinity : expectedCost,
    expectedAttempts: already ? 0 : partial ? Infinity : 45,
    successProbability: partial ? 0.6 : 1,
    unit: 'meso',
    method: 'analytic',
    sampleCount: 0,
    quantiles: { p10: 20000000, p50: 900000000, p90: 2000000000 },
    distribution: [],
    // A valid CDF must not make an already/partial result eligible for a luck rating.
    cdfAtActual: already ? 1 : 0.25,
  };
}

async function noLuck(panel: Locator) {
  await expect(panel.locator('.result-analysis-luck')).toHaveCount(0);
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
}

test('a result without useful metrics explains why and starts no analysis worker', async ({
  page,
}) => {
  const before = await page.evaluate(() => localStorage.getItem('isekai-jikjak:session:v1'));
  await candidate(page, 3).click();
  const panel = panelFor(page);
  await expect(panel.getByRole('status')).toHaveText(
    '이 직업을 기준으로 분석할 주요 옵션이 없어요.',
  );
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await noLuck(panel);
  await expect(panel.locator('.result-analysis-estimate')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Harness).resultWorkers.length)).toBe(0);
  const after = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    return localStorage.getItem('isekai-jikjak:session:v1')!;
  });
  const previous = deserialize<StoredSession>(before!);
  const current = deserialize<StoredSession>(after);
  expect(current.config.target).toEqual(previous.config.target);
  expect(current.state).toEqual(previous.state);
});

test('already and partial outcomes show their distinct reasons without a luck rating', async ({
  page,
}) => {
  const panel = await select(page, 1, 1);
  await deliver(page, 0, { type: 'benchmark', result: benchmark('already') });
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(panel.locator('.result-analysis-estimate strong')).toHaveText('0');
  await expect(panel).toContainText('시작 옵션이 이미 이 수치를 만족해요.');
  await noLuck(panel);

  await select(page, 2, 2);
  await expect(panel).not.toContainText('시작 옵션이 이미 이 수치를 만족해요.');
  await deliver(page, 1, { type: 'benchmark', result: benchmark('partial') });
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(panel.locator('.result-analysis-estimate strong')).toHaveText('무한대');
  await expect(panel).toContainText('등급 상승 후 이 수치에 도달할 수 없는 경로');
  await expect(panel).not.toContainText('계산 미완료');
  await noLuck(panel);
});

test('an analysis error clears the loading state and a fresh selection can recover', async ({
  page,
}) => {
  const panel = await select(page, 1, 1);
  await deliver(page, 0, { type: 'error', message: '테스트용 확률 데이터 응답 오류' });
  await expect(panel.getByRole('alert')).toHaveText('테스트용 확률 데이터 응답 오류');
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await noLuck(panel);
  await expect(panel.locator('.result-analysis-estimate')).toHaveCount(0);

  await select(page, 2, 2);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await deliver(page, 1, { type: 'benchmark', result: benchmark('ready') });
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(panel.locator('.result-analysis-luck')).toBeVisible();
});

test('a late first response cannot replace a newer candidate analysis', async ({ page }) => {
  const panel = await select(page, 1, 1);
  await select(page, 2, 2);
  expect(
    await page.evaluate(() => (window as unknown as Harness).resultWorkers[0].terminated),
  ).toBe(true);
  await deliver(page, 1, { type: 'benchmark', result: benchmark('ready', 900000000) });
  await expect(panel.locator('.result-analysis-estimate strong')).toHaveAttribute(
    'title',
    formatAmount(900000000, false),
  );
  await expect(panel.locator('.result-analysis-origin')).toContainText('#2 결과');

  await deliver(page, 0, { type: 'benchmark', result: benchmark('ready', 100000000) });
  await expect(panel.locator('.result-analysis-estimate strong')).toHaveAttribute(
    'title',
    formatAmount(900000000, false),
  );
  await expect(panel.locator('.result-analysis-origin')).toContainText('#2 결과');
  await expect(candidate(page, 1)).toHaveAttribute('aria-pressed', 'false');
  await expect(candidate(page, 2)).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('alert')).toHaveCount(0);
  const requests = await page.evaluate(() =>
    (window as unknown as Harness).resultWorkers.map((worker) => ({
      target: worker.request!.config.target,
      actualCost: worker.request!.actualCost,
    })),
  );
  expect(requests.map((request) => request.target.conditions)).toEqual([
    [{ type: 'attackPercent', minValue: 9 }],
    [{ type: 'attackPercent', minValue: 12 }],
  ]);
  expect(requests.map((request) => request.actualCost)).toEqual([60000000, 60000000]);
});
