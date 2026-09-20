import { useEffect, useMemo, useRef, useState } from 'react';
import { Flame, LoaderCircle, Pause, Play, RotateCcw, Settings2 } from 'lucide-react';
import type { BenchmarkResult, CharacterSnapshot } from '../types';
import {
  BONUS_FLAME_LABELS,
  BONUS_STAT_LABELS,
  bonusLuckPercentile,
  bonusRollCost,
  defaultBonusWeights,
  rollBonusOptions,
  scoreBonusStats,
  validateBonusConfig,
  type BonusConfig,
  type BonusRoll,
  type BonusStat,
  type BonusStats,
  type evaluateBonusReroll,
} from '../engine/bonus-options';
import { evaluateLuck } from '../engine/benchmark';
import { completeBonusStats, initialBonusConfig, isBonusEquipment } from './bonus-equipment';
import { DistributionChart, Field, ReactionStage } from './components';
import { formatAmount, formatPercent } from './format';
import { deserialize, serialize } from './storage';
import './bonus-options.css';

type Estimate = ReturnType<typeof evaluateBonusReroll>;
type Stats = Partial<BonusStats>;
interface BonusRun {
  start?: Stats;
  current?: Stats;
  last?: BonusRoll;
  attempts: bigint;
  spent: bigint;
  success: boolean;
  history: { attempt: bigint; score: number; hit: boolean }[];
}
interface SavedBonus {
  version: 1;
  preset: string;
  itemId: string;
  config: BonusConfig;
  run: BonusRun;
}
type LegacySavedBonus = Omit<SavedBonus, 'run'> & {
  run: BonusRun & { candidate?: BonusRoll };
};
const freshRun = (start?: Stats): BonusRun => ({
  start,
  current: start,
  attempts: 0n,
  spent: 0n,
  success: false,
  history: [],
});
const scoreText = (score: number) => score.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const percentStats = new Set<BonusStat>(['allStat', 'bossDamage', 'damage']);
const validStats = (stats: unknown): stats is Stats =>
  !!stats &&
  typeof stats === 'object' &&
  Object.entries(stats).every(
    ([key, value]) =>
      key in BONUS_STAT_LABELS && typeof value === 'number' && Number.isFinite(value) && value >= 0,
  );

const validRoll = (roll: BonusRoll | undefined) =>
  !roll ||
  (validStats(roll.stats) &&
    !!completeBonusStats(roll.stats) &&
    Number.isFinite(roll.score) &&
    roll.score >= 0 &&
    Array.isArray(roll.lines));

function BonusStatsList({ stats }: { stats: Stats }) {
  const entries = Object.entries(stats).filter(([, value]) => value !== undefined && value > 0) as [
    BonusStat,
    number,
  ][];
  return entries.length ? (
    <dl className="bonus-stat-list">
      {entries.map(([stat, value]) => (
        <div key={stat}>
          <dt>{BONUS_STAT_LABELS[stat]}</dt>
          <dd>
            +{value.toLocaleString('ko-KR')}
            {percentStats.has(stat) ? '%' : ''}
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="empty-copy">추가옵션 정보가 없어요.</p>
  );
}

export function BonusOptionSimulator({ character }: { character: CharacterSnapshot }) {
  const storageKey = `isekai:bonus-options:v1:${character.name}`;
  const [initial] = useState<SavedBonus>(() => {
    try {
      const saved = deserialize<LegacySavedBonus>(localStorage.getItem(storageKey) ?? 'null');
      if (
        saved?.version === 1 &&
        character.equipmentPresets[saved.preset] &&
        (saved.itemId === 'manual' ||
          character.equipmentPresets[saved.preset].some(
            (item) => item.id === saved.itemId && isBonusEquipment(item),
          )) &&
        validateBonusConfig(saved.config).length === 0 &&
        (saved.run.start === undefined ||
          (validStats(saved.run.start) && completeBonusStats(saved.run.start))) &&
        (saved.run.current === undefined ||
          (validStats(saved.run.current) && completeBonusStats(saved.run.current))) &&
        validRoll(saved.run.candidate) &&
        validRoll(saved.run.last) &&
        typeof saved.run.attempts === 'bigint' &&
        saved.run.attempts >= 0n &&
        typeof saved.run.spent === 'bigint' &&
        saved.run.spent >= 0n &&
        typeof saved.run.success === 'boolean' &&
        Array.isArray(saved.run.history) &&
        saved.run.history.length <= 30 &&
        saved.run.history.every(
          (entry) =>
            entry &&
            typeof entry.attempt === 'bigint' &&
            entry.attempt > 0n &&
            Number.isFinite(entry.score) &&
            entry.score >= 0 &&
            typeof entry.hit === 'boolean',
        )
      ) {
        // A result already paid for before immediate application was introduced
        // becomes the current option without charging another roll.
        const { candidate, ...restoredRun } = saved.run;
        if (candidate) {
          restoredRun.current = candidate.stats;
          restoredRun.last = candidate;
          restoredRun.success =
            scoreBonusStats(candidate.stats, saved.config.weights) >= saved.config.targetScore;
        }
        return { ...saved, run: restoredRun };
      }
    } catch {
      /* Start safely when a browser save cannot be read. */
    }
    const preset = character.activeEquipmentPreset;
    const item = character.equipmentPresets[preset]?.find(isBonusEquipment);
    return {
      version: 1,
      preset,
      itemId: item?.id ?? 'manual',
      config: initialBonusConfig(character, item),
      run: freshRun(completeBonusStats(item?.bonusOptions)),
    };
  });
  const [preset, setPreset] = useState(initial.preset);
  const [itemId, setItemId] = useState(initial.itemId);
  const [config, setConfig] = useState(initial.config);
  const [run, setRun] = useState(initial.run);
  const [auto, setAuto] = useState(false);
  const [estimate, setEstimate] = useState<Estimate>();
  const [estimateError, setEstimateError] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(true);
  const live = useRef(run);
  live.current = run;
  const items = (character.equipmentPresets[preset] ?? []).filter(isBonusEquipment);
  const item = items.find((value) => value.id === itemId);
  const errors = useMemo(() => validateBonusConfig(config), [config]);
  const score = scoreBonusStats(run.current ?? {}, config.weights);
  const reached = score >= config.targetScore;
  const canRun =
    !errors.length && !run.success && !reached && !!estimate && estimate.successProbability > 0;
  const locked = auto;
  const cost = errors.length ? 0 : bonusRollCost(config);

  useEffect(() => {
    setEstimate(undefined);
    setEstimateError('');
    if (errors.length) return;
    const worker = new Worker(new URL('../workers/bonus-options.worker.ts', import.meta.url), {
      type: 'module',
    });
    let active = true;
    worker.onmessage = (event: MessageEvent<{ result?: Estimate; error?: string }>) => {
      if (!active) return;
      setEstimate(event.data.result);
      setEstimateError(event.data.error ?? '');
    };
    worker.onerror = () => {
      if (active) setEstimateError('기댓값을 계산하지 못했습니다. 설정을 다시 확인해 주세요.');
    };
    worker.postMessage({ config, previous: run.start });
    return () => {
      active = false;
      worker.terminate();
    };
  }, [config, run.start, errors]);

  const persisted = useRef<SavedBonus>({ version: 1, preset, itemId, config, run });
  persisted.current = { version: 1, preset, itemId, config, run };
  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem(storageKey, serialize(persisted.current));
      } catch {
        /* Session remains usable. */
      }
    };
    addEventListener('pagehide', flush);
    return () => {
      flush();
      removeEventListener('pagehide', flush);
    };
  }, [storageKey]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, serialize(persisted.current));
        setSaved(true);
      } catch {
        setSaved(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [storageKey, preset, itemId, config, run]);

  function commit(next: BonusRun) {
    live.current = next;
    setRun(next);
  }
  function draw(previous: BonusRun): BonusRun {
    const result = rollBonusOptions(config, Math.random, previous.current);
    const attempts = previous.attempts + 1n;
    const hit = result.score >= config.targetScore;
    return {
      ...previous,
      attempts,
      spent: previous.spent + BigInt(cost),
      last: result,
      current: result.stats,
      success: hit,
      history: [{ attempt: attempts, score: result.score, hit }, ...previous.history].slice(0, 30),
    };
  }
  useEffect(() => {
    if (!auto || !canRun) return;
    const timer = setTimeout(() => {
      try {
        let next = live.current;
        const until = performance.now() + 12;
        for (let i = 0; i < 500 && !next.success; i++) {
          next = draw(next);
          if (performance.now() >= until) break;
        }
        commit(next);
        if (next.success) setAuto(false);
      } catch (reason) {
        setAuto(false);
        setError(reason instanceof Error ? reason.message : '추가옵션 재설정에 실패했습니다.');
      }
    }, 24);
    return () => clearTimeout(timer);
  }, [auto, canRun, run, config, cost]);

  function reset(nextConfig = config, start = completeBonusStats(item?.bonusOptions)) {
    setAuto(false);
    setError('');
    setConfig(nextConfig);
    commit(freshRun(start));
  }
  function patch(patch: Partial<BonusConfig>) {
    reset({ ...config, ...patch });
  }
  function selectItem(id: string, nextPreset = preset) {
    const selected = character.equipmentPresets[nextPreset]?.find((value) => value.id === id);
    setPreset(nextPreset);
    setItemId(id);
    const next = initialBonusConfig(character, selected);
    reset(
      { ...next, flame: config.flame, costPerRoll: config.costPerRoll },
      completeBonusStats(selected?.bonusOptions),
    );
  }
  function restart() {
    reset();
    setAuto(true);
  }
  const countBased = cost === 0;
  const compareCost = countBased ? Number(run.attempts) : Number(run.spent);
  const costBenchmark: BenchmarkResult | undefined = useMemo(() => {
    if (!estimate) return;
    const probability = estimate.successProbability;
    const unitCost = cost || 1;
    const quantile = (p: number) =>
      probability <= 0
        ? Infinity
        : probability >= 1
          ? 1
          : Math.max(1, Math.ceil(Math.log1p(-p) / Math.log1p(-probability)));
    const already = estimate.alreadySatisfied;
    return {
      status: already ? 'already' : probability <= 0 ? 'impossible' : 'ready',
      expectedCost: already ? 0 : estimate.expectedRolls * unitCost,
      expectedAttempts: estimate.expectedRolls,
      successProbability: probability,
      unit: countBased ? 'cubes' : 'meso',
      method: 'analytic',
      sampleCount: 0,
      quantiles: {
        p10: quantile(0.1) * unitCost,
        p50: quantile(0.5) * unitCost,
        p90: quantile(0.9) * unitCost,
      },
      distribution:
        probability > 0
          ? Array.from({ length: 100 }, (_, index) => {
              const count = quantile((index + 1) / 101);
              return { cost: count * unitCost, cdf: bonusLuckPercentile(probability, count) / 100 };
            })
          : [],
      cdfAtActual: run.success
        ? bonusLuckPercentile(probability, Number(run.attempts)) / 100
        : undefined,
    };
  }, [estimate, cost, countBased, run.success, run.attempts]);
  const reaction =
    run.success && costBenchmark ? evaluateLuck(costBenchmark, compareCost) : undefined;

  return (
    <div className="workspace bonus-workspace">
      <aside className="setup-column">
        <section className="panel settings-panel">
          <div className="panel-heading">
            <h2>
              <Settings2 size={17} /> 추가옵션 설정
            </h2>
            <span className="panel-step">01</span>
          </div>
          <fieldset className="bonus-fields" disabled={locked}>
            <Field label="장비 프리셋">
              <select
                value={preset}
                onChange={(event) => {
                  const nextPreset = event.target.value;
                  selectItem(
                    character.equipmentPresets[nextPreset]?.find(isBonusEquipment)?.id ?? 'manual',
                    nextPreset,
                  );
                }}
              >
                {Object.keys(character.equipmentPresets).map((value) => (
                  <option key={value} value={value}>
                    프리셋 {value}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="추가옵션 장비">
              <select value={itemId} onChange={(event) => selectItem(event.target.value)}>
                {items.map((value) => (
                  <option key={value.id} value={value.id}>
                    [{value.slot}] {value.name}
                  </option>
                ))}
                <option value="manual">장비 직접 설정</option>
              </select>
            </Field>
            <Field label="재설정 방법">
              <select
                value={config.flame}
                onChange={(event) =>
                  patch({
                    flame: event.target.value as BonusConfig['flame'],
                    costPerRoll: event.target.value === 'meso' ? undefined : 0,
                  })
                }
              >
                {Object.entries(BONUS_FLAME_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {config.flame === 'meso' ? (
              <p className="bonus-help">1회 300만 메소 · 검은 환생의 불꽃과 같은 확률</p>
            ) : (
              <Field
                label="환생의 불꽃 1개 가격 (메소)"
                hint="직접 보유한 아이템은 0으로 두면 횟수로 행운을 비교해요."
              >
                <input
                  type="number"
                  min="0"
                  max="1000000000000"
                  step="1"
                  value={config.costPerRoll ?? 0}
                  onChange={(event) => patch({ costPerRoll: Number(event.target.value) })}
                />
              </Field>
            )}
            <div className="field-row">
              <Field label="장비 레벨">
                <input
                  type="number"
                  min="1"
                  max="300"
                  value={config.equipment.level}
                  onChange={(event) =>
                    patch({ equipment: { ...config.equipment, level: Number(event.target.value) } })
                  }
                />
              </Field>
              <Field label="장비 분류">
                <select
                  value={config.equipment.kind}
                  onChange={(event) =>
                    patch({
                      equipment: {
                        ...config.equipment,
                        kind: event.target.value as 'weapon' | 'armor',
                      },
                    })
                  }
                >
                  <option value="armor">방어구·장신구</option>
                  <option value="weapon">무기</option>
                </select>
              </Field>
            </div>
            <Field
              label="추가옵션 유형"
              hint="장비 이름에 맞춰 선택했어요. 다른 유형의 장비라면 변경해 주세요."
            >
              <select
                value={config.equipment.boss ? 'boss' : 'normal'}
                onChange={(event) =>
                  patch({ equipment: { ...config.equipment, boss: event.target.value === 'boss' } })
                }
              >
                <option value="boss">보스 장비 · 4개 옵션</option>
                <option value="normal">일반 장비 · 1~4개 옵션</option>
              </select>
            </Field>
            {config.equipment.kind === 'weapon' && (
              <div className="field-row">
                <Field label="무기 기본 공격력">
                  <input
                    type="number"
                    min="0"
                    value={config.equipment.baseAttack ?? ''}
                    onChange={(event) =>
                      patch({
                        equipment: { ...config.equipment, baseAttack: Number(event.target.value) },
                      })
                    }
                  />
                </Field>
                <Field label="무기 기본 마력">
                  <input
                    type="number"
                    min="0"
                    value={config.equipment.baseMagicAttack ?? ''}
                    onChange={(event) =>
                      patch({
                        equipment: {
                          ...config.equipment,
                          baseMagicAttack: Number(event.target.value),
                        },
                      })
                    }
                  />
                </Field>
              </div>
            )}
            <details className="bonus-details">
              <summary>특수 장비 설정</summary>
              <Field
                label="추가옵션 단계 고정"
                hint="일부 이벤트·구형 장비처럼 추가옵션 단계가 고정된 경우에만 선택하세요."
              >
                <select
                  value={config.equipment.fixedTier ?? ''}
                  onChange={(event) =>
                    patch({
                      equipment: {
                        ...config.equipment,
                        fixedTier: event.target.value ? Number(event.target.value) : undefined,
                      },
                    })
                  }
                >
                  <option value="">일반 확률 적용</option>
                  {[1, 2, 3, 4, 5, 6, 7].map((value) => (
                    <option key={value} value={value}>
                      {value}단계 고정
                    </option>
                  ))}
                </select>
              </Field>
            </details>
          </fieldset>
          {item && !completeBonusStats(item.bonusOptions) && (
            <p className="notice">
              저장된 장비에 현재 추옵 정보가 없어요. 캐릭터를 다시 검색하면 불러올 수 있습니다.
              지금은 기존 추옵을 모르는 상태로 계산해요.
            </p>
          )}
        </section>
        <section className="panel goal-panel">
          <div className="panel-heading">
            <h2>
              <Flame size={17} /> 목표 추옵
            </h2>
            <span className="panel-step">02</span>
          </div>
          <fieldset className="bonus-fields" disabled={locked}>
            <Field label="목표 환산 추옵">
              <input
                type="number"
                min="1"
                max="1000000000"
                step="1"
                value={config.targetScore}
                onChange={(event) => patch({ targetScore: Number(event.target.value) })}
              />
            </Field>
            <Field label="추옵 환산 기준">
              <select
                value="custom"
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === 'hp') patch({ weights: { hp: 1, attack: 100 } });
                  else if (value === 'xenon')
                    patch({ weights: { str: 1, dex: 1, luk: 1, attack: 3, allStat: 20 } });
                  else if (value !== 'custom')
                    patch({
                      weights: defaultBonusWeights(
                        value as 'str' | 'dex' | 'int' | 'luk',
                        value === 'int' ? 'magicAttack' : 'attack',
                      ),
                    });
                }}
              >
                <option value="custom">현재 환산 비율 · 직접 조정 가능</option>
                <option value="str">STR 기준</option>
                <option value="dex">DEX 기준</option>
                <option value="int">INT 기준</option>
                <option value="luk">LUK 기준</option>
                <option value="hp">HP 기준</option>
                <option value="xenon">제논 기준</option>
              </select>
            </Field>
            <p className="bonus-help">
              추옵 수치 × 환산 비율을 모두 더해 목표와 비교합니다. 직업·장비에 맞게 비율을
              조정하세요.
            </p>
            <details className="bonus-details" open>
              <summary>환산 비율 조정</summary>
              <div className="bonus-weight-grid">
                {(
                  [
                    'str',
                    'dex',
                    'int',
                    'luk',
                    'attack',
                    'magicAttack',
                    'allStat',
                    'hp',
                    'bossDamage',
                    'damage',
                  ] as BonusStat[]
                ).map((stat) => (
                  <Field key={stat} label={`${BONUS_STAT_LABELS[stat]} 환산 비율`}>
                    <input
                      type="number"
                      min="0"
                      max="10000"
                      step="0.1"
                      value={config.weights[stat] ?? 0}
                      onChange={(event) =>
                        patch({
                          weights: { ...config.weights, [stat]: Number(event.target.value) },
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
            </details>
          </fieldset>
          <p className="bonus-help">
            설정을 바꾸면 선택한 장비의 원래 추옵에서 새 도전을 시작합니다.
          </p>
        </section>
      </aside>
      <div className="bonus-results">
        <section className="panel simulation-panel">
          <div className="panel-heading">
            <h2>
              <Flame size={18} /> 추가옵션 재설정
            </h2>
            <span className="tag">{BONUS_FLAME_LABELS[config.flame]}</span>
          </div>
          <div className="bonus-item-heading">
            {item?.imageUrl ? <img src={item.imageUrl} alt="" /> : <Flame size={36} />}
            <div>
              <strong>{item?.name ?? '직접 설정한 장비'}</strong>
              <small>
                Lv.{config.equipment.level} · 목표 {scoreText(config.targetScore)}급
              </small>
            </div>
          </div>
          <section className={`bonus-result-card bonus-new ${run.success ? 'is-goal' : ''}`}>
            <span className="small-label">{run.success ? '목표 달성 옵션' : '현재 추가옵션'}</span>
            <strong className="bonus-score">
              {scoreText(score)}
              <small>급</small>
            </strong>
            <BonusStatsList stats={run.current ?? {}} />
          </section>
          {(errors.length > 0 || error || estimateError) && (
            <div className="notice error" role="alert">
              {errors.join(' ') || error || estimateError}
            </div>
          )}
          {estimate && !estimate.alreadySatisfied && estimate.successProbability === 0 && (
            <p className="notice" role="status">
              현재 설정에서 도달할 수 없는 목표입니다. 최고 {scoreText(estimate.maxScore)}급까지
              가능해요.
            </p>
          )}
          <div className="bonus-actions">
            {run.success ? (
              <button className="button primary" onClick={restart}>
                <RotateCcw size={17} /> 다시 진행
              </button>
            ) : (
              <>
                <button
                  className="button primary"
                  disabled={!canRun || auto}
                  onClick={() => {
                    if (!canRun || auto) return;
                    try {
                      commit(draw(live.current));
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : '재설정하지 못했습니다.');
                    }
                  }}
                >
                  <Flame size={17} /> 추가옵션 재설정
                </button>
                <button
                  className="button secondary"
                  disabled={!auto && !canRun}
                  onClick={() => setAuto((value) => !value)}
                >
                  {auto ? <Pause size={17} /> : <Play size={17} />}
                  {auto ? '자동 진행 멈추기' : '목표까지 자동 진행'}
                </button>
              </>
            )}
            <button
              className="icon-button"
              aria-label="추가옵션 도전 초기화"
              onClick={() => reset()}
            >
              <RotateCcw size={17} />
            </button>
          </div>
          {!estimate && !errors.length && !estimateError && (
            <p className="bonus-help" role="status">
              <LoaderCircle size={14} className="spin" /> 목표 확률과 기댓값을 계산하고 있어요.
            </p>
          )}
          <p className="bonus-help">
            {run.success
              ? '다시 진행하면 같은 설정으로 처음부터 자동 진행해요. 횟수와 비용은 새로 집계합니다.'
              : '새로 나온 옵션이 바로 적용돼요. 자동 진행은 목표에 도달하면 멈춥니다.'}
          </p>
          <p className="bonus-save">
            {saved
              ? '도전 기록은 이 브라우저에 저장돼요.'
              : '저장 공간이 부족해 새로고침하면 기록이 사라질 수 있어요.'}
          </p>
        </section>
        <section className="stats-row bonus-stats">
          <div className="stat-card">
            <span>재설정 횟수</span>
            <strong>
              {formatAmount(run.attempts)}
              <small>회</small>
            </strong>
            <div>
              목표 옵션 확률{' '}
              {estimate ? `${formatPercent(estimate.successProbability * 100)}%` : '계산 중'}
            </div>
          </div>
          <div className="stat-card spent-stat">
            <span>사용한 총비용</span>
            <strong>
              {formatAmount(run.spent)}
              <small>메소</small>
            </strong>
            <div>
              {config.flame === 'meso'
                ? '1회 300만 메소'
                : `환생의 불꽃 ${formatAmount(run.attempts)}개`}
            </div>
          </div>
          <div className="stat-card expected-stat">
            <span>근사 기댓값</span>
            <strong>
              {estimate
                ? formatAmount(countBased ? estimate.expectedRolls : estimate.expectedCost)
                : '—'}
              <small>{countBased ? '회' : '메소'}</small>
            </strong>
            <div>
              {estimate ? `평균 ${formatAmount(estimate.expectedRolls)}회` : '현재 조건으로 계산'}
            </div>
          </div>
        </section>
        <ReactionStage
          character={character}
          state={{
            status: run.success ? 'success' : auto ? 'running' : run.attempts ? 'paused' : 'idle',
            attempts: run.attempts,
          }}
          benchmark={costBenchmark}
          reaction={reaction}
          actualCost={compareCost}
        />
        {costBenchmark?.status === 'ready' && (
          <section className="panel bonus-distribution">
            <DistributionChart
              benchmark={costBenchmark}
              actualCost={compareCost}
              done={run.success}
            />
            <p className="bonus-help">
              {countBased ? '아이템 가격이 0이므로 횟수 기준으로 비교해요. ' : ''}기댓값과 행운은
              매번 바뀌는 현재 옵션의 재등장 제외에 따른 확률 변화를 생략한 근삿값입니다.
            </p>
          </section>
        )}
        {run.history.length > 0 && (
          <details className="panel bonus-history">
            <summary>
              최근 재설정 기록 <span>{run.history.length}개</span>
            </summary>
            <ol>
              {run.history.map((entry) => (
                <li key={String(entry.attempt)}>
                  <span>{formatAmount(entry.attempt)}회</span>
                  <strong>{scoreText(entry.score)}급</strong>
                  {entry.hit && <small>목표 충족</small>}
                </li>
              ))}
            </ol>
          </details>
        )}
        <p className="bonus-source">
          <a
            href="https://maplestory.nexon.com/Guide/OtherProbability/game/gameAddOption"
            target="_blank"
            rel="noreferrer"
          >
            넥슨 공식 추가옵션 확률표
          </a>
          <span> · 동일 옵션 재등장 제외 · 옵션 종류 중복 없음</span>
          <br />
          <span>
            확률은 공식 공시를 따르며, 수치는 일반 장비 계산 모델을 사용합니다. 특수 장비의 고유
            수치·사용 제한은 적용하지 않습니다.
          </span>
        </p>
      </div>
    </div>
  );
}
