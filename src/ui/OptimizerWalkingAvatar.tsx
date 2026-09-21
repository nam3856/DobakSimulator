import { useEffect, useState } from 'react';
import {
  OPTIMIZER_WALK_FRAME_MS,
  OPTIMIZER_WALK_SEQUENCE,
  type OptimizerAvatarDescriptor,
} from '../character/optimizer-avatar';
import './optimizer-walking-avatar.css';

function WalkingFrames({ avatar, paused }: { avatar: OptimizerAvatarDescriptor; paused: boolean }) {
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [failed, setFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (paused || reducedMotion || failed || loaded !== 0b111) return;
    const timer = window.setInterval(
      () => setSequenceIndex((index) => (index + 1) % OPTIMIZER_WALK_SEQUENCE.length),
      OPTIMIZER_WALK_FRAME_MS,
    );
    return () => window.clearInterval(timer);
  }, [failed, loaded, reducedMotion, paused]);

  const frame = reducedMotion ? 1 : OPTIMIZER_WALK_SEQUENCE[sequenceIndex];
  return (
    <div
      className="optimizer-walking-avatar"
      role="img"
      aria-label={`${avatar.name} · ${reducedMotion || failed ? '계산을 기다리는 모습' : '걷는 모습'}`}
      data-walk-frame={failed ? 'fallback' : frame + 1}
    >
      {failed ? (
        fallbackFailed ? (
          <span className="optimizer-walk-placeholder" aria-hidden="true">
            {avatar.name.slice(0, 1)}
          </span>
        ) : (
          <img
            className="optimizer-walk-fallback"
            src={avatar.fallbackSrc}
            alt=""
            onError={() => setFallbackFailed(true)}
          />
        )
      ) : (
        avatar.frames.map((src, index) => (
          <img
            key={index}
            className="optimizer-walk-frame"
            src={src}
            alt=""
            aria-hidden="true"
            data-visible={index === frame}
            onLoad={() => setLoaded((mask) => mask | (1 << index))}
            onError={() => setFailed(true)}
          />
        ))
      )}
    </div>
  );
}

export function OptimizerWalkingAvatar({
  avatar,
  paused = false,
}: {
  avatar: OptimizerAvatarDescriptor;
  paused?: boolean;
}) {
  return <WalkingFrames key={avatar.frames.join('|')} avatar={avatar} paused={paused} />;
}
