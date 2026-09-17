import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Calculator, Check, LoaderCircle, Route, Square, Trophy } from 'lucide-react';
import type { CharacterSnapshot } from '../types';
import type { AbilityOption, RuleData } from '../engine/rules';
import type {
  AbilityOptimizerResult,
  AbilityOptimizerStrategyResult,
} from '../engine/ability-optimizer';
import type { OptimizerRequest, OptimizerResponse } from '../workers/ability-optimizer.worker';
import {
  ABILITY_JOB_PRESETS,
  makeAbilityPresetGoal,
  resolveAbilityPreset,
} from '../character/ability-presets';
import { Field, GradeBadge, OptionLines } from './components';
import { formatAmount } from './format';
import './ability-optimizer.css';

const PRICE_KEY = 'isekai:ability-optimizer:prices:v1';
const count = (value: number) =>
  Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
const money = (value: number) => `${formatAmount(value)} 메소`;
const maximum = (option: AbilityOption) =>
  option.values.reduce((best, value) =>
    (option.valueDirection === 'lower' ? value.value < best.value : value.value > best.value)
      ? value
      : best,
  );
function stored(key: string): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function price(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function AbilityOptimizer({
  character,
  data,
}: {
  character: CharacterSnapshot;
  data: RuleData;
}) {
  const settingsKey = `isekai:ability-optimizer:settings:v1:${character.name}`;
  const [savedSettings] = useState(() => stored(settingsKey));
  const [savedPrices] = useState(() => stored(PRICE_KEY));
  const options = useMemo(
    () =>
      data.ability.grades.legendary?.options.filter(
        (option) => option.type && option.values.length,
      ) ?? [],
    [data],
  );
  const defaultTypes = () => {
    try {
      return makeAbilityPresetGoal(data, character.job).conditions.map(
        (condition) => condition.type,
      ) as [string, string, string];
    } catch {
      return options.slice(0, 3).map((option) => option.type!) as [string, string, string];
    }
  };
  const [targetTypes, setTargetTypes] = useState<[string, string, string]>(() => {
    const saved = savedSettings.targetTypes;
    return Array.isArray(saved) &&
      saved.length === 3 &&
      saved.every((type) => options.some((option) => option.type === type))
      ? (saved as [string, string, string])
      : defaultTypes();
  });
  const [preset, setPreset] = useState(() =>
    typeof savedSettings.preset === 'string' && character.abilityPresets[savedSettings.preset]
      ? savedSettings.preset
      : character.activeAbilityPreset,
  );
  const [job, setJob] = useState(() => {
    const selectedJob =
      typeof savedSettings.job === 'string'
        ? savedSettings.job
        : (resolveAbilityPreset(character.job)?.job ?? '');
    try {
      return makeAbilityPresetGoal(data, selectedJob).conditions.every(
        (condition, index) => condition.type === targetTypes[index],
      )
        ? selectedJob
        : '';
    } catch {
      return '';
    }
  });
  const [batchSize, setBatchSize] = useState<1 | 3>(savedSettings.batchSize === 1 ? 1 : 3);
  const [medalPrice, setMedalPrice] = useState(
    typeof savedPrices.medal === 'string' ? savedPrices.medal : '',
  );
  const [circulatorPrice, setCirculatorPrice] = useState(
    typeof savedPrices.circulator === 'string' ? savedPrices.circulator : '',
  );
  const [result, setResult] = useState<AbilityOptimizerResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(true);
  const worker = useRef<Worker | null>(null);
  const inFlight = useRef(false);
  const recommendation = useRef<HTMLHeadingElement | null>(null);
  const requestId = useRef('');
  const start = character.abilityPresets[preset];
  const selected = targetTypes.map((type) => options.find((option) => option.type === type));
  const medal = price(medalPrice),
    circulator = price(circulatorPrice);
  const validation =
    !start || start.lines.length !== 3
      ? '선택한 프리셋의 어빌리티 세 줄을 불러오지 못했습니다.'
      : start.grade !== 'legendary'
        ? '고급 재설정은 레전드리 어빌리티에서 사용할 수 있습니다. 레전드리 프리셋을 선택해 주세요.'
        : new Set(targetTypes).size !== 3
          ? '같은 종류의 어빌리티는 중복으로 나올 수 없습니다. 서로 다른 옵션 세 개를 선택해 주세요.'
          : selected.some((option) => !option)
            ? '목표 옵션을 선택해 주세요.'
            : medal === undefined || circulator === undefined
              ? '훈장과 서큘레이터의 개당 메소 가격을 입력해 주세요. 무료라면 0을 입력할 수 있습니다.'
              : '';

  useEffect(() => {
    try {
      localStorage.setItem(
        PRICE_KEY,
        JSON.stringify({ medal: medalPrice, circulator: circulatorPrice }),
      );
      localStorage.setItem(settingsKey, JSON.stringify({ targetTypes, preset, batchSize, job }));
      setSaved(true);
    } catch {
      setSaved(false);
    }
    requestId.current = '';
    if (inFlight.current) {
      worker.current?.terminate();
      worker.current = null;
    }
    inFlight.current = false;
    setBusy(false);
    setResult(undefined);
    setError('');
  }, [
    medalPrice,
    circulatorPrice,
    targetTypes,
    preset,
    batchSize,
    job,
    settingsKey,
    character,
    data,
  ]);
  useEffect(() => () => worker.current?.terminate(), []);
  useEffect(() => {
    if (!result) return;
    recommendation.current?.focus({ preventScroll: true });
    recommendation.current?.scrollIntoView({
      block: 'center',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  }, [result]);

  function calculate() {
    if (validation || medal === undefined || circulator === undefined || !start) return;
    const next =
      worker.current ??
      new Worker(new URL('../workers/ability-optimizer.worker.ts', import.meta.url), {
        type: 'module',
      });
    worker.current = next;
    const id = crypto.randomUUID();
    requestId.current = id;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setResult(undefined);
    next.onmessage = ({ data: response }: MessageEvent<OptimizerResponse>) => {
      if (response.id !== requestId.current) return;
      if ('error' in response) setError(response.error);
      else setResult(response.result);
      inFlight.current = false;
      setBusy(false);
    };
    next.onerror = () => {
      if (requestId.current !== id) return;
      setError('계산을 완료하지 못했습니다. 다시 계산해 주세요.');
      inFlight.current = false;
      setBusy(false);
      next.terminate();
      worker.current = null;
    };
    next.postMessage({
      id,
      baseUrl: new URL(import.meta.env.BASE_URL, document.baseURI).href,
      input: {
        start: start.lines,
        targetTypes,
        medalPrice: medal,
        circulatorPrice: circulator,
        batchSize,
      },
    } satisfies OptimizerRequest);
  }
  function cancel() {
    requestId.current = '';
    inFlight.current = false;
    worker.current?.terminate();
    worker.current = null;
    setBusy(false);
  }
  const ranked = result ? [...result.strategies].sort((a, b) => a.totalCost - b.totalCost) : [];
  const best = ranked.find((strategy) => strategy.id === result?.bestStrategyId);
  const highest = Math.max(
    0,
    ...ranked.filter((row) => Number.isFinite(row.totalCost)).map((row) => row.totalCost),
  );
  return (
    <section className="optimizer" aria-labelledby="optimizer-title">
      <div className="optimizer-heading">
        <span className="eyebrow">PLAN YOUR ABILITY</span>
        <h2 id="optimizer-title">어빌리티 최적의 방법 찾기</h2>
        <p>어떤 옵션부터 잠그고, 언제 심연의 서큘레이터를 쓸까요?</p>
        <span className="optimizer-goal">
          <Check size={15} /> 줄 순서 무관 · 세 옵션 모두 레전드리 최대치
        </span>
      </div>
      <div className="optimizer-layout">
        <div className="optimizer-settings">
          <section className="panel">
            <div className="panel-heading">
              <h3>시작 어빌리티</h3>
              <span className="panel-step">01</span>
            </div>
            <Field label={`${character.name}의 어빌리티 프리셋`}>
              <select
                aria-label="최적화 어빌리티 프리셋"
                value={preset}
                onChange={(event) => setPreset(event.target.value)}
              >
                {Object.keys(character.abilityPresets)
                  .sort()
                  .map((key) => (
                    <option key={key} value={key}>
                      프리셋 {key}
                      {key === character.activeAbilityPreset ? ' · 사용 중' : ''}
                    </option>
                  ))}
              </select>
            </Field>
            {start && (
              <div className="optimizer-start">
                <GradeBadge grade={start.grade} />
                <OptionLines lines={start.lines} />
              </div>
            )}
            <p className="optimizer-help">
              이미 보유한 목표 옵션은 각 전략의 킵 기준에 맞게 반영합니다. 조회 시점의 프리셋에서
              시작합니다.
            </p>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h3>목표 옵션 A · B · C</h3>
              <span className="panel-step">02</span>
            </div>
            <Field label="직업별 종결 조합">
              <select
                aria-label="최적화 직업 프리셋"
                value={job}
                onChange={(event) => {
                  setJob(event.target.value);
                  if (event.target.value)
                    setTargetTypes(
                      makeAbilityPresetGoal(data, event.target.value).conditions.map(
                        (condition) => condition.type,
                      ) as [string, string, string],
                    );
                }}
              >
                <option value="">직접 선택</option>
                {ABILITY_JOB_PRESETS.map((entry) => (
                  <option key={entry.job} value={entry.job}>
                    {entry.job} · {entry.code}
                  </option>
                ))}
              </select>
            </Field>
            {selected.map((option, index) => (
              <Field key={index} label={`옵션 ${'ABC'[index]}`}>
                <select
                  aria-label={`최적화 목표 ${'ABC'[index]}`}
                  value={targetTypes[index]}
                  onChange={(event) => {
                    const next = [...targetTypes] as [string, string, string];
                    next[index] = event.target.value;
                    setTargetTypes(next);
                    setJob('');
                  }}
                >
                  {options.map((entry) => (
                    <option key={entry.id} value={entry.type}>
                      {maximum(entry).label}
                    </option>
                  ))}
                </select>
                {option && (
                  <small>
                    종류 확률 {count(option.weight * 100)}% · 수치 완성{' '}
                    {count(maximum(option).weight * 100)}%
                  </small>
                )}
              </Field>
            ))}
            <p className="optimizer-help">
              종류 확률은 레전드리 등급 안에서의 기본 확률입니다. 계산에는 줄별 등급 확률과 중복
              종류 제외를 함께 반영합니다.
            </p>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h3>재화 가격과 실행 방식</h3>
              <span className="panel-step">03</span>
            </div>
            <Field label="명예의 훈장 1개 · 명성치 5,000">
              <div className="optimizer-price">
                <input
                  aria-label="명예의 훈장 가격"
                  inputMode="numeric"
                  placeholder="개당 메소 가격"
                  value={medalPrice}
                  onChange={(event) => setMedalPrice(event.target.value.replaceAll(',', ''))}
                />
                <span>메소</span>
              </div>
              {medal !== undefined && <small>{money(medal)} / 개</small>}
            </Field>
            <Field label="심연의 서큘레이터 1개">
              <div className="optimizer-price">
                <input
                  aria-label="심연의 서큘레이터 가격"
                  inputMode="numeric"
                  placeholder="개당 메소 가격"
                  value={circulatorPrice}
                  onChange={(event) => setCirculatorPrice(event.target.value.replaceAll(',', ''))}
                />
                <span>메소</span>
              </div>
              {circulator !== undefined && <small>{money(circulator)} / 개</small>}
            </Field>
            <Field label="고급 재설정 실행 단위">
              <select
                aria-label="최적화 재설정 실행 단위"
                value={batchSize}
                onChange={(event) => setBatchSize(Number(event.target.value) as 1 | 3)}
              >
                <option value={3}>3회 비교 · 3회분 모두 사용</option>
                <option value={1}>1회씩 재설정</option>
              </select>
            </Field>
            <p className="optimizer-help">
              총 기대 비용 = 재설정 메소 + 명성치 ÷ 5,000 × 훈장 가격 + 서큘레이터 개수 × 가격. 보유
              명성치도 같은 단가로 환산합니다.
            </p>
            {validation && <p className="optimizer-validation">{validation}</p>}
            <div className="optimizer-actions">
              <button
                className="button primary"
                disabled={!!validation || busy}
                onClick={calculate}
              >
                {busy ? <LoaderCircle className="spin" size={17} /> : <Calculator size={17} />}
                {busy ? '전략 계산 중' : '최적의 방법 계산'}
                <ArrowRight size={16} />
              </button>
              {busy && (
                <button className="button" onClick={cancel}>
                  <Square size={14} /> 계산 중지
                </button>
              )}
            </div>
            {!saved && (
              <p className="optimizer-help">
                브라우저 저장을 사용할 수 없어 현재 탭에서만 설정이 유지됩니다.
              </p>
            )}
          </section>
        </div>
        <div className="optimizer-results" aria-busy={busy}>
          <p className="sr-only" role="status">
            {busy
              ? '전략별 기대 비용을 계산 중입니다.'
              : result
                ? `${result.strategies.length}개 전략의 계산을 완료했습니다.`
                : ''}
          </p>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {!result && (
            <section className="panel optimizer-empty">
              <Route size={34} />
              <h3>
                {busy
                  ? '옵션 확률과 잠금 비용을 계산하고 있어요.'
                  : '내 어빌리티에 맞는 순서를 찾아보세요.'}
              </h3>
              <p>
                현재 프리셋과 두 재화의 가격으로 킵 순서·서큘레이터 사용 시점별 기대 비용을
                비교합니다.
              </p>
              <ul>
                <li>A·B·C 아무거나 킵</li>
                <li>B·C 중 하나를 먼저 킵</li>
                <li>C가 나올 때까지 스킵</li>
                <li>다른 킵 순서와 서큘레이터 없이 직접 최대치 뽑기</li>
                <li>이미 완성된 첫 줄을 유지하고 보조 줄만 뽑기</li>
              </ul>
            </section>
          )}
          {best && (
            <section className="panel optimizer-best" aria-label="추천 전략">
              <span className="optimizer-best-tag">
                <Trophy size={16} /> 비교 전략 중 기대 비용 최저
              </span>
              <h3 ref={recommendation} tabIndex={-1}>
                {best.name}
              </h3>
              <p>{best.description}</p>
              <strong className="optimizer-total">{money(best.totalCost)}</strong>
              <CostBreakdown strategy={best} medalPrice={medal!} circulatorPrice={circulator!} />
              <ol className="optimizer-steps">
                {best.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            </section>
          )}
          {!!result && (
            <section
              className="panel optimizer-comparison"
              aria-labelledby="optimizer-comparison-title"
            >
              <div className="panel-heading">
                <h3 id="optimizer-comparison-title">전략별 기대 비용</h3>
                <span>{ranked.length}개 비교</span>
              </div>
              <p className="optimizer-help">
                가능한 모든 행동을 탐색한 전역 최적값이 아니라, 아래 킵 기준과 완성 방식 중 가장
                저렴한 방법입니다.
              </p>
              <div className="optimizer-strategy-list">
                {ranked.map((strategy, index) => (
                  <details
                    className={`optimizer-strategy ${strategy.id === best?.id ? 'best' : ''}`}
                    key={strategy.id}
                  >
                    <summary>
                      <span className="optimizer-rank">{index + 1}</span>
                      <span className="optimizer-strategy-name">
                        {strategy.name}
                        <small>
                          {strategy.status === 'already' ? '이미 목표 달성' : strategy.description}
                        </small>
                      </span>
                      <strong>
                        {strategy.status === 'impossible' ? '달성 불가' : money(strategy.totalCost)}
                      </strong>
                    </summary>
                    <div className="optimizer-strategy-detail">
                      <div className="optimizer-bar" aria-hidden="true">
                        <span
                          style={{
                            width: `${highest > 0 && Number.isFinite(strategy.totalCost) ? Math.max(0.5, (strategy.totalCost / highest) * 100) : 0}%`,
                          }}
                        />
                      </div>
                      <CostBreakdown
                        strategy={strategy}
                        medalPrice={medal!}
                        circulatorPrice={circulator!}
                      />
                      <ol className="optimizer-steps">
                        {strategy.steps.map((step, position) => (
                          <li key={position}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  </details>
                ))}
              </div>
            </section>
          )}
          <section className="panel optimizer-notes">
            <h3>계산 기준</h3>
            <ul>
              <li>
                최종 목표는 선택한 세 종류의 레전드리 최대 수치입니다. 첫째·둘째·셋째 줄 순서는
                상관없습니다.
              </li>
              <li>
                기본 비교는 둘째·셋째 줄에서 두 목표를 확보한 뒤 첫째 줄을 완성하는 방식입니다. 첫째
                줄이 이미 목표 최대치라면 그 줄을 유지하는 전략도 함께 비교합니다.
              </li>
              <li>
                심연의 서큘레이터는 세 줄의 등급·종류를 유지하고 수치를 함께 바꿉니다. 필요한 수치가
                동시에 만족해야 채택합니다.
              </li>
              <li>
                종류만 먼저 확보할 때도 레전드리 옵션만 킵합니다. 서큘레이터로 등급을 올릴 수
                없습니다.
              </li>
              <li>모든 전략은 평상시 확률이며, 기댓값은 결과를 보장하는 예산이 아닙니다.</li>
              {result?.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
            <div className="optimizer-sources">
              <a
                href="https://maplestory.nexon.com/Guide/OtherProbability/ability/reputevalue"
                target="_blank"
                rel="noreferrer"
              >
                공식 재설정·서큘레이터 확률표 ↗
              </a>
              <a
                href="https://maplestory.nexon.com/Guide/N23GameInformation/Articles/392"
                target="_blank"
                rel="noreferrer"
              >
                공식 어빌리티 가이드 ↗
              </a>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

function CostBreakdown({
  strategy,
  medalPrice,
  circulatorPrice,
}: {
  strategy: AbilityOptimizerStrategyResult;
  medalPrice: number;
  circulatorPrice: number;
}) {
  return (
    <dl className="optimizer-breakdown">
      <div>
        <dt>재설정 메소</dt>
        <dd>
          {money(strategy.expectedMeso)}
          <small>{count(strategy.expectedResets)}회 사용</small>
        </dd>
      </div>
      <div>
        <dt>명성치 환산</dt>
        <dd>
          {money((strategy.expectedHonor / 5000) * medalPrice)}
          <small>
            {count(strategy.expectedHonor)} 명성치 · 훈장 {count(strategy.expectedHonor / 5000)}개분
          </small>
        </dd>
      </div>
      <div>
        <dt>서큘레이터</dt>
        <dd>
          {money(strategy.expectedCirculators * circulatorPrice)}
          <small>{count(strategy.expectedCirculators)}개 사용</small>
        </dd>
      </div>
    </dl>
  );
}
