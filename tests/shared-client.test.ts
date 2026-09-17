import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { getSharedCharacter, resolveSharedApiBase, validateApiBase } from '../src/character/shared';

afterEach(() => vi.unstubAllGlobals());
describe('shared character search client', () => {
  it('uses only a nickname query and no key or credentials', async () => {
    const character = JSON.parse(
      readFileSync(new URL('../public/character/snapshot.json', import.meta.url), 'utf8'),
    );
    const fetchMock = vi.fn(async () => Response.json(character));
    vi.stubGlobal('fetch', fetchMock);
    const result = await getSharedCharacter(' 깽미니 ', 'https://sim-api.example/api/');
    expect(result.name).toBe('깽미니');
    expect(result.bundledAvatars).toBe(false);
    const [url, request] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/api/character');
    expect(url.searchParams.get('name')).toBe('깽미니');
    expect(request.credentials).toBe('omit');
    expect(request.headers).toBeUndefined();
  });
  it('supports a deploy address and local server detection without persisting secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL) =>
        Response.json(
          url.pathname.endsWith('health') ? { configured: true } : { characterApiBaseUrl: '' },
        ),
      ),
    );
    expect(
      await resolveSharedApiBase({
        pageBase: 'https://site.example/app/',
        configuredUrl: 'https://worker.example/api',
      }),
    ).toBe('https://worker.example/api/');
    expect(
      await resolveSharedApiBase({ pageBase: 'http://127.0.0.1:5173/', development: true }),
    ).toBe('http://127.0.0.1:5173/api/');
    expect(await resolveSharedApiBase({ pageBase: 'https://site.example/app/' })).toBeUndefined();
  });
  it('does not echo error bodies or accept an invalid server response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: { message: 'server-secret-value' } }, { status: 503 }),
      ),
    );
    const error = await getSharedCharacter('깽미니', 'https://worker.example/api/').catch(
      (error) => error,
    );
    expect(error.message).not.toContain('server-secret-value');
    expect(error.message).toContain('공용 검색');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ name: 'incomplete' })),
    );
    await expect(getSharedCharacter('깽미니', 'https://worker.example/api/')).rejects.toThrow(
      '올바른 캐릭터',
    );
  });
  it('preserves user cancellation and offers a useful quota error', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, options: RequestInit) => {
        options.signal?.throwIfAborted();
        return Response.json({}, { status: 429 });
      }),
    );
    await expect(
      getSharedCharacter('깽미니', 'https://worker.example/api/', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(getSharedCharacter('깽미니', 'https://worker.example/api/')).rejects.toThrow(
      '호출 한도',
    );
  });
  it('rejects unsafe public server configuration', () => {
    expect(() => validateApiBase('http://remote.example/api', 'https://site.example/')).toThrow();
    expect(() =>
      validateApiBase('https://key@remote.example/api', 'https://site.example/'),
    ).toThrow();
    expect(() =>
      validateApiBase('https://remote.example/api?key=secret', 'https://site.example/'),
    ).toThrow();
    expect(validateApiBase('/api', 'https://site.example/app/')).toBe('https://site.example/api/');
  });
});
