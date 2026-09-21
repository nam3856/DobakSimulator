import { test, expect, type Page } from '@playwright/test';
import { selectSimulator } from './helpers/navigation';
import { readFileSync } from 'node:fs';
import type { CharacterSnapshot } from '../../src/types';

const SITE_URL = 'https://nam3856.github.io/DobakSimulator/';
const SITE_TITLE = '이세계 직작 — 메이플스토리 통합 강화 시뮬레이터';
const SHARED_API = 'https://fixture-api.example/api';

function characterFixture(name: string): CharacterSnapshot {
  const character = JSON.parse(
    readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
  ) as CharacterSnapshot;
  character.name = name;
  character.imageUrl = 'http://127.0.0.1:4173/DobakSimulator/character/neutral.png';
  for (const items of Object.values(character.equipmentPresets))
    for (const item of items) item.imageUrl = character.imageUrl;
  return character;
}

async function configureCharacter(page: Page, name: string) {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: SHARED_API } }),
  );
  await page.route(`${SHARED_API}/character?*`, (route) =>
    route.fulfill({ json: characterFixture(name) }),
  );
  await page.route('https://open.api.nexon.com/maplestory/v1/**', (route) => route.abort());
}

async function stubClipboard(page: Page, rejectWrites = false) {
  await page.addInitScript(
    ({ rejectWrites }) => {
      const copiedShareLinks: string[] = [];
      Object.defineProperty(window, 'copiedShareLinks', { value: copiedShareLinks });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            if (rejectWrites) throw new DOMException('Clipboard access denied', 'NotAllowedError');
            copiedShareLinks.push(value);
          },
        },
      });
    },
    { rejectWrites },
  );
}

function expectedShareUrl(name: string, mode: string) {
  const url = new URL('/share', SHARED_API);
  url.searchParams.set('character', name);
  url.searchParams.set('mode', mode);
  return url.href;
}

async function lastCopiedLink(page: Page) {
  return page.evaluate(() =>
    (window as Window & { copiedShareLinks?: string[] }).copiedShareLinks?.at(-1),
  );
}

test('initial HTML exposes searchable metadata, verification and the canonical sitemap URL', async ({
  request,
  page,
}) => {
  const response = await request.get('./');
  expect(response.ok()).toBe(true);
  const metadata = await page.evaluate(
    (source) => {
      const document = new DOMParser().parseFromString(source, 'text/html');
      const content = (selector: string) =>
        document.querySelector(selector)?.getAttribute('content');
      return {
        title: document.title,
        description: content('meta[name="description"]'),
        openGraphTitle: content('meta[property="og:title"]'),
        openGraphDescription: content('meta[property="og:description"]'),
        canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
        verification: content('meta[name="google-site-verification"]'),
        robots: content('meta[name="robots"]'),
      };
    },
    await response.text(),
  );

  expect(metadata.title).toBe(SITE_TITLE);
  expect(metadata.description).toContain('메이플스토리');
  expect(metadata.description).toContain('통합 강화 시뮬레이터');
  expect(metadata.openGraphTitle).toBe(SITE_TITLE);
  expect(metadata.openGraphDescription).toBeTruthy();
  expect(metadata.canonical).toBe(SITE_URL);
  expect(metadata.verification).toBe('Debm8DJNNZyf4MuSZVmTN5RqocTv1vnR-iPiRtmElTU');
  expect(metadata.robots ?? '').not.toMatch(/noindex/i);

  const sitemap = await request.get('./sitemap.xml');
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).toMatch(
    /<loc>\s*https:\/\/nam3856\.github\.io\/DobakSimulator\/\s*<\/loc>/,
  );
});

test('loaded character metadata and copied links use the returned nickname and current tab', async ({
  page,
}) => {
  const name = '공유검객';
  await configureCharacter(page, name);
  await stubClipboard(page);
  await page.goto(`./?v=preview&character=${encodeURIComponent('공유요청캐릭터')}#cube`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText(name);
  await expect(page).toHaveTitle(`이세계의 ${name}으로 강화하기 | 이세계 직작`);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    new RegExp(`^이세계의 ${name}으로 강화하기`),
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', SITE_URL);

  for (const [mode, label] of [
    ['cube', '큐브'],
    ['starforce', '스타포스'],
    ['bonusOptions', '추가옵션'],
    ['abilityOptimizer', '어빌리티 최적화'],
    ['ability', '어빌리티'],
    ['soulAmplification', '소울 증폭'],
    ['soulPotential', '소울 잠재'],
  ]) {
    if (mode !== 'cube') await selectSimulator(page, label);
    const share = page.getByRole('button', { name: '캐릭터 공유 링크 복사', exact: true });
    if (mode === 'abilityOptimizer') {
      await expect(share).toHaveCount(0);
      const optimizer = page.getByRole('region', { name: '어빌리티 최적화', exact: true });
      await expect(optimizer.getByRole('button')).toHaveCount(1);
      await expect(optimizer.getByRole('button', { name: '시작하기', exact: true })).toBeVisible();
    } else {
      await expect(share).toBeVisible();
      await share.click();
      await expect.poll(() => lastCopiedLink(page)).toBe(expectedShareUrl(name, mode));
    }
    expect(new URL(page.url()).hash).toBe(`#${mode}`);
    expect(new URL(page.url()).searchParams.get('character')).toBe(name);
    await expect(page).toHaveTitle(`이세계의 ${name}으로 강화하기 | 이세계 직작`);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      new RegExp(`^이세계의 ${name}으로 강화하기`),
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', SITE_URL);
  }
});

test('searching the displayed default character updates the new nickname URL metadata', async ({
  page,
}) => {
  await configureCharacter(page, '깽미니');
  await page.goto('./');
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText('깽미니');
  await expect(page).toHaveTitle(SITE_TITLE);
  await page.getByRole('button', { name: '캐릭터 검색 열기' }).click();
  await page.getByRole('dialog').getByRole('textbox').first().fill('깽미니');
  await page.getByRole('button', { name: '캐릭터 불러오기', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveTitle('이세계의 깽미니로 강화하기 | 이세계 직작');
  expect(new URL(page.url()).searchParams.get('character')).toBe('깽미니');
});

test('clipboard denial leaves a selectable character share link with the current mode', async ({
  page,
}) => {
  const name = '직접복사캐릭터';
  await configureCharacter(page, name);
  await stubClipboard(page, true);
  await page.goto(`./?character=${encodeURIComponent(name)}#soulAmplification`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기' })).toContainText(name);
  await page.getByRole('button', { name: '캐릭터 공유 링크 복사', exact: true }).click();
  const link = page.getByLabel('캐릭터 공유 링크', { exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveValue(expectedShareUrl(name, 'soulAmplification'));
  await expect(link).toHaveAttribute('readonly', '');
  expect(await lastCopiedLink(page)).toBeUndefined();
});
