/// <reference lib="webworker" />
import { benchmarkStarforce, type StarforceConfig, type StarforceRules } from '../engine/starforce';

self.onmessage = (event: MessageEvent<{ rules: StarforceRules; config: StarforceConfig }>) => {
  try {
    self.postMessage({ result: benchmarkStarforce(event.data.rules, event.data.config) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : '기댓값 계산에 실패했습니다.',
    });
  }
};
