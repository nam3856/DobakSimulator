import type { RuleData } from '../engine/rules';
import type { CharacterSnapshot, OptionLine } from '../types';
import { makeAbilityPresetGoal, resolveAbilityPreset } from './ability-presets';
import {
  BUNDLED_OPTIMIZER_AVATARS,
  buildOptimizerWalkUrl,
  createOptimizerAvatar,
  type OptimizerAvatarDescriptor,
} from './optimizer-avatar';

export interface OptimizerIntroPortrait {
  name: string;
  job: string;
  avatar: OptimizerAvatarDescriptor;
  options: OptionLine[];
}

/** Uses only bundled metadata and already loaded snapshots; never looks up a character. */
export function createOptimizerIntroPortraits(
  data: RuleData,
  characters: readonly CharacterSnapshot[] = [],
  baseUrl = import.meta.env.BASE_URL,
): OptimizerIntroPortrait[] {
  const portraits = new Map<string, OptimizerIntroPortrait>(
    BUNDLED_OPTIMIZER_AVATARS.map((entry) => [
      entry.name,
      {
        name: entry.name,
        job: entry.job,
        avatar: createOptimizerAvatar({ name: entry.name, imageUrl: '' }, Math.random, baseUrl),
        options: makeAbilityPresetGoal(data, entry.job).lines,
      },
    ]),
  );

  for (const character of characters) {
    const name = character.name.trim();
    if (!name || !resolveAbilityPreset(character.job)) continue;
    const bundled = BUNDLED_OPTIMIZER_AVATARS.some((entry) => entry.name === name);
    if (!bundled) {
      try {
        buildOptimizerWalkUrl(character.imageUrl, 1);
      } catch {
        // Unsupported image sources cannot provide the walking frames used by this scene.
        continue;
      }
    }
    portraits.set(name, {
      name,
      job: character.job,
      avatar: createOptimizerAvatar({ name, imageUrl: character.imageUrl }, Math.random, baseUrl),
      options: makeAbilityPresetGoal(data, character.job).lines,
    });
  }
  return [...portraits.values()];
}
