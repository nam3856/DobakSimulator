import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { OptionLine } from '../types';

const OPTION_INTERVAL = 733;
interface FlyingOption {
  id: number;
  character: string;
  option: OptionLine;
}

/** Each emitted option keeps its own identity and text until it has left the scene. */
export function OptimizerIntroOptions({
  character,
  options,
  paused,
  reducedMotion,
}: {
  character: string;
  options: OptionLine[];
  paused: boolean;
  reducedMotion: boolean;
}) {
  const nextId = useRef(1);
  const source = useRef({ character, options, nextOption: 1 });
  const [flying, setFlying] = useState<FlyingOption[]>(() =>
    !reducedMotion && options[0] ? [{ id: 0, character, option: options[0] }] : [],
  );

  useEffect(() => {
    if (source.current.character !== character || source.current.options !== options)
      source.current = { character, options, nextOption: 0 };
  }, [character, options]);

  useEffect(() => {
    if (reducedMotion) {
      setFlying([]);
      return;
    }
    if (paused) return;
    const timer = window.setInterval(() => {
      const current = source.current;
      const option = current.options[current.nextOption % current.options.length];
      if (!option) return;
      current.nextOption += 1;
      const token = { id: nextId.current++, character: current.character, option };
      setFlying((previous) => [...previous, token]);
    }, OPTION_INTERVAL);
    return () => window.clearInterval(timer);
  }, [paused, reducedMotion]);

  const visible: FlyingOption[] = reducedMotion
    ? options.map((option, id) => ({ id, character, option }))
    : flying;

  return (
    <div className="optimizer-intro-options" data-current-character={character}>
      {visible.map((token) => (
        <div
          className="optimizer-intro-option-runner"
          key={token.id}
          data-option-id={token.id}
          data-option-character={token.character}
          style={{ '--option-lane': token.id % 3 } as CSSProperties}
          onAnimationEnd={(event) => {
            if (
              event.target !== event.currentTarget ||
              event.animationName !== 'optimizer-intro-option-pass'
            )
              return;
            setFlying((previous) => previous.filter((option) => option.id !== token.id));
          }}
        >
          <span className="optimizer-intro-option" data-option-type={token.option.type}>
            <span className="optimizer-intro-option-grade" />
            {token.option.text}
          </span>
        </div>
      ))}
    </div>
  );
}
