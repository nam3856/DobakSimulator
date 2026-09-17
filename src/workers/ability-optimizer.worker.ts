/// <reference lib="webworker" />
import { loadRuleData } from '../engine/rules';
import {
  optimizeAbilityCost,
  type AbilityOptimizerInput,
  type AbilityOptimizerResult,
} from '../engine/ability-optimizer';

export interface OptimizerRequest {
  id: string;
  baseUrl: string;
  input: AbilityOptimizerInput;
}
export type OptimizerResponse =
  | { id: string; result: AbilityOptimizerResult }
  | { id: string; error: string };

let baseUrl = '';
let rules: ReturnType<typeof loadRuleData> | undefined;

self.onmessage = async ({ data: request }: MessageEvent<OptimizerRequest>) => {
  try {
    if (!rules || baseUrl !== request.baseUrl) {
      baseUrl = request.baseUrl;
      rules = loadRuleData(baseUrl).catch((error) => {
        rules = undefined;
        throw error;
      });
    }
    const data = await rules;
    const result = optimizeAbilityCost(data, request.input);
    self.postMessage({ id: request.id, result } satisfies OptimizerResponse);
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies OptimizerResponse);
  }
};
