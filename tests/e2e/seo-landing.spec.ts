import { expect, test, type Page } from '@playwright/test';

const siteOrigin = 'https://nam3856.github.io';
const simulators = [
  { slug: 'cube', mode: 'cube', keyword: '큐브 시뮬레이터', tab: '큐브' },
  {
    slug: 'ability',
    mode: 'ability',
    keyword: '어빌리티 고급 재설정 시뮬레이터',
    tab: '고급 재설정',
  },
  {
    slug: 'soul-amplification',
    mode: 'soulAmplification',
    keyword: '소울 증폭 시뮬레이터',
    tab: '소울 증폭',
  },
  {
    slug: 'soul-potential',
    mode: 'soulPotential',
    keyword: '소울 잠재 시뮬레이터',
    tab: '소울 잠재',
  },
  {
    slug: 'ability-optimizer',
    mode: 'abilityOptimizer',
    keyword: '어빌리티 최적화',
    tab: '어빌리티 최적화',
  },
] as const;

function guidePath(slug: string) {
  return `/DobakSimulator/simulators/${slug}/`;
}

function launchPath(mode: string) {
  return `/DobakSimulator/#${mode}`;
}

async function inspectSource(page: Page, html: string) {
  return page.evaluate((source) => {
    const document = new DOMParser().parseFromString(source, 'text/html');
    const content = (selector: string) => document.querySelector(selector)?.getAttribute('content');
    const schemaObjects: Record<string, unknown>[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        schemaObjects.push(value as Record<string, unknown>);
        Object.values(value).forEach(visit);
      }
    };
    const schemaScripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    schemaScripts.forEach((script) => visit(JSON.parse(script.textContent ?? '')));
    return {
      title: document.title,
      description: content('meta[name="description"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      robots: content('meta[name="robots"]'),
      ogTitle: content('meta[property="og:title"]'),
      ogDescription: content('meta[property="og:description"]'),
      ogUrl: content('meta[property="og:url"]'),
      h1: [...document.querySelectorAll('h1')].map((heading) => heading.textContent?.trim()),
      body: document.body.textContent ?? '',
      links: [...document.querySelectorAll('a[href]')].map((link) => link.getAttribute('href')!),
      assets: [
        ...[...document.querySelectorAll('img[src], script[src], source[src]')].map(
          (asset) => asset.getAttribute('src')!,
        ),
        ...[
          ...document.querySelectorAll(
            'link[rel="stylesheet"], link[rel~="icon"], link[rel="apple-touch-icon"]',
          ),
        ].map((asset) => asset.getAttribute('href')!),
        content('meta[property="og:image"]'),
        content('meta[name="twitter:image"]'),
      ].filter((value): value is string => Boolean(value)),
      schemaCount: schemaScripts.length,
      schemaContexts: schemaObjects.map((object) => object['@context']),
      schemaTypes: schemaObjects.flatMap((object) => object['@type'] ?? []),
      schemaUrls: schemaObjects.map((object) => object.url),
      schemaNames: schemaObjects.map((object) => object.name),
    };
  }, html);
}

async function expectNoOverflow(page: Page, width: number) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.viewport).toBe(width);
  expect(dimensions.document).toBeLessThanOrEqual(width);
  expect(dimensions.body).toBeLessThanOrEqual(width);
}

async function tapCardSurface(page: Page, mode: string, surface: 'h3' | '.card-description') {
  const card = page.locator(`.simulator-card[data-simulator="${mode}"]`);
  await card.scrollIntoViewIfNeeded();
  const target = await card.locator(surface).boundingBox();
  const bounds = await card.boundingBox();
  await card.tap({
    position: {
      x: target!.x - bounds!.x + target!.width / 2,
      y: target!.y - bounds!.y + target!.height / 2,
    },
  });
}

async function expectSelectedSimulator(page: Page, simulator: (typeof simulators)[number]) {
  await expect(page).toHaveURL(new RegExp(`/DobakSimulator/#${simulator.mode}$`));
  const navigation = page.getByRole('navigation', { name: '시뮬레이터', exact: true });
  await expect(
    navigation.getByRole('button', { name: simulator.tab, exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
}

test('initial HTML exposes distinct searchable guides and crawlable landing links', async ({
  request,
  page,
}) => {
  const assets = new Set<string>();
  const titles = new Set<string>();
  const descriptions = new Set<string>();

  for (const simulator of simulators) {
    const path = guidePath(simulator.slug);
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    const source = await inspectSource(page, await response.text());
    const canonical = `${siteOrigin}${path}`;
    expect(source.title).toContain(simulator.keyword);
    expect(source.title).toContain('이세계 직작');
    expect(source.description).toContain(simulator.keyword);
    expect(source.canonical).toBe(canonical);
    expect(source.robots ?? '').not.toMatch(/noindex/i);
    expect(source.ogTitle).toContain(simulator.keyword);
    expect(source.ogDescription).toBeTruthy();
    expect(source.ogUrl).toBe(canonical);
    expect(source.h1).toHaveLength(1);
    expect(source.h1[0]).toContain(simulator.keyword);
    expect(source.links).toContain(launchPath(simulator.mode));
    expect(source.schemaCount).toBeGreaterThan(0);
    expect(source.schemaContexts).toContain('https://schema.org');
    expect(source.schemaUrls).toContain(canonical);
    expect(source.schemaNames.some((name) => String(name).includes(simulator.keyword))).toBe(true);
    expect(source.schemaTypes).toContain('BreadcrumbList');
    titles.add(source.title);
    descriptions.add(source.description!);
    for (const asset of source.assets) {
      const url = new URL(asset, canonical);
      if (url.origin === siteOrigin) assets.add(`${url.pathname}${url.search}`);
    }
  }
  expect(titles.size).toBe(simulators.length);
  expect(descriptions.size).toBe(simulators.length);

  const landingResponse = await request.get('/');
  expect(landingResponse.status()).toBe(200);
  const landing = await inspectSource(page, await landingResponse.text());
  expect(landing.title).toContain('이세계 직작');
  expect(landing.canonical).toBe(`${siteOrigin}/`);
  expect(landing.robots ?? '').not.toMatch(/noindex/i);
  expect(landing.schemaCount).toBeGreaterThan(0);
  for (const simulator of simulators) {
    expect(landing.body).toContain(simulator.keyword);
    expect(landing.links).toContain(guidePath(simulator.slug));
    expect(landing.links).toContain(launchPath(simulator.mode));
  }
  for (const asset of landing.assets) {
    const url = new URL(asset, `${siteOrigin}/`);
    if (url.origin === siteOrigin) assets.add(`${url.pathname}${url.search}`);
  }
  for (const asset of assets) {
    const response = await request.get(asset);
    expect(response.status(), asset).toBe(200);
    const mime = response.headers()['content-type'];
    expect(mime, asset).not.toContain('text/html');
    if (/\.css(?:\?|$)/.test(asset)) expect(mime, asset).toContain('text/css');
    if (/\.(?:png|ico|svg|webp)(?:\?|$)/.test(asset)) expect(mime, asset).toMatch(/^image\//);
  }
});

test('sitemaps list every canonical guide and the static server preserves real HTTP semantics', async ({
  request,
  page,
}) => {
  for (const sitemapPath of ['/sitemap.xml', '/DobakSimulator/sitemap.xml']) {
    const response = await request.get(sitemapPath);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/xml');
    const sitemap = await page.evaluate(
      (source) => {
        const xml = new DOMParser().parseFromString(source, 'application/xml');
        return {
          errors: xml.querySelectorAll('parsererror').length,
          urls: [...xml.querySelectorAll('loc')].map((location) => location.textContent?.trim()),
        };
      },
      await response.text(),
    );
    expect(sitemap.errors).toBe(0);
    expect(new Set(sitemap.urls).size).toBe(sitemap.urls.length);
    expect(sitemap.urls).toContain(`${siteOrigin}/DobakSimulator/`);
    for (const simulator of simulators) {
      expect(sitemap.urls).toContain(`${siteOrigin}${guidePath(simulator.slug)}`);
    }
    for (const url of sitemap.urls) {
      expect(new URL(url!).search).toBe('');
      expect(new URL(url!).hash).toBe('');
      expect((await request.get(new URL(url!).pathname)).status(), url).toBe(200);
    }
  }
  for (const path of ['/robots.txt', '/DobakSimulator/robots.txt']) {
    const response = await request.get(path);
    expect(response.headers()['content-type']).toContain('text/plain');
    expect(await response.text()).toContain('Sitemap:');
  }
  const directory = await request.get('/DobakSimulator/simulators/cube?source=search', {
    maxRedirects: 0,
  });
  expect(directory.status()).toBe(308);
  expect(directory.headers().location).toBe('/DobakSimulator/simulators/cube/?source=search');
  for (const path of ['/missing-page', '/DobakSimulator/simulators/missing/']) {
    expect((await request.get(path)).status()).toBe(404);
  }
  for (const path of ['/%2e%2e%5cpackage.json', '/DobakSimulator/%2e%2e%5cpackage.json']) {
    expect((await request.get(path)).status()).toBe(403);
  }
});

for (const [index, width] of [320, 360, 390, 430].entries()) {
  test.describe(`mobile landing at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });

    test('guides fit the screen and touch selection launches the intended simulator', async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/app-config.json', (route) =>
        route.fulfill({ json: { characterApiBaseUrl: '' } }),
      );

      for (const simulator of simulators) {
        await page.goto(guidePath(simulator.slug));
        await expect(page.getByRole('heading', { level: 1 })).toContainText(simulator.keyword);
        const launch = page.locator(`a[href="${launchPath(simulator.mode)}"]`).first();
        await expect(launch).toBeVisible();
        const bounds = await launch.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        await expectNoOverflow(page, width);
      }

      await page.goto('/');
      for (const simulator of simulators) {
        const preview = page.getByRole('button', {
          name: `${simulator.keyword} 선택`,
          exact: true,
        });
        const bounds = await preview.boundingBox();
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
        await tapCardSurface(page, simulator.mode, index % 2 ? '.card-description' : 'h3');
        await expect(preview).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(1);
        await expect(page.locator('#selected-launch')).toHaveAttribute(
          'href',
          launchPath(simulator.mode),
        );
        await expect(page.locator('#selected-launch')).toHaveAccessibleName(
          `${simulator.keyword} 시작하기`,
        );
        await expect(page.getByRole('status')).toContainText(simulator.keyword);
        await expectNoOverflow(page, width);
      }

      // Touch covers four destinations; the keyboard case launches the fifth, the optimizer.
      const destination = simulators[index];
      await tapCardSurface(page, destination.mode, '.card-description');
      await page.locator('#selected-launch').tap();
      await expectSelectedSimulator(page, destination);
      await expectNoOverflow(page, width);
      expect(errors).toEqual([]);
    });
  });
}

test('landing selection supports keyboard activation and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: '' } }),
  );
  await page.goto('/');
  const destination = simulators[4];
  const preview = page.getByRole('button', {
    name: `${destination.keyword} 선택`,
    exact: true,
  });
  await preview.focus();
  await page.keyboard.press('Space');
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: '큐브 시뮬레이터 선택', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('status')).toContainText(destination.keyword);
  await expect(preview).toBeFocused();
  expect(await preview.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
    'none',
  );
  const launch = page.locator('#selected-launch');
  await expect(launch).toHaveAttribute('href', launchPath(destination.mode));
  await expect(launch).toHaveAccessibleName(`${destination.keyword} 시작하기`);
  for (const element of [preview, launch]) {
    const durations = await element.evaluate((node) => {
      const style = getComputedStyle(node);
      return `${style.transitionDuration},${style.animationDuration}`
        .split(',')
        .map((value) => parseFloat(value) * (value.trim().endsWith('ms') ? 0.001 : 1));
    });
    expect(Math.max(...durations)).toBeLessThanOrEqual(0.001);
  }
  await launch.focus();
  await page.keyboard.press('Enter');
  await expectSelectedSimulator(page, destination);

  // React replaces the initial app HTML; guide navigation must remain available after mount.
  const guides = page.getByRole('navigation', { name: '시뮬레이터 이용 안내', exact: true });
  await expect(guides).toBeVisible();
  for (const simulator of simulators) {
    const guide = guides.getByRole('link', { name: simulator.keyword, exact: true });
    await expect(guide).toBeVisible();
    const url = new URL(await guide.evaluate((link) => (link as HTMLAnchorElement).href));
    expect(url.origin).toBe(new URL(page.url()).origin);
    expect(url.pathname).toBe(guidePath(simulator.slug));
  }
  const guide = guides.getByRole('link', { name: destination.keyword, exact: true });
  await guide.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`${guidePath(destination.slug)}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(destination.keyword);
});

test.describe('JavaScript-disabled landing and guide navigation', () => {
  test.use({ javaScriptEnabled: false, viewport: { width: 360, height: 844 } });

  test('search visitors can read guides and follow direct simulator links without JavaScript', async ({
    page,
  }) => {
    await page.goto('/');
    for (const simulator of simulators) {
      const launch = page
        .locator('.card-start')
        .and(page.getByRole('link', { name: `${simulator.keyword} 시작하기`, exact: true }));
      await expect(launch).toBeVisible();
      await expect(launch).toHaveAttribute('href', launchPath(simulator.mode));
      const guide = page.locator(`a[href="${guidePath(simulator.slug)}"]`).first();
      await guide.click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(simulator.keyword);
      await expect(page.locator(`a[href="${launchPath(simulator.mode)}"]`).first()).toBeVisible();
      await expectNoOverflow(page, 360);
      await page.goto('/');
    }
    await expect(page.getByRole('button', { name: /선택$/ })).toHaveCount(0);
    await expectNoOverflow(page, 360);
    await page
      .locator('.card-start')
      .and(page.getByRole('link', { name: '소울 잠재 시뮬레이터 시작하기', exact: true }))
      .click();
    await expect(page).toHaveURL(/\/DobakSimulator\/#soulPotential$/);
  });
});
