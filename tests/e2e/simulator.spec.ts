import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
});

async function boot(page: Page, hash = '#cube') {
  await page.goto(`./${hash}`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toBeVisible();
  await expect(page.locator('.expected-stat')).not.toContainText('계산 중');
}
const nav = (page: Page, name: string) =>
  page.getByRole('navigation').getByRole('button', { name, exact: true });

async function setUnsuccessfulCubeStart(page: Page) {
  const details = page.locator('.start-details');
  if (!(await details.evaluate((element: HTMLDetailsElement) => element.open)))
    await details.locator('summary').click();
  // The imported weapon already meets its initial goal. Explicit STR lines let this test roll.
  for (const slot of [1, 2, 3])
    await page.getByLabel(`${slot}번째 시작 옵션`).selectOption({ index: 1 });
  await expect(page.locator('.expected-stat')).toContainText('같은 조건의 평균 소비');
}

test('bundled character, Worker benchmark and hash reload work under the Pages subpath', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
  await setUnsuccessfulCubeStart(page);
  await expect(page.locator('.expected-stat')).toContainText('같은 조건의 평균 소비');
  await expect(page.locator('.portrait-frame img')).toHaveJSProperty('naturalWidth', 300);
  await nav(page, '소울 증폭').click();
  await page.reload();
  await expect(page).toHaveURL(/#soulAmplification$/);
  await expect(page.getByRole('heading', { name: '소울 증폭 시뮬레이터' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('three comparison rolls charge all three and persist BigInt costs', async ({ page }) => {
  await boot(page);
  await setUnsuccessfulCubeStart(page);
  await expect(page.getByRole('button', { name: '3회 비교', exact: true })).toHaveClass(/selected/);
  await page.getByRole('button', { name: '3회 재설정하기', exact: true }).click();
  await expect(page.locator('.stat-card').first().locator('strong')).toContainText('3');
  await expect(page.locator('.candidate-card')).toHaveCount(3);
  const cost = await page.locator('.spent-stat strong').getAttribute('title');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('isekai-jikjak:session:v1') ?? ''))
    .toContain('"$bigint":"3"');
  await page.reload();
  await expect(page.locator('.spent-stat strong')).toHaveAttribute('title', cost!);
  await expect(page.locator('.candidate-card')).toHaveCount(3);
});

test('both prime cubes preserve the acquired first line and account for credits', async ({
  page,
}) => {
  await boot(page);
  for (const [name, credits] of [
    ['프라임큐브', '1만'],
    ['프라임 에디셔널', '2만'],
  ]) {
    await page
      .locator('.cube-picker')
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click();
    await page.getByRole('button', { name: '1회', exact: true }).click();
    // Make an explicit unsuccessful suffix; free setup can legitimately hit the target.
    await page.getByLabel('2번째 시작 옵션').selectOption({ index: 1 });
    await page.getByLabel('3번째 시작 옵션').selectOption({ index: 1 });
    const anchor = await page.locator('.current-result .option-row').first().innerText();
    await page.getByRole('button', { name: '1회 재설정하기', exact: true }).click();
    await expect(page.locator('.candidate-card .option-row').first()).toHaveText(anchor);
    await expect(page.locator('.resource-ledger')).toContainText(credits);
    await expect(page.getByLabel('시작 등급')).toBeDisabled();
  }
});

test('soul potential starts with a three-comparison preference and uses it after legendary', async ({
  page,
}) => {
  await boot(page, '#soulPotential');
  await expect(page.getByLabel('시작 등급')).toHaveValue('rare');
  await expect(page.getByRole('button', { name: '3회 비교', exact: true })).toHaveClass(/selected/);
  await page.getByRole('button', { name: '1회 재설정하기', exact: true }).click();
  await expect(page.locator('.candidate-card')).toHaveCount(1);
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');

  await page.getByLabel('시작 등급').selectOption('legendary');
  await page.getByLabel('목표 조건 1 수치').fill('6');
  await page.locator('.start-details summary').click();
  for (const slot of [1, 2, 3])
    await page.getByLabel(`${slot}번째 시작 옵션`).selectOption({ index: 1 });
  await expect(page.getByRole('button', { name: '3회 비교', exact: true })).toHaveClass(/selected/);
  await page.getByRole('button', { name: '3회 재설정하기', exact: true }).click();
  await expect(page.locator('.candidate-card')).toHaveCount(3);
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('3회');
  await expect(page.locator('.spent-stat strong')).toHaveAttribute('title', '264,000,000');

  await page.getByLabel('시작 등급').selectOption('unique');
  await page.getByRole('button', { name: '1회', exact: true }).click();
  await expect(page.getByRole('button', { name: '1회', exact: true })).toHaveClass(/selected/);
  await page.reload();
  await expect(page.getByLabel('시작 등급')).toHaveValue('unique');
  await expect(page.getByRole('button', { name: '1회', exact: true })).toHaveClass(/selected/);
  await page.getByLabel('시작 등급').selectOption('legendary');
  await expect(page.getByRole('button', { name: '1회 재설정하기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '1회', exact: true })).toHaveClass(/selected/);
});

test('soul amplification auto completes with a final avatar and displayed percentile', async ({
  page,
}) => {
  await boot(page, '#soulAmplification');
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect(page.locator('.status-badge')).toHaveText('목표 달성');
  await expect(page.locator('.luck-badge')).toContainText(/P<?[\d.]/);
  await expect(page.locator('.ratio-copy')).toContainText('기댓값의');
  await expect(page.locator('.resource-ledger')).toContainText('4단계 에테르');
  await expect(page.getByRole('button', { name: '증폭 시도하기' })).toBeDisabled();
  const image = page.locator('.stage-sprite');
  await expect(image).toHaveJSProperty('naturalWidth', 300);
});

test('ability automation stops, resumes and has no final luck verdict while unfinished', async ({
  page,
}) => {
  await boot(page, '#ability');
  await expect(page.getByLabel('한 번에 자동 실행할 최대 횟수')).toHaveCount(0);
  await page.getByLabel('어빌리티 진행 방식').selectOption('fixed');
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await page.getByRole('button', { name: '중지', exact: true }).click();
  await expect(page.getByRole('button', { name: '자동 재설정', exact: true })).toBeEnabled();
  await expect(page.locator('.luck-badge')).toHaveCount(0);
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await page.getByRole('button', { name: '중지', exact: true }).click();
  await expect(page.locator('.luck-badge')).toHaveCount(0);
});

test('two ability locks survive a roll and consume the corresponding honor and mesos', async ({
  page,
}) => {
  await boot(page, '#ability');
  await page.getByLabel('어빌리티 진행 방식').selectOption('fixed');
  await page.getByRole('button', { name: '1회', exact: true }).click();
  // Switching to manual preserves the already acquired lower locks; set this test's own pair.
  for (const slot of [1, 2, 3]) {
    const unlock = page.getByRole('button', { name: `${slot}번째 옵션 잠금 해제`, exact: true });
    if (await unlock.count()) await unlock.click();
  }
  await page.getByLabel('목표 조건 2 등급').selectOption('unique');
  await page.getByLabel('목표 조건 2 수치').fill('8');
  await page.getByLabel('목표 조건 3 옵션').selectOption('buffDurationPercent');
  await page.getByLabel('목표 조건 3 수치').fill('44');
  await page.getByRole('button', { name: '1번째 옵션 잠금', exact: true }).click();
  await page.getByRole('button', { name: '2번째 옵션 잠금', exact: true }).click();
  const before = await page.locator('.current-result .option-row').allTextContents();
  await page.getByRole('button', { name: '1회 재설정하기', exact: true }).click();
  const after = await page.locator('.candidate-card .option-row').allTextContents();
  expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
  await expect(page.locator('.spent-stat')).toContainText('1,500만');
  await expect(page.locator('.spent-stat')).toContainText('명성치 4만');
});

test('already satisfied starts get no final luck label; impossible exact goals do not show finite means', async ({
  page,
}) => {
  await boot(page);
  await expect(page.locator('.expected-stat')).toContainText('시작 상태가 이미 목표를 만족');
  await expect(page.locator('.luck-badge')).toHaveCount(0);
  await page.getByLabel('성공 기준').selectOption('exact');
  await page.getByLabel('장비 부위').selectOption('gloves');
  await expect(page.locator('.expected-stat')).toContainText('달성할 수 없음');
  await expect(page.locator('.expected-stat strong')).toContainText('∞');
});

test('360px layout, keyboard dialog and reduced motion remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Force the minimum-cost path in the run Worker; benchmark probabilities stay official.
  await page.route('**/assets/simulator.worker-*.js', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `self.crypto.getRandomValues = array => { array.fill(0); return array; };\n${await response.text()}`,
    });
  });
  await boot(page, '#soulAmplification');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('캐릭터 닉네임')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toBeFocused();
  await page.getByRole('button', { name: '자동 재설정', exact: true }).click();
  await expect(page.locator('.stage-sprite')).toHaveClass(/reaction-jackpot/);
  expect(
    await page.locator('.stage-sprite').evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});

test('clamping an edited aggregate goal after promotion keeps the actual promoted state', async ({
  page,
}) => {
  await boot(page);
  await page.getByLabel('시작 등급').selectOption('unique');
  await page.getByLabel('등급 상승 누적 실패').fill('107');
  await page.getByRole('button', { name: '1회 재설정하기', exact: true }).click();
  await expect(page.locator('.current-result .grade-badge')).toHaveText('레전드리');
  const promoted = await page.locator('.current-result .option-row').allTextContents();
  const goalValue = page.getByLabel('목표 조건 1 수치');
  const maximum = await goalValue.getAttribute('max');
  expect(Number(maximum)).toBeGreaterThan(0);
  await goalValue.fill('99');
  await goalValue.press('Enter');
  await expect(goalValue).toHaveValue(maximum!);
  await expect(page.getByLabel('시작 등급')).toHaveValue('legendary');
  expect(await page.locator('.current-result .option-row').allTextContents()).toEqual(promoted);
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('0회');
});

test('cube and soul numeric limits preserve aggregate targets and clamp out-of-range input', async ({
  page,
}) => {
  await boot(page);
  const value = page.getByLabel('목표 조건 1 수치');
  await page.getByLabel('장비 부위').selectOption('weapon');
  await page.getByLabel('목표 조건 1 옵션').selectOption('attackPercent');
  const maximum = Number(await value.getAttribute('max'));
  expect(maximum).toBeGreaterThanOrEqual(24);
  await value.fill('24');
  await value.press('Tab');
  await expect(value).toHaveValue('24');
  await value.fill('999');
  await value.press('Enter');
  await expect(value).toHaveValue(String(maximum));
  await value.fill('0');
  await value.press('Tab');
  await expect(value).toHaveValue((await value.getAttribute('min'))!);
  await value.fill('');
  await value.press('Tab');
  await expect(value).toHaveValue((await value.getAttribute('min'))!);

  await nav(page, '소울 잠재').click();
  await expect(value).toHaveValue('5');
  await expect(value).toHaveAttribute('max', '6');
  await value.fill('999');
  await value.press('Enter');
  await expect(value).toHaveValue('6');
  await page.reload();
  await expect(value).toHaveValue('6');
  await value.fill('-5');
  await value.press('Tab');
  await expect(value).toHaveValue((await value.getAttribute('min'))!);
});

test('API error and cancellation retain the previous character and never store the key', async ({
  page,
}) => {
  await boot(page);
  await page.route('https://open.api.nexon.com/maplestory/v1/**', (route) =>
    route.fulfill({ status: 400, json: { error: { name: 'OPENAPI00005' } } }),
  );
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
  await expect(page.getByLabel('캐릭터 닉네임')).toHaveValue('');
  await page.getByLabel('캐릭터 닉네임').fill('깽미니');
  await page.getByLabel('개인 Nexon Open API 키').fill('test-memory-only-key');
  await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('유효하지 않은');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    'test-memory-only-key',
  );
  await page.unroute('https://open.api.nexon.com/maplestory/v1/**');
  await page.route('https://open.api.nexon.com/maplestory/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.fulfill({ json: { ocid: 'cancelled' } }).catch(() => {});
  });
  await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
  await page.getByRole('button', { name: '캐릭터 검색 닫기' }).click();
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
});

test('nickname replacement accepts missing presets and falls back when pose images fail', async ({
  page,
}) => {
  const png = readFileSync(new URL('../../public/character/neutral.png', import.meta.url));
  await boot(page);
  await page.route('https://open.api.nexon.com/maplestory/v1/**', (route) => {
    const url = route.request().url();
    const json = url.includes('/id?')
      ? { ocid: 'fixture' }
      : url.includes('/basic?')
        ? {
            character_name: '새캐릭터',
            character_class: '메카닉',
            character_level: 290,
            world_name: '오로라',
            character_image:
              'https://open.api.nexon.com/static/maplestory/character/look/test-avatar',
          }
        : {};
    return route.fulfill({ json });
  });
  await page.route(
    'https://open.api.nexon.com/static/maplestory/character/look/test-avatar**',
    (route) =>
      route.request().url().includes('action=')
        ? route.abort()
        : route.fulfill({ contentType: 'image/png', body: png }),
  );
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
  await page.getByLabel('캐릭터 닉네임').fill('새캐릭터');
  await page.getByLabel('개인 Nexon Open API 키').fill('test-key');
  await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('새캐릭터');
  await expect(page.locator('.stage-sprite')).toHaveAttribute('src', /test-avatar$/);
  await expect(page.locator('.stage-sprite')).toHaveJSProperty('naturalWidth', 300);
  await expect(page.locator('.reaction-stage')).toContainText('새캐릭터');
});
