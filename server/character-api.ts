import { CharacterApiError, fetchCharacter } from '../src/character/client.ts';
import { CharacterLookupCache } from '../src/character/lookup-cache.ts';

const characterCache = new CharacterLookupCache(100);
let cacheCredential = '';

export function clearCharacterApiCache() {
  characterCache.clear();
  cacheCredential = '';
}

export interface CharacterRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface CharacterApiEnv {
  /** Server secret. Never put this value in a VITE_ variable or a response. */
  NEXON_API_KEY?: string;
  /** Comma-separated exact browser origins, for example https://example.github.io. */
  ALLOWED_ORIGINS?: string;
  CHAR_SEARCH_LIMITER?: CharacterRateLimiter;
}

export interface CharacterApiOptions {
  /** Set by the server adapter from trusted connection metadata, never a query parameter. */
  rateLimitKey?: string;
}

function validKey(env: CharacterApiEnv): string {
  const key = env.NEXON_API_KEY?.trim() ?? '';
  return key && !/[^\x21-\x7e]/.test(key) ? key : '';
}

function allowedOrigin(request: Request, env: CharacterApiEnv): boolean {
  const origin = request.headers.get('Origin');
  // Read-only clients without Origin remain supported; CORS is not authentication.
  if (origin === null || origin === new URL(request.url).origin) return true;
  return (env.ALLOWED_ORIGINS ?? '').split(',').some((entry) => {
    const allowed = entry.trim();
    if (allowed !== origin) return false;
    try {
      const url = new URL(allowed);
      return ['https:', 'http:'].includes(url.protocol) && url.origin === allowed;
    } catch {
      return false;
    }
  });
}

/** A fixed, read-only API. Credentials and provider error text never cross this boundary. */
export async function handleCharacterRequest(
  request: Request,
  env: CharacterApiEnv,
  options: CharacterApiOptions = {},
): Promise<Response> {
  const corsAllowed = allowedOrigin(request, env);
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  const origin = request.headers.get('Origin');
  if (corsAllowed && origin) headers.set('Access-Control-Allow-Origin', origin);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers });
  const failure = (status: number, code: string, message: string) =>
    json({ error: { code, message } }, status);

  if (!corsAllowed)
    return failure(403, 'ORIGIN_NOT_ALLOWED', '이 사이트에서는 캐릭터 조회를 사용할 수 없습니다.');

  const url = new URL(request.url);
  if (!['/api/character', '/api/health'].includes(url.pathname))
    return failure(404, 'NOT_FOUND', '지원하지 않는 요청입니다.');

  if (request.method === 'OPTIONS') {
    const method = request.headers.get('Access-Control-Request-Method');
    if (method && method !== 'GET') {
      headers.set('Allow', 'GET, OPTIONS');
      return failure(405, 'METHOD_NOT_ALLOWED', '캐릭터 조회는 GET 요청만 지원합니다.');
    }
    // The browser client needs no custom request headers, especially no API key header.
    if (request.headers.get('Access-Control-Request-Headers'))
      return failure(400, 'HEADERS_NOT_ALLOWED', '지원하지 않는 요청 헤더입니다.');
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'GET') {
    headers.set('Allow', 'GET, OPTIONS');
    return failure(405, 'METHOD_NOT_ALLOWED', '캐릭터 조회는 GET 요청만 지원합니다.');
  }

  const key = validKey(env);
  const limiter = env.CHAR_SEARCH_LIMITER;
  const configured = Boolean(key && limiter && typeof limiter.limit === 'function');
  if (url.pathname === '/api/health') return json({ configured });

  const names = url.searchParams.getAll('name');
  const refresh = url.searchParams.getAll('refresh');
  const nickname = names[0]?.trim() ?? '';
  if (
    names.length !== 1 ||
    refresh.length > 1 ||
    (refresh.length === 1 && refresh[0] !== '1') ||
    [...url.searchParams.keys()].some((name) => !['name', 'refresh'].includes(name)) ||
    [...nickname].length > 20 ||
    !/^[\p{L}\p{N}]+$/u.test(nickname)
  )
    return failure(
      400,
      'INVALID_NAME',
      '닉네임은 한글·영문·숫자 등 문자와 숫자 1~20자로 입력해 주세요.',
    );

  if (!configured || !limiter)
    return failure(
      503,
      'SERVICE_NOT_CONFIGURED',
      '캐릭터 조회 서버 설정이 아직 완료되지 않았습니다.',
    );

  if (request.signal.aborted)
    return failure(499, 'REQUEST_CANCELLED', '캐릭터 조회가 취소되었습니다.');

  try {
    // In production the Worker adapter supplies CF-Connecting-IP. Missing metadata
    // shares one bucket instead of allowing an unlimited anonymous bypass.
    const result = await limiter.limit({ key: `character:${options.rateLimitKey || 'anonymous'}` });
    if (!result.success) {
      headers.set('Retry-After', '60');
      return failure(429, 'RATE_LIMITED', '조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    }
  } catch {
    return failure(503, 'SERVICE_UNAVAILABLE', '캐릭터 조회를 잠시 사용할 수 없습니다.');
  }

  try {
    if (cacheCredential !== key) {
      characterCache.clear();
      cacheCredential = key;
    }
    // Cache normalized data only: response headers/CORS always belong to this request.
    // The upstream lookup owns a 20-second timeout and four fixed Nexon endpoints.
    const snapshot = await characterCache.get(
      nickname,
      (signal) => fetchCharacter(nickname, key, signal),
      request.signal,
      { refresh: refresh[0] === '1' },
    );
    return json(snapshot);
  } catch (error) {
    if (request.signal.aborted)
      return failure(499, 'REQUEST_CANCELLED', '캐릭터 조회가 취소되었습니다.');
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
      return failure(
        504,
        'LOOKUP_TIMEOUT',
        '캐릭터 조회 시간이 초과되었습니다. 다시 시도해 주세요.',
      );
    if (error instanceof CharacterApiError) {
      if (['OPENAPI00003', 'OPENAPI00004'].includes(error.code))
        return failure(
          404,
          'CHARACTER_NOT_FOUND',
          '캐릭터를 찾을 수 없습니다. 닉네임을 확인해 주세요.',
        );
      if (error.code === 'OPENAPI00007' || error.status === 429) {
        headers.set('Retry-After', '60');
        return failure(429, 'RATE_LIMITED', '조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
      }
      if (
        ['OPENAPI00002', 'OPENAPI00005', 'OPENAPI00009', 'OPENAPI00010', 'OPENAPI00011'].includes(
          error.code,
        )
      )
        return failure(503, 'SERVICE_UNAVAILABLE', '캐릭터 조회를 잠시 사용할 수 없습니다.');
    }
    return failure(
      502,
      'LOOKUP_FAILED',
      '캐릭터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
    );
  }
}
