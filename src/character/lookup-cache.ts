import type { CharacterSnapshot } from '../types.ts';

export const CHARACTER_CACHE_TTL = 5 * 60_000;
export interface CharacterLookupOptions {
  /** Ignore completed cached results; concurrent live lookups are still shared. */
  refresh?: boolean;
}

export function isCharacterSnapshot(value: unknown): value is CharacterSnapshot {
  const character = value as CharacterSnapshot | null;
  return Boolean(
    character &&
      typeof character.name === 'string' &&
      character.name &&
      character.profile &&
      Array.isArray(character.profile.mainStats) &&
      character.equipmentPresets &&
      character.abilityPresets &&
      ['1', '2', '3'].every(
        (preset) =>
          Array.isArray(character.equipmentPresets[preset]) &&
          Array.isArray(character.abilityPresets[preset]?.lines),
      ),
  );
}

export function isRecentCharacter(character: CharacterSnapshot, now = Date.now()): boolean {
  const fetchedAt = Date.parse(character.fetchedAt);
  return Number.isFinite(fetchedAt) && fetchedAt <= now && now - fetchedAt < CHARACTER_CACHE_TTL;
}

interface Persistence {
  read(): unknown;
  write(entries: [string, CharacterSnapshot][]): void;
}

interface PendingLookup {
  controller: AbortController;
  promise: Promise<CharacterSnapshot>;
  consumers: Set<object>;
}

/** Stores only successful snapshots. Every consumer owns its cancellation and returned copy. */
export class CharacterLookupCache {
  private readonly completed = new Map<string, CharacterSnapshot>();
  private readonly pending = new Map<string, PendingLookup>();
  private restored = false;

  constructor(
    private readonly capacity: number,
    private readonly persistence?: Persistence,
    /** A public-server request may itself hit that server's completed cache. */
    private readonly ordinaryLoadsAreFresh = true,
  ) {}

  private restore() {
    if (this.restored) return;
    this.restored = true;
    try {
      const entries = this.persistence?.read();
      if (Array.isArray(entries)) {
        for (const entry of entries.slice(-this.capacity)) {
          if (
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === 'string' &&
            isCharacterSnapshot(entry[1]) &&
            isRecentCharacter(entry[1])
          )
            this.completed.set(entry[0], structuredClone(entry[1]));
        }
      }
    } catch {
      // Browsers can deny storage or contain an obsolete/corrupt cache.
    }
  }

  private persist() {
    try {
      this.persistence?.write([...this.completed]);
    } catch {
      // Memory caching remains available when storage is full or disabled.
    }
  }

  seed(key: string, character: CharacterSnapshot) {
    this.restore();
    for (const [savedKey, value] of this.completed)
      if (!isRecentCharacter(value)) this.completed.delete(savedKey);
    if (!isRecentCharacter(character)) return;
    const existing = this.completed.get(key);
    if (existing && Date.parse(existing.fetchedAt) > Date.parse(character.fetchedAt)) return;
    this.completed.delete(key);
    this.completed.set(key, structuredClone(character));
    while (this.completed.size > this.capacity)
      this.completed.delete(this.completed.keys().next().value!);
    this.persist();
  }

  clear() {
    for (const lookup of this.pending.values()) lookup.controller.abort();
    this.pending.clear();
    this.completed.clear();
    this.restored = true;
    this.persist();
  }

  async get(
    key: string,
    load: (signal: AbortSignal) => Promise<CharacterSnapshot>,
    signal?: AbortSignal,
    options: CharacterLookupOptions = {},
  ): Promise<CharacterSnapshot> {
    signal?.throwIfAborted();
    this.restore();
    const liveKey = JSON.stringify([key, 'live']);
    const ordinaryKey = this.ordinaryLoadsAreFresh ? liveKey : JSON.stringify([key, 'cached']);
    let pendingKey = liveKey;
    let lookup = this.pending.get(liveKey);
    if (!lookup && !options.refresh) {
      const saved = this.completed.get(key);
      if (saved && isRecentCharacter(saved)) {
        this.completed.delete(key);
        this.completed.set(key, saved);
        this.persist();
        return structuredClone(saved);
      }
      if (saved) {
        this.completed.delete(key);
        this.persist();
      }
      pendingKey = ordinaryKey;
      lookup = this.pending.get(ordinaryKey);
    }
    if (!lookup) {
      pendingKey = options.refresh ? liveKey : ordinaryKey;
      const flightKey = pendingKey;
      const controller = new AbortController();
      lookup = {
        controller,
        consumers: new Set(),
        promise: Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return load(controller.signal);
        }),
      };
      const current = lookup;
      lookup.promise = lookup.promise.then(
        (character) => {
          controller.signal.throwIfAborted();
          if (this.pending.get(flightKey) === current) {
            this.pending.delete(flightKey);
            this.seed(key, character);
          }
          return character;
        },
        (error: unknown) => {
          if (this.pending.get(flightKey) === current) this.pending.delete(flightKey);
          throw error;
        },
      );
      this.pending.set(flightKey, lookup);
    }
    const current = lookup;
    return new Promise<CharacterSnapshot>((resolve, reject) => {
      const consumer = {};
      current.consumers.add(consumer);
      const detach = () => {
        signal?.removeEventListener('abort', abort);
        current.consumers.delete(consumer);
      };
      const abort = () => {
        detach();
        reject(signal?.reason ?? new DOMException('Request cancelled', 'AbortError'));
        if (current.consumers.size === 0 && this.pending.get(pendingKey) === current) {
          this.pending.delete(pendingKey);
          current.controller.abort();
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(
        (character) => {
          detach();
          resolve(structuredClone(character));
        },
        (error: unknown) => {
          detach();
          reject(error);
        },
      );
    });
  }
}
