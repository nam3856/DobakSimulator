import type { CharacterSnapshot } from '../types';
import {
  CharacterLookupCache,
  isCharacterSnapshot,
  type CharacterLookupOptions,
} from './lookup-cache';

const CACHE_KEY = 'isekai:character-cache:v1';
const sharedCache = new CharacterLookupCache(
  5,
  {
    read: () => JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? 'null'),
    write: (entries) => sessionStorage.setItem(CACHE_KEY, JSON.stringify(entries)),
  },
  false,
);

function lookupKey(name: string, apiBase: string) {
  return JSON.stringify([validateApiBase(apiBase, apiBase), name.trim()]);
}

/** Reuse an already loaded full snapshot without resetting any simulator's paid state. */
export function seedSharedCharacter(character: CharacterSnapshot, apiBase: string) {
  if (character.bundledAvatars) return;
  sharedCache.seed(lookupKey(character.name, apiBase), character);
}

export function clearSharedCharacterCache() {
  sharedCache.clear();
}

/** Public server address only. The shared Nexon key is never a browser input. */
export function validateApiBase(value: string, pageBase: string): string {
  const url = new URL(value, pageBase);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('공용 검색 서버 주소를 확인해 주세요.');
  }
  return url.href.replace(/\/?$/, '/');
}

export async function resolveSharedApiBase(options: {
  pageBase: string;
  configuredUrl?: string;
  development?: boolean;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const { pageBase, configuredUrl, development, signal } = options;
  if (configuredUrl?.trim()) return validateApiBase(configuredUrl.trim(), pageBase);
  try {
    const response = await fetch(new URL('app-config.json', pageBase), {
      signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    if (response.ok) {
      const config = (await response.json()) as { characterApiBaseUrl?: unknown };
      if (typeof config.characterApiBaseUrl === 'string' && config.characterApiBaseUrl.trim())
        return validateApiBase(config.characterApiBaseUrl.trim(), pageBase);
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  if (!development) return undefined;
  const localBase = new URL('api/', pageBase).href;
  try {
    const response = await fetch(new URL('health', localBase), {
      signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    if (response.ok && (await response.json()).configured === true) return localBase;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  return undefined;
}

export async function getSharedCharacter(
  name: string,
  apiBase: string,
  signal?: AbortSignal,
  options: CharacterLookupOptions = {},
): Promise<CharacterSnapshot> {
  const base = validateApiBase(apiBase, apiBase);
  return sharedCache.get(
    lookupKey(name, base),
    (requestSignal) => fetchSharedCharacter(name, base, requestSignal, options),
    signal,
    options,
  );
}

async function fetchSharedCharacter(
  name: string,
  apiBase: string,
  signal: AbortSignal,
  options: CharacterLookupOptions,
): Promise<CharacterSnapshot> {
  const url = new URL('character', apiBase);
  url.searchParams.set('name', name.trim());
  if (options.refresh) url.searchParams.set('refresh', '1');
  const timeout = AbortSignal.timeout(25_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { signal: requestSignal, credentials: 'omit', cache: 'no-store' });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      '공용 검색 서버에 연결하지 못했습니다. 잠시 후 다시 시도하거나 개인 API 키를 사용해 주세요.',
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('공용 검색 서버 응답을 확인할 수 없습니다.');
  }
  if (!response.ok) {
    const code = (body as { error?: { code?: string } } | null)?.error?.code;
    if (response.status === 429)
      throw new Error(
        '공용 검색의 호출 한도에 도달했습니다. 잠시 후 다시 시도하거나 개인 API 키를 사용해 주세요.',
      );
    if (response.status === 404 || code === 'CHARACTER_NOT_FOUND')
      throw new Error('캐릭터를 찾을 수 없습니다. 닉네임을 확인해 주세요.');
    if (response.status === 400) throw new Error('캐릭터 닉네임을 확인해 주세요.');
    throw new Error(
      '공용 검색을 잠시 사용할 수 없습니다. 잠시 후 다시 시도하거나 개인 API 키를 사용해 주세요.',
    );
  }
  if (!isCharacterSnapshot(body)) {
    throw new Error('공용 검색에서 올바른 캐릭터 정보를 받지 못했습니다.');
  }
  return { ...body, bundledAvatars: false };
}
