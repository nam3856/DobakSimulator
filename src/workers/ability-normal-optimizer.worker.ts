/// <reference lib="webworker" />
import { loadRuleData } from '../engine/rules';
import {
  optimizeNormalAbility,
  type NormalAbilityOptimizerInput,
  type NormalAbilityOptimizerResult,
} from '../engine/ability-normal-optimizer';

export interface NormalOptimizerRequest {
  id: string;
  baseUrl: string;
  input: NormalAbilityOptimizerInput;
}
export type NormalOptimizerResponse =
  { id: string; result: NormalAbilityOptimizerResult } | { id: string; error: string };

let baseUrl = '';
let rules: ReturnType<typeof loadRuleData> | undefined;
let miracleRules: Promise<NormalAbilityOptimizerInput['miracleRules']> | undefined;

self.onmessage = async ({ data: request }: MessageEvent<NormalOptimizerRequest>) => {
  try {
    if (!rules || baseUrl !== request.baseUrl) {
      baseUrl = request.baseUrl;
      rules = loadRuleData(baseUrl).catch((error) => {
        rules = undefined;
        throw error;
      });
      miracleRules = fetch(new URL('rules/ability-miracle.json', baseUrl))
        .then(async (response) => (response.ok ? await response.json() : undefined))
        .catch(() => undefined);
    }
    const [data, miracle] = await Promise.all([rules, miracleRules]);
    self.postMessage({
      id: request.id,
      result: optimizeNormalAbility(data, { ...request.input, miracleRules: miracle }),
    } satisfies NormalOptimizerResponse);
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies NormalOptimizerResponse);
  }
};
