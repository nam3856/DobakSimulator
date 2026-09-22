import { expect, test } from '@playwright/test';
import { deserialize, type StoredSession } from '../../src/ui/storage';
import { selectSimulator } from './helpers/navigation';

test.beforeEach(async ({ page }) => {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
});

test('normal reset applies each result, charges honor, and restores the normal tab on reload', async ({
  page,
}) => {
  await page.goto('./#abilityNormal');
  await expect(page.getByRole('button', { name: '일반 재설정', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('button', { name: '3회 비교', exact: true })).toBeDisabled();
  await expect(page.getByLabel('일반 재설정 안내')).toContainText('8,000');
  await page.getByLabel('목표 조건 1 옵션', { exact: true }).selectOption('attackFlat');
  await page.getByLabel('목표 조건 1 수치', { exact: true }).fill('30');
  const roll = page.getByRole('button', { name: '1회 재설정하기', exact: true });
  await expect(roll).toBeEnabled();
  await roll.click();
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  await expect(page.locator('.spent-stat')).toContainText('사용한 명성치');
  await expect(page.locator('.spent-stat strong')).toContainText('8,000');
  const raw = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    return localStorage.getItem('isekai-jikjak:session:v1')!;
  });
  const saved = deserialize<StoredSession>(raw);
  expect(saved.config.abilityResetMode).toBe('normal');
  expect(saved.state.spent.honor).toBe(8000n);
  expect(saved.state.spent.meso).toBe(0n);
  expect(saved.state.lines).toEqual(saved.state.candidates[0].lines);
  expect(saved.state.lines.slice(1).every((line) => line.grade !== 'legendary')).toBe(true);
  await page.reload();
  await expect(page).toHaveURL(/#abilityNormal$/);
  await expect(page.getByRole('button', { name: '일반 재설정', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('1회');
  await selectSimulator(page, '고급 재설정');
  await expect(page).toHaveURL(/#ability$/);
  await expect(page.getByRole('button', { name: '3회 비교', exact: true })).toBeEnabled();
  await selectSimulator(page, '일반 재설정');
  await expect(page.getByRole('button', { name: '3회 비교', exact: true })).toBeDisabled();
});
