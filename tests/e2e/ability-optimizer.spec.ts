import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { selectSimulator } from './helpers/navigation';
import type { CharacterSnapshot, OptionLine } from '../../src/types';
import type {
  AbilityOptimizerResult,
  AbilityOptimizerStrategyResult,
} from '../../src/engine/ability-optimizer';
import { formatAmount } from '../../src/ui/format';
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
const TARGETS = ['passiveSkillLevel', 'bossDamagePercent', 'criticalRatePercent'];

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
  character.bundledAvatars = false;
  character.fetchedAt = new Date().toISOString();
  character.imageUrl = 'http://127.0.0.1:4173/DobakSimulator/character/neutral.png';
  character.activeAbilityPreset = '3';
  character.abilityPresets['3'] = {
    grade: 'legendary',
    honor: 765432,
    lines: [
      line('passiveSkillLevel'),
      line('bossDamagePercent', complete),
      line('criticalRatePercent', complete),
    ],
  };
  character.abilityPresets['1'] = { ...character.abilityPresets['3'], honor: 123456 };
  for (const equipment of Object.values(character.equipmentPresets))
    for (const item of equipment) item.imageUrl = character.imageUrl;
  return character;
}

const wizard = (page: Page) => page.locator('.optimizer-wizard');
const nextButton = (page: Page) => wizard(page).getByRole('button', { name: '다음', exact: true });
async function atStep(page: Page, step: string) {
  await expect(wizard(page)).toHaveAttribute('data-step', step);
}
async function next(page: Page, step: string) {
  await nextButton(page).click();
  await atStep(page, step);
}
async function back(page: Page, step: string) {
  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await atStep(page, step);
}
async function start(page: Page) {
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await atStep(page, 'character');
}
async function boot(page: Page, character?: CharacterSnapshot) {
  if (character)
    await page.route(`${SHARED_API}/character?*`, (route) => route.fulfill({ json: character }));
  await page.goto(
    `./${character ? `?character=${encodeURIComponent(character.name)}` : ''}#abilityOptimizer`,
  );
  await atStep(page, 'intro');
  await expect(wizard(page).getByRole('button')).toHaveCount(1);
  await expect(
    wizard(page).getByRole('heading', { name: '내 어빌리티, 어떻게 완성할까요?', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.optimizer-intro-description')).toHaveText(
    '현재 옵션과 보유 명성치에 맞춰 강화 순서와 예상 추가비용을 비교해요.',
  );
  await expect(page.locator('.optimizer-intro-portrait img')).toHaveAttribute(
    'src',
    /character\/optimizer\/(kkangmini|kkangkun|rennae)\/walk-2\.png$/,
  );
  await expect(
    page
      .getByRole('list', { name: '어빌리티 최적화 진행 순서', exact: true })
      .getByRole('listitem'),
  ).toHaveCount(3);
  await expect(page.getByRole('button', { name: '어빌리티 최적화', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
}
async function targets(page: Page, types = TARGETS) {
  for (const [index, type] of types.entries())
    await page.getByLabel(`목표 옵션 ${index + 1}`, { exact: true }).selectOption(type);
  await expect(page.getByLabel(/^최적화 목표 [ABC]$/)).toHaveCount(0);
}
async function prices(page: Page, medal: string, circulator: string) {
  await page.getByLabel('명예의 훈장 가격', { exact: true }).fill(medal);
  await page.getByLabel('심연의 서큘레이터 가격', { exact: true }).fill(circulator);
}
async function manualLine(page: Page, slot: number, type: string, best = false) {
  await page
    .getByLabel(`${slot}번째 시작 옵션`, { exact: true })
    .selectOption({ label: `[레전드리] ${line(type, best).text}` });
}
async function chooseManual(page: Page) {
  await page.getByRole('button', { name: '직접 입력할게요', exact: true }).click();
  await manualLine(page, 1, 'passiveSkillLevel');
  await manualLine(page, 2, 'bossDamagePercent');
  await manualLine(page, 3, 'criticalRatePercent');
}
async function calculate(page: Page): Promise<AbilityOptimizerResult> {
  await page.evaluate(() => {
    delete (window as unknown as { optimizerResult?: unknown }).optimizerResult;
  });
  await page.getByRole('button', { name: '계산', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'result', { timeout: 60_000 });
  await expect(page.locator('.optimizer-comparison')).toBeVisible();
  await expect(wizard(page).getByRole('alert')).toHaveCount(0);
  return page.evaluate(
    () => (window as unknown as { optimizerResult: AbilityOptimizerResult }).optimizerResult,
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
async function noOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
  const bounds = (await wizard(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
}

function strategyMethod(strategy: AbilityOptimizerStrategyResult): string {
  return strategy.policy.kind === 'acquire'
    ? strategy.policy.timing
    : strategy.policy.kind === 'current-types'
      ? 'all'
      : 'keep-first';
}

async function groupedResults(page: Page, result: AbilityOptimizerResult) {
  const expected = new Map<string, AbilityOptimizerStrategyResult[]>();
  for (const strategy of result.strategies) {
    expect(strategy.policy).toBeDefined();
    if (strategy.policy.kind === 'acquire') {
      expect(strategy.policy.firstAcceptedTargets.length).toBeGreaterThan(0);
      expect(new Set(strategy.policy.firstAcceptedTargets).size).toBe(
        strategy.policy.firstAcceptedTargets.length,
      );
      for (const type of strategy.policy.firstAcceptedTargets) expect(TARGETS).toContain(type);
    }
    const method = strategyMethod(strategy);
    expected.set(method, [...(expected.get(method) ?? []), strategy]);
  }
  const methods = [...expected.keys()].sort((a, b) => {
    const aBest = Math.min(...expected.get(a)!.map((row) => row.totalCost));
    const bBest = Math.min(...expected.get(b)!.map((row) => row.totalCost));
    return aBest - bBest || a.localeCompare(b);
  });
  const groups = page.locator('details.optimizer-method-group');
  await expect(groups).toHaveCount(methods.length);
  expect(
    await groups.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-method'))),
  ).toEqual(methods);
  const seen: string[] = [];
  for (const [index, method] of methods.entries()) {
    const group = groups.nth(index);
    const variants = expected.get(method)!;
    const best = [...variants].sort(
      (a, b) => a.totalCost - b.totalCost || a.id.localeCompare(b.id),
    )[0];
    await expect(group).toHaveAttribute('data-best-strategy', best.id);
    await expect(group).not.toHaveAttribute('open');
    const summary = group.locator(':scope > .optimizer-method-summary');
    await expect(summary).toBeVisible();
    await expect(summary.locator(':scope > strong')).toHaveText(
      `최저 예상 추가비용${best.status === 'impossible' ? '달성 불가' : `${formatAmount(best.totalCost)} 메소`}`,
    );
    await expect(summary.locator('.optimizer-lock-condition')).not.toBeEmpty();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(group).toHaveAttribute('open');
    const details = group.locator('.optimizer-strategy-list > details.optimizer-strategy');
    await expect(details).toHaveCount(variants.length);
    const displayed = await details.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-strategy')!),
    );
    expect(displayed).toEqual(variants.map((row) => row.id));
    seen.push(...displayed);
    for (const detail of await details.all()) {
      await expect(detail.locator(':scope > summary')).toBeVisible();
      await expect(detail.locator(':scope > summary .optimizer-lock-condition')).not.toBeEmpty();
    }
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(group).not.toHaveAttribute('open');
  }
  expect(seen.sort()).toEqual(result.strategies.map((row) => row.id).sort());
  return methods;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: SHARED_API } }),
  );
  await page.route('https://open.api.nexon.com/maplestory/v1/**', (route) => route.abort());
  // Observe real worker messages without replacing the probability calculation.
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

test('bundled character starts blank, validates three manual lines, and preserves choices when going back', async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByLabel('최적화 캐릭터 닉네임', { exact: true })).toHaveCount(0);
  await start(page);
  await expect(page.getByLabel('최적화 캐릭터 닉네임', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('최적화 어빌리티 프리셋', { exact: true })).toBeDisabled();
  await expect(nextButton(page)).toBeDisabled();
  await page.getByRole('button', { name: '직접 입력할게요', exact: true }).click();
  await manualLine(page, 1, 'passiveSkillLevel');
  await manualLine(page, 3, 'criticalRatePercent');
  await expect(nextButton(page)).toBeDisabled();
  await manualLine(page, 2, 'passiveSkillLevel');
  await expect(page.locator('.optimizer-validation')).toContainText('서로 다른 종류');
  await expect(nextButton(page)).toBeDisabled();
  await manualLine(page, 2, 'bossDamagePercent');
  await next(page, 'target');
  await expect(page.getByLabel('최적화 직업 프리셋', { exact: true })).toHaveValue('메카닉');
  await targets(page);
  await page.getByLabel('목표 옵션 2', { exact: true }).selectOption('passiveSkillLevel');
  await expect(page.locator('.optimizer-validation')).toContainText('서로 다른 옵션 세 개');
  await expect(nextButton(page)).toBeDisabled();
  await targets(page);
  await next(page, 'prices');
  await expect(page.getByLabel('현재 보유 명성치', { exact: true })).toHaveValue('0');
  await prices(page, '12345', '67890');
  await page.getByLabel('현재 보유 명성치', { exact: true }).fill('10000');
  await back(page, 'target');
  await expect(page.getByLabel('목표 옵션 3', { exact: true })).toHaveValue('criticalRatePercent');
  await back(page, 'character');
  await expect(
    page.getByLabel('1번째 시작 옵션', { exact: true }).locator('option:checked'),
  ).toHaveText(`[레전드리] ${line('passiveSkillLevel').text}`);
  await expect(
    page.getByLabel('3번째 시작 옵션', { exact: true }).locator('option:checked'),
  ).toHaveText(`[레전드리] ${line('criticalRatePercent').text}`);
  await next(page, 'target');
  await next(page, 'prices');
  await expect(page.getByLabel('현재 보유 명성치', { exact: true })).toHaveValue('10000');
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toHaveValue('12345');
  await expect(page.getByLabel('심연의 서큘레이터 가격', { exact: true })).toHaveValue('67890');
});

test('deep-link lookup waits for start, imports honor, reuses fresh results, and supports explicit refresh', async ({
  page,
}) => {
  const character = characterFixture('시작후조회');
  const requests: string[] = [];
  await page.route(`${SHARED_API}/character?*`, (route) => {
    requests.push(route.request().url());
    return route.fulfill({ json: character });
  });
  await page.goto(`./?character=${encodeURIComponent(character.name)}#abilityOptimizer`);
  await atStep(page, 'intro');
  expect(requests).toHaveLength(0);
  await start(page);
  await expect(page.getByLabel('최적화 어빌리티 프리셋', { exact: true })).toHaveValue('3');
  await expect(nextButton(page)).toBeEnabled();
  expect(requests).toHaveLength(1);
  await expect(page.getByLabel('최적화 캐릭터 닉네임', { exact: true })).toHaveValue(
    character.name,
  );
  await next(page, 'target');
  await expect(page.getByLabel('최적화 직업 프리셋', { exact: true })).toHaveValue('나이트로드');
  await next(page, 'prices');
  await expect(page.getByLabel('현재 보유 명성치', { exact: true })).toHaveValue('765432');
  await back(page, 'target');
  await back(page, 'character');
  await page.getByLabel('최적화 어빌리티 프리셋', { exact: true }).selectOption('1');
  await next(page, 'target');
  await next(page, 'prices');
  await expect(page.getByLabel('현재 보유 명성치', { exact: true })).toHaveValue('123456');
  await back(page, 'target');
  await back(page, 'character');
  await page.getByRole('button', { name: '최적화 캐릭터 조회', exact: true }).click();
  await expect(nextButton(page)).toBeEnabled();
  expect(requests).toHaveLength(1);
  await page.getByRole('button', { name: '최신 정보로 조회', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(new URL(requests[1]).searchParams.get('refresh')).toBe('1');
  await expect(nextButton(page)).toBeEnabled();
  await page.reload();
  await atStep(page, 'intro');
  expect(requests).toHaveLength(2);
  await start(page);
  await expect(nextButton(page)).toBeEnabled();
  expect(requests).toHaveLength(2);
});

test('an already selected non-bundled character is prefilled without another lookup', async ({
  page,
}) => {
  const character = characterFixture('기존선택캐릭터');
  let requests = 0;
  await page.route(`${SHARED_API}/character?*`, (route) => {
    requests++;
    return route.fulfill({ json: character });
  });
  await page.goto(`./?character=${encodeURIComponent(character.name)}#cube`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기', exact: true })).toContainText(
    character.name,
  );
  expect(requests).toBe(1);
  await selectSimulator(page, '어빌리티 최적화');
  await atStep(page, 'intro');
  await start(page);
  await expect(page.getByLabel('최적화 캐릭터 닉네임', { exact: true })).toHaveValue(
    character.name,
  );
  await expect(page.getByLabel('최적화 어빌리티 프리셋', { exact: true })).toHaveValue('3');
  await expect(nextButton(page)).toBeEnabled();
  expect(requests).toBe(1);
});

test('prices and available honor validate independently, with persisted prices and optional batch settings', async ({
  page,
}) => {
  await boot(page);
  await start(page);
  await chooseManual(page);
  await next(page, 'target');
  await next(page, 'prices');
  const submit = page.getByRole('button', { name: '계산', exact: true });
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toHaveValue('4000000');
  await expect(page.getByLabel('심연의 서큘레이터 가격', { exact: true })).toHaveValue('200000000');
  for (const value of ['', '-1', '1.5', '1000000000']) {
    await page.getByLabel('현재 보유 명성치', { exact: true }).fill(value);
    await expect(submit).toBeDisabled();
    await expect(page.locator('.optimizer-validation')).toContainText('보유 명성치');
  }
  await page.getByLabel('현재 보유 명성치', { exact: true }).fill('999,999,999');
  await expect(page.getByLabel('현재 보유 명성치', { exact: true })).toHaveValue('999999999');
  for (const [medal, circulator] of [
    ['', '2'],
    ['1', ''],
    ['-1', '2'],
    ['1', '1.5'],
    ['9007199254740992', '2'],
  ]) {
    await prices(page, medal, circulator);
    await expect(submit).toBeDisabled();
  }
  await prices(page, '500,000', '10,000,000');
  await expect(submit).toBeEnabled();
  await page.locator('.optimizer-extra summary').click();
  await expect(page.getByLabel('최적화 재설정 실행 단위', { exact: true })).toHaveValue('3');
  await page.getByLabel('최적화 재설정 실행 단위', { exact: true }).selectOption('1');
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), PRICE_KEY))
    .toEqual({ medal: '500000', circulator: '10000000' });
  await back(page, 'target');
  await next(page, 'prices');
  await page.locator('.optimizer-extra summary').click();
  await expect(page.getByLabel('최적화 재설정 실행 단위', { exact: true })).toHaveValue('1');
  await page.evaluate(
    (key) => localStorage.setItem(key, JSON.stringify({ medal: ' ', circulator: '0' })),
    PRICE_KEY,
  );
  await page.reload();
  await atStep(page, 'intro');
  await start(page);
  await chooseManual(page);
  await next(page, 'target');
  await next(page, 'prices');
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toHaveValue('4000000');
  await expect(page.getByLabel('심연의 서큘레이터 가격', { exact: true })).toHaveValue('0');
});

test('real worker compares current types and first-line retention and reprices honor without changing resource means', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await boot(page, characterFixture('실제계산테스트'));
  await start(page);
  await expect(nextButton(page)).toBeEnabled();
  await next(page, 'target');
  await targets(page);
  await expect(page.locator('.optimizer-start-status')).toContainText('목표 세 종류 확보 완료');
  await next(page, 'prices');
  await page.getByLabel('현재 보유 명성치', { exact: true }).fill('0');
  await prices(page, '500000', '1');
  const cheap = await calculate(page);
  const cheapMethods = await groupedResults(page, cheap);
  expect([...cheapMethods].sort()).toEqual(['all', 'direct', 'keep-first', 'lower']);
  expect(cheapMethods[0]).toBe('all');
  const current = cheap.strategies.find((row) => row.id === 'current-types-circulator')!;
  expect(current.policy).toEqual({ kind: 'current-types' });
  expect(current.expectedResets).toBe(0);
  expect(current.expectedHonor).toBe(0);
  expect(current.expectedMeso).toBe(0);
  expect(current.expectedCirculators).toBeGreaterThan(0);
  expect(current.totalCost).toBe(current.expectedCirculators);
  expect(cheap.bestStrategyId).toBe(current.id);
  expect(cheap.strategies.some((row) => row.id === 'keep-first-max')).toBe(true);
  expect(cheap.strategies.find((row) => row.id === 'keep-first-max')?.policy).toEqual({
    kind: 'keep-first',
    targetType: 'passiveSkillLevel',
  });
  expect(cheap.strategies.filter((row) => row.id.startsWith('all-'))).toHaveLength(0);
  expect(cheap.strategies.filter((row) => row.id.startsWith('direct-'))).toHaveLength(7);
  expect(cheap.strategies.filter((row) => row.id.startsWith('lower-'))).toHaveLength(7);
  await expect(page.locator('.optimizer-best .optimizer-breakdown dt')).toHaveText([
    '재설정 메소',
    '명성치 추가 구매',
    '서큘레이터',
  ]);
  await expect(page.locator('.optimizer-best h3')).toHaveText(current.name);
  await expect(page.locator('.optimizer-best .optimizer-lock-condition')).not.toBeEmpty();
  for (const type of TARGETS)
    await expect(page.locator('.optimizer-target-summary')).toContainText(line(type, true).text);
  await back(page, 'prices');
  await page.getByLabel('현재 보유 명성치', { exact: true }).fill('999999999');
  await prices(page, '500000', '1000000000000000');
  const expensive = await calculate(page);
  const expensiveMethods = await groupedResults(page, expensive);
  expect(expensiveMethods[0]).not.toBe(cheapMethods[0]);
  expect(expensive.bestStrategyId).not.toBe(cheap.bestStrategyId);
  expect(expensive.strategies[0].expectedCirculators).toBe(0);
  for (const row of expensive.strategies) {
    const old = cheap.strategies.find((previous) => previous.id === row.id)!;
    expect(row.expectedHonor).toBe(old.expectedHonor);
    expect(row.expectedMeso).toBe(old.expectedMeso);
    expect(row.expectedResets).toBe(old.expectedResets);
    expect(row.expectedCirculators).toBe(old.expectedCirculators);
    expect(row.estimatedAdditionalHonor).toBe(Math.max(0, row.expectedHonor - 999999999));
    expect(row.estimatedHonorPurchaseCost).toBe((row.estimatedAdditionalHonor / 5000) * 500000);
    expect(row.totalCost).toBe(
      row.expectedMeso +
        row.estimatedHonorPurchaseCost +
        row.expectedCirculators * 1000000000000000,
    );
  }
  await expect(page.locator('.optimizer-best h3')).toHaveText(expensive.strategies[0].name);
  await page.locator('.optimizer-notes summary').click();
  await expect(page.locator('.optimizer-notes')).toContainText('정확히 평균한 값은 아닙니다');
});

test('calculation displays a walking avatar and a tip, and cancel restores the price step', async ({
  page,
}) => {
  const workerRoute = '**/assets/ability-optimizer.worker-*.js';
  await page.route(workerRoute, (route) =>
    route.fulfill({ contentType: 'application/javascript', body: 'self.onmessage = () => {};' }),
  );
  await boot(page);
  await start(page);
  await chooseManual(page);
  await next(page, 'target');
  await next(page, 'prices');
  await page.getByRole('button', { name: '계산', exact: true }).click();
  await atStep(page, 'calculating');
  await expect(page.getByRole('heading', { name: '계산중', exact: true })).toBeVisible();
  await expect(page.locator('.optimizer-calculation')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.optimizer-walking-avatar')).toBeVisible();
  await expect(page.locator('.optimizer-tip')).toContainText('알아두면 좋은 팁');
  await expect(page.getByLabel('현재 보유 명성치', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '계산 취소', exact: true }).click();
  await atStep(page, 'prices');
  await expect(page.getByRole('button', { name: '계산', exact: true })).toBeEnabled();
  await expect(page.locator('.optimizer-comparison')).toHaveCount(0);
});

test('method groups omit first-line retention when the current first line is not a target maximum', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const character = characterFixture('첫줄최대치아님');
  character.abilityPresets['3'].lines = [
    line('bossDamagePercent'),
    line('passiveSkillLevel'),
    line('criticalRatePercent'),
  ];
  await boot(page, character);
  await start(page);
  await expect(nextButton(page)).toBeEnabled();
  await next(page, 'target');
  await targets(page);
  await next(page, 'prices');
  await prices(page, '500000', '1');
  const result = await calculate(page);
  expect(result.strategies.some((row) => row.policy.kind === 'keep-first')).toBe(false);
  const methods = await groupedResults(page, result);
  expect([...methods].sort()).toEqual(['all', 'direct', 'lower']);
  await expect(
    page.locator('details.optimizer-method-group[data-method="keep-first"]'),
  ).toHaveCount(0);
  await expect(page.locator('details.optimizer-method-group[data-method="all"]')).toHaveAttribute(
    'data-best-strategy',
    'current-types-circulator',
  );
});

test('optimizer lookup and reload preserve the global character and a paid challenge', async ({
  page,
}) => {
  await page.goto('./#soulAmplification');
  await page.getByRole('button', { name: '증폭 시도하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  const before = await readSession(page);
  // Leaving a challenge pauses it; paid attempts, options, costs, and history must survive.
  const pausedState = {
    ...before.state,
    status: before.state.status === 'running' ? 'paused' : before.state.status,
  };
  const character = characterFixture('내부조회전용');
  await page.route(`${SHARED_API}/character?*`, (route) => route.fulfill({ json: character }));
  await selectSimulator(page, '어빌리티 최적화');
  await start(page);
  await page.getByLabel('최적화 캐릭터 닉네임', { exact: true }).fill(character.name);
  await page.getByRole('button', { name: '최적화 캐릭터 조회', exact: true }).click();
  await expect(nextButton(page)).toBeEnabled();
  await next(page, 'target');
  await next(page, 'prices');
  await prices(page, '1000', '100000');
  expect(new URL(page.url()).searchParams.has('character')).toBe(false);
  const during = await readSession(page);
  expect(during.character.name).toBe(bundled.name);
  expect(during.config).toEqual(before.config);
  expect(during.state).toEqual(pausedState);
  await page.reload();
  await atStep(page, 'intro');
  const refreshed = await readSession(page);
  expect(refreshed.config).toEqual(before.config);
  expect(refreshed.state).toEqual(pausedState);
  await selectSimulator(page, '소울 증폭');
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기', exact: true })).toContainText(
    bundled.name,
  );
  const after = await readSession(page);
  expect(after.state).toEqual(pausedState);
});

for (const width of [360, 390, 1280]) {
  test(`wizard steps and completed results fit ${width}px in dark and light themes`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await boot(page, characterFixture(`최적화완성긴닉네임${width}`, true));
    await noOverflow(page, width);
    await start(page);
    await expect(nextButton(page)).toBeEnabled();
    await noOverflow(page, width);
    await next(page, 'target');
    await targets(page);
    await expect(page.locator('.optimizer-start-status')).toContainText('세 줄 모두 최대치입니다');
    await noOverflow(page, width);
    await next(page, 'prices');
    await prices(page, '0', '0');
    await noOverflow(page, width);
    const result = await calculate(page);
    expect(result.strategies.every((row) => row.status === 'already' && row.totalCost === 0)).toBe(
      true,
    );
    await expect(page.locator('.optimizer-total')).toHaveText('0 메소');
    await expect(page.locator('.optimizer-best h3')).toHaveText('이미 완성됐어요');
    await groupedResults(page, result);
    for (const type of TARGETS)
      await expect(page.locator('.optimizer-target-summary')).toContainText(line(type, true).text);
    for (const theme of ['dark', 'light']) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme)
        await page
          .getByRole('button', {
            name: theme === 'dark' ? '어두운 테마' : '밝은 테마',
            exact: true,
          })
          .click();
      await expect(
        page.getByRole('button', { name: '어빌리티 최적화', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.optimizer-best')).toBeVisible();
      await noOverflow(page, width);
      const bounds = (await page.locator('.optimizer-best').boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      for (const group of await page.locator('details.optimizer-method-group').all()) {
        const summary = group.locator(':scope > .optimizer-method-summary');
        await summary.click();
        await expect(group).toHaveAttribute('open');
        const firstVariant = group.locator('details.optimizer-strategy').first();
        await firstVariant.locator(':scope > summary').click();
        await expect(firstVariant.locator('.optimizer-breakdown')).toBeVisible();
        await noOverflow(page, width);
        await firstVariant.locator(':scope > summary').click();
        await summary.click();
      }
    }
  });
}
