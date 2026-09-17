import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { CharacterSnapshot, OptionLine } from '../../src/types';
import { deserialize, type StoredSession } from '../../src/ui/storage';

const SHARED_API = 'https://fixture-api.example/api';
const SESSION_KEY = 'isekai-jikjak:session:v1';
const PRICE_KEY = 'isekai:ability-optimizer:prices:v1';
const bundled = JSON.parse(
  readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
) as CharacterSnapshot;
const ability = JSON.parse(
  readFileSync(new URL('../../public/rules/ability.json', import.meta.url), 'utf8'),
);

interface StrategyResult {
  id: string;
  name: string;
  status: string;
  totalCost: number;
  expectedMeso: number;
  expectedHonor: number;
  expectedCirculators: number;
  expectedResets: number;
}
interface OptimizerResult {
  bestStrategyId: string;
  strategies: StrategyResult[];
}

function line(type: string, best = false): OptionLine {
  const option = ability.grades.legendary.options.find(
    (row: { type: string }) => row.type === type,
  );
  const value = best ? option.values.at(-1) : option.values[0];
  return {
    id: option.id,
    abilityTypeId: option.id,
    type,
    value: value.value,
    text: value.label,
    unit: type.endsWith('Percent') ? 'percent' : 'flat',
    grade: 'legendary',
  };
}

function characterFixture(name: string, complete = false): CharacterSnapshot {
  const character = structuredClone(bundled);
  character.name = name;
  character.job = '나이트로드';
  character.imageUrl = 'http://127.0.0.1:4173/DobakSimulator/character/neutral.png';
  character.activeAbilityPreset = '3';
  character.abilityPresets['3'] = {
    grade: 'legendary',
    honor: 0,
    lines: [
      line('passiveSkillLevel'),
      line('bossDamagePercent', complete),
      line('criticalRatePercent', complete),
    ],
  };
  for (const equipment of Object.values(character.equipmentPresets))
    for (const item of equipment) item.imageUrl = character.imageUrl;
  return character;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: SHARED_API } }),
  );
  await page.route('https://open.api.nexon.com/maplestory/v1/**', (route) => route.abort());
  // Observe real worker replies without changing either their inputs or their results.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event) => {
          if (event.data?.result?.strategies)
            (window as unknown as { optimizerResult: unknown }).optimizerResult = event.data.result;
        });
      }
    };
  });
});

async function boot(page: Page, character?: CharacterSnapshot) {
  if (character)
    await page.route(`${SHARED_API}/character?*`, (route) => route.fulfill({ json: character }));
  await page.goto(
    `./${character ? `?character=${encodeURIComponent(character.name)}` : ''}#abilityOptimizer`,
  );
  await expect(
    page.getByRole('heading', { name: '어빌리티 최적의 방법 찾기', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: '시뮬레이터' }).getByRole('button'),
  ).toHaveCount(6);
  await expect(page.getByRole('button', { name: '어빌리티 최적화', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
}

async function targets(page: Page, types: string[]) {
  for (const [index, type] of types.entries())
    await page.getByLabel(`최적화 목표 ${'ABC'[index]}`, { exact: true }).selectOption(type);
}

async function prices(page: Page, medal: string, circulator: string) {
  await page.getByLabel('명예의 훈장 가격', { exact: true }).fill(medal);
  await page.getByLabel('심연의 서큘레이터 가격', { exact: true }).fill(circulator);
}

async function calculate(page: Page): Promise<OptimizerResult> {
  await page.evaluate(() => {
    delete (window as unknown as { optimizerResult?: unknown }).optimizerResult;
  });
  await page.getByRole('button', { name: '최적의 방법 계산', exact: true }).click();
  await expect(page.locator('.optimizer-comparison')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.optimizer-results')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.optimizer-results [role="alert"]')).toHaveCount(0);
  return page.evaluate(
    () => (window as unknown as { optimizerResult: OptimizerResult }).optimizerResult,
  );
}

async function readSession(page: Page) {
  return deserialize<StoredSession>(
    await page.evaluate((key) => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem(key)!;
    }, SESSION_KEY),
  );
}

test('fifth-tab deep links select the character job and active preset, validate prices and duplicate goals, and restore settings', async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByLabel('최적화 직업 프리셋', { exact: true })).toHaveValue('메카닉');
  await expect(page.getByLabel('최적화 어빌리티 프리셋', { exact: true })).toHaveValue(
    bundled.activeAbilityPreset,
  );
  await expect(page.getByLabel('최적화 재설정 실행 단위', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('최적화 목표 A', { exact: true })).toHaveValue('bossDamagePercent');
  await expect(page.getByLabel('최적화 목표 B', { exact: true })).toHaveValue(
    'statusAilmentDamagePercent',
  );
  await expect(page.getByLabel('최적화 목표 C', { exact: true })).toHaveValue('attackFlat');
  const calculateButton = page.getByRole('button', { name: '최적의 방법 계산', exact: true });
  await expect(calculateButton).toBeDisabled();
  await prices(page, '-1', '10000000');
  await expect(calculateButton).toBeDisabled();
  await prices(page, '500000', '1.5');
  await expect(calculateButton).toBeDisabled();
  await prices(page, '9007199254740992', '10000000');
  await expect(calculateButton).toBeDisabled();
  await prices(page, '500,000', '10,000,000');
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toHaveValue('500000');
  await expect(calculateButton).toBeEnabled();
  await page.getByLabel('최적화 목표 B', { exact: true }).selectOption('bossDamagePercent');
  await expect(page.locator('.optimizer-validation')).toContainText('서로 다른 옵션 세 개');
  await expect(calculateButton).toBeDisabled();
  await targets(page, ['passiveSkillLevel', 'bossDamagePercent', 'criticalRatePercent']);
  await page.getByLabel('최적화 재설정 실행 단위', { exact: true }).selectOption('1');
  await expect(page.getByLabel('최적화 직업 프리셋', { exact: true })).toHaveValue('');
  await expect(calculateButton).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).targetTypes,
        `isekai:ability-optimizer:settings:v1:${bundled.name}`,
      ),
    )
    .toEqual(['passiveSkillLevel', 'bossDamagePercent', 'criticalRatePercent']);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '어빌리티 최적의 방법 찾기', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#abilityOptimizer$/);
  await expect(page.getByLabel('최적화 목표 C', { exact: true })).toHaveValue(
    'criticalRatePercent',
  );
  await expect(page.getByLabel('최적화 직업 프리셋', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('최적화 재설정 실행 단위', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toHaveValue('500000');
  await expect(page.getByLabel('심연의 서큘레이터 가격', { exact: true })).toHaveValue('10000000');
  const workerRoute = '**/assets/ability-optimizer.worker-*.js';
  let pendingWorkers = 0;
  await page.route(workerRoute, (route) => {
    pendingWorkers++;
    return route.fulfill({
      contentType: 'application/javascript',
      body: 'self.onmessage = () => {};',
    });
  });
  await calculateButton.click();
  await expect.poll(() => pendingWorkers).toBe(1);
  await expect(page.locator('.optimizer-results')).toHaveAttribute('aria-busy', 'true');
  await page.getByRole('button', { name: '계산 중지', exact: true }).click();
  await expect(page.locator('.optimizer-results')).toHaveAttribute('aria-busy', 'false');
  await expect(calculateButton).toBeEnabled();
  await expect(page.locator('.optimizer-comparison')).toHaveCount(0);
  await page.unroute(workerRoute);
});

test('real worker results include every cost and rerank after the circulator price changes', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await boot(page, characterFixture('전략계산테스트'));
  await expect(page.getByLabel('최적화 어빌리티 프리셋', { exact: true })).toHaveValue('3');
  await targets(page, ['passiveSkillLevel', 'bossDamagePercent', 'criticalRatePercent']);
  await prices(page, '500000', '1');
  const cheap = await calculate(page);
  expect(cheap.strategies.length).toBeGreaterThan(3);
  const cheapBest = cheap.strategies.find((strategy) => strategy.id === cheap.bestStrategyId)!;
  expect(cheapBest.expectedCirculators).toBeGreaterThan(0);
  for (const strategy of cheap.strategies.filter((row) => Number.isFinite(row.totalCost))) {
    const sum =
      strategy.expectedMeso +
      (strategy.expectedHonor / 5000) * 500000 +
      strategy.expectedCirculators;
    expect(Math.abs(strategy.totalCost - sum)).toBeLessThan(Math.max(1e-6, sum * 1e-10));
  }
  await expect(page.locator('.optimizer-best h3')).toHaveText(cheapBest.name);
  await expect(page.locator('.optimizer-best .optimizer-breakdown dt')).toHaveText([
    '재설정 메소',
    '명성치 환산',
    '서큘레이터',
  ]);
  await expect(page.locator('.optimizer-strategy').first()).toHaveClass(/best/);
  await prices(page, '500000', '1000000000000000');
  await expect(page.locator('.optimizer-best')).toHaveCount(0);
  await expect(page.locator('.optimizer-comparison')).toHaveCount(0);
  const expensive = await calculate(page);
  const expensiveBest = expensive.strategies.find(
    (strategy) => strategy.id === expensive.bestStrategyId,
  )!;
  expect(expensiveBest.expectedCirculators).toBe(0);
  expect(expensive.bestStrategyId).not.toBe(cheap.bestStrategyId);
  await expect(page.locator('.optimizer-best h3')).toHaveText(expensiveBest.name);
  await page
    .getByLabel('최적화 목표 C', { exact: true })
    .selectOption('statusAilmentDamagePercent');
  await expect(page.locator('.optimizer-comparison')).toHaveCount(0);
  await page.getByLabel('최적화 어빌리티 프리셋', { exact: true }).selectOption('1');
  await expect(page.locator('.optimizer-best')).toHaveCount(0);
});

test('visiting, refreshing and leaving the optimizer preserves a paid simulator challenge', async ({
  page,
}) => {
  await page.goto('./#soulAmplification');
  await expect(page.getByRole('button', { name: '증폭 시도하기', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '증폭 시도하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  const before = await readSession(page);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '어빌리티 최적화', exact: true })
    .click();
  await expect(page).toHaveURL(/#abilityOptimizer$/);
  await expect(
    page.getByRole('heading', { name: '어빌리티 최적의 방법 찾기', exact: true }),
  ).toBeVisible();
  await prices(page, '1000', '100000');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '어빌리티 최적의 방법 찾기', exact: true }),
  ).toBeVisible();
  const during = await readSession(page);
  expect(during.config).toEqual(before.config);
  expect(during.state.spent).toEqual(before.state.spent);
  expect(during.state.attempts).toBe(before.state.attempts);
  await page
    .getByRole('navigation')
    .getByRole('button', { name: '소울 증폭', exact: true })
    .click();
  await expect(page).toHaveURL(/#soulAmplification$/);
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  const after = await readSession(page);
  expect(after.state.spent).toEqual(before.state.spent);
  expect(after.state.stage).toBe(before.state.stage);
  expect(after.state.failures).toBe(before.state.failures);
  expect(after.state.history).toEqual(before.state.history);
  await page.goto('./');
  await expect(
    page.getByRole('navigation').getByRole('button', { name: '소울 증폭', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  const restored = await readSession(page);
  expect(restored.config).toEqual(before.config);
  expect(restored.state.spent).toEqual(before.state.spent);
  expect(restored.state.history).toEqual(before.state.history);
});

test('character search keeps the optimizer tab and prices while importing the new job and active ability preset', async ({
  page,
}) => {
  await boot(page);
  await prices(page, '700000', '20000000');
  const character = characterFixture('최적화비숍');
  character.job = '비숍';
  character.profile = { mainStats: ['int'], secondaryStats: ['luk'], attackType: 'magicAttack' };
  character.activeAbilityPreset = '2';
  let requests = 0;
  await page.route(`${SHARED_API}/character?*`, (route) => {
    requests++;
    return route.fulfill({ json: character });
  });
  await page.getByRole('button', { name: '캐릭터 검색 열기', exact: true }).click();
  await page.getByLabel('캐릭터 닉네임', { exact: true }).fill(character.name);
  await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: '어빌리티 최적의 방법 찾기', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('최적화 직업 프리셋', { exact: true })).toHaveValue('비숍');
  await expect(page.getByLabel('최적화 어빌리티 프리셋', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('최적화 목표 C', { exact: true })).toHaveValue('magicAttackFlat');
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toHaveValue('700000');
  await expect(page.getByLabel('심연의 서큘레이터 가격', { exact: true })).toHaveValue('20000000');
  expect(new URL(page.url()).searchParams.get('character')).toBe(character.name);
  expect(new URL(page.url()).hash).toBe('#abilityOptimizer');
  await page.reload();
  await expect(page.getByLabel('최적화 어빌리티 프리셋', { exact: true })).toHaveValue('2');
  expect(requests).toBe(1);
});

test('already complete results and all six tabs remain readable at 360px in both themes', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 900 });
  await boot(page, characterFixture('완성어빌테스트', true));
  await targets(page, ['passiveSkillLevel', 'bossDamagePercent', 'criticalRatePercent']);
  await prices(page, '0', '0');
  const result = await calculate(page);
  expect(
    result.strategies.every(
      (strategy) => strategy.status === 'already' && strategy.totalCost === 0,
    ),
  ).toBe(true);
  await expect(page.locator('.optimizer-total')).toHaveText('0 메소');
  for (const theme of ['dark', 'light']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page
        .getByRole('button', { name: theme === 'dark' ? '어두운 테마' : '밝은 테마', exact: true })
        .click();
    await expect(page.getByRole('button', { name: '어빌리티 최적화', exact: true })).toBeVisible();
    await expect(page.getByLabel('최적화 목표 A', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    const bounds = (await page.locator('.optimizer-best').boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  }
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), PRICE_KEY)).toEqual({
    medal: '0',
    circulator: '0',
  });
});
