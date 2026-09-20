import { expect, type Page } from '@playwright/test';

const simulatorGroups: Record<string, string> = {
  큐브: '장비 강화',
  추가옵션: '장비 강화',
  스타포스: '장비 강화',
  어빌리티: '어빌리티',
  '어빌리티 최적화': '어빌리티',
  '소울 증폭': '소울',
  '소울 잠재': '소울',
};

export async function selectSimulator(page: Page, name: string) {
  const group = simulatorGroups[name];
  if (!group) throw new Error(`Unknown simulator: ${name}`);
  const navigation = page.getByRole('navigation', { name: '시뮬레이터', exact: true });
  await navigation.getByRole('button', { name: `${group} 분류`, exact: true }).click();
  const tab = navigation.getByRole('button', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-current', 'page');
}
