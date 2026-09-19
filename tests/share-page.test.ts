import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import worker from '../server/worker.ts';
import { characterShareHeadline } from '../src/share-metadata.ts';

const API_ORIGIN = 'https://character.example.workers.dev';
const SITE_URL = 'https://nam3856.github.io/DobakSimulator/';

function request(character: string, mode = 'soulAmplification', method = 'GET'): Request {
  const url = new URL('/share', API_ORIGIN);
  url.searchParams.set('character', character);
  url.searchParams.set('mode', mode);
  return new Request(url, { method });
}

afterEach(() => vi.unstubAllGlobals());

describe('nickname share preview', () => {
  it.each([
    ['깽미니', '이세계의 깽미니로 강화하기'],
    ['은월', '이세계의 은월로 강화하기'],
    ['검객', '이세계의 검객으로 강화하기'],
    [' Test123 ', '이세계의 Test123으로 강화하기'],
  ])('uses a natural Korean invitation for %s', (nickname, headline) => {
    expect(characterShareHeadline(nickname)).toBe(headline);
  });

  it('serves nickname metadata in the original HTML without fetching character data', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const limit = vi.fn();
    const response = await worker.fetch(request('깽미니'), { CHAR_SEARCH_LIMITER: { limit } });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Location')).toBeNull();
    expect(html).toContain('<title>이세계의 깽미니로 강화하기 | 이세계 직작</title>');
    for (const attribute of ['property="og:title"', 'name="twitter:title"'])
      expect(html).toContain(
        `<meta ${attribute} content="이세계의 깽미니로 강화하기 | 이세계 직작"`,
      );
    for (const attribute of [
      'name="description"',
      'property="og:description"',
      'name="twitter:description"',
    ])
      expect(html).toContain(
        `<meta ${attribute} content="이세계의 깽미니로 강화하기. 메이플스토리 통합 강화 시뮬레이터`,
      );
    expect(html).toContain(`${SITE_URL}social-preview.png`);
    expect(html).toContain('<meta property="og:image:width" content="1200"');
    expect(html).toContain('<meta property="og:image:height" content="630"');
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}"`);
    expect(html).toContain('<meta name="robots" content="noindex, follow"');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it.each([
    'ability',
    'cube',
    'soulAmplification',
    'soulPotential',
    'abilityOptimizer',
    'starforce',
  ])(
    'opens the named character in the %s tab and preserves a link without JavaScript',
    async (mode) => {
      const response = await worker.fetch(request(' 테스트123 ', mode), {});
      const html = await response.text();
      const replace = vi.fn();
      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(script).toBeDefined();
      runInNewContext(script!, { window: { location: { replace } } });
      const destination = new URL(replace.mock.calls[0][0]);
      expect(destination.origin + destination.pathname).toBe(SITE_URL);
      expect(destination.searchParams.get('character')).toBe('테스트123');
      expect(destination.hash).toBe(`#${mode}`);
      expect(html).toContain(`<a href="${destination.href}">시뮬레이터에서 강화하기</a>`);
      const ogUrl = html.match(/property="og:url" content="([^"]+)"/)?.[1].replaceAll('&amp;', '&');
      expect(ogUrl).toBe(
        `${API_ORIGIN}/share?character=${encodeURIComponent('테스트123')}&mode=${mode}`,
      );
    },
  );

  it('supports bodyless HEAD requests with the same crawler metadata headers', async () => {
    const getResponse = await worker.fetch(request('테스트'), {});
    const headResponse = await worker.fetch(request('테스트', 'cube', 'HEAD'), {});
    expect(headResponse.status).toBe(200);
    expect(await headResponse.text()).toBe('');
    expect(Object.fromEntries(headResponse.headers)).toEqual(
      Object.fromEntries(getResponse.headers),
    );
  });

  it.each([
    '',
    'a'.repeat(21),
    '<script>alert(1)</script>',
    '" onload="alert(1)',
    '이름\n다음',
    'a&b',
    '\u2028',
  ])('rejects invalid nickname %j without reflecting it', async (nickname) => {
    const response = await worker.fetch(request(nickname), {});
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const html = await response.text();
    expect(html).not.toContain('<script>');
    if (nickname) expect(html).not.toContain(nickname);
  });

  it('rejects duplicate nickname parameters instead of choosing ambiguous metadata', async () => {
    const response = await worker.fetch(
      new Request(`${API_ORIGIN}/share?character=첫째&character=둘째`),
      {},
    );
    expect(response.status).toBe(400);
  });

  it('keeps malicious modes and redirect parameters out of metadata and scripts', async () => {
    const url = new URL(request('테스트', '</script><script>alert(1)</script>').url);
    url.searchParams.set('redirect', 'https://attacker.example/');
    url.searchParams.set('key', 'must-not-appear');
    const response = await worker.fetch(new Request(url), {});
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('attacker.example');
    expect(html).not.toContain('must-not-appear');
    expect(html.match(/<script>/g)).toHaveLength(1);
    const replace = vi.fn();
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)![1], {
      window: { location: { replace } },
    });
    expect(new URL(replace.mock.calls[0][0]).hash).toBe('#cube');
  });

  it('rejects methods that cannot load a share page', async () => {
    const response = await worker.fetch(request('테스트', 'cube', 'POST'), {});
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
  });

  it('preserves existing API and unknown route behavior', async () => {
    const health = await worker.fetch(new Request(`${API_ORIGIN}/api/health`), {});
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ configured: false });
    const unknown = await worker.fetch(new Request(`${API_ORIGIN}/share/unknown`), {});
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
