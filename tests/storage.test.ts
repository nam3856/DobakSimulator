import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CharacterSnapshot, SimulationConfig } from '../src/types';
import {
  readSession,
  serialize,
  deserialize,
  saveSession,
  type StoredSession,
} from '../src/ui/storage';

function validSession(): StoredSession {
  const character = JSON.parse(
    readFileSync(new URL('../public/character/snapshot.json', import.meta.url), 'utf8'),
  ) as CharacterSnapshot;
  const equipmentPreset = character.activeEquipmentPreset;
  const item = character.equipmentPresets[equipmentPreset].find((item) => item.potentialGrade)!;
  const config: SimulationConfig = {
    mode: 'cube',
    cubeType: 'black',
    category: item.category,
    level: item.level,
    start: { grade: item.potentialGrade!, lines: item.potential, stage: 0, failures: 0 },
    lockedSlots: [],
    batchSize: 1,
    target: {
      mode: 'grade',
      minimumGrade: 'legendary',
      conditions: [],
      lines: [],
      stage: 0,
      match: 'all',
    },
    ruleVersion: 'storage-test',
    unitPrices: {},
  };
  return {
    version: 1,
    character,
    config,
    state: {
      ...config.start,
      failures: 2,
      attempts: 2n,
      spent: { meso: 8000000n, honor: 0n, cubes: 0n, credits: 0n, ethers: [0n, 0n, 0n, 0n] },
      status: 'paused',
      history: [],
      candidates: [],
      startedAt: '2026-09-23T00:00:00.000Z',
    },
    equipmentPreset,
    abilityPreset: character.activeAbilityPreset,
    equipmentId: item.id,
    playMode: 'upgrade',
  };
}

afterEach(() => vi.unstubAllGlobals());
describe('browser persistence', () => {
  it('round-trips costs beyond Number precision and refuses malformed BigInt', () => {
    const original = { meso: 123456789012345678901234567890n, ethers: [10000000000000000000n] };
    expect(deserialize(serialize(original))).toEqual(original);
    expect(() => deserialize('{"$bigint":"NaN"}')).toThrow();
  });
  it.each([true, false, undefined])(
    'restores a valid paid session with Miracle Time %s, including legacy saves without the flag',
    (miracleTime) => {
      const session = validSession();
      if (miracleTime !== undefined) session.config.miracleTime = miracleTime;
      const storage = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      });

      expect(saveSession(session)).toBe(true);
      const restored = readSession();
      expect(restored).toEqual(session);
      expect(restored!.config.miracleTime).toBe(miracleTime);
      if (miracleTime === undefined) expect(restored!.config).not.toHaveProperty('miracleTime');
    },
  );
  it.each(['true', 'false', 1, 0, null, {}])(
    'rejects non-boolean Miracle Time %j in an otherwise valid saved session',
    (invalidFlag) => {
      const session = validSession();
      let saved = serialize(session);
      vi.stubGlobal('localStorage', { getItem: () => saved });
      expect(readSession()).toEqual(session);

      saved = serialize({ ...session, config: { ...session.config, miracleTime: invalidFlag } });
      expect(readSession()).toBeNull();
    },
  );
  it('keeps the original starting options separately from the current challenge', () => {
    const session = validSession();
    session.config.retryStart = { ...structuredClone(session.config.start), failures: 7 };
    let saved = '';
    vi.stubGlobal('localStorage', {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    });
    expect(saveSession(session)).toBe(true);
    expect(readSession()).toEqual(session);
    expect(readSession()!.config.start.failures).toBe(0);
    expect(readSession()!.config.retryStart!.failures).toBe(7);
  });
  it.each([
    null,
    { grade: 'normal' },
    { lines: [] },
    { stage: 5 },
    { failures: -1 },
    { failures: 1.5 },
  ])('rejects a damaged retry starting state %j', (patch) => {
    const session = validSession();
    const retryStart = patch === null ? null : { ...session.config.start, ...patch };
    vi.stubGlobal('localStorage', {
      getItem: () => serialize({ ...session, config: { ...session.config, retryStart } }),
    });
    expect(readSession()).toBeNull();
  });
  it('ignores a damaged saved session instead of crashing the page', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        serialize({
          version: 1,
          character: { name: '깽미니' },
          config: { start: { lines: [] } },
          state: { attempts: 1n, spent: { ethers: [] } },
        }),
    });
    expect(readSession()).toBeNull();
  });
  it('continues without persistence if browser storage is denied or full', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw Error('denied');
      },
      setItem: () => {
        throw Error('quota');
      },
    });
    expect(readSession()).toBeNull();
    expect(saveSession({} as StoredSession)).toBe(false);
  });
});
