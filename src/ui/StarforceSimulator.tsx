import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Hammer,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Star,
  FastForward,
} from 'lucide-react';
import type { BenchmarkResult, CharacterSnapshot, EquipmentSnapshot } from '../types';
import {
  createStarforceState,
  maxStarforceStars,
  quoteStarforce,
  restoreStarforce,
  rollStarforce,
  type StarforceBenchmark,
  type StarforceConfig,
  type StarforceRules,
  type StarforceState,
} from '../engine/starforce';
import { DistributionChart, Field, ReactionStage } from './components';
import { evaluateLuck } from '../engine/benchmark';
import { formatAmount, formatPercent } from './format';
import type { StarforceOptimization } from '../engine/starforce-optimizer';
import type { StarforceRunResponse } from '../engine/starforce-runner';
import './starforce.css';

type Phase = 'idle' | 'charging' | 'result' | 'restoring' | 'restored';
const pacing = (state: StarforceState, config: StarforceConfig) =>
  state.status !== 'destroyed' && state.stars === config.targetStars - 1
    ? { charge: 600, result: 733 }
    : state.status !== 'destroyed' && state.stars <= 12
      ? { charge: 150, result: 183 }
      : { charge: 225, result: 275 };
const outcomeText = {
  success: '강화 성공',
  stay: '강화 실패 · 단계 유지',
  down: '강화 실패 · 단계 하락',
  destroy: '장비 파괴',
};
const eligible = (item: EquipmentSnapshot) =>
  item.level > 0 &&
  item.level <= 250 &&
  !item.superiorEquipment &&
  !item.extraordinaryStarforce &&
  !['unsupported', 'emblem', 'forceShieldSoulRing', 'pocket'].includes(item.category) &&
  (item.category !== 'secondaryWeapon' || item.name.includes('블레이드')) &&
  !/^(봉인된 제네시스|제네시스|데스티니|아스트라)/.test(item.name) &&
  (item.category !== 'ring' || item.level !== 110) &&
  !/이벤트 링|어웨이크 링|테네브리스 원정대 반지|글로리온 링|이터널 플레임 링|결속의 반지|벤젼스 링|코스모스 링|딥다크 크리티컬 링/.test(
    item.name,
  );
function EquipmentArt({ item }: { item?: EquipmentSnapshot }) {
  const [failed, setFailed] = useState(false);
  return item?.imageUrl && !failed ? (
    <img src={item.imageUrl} alt={item.name} onError={() => setFailed(true)} />
  ) : (
    <Hammer size={58} aria-hidden="true" />
  );
}

export function StarforceSimulator({ character }: { character: CharacterSnapshot }) {
  const [rules, setRules] = useState<StarforceRules>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}rules/starforce.json`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('스타포스 확률표를 불러오지 못했습니다.');
        return response.json();
      })
      .then(setRules)
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setError(error.message);
      });
    return () => controller.abort();
  }, []);
  if (error)
    return (
      <section className="panel sf-loading" role="alert">
        {error}
      </section>
    );
  if (!rules)
    return (
      <section className="panel sf-loading" role="status">
        <LoaderCircle className="spin" size={18} /> 스타포스 확률표를 불러오는 중
      </section>
    );
  return <StarforceChallenge character={character} rules={rules} />;
}

function StarforceChallenge({
  character,
  rules,
}: {
  character: CharacterSnapshot;
  rules: StarforceRules;
}) {
  const [initial] = useState(() => {
    const preset = character.activeEquipmentPreset;
    const item = character.equipmentPresets[preset]?.find(eligible);
    const level = item?.level ?? 200;
    const maximum = maxStarforceStars(rules, level);
    const startStars = Math.min(maximum, item?.starforce ?? 0);
    const config: StarforceConfig = {
      level,
      startStars,
      targetStars: Math.min(maximum, Math.max(17, startStars + 1)),
      safeguard: false,
      restoration: 'trace12',
      replacementPrice: 0,
      equipmentType: 'normal',
    };
    return {
      preset,
      itemId: item?.id ?? 'manual',
      config,
      state: createStarforceState(rules, config),
    };
  });
  const [preset, setPreset] = useState(initial.preset);
  const [itemId, setItemId] = useState(initial.itemId);
  const [config, setConfig] = useState(initial.config);
  const [state, setState] = useState(initial.state);
  const [phase, setPhase] = useState<Phase>('idle');
  const [auto, setAuto] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [timing, setTiming] = useState(() => pacing(initial.state, initial.config));
  const [error, setError] = useState('');
  const [benchmark, setBenchmark] = useState<StarforceBenchmark>();
  const [benchmarkError, setBenchmarkError] = useState('');
  const [distribution, setDistribution] =
    useState<
      Pick<BenchmarkResult, 'method' | 'sampleCount' | 'quantiles' | 'distribution' | 'note'>
    >();
  const [distributionError, setDistributionError] = useState('');
  const [percentile, setPercentile] = useState<{ cost: number; cdf: number }>();
  const benchmarkWorker = useRef<Worker | null>(null);
  const [optimization, setOptimization] = useState<StarforceOptimization>();
  const [optimizing, setOptimizing] = useState(false);
  const optimizeWorker = useRef<Worker | null>(null);
  const runWorker = useRef<Worker | null>(null);
  const runId = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const live = useRef({ config, state, auto });
  live.current = { config, state, auto };
  const items = (character.equipmentPresets[preset] ?? []).filter(eligible);
  const item = items.find((candidate) => candidate.id === itemId);
  const maximum = maxStarforceStars(rules, config.level);
  const busy = phase !== 'idle';
  const last = state.history.at(-1);
  const actualCost = Number(state.spentMeso);
  const done = state.status === 'success' && state.attempts > 0n;
  const costBenchmark: BenchmarkResult | undefined =
    benchmark && distribution
      ? {
          ...distribution,
          status: benchmark.status,
          expectedCost: benchmark.expectedMeso,
          expectedAttempts: benchmark.expectedAttempts,
          successProbability: benchmark.status === 'impossible' ? 0 : 1,
          unit: 'meso',
          cdfAtActual: done && percentile?.cost === actualCost ? percentile.cdf : undefined,
        }
      : undefined;
  const reaction =
    done && costBenchmark?.cdfAtActual !== undefined
      ? evaluateLuck(costBenchmark, actualCost)
      : undefined;
  const quote = useMemo(() => {
    try {
      return state.status === 'ready' ? quoteStarforce(rules, config, state) : undefined;
    } catch {
      return undefined;
    }
  }, [rules, config, state]);
  const routeSteps = useMemo(() => {
    if (!config.policy) return [];
    const reachable = new Set<number>();
    const pending = [config.startStars];
    while (pending.length) {
      const stars = pending.pop()!;
      if (stars >= config.targetStars || reachable.has(stars)) continue;
      reachable.add(stars);
      const next = quoteStarforce(rules, config, { stars });
      if (next.successProbability > 0) pending.push(next.successStar);
      if (next.decreaseProbability > 0) pending.push(next.decreaseStar);
      if (next.destroyProbability > 0 && next.restoration) pending.push(next.restoration.toStars);
    }
    return config.policy
      .filter((step) => reachable.has(step.stars))
      .sort((a, b) => a.stars - b.stars);
  }, [rules, config]);

  useEffect(() => {
    const worker = new Worker(new URL('../workers/starforce.worker.ts', import.meta.url), {
      type: 'module',
    });
    setBenchmark(undefined);
    setBenchmarkError('');
    setDistribution(undefined);
    setDistributionError('');
    setPercentile(undefined);
    benchmarkWorker.current = worker;
    worker.onmessage = (event) => {
      if (event.data.type === 'distribution') {
        setDistribution(event.data.result);
        setDistributionError(event.data.error ?? '');
      } else if (event.data.type === 'cdf') {
        setPercentile({ cost: event.data.actualCost, cdf: event.data.cdf });
      } else {
        setBenchmark(event.data.result);
        setBenchmarkError(event.data.error ?? '');
      }
    };
    worker.onerror = () => {
      setBenchmarkError('기댓값 계산을 불러오지 못했습니다. 다시 시도해 주세요.');
      setDistributionError('비용 분포를 계산하지 못했습니다. 새로고침해 다시 시도해 주세요.');
    };
    worker.postMessage({ type: 'benchmark', rules, config });
    return () => {
      worker.terminate();
      if (benchmarkWorker.current === worker) benchmarkWorker.current = null;
    };
  }, [rules, config]);
  useEffect(() => {
    if (done && distribution) benchmarkWorker.current?.postMessage({ type: 'cdf', actualCost });
    else setPercentile(undefined);
  }, [done, actualCost, distribution]);
  useEffect(() => {
    const leavePage = () => finishExecution();
    window.addEventListener('pagehide', leavePage);
    return () => {
      window.removeEventListener('pagehide', leavePage);
      disposeExecution();
      optimizeWorker.current?.terminate();
    };
  }, []);

  function disposeExecution() {
    generation.current++;
    clearTimeout(timer.current);
    if (runWorker.current) {
      runWorker.current.onmessage = null;
      runWorker.current.onerror = null;
      runWorker.current.terminate();
      runWorker.current = null;
    }
    live.current.auto = false;
  }
  function finishExecution() {
    disposeExecution();
    setAuto(false);
    setSkipping(false);
    setStopping(false);
    setPhase('idle');
  }
  function stop() {
    if (runWorker.current) {
      setStopping(true);
      runWorker.current.postMessage({ type: 'stop', id: runId.current });
    } else finishExecution();
  }
  function commit(next: StarforceState) {
    live.current.state = next;
    setState(next);
  }
  function queuePhase(callback: () => void, remaining: number) {
    clearTimeout(timer.current);
    timer.current = setTimeout(callback, remaining);
  }
  function skipAnimation() {
    if (!live.current.auto || runWorker.current) return;
    if (live.current.state.status === 'success') {
      finishExecution();
      return;
    }
    generation.current++;
    clearTimeout(timer.current);
    setPhase('idle');
    setSkipping(true);
    setError('');
    const id = String(generation.current);
    runId.current = id;
    const worker = new Worker(new URL('../workers/starforce-run.worker.ts', import.meta.url), {
      type: 'module',
    });
    runWorker.current = worker;
    worker.onmessage = (event: MessageEvent<StarforceRunResponse>) => {
      if (runWorker.current !== worker || event.data.id !== id) return;
      const response = event.data;
      if (response.state) commit(response.state);
      if (response.type === 'error') {
        setError(response.message);
        finishExecution();
      } else if (response.done) finishExecution();
    };
    worker.onerror = () => {
      if (runWorker.current !== worker) return;
      setError('자동 강화를 실행하지 못했습니다. 현재 진행에서 다시 시작해 주세요.');
      finishExecution();
    };
    worker.postMessage({
      type: 'run',
      id,
      rules,
      config: live.current.config,
      state: live.current.state,
    });
  }
  function schedule(next: StarforceState, token: number, delay: number) {
    queuePhase(() => {
      if (token !== generation.current) return;
      if (live.current.auto && next.status !== 'success') attempt();
      else {
        setPhase('idle');
        setAuto(false);
        live.current.auto = false;
      }
    }, delay);
  }
  function attempt() {
    const token = generation.current;
    const current = live.current.state;
    if (current.status === 'success') return;
    const duration = pacing(current, live.current.config);
    setTiming(duration);
    setError('');
    setPhase(current.status === 'destroyed' ? 'restoring' : 'charging');
    queuePhase(() => {
      if (token !== generation.current) return;
      try {
        const next =
          current.status === 'destroyed'
            ? restoreStarforce(rules, live.current.config, current)
            : rollStarforce(rules, live.current.config, current).state;
        // Let the shield result linger; the slower final step still takes precedence.
        const resultDuration =
          current.status !== 'destroyed' && next.history.at(-1)?.safeguardPrevented
            ? Math.max(duration.result, 550)
            : duration.result;
        setTiming({ ...duration, result: resultDuration });
        commit(next);
        setPhase(current.status === 'destroyed' ? 'restored' : 'result');
        schedule(next, token, resultDuration);
      } catch (error) {
        setError(error instanceof Error ? error.message : '강화에 실패했습니다.');
        stop();
      }
    }, duration.charge);
  }
  function startAutomatic() {
    if (busy) return;
    if (state.status === 'success') commit(createStarforceState(rules, config));
    live.current.auto = true;
    setAuto(true);
    attempt();
  }
  function reset(nextConfig = config) {
    finishExecution();
    setError('');
    try {
      const next = createStarforceState(rules, nextConfig);
      setConfig(nextConfig);
      live.current.config = nextConfig;
      commit(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : '설정을 확인해 주세요.');
    }
  }
  function patch(patch: Partial<StarforceConfig>) {
    setOptimization(undefined);
    const next = { ...config, ...patch, policy: undefined };
    const max = maxStarforceStars(rules, next.level);
    next.startStars = Math.min(max, Math.max(0, next.startStars));
    next.targetStars = Math.min(max, Math.max(1, next.targetStars));
    reset(next);
  }
  function selectItem(id: string, selectedPreset = preset) {
    const selected = character.equipmentPresets[selectedPreset]?.find(
      (item) => item.id === id && eligible(item),
    );
    const level = selected?.level ?? 200;
    const max = maxStarforceStars(rules, level);
    const startStars = Math.min(max, selected?.starforce ?? 0);
    setPreset(selectedPreset);
    setItemId(selected?.id ?? 'manual');
    setOptimization(undefined);
    reset({
      ...config,
      level,
      startStars,
      targetStars: Math.min(max, Math.max(17, startStars + 1)),
      restoration: 'trace12',
      policy: undefined,
    });
  }
  function cancelOptimization() {
    optimizeWorker.current?.terminate();
    optimizeWorker.current = null;
    setOptimizing(false);
  }
  function optimizeRoute() {
    if (busy || auto || optimizing) return;
    setError('');
    setOptimizing(true);
    const worker = new Worker(new URL('../workers/starforce.worker.ts', import.meta.url), {
      type: 'module',
    });
    optimizeWorker.current = worker;
    worker.onmessage = (
      event: MessageEvent<{ result?: StarforceOptimization; error?: string }>,
    ) => {
      if (optimizeWorker.current !== worker) return;
      const result = event.data.result;
      cancelOptimization();
      if (!result || result.status !== 'ready') {
        setError(event.data.error ?? '시작 단계보다 높은 목표를 선택해 주세요.');
        return;
      }
      reset(result.config);
      setOptimization(result);
    };
    worker.onerror = () => {
      cancelOptimization();
      setError('강화 루트 계산을 불러오지 못했습니다. 다시 시도해 주세요.');
    };
    worker.postMessage({ type: 'optimize', rules, config });
  }
  const resultText =
    phase === 'charging'
      ? '별의 힘을 모으는 중…'
      : phase === 'restoring'
        ? '장비를 복구하는 중…'
        : phase === 'restored'
          ? `${state.stars}성 복구 완료`
          : state.status === 'destroyed'
            ? '장비 파괴 · 흔적 복구 대기'
            : state.status === 'success'
              ? state.attempts > 0n
                ? '목표 강화 달성!'
                : '이미 목표 단계입니다'
              : last?.restored
                ? `${state.stars}성 복구 완료`
                : last
                  ? last.safeguardPrevented
                    ? '파괴 방지 성공!'
                    : outcomeText[last.outcome]
                  : '다음 별을 향해';
  return (
    <div className="workspace sf-workspace">
      <aside className="setup-column">
        <section className="panel settings-panel">
          <div className="panel-heading">
            <h2>
              <Hammer size={18} /> 스타포스 설정
            </h2>
            <span className="panel-step">01</span>
          </div>
          <fieldset className="sf-settings" disabled={busy || auto || optimizing}>
            <Field label="장비 프리셋">
              <select
                value={preset}
                onChange={(e) => {
                  const selectedPreset = e.target.value;
                  selectItem(
                    character.equipmentPresets[selectedPreset]?.find(eligible)?.id ?? 'manual',
                    selectedPreset,
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
            <Field label="스타포스 장비">
              <select value={itemId} onChange={(e) => selectItem(e.target.value)}>
                {items.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.slot} · {item.name}
                    {item.starforce === undefined ? '' : ` (${item.starforce}성)`}
                  </option>
                ))}
                <option value="manual">일반 장비 직접 설정</option>
              </select>
            </Field>
            <div className="sf-input-pair">
              <Field label="장비 레벨">
                <input
                  type="number"
                  min={1}
                  max={250}
                  value={config.level}
                  disabled={!!item}
                  onChange={(e) =>
                    patch({ level: Math.min(250, Math.max(1, Math.round(Number(e.target.value)))) })
                  }
                />
              </Field>
              <Field label="시작 스타포스">
                <select
                  value={config.startStars}
                  onChange={(e) => patch({ startStars: Number(e.target.value) })}
                >
                  {Array.from({ length: maximum + 1 }, (_, star) => (
                    <option value={star} key={star}>
                      {star}성
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {item && (
              <small className="inline-note">
                {item.starforce === undefined
                  ? '조회된 강화 단계가 없어 0성으로 시작합니다. 직접 수정할 수 있어요.'
                  : `조회 당시 ${item.starforce}성 · 시작 단계를 직접 수정할 수 있어요.`}
              </small>
            )}
            <Field label="목표 스타포스">
              <select
                value={config.targetStars}
                onChange={(e) => patch({ targetStars: Number(e.target.value) })}
              >
                {Array.from({ length: maximum }, (_, index) => index + 1).map((star) => (
                  <option value={star} key={star}>
                    {star}성
                  </option>
                ))}
              </select>
            </Field>
            <label className="sf-toggle">
              <input
                type="checkbox"
                checked={config.event === 'shiningNoGuarantee'}
                onChange={(e) => patch({ event: e.target.checked ? 'shiningNoGuarantee' : 'none' })}
              />
              <span>
                <b>샤이닝 스타포스</b>
                <small>15→16성 확정 성공 제외</small>
                <small>강화 비용 30% · 21성 이하 파괴 확률 30% · 복구 메소 20% 감소</small>
              </span>
              <Sparkles size={19} />
            </label>
            <label className="sf-toggle">
              <input
                type="checkbox"
                checked={config.safeguard}
                onChange={(e) => patch({ safeguard: e.target.checked })}
              />
              <span>
                <b>파괴 방지</b>
                <small>15~17성 · 기본 강화 비용의 2배 추가 (추가분은 할인 제외)</small>
              </span>
              <ShieldCheck size={19} />
            </label>
            <Field label="파괴 후 복구 방식">
              <select
                value={config.restoration}
                onChange={(e) =>
                  patch({ restoration: e.target.value as StarforceConfig['restoration'] })
                }
              >
                <option value="trace12">12성으로 복구</option>
                <option value="original">흔적의 단계로 복구 (최대 22성)</option>
              </select>
            </Field>
            <Field label="복구용 동일 장비 가격 (메소)">
              <input
                inputMode="numeric"
                value={config.replacementPrice}
                onChange={(e) => {
                  if (/^\d*$/.test(e.target.value) && Number.isSafeInteger(Number(e.target.value)))
                    patch({ replacementPrice: Number(e.target.value) });
                }}
              />
            </Field>
            <small className="inline-note">
              장비 가격 0은 복구용 장비를 보유한 경우입니다. 입력한 장비값과 복구 메소까지 실제
              비용·기댓값에 포함합니다.
            </small>
          </fieldset>
          <div className="sf-route-settings">
            <button
              className="button sf-optimize-button"
              disabled={busy || auto || (!optimizing && config.startStars >= config.targetStars)}
              onClick={optimizing ? cancelOptimization : optimizeRoute}
            >
              {optimizing ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}
              {optimizing ? '최적화 중단' : '강화 루트 최적화'}
            </button>
            <small className="inline-note">
              장비값에 맞춰 단계별 파괴 방지·복구 방식을 계산하고, 현재 시작 설정의 새 도전에
              적용합니다.
            </small>
            {config.policy?.length ? (
              <div className="sf-route-result" aria-live="polite">
                <strong>최적 루트 적용 중</strong>
                {optimization?.savedMeso != null && (
                  <p>
                    수동 설정 대비 기대 비용{' '}
                    <b>{formatAmount(Math.max(0, optimization.savedMeso))} 메소</b> 절약
                    {optimization.savedPercent != null &&
                      ` (${optimization.savedPercent.toFixed(1)}%)`}
                  </p>
                )}
                {optimization?.baselineError && <p>{optimization.baselineError}</p>}
                <small>
                  현재 장비·목표에서 단계별 파괴 방지와 두 복구 방식 중 기대 총비용이 가장 낮은
                  조합입니다. 설정을 바꾸면 수동 방식으로 돌아갑니다.
                </small>
                <details className="sf-route-details">
                  <summary>단계별 강화 루트 보기</summary>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">강화 단계</th>
                        <th scope="col">파괴 방지</th>
                        <th scope="col">파괴 시 복구</th>
                      </tr>
                    </thead>
                    <tbody>
                      {routeSteps.map((step) => (
                        <tr key={step.stars}>
                          <th scope="row">
                            {step.stars}→{step.stars + 1}성
                          </th>
                          <td>{step.safeguard ? '사용' : '미사용'}</td>
                          <td>
                            {step.stars < 15 || step.safeguard
                              ? '파괴 없음'
                              : step.restoration === 'original'
                                ? `${Math.min(step.stars, 22)}성`
                                : '12성'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || auto || optimizing}
                  onClick={() => patch({ policy: undefined })}
                >
                  수동 설정으로 돌아가기
                </button>
              </div>
            ) : null}
          </div>
          <div className="sf-rules-note">
            일반 장비 · 단계 하락 없음 · 스타캐치 효과 기본 적용. 슈페리얼·놀장·특수 장비는 지원하지
            않습니다.
          </div>
        </section>
        <section className="panel sf-sources">
          <h3>확률과 비용 기준</h3>
          <p>
            확률은 본서버 공식 표를 적용합니다. 강화·단계 보존 복구 비용은 검증 모델(베타)이며 실제
            게임과 차이가 있을 수 있습니다.
          </p>
          <a
            href="https://maplestory.nexon.com/Guide/N23GameInformation/Articles/412"
            target="_blank"
            rel="noreferrer"
          >
            공식 스타포스 안내 ↗
          </a>
          <a href="https://maplestory.nexon.com/News/Update/799" target="_blank" rel="noreferrer">
            스타캐치·복구 개편 ↗
          </a>
          <a
            href="https://maplestory.nexon.com/News/Event/Closed/1377"
            target="_blank"
            rel="noreferrer"
          >
            샤이닝 스타포스 혜택 ↗
          </a>
        </section>
      </aside>
      <section className="result-column">
        <section className="panel sf-panel">
          <div className="sf-heading">
            <div>
              <span className="eyebrow">ONE MORE STAR</span>
              <h2>스타포스 시뮬레이터</h2>
              <p>별 하나마다, 또 다른 나의 운명</p>
            </div>
            <Star size={36} />
          </div>
          <div
            className="sf-stars"
            aria-label={`현재 ${state.stars}성 / 목표 ${config.targetStars}성`}
          >
            {Array.from({ length: maximum }, (_, index) => (
              <Star
                key={index}
                size={17}
                aria-hidden="true"
                className={index < state.stars && state.status !== 'destroyed' ? 'lit' : ''}
              />
            ))}
          </div>
          <div
            className={`sf-stage phase-${phase}${skipping ? ' is-skipping' : ''} outcome-${last?.restored ? 'none' : last?.safeguardPrevented ? 'protected' : (last?.outcome ?? 'none')}`}
            style={
              {
                '--sf-charge-duration': `${timing.charge}ms`,
                '--sf-result-duration': `${timing.result}ms`,
              } as React.CSSProperties
            }
          >
            <div className="sf-orbit sf-orbit-outer" />
            <div className="sf-orbit" />
            <div className="sf-item">
              <EquipmentArt item={item} key={item?.imageUrl ?? 'manual'} />
            </div>
            {phase === 'result' && last?.safeguardPrevented && !skipping && (
              <div className="sf-protection" aria-label="파괴 방지 발동">
                <div className="sf-protection-ring" />
                <ShieldCheck size={98} strokeWidth={1.4} aria-hidden="true" />
                <span>장비를 지켜냈습니다</span>
              </div>
            )}
            <div className="sf-sparks" aria-hidden="true">
              {Array.from({ length: 8 }, (_, i) => (
                <span key={i} style={{ '--spark-angle': `${i * 45}deg` } as React.CSSProperties}>
                  ✦
                </span>
              ))}
            </div>
            <div className="sf-stage-caption">
              <span>{item?.name ?? `Lv.${config.level} 일반 장비`}</span>
              <strong>
                {state.status === 'destroyed' ? '파괴' : `${state.stars}성`}
                <ArrowRight size={20} />
                {config.targetStars}성
              </strong>
            </div>
          </div>
          <div className="sf-outcome" role="status" aria-live="polite">
            <strong>{resultText}</strong>
            <span>
              {stopping
                ? '강화를 중단하고 있어요.'
                : auto
                  ? '자동 강화 중'
                  : '원하는 별까지 도전해 보세요.'}
            </span>
          </div>
          <div className="sf-quote">
            {quote ? (
              <>
                <span>
                  성공 <b>{formatPercent(quote.successProbability * 100)}%</b>
                </span>
                <span>
                  유지 <b>{formatPercent(quote.maintainProbability * 100)}%</b>
                </span>
                <span>
                  파괴 <b>{formatPercent(quote.destroyProbability * 100)}%</b>
                </span>
                <span>
                  다음 강화 <b>{formatAmount(quote.cost)} 메소</b>
                </span>
              </>
            ) : state.pendingRestoration ? (
              <>
                <span>
                  복구 단계 <b>{state.pendingRestoration.toStars}성</b>
                </span>
                <span>
                  동일 장비 <b>{String(state.pendingRestoration.equipmentCount)}개</b>
                </span>
                <span>
                  복구 총비용 <b>{formatAmount(state.pendingRestoration.totalCost)} 메소</b>
                </span>
              </>
            ) : (
              <span>
                목표 {config.targetStars}성 {state.attempts > 0n ? '달성' : '이상에서 시작'}
              </span>
            )}
          </div>
          {(error || benchmarkError) && (
            <p className="sf-error" role="alert">
              {error || benchmarkError}
            </p>
          )}
          <div className={`sf-actions${auto ? ' is-auto' : ''}`}>
            <button
              className="button primary roll-button"
              disabled={
                auto
                  ? skipping || stopping
                  : busy ||
                    optimizing ||
                    state.status === 'success' ||
                    !benchmark ||
                    !!benchmarkError
              }
              onClick={auto ? skipAnimation : attempt}
            >
              {auto ? <FastForward size={18} /> : <Hammer size={18} />}
              {auto
                ? skipping
                  ? '연출 스킵 중'
                  : '연출 스킵'
                : state.status === 'destroyed'
                  ? '장비 복구하기'
                  : '강화하기'}
            </button>
            {busy || auto ? (
              <button className="button auto-button stop" onClick={stop} disabled={stopping}>
                <Pause size={18} />
                {stopping ? '중단 중' : '중단'}
              </button>
            ) : (
              <button
                className="button auto-button"
                disabled={
                  optimizing ||
                  !benchmark ||
                  !!benchmarkError ||
                  config.startStars >= config.targetStars
                }
                onClick={startAutomatic}
              >
                <Play size={18} />
                {state.status === 'success' ? '다시 자동 강화' : '자동 강화'}
              </button>
            )}
          </div>
          <div className="sf-reset">
            <button
              className="text-button"
              disabled={optimizing || skipping || stopping}
              onClick={() => reset()}
            >
              <RotateCcw size={14} />
              처음부터 다시
            </button>
          </div>
        </section>
        <section className="stats-row sf-stats">
          <div className="stat-card">
            <span>강화 시도</span>
            <strong>
              {formatAmount(state.attempts)}
              <small>회</small>
            </strong>
            <div>
              파괴 {formatAmount(state.destructions)}회 · 복구 {formatAmount(state.restorations)}회
            </div>
          </div>
          <div className="stat-card spent-stat">
            <span>사용한 총비용</span>
            <strong>
              {formatAmount(state.spentMeso)}
              <small>메소</small>
            </strong>
            <div>복구용 장비 {formatAmount(state.replacementCopies)}개 포함</div>
          </div>
          <div className="stat-card expected-stat">
            <span>목표까지 기댓값</span>
            <strong>
              {benchmark ? formatAmount(benchmark.expectedMeso) : benchmarkError ? '—' : '계산 중'}
              <small>{benchmark ? '메소' : ''}</small>
            </strong>
            <div>
              {benchmark
                ? `평균 ${formatAmount(benchmark.expectedAttempts)}회 · 파괴 ${benchmark.expectedDestructions.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}회`
                : '같은 시작 단계와 복구 방식으로 계산'}
            </div>
          </div>
        </section>
        <div className="resource-ledger">
          <span>
            강화 <b>{formatAmount(state.enhancementMeso)} 메소</b>
          </span>
          <span>
            복구 메소 <b>{formatAmount(state.restorationMeso)} 메소</b>
          </span>
          <span>
            복구용 장비 <b>{formatAmount(state.replacementMeso)} 메소</b>
          </span>
        </div>
        <ReactionStage
          character={character}
          state={{
            status:
              state.status === 'success'
                ? 'success'
                : auto
                  ? 'running'
                  : state.attempts > 0n
                    ? 'paused'
                    : 'idle',
            attempts: state.attempts,
          }}
          benchmark={
            costBenchmark ??
            (benchmark?.status === 'already'
              ? {
                  status: 'already',
                  expectedCost: 0,
                  expectedAttempts: 0,
                  successProbability: 1,
                  unit: 'meso',
                  method: 'analytic',
                  sampleCount: 0,
                  quantiles: { p10: 0, p50: 0, p90: 0 },
                  distribution: [],
                }
              : undefined)
          }
          actualCost={actualCost}
          reaction={reaction}
          messages={{
            jackpot: [
              state.attempts % 2n === 0n
                ? '이게 뜬다고? 오늘은 내 날이다!'
                : '아 게임에서 돌릴걸..',
              `${config.targetStars}성 달성! 이 비용 안에 성공할 확률이 10% 이하예요.`,
            ],
            happy: [
              state.attempts % 2n === 0n
                ? '어? 생각보다 얼마 안 썼네?'
                : '이 정도면 꽤 싸게 먹혔다!',
              `${config.targetStars}성 달성! 기댓값보다 가볍게 끝냈어요.`,
            ],
            neutral: [
              actualCost > (benchmark?.expectedMeso ?? Infinity)
                ? '그래.. 이거면 된거야..'
                : '그래, 이 정도면 잘했다.',
              `${config.targetStars}성 달성. 기댓값 언저리에서 무난하게 도착했어요.`,
            ],
            cry: [
              state.attempts % 2n === 0n ? '아무튼 내가 이긴거야..' : '그래.. 이거면 된거야..',
              `${config.targetStars}성은 남았으니까.. 기댓값보다 먼 길을 돌아왔어요.`,
            ],
          }}
        />
        {costBenchmark?.status === 'ready' ? (
          <div className="panel sf-distribution">
            <DistributionChart benchmark={costBenchmark} actualCost={actualCost} done={done} />
            <p className="sf-distribution-note">
              {costBenchmark.note} 백분위는 이 비용 이내에 성공할 확률이며, 낮을수록 행운이에요.
            </p>
          </div>
        ) : benchmark?.status === 'ready' ? (
          <p className="sf-distribution-note" role="status">
            {distributionError ||
              '같은 조건의 비용 분포를 계산하고 있어요. 강화는 바로 시작할 수 있습니다.'}
          </p>
        ) : null}
        <details className="panel history-panel">
          <summary>강화 기록 · 최근 {state.history.length}회</summary>
          <div className="sf-history">
            {state.history.length ? (
              [...state.history].reverse().map((row) => (
                <div key={String(row.sequence)}>
                  <span>
                    {String(row.sequence)}회 · {row.fromStars}성
                  </span>
                  <b className={`sf-history-${row.outcome}`}>
                    {row.safeguardPrevented ? '파괴 방지 · 단계 유지' : outcomeText[row.outcome]}
                    {row.toStars !== null && ` → ${row.toStars}성`}
                    {row.restored && ` · ${row.restoration?.toStars}성 복구`}
                  </b>
                  <span>{formatAmount(row.mesoCost)} 메소</span>
                </div>
              ))
            ) : (
              <p>첫 강화의 결과를 기다리고 있어요.</p>
            )}
          </div>
        </details>
      </section>
    </div>
  );
}
