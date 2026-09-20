import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_OPTIMIZER_AVATARS,
  buildOptimizerWalkUrl,
  createOptimizerAvatar,
  OPTIMIZER_WALK_SEQUENCE,
} from '../src/character/optimizer-avatar';

describe('optimizer walking avatars', () => {
  it('selects each fallback from local assets without any lookup', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      for (const [index, entry] of BUNDLED_OPTIMIZER_AVATARS.entries()) {
        const random = vi.fn(() => (index + 0.5) / 3);
        const avatar = createOptimizerAvatar(undefined, random, '/DobakSimulator/');
        expect(avatar.name).toBe(entry.name);
        expect(avatar.frames).toEqual(
          [1, 2, 3].map(
            (frame) => `/DobakSimulator/character/optimizer/${entry.directory}/walk-${frame}.png`,
          ),
        );
        expect(random).toHaveBeenCalledOnce();
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('uses bundled frames for all three known nicknames even after API import', () => {
    const random = vi.fn(() => 0);
    for (const entry of BUNDLED_OPTIMIZER_AVATARS) {
      const avatar = createOptimizerAvatar({ name: entry.name, imageUrl: 'invalid' }, random, './');
      expect(
        avatar.frames.every((path) => path.startsWith(`./character/optimizer/${entry.directory}/`)),
      ).toBe(true);
    }
    expect(random).not.toHaveBeenCalled();
  });

  it('preserves the imported outfit while constructing all walk frames', () => {
    const avatar = createOptimizerAvatar(
      {
        name: '새캐릭터',
        imageUrl: 'https://open.api.nexon.com/static/maplestory/character/look/outfit?action=A00.0',
      },
      Math.random,
      '/sim/',
    );
    for (const [index, frame] of avatar.frames.entries()) {
      const url = new URL(frame);
      expect(url.pathname).toBe('/static/maplestory/character/look/outfit');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        action: `A02.${index + 1}`,
        emotion: 'E00.0',
        width: '240',
        height: '200',
        x: '120',
        y: '150',
      });
    }
    expect(
      OPTIMIZER_WALK_SEQUENCE.map((index) =>
        new URL(avatar.frames[index]).searchParams.get('action'),
      ),
    ).toEqual(['A02.1', 'A02.2', 'A02.3', 'A02.2']);
  });

  it('falls back to local artwork for untrusted or malformed image URLs', () => {
    for (const imageUrl of ['bad', 'http://open.api.nexon.com/a', 'https://example.com/a']) {
      expect(() => buildOptimizerWalkUrl(imageUrl, 1)).toThrow();
      const avatar = createOptimizerAvatar({ name: '새캐릭터', imageUrl }, Math.random, '/sim/');
      expect(avatar.frames).toEqual(Array(3).fill('/sim/character/neutral.png'));
      expect(avatar.fallbackSrc).toBe('/sim/character/neutral.png');
    }
  });

  it('ships all nine correctly sized PNG frames described by the manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../public/character/optimizer/manifest.json', import.meta.url), 'utf8'),
    );
    expect(manifest.characters.map((character: { name: string }) => character.name)).toEqual(
      BUNDLED_OPTIMIZER_AVATARS.map((character) => character.name),
    );
    expect(manifest.frameOrder).toEqual([1, 2, 3, 2]);
    for (const character of manifest.characters) {
      expect(character.frames).toHaveLength(3);
      const frames = [];
      for (const path of character.frames) {
        const png = readFileSync(new URL(`../public/character/optimizer/${path}`, import.meta.url));
        expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([300, 300]);
        frames.push(png.toString('base64'));
      }
      expect(new Set(frames).size).toBe(3);
    }
  });
});
