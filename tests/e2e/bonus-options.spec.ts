import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { CharacterSnapshot } from '../../src/types';
import type { BonusConfig, BonusRoll, BonusStats } from '../../src/engine/bonus-options';
import { deserialize, serialize } from '../../src/ui/storage';
import { selectSimulator } from './helpers/navigation';

const character: CharacterSnapshot = JSON.parse(
  readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
);
const equipment = character.equipmentPresets[character.activeEquipmentPreset];
const hat = equipment.find((item) => item.category === 'hat')!;
const storageKey = `isekai:bonus-options:v1:${character.name}`;
const workerRoute = '**/assets/bonus-options.worker-*.js';

interface SavedBonus {
  version: 1;
  preset: string;
  config: BonusConfig;
  itemId: string;
  run: {
    start: Partial<BonusStats>;
    current: Partial<BonusStats>;
    candidate?: BonusRoll;
    last?: BonusRoll;
    attempts: bigint;
    spent: bigint;
    success: boolean;
    history: { attempt: bigint; score: number; hit: boolean }[];
  };
}

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
});

async function saved(page: Page) {
  return deserialize<SavedBonus>(
    await page.evaluate((key) => {
      window.dispatchEvent(new Event('pagehide'));
      return localStorage.getItem(key)!;
    }, storageKey),
  );
}

const rollButton = (page: Page) =>
  page.getByRole('button', { name: '추가옵션 재설정', exact: true });
const autoButton = (page: Page) =>
  page.getByRole('button', { name: '목표까지 자동 진행', exact: true });
const itemSelect = (page: Page) =>
  page.getByRole('combobox', { name: '추가옵션 장비', exact: true });

async function boot(page: Page) {
  await page.goto('./#bonusOptions');
  await expect(page.getByRole('heading', { name: '추가옵션 재설정', exact: true })).toBeVisible();
}

async function ready(page: Page) {
  await expect(rollButton(page)).toBeEnabled();
  await expect(page.locator('.bonus-distribution')).toBeVisible();
}

// A boss roll makes eight draws: four distinct option choices and four tiers.
// Failures alternate STR/DEX/INT/LUK at tiers 4 and 5 so each result can replace
// the previous roll. Success draws allstat tier 7 first.
// Install only after boot so banner selection cannot consume a controlled draw.
async function forceAllStatSuccess(page: Page, successAttempt: number) {
  await page.evaluate((attempt) => {
    const controls = window as unknown as { bonusRandomDraws: number };
    controls.bonusRandomDraws = 0;
    Math.random = () => {
      const draw = controls.bonusRandomDraws++;
      const roll = Math.floor(draw / 8);
      if (roll >= attempt - 1) return draw % 8 < 2 ? 0.999 : 0;
      return draw % 2 === 1 && roll % 2 === 1 ? 0.5 : 0;
    };
  }, successAttempt);
}

async function allStatGoal(page: Page) {
  await page.getByLabel('DEX 환산 비율', { exact: true }).fill('0');
  await page.getByLabel('공격력 환산 비율', { exact: true }).fill('0');
  await page.getByLabel('올스탯% 환산 비율', { exact: true }).fill('1');
  await page.getByLabel('목표 환산 추옵', { exact: true }).fill('7');
  await ready(page);
}

test('bonusOptions deep link imports the level 250 hat and excludes ineligible equipment', async ({
  page,
}) => {
  await boot(page);
  await ready(page);
  await expect(itemSelect(page)).toHaveValue(hat.id);
  await expect(page.getByLabel('장비 레벨', { exact: true })).toHaveValue('250');
  await expect(page.getByRole('combobox', { name: /^추가옵션 유형/ })).toHaveValue('boss');
  const initial = await saved(page);
  expect(initial.run.current).toEqual(hat.bonusOptions);
  expect(initial.run.start).toEqual(hat.bonusOptions);
  expect(initial.run.attempts).toBe(0n);
  await expect(page.locator('.bonus-result-card')).toHaveCount(1);
  const before = page.locator('.bonus-result-card').first();
  await expect(before.locator('.bonus-score')).toHaveText('172급');
  for (const value of ['+42', '+132', '+4%']) await expect(before).toContainText(value);

  const options = itemSelect(page).locator('option');
  const values = await options.evaluateAll((items) =>
    items.map((item) => (item as HTMLOptionElement).value),
  );
  for (const item of equipment.filter((value) =>
    ['ring', 'emblem', 'shoulder', 'secondaryWeapon', 'heart'].includes(value.category),
  ))
    expect(values).not.toContain(item.id);
  const pocket = equipment.find((item) => item.category === 'pocket')!;
  expect(values).toContain(pocket.id);
  await itemSelect(page).selectOption(pocket.id);
  expect((await saved(page)).run.current).toEqual(pocket.bonusOptions);
  await selectSimulator(page, '스타포스');
  const starforceOptions = page.getByRole('combobox', { name: '스타포스 장비', exact: true });
  await expect(starforceOptions).toBeVisible();
  const starforceIds = await starforceOptions
    .locator('option')
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(starforceIds).not.toContain(pocket.id);
  await selectSimulator(page, '추가옵션');
  await expect(itemSelect(page)).toHaveValue(pocket.id);

  const weapon = equipment.find((item) => item.category === 'weapon')!;
  await itemSelect(page).selectOption(weapon.id);
  await expect(page.getByLabel('무기 기본 공격력', { exact: true })).toHaveValue('249');
  await expect(page.getByLabel('무기 기본 마력', { exact: true })).toHaveValue('0');
  await selectSimulator(page, '큐브');
  await selectSimulator(page, '추가옵션');
  await expect(page).toHaveURL(/#bonusOptions$/);
  await expect(itemSelect(page)).toHaveValue(weapon.id);
});

test('manual rolls apply immediately, persist and reject an identical result without extra cost', async ({
  page,
}) => {
  await boot(page);
  await ready(page);
  await forceAllStatSuccess(page, 100);
  const initial = await saved(page);
  await rollButton(page).click();
  await ready(page);
  await expect(page.getByRole('button', { name: '이전 옵션 유지', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '새 옵션 적용', exact: true })).toHaveCount(0);
  await expect(itemSelect(page)).toBeEnabled();
  await expect(page.getByLabel('목표 환산 추옵', { exact: true })).toBeEnabled();
  const first = await saved(page);
  expect(first.run.attempts).toBe(1n);
  expect(first.run.spent).toBe(3_000_000n);
  expect(first.run.current).toEqual(first.run.last?.stats);
  expect(first.run.current).not.toEqual(initial.run.current);
  expect(first.run.current.dex).toBe(48);
  expect(first.run).not.toHaveProperty('candidate');
  await expect(page.locator('.bonus-new .bonus-score')).toHaveText('48급');
  await page.reload();
  await ready(page);
  expect((await saved(page)).run).toEqual(first.run);

  // The first generated result is identical to the applied tier-4 result. Only
  // the following tier-5 result is accepted, and this remains one paid attempt.
  await forceAllStatSuccess(page, 100);
  await rollButton(page).click();
  const adopted = await saved(page);
  expect(adopted.run.current).toEqual(adopted.run.last?.stats);
  expect(adopted.run.current.dex).toBe(60);
  expect(adopted.run.last?.lines.every((line) => line.tier === 5)).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { bonusRandomDraws: number }).bonusRandomDraws),
  ).toBe(16);
  expect(adopted.run.start).toEqual(initial.run.start);
  expect(adopted.run.attempts).toBe(2n);
  expect(adopted.run.spent).toBe(6_000_000n);
  expect(adopted.run.history).toHaveLength(2);
  expect(adopted.run).not.toHaveProperty('candidate');
  await page.reload();
  await expect(page.getByRole('heading', { name: '추가옵션 재설정', exact: true })).toBeVisible();
  expect((await saved(page)).run).toEqual(adopted.run);
});

test('an impossible goal and invalid weapon bases block paid actions until corrected', async ({
  page,
}) => {
  await boot(page);
  await page.getByLabel('목표 환산 추옵', { exact: true }).fill('999999');
  await expect(page.getByRole('status')).toContainText('도달할 수 없는 목표');
  await expect(rollButton(page)).toBeDisabled();
  await expect(autoButton(page)).toBeDisabled();
  expect((await saved(page)).run.attempts).toBe(0n);
  await page.getByLabel('목표 환산 추옵', { exact: true }).fill('180');
  await ready(page);
  await itemSelect(page).selectOption('manual');
  await page.getByRole('combobox', { name: '장비 분류', exact: true }).selectOption('weapon');
  await expect(page.getByRole('alert')).toContainText('기본 공격력 또는 기본 마력');
  await expect(rollButton(page)).toBeDisabled();
  await page.getByLabel('무기 기본 공격력', { exact: true }).fill('249');
  await page.getByLabel('무기 기본 마력', { exact: true }).fill('0');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('automatic failures replace current stats and stopping prevents further paid attempts', async ({
  page,
}) => {
  await boot(page);
  await allStatGoal(page);
  const time = new Date('2026-09-20T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await forceAllStatSuccess(page, 10_000);
  await autoButton(page).click();
  await page.clock.runFor(25);
  const stop = page.getByRole('button', { name: '자동 진행 멈추기', exact: true });
  await expect(stop).toBeEnabled();
  const progressing = await saved(page);
  expect(progressing.run.attempts).toBeGreaterThan(0n);
  expect(progressing.run.attempts).toBeLessThanOrEqual(500n);
  expect(progressing.run.current).toEqual(progressing.run.last?.stats);
  expect(progressing.run.current).not.toEqual(hat.bonusOptions);
  expect(progressing.run.current.allStat).toBe(0);
  expect(progressing.run.success).toBe(false);
  expect(progressing.run.spent).toBe(progressing.run.attempts * 3_000_000n);
  expect(progressing.run).not.toHaveProperty('candidate');
  await stop.click();
  await expect(autoButton(page)).toBeEnabled();
  await page.clock.runFor(1000);
  expect((await saved(page)).run).toEqual(progressing.run);
});

test('completed auto runs reload and 다시 진행 starts a fresh automatic run at the imported baseline', async ({
  page,
}) => {
  await boot(page);
  await allStatGoal(page);
  await forceAllStatSuccess(page, 3);
  const initial = await saved(page);
  await autoButton(page).click();
  await expect(page.locator('.bonus-stats .stat-card').first().locator('strong')).toHaveText('3회');
  await expect(page.locator('.bonus-new')).toContainText('목표 달성 옵션');
  const restart = page.getByRole('button', { name: '다시 진행', exact: true });
  await expect(restart).toBeEnabled();
  await expect(autoButton(page)).toHaveCount(0);
  await expect(rollButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '이전 옵션 유지', exact: true })).toHaveCount(0);
  const completed = await saved(page);
  expect(completed.run.success).toBe(true);
  expect(completed.run.attempts).toBe(3n);
  expect(completed.run.spent).toBe(9_000_000n);
  expect(completed.run.current.allStat).toBe(7);
  expect(completed.run.start).toEqual(initial.run.start);
  expect(completed.run.current).toEqual(completed.run.last?.stats);
  expect(completed.run).not.toHaveProperty('candidate');
  expect(completed.run.history.map((entry) => entry.hit)).toEqual([true, false, false]);
  await page.reload();
  await expect(restart).toBeEnabled();
  expect((await saved(page)).run).toEqual(completed.run);

  const time = new Date('2026-09-20T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await forceAllStatSuccess(page, 1);
  await restart.click();
  await expect(page.getByRole('button', { name: '자동 진행 멈추기', exact: true })).toBeEnabled();
  const restarted = await saved(page);
  expect(restarted.config).toEqual(initial.config);
  expect(restarted.run.current).toEqual(hat.bonusOptions);
  expect(restarted.run.attempts).toBe(0n);
  expect(restarted.run.spent).toBe(0n);
  expect(restarted.run.history).toEqual([]);
  await expect(page.locator('.luck-badge')).toHaveCount(0);
  await expect(page.locator('.bonus-stats .stat-card').first()).not.toContainText('계산 중');
  await page.clock.runFor(50);
  await expect(restart).toBeEnabled();
  const completedAgain = await saved(page);
  expect(completedAgain.config).toEqual(initial.config);
  expect(completedAgain.run.attempts).toBe(1n);
  expect(completedAgain.run.spent).toBe(3_000_000n);
  expect(completedAgain.run.history).toHaveLength(1);
  expect(completedAgain.run.success).toBe(true);
  expect(completedAgain.run.current.allStat).toBe(7);
});

for (const success of [false, true]) {
  test(`legacy pending ${success ? 'winning' : 'failed'} candidate is applied once on restore`, async ({
    page,
  }) => {
    await boot(page);
    await allStatGoal(page);
    await forceAllStatSuccess(page, success ? 1 : 100);
    const initial = await saved(page);
    await rollButton(page).click();
    const applied = await saved(page);
    const candidate = applied.run.last!;
    expect(candidate).toBeDefined();
    const legacy: SavedBonus = {
      ...applied,
      version: 1,
      run: { ...applied.run, current: initial.run.current, candidate, success: false },
    };
    // Leave the component before seeding so its pagehide flush cannot overwrite
    // the fixture. The next page boot follows the real old-save migration path.
    await selectSimulator(page, '큐브');
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: storageKey,
      value: serialize(legacy),
    });
    await boot(page);
    if (success)
      await expect(page.getByRole('button', { name: '다시 진행', exact: true })).toBeEnabled();
    else await ready(page);
    const migrated = await saved(page);
    expect(migrated.run.current).toEqual(candidate.stats);
    expect(migrated.run.last).toEqual(candidate);
    expect(migrated.run.start).toEqual(initial.run.start);
    expect(migrated.run.attempts).toBe(1n);
    expect(migrated.run.spent).toBe(3_000_000n);
    expect(migrated.run.history).toEqual(applied.run.history);
    expect(migrated.run.success).toBe(success);
    expect(migrated.run).not.toHaveProperty('candidate');
    await expect(page.getByRole('button', { name: '이전 옵션 유지', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '새 옵션 적용', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: '추가옵션 재설정', exact: true })).toBeVisible();
    expect((await saved(page)).run).toEqual(migrated.run);
  });
}

// Inclusion 4/19 and a 1% tier-7 chance give the displayed independent-roll
// geometric approximation; rejecting identical consecutive results is simulated.
const allStatProbability = (4 / 19) * 0.01;
const p95Attempts = Math.ceil(Math.log(0.05) / Math.log1p(-allStatProbability));
for (const scenario of [
  { flame: 'meso', attempts: 1, reaction: 'jackpot', cost: 3_000_000n },
  { flame: 'black', attempts: p95Attempts, reaction: 'ghost', cost: 0n },
]) {
  test(`${scenario.flame} completion uses the correct percentile scale and restores ${scenario.reaction}`, async ({
    page,
  }) => {
    await boot(page);
    if (scenario.flame !== 'meso')
      await page
        .getByRole('combobox', { name: '재설정 방법', exact: true })
        .selectOption(scenario.flame);
    await allStatGoal(page);
    await forceAllStatSuccess(page, scenario.attempts);
    await autoButton(page).click();
    await expect(page.locator('.reaction-stage')).toHaveClass(
      new RegExp(`is-${scenario.reaction}`),
    );
    const percentile = Number(
      (await page.locator('.luck-badge').innerText()).match(/P([\d.]+)/)![1],
    );
    const expectedPercentile =
      -Math.expm1(scenario.attempts * Math.log1p(-allStatProbability)) * 100;
    expect(Math.abs(percentile - expectedPercentile)).toBeLessThan(0.01);
    expect(percentile).toBeLessThanOrEqual(100);
    const completed = await saved(page);
    expect(completed.run.attempts).toBe(BigInt(scenario.attempts));
    expect(completed.run.spent).toBe(scenario.cost * BigInt(scenario.attempts));
    await expect(page.locator('.chart-actual-label')).toHaveText('이번의 나');
    if (scenario.reaction === 'ghost') {
      await expect(page.locator('.reaction-tombstone')).toBeVisible();
      await expect(page.locator('.stage-sprite')).toHaveAttribute(
        'src',
        /\/character\/ghost\.png$/,
      );
      await expect(page.locator('.bonus-distribution')).toContainText('횟수 기준');
    }
    await page.reload();
    await expect(page.locator('.reaction-stage')).toHaveClass(
      new RegExp(`is-${scenario.reaction}`),
    );
    expect((await saved(page)).run).toEqual(completed.run);
  });
}

test('benchmark errors disable rolling and a corrected setting can recover', async ({ page }) => {
  await page.route(workerRoute, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: "self.onmessage = () => self.postMessage({error: '기댓값 테스트 오류'});",
    }),
  );
  await boot(page);
  await expect(page.getByRole('alert')).toHaveText('기댓값 테스트 오류');
  await expect(rollButton(page)).toBeDisabled();
  await expect(autoButton(page)).toBeDisabled();
  await page.unroute(workerRoute);
  await page.getByLabel('목표 환산 추옵', { exact: true }).fill('181');
  await ready(page);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await saved(page)).run.spent).toBe(0n);
});

test('replacing a slow benchmark ignores its stale response after a settings change', async ({
  page,
}) => {
  await page.route(workerRoute, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `self.onmessage = ({data}) => {
        const stale = data.config.targetScore === 201;
        const p = stale ? .5 : .25;
        setTimeout(() => self.postMessage({result: {
          successProbability: p, baseProbability: p, excludedProbability: 0,
          expectedRolls: 1 / p, expectedCost: 3000000 / p,
          medianRolls: 3, p90Rolls: 9, maxScore: 250, alreadySatisfied: false
        }}), stale ? 400 : 0);
      };`,
    }),
  );
  await boot(page);
  await ready(page);
  await page.getByLabel('목표 환산 추옵', { exact: true }).fill('201');
  await page.getByLabel('목표 환산 추옵', { exact: true }).fill('202');
  await ready(page);
  await expect(page.locator('.bonus-stats .expected-stat strong')).toHaveText('1,200만메소');
  await page.waitForTimeout(500);
  await expect(page.locator('.bonus-stats .expected-stat strong')).toHaveText('1,200만메소');
  expect((await saved(page)).config.targetScore).toBe(202);
  expect((await saved(page)).run.attempts).toBe(0n);
});
