import { useCallback, useEffect, useRef, useState } from 'react';
import type { SimulationState } from '../types';
import { SOUL_CHARGE_MS, SOUL_RESULT_MS, SOUL_SUCCESS_RESULT_MS } from './SoulAmplificationDisplay';

interface AmplificationAnimation {
  phase: 'charging' | 'success' | 'failure';
  fromStage: number;
  attemptKey: string;
}

export function useSoulAmplificationAnimation() {
  const [animation, setAnimation] = useState<AmplificationAnimation>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    busy.current = false;
    setAnimation(undefined);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  const play = useCallback((next: SimulationState) => {
    const result = next.candidates[0];
    if (!result) return;
    clearTimeout(timer.current);
    busy.current = true;
    const outcome = result.amplified ? 'success' : 'failure';
    const attempt = {
      fromStage: result.stage - (result.amplified ? 1 : 0),
      attemptKey: `${next.startedAt}:${result.sequence}`,
    };
    setAnimation({ ...attempt, phase: 'charging' });
    timer.current = setTimeout(() => {
      setAnimation({ ...attempt, phase: outcome });
      timer.current = setTimeout(
        () => {
          busy.current = false;
          setAnimation(undefined);
        },
        outcome === 'success' ? SOUL_SUCCESS_RESULT_MS : SOUL_RESULT_MS,
      );
    }, SOUL_CHARGE_MS);
  }, []);

  return { animation, busy, play, clear };
}
