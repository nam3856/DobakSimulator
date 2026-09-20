/// <reference lib="webworker" />
import { evaluateBonusReroll, type BonusConfig, type BonusStats } from '../engine/bonus-options';
self.onmessage = (event: MessageEvent<{ config: BonusConfig; previous?: Partial<BonusStats> }>) => {
  try {
    self.postMessage({ result: evaluateBonusReroll(event.data.config, event.data.previous) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : '추가옵션 기댓값을 계산하지 못했습니다.',
    });
  }
};
