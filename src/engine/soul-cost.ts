import type { ResourceCost, SimulationConfig } from '../types';
import { isNormalAbility } from './rules';

export const DEFAULT_ETHER_PRICES: Record<string, string> = {
  ether1: '1500000000',
  ether2: '2000000000',
  ether3: '1200000000',
  ether4: '4000000000',
};

/** Migrate old blank settings while preserving explicit prices, including zero. */
export function withDefaultEtherPrices(prices: Record<string, string>) {
  const result = { ...prices };
  for (const [key, value] of Object.entries(DEFAULT_ETHER_PRICES))
    if (!result[key]?.trim()) result[key] = value;
  return result;
}

export function etherPrice(config: SimulationConfig, stage: number): bigint {
  const value = config.unitPrices[`ether${stage}`];
  return value && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

export function etherMarketValue(config: SimulationConfig, cost: ResourceCost): bigint {
  return cost.ethers.reduce((sum, count, index) => sum + count * etherPrice(config, index + 1), 0n);
}

/** Keep the resource ledger intact; value consumed ethers for soul amplification. */
export function paidBenchmarkCost(config: SimulationConfig, cost: ResourceCost): bigint {
  if (isNormalAbility(config)) return cost.honor;
  if (config.mode === 'soulAmplification') return cost.meso + etherMarketValue(config, cost);
  if (config.mode === 'cube' && ['gold', 'prime', 'primeAdditional'].includes(config.cubeType))
    return cost.cubes;
  return cost.meso;
}
