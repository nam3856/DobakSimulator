export type Grade = 'rare' | 'epic' | 'unique' | 'legendary';
export type LineGrade = Grade | 'normal';
export type SimulatorMode = 'cube' | 'ability' | 'soulAmplification' | 'soulPotential';
export type CubeType = 'black' | 'additional' | 'gold' | 'prime' | 'primeAdditional';
export type OptionUnit = 'flat' | 'percent' | 'second' | 'level' | 'text';
export interface OptionLine {
  id: string;
  type: string;
  value: number;
  unit: OptionUnit;
  text: string;
  grade: LineGrade;
  abilityTypeId?: string;
}
export interface TargetCondition {
  type: string;
  minValue: number;
  maxValue?: number;
  minGrade?: Grade;
  slot?: number;
  slots?: number[];
  count?: number;
}
export interface Goal {
  mode: 'sum' | 'exact' | 'grade' | 'stage' | 'ability';
  minimumGrade: Grade;
  conditions: TargetCondition[];
  lines: OptionLine[];
  stage: number;
  match: 'all' | 'any';
}
export interface StartState {
  grade: Grade;
  lines: OptionLine[];
  stage: number;
  failures: number;
}
export interface SimulationConfig {
  mode: SimulatorMode;
  cubeType: CubeType;
  category: string;
  level: number;
  start: StartState;
  lockedSlots: number[];
  abilityStrategy?: 'lowerFirst' | 'firstLocked' | 'fixed';
  abilityPresetJob?: string;
  batchSize: 1 | 3;
  target: Goal;
  ruleVersion: string;
  unitPrices: Record<string, string>;
}
export interface ResourceCost {
  meso: bigint;
  honor: bigint;
  cubes: bigint;
  credits: bigint;
  ethers: bigint[];
}
export interface RollResult {
  sequence: bigint;
  grade: Grade;
  lines: OptionLine[];
  stage: number;
  promoted: boolean;
  amplified: boolean;
  hit: boolean;
  cost: ResourceCost;
  lockedSlots?: number[];
  progressed?: boolean;
  adopted?: boolean;
}
export interface SimulationState {
  grade: Grade;
  lines: OptionLine[];
  stage: number;
  failures: number;
  attempts: bigint;
  lockedSlots?: number[];
  spent: ResourceCost;
  status: 'idle' | 'running' | 'paused' | 'success' | 'impossible';
  history: RollResult[];
  candidates: RollResult[];
  startedAt: string;
  finishedAt?: string;
}
export interface BenchmarkResult {
  status: 'ready' | 'already' | 'impossible' | 'partial';
  expectedCost: number;
  expectedAttempts: number;
  successProbability: number;
  unit: 'meso' | 'cubes';
  method: 'analytic' | 'sampled';
  sampleCount: number;
  quantiles: { p10: number; p50: number; p90: number };
  distribution: { cost: number; cdf: number }[];
  cdfAtActual?: number;
  note?: string;
}
export type LuckReaction = 'jackpot' | 'happy' | 'neutral' | 'cry' | 'ghost';
export interface EquipmentSnapshot {
  id: string;
  name: string;
  category: string;
  slot: string;
  level: number;
  imageUrl: string;
  /** Actual API value; absent when the source did not provide a valid star count. */
  starforce?: number;
  /** Explicit superior marker from the item name/description; absence is unknown. */
  superiorEquipment?: boolean;
  /** Whether an amazing equipment enhancement scroll was applied (blue stars). */
  extraordinaryStarforce?: boolean;
  potentialGrade?: Grade;
  potential: OptionLine[];
  additionalGrade?: Grade;
  additional: OptionLine[];
  soul?: { name: string; active: boolean; stage: number; grade?: Grade; lines: OptionLine[] };
  eligibleSoul: boolean;
}
export interface AbilitySnapshot {
  grade: Grade;
  lines: OptionLine[];
  honor: number;
}
export interface CharacterProfile {
  mainStats: string[];
  secondaryStats: string[];
  attackType: 'attack' | 'magicAttack';
}
export interface CharacterSnapshot {
  bundledAvatars?: boolean;
  /** Separate provenance when only Star Force metadata was refreshed in the bundled snapshot. */
  starforceFetchedAt?: string;
  name: string;
  world: string;
  job: string;
  level: number;
  imageUrl: string;
  fetchedAt: string;
  sourceUrl: string;
  equipmentPresets: Record<string, EquipmentSnapshot[]>;
  abilityPresets: Record<string, AbilitySnapshot>;
  activeEquipmentPreset: string;
  activeAbilityPreset: string;
  profile: CharacterProfile;
}
export type WorkerRequest =
  | {
      type: 'benchmark';
      id: string;
      config: SimulationConfig;
      actualCost?: number;
      baseUrl?: string;
    }
  | {
      type: 'run';
      id: string;
      config: SimulationConfig;
      state: SimulationState;
      baseUrl?: string;
    }
  | { type: 'stop'; id: string };
export type WorkerResponse =
  | { type: 'benchmark'; id: string; result: BenchmarkResult }
  | { type: 'state'; id: string; state: SimulationState; done: boolean }
  | { type: 'error'; id: string; message: string };
