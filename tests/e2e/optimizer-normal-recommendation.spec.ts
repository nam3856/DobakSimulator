import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { CharacterSnapshot, OptionLine } from '../../src/types';
import type { AbilityOption } from '../../src/engine/rules';

const bundled = JSON.parse(
  readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
) as CharacterSnapshot;
const ability = JSON.parse(
  readFileSync(new URL('../../public/rules/ability.json', import.meta.url), 'utf8'),
) as { grades: Record<'unique' | 'legendary', { options: AbilityOption[] }> };

function line(type: string, best = false, grade: 'unique' | 'legendary' = 'legendary'): OptionLine {
  const option = ability.grades[grade].options.find((row) => row.type === type)!;
  const value = best ? option.values.at(-1)! : option.values[0];
  return {
    id: option.id,
    abilityTypeId: option.id,
    type,
    value: value.value,
    text: value.label,
    unit: type.endsWith('Percent') ? 'percent' : 'flat',
    grade,
  };
}

function fixture(name: string, best = false, normalStart = false) {
  const character = structuredClone(bundled);
  character.name = name;
  character.job = '나이트로드';
  character.bundledAvatars = false;
  character.fetchedAt = new Date().toISOString();
  character.imageUrl = 'http://127.0.0.1:4173/DobakSimulator/character/neutral.png';
  character.activeAbilityPreset = '1';
  character.abilityPresets['1'] = {
    grade: 'legendary',
    honor: 0,
    lines: [
      line('passiveSkillLevel'),
      line('bossDamagePercent', best, normalStart ? 'unique' : 'legendary'),
      line('criticalRatePercent', false, normalStart ? 'unique' : 'legendary'),
    ],
  };
  for (const equipment of Object.values(character.equipmentPresets))
    for (const item of equipment) item.imageUrl = character.imageUrl;
  return character;
}

const wizard = (page: Page) => page.locator('.optimizer-wizard');
const next = (page: Page) => wizard(page).getByRole('button', { name: '다음', exact: true });

async function openSingleTarget(page: Page, character: CharacterSnapshot, type: string) {
  await page.route('**/api/character?*', (route) => route.fulfill({ json: character }));
  await page.goto(`./?character=${encodeURIComponent(character.name)}#abilityOptimizer`);
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(next(page)).toBeEnabled();
  await next(page).click();
  await page.getByLabel('목표 옵션 2 등급', { exact: true }).selectOption('none');
  await page.getByLabel('목표 옵션 3 등급', { exact: true }).selectOption('none');
  await page.getByLabel('목표 옵션 1', { exact: true }).selectOption(type);
}

async function expectNoAdvancedCalculation(page: Page) {
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('심연의 서큘레이터 가격', { exact: true })).toHaveCount(0);
  await expect(page.locator('.optimizer-comparison')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { advancedOptimizerWorkers: number }).advancedOptimizerWorkers,
    ),
  ).toBe(0);
}

async function expectNormalResult(page: Page) {
  await expect(wizard(page)).toHaveAttribute('data-step', 'result', { timeout: 60_000 });
  await expect(page.locator('.optimizer-best h3')).toHaveText(
    '일반 재설정과 서큘레이터를 비교해 보세요',
  );
  const table = page.getByRole('table', { name: '일반 최적화 재화별 기댓값' });
  await expect(table).toContainText('미라클');
  await expect(table).toContainText('블랙');
  await expect(table).toContainText('카오스');
  await expect(table).not.toContainText('메소');
  await expect(wizard(page).getByRole('alert')).toHaveCount(0);
  await expectNoAdvancedCalculation(page);
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(90_000);
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: 'https://fixture-api.example/api' } }),
  );
  await page.route('https://open.api.nexon.com/maplestory/v1/**', (route) => route.abort());
  await page.addInitScript(() => {
    const state = window as unknown as {
      advancedOptimizerWorkers: number;
      normalOptimizerWorkers: number;
    };
    state.advancedOptimizerWorkers = 0;
    state.normalOptimizerWorkers = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (String(url).includes('ability-optimizer.worker')) state.advancedOptimizerWorkers++;
        if (String(url).includes('ability-normal-optimizer.worker')) state.normalOptimizerWorkers++;
        super(url, options);
      }
    };
    // Invalid advanced prices must not block the normal-reset recommendation.
    localStorage.setItem(
      'isekai:ability-optimizer:prices:v1',
      JSON.stringify({ medal: 'invalid', circulator: 'invalid' }),
    );
  });
});

test('a single legendary goal skips prices and advanced calculation, and links to normal reset', async ({
  page,
}) => {
  await openSingleTarget(page, fixture('일반재설정추천', false, true), 'attackFlat');
  await next(page).click();
  await expectNormalResult(page);
  await expect(page.locator('.optimizer-target-summary li')).toHaveCount(1);
  await expectNoAdvancedCalculation(page);
  const link = page.getByRole('link', { name: '일반 재설정으로 이동' });
  await expect(link).toHaveAttribute('href', '#abilityNormal');
  await link.click();
  await expect(page).toHaveURL(/#abilityNormal$/);
  await expect(wizard(page)).toHaveCount(0);
  await expect(page.getByLabel('목표 조건 1 옵션', { exact: true })).toHaveValue('attackFlat');
  await expect(page.getByLabel('목표 조건 1 수치', { exact: true })).toHaveValue(
    String(line('attackFlat', true).value),
  );
});

test('a current nonmaximum legendary goal still recommends normal reset', async ({ page }) => {
  await openSingleTarget(page, fixture('일반재설정수치'), 'bossDamagePercent');
  await next(page).click();
  await expectNormalResult(page);
  await expect(page.locator('.optimizer-target-summary')).toContainText(
    line('bossDamagePercent', true).text,
  );
  await expectNoAdvancedCalculation(page);
});

test('an already maximum legendary goal on a lower line keeps the free completed result', async ({
  page,
}) => {
  await openSingleTarget(page, fixture('일반재설정완료', true), 'bossDamagePercent');
  await next(page).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'result');
  await expect(page.locator('.optimizer-best h3')).toHaveText('이미 완성됐어요');
  await expect(page.locator('.optimizer-total')).toHaveText('추가 소모 없음');
  await expect(page.getByRole('link', { name: '일반 재설정으로 이동' })).toHaveCount(0);
  await expectNoAdvancedCalculation(page);
  expect(
    await page.evaluate(
      () => (window as unknown as { normalOptimizerWorkers: number }).normalOptimizerWorkers,
    ),
  ).toBe(0);
});

test('one legendary plus a unique goal stays in normal optimization and transfers both goals', async ({
  page,
}) => {
  await openSingleTarget(page, fixture('일반재설정유니크목표', false, true), 'attackFlat');
  await page.getByLabel('목표 옵션 2 등급', { exact: true }).selectOption('unique');
  await page.getByLabel('목표 옵션 2', { exact: true }).selectOption('bossDamagePercent');
  await next(page).click();
  await expectNormalResult(page);
  await expect(page.locator('.optimizer-target-summary li')).toHaveCount(2);
  await page.getByRole('link', { name: '일반 재설정으로 이동' }).click();
  await expect(page.getByLabel('목표 조건 1 옵션', { exact: true })).toHaveValue('attackFlat');
  await expect(page.getByLabel('목표 조건 1 줄', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('목표 조건 2 옵션', { exact: true })).toHaveValue(
    'bossDamagePercent',
  );
  await expect(page.getByLabel('목표 조건 2 등급', { exact: true })).toHaveValue('unique');
  await expect(page.getByLabel('목표 조건 2 줄', { exact: true })).toHaveValue('lower');
});

test('back returns to goals and adding a second legendary target restores advanced prices', async ({
  page,
}) => {
  await openSingleTarget(page, fixture('일반재설정목표변경'), 'attackFlat');
  await next(page).click();
  await expectNormalResult(page);
  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'target');
  await page.getByLabel('목표 옵션 2 등급', { exact: true }).selectOption('legendary');
  await page.getByLabel('목표 옵션 2', { exact: true }).selectOption('bossDamagePercent');
  await next(page).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'prices');
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toBeVisible();
  await expect(page.getByLabel('심연의 서큘레이터 가격', { exact: true })).toBeVisible();
});
