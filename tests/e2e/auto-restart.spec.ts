import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { abilityConfigForState } from '../../src/engine/ability-strategy';
import { eligibleCandidates, type RuleData } from '../../src/engine/rules';
import { prepareDraw, rollBatch } from '../../src/engine/simulation';
import { deserialize, type StoredSession } from '../../src/ui/storage';
import type { SimulationConfig, SimulationState, WorkerRequest } from '../../src/types';

type RunRequest = Extract<WorkerRequest, { type: 'run' }>;
const readRule = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../public/rules/${name}.json`, import.meta.url), 'utf8'));
const data: RuleData = {
  potential: readRule('potential'),
  additional: readRule('additional-potential'),
  gold: readRule('gold'),
  ability: readRule('ability'),
  soul: readRule('soul'),
};

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  // Observe the real Worker request, including the brief zero-cost state before a fast win.
  await page.addInitScript(() => {
    const observed = window as unknown as { runRequests: unknown[] };
    observed.runRequests = [];
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message) {
      if (message?.type === 'run') observed.runRequests.push(structuredClone(message));
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

async function runs(page: Page): Promise<RunRequest[]> {
  return deserialize<RunRequest[]>(
    await page.evaluate(() =>
      JSON.stringify(
        (window as unknown as { runRequests: unknown[] }).runRequests,
        (_key, value) => (typeof value === 'bigint' ? { $bigint: value.toString() } : value),
      ),
    ),
  );
}

async function archives(page: Page) {
  return deserialize<{ config: SimulationConfig; state: SimulationState }[]>(
    await page.evaluate(() => localStorage.getItem('isekai-jikjak:archive:v1') ?? '[]'),
  );
}

async function ready(page: Page) {
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중', { timeout: 30000 });
}

async function boot(page: Page, mode: string) {
  await page.goto(`./#${mode}`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toBeVisible();
  await ready(page);
}

/** Change only the run RNG; probabilities, selection, accounting and the Worker stay real. */
async function forceWorkerRandom(page: Page, values: number[], fallback = 0) {
  await page.route('**/assets/simulator.worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `const forcedDraws = ${JSON.stringify(values)};
        self.crypto.getRandomValues = array => {
          array.fill(Math.floor((forcedDraws.shift() ?? ${fallback}) * 4294967296));
          return array;
        };\n${await response.text()}`,
    });
  });
}

function maximum(type: string) {
  const option = data.ability.grades.legendary!.options.find((row) => row.type === type)!;
  return option.values.reduce((best, row) => (row.value > best.value ? row : best));
}

async function abilityStart(page: Page, types: string[]) {
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await page.getByLabel('어빌리티 목표 줄 수').selectOption('2');
  for (const [slot, type] of types.entries())
    await page.getByLabel(`${slot + 1}번째 시작 옵션`).selectOption({
      label: `[레전드리] ${maximum(type).label}`,
    });
  await ready(page);
}

function abilityDraws(config: SimulationConfig, initial: SimulationState, batches: string[][]) {
  let state = initial;
  const samples: number[] = [];
  for (const types of batches) {
    const prepared = prepareDraw(
      data,
      abilityConfigForState(config, state),
      state.grade,
      state.lines,
    );
    const prefix = [...prepared.fixed.values()];
    const draw: number[] = [];
    for (let slot = 0; slot < 3; slot++) {
      if (prepared.fixed.has(slot)) continue;
      const rows = eligibleCandidates(prepared.candidates[slot], prefix);
      const index = rows.findIndex(
        (row) =>
          row.line.type === types[slot] &&
          row.line.grade === 'legendary' &&
          row.line.value === maximum(types[slot]).value,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      draw.push(
        (rows.slice(0, index).reduce((sum, row) => sum + row.probability, 0) +
          rows[index].probability / 2) /
          rows.reduce((sum, row) => sum + row.probability, 0),
      );
      prefix.push(rows[index]);
    }
    const batch = Array.from({ length: config.batchSize }, () => draw).flat();
    samples.push(...batch);
    let index = 0;
    state = rollBatch(data, config, state, () => batch[index++]);
  }
  expect(state.status).toBe('success');
  return samples;
}

test('completed amplification restarts immediately, resets costs, archives results and survives reload', async ({
  page,
}) => {
  await forceWorkerRandom(page, []);
  await boot(page, 'soulAmplification');
  const initial = await stored(page);
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect(page.getByRole('button', { name: '다시 자동재설정', exact: true })).toBeEnabled();
  const first = await stored(page);
  expect(first.state.status).toBe('success');
  expect(first.state.attempts).toBe(BigInt(4 - initial.config.start.stage));
  expect(first.state.spent.meso).toBeGreaterThan(0n);

  for (const reload of [false, true]) {
    if (reload) await page.reload();
    const runCount = (await runs(page)).length;
    await page.getByRole('button', { name: '다시 자동재설정', exact: true }).click();
    await expect.poll(async () => (await runs(page)).length).toBe(runCount + 1);
    await expect(page.getByRole('button', { name: '다시 자동재설정', exact: true })).toBeEnabled();
    const restarted = (await runs(page)).at(-1)!;
    expect(restarted.config).toEqual(initial.config);
    expect(restarted.state.attempts).toBe(0n);
    expect(restarted.state.spent).toEqual(initial.state.spent);
    expect(restarted.state.stage).toBe(initial.config.start.stage);
    expect(restarted.state.failures).toBe(initial.config.start.failures);
    const completed = await stored(page);
    expect(completed.state.status).toBe('success');
    expect(completed.state.attempts).toBe(first.state.attempts);
    expect(completed.state.spent).toEqual(first.state.spent);
    const saved = await archives(page);
    expect(saved).toHaveLength(reload ? 2 : 1);
    expect(saved[0].config).toEqual(first.config);
    expect(saved[0].state.status).toBe('success');
    expect(saved[0].state.spent).toEqual(first.state.spent);
  }
});

for (const strategy of ['lowerFirst', 'firstLocked'] as const)
  test(`ability ${strategy} retry returns to the original locks and pays both phases again`, async ({
    page,
  }) => {
    await boot(page, 'ability');
    const firstLocked = strategy === 'firstLocked';
    await abilityStart(page, [
      firstLocked ? 'passiveSkillLevel' : 'attackFlat',
      'strFlat',
      'dexFlat',
    ]);
    if (firstLocked) {
      await page.getByLabel('어빌리티 목표 줄 수').selectOption('3');
      await page.getByLabel('어빌리티 진행 방식').selectOption('firstLocked');
      await ready(page);
    }
    const initial = await stored(page);
    const initialLocks = firstLocked ? [0] : [];
    expect(initial.state.lockedSlots).toEqual(initialLocks);
    await forceWorkerRandom(
      page,
      abilityDraws(initial.config, initial.state, [
        [firstLocked ? 'passiveSkillLevel' : 'attackFlat', 'bossDamagePercent', 'dexFlat'],
        [
          'passiveSkillLevel',
          'bossDamagePercent',
          firstLocked ? 'statusAilmentDamagePercent' : 'intFlat',
        ],
      ]),
    );
    const mean = (await page.locator('.expected-stat strong').textContent())!;
    await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
    await expect(page.getByRole('button', { name: '다시 자동재설정', exact: true })).toBeEnabled();
    const first = await stored(page);
    expect(first.state.lockedSlots).toEqual(firstLocked ? [0, 1] : [1]);
    expect(first.state.attempts).toBe(6n);
    expect(first.state.spent.meso).toBe(firstLocked ? 63000000n : 24000000n);
    await page.getByRole('button', { name: '다시 자동재설정', exact: true }).click();
    await expect.poll(async () => (await runs(page)).length).toBe(2);
    await expect(page.getByRole('button', { name: '다시 자동재설정', exact: true })).toBeEnabled();
    const restarted = (await runs(page))[1];
    expect(restarted.config).toEqual(initial.config);
    expect(restarted.state.lines).toEqual(initial.state.lines);
    expect(restarted.state.lockedSlots).toEqual(initialLocks);
    expect(restarted.state.attempts).toBe(0n);
    expect(restarted.state.spent).toEqual(initial.state.spent);
    const second = await stored(page);
    expect(second.state.status).toBe('success');
    expect(second.state.attempts).toBe(6n);
    expect(second.state.spent).toEqual(first.state.spent);
    expect(second.state.spent.honor).toBe(firstLocked ? 210000n : 150000n);
    expect(second.state.history[0].sequence).toBe(1n);
    await ready(page);
    await expect(page.locator('.expected-stat strong')).toHaveText(mean);
    const saved = await archives(page);
    expect(saved).toHaveLength(1);
    expect(saved[0].state).toEqual(first.state);
  });

test('paused automation resumes its costs and attempts instead of creating a new challenge', async ({
  page,
}) => {
  await forceWorkerRandom(page, []);
  await boot(page, 'ability');
  await abilityStart(page, ['attackFlat', 'bossDamagePercent', 'dexFlat']);
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.attempts).toBeGreaterThan(0n);
  await page.getByRole('button', { name: '중지', exact: true }).click();
  await expect(page.getByRole('button', { name: '자동 재설정', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '다시 자동재설정', exact: true })).toHaveCount(0);
  const paused = await stored(page);
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect.poll(async () => (await runs(page)).length).toBe(2);
  await expect
    .poll(async () => (await stored(page)).state.attempts)
    .toBeGreaterThan(paused.state.attempts);
  await page.getByRole('button', { name: '중지', exact: true }).click();
  const resumed = (await runs(page))[1];
  expect(resumed.config).toEqual(paused.config);
  expect(resumed.state.attempts).toBe(paused.state.attempts);
  expect(resumed.state.spent).toEqual(paused.state.spent);
  const current = await stored(page);
  expect(current.state.spent.meso).toBeGreaterThan(paused.state.spent.meso);
  expect(await archives(page)).toHaveLength(0);
});

test('a free already-satisfied start does not offer an automatic retry', async ({ page }) => {
  await boot(page, 'cube');
  await expect(page.locator('.expected-stat')).toContainText('시작 상태가 이미 목표를 만족');
  const session = await stored(page);
  expect(session.state.attempts).toBe(0n);
  await expect(page.getByRole('button', { name: '다시 자동재설정', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '자동 재설정', exact: true })).toBeDisabled();
  expect(await runs(page)).toHaveLength(0);
});

for (const mode of ['cube', 'soulPotential'] as const)
  test(`${mode} retry preserves the original grade, options and failures after promotion and settings changes`, async ({
    page,
  }) => {
    await forceWorkerRandom(page, []);
    await boot(page, mode);
    await page.getByLabel('시작 등급', { exact: true }).selectOption('rare');
    await page.getByLabel('성공 기준', { exact: true }).selectOption('grade');
    await page.getByLabel('목표 등급', { exact: true }).selectOption('legendary');
    await page.getByRole('button', { name: '1회', exact: true }).click();
    await page.getByLabel('등급 상승 누적 실패', { exact: true }).fill('7');
    await ready(page);
    const original = await stored(page);
    expect(original.config.start.grade).toBe('rare');
    expect(original.config.start.failures).toBe(7);
    expect(original.config.start.lines).toHaveLength(3);

    // Fix the manual draw too: all rule, promotion, guarantee and cost logic stays real.
    await page.evaluate(() => {
      Object.defineProperty(globalThis.crypto, 'getRandomValues', {
        value: (values: Uint32Array) => {
          values.fill(0);
          return values;
        },
      });
    });
    await page.getByRole('button', { name: '1회 재설정하기', exact: true }).click();
    await expect.poll(async () => (await stored(page)).state.grade).toBe('epic');
    const promoted = await stored(page);
    expect(promoted.state.attempts).toBe(1n);
    expect(promoted.state.failures).toBe(0);
    expect(promoted.state.spent.meso).toBeGreaterThan(0n);

    // These edits intentionally make the current challenge start at the promoted state.
    // They must not replace the independently remembered origin used by "다시 자동재설정".
    await page.getByRole('button', { name: '3회 연속', exact: true }).click();
    await page.getByLabel('목표 등급', { exact: true }).selectOption('unique');
    await page.getByLabel('목표 등급', { exact: true }).selectOption('legendary');
    await page.getByRole('checkbox', { name: '미라클타임', exact: true }).check();
    await ready(page);
    const changed = await stored(page);
    expect(changed.config.start.grade).toBe('epic');
    expect(changed.config.start.lines).toEqual(promoted.state.lines);
    expect(changed.config.start.failures).toBe(0);
    expect(changed.config.retryStart).toEqual(original.config.start);
    expect(changed.state.spent).toEqual(original.state.spent);

    await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
    await expect(page.getByRole('button', { name: '다시 자동재설정', exact: true })).toBeEnabled();
    const completedFromEpic = await stored(page);
    expect(completedFromEpic.state.grade).toBe('legendary');
    expect(completedFromEpic.state.attempts).toBe(2n);
    const totalFromOrigin = promoted.state.spent.meso + completedFromEpic.state.spent.meso;
    let previousRetry: SimulationState | undefined;

    // A completed result becomes a zero-cost already-satisfied challenge on a batch edit.
    // Retry must remain available because the remembered origin still needs paid upgrades.
    await page.getByRole('button', { name: '1회', exact: true }).click();
    await expect(page.getByRole('button', { name: '다시 자동재설정', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '3회 비교', exact: true }).click();
    await expect(page.getByRole('button', { name: '다시 자동재설정', exact: true })).toBeEnabled();
    const completedAfterEdit = await stored(page);
    expect(completedAfterEdit.state.grade).toBe('legendary');
    expect(completedAfterEdit.state.attempts).toBe(0n);
    expect(completedAfterEdit.config.retryStart).toEqual(original.config.start);

    for (const reload of [false, true]) {
      if (reload) {
        await page.reload();
        await expect(
          page.getByRole('button', { name: '다시 자동재설정', exact: true }),
        ).toBeEnabled();
      }
      const runCount = (await runs(page)).length;
      await page.getByRole('button', { name: '다시 자동재설정', exact: true }).click();
      await expect.poll(async () => (await runs(page)).length).toBe(runCount + 1);
      await expect(
        page.getByRole('button', { name: '다시 자동재설정', exact: true }),
      ).toBeEnabled();
      const restarted = (await runs(page)).at(-1)!;
      expect(restarted.config.start).toEqual(original.config.start);
      expect(restarted.config.retryStart).toEqual(original.config.start);
      expect(restarted.config.batchSize).toBe(3);
      expect(restarted.config.miracleTime).toBe(true);
      expect(restarted.state.grade).toBe(original.config.start.grade);
      expect(restarted.state.lines).toEqual(original.config.start.lines);
      expect(restarted.state.stage).toBe(original.config.start.stage);
      expect(restarted.state.failures).toBe(7);
      expect(restarted.state.attempts).toBe(0n);
      expect(restarted.state.spent).toEqual(original.state.spent);
      expect(restarted.state.history).toEqual([]);
      const completed = await stored(page);
      expect(completed.state.status).toBe('success');
      expect(completed.state.attempts).toBe(3n);
      expect(completed.state.spent.meso).toBe(totalFromOrigin);
      if (previousRetry) expect(completed.state.spent).toEqual(previousRetry.spent);
      previousRetry = completed.state;
    }
  });
