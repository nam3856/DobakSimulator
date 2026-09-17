import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSession,
  serialize,
  deserialize,
  saveSession,
  type StoredSession,
} from '../src/ui/storage';

afterEach(() => vi.unstubAllGlobals());
describe('browser persistence', () => {
  it('round-trips costs beyond Number precision and refuses malformed BigInt', () => {
    const original = { meso: 123456789012345678901234567890n, ethers: [10000000000000000000n] };
    expect(deserialize(serialize(original))).toEqual(original);
    expect(() => deserialize('{"$bigint":"NaN"}')).toThrow();
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
