import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { CharacterSnapshot, OptionLine } from '../../src/types';
import type { NormalAbilityOptimizerResult } from '../../src/engine/ability-normal-optimizer';
import type { AbilityOption } from '../../src/engine/rules';

const API = 'https://fixture-api.example/api';
const SETTINGS = 'isekai:ability-optimizer:settings:v1:';
const bundled = JSON.parse(
  readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
) as CharacterSnapshot;
const ability = JSON.parse(
  readFileSync(new URL('../../public/rules/ability.json', import.meta.url), 'utf8'),
) as { grades: Record<'unique' | 'legendary', { options: AbilityOption[] }> };
const TARGETS = ['passiveSkillLevel', 'bossDamagePercent', 'criticalRatePercent'];

function line(type: string, grade: 'unique' | 'legendary' = 'legendary', best = false): OptionLine {
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

function fixture(name: string, criticalGrade: 'unique' | 'legendary' = 'legendary') {
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
    // The required legendary target is deliberately on the second line.
    lines: [
      line('bossDamagePercent'),
      line('passiveSkillLevel'),
      line('criticalRatePercent', criticalGrade),
    ],
  };
  for (const equipment of Object.values(character.equipmentPresets))
    for (const item of equipment) item.imageUrl = character.imageUrl;
  return character;
}

const wizard = (page: Page) => page.locator('.optimizer-wizard');
const next = (page: Page) => wizard(page).getByRole('button', { name: '다음', exact: true });
const target = (page: Page, slot: number) => page.getByLabel(`목표 옵션 ${slot}`, { exact: true });
const grade = (page: Page, slot: number) =>
  page.getByLabel(`목표 옵션 ${slot} 등급`, { exact: true });

async function openTargets(page: Page, character: CharacterSnapshot) {
  await page.route('**/api/character?*', (route) => route.fulfill({ json: character }));
  await page.goto(`./?character=${encodeURIComponent(character.name)}#abilityOptimizer`);
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'character');
  await expect(next(page)).toBeEnabled();
  await next(page).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'target');
  for (const [index, type] of TARGETS.entries()) await target(page, index + 1).selectOption(type);
}

async function calculate(page: Page) {
  await next(page).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'result', { timeout: 60_000 });
  await expect(wizard(page).getByRole('alert')).toHaveCount(0);
  return page.evaluate(
    () => (window as unknown as { optimizerResult: NormalAbilityOptimizerResult }).optimizerResult,
  );
}

async function expectComplete(page: Page, count: number) {
  await expect(page.locator('.optimizer-best h3')).toHaveText('이미 완성됐어요');
  await expect(page.locator('.optimizer-total')).toHaveText('추가 소모 없음');
  await expect(page.locator('.optimizer-target-summary li')).toHaveCount(count);
  await expect(page.locator('.optimizer-target-summary')).toContainText(`${count}개 옵션`);
}

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: API } }),
  );
  await page.route('https://open.api.nexon.com/maplestory/v1/**', (route) => route.abort());
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

test('optional targets use independent grade pools, preserve compatible choices, and reject active duplicates', async ({
  page,
}) => {
  await openTargets(page, fixture('목표등급선택'));
  await expect(grade(page, 1)).toHaveCount(0);
  await expect(grade(page, 2)).toHaveValue('legendary');
  await expect(grade(page, 3)).toHaveValue('legendary');
  await grade(page, 2).selectOption('none');
  await expect(target(page, 2)).toBeDisabled();
  await expect(target(page, 2)).toHaveValue('');
  await expect(target(page, 3)).toBeEnabled();
  await expect(next(page)).toBeEnabled();

  await grade(page, 2).selectOption('unique');
  await expect(target(page, 2)).toHaveValue('bossDamagePercent');
  const uniqueTypes = await target(page, 2)
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value).filter(Boolean));
  expect(uniqueTypes.sort()).toEqual(
    ability.grades.unique.options
      .filter((o) => o.type && o.values.length)
      .map((o) => o.type!)
      .sort(),
  );
  expect(uniqueTypes).not.toContain('passiveSkillLevel');
  await expect(target(page, 2).locator('option:checked')).toHaveText(
    line('bossDamagePercent', 'unique', true).text,
  );
  await target(page, 2).selectOption('criticalRatePercent');
  await expect(page.locator('.optimizer-validation')).toContainText('서로 다른 옵션');
  await expect(next(page)).toBeDisabled();
  await grade(page, 3).selectOption('none');
  await expect(next(page)).toBeEnabled();

  await grade(page, 2).selectOption('legendary');
  await expect(target(page, 2)).toHaveValue('criticalRatePercent');
  await target(page, 2).selectOption('passiveSkillLevel');
  await grade(page, 2).selectOption('unique');
  await expect(target(page, 2)).toHaveValue('');
  await expect(next(page)).toBeDisabled();
  await target(page, 2).selectOption('attackFlat');
  await expect(next(page)).toBeEnabled();
  await expect(page.getByLabel('최적화 직업 프리셋', { exact: true })).toHaveValue('');

  await page.getByLabel('최적화 직업 프리셋', { exact: true }).selectOption('나이트로드');
  for (const slot of [2, 3]) {
    await expect(grade(page, slot)).toHaveValue('legendary');
    await expect(target(page, slot)).toBeEnabled();
    await expect(target(page, slot)).not.toHaveValue('');
  }
  await expect(next(page)).toBeEnabled();
});

test('saved optional grades survive reload and keep the hidden option for re-enabling', async ({
  page,
}) => {
  const character = fixture('선택목표저장');
  await openTargets(page, character);
  await grade(page, 2).selectOption('none');
  await grade(page, 3).selectOption('unique');
  await target(page, 3).selectOption('attackFlat');
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        `${SETTINGS}${character.name}`,
      ),
    )
    .toMatchObject({
      targetTypes: ['passiveSkillLevel', 'bossDamagePercent', 'attackFlat'],
      targetGrades: ['legendary', 'none', 'unique'],
    });
  await page.reload();
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await next(page).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'target');
  await expect(grade(page, 2)).toHaveValue('none');
  await expect(target(page, 2)).toBeDisabled();
  await expect(grade(page, 3)).toHaveValue('unique');
  await expect(target(page, 3)).toHaveValue('attackFlat');
  await grade(page, 2).selectOption('legendary');
  await expect(target(page, 2)).toHaveValue('bossDamagePercent');
  await expect(next(page)).toBeEnabled();
});

test('legacy settings without target grades restore three legendary targets', async ({ page }) => {
  const character = fixture('이전목표설정');
  const legacyTargets = ['bossDamagePercent', 'attackFlat', 'passiveSkillLevel'];
  await page.addInitScript(
    ({ key, types }) => {
      localStorage.setItem(
        key,
        JSON.stringify({ targetTypes: types, preset: '1', batchSize: 3, job: '' }),
      );
    },
    { key: `${SETTINGS}${character.name}`, types: legacyTargets },
  );
  await page.route('**/api/character?*', (route) => route.fulfill({ json: character }));
  await page.goto(`./?character=${encodeURIComponent(character.name)}#abilityOptimizer`);
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await next(page).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'target');
  for (const [index, type] of legacyTargets.entries())
    await expect(target(page, index + 1)).toHaveValue(type);
  for (const slot of [2, 3]) await expect(grade(page, slot)).toHaveValue('legendary');
  await expect(next(page)).toBeEnabled();
});

test('one required target is complete on any current line and excludes both unused goals', async ({
  page,
}) => {
  await openTargets(page, fixture('한줄완성목표'));
  await grade(page, 2).selectOption('none');
  await grade(page, 3).selectOption('none');
  await expect(page.locator('.optimizer-start-status')).toContainText('이미 달성');
  const result = await calculate(page);
  await expectComplete(page, 1);
  await expect(page.locator('.optimizer-target-summary')).toContainText(
    line('passiveSkillLevel').text,
  );
  await expect(page.locator('.optimizer-target-summary')).not.toContainText(
    line('bossDamagePercent', 'legendary', true).text,
  );
  await expect(page.locator('.optimizer-target-summary')).not.toContainText(
    line('criticalRatePercent', 'legendary', true).text,
  );
});

test('a legendary value above a unique target counts as complete even when target two is unused', async ({
  page,
}) => {
  await openTargets(page, fixture('두줄유니크타협'));
  await grade(page, 2).selectOption('none');
  await grade(page, 3).selectOption('unique');
  await expect(page.locator('.optimizer-start-status')).toContainText('이미 달성');
  const result = await calculate(page);
  await expectComplete(page, 2);
  const summary = page.locator('.optimizer-target-summary');
  await expect(summary).toContainText('선택한 등급 이상 · 목표 수치 충족');
  await expect(summary.locator('li').nth(1)).toContainText('유니크');
  await expect(summary.locator('li').nth(1)).toContainText(
    line('criticalRatePercent', 'unique', true).text,
  );
  await expect(summary).not.toContainText(line('criticalRatePercent', 'legendary', true).text);
});

test('three mixed-grade targets retain all goals and compare lower-line circulation', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const character = fixture('세줄혼합등급목표', 'unique');
  character.abilityPresets['1'].lines = [
    line('passiveSkillLevel'),
    line('bossDamagePercent', 'unique'),
    line('criticalRatePercent', 'unique'),
  ];
  await openTargets(page, character);
  await grade(page, 2).selectOption('unique');
  await grade(page, 3).selectOption('unique');
  const result = await calculate(page);
  expect(
    result.strategies.every((row) => row.status === 'ready' && Number.isFinite(row.expectedHonor)),
  ).toBe(true);
  const current = result.strategies.find((row) => row.id === 'normal-black')!;
  expect(current.expectedResets).toBe(0);
  expect(current.expectedBlack).toBeGreaterThan(0);
  expect(result.strategies.some((row) => row.id === 'normal-miracle-honor')).toBe(true);
  await expect(page.locator('.optimizer-target-summary li')).toHaveCount(3);
  await expect(page.locator('.optimizer-target-summary .grade-unique')).toHaveCount(2);
  await expect(page.locator('.optimizer-target-summary .grade-legendary')).toHaveCount(1);
});

test('a unique target below its maximum needs real worker calculation and can finish with circulators', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const character = fixture('유니크수치미완성', 'unique');
  character.abilityPresets['1'].lines = [
    line('passiveSkillLevel'),
    line('bossDamagePercent', 'unique'),
    line('criticalRatePercent', 'unique'),
  ];
  await openTargets(page, character);
  await grade(page, 2).selectOption('none');
  await grade(page, 3).selectOption('unique');
  await expect(page.locator('.optimizer-start-status')).not.toContainText('이미 달성');
  const result = await calculate(page);
  expect(result.strategies.some((row) => row.status === 'already')).toBe(false);
  const current = result.strategies.find((row) => row.id === 'normal-black');
  expect(current).toBeDefined();
  expect(current!.expectedResets).toBe(0);
  expect(current!.expectedBlack).toBeGreaterThan(1);
  expect(current!.expectedHonor).toBe(0);
  expect(current!.expectedMiracle).toBe(0);
  expect(current!.expectedChaos).toBe(0);
  await expect(page.locator('.optimizer-best h3')).not.toHaveText('이미 완성됐어요');
  await expect(page.locator('.optimizer-target-summary li')).toHaveCount(2);
});

for (const width of [360, 390]) {
  test(`optional goal controls are keyboard accessible and fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openTargets(page, fixture(`목표모바일${width}`));
    await grade(page, 2).focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await expect(grade(page, 2)).toHaveValue('unique');
    await page.keyboard.press('Tab');
    await expect(target(page, 2)).toBeFocused();
    await grade(page, 3).focus();
    await page.keyboard.press('Home');
    await expect(grade(page, 3)).toHaveValue('none');
    await expect(target(page, 3)).toBeDisabled();
    await expect(next(page)).toBeEnabled();
    for (const control of [
      target(page, 1),
      grade(page, 2),
      target(page, 2),
      grade(page, 3),
      next(page),
    ]) {
      await expect(control).toBeVisible();
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await next(page).focus();
    await page.keyboard.press('Enter');
    await expect(wizard(page)).toHaveAttribute('data-step', 'result');
    await expect(page.locator('.optimizer-target-summary li')).toHaveCount(2);
    await expect(page.locator('.optimizer-best h3')).toHaveText('이미 완성됐어요');
    for (const group of await page.locator('.optimizer-method-group').all()) {
      await group.locator(':scope > summary').focus();
      await page.keyboard.press('Enter');
      await expect(group).toHaveAttribute('open');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
  });
}
