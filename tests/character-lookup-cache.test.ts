import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CharacterLookupCache, isRecentCharacter } from '../src/character/lookup-cache';
import { clearPersonalCharacterCache, getCharacter } from '../src/character/client';
import type { CharacterSnapshot } from '../src/types';

function snapshot(): CharacterSnapshot {
  return {
    ...JSON.parse(
      readFileSync(new URL('../public/character/snapshot.json', import.meta.url), 'utf8'),
    ),
    fetchedAt: new Date().toISOString(),
  };
}

afterEach(() => {
  clearPersonalCharacterCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bounded character lookup cache', () => {
  it('does not replace newer cached data with an older saved snapshot', async () => {
    const cache = new CharacterLookupCache(5);
    const recent = snapshot();
    const older = { ...recent, level: 1, fetchedAt: new Date(Date.now() - 60_000).toISOString() };
    cache.seed('same', recent);
    cache.seed('same', older);
    const load = vi.fn(async () => older);
    expect(await cache.get('same', load)).toEqual(recent);
    expect(load).not.toHaveBeenCalled();
  });

  it('does not let explicit refresh join a network lookup that may return a server cache hit', async () => {
    const cache = new CharacterLookupCache(5, undefined, false);
    let finishOrdinary!: (character: CharacterSnapshot) => void;
    let finishFresh!: (character: CharacterSnapshot) => void;
    const old = { ...snapshot(), level: 1, fetchedAt: new Date(Date.now() - 60_000).toISOString() };
    const fresh = snapshot();
    const ordinary = vi.fn(
      () =>
        new Promise<CharacterSnapshot>((resolve) => {
          finishOrdinary = resolve;
        }),
    );
    const refresh = vi.fn(
      () =>
        new Promise<CharacterSnapshot>((resolve) => {
          finishFresh = resolve;
        }),
    );
    const pendingOrdinary = cache.get('same', ordinary);
    const pendingRefresh = cache.get('same', refresh, undefined, { refresh: true });
    const anotherRefresh = cache.get('same', refresh, undefined, { refresh: true });
    await Promise.resolve();
    expect(ordinary).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    finishFresh(fresh);
    expect(await pendingRefresh).toEqual(fresh);
    expect(await anotherRefresh).toEqual(fresh);
    expect(await cache.get('same', ordinary)).toEqual(fresh);
    finishOrdinary(old);
    expect(await pendingOrdinary).toEqual(old);
    expect(await cache.get('same', ordinary)).toEqual(fresh);
    expect(ordinary).toHaveBeenCalledTimes(1);
  });

  it('restores fresh data without extending its age, prunes old entries and clones every return', async () => {
    vi.useFakeTimers();
    const recent = snapshot();
    recent.fetchedAt = new Date(Date.now() - 290_000).toISOString();
    const old = { ...recent, fetchedAt: '2000-01-01T00:00:00Z' };
    const invalid = { ...recent, fetchedAt: 'invalid' };
    const future = { ...recent, fetchedAt: new Date(Date.now() + 1).toISOString() };
    for (const character of [old, invalid, future])
      expect(isRecentCharacter(character)).toBe(false);
    const write = vi.fn();
    const cache = new CharacterLookupCache(5, {
      read: () => [
        ['old', old],
        ['invalid', invalid],
        ['future', future],
        ['recent', recent],
      ],
      write,
    });
    const load = vi.fn(async () => snapshot());
    const first = await cache.get('recent', load);
    first.abilityPresets['1'].lines = [];
    expect((await cache.get('recent', load)).abilityPresets['1'].lines).toHaveLength(3);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await cache.get('recent', load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalled();
  });

  it('evicts the least recently used entry and survives corrupt or unavailable storage', async () => {
    const cache = new CharacterLookupCache(2, {
      read: () => {
        throw new Error('disabled');
      },
      write: () => {
        throw new Error('quota');
      },
    });
    const load = vi.fn(async () => snapshot());
    await cache.get('a', load);
    await cache.get('b', load);
    await cache.get('a', load);
    await cache.get('c', load);
    await cache.get('b', load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('shares a live request while letting one caller cancel independently', async () => {
    const cache = new CharacterLookupCache(5);
    let finish!: (value: CharacterSnapshot) => void;
    let upstream!: AbortSignal;
    const load = vi.fn((signal: AbortSignal) => {
      upstream = signal;
      return new Promise<CharacterSnapshot>((resolve) => {
        finish = resolve;
      });
    });
    const cancelled = new AbortController();
    const first = cache.get('same', load, cancelled.signal);
    const second = cache.get('same', load);
    await Promise.resolve();
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    cancelled.abort();
    await rejected;
    expect(upstream.aborted).toBe(false);
    finish(snapshot());
    expect((await second).name).toBe('깽미니');
    expect(load).toHaveBeenCalledTimes(1);
    await cache.get('same', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('aborts abandoned upstream work, never caches errors and permits a clean retry', async () => {
    const cache = new CharacterLookupCache(5);
    let upstream!: AbortSignal;
    const load = vi.fn((signal: AbortSignal) => {
      upstream = signal;
      return new Promise<CharacterSnapshot>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const controller = new AbortController();
    const pending = cache.get('same', load, controller.signal);
    await Promise.resolve();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(upstream.aborted).toBe(true);
    const failure = vi.fn(async () => {
      throw new Error('retry');
    });
    await expect(cache.get('same', failure)).rejects.toThrow('retry');
    await expect(cache.get('same', failure)).rejects.toThrow('retry');
    expect(failure).toHaveBeenCalledTimes(2);
    await expect(cache.get('same', async () => snapshot())).resolves.toMatchObject({
      name: '깽미니',
    });
  });

  it('keeps personal credentials out of storage and isolates cached results by key', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('sessionStorage', { setItem });
    vi.stubGlobal('localStorage', { setItem });
    const fetcher = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      return Response.json(
        path.endsWith('/id')
          ? { ocid: 'private-id' }
          : path.endsWith('/basic')
            ? { character_name: '캐릭터', character_class: '메카닉' }
            : {},
      );
    });
    vi.stubGlobal('fetch', fetcher);
    await getCharacter('캐릭터', 'personal-one');
    await getCharacter('캐릭터', 'personal-one');
    expect(fetcher).toHaveBeenCalledTimes(4);
    await getCharacter('캐릭터', 'personal-two');
    expect(fetcher).toHaveBeenCalledTimes(8);
    await getCharacter('캐릭터', 'personal-two', undefined, { refresh: true });
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(setItem).not.toHaveBeenCalled();
  });
});
