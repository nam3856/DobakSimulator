/// <reference lib="webworker" />
import { benchmarkStarforce, type StarforceConfig, type StarforceRules } from '../engine/starforce';
import { optimizeStarforce } from '../engine/starforce-optimizer';
import {
  sampleStarforceCosts,
  starforceCostCdf,
  summarizeStarforceDistribution,
} from '../engine/starforce-distribution';

let costs: Float64Array | undefined;
type Request =
  | { type?: 'benchmark' | 'optimize'; rules: StarforceRules; config: StarforceConfig }
  | { type: 'cdf'; actualCost: number };

self.onmessage = (event: MessageEvent<Request>) => {
  try {
    const request = event.data;
    if (request.type === 'cdf') {
      if (costs)
        self.postMessage({
          type: 'cdf',
          actualCost: request.actualCost,
          cdf: starforceCostCdf(costs, request.actualCost),
        });
      return;
    }
    if (request.type === 'optimize') {
      self.postMessage({ result: optimizeStarforce(request.rules, request.config) });
      return;
    }
    costs = undefined;
    const result = benchmarkStarforce(request.rules, request.config);
    // The exact mean is available immediately; aggregate sampling never blocks play.
    self.postMessage({ type: 'benchmark', result });
    if (result.status === 'ready') {
      try {
        costs = sampleStarforceCosts(request.rules, request.config);
        self.postMessage({ type: 'distribution', result: summarizeStarforceDistribution(costs) });
      } catch (error) {
        self.postMessage({
          type: 'distribution',
          error: error instanceof Error ? error.message : '비용 분포 계산에 실패했습니다.',
        });
      }
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : '기댓값 계산에 실패했습니다.',
    });
  }
};
