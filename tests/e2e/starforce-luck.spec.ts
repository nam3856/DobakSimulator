import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { StarforceRules } from '../../src/engine/starforce';

const rules: StarforceRules = JSON.parse(
  readFileSync(new URL('../../public/rules/starforce.json', import.meta.url), 'utf8'),
);
// An independent geometric fixture makes every cost ratio and percentile auditable.
rules.transitions[0] = {
  ...rules.transitions[0],
  successProbability: 0.05,
  maintainProbability: 0.95,
  decreaseProbability: 0,
  destroyProbability: 0,
};

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  await page.route('**/rules/starforce.json', (route) => route.fulfill({ json: rules }));
  await page.addInitScript(() => {
    Math.random = () => 0;
    const controls = window as unknown as { failures: number; draws: number };
    controls.failures = 0;
    controls.draws = 0;
    crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint32Array).fill(controls.draws++ < controls.failures ? 2147483648 : 0);
      return array;
    };
  });
  const time = new Date('2026-09-18T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  await page.goto('./#starforce');
  await expect(page.locator('.sf-stats .expected-stat')).not.toContainText('계산 중');
  await page.getByRole('combobox', { name: '스타포스 장비', exact: true }).selectOption('manual');
  await page.getByRole('combobox', { name: '시작 스타포스', exact: true }).selectOption('0');
  await page.getByRole('combobox', { name: '목표 스타포스', exact: true }).selectOption('1');
  await expect(page.locator('.sf-distribution')).toBeVisible();
});

for (const scenario of [
  { attempts: 1, reaction: 'jackpot', message: '아 게임에서 돌릴걸..', ratio: '5.0%' },
  { attempts: 9, reaction: 'happy', message: '이 정도면 꽤 싸게 먹혔다!', ratio: '45.0%' },
  { attempts: 10, reaction: 'happy', message: '어? 생각보다 얼마 안 썼네?', ratio: '50.0%' },
  { attempts: 20, reaction: 'neutral', message: '그래, 이 정도면 잘했다.', ratio: '100.0%' },
  { attempts: 30, reaction: 'cry', message: '아무튼 내가 이긴거야..', ratio: '150.0%' },
  { attempts: 60, reaction: 'ghost', message: '이세계여서 다행이다…', ratio: '300.0%' },
]) {
  test(`${scenario.reaction} at ${scenario.attempts} attempts: completed cost, inclusive percentile, reaction and graph agree and reset`, async ({
    page,
  }) => {
    await page.evaluate((failures) => {
      const controls = window as unknown as { failures: number; draws: number };
      controls.failures = failures;
      controls.draws = 0;
    }, scenario.attempts - 1);
    await expect(page.locator('.luck-badge')).toHaveCount(0);
    await expect(page.locator('.sf-distribution')).toContainText('50만 표본 · 추정 분포');
    await expect(page.locator('.chart-actual')).toHaveCount(0);
    await page.getByRole('button', { name: '자동 강화', exact: true }).click();
    await page.clock.runFor(1333 * scenario.attempts);
    await expect(page.locator('.reaction-stage')).toHaveClass(
      new RegExp(`is-${scenario.reaction}`),
    );
    await expect(page.locator('.reaction-stage h3')).toHaveText(scenario.message);
    await expect(page.locator('.ratio-copy')).toContainText(scenario.ratio);
    if (scenario.reaction === 'ghost') {
      await expect(page.locator('.stage-sprite')).toHaveAttribute(
        'src',
        /\/character\/ghost\.png$/,
      );
      await expect(page.locator('.reaction-tombstone')).toBeVisible();
      expect(
        await page.locator('.stage-sprite').evaluate((element) => {
          const style = getComputedStyle(element);
          return { name: style.animationName, repetitions: style.animationIterationCount };
        }),
      ).toEqual({ name: 'ghost-hover', repetitions: 'infinite' });
    }
    const percentile = Number(
      (await page.locator('.luck-badge').innerText()).match(/P([\d.]+)/)![1],
    );
    expect(Math.abs(percentile / 100 - (1 - 0.95 ** scenario.attempts))).toBeLessThan(0.005);
    await expect(page.locator('.chart-actual-label')).toHaveText('이번의 나');
    await expect(page.getByRole('img', { name: '목표 달성 비용 누적 분포' })).toBeVisible();
    await page.getByRole('button', { name: '다시 자동 강화', exact: true }).click();
    await expect(page.locator('.luck-badge')).toHaveCount(0);
    await expect(page.locator('.chart-actual')).toHaveCount(0);
    await expect(page.locator('.reaction-tombstone')).toHaveCount(0);
    await page.getByRole('button', { name: '중단', exact: true }).click();
    await page.reload();
    await expect(page.locator('.sf-stats .stat-card').first().locator('strong')).toHaveText('0회');
    await expect(page.locator('.luck-badge')).toHaveCount(0);
    await expect(page.locator('.chart-actual')).toHaveCount(0);
    await expect(page.locator('.reaction-tombstone')).toHaveCount(0);
  });
}

test('paused and already complete runs have no verdict; mobile reactions respect reduced motion and image fallback', async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as unknown as { failures: number }).failures = 1;
  });
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.clock.runFor(600);
  await page.getByRole('button', { name: '중단', exact: true }).click();
  await expect(page.locator('.luck-badge')).toHaveCount(0);
  await expect(page.locator('.chart-actual')).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/character/*.png', (route) => route.abort());
  await page.getByRole('button', { name: '자동 강화', exact: true }).click();
  await page.clock.runFor(1333);
  await expect(page.locator('.reaction-stage')).toHaveClass(/is-jackpot/);
  await expect(page.locator('.stage-sprite')).not.toHaveAttribute(
    'src',
    /\/character\/jackpot\.png$/,
  );
  for (const theme of ['dark', 'light']) {
    if ((await page.locator('html').getAttribute('data-theme')) !== theme)
      await page
        .getByRole('button', { name: theme === 'dark' ? '어두운 테마' : '밝은 테마', exact: true })
        .click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      360,
    );
    await expect(page.locator('.reaction-stage h3')).toHaveText('이게 뜬다고? 오늘은 내 날이다!');
    expect(
      await page.locator('.stage-sprite').evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
  }
  await page.getByRole('combobox', { name: '시작 스타포스', exact: true }).selectOption('1');
  await expect(page.locator('.reaction-stage')).toContainText('이미 목표에 도착해 있어요.');
  await expect(page.locator('.luck-badge')).toHaveCount(0);
  await expect(page.locator('.sf-distribution')).toHaveCount(0);
});
