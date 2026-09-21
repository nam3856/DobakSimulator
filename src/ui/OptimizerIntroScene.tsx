import { useEffect, useMemo, useState } from 'react';
import type { RuleData } from '../engine/rules';
import type { OptimizerAvatarDescriptor } from '../character/optimizer-avatar';
import type { CharacterSnapshot } from '../types';
import { createOptimizerIntroPortraits } from '../character/optimizer-intro-portraits';
import { OptimizerWalkingAvatar } from './OptimizerWalkingAvatar';
import { OptimizerIntroOptions } from './OptimizerIntroOptions';

const CHARACTER_INTERVAL = 5_000;
const CROSSFADE_DURATION = 320;

export function OptimizerIntroScene({
  initialAvatar,
  data,
  characters,
}: {
  initialAvatar: OptimizerAvatarDescriptor;
  data: RuleData;
  characters: readonly CharacterSnapshot[];
}) {
  const portraits = useMemo(
    () => createOptimizerIntroPortraits(data, characters),
    [data, characters],
  );
  const [scene, setScene] = useState(() => ({
    current: Math.max(
      0,
      portraits.findIndex((entry) => entry.name === initialAvatar.name),
    ),
    previous: null as number | null,
  }));
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [hidden, setHidden] = useState(() => document.hidden);

  useEffect(() => {
    if (reducedMotion || hidden) return;
    // Warm the existing frame URLs before the first swap; no character lookup is needed.
    for (const portrait of portraits) {
      for (const src of portrait.avatar.frames) {
        const frame = new Image();
        frame.src = src;
      }
    }
  }, [portraits, reducedMotion, hidden]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = () => setReducedMotion(preference.matches);
    const onVisibility = () => setHidden(document.hidden);
    preference.addEventListener('change', onPreference);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      preference.removeEventListener('change', onPreference);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    if (reducedMotion || hidden || portraits.length < 2) return;
    const timer = window.setInterval(() => {
      setScene(({ current }) => ({
        previous: current,
        current:
          (current + 1 + Math.floor(Math.random() * (portraits.length - 1))) % portraits.length,
      }));
    }, CHARACTER_INTERVAL);
    return () => window.clearInterval(timer);
  }, [reducedMotion, hidden, portraits.length]);

  useEffect(() => {
    if (scene.previous === null) return;
    if (reducedMotion) {
      setScene((current) => ({ ...current, previous: null }));
      return;
    }
    const timer = window.setTimeout(
      () => setScene((current) => ({ ...current, previous: null })),
      CROSSFADE_DURATION,
    );
    return () => window.clearTimeout(timer);
  }, [scene.current, scene.previous, reducedMotion]);

  const currentIndex = Math.min(scene.current, portraits.length - 1);
  const current = portraits[currentIndex];
  const layers = (scene.previous === null ? [currentIndex] : [scene.previous, currentIndex]).filter(
    (index, position, all) => portraits[index] && all.indexOf(index) === position,
  );
  return (
    <div
      className="optimizer-intro-scene"
      aria-hidden="true"
      data-character={current.name}
      data-job={current.job}
      data-paused={hidden || reducedMotion}
    >
      <OptimizerIntroOptions
        character={current.name}
        options={current.options}
        paused={hidden}
        reducedMotion={reducedMotion}
      />
      <div className="optimizer-intro-portrait">
        {layers.map((index) => (
          <div
            className="optimizer-intro-avatar-layer"
            key={portraits[index].name}
            data-active={index === currentIndex}
            data-character={portraits[index].name}
          >
            <OptimizerWalkingAvatar avatar={portraits[index].avatar} paused={hidden} />
          </div>
        ))}
      </div>
    </div>
  );
}
