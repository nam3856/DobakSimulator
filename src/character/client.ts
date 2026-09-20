import type { CharacterSnapshot } from '../types.ts';
import { normalizeCharacter } from './normalize.ts';
import { CharacterLookupCache, type CharacterLookupOptions } from './lookup-cache.ts';

const BASE = 'https://open.api.nexon.com/maplestory/v1';
const ERROR_MESSAGES: Record<string, string> = {
  OPENAPI00001: '넥슨 API에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  OPENAPI00002: '이 API 키로 조회할 권한이 없습니다. 메이플스토리용 키인지 확인해 주세요.',
  OPENAPI00003: '캐릭터를 찾을 수 없습니다. 닉네임을 확인해 주세요.',
  OPENAPI00004:
    '조회 정보를 확인해 주세요. 캐릭터 데이터가 없는 경우에도 조회되지 않을 수 있습니다.',
  OPENAPI00005: '유효하지 않은 API 키입니다. 복사한 키를 다시 확인해 주세요.',
  OPENAPI00006: '넥슨 API 요청을 처리할 수 없습니다.',
  OPENAPI00007: 'API 호출 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.',
  OPENAPI00009: '캐릭터 데이터를 준비 중입니다. 잠시 후 다시 시도해 주세요.',
  OPENAPI00010: '메이플스토리 점검 중입니다. 점검 후 다시 시도해 주세요.',
  OPENAPI00011: '넥슨 API 점검 중입니다. 점검 후 다시 시도해 주세요.',
};

export class CharacterApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(
      ERROR_MESSAGES[code] ??
        (status === 429
          ? ERROR_MESSAGES.OPENAPI00007
          : '캐릭터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'),
    );
    this.name = 'CharacterApiError';
    this.code = code;
    this.status = status;
  }
}

const personalCache = new CharacterLookupCache(5);

/** Personal credentials and their bounded cache stay only in this process's memory. */
export async function getCharacter(
  name: string,
  key: string,
  signal?: AbortSignal,
  options: CharacterLookupOptions = {},
): Promise<CharacterSnapshot> {
  const nickname = name.trim();
  const apiKey = key.trim();
  if (!nickname) throw new Error('캐릭터 닉네임을 입력해 주세요.');
  if (!apiKey || /[^\x21-\x7e]/.test(apiKey)) throw new Error('API 키를 올바르게 입력해 주세요.');
  return personalCache.get(
    JSON.stringify([apiKey, nickname]),
    (requestSignal) => fetchCharacter(nickname, apiKey, requestSignal),
    signal,
    options,
  );
}

export function clearPersonalCharacterCache() {
  personalCache.clear();
}

/** Uncached fixed-endpoint lookup; the server applies its own bounded cache around this. */
export async function fetchCharacter(
  name: string,
  key: string,
  signal?: AbortSignal,
): Promise<CharacterSnapshot> {
  const nickname = name.trim();
  const apiKey = key.trim();
  if (!nickname) throw new Error('캐릭터 닉네임을 입력해 주세요.');
  if (!apiKey || /[^\x21-\x7e]/.test(apiKey)) throw new Error('API 키를 올바르게 입력해 주세요.');
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException('캐릭터 조회 시간이 초과되었습니다.', 'TimeoutError')),
    20_000,
  );
  const request = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${BASE}${path}`, {
      headers: { 'x-nxopen-api-key': apiKey },
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CharacterApiError('INVALID_RESPONSE', response.status);
    }
    if (!response.ok) {
      const error = (body as { error?: { name?: unknown } } | null)?.error;
      throw new CharacterApiError(
        typeof error?.name === 'string' ? error.name : 'REQUEST_FAILED',
        response.status,
      );
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new CharacterApiError('INVALID_RESPONSE', response.status);
    return body as Record<string, unknown>;
  };
  try {
    const id = await request(`/id?character_name=${encodeURIComponent(nickname)}`);
    if (typeof id.ocid !== 'string' || !id.ocid) throw new CharacterApiError('OPENAPI00003', 400);
    const query = `?ocid=${encodeURIComponent(id.ocid)}`;
    const [basic, equipment, ability] = await Promise.all([
      request(`/character/basic${query}`),
      request(`/character/item-equipment${query}`),
      request(`/character/ability${query}`),
    ]);
    return normalizeCharacter(basic, equipment, ability);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
