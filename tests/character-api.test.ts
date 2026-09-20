import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearCharacterApiCache,
  handleCharacterRequest,
  type CharacterApiEnv,
} from '../server/character-api.ts';
import worker from '../server/worker.ts';

const API_ORIGIN = 'https://character.example.workers.dev';
const SITE_ORIGIN = 'https://example.github.io';
const SECRET = 'server-only-test-key';
const PRIVATE_ID = 'private-test-ocid';

function environment(): CharacterApiEnv {
  return {
    NEXON_API_KEY: SECRET,
    ALLOWED_ORIGINS: SITE_ORIGIN,
    CHAR_SEARCH_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  };
}

function request(path = '/api/character?name=테스트', init: RequestInit = {}): Request {
  return new Request(`${API_ORIGIN}${path}`, {
    ...init,
    headers: { Origin: SITE_ORIGIN, ...init.headers },
  });
}

function mockNexon() {
  const fetchMock = vi.fn(async (input: string, _options?: RequestInit) => {
    const url = new URL(input);
    return Response.json(
      url.pathname.endsWith('/id')
        ? { ocid: PRIVATE_ID }
        : url.pathname.endsWith('/basic')
          ? {
              character_name: '테스트',
              character_class: '메카닉',
              character_level: 290,
              world_name: '오로라',
              ocid: PRIVATE_ID,
              apiKey: SECRET,
              private_field: 'must-not-leak',
            }
          : { ocid: PRIVATE_ID },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  clearCharacterApiCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shared character API', () => {
  it('uses only its server key and fixed latest endpoints, returning a normalized fresh snapshot', async () => {
    const fetchMock = mockNexon();
    const response = await handleCharacterRequest(
      request('/api/character?name=%20테스트%20', {
        headers: { 'x-nxopen-api-key': 'untrusted-browser-key' },
      }),
      environment(),
      { rateLimitKey: '192.0.2.1' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    const snapshot = JSON.parse(text);
    expect(snapshot).toMatchObject({ name: '테스트', level: 290, job: '메카닉' });
    expect(Date.parse(snapshot.fetchedAt)).toBeGreaterThan(0);
    for (const secret of [SECRET, PRIVATE_ID, 'must-not-leak', 'untrusted-browser-key'])
      expect(text).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const paths = [];
    for (const [input, options] of fetchMock.mock.calls) {
      const url = new URL(input);
      paths.push(url.pathname);
      expect(url.origin).toBe('https://open.api.nexon.com');
      expect(url.searchParams.has('date')).toBe(false);
      expect(input).not.toContain(SECRET);
      expect(options?.headers).toEqual({ 'x-nxopen-api-key': SECRET });
      expect(options?.cache).toBe('no-store');
      expect(options?.credentials).toBe('omit');
    }
    expect(paths).toEqual([
      '/maplestory/v1/id',
      '/maplestory/v1/character/basic',
      '/maplestory/v1/character/item-equipment',
      '/maplestory/v1/character/ability',
    ]);
    await handleCharacterRequest(request(), environment());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reuses concurrent and recent lookups, preserving timestamps and independently setting CORS', async () => {
    vi.useFakeTimers();
    const fetchMock = mockNexon();
    const env = { ...environment(), ALLOWED_ORIGINS: `${SITE_ORIGIN},https://other.example` };
    const [first, second] = await Promise.all([
      handleCharacterRequest(request(), env),
      handleCharacterRequest(
        request(undefined, { headers: { Origin: 'https://other.example' } }),
        env,
      ),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(first.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
    expect(second.headers.get('Access-Control-Allow-Origin')).toBe('https://other.example');
    const snapshot = await first.json();
    expect(await second.json()).toEqual(snapshot);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(await (await handleCharacterRequest(request(), env)).json()).toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    await handleCharacterRequest(request(), env);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(env.CHAR_SEARCH_LIMITER?.limit).toHaveBeenCalledTimes(4);
  });

  it('bypasses completed cache explicitly, shares concurrent refreshes and invalidates a changed key', async () => {
    const fetchMock = mockNexon();
    await handleCharacterRequest(request(), environment());
    await Promise.all([
      handleCharacterRequest(request('/api/character?name=테스트&refresh=1'), environment()),
      handleCharacterRequest(request('/api/character?name=테스트&refresh=1'), environment()),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(8);
    await handleCharacterRequest(request(), { ...environment(), NEXON_API_KEY: 'changed-key' });
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(fetchMock.mock.calls[8][1]?.headers).toEqual({ 'x-nxopen-api-key': 'changed-key' });
  });

  it('keeps origin checks and rate limits ahead of an existing cache hit', async () => {
    const fetchMock = mockNexon();
    await handleCharacterRequest(request(), environment());
    const blocked = await handleCharacterRequest(
      request(undefined, { headers: { Origin: 'https://evil.example' } }),
      environment(),
    );
    expect(blocked.status).toBe(403);
    const env = environment();
    env.CHAR_SEARCH_LIMITER!.limit = vi.fn(async () => ({ success: false }));
    expect((await handleCharacterRequest(request(), env)).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reports readiness without disclosing credentials or contacting Nexon', async () => {
    const fetchMock = mockNexon();
    for (const [env, expected] of [
      [environment(), true],
      [{ ...environment(), NEXON_API_KEY: undefined }, false],
      [{ ...environment(), NEXON_API_KEY: 'invalid\nkey' }, false],
      [{ ...environment(), CHAR_SEARCH_LIMITER: undefined }, false],
    ] as const) {
      const response = await handleCharacterRequest(request('/api/health'), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ configured: expected });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '?name=',
    '?name=%20',
    '?name=테스트&name=다른이름',
    '?name=테스트&url=https://attacker.example',
    '?name=테스트&refresh=0',
    '?name=테스트&refresh=1&refresh=1',
    '?name=https://evil.test',
    '?name=../basic',
    '?name=테%00스트',
    '?name=테%0A스트',
    '?name=테%20스트',
    '?name=%E0%A4%A',
    `?name=${'가'.repeat(21)}`,
  ])(
    'rejects invalid or proxy-style input before rate limiting or upstream fetch: %s',
    async (query) => {
      const fetchMock = mockNexon();
      const env = environment();
      const response = await handleCharacterRequest(request(`/api/character${query}`), env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_NAME' } });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(env.CHAR_SEARCH_LIMITER?.limit).not.toHaveBeenCalled();
    },
  );

  it('accepts a 20-character Unicode nickname and encodes it as one query value', async () => {
    const fetchMock = mockNexon();
    const name = '가'.repeat(20);
    expect(
      (await handleCharacterRequest(request(`/api/character?name=${name}`), environment())).status,
    ).toBe(200);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('character_name')).toBe(name);
  });

  it('denies unlisted, null, wildcard and lookalike browser origins without upstream calls', async () => {
    const fetchMock = mockNexon();
    const env = { ...environment(), ALLOWED_ORIGINS: `${SITE_ORIGIN},*,null` };
    for (const origin of ['https://evil.example', `${SITE_ORIGIN}.evil.example`, 'null', '*']) {
      const response = await handleCharacterRequest(
        request(undefined, { headers: { Origin: origin } }),
        env,
      );
      expect(response.status).toBe(403);
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('supports exact configured origins, same-origin and read-only clients without Origin', async () => {
    mockNexon();
    const env = { ...environment(), ALLOWED_ORIGINS: `https://other.example, ${SITE_ORIGIN}` };
    for (const origin of [SITE_ORIGIN, API_ORIGIN, undefined]) {
      const headers = origin ? { Origin: origin } : undefined;
      const response = await handleCharacterRequest(
        new Request(`${API_ORIGIN}/api/health`, { headers }),
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin ?? null);
      expect(response.headers.get('Vary')).toBe('Origin');
    }
  });

  it('handles GET preflight and refuses custom headers, writes and arbitrary paths', async () => {
    const fetchMock = mockNexon();
    const env = environment();
    const preflight = await handleCharacterRequest(
      request(undefined, {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Method': 'GET' },
      }),
      env,
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
    const customHeaders = await handleCharacterRequest(
      request(undefined, {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Headers': 'x-nxopen-api-key' },
      }),
      env,
    );
    expect(customHeaders.status).toBe(400);
    const write = await handleCharacterRequest(
      request(undefined, { method: 'POST', body: '{}' }),
      env,
    );
    expect(write.status).toBe(405);
    expect(write.headers.get('Allow')).toBe('GET, OPTIONS');
    expect(
      (await handleCharacterRequest(request('/api/proxy?url=https://evil.example'), env)).status,
    ).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed if the shared key or rate limiter is unavailable', async () => {
    const fetchMock = mockNexon();
    for (const env of [
      { ...environment(), NEXON_API_KEY: '' },
      { ...environment(), CHAR_SEARCH_LIMITER: undefined },
      {
        ...environment(),
        CHAR_SEARCH_LIMITER: {
          limit: vi.fn(async () => {
            throw new Error(SECRET);
          }),
        },
      },
    ]) {
      const response = await handleCharacterRequest(request(), env);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(SECRET);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rate limits before spending upstream calls and uses trusted Worker IP metadata', async () => {
    const fetchMock = mockNexon();
    const env = environment();
    env.CHAR_SEARCH_LIMITER!.limit = vi.fn(async () => ({ success: false }));
    const response = await worker.fetch(
      request(undefined, {
        headers: { 'CF-Connecting-IP': '192.0.2.8', 'X-Forwarded-For': 'attacker-input' },
      }),
      env,
    );
    expect(env.CHAR_SEARCH_LIMITER!.limit).toHaveBeenCalledWith({ key: 'character:192.0.2.8' });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
    expect(await response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['OPENAPI00003', 400, 404, 'CHARACTER_NOT_FOUND'],
    ['OPENAPI00005', 400, 503, 'SERVICE_UNAVAILABLE'],
    ['OPENAPI00007', 429, 429, 'RATE_LIMITED'],
    [`PRIVATE_${SECRET}_${PRIVATE_ID}`, 500, 502, 'LOOKUP_FAILED'],
  ])('sanitizes provider error %s', async (name, status, expectedStatus, code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: { name, message: `${SECRET} ${PRIVATE_ID} private-provider-message` } },
          { status },
        ),
      ),
    );
    const response = await handleCharacterRequest(request(), environment());
    expect(response.status).toBe(expectedStatus);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code } });
    for (const secret of [SECRET, PRIVATE_ID, 'private-provider-message'])
      expect(text).not.toContain(secret);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(SITE_ORIGIN);
  });

  it('sanitizes network failures and malformed upstream JSON', async () => {
    for (const fetcher of [
      vi.fn(async () => {
        throw new Error(`${SECRET} ${PRIVATE_ID}`);
      }),
      vi.fn(async () => new Response(`<html>${SECRET} ${PRIVATE_ID}</html>`)),
    ]) {
      vi.stubGlobal('fetch', fetcher);
      const response = await handleCharacterRequest(request(), environment());
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: {
          code: 'LOOKUP_FAILED',
          message: '캐릭터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
        },
      });
    }
  });

  it('cancels upstream work without echoing the abort reason', async () => {
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            });
            notifyStarted();
          }),
      ),
    );
    const controller = new AbortController();
    const responsePromise = handleCharacterRequest(
      request(undefined, { signal: controller.signal }),
      environment(),
    );
    await started;
    controller.abort(new Error(SECRET));
    const response = await responsePromise;
    expect(response.status).toBe(499);
    expect(await response.text()).not.toContain(SECRET);
  });

  it('aborts a stalled Nexon request after 20 seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const pending = handleCharacterRequest(request(), environment());
    await vi.advanceTimersByTimeAsync(20_000);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: { code: 'LOOKUP_TIMEOUT' } });
  });
});
