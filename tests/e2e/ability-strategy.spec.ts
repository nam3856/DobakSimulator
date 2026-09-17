import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { abilityConfigForState } from '../../src/engine/ability-strategy';
import { eligibleCandidates, type RuleData } from '../../src/engine/rules';
import { prepareDraw } from '../../src/engine/simulation';
import { deserialize, type StoredSession } from '../../src/ui/storage';

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
});

async function boot(page: Page) {
  await page.goto('./#ability');
  await expect(page.getByRole('heading', { name: '고급 어빌리티 시뮬레이터' })).toBeVisible();
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('lowerFirst');
}

async function stored(page: Page): Promise<StoredSession> {
  // Exercise the same page-exit persistence hook used by refresh/navigation.
  const value = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    return localStorage.getItem('isekai-jikjak:session:v1')!;
  });
  return deserialize<StoredSession>(value);
}

function maximum(type: string) {
  const option = data.ability.grades.legendary!.options.find((row) => row.type === type)!;
  return option.values.reduce((best, row) => (row.value > best.value ? row : best));
}

async function selectStart(page: Page, types: string[]) {
  for (const [slot, type] of types.entries()) {
    await page.getByLabel(`${slot + 1}번째 시작 옵션`).selectOption({
      label: `[레전드리] ${maximum(type).label}`,
    });
  }
}

async function benchmarkReady(page: Page) {
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중', { timeout: 30000 });
  await expect(page.locator('.expected-stat')).not.toContainText('달성할 수 없음');
}

/** Force legal paid outcomes while leaving every benchmark probability and RNG intact. */
async function forceOneRoll(page: Page, types: string[]) {
  const session = await stored(page);
  const prepared = prepareDraw(
    data,
    abilityConfigForState(session.config, session.state),
    session.state.grade,
    session.state.lines,
  );
  const prefix = [...prepared.fixed.values()];
  const samples: number[] = [];
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
    const total = rows.reduce((sum, row) => sum + row.probability, 0);
    samples.push(
      (rows.slice(0, index).reduce((sum, row) => sum + row.probability, 0) +
        rows[index].probability / 2) /
        total,
    );
    prefix.push(rows[index]);
  }
  await page.evaluate((samples) => {
    const original = crypto.getRandomValues.bind(crypto);
    const queued = [...samples];
    crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint32Array && array.length === 2 && queued.length) {
        array.fill(Math.floor(queued.shift()! * 4294967296));
        if (!queued.length) crypto.getRandomValues = original;
        return array;
      }
      return original(array as ArrayBufferView) as T;
    };
  }, samples);
  await page.getByRole('button', { name: '1회 재설정하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText(
    `${session.state.attempts + 1n}회`,
  );
}

test('job presets set three legendary maxima and interchangeable secondary slots', async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByRole('button', { name: '3회 비교', exact: true })).toHaveClass(/selected/);
  await expect(page.getByRole('button', { name: '3회 재설정하기', exact: true })).toBeVisible();
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  for (const [index, type, value] of [
    [1, 'passiveSkillLevel', '1'],
    [2, 'bossDamagePercent', '20'],
    [3, 'statusAilmentDamagePercent', '10'],
  ] as const) {
    await expect(page.getByLabel(`목표 조건 ${index} 옵션`)).toHaveValue(type);
    await expect(page.getByLabel(`목표 조건 ${index} 수치`)).toHaveValue(value);
    await expect(page.getByLabel(`목표 조건 ${index} 등급`)).toHaveValue('legendary');
    await expect(page.getByLabel(`목표 조건 ${index} 줄`)).toHaveValue(index === 1 ? '0' : 'lower');
  }
  await expect(page.getByRole('button', { name: '1번째 옵션 잠금', exact: true })).toHaveCount(0);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트워커');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('attackFlat');
  await expect(page.getByLabel('목표 조건 3 수치')).toHaveValue('30');
  await page.getByLabel('직업별 종결 어빌리티').selectOption('비숍');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('magicAttackFlat');
  await expect(page.getByLabel('목표 조건 3 수치')).toHaveValue('30');
  await page.getByLabel('직업별 종결 어빌리티').selectOption('메르세데스');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('criticalRatePercent');
  await expect(page.getByLabel('목표 조건 3 수치')).toHaveValue('30');
  await benchmarkReady(page);
  expect((await stored(page)).config.abilityPresetJob).toBe('메르세데스');
  expect((await stored(page)).config.batchSize).toBe(3);
});

test('matching secondary starts lock for free in reversed order and persist paid misses', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: '1회', exact: true }).click();
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await selectStart(page, ['attackFlat', 'statusAilmentDamagePercent', 'bossDamagePercent']);
  await benchmarkReady(page);
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('첫 번째 줄 도전 중');
  await expect(page.locator('.current-result').getByLabel('2번째 줄 자동 잠금')).toBeVisible();
  await expect(page.locator('.current-result').getByLabel('3번째 줄 자동 잠금')).toBeVisible();
  await expect(page.locator('.spent-stat strong')).toHaveAttribute('title', '0');
  const original = await stored(page);
  expect(original.state.lockedSlots).toEqual([1, 2]);
  expect(original.state.attempts).toBe(0n);
  await forceOneRoll(page, ['magicAttackFlat', 'statusAilmentDamagePercent', 'bossDamagePercent']);
  await expect(page.locator('.spent-stat')).toContainText('1,500만');
  expect((await stored(page)).state.lines).toEqual(original.state.lines);
  await page.reload();
  await benchmarkReady(page);
  await expect(page.getByLabel('직업별 종결 어빌리티')).toHaveValue('나이트로드');
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('자동 잠금 2/2줄');
  await expect(page.locator('.spent-stat')).toContainText('명성치 4만');
  expect((await stored(page)).state.spent.meso).toBe(15000000n);
});

test('paid phases adopt lower goals and keep the original benchmark through completion', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: '1회', exact: true }).click();
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await selectStart(page, ['attackFlat', 'strFlat', 'dexFlat']);
  await benchmarkReady(page);
  const initial = await stored(page);
  const mean = (await page.locator('.expected-stat strong').textContent())!;
  await forceOneRoll(page, ['attackFlat', 'bossDamagePercent', 'dexFlat']);
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('남은 보조 줄 도전 중');
  await expect(page.locator('.candidate-card')).toContainText('보조 목표 확보 · 자동 잠금');
  await expect(page.locator('.spent-stat')).toContainText('200만');
  await expect(page.locator('.expected-stat strong')).toHaveText(mean);
  await forceOneRoll(page, ['attackFlat', 'bossDamagePercent', 'statusAilmentDamagePercent']);
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('첫 번째 줄 도전 중');
  await expect(page.locator('.spent-stat')).toContainText('800만');
  await expect(page.locator('.expected-stat strong')).toHaveText(mean);
  await forceOneRoll(page, [
    'passiveSkillLevel',
    'bossDamagePercent',
    'statusAilmentDamagePercent',
  ]);
  await expect(page.locator('.status-badge')).toHaveText('목표 달성');
  await benchmarkReady(page);
  await expect(page.locator('.expected-stat strong')).toHaveText(mean);
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('세 줄 완성');
  await expect(page.locator('.luck-badge')).toBeVisible();
  const completed = await stored(page);
  expect(completed.config.start).toEqual(initial.config.start);
  expect(completed.config.lockedSlots).toEqual([]);
  expect(completed.state.lockedSlots).toEqual([1, 2]);
  expect(completed.state.spent.meso).toBe(23000000n);
  expect(completed.state.spent.honor).toBe(90000n);
});

test('ability presets and automatic lock progress fit a 360px screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await boot(page);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('비숍');
  await selectStart(page, ['attackFlat', 'magicAttackFlat', 'statusAilmentDamagePercent']);
  await benchmarkReady(page);
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('자동 잠금 2/2줄');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.getByLabel('어빌리티 진행 방식').selectOption('fixed');
  await expect(
    page.getByRole('button', { name: '2번째 옵션 잠금 해제', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '3번째 옵션 잠금 해제', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'test-results/ability-mobile.png', fullPage: true });
});
