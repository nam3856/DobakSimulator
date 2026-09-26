import { useEffect, useMemo, useRef, useState } from 'react';
import { ChartNoAxesCombined, LoaderCircle, Sparkles, X } from 'lucide-react';
import type {
  BenchmarkResult,
  CharacterSnapshot,
  Goal,
  LuckReaction,
  ResourceCost,
  RollResult,
  SimulationConfig,
  WorkerRequest,
  WorkerResponse,
} from '../types';
import { evaluateLuck } from '../engine/benchmark';
import { paidBenchmarkCost } from '../engine/soul-cost';
import { GoalChips, GradeBadge } from './components';
import { GRADE_NAMES } from './constants';
import { formatAmount, formatPercent } from './format';
import { makeResultGoal } from './result-goal';
import './result-analysis.css';

export interface ResultAnalysisSelection {
  config: SimulationConfig;
  result: RollResult;
  spent: ResourceCost;
  attempts: bigint;
}

interface ResultAnalysisProps {
  selection: ResultAnalysisSelection;
  character: CharacterSnapshot;
  baseUrl: string;
  onClose: () => void;
}

interface AnalysisState {
  selection: ResultAnalysisSelection;
  goal: Goal;
  baseUrl: string;
  result?: BenchmarkResult;
  error?: string;
}

const LUCK_LABELS: Record<LuckReaction, string> = {
  jackpot: '행운 매우 좋음',
  happy: '행운 좋음',
  neutral: '행운 보통',
  cry: '행운 아쉬움',
  ghost: '행운 많이 아쉬움',
};

export function ResultAnalysis({ selection, character, baseUrl, onClose }: ResultAnalysisProps) {
  const panel = useRef<HTMLElement>(null);
  const goal = useMemo(
    () => makeResultGoal(selection.config, selection.result, character.profile),
    [selection, character.profile],
  );
  const displayGoal = goal
    ? {
        ...goal,
        conditions: goal.conditions.map((condition) => ({
          ...condition,
          minValue: Number(condition.minValue.toFixed(4)),
        })),
      }
    : undefined;
  const paid = paidBenchmarkCost(selection.config, selection.spent);
  const actualCost = Number(paid);
  const [analysis, setAnalysis] = useState<AnalysisState>();
  // A newly selected snapshot must never display the previous result while its effect starts.
  const current =
    analysis?.selection === selection && analysis.goal === goal && analysis.baseUrl === baseUrl
      ? analysis
      : undefined;
  const benchmark = current?.result;
  const error = current?.error;
  const ready =
    benchmark?.status === 'ready' &&
    Number.isFinite(benchmark.expectedCost) &&
    benchmark.expectedCost > 0 &&
    Number.isFinite(actualCost);
  const luck = ready && selection.attempts > 0n ? evaluateLuck(benchmark, actualCost) : undefined;
  const budgetProbability =
    ready &&
    benchmark.cdfAtActual !== undefined &&
    Number.isFinite(benchmark.cdfAtActual) &&
    benchmark.cdfAtActual >= 0 &&
    benchmark.cdfAtActual <= 1
      ? benchmark.cdfAtActual
      : undefined;
  const unit = benchmark?.unit === 'cubes' ? '개' : benchmark?.unit === 'honor' ? '명성치' : '메소';
  const ratio = ready ? actualCost / benchmark.expectedCost : undefined;
  const ratioText =
    ratio !== undefined
      ? ratio > 0 && ratio < 0.01
        ? '0.01배 미만'
        : `${ratio.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}배`
      : '';

  useEffect(() => {
    if (!goal) return;
    const context = { selection, goal, baseUrl };
    setAnalysis(context);
    let worker: Worker | undefined;
    let cancelled = false;
    let settled = false;
    const id = crypto.randomUUID();
    const fail = (message: string) => {
      if (cancelled || settled) return;
      settled = true;
      setAnalysis({ ...context, error: message });
      worker?.terminate();
    };
    try {
      worker = new Worker(new URL('../workers/simulator.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        if (cancelled || settled || event.data.id !== id) return;
        if (event.data.type === 'error') {
          fail(event.data.message);
        } else if (event.data.type === 'benchmark') {
          settled = true;
          setAnalysis({ ...context, result: event.data.result });
          worker?.terminate();
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fail('분석을 불러오지 못했어요. 잠시 후 결과를 다시 선택해 주세요.');
      };
      worker.onmessageerror = () => {
        fail('분석 결과를 읽지 못했어요. 결과를 다시 선택해 주세요.');
      };
      const request: WorkerRequest = {
        type: 'benchmark',
        id,
        config: { ...selection.config, target: goal },
        actualCost,
        baseUrl,
      };
      worker.postMessage(request);
    } catch {
      fail('분석을 시작하지 못했어요. 결과를 다시 선택해 주세요.');
    }
    return () => {
      cancelled = true;
      worker?.terminate();
    };
  }, [selection, goal, baseUrl, actualCost]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = panel.current;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      if (bounds.top < 0 || bounds.bottom > window.innerHeight)
        element.scrollIntoView({
          block: 'nearest',
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
        });
    });
    return () => cancelAnimationFrame(frame);
  }, [selection]);

  return (
    <section
      ref={panel}
      id="result-analysis"
      className="result-analysis"
      aria-label="선택 결과 분석"
      aria-busy={Boolean(goal && !benchmark && !error)}
    >
      <div className="result-analysis-heading">
        <div>
          <h3>
            <ChartNoAxesCombined size={17} aria-hidden="true" />
            선택 결과 분석
          </h3>
          <p className="result-analysis-origin">
            #{formatAmount(selection.result.sequence)} 결과 · 시작{' '}
            {GRADE_NAMES[selection.config.start.grade]}
          </p>
        </div>
        <button
          type="button"
          className="result-analysis-close"
          aria-label="결과 분석 닫기"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="result-analysis-selected">
        <GradeBadge grade={selection.result.grade} />
        <span>선택한 옵션의 주요 수치 이상</span>
      </div>
      {goal ? (
        <>
          <GoalChips goal={displayGoal!} />
          <p className="result-analysis-method">
            이 수치를 목표로 했을 때의 기댓값을 현재 사용 예산과 비교해요.
          </p>
          <div className="result-analysis-response" aria-live="polite" aria-atomic="true">
            {error ? (
              <p className="result-analysis-message result-analysis-error" role="alert">
                {error}
              </p>
            ) : !benchmark ? (
              <p className="result-analysis-message result-analysis-loading" role="status">
                <LoaderCircle size={16} aria-hidden="true" />
                선택한 수치를 분석하고 있어요.
              </p>
            ) : (
              <>
                <dl className="result-analysis-metrics">
                  <div className="result-analysis-estimate">
                    <dt>이 수치 이상의 기댓값</dt>
                    <dd>
                      <strong title={formatAmount(benchmark.expectedCost, false)}>
                        {benchmark.status === 'partial'
                          ? '무한대'
                          : benchmark.status === 'impossible'
                            ? '도달 불가'
                            : formatAmount(benchmark.expectedCost)}
                      </strong>
                      {(benchmark.status === 'ready' || benchmark.status === 'already') && (
                        <span>{unit}</span>
                      )}
                    </dd>
                    {ready && <small>평균 {formatAmount(benchmark.expectedAttempts)}회 시도</small>}
                  </div>
                  <div className="result-analysis-spent">
                    <dt>현재 사용 예산</dt>
                    <dd>
                      <strong title={formatAmount(paid, false)}>{formatAmount(paid)}</strong>
                      <span>{unit}</span>
                    </dd>
                    <small>현재 도전에서 누적 {formatAmount(selection.attempts)}회</small>
                  </div>
                </dl>

                {luck && (
                  <div className={`result-analysis-luck luck-${luck}`}>
                    <span>
                      <Sparkles size={15} aria-hidden="true" />
                      <b>{LUCK_LABELS[luck]}</b>
                    </span>
                    <small>기댓값의 {ratioText} 사용</small>
                  </div>
                )}
                {budgetProbability !== undefined && (
                  <div className="result-analysis-budget-probability">
                    <div>
                      <span>현재 예산 이내 달성 확률</span>
                      <b>{formatPercent(budgetProbability * 100)}%</b>
                    </div>
                    <progress
                      max={1}
                      value={budgetProbability}
                      aria-label="현재 예산 이내 목표 달성 확률"
                    />
                  </div>
                )}
                {benchmark.status === 'already' && (
                  <p className="result-analysis-message">
                    시작 옵션이 이미 이 수치를 만족해요. 이 경우에는 행운을 판정하지 않아요.
                  </p>
                )}
                {benchmark.status === 'partial' && (
                  <p className="result-analysis-message">
                    등급 상승 후 이 수치에 도달할 수 없는 경로가 있어 평균 비용은 무한대예요. 이
                    경우에는 행운을 비교하지 않아요.
                  </p>
                )}
                {benchmark.status === 'impossible' && (
                  <p className="result-analysis-message">
                    현재 도전 조건으로는 이 수치에 도달할 수 없어 행운을 비교할 수 없어요.
                  </p>
                )}
              </>
            )}
          </div>
          <p className="result-analysis-note">
            도전 시작 상태와 현재 {selection.config.batchSize}회 진행 방식을 기준으로 계산합니다.
            {selection.config.batchSize === 3
              ? ' 등급 상승 구간은 목표 달성 시 멈추고, 레전드리 3회 비교는 세 번 모두 과금합니다.'
              : ' 목표 수치를 달성하면 멈추는 전략과 비교합니다.'}
          </p>
        </>
      ) : (
        <p className="result-analysis-message" role="status">
          이 직업을 기준으로 분석할 주요 옵션이 없어요.
        </p>
      )}
    </section>
  );
}
