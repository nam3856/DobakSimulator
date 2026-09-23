import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { abilityConfigForState } from '../../src/engine/ability-strategy';
import { eligibleCandidates, type RuleData } from '../../src/engine/rules';
import { prepareDraw } from '../../src/engine/simulation';
import { deserialize, serialize, type StoredSession } from '../../src/ui/storage';
import type { CharacterSnapshot, SimulationConfig, SimulationState } from '../../src/types';

const readRule = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../public/rules/${name}.json`, import.meta.url), 'utf8'));
const data: RuleData = {
  potential: readRule('potential'),
  additional: readRule('additional-potential'),
  gold: readRule('gold'),
  ability: readRule('ability'),
  soul: readRule('soul'),
};
const bundledCharacter = JSON.parse(
  readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
) as CharacterSnapshot;

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
async function forceOneRoll(page: Page, types: string[], batchSize: 1 | 3 = 1) {
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
  await page.evaluate(
    (samples) => {
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
    },
    Array.from({ length: batchSize }, () => samples).flat(),
  );
  await page.getByRole('button', { name: `${batchSize}회 재설정하기`, exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText(
    `${session.state.attempts + BigInt(batchSize)}회`,
  );
}

test('job presets start at three legendary minimum values and interchangeable secondary slots', async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByText('지금부터 업그레이드', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '현재 옵션 재현', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '지금부터 업그레이드', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByLabel('직업별 종결 어빌리티')).toHaveValue('메카닉');
  await expect(page.getByLabel('목표 조건 1 옵션')).toHaveValue('bossDamagePercent');
  await expect(page.getByLabel('목표 조건 2 옵션')).toHaveValue('statusAilmentDamagePercent');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('attackFlat');
  for (const line of bundledCharacter.abilityPresets['1'].lines)
    await expect(page.locator('.current-result')).toContainText(line.text);
  expect((await stored(page)).playMode).toBe('upgrade');
  await expect(page.getByRole('button', { name: '3회 비교', exact: true })).toHaveClass(/selected/);
  await expect(page.getByRole('button', { name: '3회 재설정하기', exact: true })).toBeVisible();
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  for (const [index, type, value] of [
    [1, 'passiveSkillLevel', '1'],
    [2, 'bossDamagePercent', '15'],
    [3, 'statusAilmentDamagePercent', '9'],
  ] as const) {
    await expect(page.getByLabel(`목표 조건 ${index} 옵션`)).toHaveValue(type);
    await expect(page.getByLabel(`목표 조건 ${index} 수치`)).toHaveValue(value);
    await expect(page.getByLabel(`목표 조건 ${index} 등급`)).toHaveValue('legendary');
    await expect(page.getByLabel(`목표 조건 ${index} 줄`)).toHaveValue(index === 1 ? '0' : 'lower');
  }
  await expect(page.getByRole('button', { name: '1번째 옵션 잠금', exact: true })).toHaveCount(0);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트워커');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('attackFlat');
  await expect(page.getByLabel('목표 조건 3 수치')).toHaveValue('27');
  await page.getByLabel('직업별 종결 어빌리티').selectOption('비숍');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('magicAttackFlat');
  await expect(page.getByLabel('목표 조건 3 수치')).toHaveValue('27');
  await page.getByLabel('직업별 종결 어빌리티').selectOption('메르세데스');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('criticalRatePercent');
  await expect(page.getByLabel('목표 조건 3 수치')).toHaveValue('25');
  await benchmarkReady(page);
  expect((await stored(page)).config.abilityPresetJob).toBe('메르세데스');
  expect((await stored(page)).config.batchSize).toBe(3);
});

test('ability values clamp on commit and adjust their range when the selected option or grade changes', async ({
  page,
}) => {
  await boot(page);
  const value = page.getByLabel('목표 조건 1 수치');
  await expect(value).toHaveValue('15');
  await expect(value).toHaveAttribute('min', '15');
  await expect(value).toHaveAttribute('max', '20');
  await value.fill('19');
  expect((await stored(page)).config.target.conditions[0].minValue).toBe(19);
  await value.fill('999');
  await expect(value).toHaveValue('999');
  expect((await stored(page)).config.target.conditions[0].minValue).toBe(19);
  await value.press('Enter');
  await expect(value).toHaveValue('20');
  await value.fill('-1');
  await value.press('Tab');
  await expect(value).toHaveValue('15');
  await value.fill('');
  await value.press('Tab');
  await expect(value).toHaveValue('15');
  await page.getByLabel('목표 조건 1 옵션').selectOption('criticalRatePercent');
  await expect(value).toHaveValue('25');
  await expect(value).toHaveAttribute('min', '25');
  await expect(value).toHaveAttribute('max', '30');
  await page.getByLabel('목표 조건 1 옵션').selectOption('passiveSkillLevel');
  await expect(value).toHaveValue('1');
  await expect(value).toHaveAttribute('min', '1');
  await expect(value).toHaveAttribute('max', '1');

  const secondary = page.getByLabel('목표 조건 2 수치');
  await expect(secondary).toHaveValue('9');
  await page.getByLabel('목표 조건 2 등급').selectOption('unique');
  await expect(secondary).toHaveAttribute('min', '7');
  await secondary.fill('7');
  await page.getByLabel('목표 조건 2 등급').selectOption('legendary');
  await expect(secondary).toHaveValue('9');
  await page.reload();
  await expect(page.getByLabel('목표 조건 1 수치')).toHaveValue('1');
  await expect(page.getByLabel('목표 조건 2 수치')).toHaveValue('9');
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
  expect((await stored(page)).playMode).toBe('upgrade');
});

test('kept ability options can be locked directly, charge manual batches and preserve the new challenge on reload', async ({
  page,
}) => {
  await boot(page);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await selectStart(page, ['passiveSkillLevel', 'bossDamagePercent', 'dexFlat']);
  await benchmarkReady(page);
  const before = await stored(page);
  await expect(
    page.getByRole('button', { name: '2번째 보관 옵션 잠금 해제', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '1번째 보관 옵션 잠금', exact: true }).click();
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('fixed');
  await expect(
    page.getByRole('button', { name: '3번째 보관 옵션 잠금', exact: true }),
  ).toBeDisabled();
  expect((await stored(page)).config.lockedSlots.slice().sort()).toEqual([0, 1]);
  expect((await stored(page)).state.lines).toEqual(before.state.lines);
  await benchmarkReady(page);
  await forceOneRoll(page, ['passiveSkillLevel', 'bossDamagePercent', 'magicAttackFlat'], 3);
  await expect(page.locator('.candidate-card')).toHaveCount(3);
  const paid = await stored(page);
  for (const candidate of paid.state.candidates)
    expect(candidate.lines.slice(0, 2)).toEqual(before.state.lines.slice(0, 2));
  expect(paid.state.spent.meso).toBe(45000000n);
  expect(paid.state.spent.honor).toBe(120000n);
  expect(paid.config.abilityStrategy).toBe('fixed');
  expect(paid.state.lines).toEqual(before.state.lines);

  await page.getByRole('button', { name: '1번째 보관 옵션 잠금 해제', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '3번째 보관 옵션 잠금', exact: true }),
  ).toBeEnabled();
  const reset = await stored(page);
  expect(reset.config.lockedSlots).toEqual([1]);
  expect(reset.config.start.lines).toEqual(paid.state.lines);
  expect(reset.state.attempts).toBe(0n);
  expect(reset.state.spent.meso).toBe(0n);
  const archive = deserialize<{ config: SimulationConfig; state: SimulationState }[]>(
    await page.evaluate(() => localStorage.getItem('isekai-jikjak:archive:v1')!),
  );
  expect(archive[0].state.spent.meso).toBe(45000000n);
  await page.getByRole('button', { name: '1회', exact: true }).click();
  await benchmarkReady(page);
  await forceOneRoll(page, ['attackFlat', 'bossDamagePercent', 'magicAttackFlat']);
  const one = await stored(page);
  expect(one.state.candidates[0].lines[1]).toEqual(before.state.lines[1]);
  expect(one.state.spent.meso).toBe(6000000n);
  await page.reload();
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('fixed');
  await expect(
    page.getByRole('button', { name: '2번째 보관 옵션 잠금 해제', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '1번째 보관 옵션 잠금', exact: true }),
  ).toBeEnabled();
  await expect(page.locator('.spent-stat strong')).toHaveAttribute('title', '6,000,000');
  expect((await stored(page)).state.lines).toEqual(before.state.lines);
});

test('automatic ability execution releases a wrong manual first lock and recomputes lower locks from the current options', async ({
  page,
}) => {
  // Deterministic misses keep the real auto Worker running until the user stops it.
  await page.route('**/assets/simulator.worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `self.crypto.getRandomValues = array => { array.fill(0); return array; };\n${await response.text()}`,
    });
  });
  await boot(page);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await selectStart(page, ['attackFlat', 'bossDamagePercent', 'dexFlat']);
  await benchmarkReady(page);
  const original = await stored(page);
  const expectedMean = (await page.locator('.expected-stat strong').textContent())!;
  await page.getByRole('button', { name: '1번째 보관 옵션 잠금', exact: true }).click();
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('fixed');
  await expect(page.locator('.expected-stat')).toContainText('달성할 수 없음');
  await expect(page.getByRole('button', { name: '3회 재설정하기', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '자동 재설정', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('lowerFirst');
  await expect(page.locator('.current-result').getByLabel('2번째 줄 자동 잠금')).toBeVisible();
  await expect(page.locator('.current-result').getByLabel('1번째 줄 자동 잠금')).toHaveCount(0);
  for (const slot of [1, 2, 3])
    await expect(
      page.getByRole('button', { name: new RegExp(`^${slot}번째 보관 옵션 잠금`) }),
    ).toBeDisabled();
  await expect.poll(async () => (await stored(page)).state.attempts).toBeGreaterThan(0n);
  await page.getByRole('button', { name: '중지', exact: true }).click();
  await benchmarkReady(page);
  const paused = await stored(page);
  expect(paused.config.abilityStrategy).toBe('lowerFirst');
  expect(paused.config.lockedSlots).toEqual([]);
  expect(paused.config.start).toEqual(original.config.start);
  expect(paused.state.lockedSlots).toEqual([1]);
  expect(paused.state.lines).toEqual(original.state.lines);
  expect(paused.state.spent.meso).toBe(paused.state.attempts * 6000000n);
  await expect(page.locator('.expected-stat strong')).toHaveText(expectedMean);
  await expect(page.locator('.luck-badge')).toHaveCount(0);

  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect
    .poll(async () => (await stored(page)).state.attempts)
    .toBeGreaterThan(paused.state.attempts);
  await page.getByRole('button', { name: '중지', exact: true }).click();
  const resumed = await stored(page);
  expect(resumed.config.start).toEqual(paused.config.start);
  expect(resumed.state.spent.meso).toBeGreaterThan(paused.state.spent.meso);
  await expect(page.locator('.expected-stat strong')).toHaveText(expectedMean);
});

test('legacy recreate ability sessions archive paid progress and migrate to the loaded character upgrade target', async ({
  page,
}) => {
  await boot(page);
  await page.getByRole('button', { name: '1회', exact: true }).click();
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await selectStart(page, ['attackFlat', 'statusAilmentDamagePercent', 'bossDamagePercent']);
  await benchmarkReady(page);
  await forceOneRoll(page, ['magicAttackFlat', 'statusAilmentDamagePercent', 'bossDamagePercent']);
  const previous = await stored(page);
  previous.playMode = 'recreate';
  await page.addInitScript((session) => {
    localStorage.setItem('isekai-jikjak:session:v1', session);
  }, serialize(previous));
  await page.reload();
  await expect(page.getByLabel('직업별 종결 어빌리티')).toHaveValue('메카닉');
  await expect(page.getByRole('heading', { name: '고급 어빌리티 시뮬레이터' })).toBeVisible();
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('attackFlat');
  await expect(page.getByRole('button', { name: '1회', exact: true })).toHaveClass(/selected/);
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('0회');
  await expect(page.locator('.spent-stat strong')).toHaveAttribute('title', '0');
  await expect(page.locator('.candidate-card')).toHaveCount(0);
  for (const line of bundledCharacter.abilityPresets['1'].lines)
    await expect(page.locator('.current-result')).toContainText(line.text);
  const migrated = await stored(page);
  expect(migrated.playMode).toBe('upgrade');
  expect(migrated.config.abilityPresetJob).toBe('메카닉');
  expect(migrated.config.start.lines.map((line) => line.text)).toEqual(
    bundledCharacter.abilityPresets['1'].lines.map((line) => line.text),
  );
  expect(migrated.state.attempts).toBe(0n);
  const archive = deserialize<{ config: SimulationConfig; state: SimulationState }[]>(
    await page.evaluate(() => localStorage.getItem('isekai-jikjak:archive:v1')!),
  );
  expect(archive[0].config).toEqual(previous.config);
  expect(archive[0].state.attempts).toBe(1n);
  expect(archive[0].state.spent).toEqual(previous.state.spent);
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

for (const lowerSlot of [1, 2])
  test(`two ability goals acquire slot ${lowerSlot + 1} before the first line and charge every candidate`, async ({
    page,
  }) => {
    await boot(page);
    await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
    await page.getByLabel('어빌리티 목표 줄 수').selectOption('2');
    await selectStart(page, ['attackFlat', 'strFlat', 'dexFlat']);
    await benchmarkReady(page);
    const initial = await stored(page);
    const mean = (await page.locator('.expected-stat strong').textContent())!;
    await expect(page.locator('.ability-progress-steps > span')).toHaveCount(2);
    await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('자동 잠금 0/1줄');

    const acquired = ['attackFlat', 'strFlat', 'dexFlat'];
    acquired[lowerSlot] = 'bossDamagePercent';
    await forceOneRoll(page, acquired, 3);
    await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('첫 번째 줄 도전 중');
    await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('자동 잠금 1/1줄');
    await expect(
      page.locator('.current-result').getByLabel(`${lowerSlot + 1}번째 줄 자동 잠금`),
    ).toBeVisible();
    const unusedSlot = lowerSlot === 1 ? 2 : 1;
    await expect(
      page.getByRole('button', { name: `${unusedSlot + 1}번째 보관 옵션 잠금`, exact: true }),
    ).toBeEnabled();
    const locked = await stored(page);
    expect(locked.state.lockedSlots).toEqual([lowerSlot]);
    expect(locked.state.attempts).toBe(3n);
    expect(locked.state.spent.meso).toBe(6000000n);
    expect(locked.state.spent.honor).toBe(60000n);
    expect(locked.state.candidates).toHaveLength(3);
    await expect(page.locator('.expected-stat strong')).toHaveText(mean);

    await page.reload();
    await benchmarkReady(page);
    await expect(page.getByLabel('어빌리티 목표 줄 수')).toHaveValue('2');
    await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('lowerFirst');
    expect((await stored(page)).state.lockedSlots).toEqual([lowerSlot]);
    const completed = [...acquired];
    completed[0] = 'passiveSkillLevel';
    completed[unusedSlot] = 'intFlat';
    await forceOneRoll(page, completed, 3);
    await expect(page.locator('.status-badge')).toHaveText('목표 달성');
    await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('두 줄 완성');
    await benchmarkReady(page);
    await expect(page.locator('.expected-stat strong')).toHaveText(mean);
    const result = await stored(page);
    expect(result.config.target.conditions).toHaveLength(2);
    expect(result.config.start).toEqual(initial.config.start);
    expect(result.state.lines[unusedSlot].type).toBe('intFlat');
    expect(result.state.lockedSlots).toEqual([lowerSlot]);
    expect(result.state.attempts).toBe(6n);
    expect(result.state.spent.meso).toBe(24000000n);
    expect(result.state.spent.honor).toBe(150000n);
    expect(result.state.candidates).toHaveLength(3);
  });

test('two ability goals persist across presets, reload and goal deletion on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await boot(page);
  await expect(page.getByLabel('어빌리티 목표 줄 수')).toHaveValue('3');
  await page.getByLabel('어빌리티 목표 줄 수').selectOption('2');
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await expect(page.getByLabel('목표 조건 1 옵션')).toHaveValue('passiveSkillLevel');
  await expect(page.getByLabel('목표 조건 2 옵션')).toHaveValue('bossDamagePercent');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveCount(0);
  expect((await stored(page)).config.target.conditions).toHaveLength(2);
  await page.reload();
  await expect(page.getByLabel('어빌리티 목표 줄 수')).toHaveValue('2');
  await page.getByLabel('어빌리티 목표 줄 수').selectOption('3');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('statusAilmentDamagePercent');
  await expect(page.getByLabel('목표 조건 3 수치')).toHaveValue('9');
  await page.getByRole('button', { name: '목표 조건 3 삭제', exact: true }).click();
  await expect(page.getByLabel('어빌리티 목표 줄 수')).toHaveValue('2');
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('lowerFirst');
  await page.getByLabel('직업별 종결 어빌리티').selectOption('비숍');
  await expect(page.getByLabel('목표 조건 1 옵션')).toHaveValue('bossDamagePercent');
  await expect(page.getByLabel('목표 조건 2 옵션')).toHaveValue('statusAilmentDamagePercent');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveCount(0);
  await benchmarkReady(page);
  const session = await stored(page);
  expect(session.config.target.conditions[0].slot).toBe(0);
  expect(session.config.target.conditions[1].slots).toEqual([1, 2]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

test('two ability goals reassess manual locks before automatic reset and use one-lock prices', async ({
  page,
}) => {
  await page.route('**/assets/simulator.worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `self.crypto.getRandomValues = array => { array.fill(0); return array; };\n${await response.text()}`,
    });
  });
  await boot(page);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await page.getByLabel('어빌리티 목표 줄 수').selectOption('2');
  await selectStart(page, ['attackFlat', 'bossDamagePercent', 'dexFlat']);
  await benchmarkReady(page);
  const initial = await stored(page);
  const mean = (await page.locator('.expected-stat strong').textContent())!;
  await page.getByRole('button', { name: '1번째 보관 옵션 잠금', exact: true }).click();
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('fixed');
  await expect(page.locator('.expected-stat')).toContainText('달성할 수 없음');
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('lowerFirst');
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('자동 잠금 1/1줄');
  await expect.poll(async () => (await stored(page)).state.attempts).toBeGreaterThan(0n);
  await page.getByRole('button', { name: '중지', exact: true }).click();
  await benchmarkReady(page);
  const paused = await stored(page);
  expect(paused.config.lockedSlots).toEqual([]);
  expect(paused.config.target.conditions).toHaveLength(2);
  expect(paused.state.lockedSlots).toEqual([1]);
  expect(paused.state.lines).toEqual(initial.state.lines);
  expect(paused.state.attempts % 3n).toBe(0n);
  expect(paused.state.spent.meso).toBe(paused.state.attempts * 6000000n);
  expect(paused.state.spent.honor).toBe(paused.state.attempts * 30000n);
  await expect(page.locator('.expected-stat strong')).toHaveText(mean);
});

test('fixed first ability line acquires and locks lower goals, restores progress and charges both phases', async ({
  page,
}) => {
  await boot(page);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await selectStart(page, ['passiveSkillLevel', 'strFlat', 'dexFlat']);
  await page.getByLabel('어빌리티 진행 방식').selectOption('firstLocked');
  await benchmarkReady(page);
  const initial = await stored(page);
  const mean = (await page.locator('.expected-stat strong').textContent())!;
  expect(initial.config.lockedSlots).toEqual([0]);
  expect(initial.state.lockedSlots).toEqual([0]);
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('보조 줄 도전 중');
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('첫 줄 고정 · 잠금 1/2줄');
  await expect(page.locator('.current-result').getByLabel('1번째 줄 자동 잠금')).toBeVisible();
  await forceOneRoll(page, ['passiveSkillLevel', 'bossDamagePercent', 'dexFlat'], 3);
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('마지막 보조 줄 도전 중');
  await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('첫 줄 고정 · 잠금 2/2줄');
  const acquired = await stored(page);
  expect(acquired.state.lockedSlots).toEqual([0, 1]);
  expect(acquired.state.spent.meso).toBe(18000000n);
  expect(acquired.state.spent.honor).toBe(90000n);
  for (const candidate of acquired.state.candidates)
    expect(candidate.lines[0]).toEqual(initial.state.lines[0]);
  await expect(page.locator('.expected-stat strong')).toHaveText(mean);
  await page.reload();
  await benchmarkReady(page);
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('firstLocked');
  expect((await stored(page)).state.lockedSlots).toEqual([0, 1]);
  await forceOneRoll(
    page,
    ['passiveSkillLevel', 'bossDamagePercent', 'statusAilmentDamagePercent'],
    3,
  );
  await expect(page.locator('.status-badge')).toHaveText('목표 달성');
  const completed = await stored(page);
  expect(completed.config.start).toEqual(initial.config.start);
  expect(completed.state.lockedSlots).toEqual([0, 1]);
  expect(completed.state.attempts).toBe(6n);
  expect(completed.state.spent.meso).toBe(63000000n);
  expect(completed.state.spent.honor).toBe(210000n);
  for (const candidate of completed.state.candidates)
    expect(candidate.lines.slice(0, 2)).toEqual(acquired.state.lines.slice(0, 2));
  await benchmarkReady(page);
  await expect(page.locator('.expected-stat strong')).toHaveText(mean);
});

test('fixed first ability line accepts either lower slot for two goals and persists through target controls', async ({
  page,
}) => {
  await boot(page);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await selectStart(page, ['passiveSkillLevel', 'strFlat', 'dexFlat']);
  await page.getByLabel('어빌리티 진행 방식').selectOption('firstLocked');
  await page.getByLabel('어빌리티 목표 줄 수').selectOption('2');
  await page.getByLabel('직업별 종결 어빌리티').selectOption('메르세데스');
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('firstLocked');
  await expect(page.getByLabel('어빌리티 목표 줄 수')).toHaveValue('2');
  for (const lowerSlot of [1, 2]) {
    await selectStart(page, ['passiveSkillLevel', 'strFlat', 'dexFlat']);
    await benchmarkReady(page);
    const original = await stored(page);
    const result = ['passiveSkillLevel', 'strFlat', 'dexFlat'];
    result[lowerSlot] = 'bossDamagePercent';
    await forceOneRoll(page, result, 3);
    await expect(page.locator('.status-badge')).toHaveText('목표 달성');
    await expect(page.getByLabel('어빌리티 자동 잠금 진행')).toContainText('두 줄 완성');
    const completed = await stored(page);
    expect(completed.config.abilityStrategy).toBe('firstLocked');
    expect(completed.state.lines[0]).toEqual(original.state.lines[0]);
    expect(completed.state.lockedSlots).toEqual([0, lowerSlot]);
    expect(completed.state.spent.meso).toBe(18000000n);
    expect(completed.state.spent.honor).toBe(90000n);
  }
  await page.getByLabel('어빌리티 목표 줄 수').selectOption('3');
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('firstLocked');
  await expect(page.getByLabel('목표 조건 3 옵션')).toHaveValue('criticalRatePercent');
  expect((await stored(page)).config.lockedSlots).toEqual([0]);
});

test('fixed first ability line must satisfy its first goal before simulation is enabled', async ({
  page,
}) => {
  await boot(page);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await selectStart(page, ['attackFlat', 'strFlat', 'dexFlat']);
  await page.getByLabel('어빌리티 진행 방식').selectOption('firstLocked');
  await expect(page.getByRole('alert')).toContainText(
    '고정할 첫째 줄이 첫 줄 목표를 만족하지 않습니다',
  );
  await expect(page.getByRole('button', { name: '자동 재설정', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '3회 재설정하기', exact: true })).toBeDisabled();
  await expect(page.locator('.expected-stat strong')).not.toContainText(/\d/);
  await expect(page.locator('.expected-stat')).not.toContainText('같은 조건의 평균 소비');
  await page.getByLabel('1번째 시작 옵션').selectOption({
    label: `[레전드리] ${maximum('passiveSkillLevel').label}`,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await benchmarkReady(page);
  await expect(page.getByRole('button', { name: '자동 재설정', exact: true })).toBeEnabled();
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('firstLocked');
  expect((await stored(page)).state.lockedSlots).toEqual([0]);
});

test('fixed first ability line remains fixed during real automatic execution and pause resume', async ({
  page,
}) => {
  await page.route('**/assets/simulator.worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `self.crypto.getRandomValues = array => { array.fill(0); return array; };\n${await response.text()}`,
    });
  });
  await boot(page);
  await page.getByLabel('직업별 종결 어빌리티').selectOption('나이트로드');
  await selectStart(page, ['passiveSkillLevel', 'bossDamagePercent', 'dexFlat']);
  await page.getByLabel('어빌리티 진행 방식').selectOption('firstLocked');
  await benchmarkReady(page);
  const initial = await stored(page);
  const mean = (await page.locator('.expected-stat strong').textContent())!;
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.attempts).toBeGreaterThan(0n);
  await page.getByRole('button', { name: '중지', exact: true }).click();
  const paused = await stored(page);
  expect(paused.config).toEqual(initial.config);
  expect(paused.state.lockedSlots).toEqual([0, 1]);
  expect(paused.state.lines).toEqual(initial.state.lines);
  expect(paused.state.spent.meso).toBe(paused.state.attempts * 15000000n);
  expect(paused.state.spent.honor).toBe(paused.state.attempts * 40000n);
  await expect(page.getByLabel('어빌리티 진행 방식')).toHaveValue('firstLocked');
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect
    .poll(async () => (await stored(page)).state.attempts)
    .toBeGreaterThan(paused.state.attempts);
  await page.getByRole('button', { name: '중지', exact: true }).click();
  const resumed = await stored(page);
  expect(resumed.config).toEqual(initial.config);
  expect(resumed.state.lines).toEqual(initial.state.lines);
  expect(resumed.state.spent.meso).toBeGreaterThan(paused.state.spent.meso);
  await benchmarkReady(page);
  await expect(page.locator('.expected-stat strong')).toHaveText(mean);
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
