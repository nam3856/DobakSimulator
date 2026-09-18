import { useEffect, useId, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  LockKeyhole,
  Plus,
  Trash2,
  UnlockKeyhole,
} from 'lucide-react';
import type {
  BenchmarkResult,
  CharacterSnapshot,
  Goal,
  LuckReaction,
  OptionLine,
  SimulationConfig,
  SimulationState,
  TargetCondition,
} from '../types';
import { GRADE_NAMES, GRADES, METRIC_LABELS } from './constants';
import { formatAmount, formatPercent } from './format';
import { buildAvatarUrl } from '../character/avatar';
import { ReactionTombstone } from './ReactionTombstone';
import {
  abilityConditionBounds,
  boundAbilityCondition,
  clampConditionValue,
  type ConditionValueBounds,
} from './ability-bounds';

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function GradeBadge({ grade }: { grade: keyof typeof GRADE_NAMES }) {
  return <span className={`grade-badge grade-${grade}`}>{GRADE_NAMES[grade]}</span>;
}
export function OptionLines({
  lines,
  locks,
  onToggleLock,
  locksDisabled = false,
  automaticLocks = false,
  empty = '아직 다른 세계의 결과가 없어요.',
}: {
  lines: OptionLine[];
  locks?: number[];
  onToggleLock?: (slot: number) => void;
  locksDisabled?: boolean;
  automaticLocks?: boolean;
  empty?: string;
}) {
  return (
    <div className="option-lines">
      {lines.length ? (
        lines.map((line, i) => {
          const locked = locks?.includes(i) ?? false;
          const lockLabel = `${i + 1}번째 줄 ${automaticLocks ? '자동 ' : ''}잠금`;
          return (
            <div className={`option-row${onToggleLock ? ' has-lock-control' : ''}`} key={i}>
              <i className={`grade-dot grade-${line.grade}`} aria-label={GRADE_NAMES[line.grade]} />
              <span>{line.text}</span>
              {onToggleLock ? (
                <button
                  type="button"
                  className={`icon-button option-lock-button${locked ? ' locked' : ''}`}
                  aria-label={`${i + 1}번째 보관 옵션 ${locked ? '잠금 해제' : '잠금'}`}
                  aria-pressed={locked}
                  disabled={locksDisabled || (!locked && (locks?.length ?? 0) >= 2)}
                  onClick={() => onToggleLock(i)}
                >
                  {locked ? (
                    <LockKeyhole
                      size={17}
                      aria-label={automaticLocks ? lockLabel : undefined}
                      aria-hidden={automaticLocks ? undefined : true}
                    />
                  ) : (
                    <UnlockKeyhole size={17} aria-hidden="true" />
                  )}
                </button>
              ) : locked ? (
                <LockKeyhole size={14} className="option-lock" aria-label={lockLabel} />
              ) : null}
            </div>
          );
        })
      ) : (
        <p className="empty-copy">{empty}</p>
      )}
    </div>
  );
}
export function LineEditor({
  lines,
  options,
  onChange,
  locks,
  onLock,
  canLock = false,
}: {
  lines: OptionLine[];
  options: OptionLine[][];
  onChange: (lines: OptionLine[]) => void;
  locks?: number[];
  onLock?: (slot: number) => void;
  canLock?: boolean;
}) {
  return (
    <div className="line-editors">
      {[0, 1, 2].map((slot) => {
        const current = lines[slot];
        const pool = options[slot] ?? [];
        const index = pool.findIndex((x) => x.id === current?.id && x.grade === current?.grade);
        return (
          <div className="line-editor" key={slot}>
            <span className="line-no">{slot + 1}</span>
            <select
              aria-label={`${slot + 1}번째 시작 옵션`}
              value={index < 0 ? 'current' : String(index)}
              onChange={(e) => {
                const next = lines.slice();
                next[slot] = pool[Number(e.target.value)];
                onChange(next);
              }}
            >
              <option value="current" disabled>
                {current?.text ?? '시작 옵션 선택'}
              </option>
              {pool.map((x, i) => (
                <option value={i} key={`${x.grade}-${x.id}-${i}`}>
                  [{GRADE_NAMES[x.grade]}] {x.text}
                </option>
              ))}
            </select>
            {canLock && (
              <button
                type="button"
                className={`icon-button lock-button ${locks?.includes(slot) ? 'locked' : ''}`}
                aria-label={`${slot + 1}번째 옵션 ${locks?.includes(slot) ? '잠금 해제' : '잠금'}`}
                aria-pressed={locks?.includes(slot)}
                onClick={() => onLock?.(slot)}
              >
                {locks?.includes(slot) ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
function ConditionValueInput({
  condition,
  index,
  bounds,
  descriptionId,
  onChange,
}: {
  condition: TargetCondition;
  index: number;
  bounds?: ConditionValueBounds;
  descriptionId?: string;
  onChange: (patch: Partial<TargetCondition>) => void;
}) {
  const value = condition.maxValue ?? condition.minValue;
  const [draft, setDraft] = useState(String(value));
  const identity = `${condition.type}:${condition.minGrade}:${condition.slot}:${condition.slots?.join(',')}`;
  useEffect(() => {
    setDraft(String(value));
  }, [value, identity, bounds?.min, bounds?.max]);
  const update = (next: number) => {
    if (next !== value)
      onChange(condition.maxValue !== undefined ? { maxValue: next } : { minValue: next });
  };
  const commit = () => {
    const next = clampConditionValue(draft, bounds, value);
    setDraft(String(next));
    update(next);
  };
  return (
    <input
      aria-label={`목표 조건 ${index + 1} 수치`}
      aria-describedby={descriptionId}
      type="number"
      min={bounds?.min ?? 0}
      max={bounds?.max}
      step="0.5"
      value={draft}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const parsed = Number(raw);
        if (
          raw.trim() &&
          Number.isFinite(parsed) &&
          (!bounds || (parsed >= bounds.min && parsed <= bounds.max))
        )
          update(parsed);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function GoalEditor({
  goal,
  onChange,
  options,
  mode,
  conditionBounds,
}: {
  goal: Goal;
  onChange: (x: Goal) => void;
  options: OptionLine[];
  mode: SimulationConfig['mode'];
  conditionBounds?: Array<ConditionValueBounds | undefined>;
}) {
  const rangeId = useId();
  const lowerTypes = new Set([
    'ability-7dc1b5f41b7891f2',
    'ability-a25eb717baea2b8e',
    'attackPerLevels',
    'magicAttackPerLevels',
  ]);
  const metrics = new Map<string, string>();
  for (const x of options)
    if (x.type !== 'unknown')
      metrics.set(
        x.type,
        METRIC_LABELS[x.type] ?? x.text.replace(/[+-]?\d+(?:\.\d+)?/g, '').trim(),
      );
  for (const x of goal.conditions)
    if (!metrics.has(x.type)) metrics.set(x.type, METRIC_LABELS[x.type] ?? x.type);
  const changeCondition = (i: number, patch: Partial<TargetCondition>, useMinimum = false) =>
    onChange({
      ...goal,
      conditions: goal.conditions.map((x, j) =>
        j !== i
          ? x
          : mode === 'ability'
            ? boundAbilityCondition(options, { ...x, ...patch }, useMinimum)
            : { ...x, ...patch },
      ),
    });
  return (
    <div className="goal-editor">
      {mode !== 'soulAmplification' && (
        <div className="field-row">
          <Field label="성공 기준">
            <select
              aria-label="성공 기준"
              value={goal.mode}
              onChange={(e) => onChange({ ...goal, mode: e.target.value as Goal['mode'] })}
            >
              <option value={mode === 'ability' ? 'ability' : 'sum'}>
                {mode === 'ability' ? '원하는 어빌리티' : '유효옵션 합계 이상'}
              </option>
              <option value="exact">정확한 세 줄 재현</option>
              {mode !== 'ability' && <option value="grade">등급 도달</option>}
            </select>
          </Field>
          <Field label="목표 등급">
            <select
              aria-label="목표 등급"
              value={goal.minimumGrade}
              disabled={mode === 'ability'}
              onChange={(e) =>
                onChange({ ...goal, minimumGrade: e.target.value as Goal['minimumGrade'] })
              }
            >
              {GRADES.map((x) => (
                <option value={x} key={x}>
                  {GRADE_NAMES[x]} 이상
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {mode === 'soulAmplification' ? (
        <Field label="목표 증폭 단계">
          <select
            value={goal.stage}
            onChange={(e) => onChange({ ...goal, stage: Number(e.target.value) })}
          >
            {[1, 2, 3, 4].map((x) => (
              <option key={x} value={x}>
                {x}단계
              </option>
            ))}
          </select>
        </Field>
      ) : goal.mode === 'exact' ? (
        <>
          <div className="exact-goal-lines">
            <OptionLines
              lines={goal.lines}
              empty="장비를 불러오거나 아래에서 목표 옵션을 선택해 주세요."
            />
          </div>
          <div className="line-editors">
            {[0, 1, 2].map((i) => (
              <select
                aria-label={`정확한 재현 ${i + 1}번째 목표 옵션`}
                key={i}
                value={options.findIndex(
                  (x) => x.id === goal.lines[i]?.id && x.grade === goal.lines[i]?.grade,
                )}
                onChange={(e) => {
                  const lines = Array.from({ length: 3 }, (_, slot) =>
                    slot === i ? options[Number(e.target.value)] : (goal.lines[slot] ?? options[0]),
                  );
                  onChange({ ...goal, lines });
                }}
              >
                <option value={-1} disabled>
                  {goal.lines[i]?.text ?? `${i + 1}번째 목표 옵션`}
                </option>
                {options.map((x, j) => (
                  <option value={j} key={`${x.grade}${x.id}${j}`}>
                    [{GRADE_NAMES[x.grade]}] {x.text}
                  </option>
                ))}
              </select>
            ))}
          </div>
          <small className="muted">줄 순서를 제외한 종류·수치·중복 개수를 맞춥니다.</small>
        </>
      ) : goal.mode !== 'grade' ? (
        <>
          <div className="goal-conditions">
            {goal.conditions.map((condition, i) => {
              const bounds =
                conditionBounds?.[i] ??
                (mode === 'ability' ? abilityConditionBounds(options, condition) : undefined);
              const descriptionId = bounds ? `${rangeId}-condition-${i}` : undefined;
              return (
                <div className="goal-condition" key={i}>
                  <div className="condition-main">
                    <select
                      aria-label={`목표 조건 ${i + 1} 옵션`}
                      value={condition.type}
                      onChange={(e) =>
                        changeCondition(
                          i,
                          {
                            type: e.target.value,
                            minValue: lowerTypes.has(e.target.value) ? 0 : 1,
                            maxValue: lowerTypes.has(e.target.value) ? 10 : undefined,
                          },
                          true,
                        )
                      }
                    >
                      {[...metrics].map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {mode === 'ability' || bounds ? (
                      <ConditionValueInput
                        condition={condition}
                        index={i}
                        bounds={bounds}
                        descriptionId={descriptionId}
                        onChange={(patch) => changeCondition(i, patch)}
                      />
                    ) : (
                      <input
                        aria-label={`목표 조건 ${i + 1} 수치`}
                        type="number"
                        min="0"
                        step="0.5"
                        value={condition.maxValue ?? condition.minValue}
                        onChange={(e) =>
                          changeCondition(
                            i,
                            condition.maxValue !== undefined
                              ? { maxValue: Number(e.target.value) }
                              : { minValue: Number(e.target.value) },
                          )
                        }
                      />
                    )}
                    <span className="condition-comparator">
                      {condition.maxValue !== undefined ? '이하' : '이상'}
                    </span>
                    <button
                      className="icon-button"
                      aria-label={`목표 조건 ${i + 1} 삭제`}
                      onClick={() =>
                        onChange({ ...goal, conditions: goal.conditions.filter((_, j) => j !== i) })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  {bounds && (
                    <small className="condition-range" id={descriptionId}>
                      입력 범위{' '}
                      {bounds.min === bounds.max
                        ? `${bounds.min} 고정`
                        : `${bounds.min} ~ ${bounds.max}`}
                    </small>
                  )}
                  {mode === 'ability' && (
                    <div className="ability-condition-meta">
                      <select
                        aria-label={`목표 조건 ${i + 1} 줄`}
                        value={
                          condition.slots?.length === 2 &&
                          condition.slots.includes(1) &&
                          condition.slots.includes(2)
                            ? 'lower'
                            : (condition.slot ?? -1)
                        }
                        onChange={(e) =>
                          changeCondition(i, {
                            slot:
                              e.target.value === 'lower' || Number(e.target.value) < 0
                                ? undefined
                                : Number(e.target.value),
                            slots: e.target.value === 'lower' ? [1, 2] : undefined,
                          })
                        }
                      >
                        <option value={-1}>아무 줄</option>
                        <option value="lower">2·3번째 줄 중 하나</option>
                        {[0, 1, 2].map((x) => (
                          <option key={x} value={x}>
                            {x + 1}번째 줄
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label={`목표 조건 ${i + 1} 등급`}
                        value={condition.minGrade ?? 'epic'}
                        onChange={(e) =>
                          changeCondition(i, {
                            minGrade: e.target.value as TargetCondition['minGrade'],
                          })
                        }
                      >
                        {GRADES.filter((x) => x !== 'rare').map((x) => (
                          <option key={x} value={x}>
                            {GRADE_NAMES[x]} 이상
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="goal-actions">
            <button
              className="text-button"
              onClick={() => {
                const type = [...metrics.keys()][0];
                if (type) {
                  const condition: TargetCondition =
                    mode === 'ability' && lowerTypes.has(type)
                      ? { type, minValue: 0, maxValue: 10 }
                      : { type, minValue: 1 };
                  onChange({
                    ...goal,
                    conditions: [
                      ...goal.conditions,
                      mode === 'ability'
                        ? boundAbilityCondition(options, condition, true)
                        : condition,
                    ],
                  });
                }
              }}
            >
              <Plus size={14} /> 조건 추가
            </button>
            <select
              aria-label="조건 결합 방식"
              value={goal.match}
              onChange={(e) => onChange({ ...goal, match: e.target.value as Goal['match'] })}
            >
              <option value="all">모두 만족</option>
              <option value="any">하나 이상 만족</option>
            </select>
          </div>
          {!goal.conditions.length && (
            <p className="inline-note">주요 옵션이 없습니다. 목표 조건을 직접 추가해 주세요.</p>
          )}
        </>
      ) : (
        <p className="inline-note">선택한 등급에 도달하면 도전이 끝납니다.</p>
      )}
    </div>
  );
}
export function Avatar({
  character,
  reaction = 'neutral',
  className = '',
}: {
  character: CharacterSnapshot;
  reaction?: LuckReaction;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    setFallbackFailed(false);
  }, [character.imageUrl, reaction]);
  let imageUrl = '';
  try {
    imageUrl = character.bundledAvatars
      ? `${import.meta.env.BASE_URL}character/${reaction}.png`
      : buildAvatarUrl(character.imageUrl, reaction);
  } catch {
    imageUrl = character.imageUrl;
  }
  return fallbackFailed ? (
    <div
      className={`avatar-fallback reaction-${reaction} ${className}`}
      aria-label={`${character.name} 캐릭터 이미지 없음`}
    >
      {character.name.slice(0, 1)}
    </div>
  ) : (
    <img
      className={`character-sprite reaction-${reaction} ${failed ? 'avatar-image-fallback' : ''} ${className}`}
      src={failed ? character.imageUrl : imageUrl}
      alt={`${character.name} · ${{ neutral: '기본 자세', happy: '웃는 모습', cry: '울면서 엎드린 모습', jackpot: '웃으며 점프하는 모습', ghost: '둥둥 떠 있는 유령 모습' }[reaction]}`}
      onError={() => (failed ? setFallbackFailed(true) : setFailed(true))}
    />
  );
}
export function ReactionStage({
  character,
  state,
  benchmark,
  reaction,
  actualCost,
  messages,
}: {
  character: CharacterSnapshot;
  state: Pick<SimulationState, 'status' | 'attempts'>;
  benchmark?: BenchmarkResult;
  reaction?: LuckReaction;
  actualCost: number;
  messages?: Partial<Record<LuckReaction, readonly [string, string]>>;
}) {
  const done = state.status === 'success' && state.attempts > 0n;
  const judged = done && !!reaction;
  const copy = {
    jackpot: ['이 세계에선, 내가 주인공.', '이 정도면 평행세계에서도 부러워할 운이에요.'],
    happy: ['이번 세계의 나는, 꽤 운이 좋다.', '기댓값보다 가볍게 목표에 도착했어요.'],
    neutral: ['어느 세계나, 이 정도는 쓰는구나.', '기댓값 언저리에서 무난하게 목표를 달성했어요.'],
    cry: ['다른 세계의 나도… 울고 있다.', '기댓값보다 조금 더 먼 길을 돌아왔어요.'],
    ghost: ['이세계여서 다행이다…', '현실에서 돌렸으면 나도 같이 증발했겠다.'],
  };
  const text = judged
    ? (messages?.[reaction] ?? copy[reaction])
    : done && benchmark && (benchmark.status === 'partial' || benchmark.status === 'impossible')
      ? [
          '목표 달성! 평균과의 비교는 할 수 없어요.',
          '실패로 끝나는 경로가 있어 이 설정의 평균 비용은 무한대입니다.',
        ]
      : done
        ? [
            '목표 달성! 결과를 살펴보고 있어요.',
            '같은 조건의 기댓값과 비용 분포를 계산하고 있어요.',
          ]
        : state.attempts === 0n && benchmark?.status === 'already'
          ? ['이미 목표에 도착해 있어요.', '더 높은 목표를 선택해 새로운 도전을 시작해 보세요.']
          : ['이 세계의 결말은, 아직 모른다.', '목표를 달성하면 또 다른 내가 결과에 반응해요.'];
  return (
    <section
      className={`reaction-stage ${judged ? `is-${reaction}` : ''}`}
      aria-label="이세계 캐릭터 반응"
    >
      <div className="reaction-stage-head">
        <span className="eyebrow">ANOTHER ME</span>
        <span className="stage-label">이세계의 {character.name}</span>
        {judged && (
          <span className="luck-badge">
            {reaction === 'jackpot'
              ? `행운의 상위 10% · P${formatPercent((benchmark?.cdfAtActual ?? 0) * 100)}`
              : `비용 백분위 P${formatPercent((benchmark?.cdfAtActual ?? 0) * 100)}`}
          </span>
        )}
      </div>
      <div className="reaction-scene">
        <div className="world-orbit orbit-one" />
        <div className="world-orbit orbit-two" />
        <div className="star star-one">✦</div>
        <div className="star star-two">✧</div>
        <div className="character-ground" />
        {judged && reaction === 'ghost' && <ReactionTombstone />}
        <Avatar
          character={character}
          reaction={judged ? reaction : 'neutral'}
          className="stage-sprite"
        />
        {judged && reaction === 'cry' && <span className="reaction-symbol">···</span>}
        {judged && reaction === 'jackpot' && (
          <span className="reaction-symbol jackpot-symbol">✦</span>
        )}
      </div>
      <div className="reaction-copy">
        <h3>{text[0]}</h3>
        <p>{text[1]}</p>
        {judged && benchmark && (
          <span className="ratio-copy">
            기댓값의 <b>{((actualCost / benchmark.expectedCost) * 100).toFixed(1)}%</b> 사용
          </span>
        )}
      </div>
    </section>
  );
}
export function DistributionChart({
  benchmark,
  actualCost,
  done,
}: {
  benchmark: BenchmarkResult;
  actualCost: number;
  done: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const maxCost = Math.max(benchmark.quantiles.p90 * 1.25, done ? actualCost : 0, 1);
  const samples = benchmark.distribution.filter(
    (x) => Number.isFinite(x.cost) && x.cost <= maxCost,
  );
  const points = [{ cost: 0, cdf: 0 }, ...samples];
  const line = points
    .map((x, i) => `${i ? 'L' : 'M'}${36 + (x.cost / maxCost) * 524},${144 - x.cdf * 120}`)
    .join(' ');
  const markers = [
    ['P10', benchmark.quantiles.p10],
    ['P50', benchmark.quantiles.p50],
    ['P90', benchmark.quantiles.p90],
  ] as const;
  const hovered =
    hover === null
      ? undefined
      : points.reduce(
          (prev, cur) =>
            Math.abs(cur.cost - hover * maxCost) < Math.abs(prev.cost - hover * maxCost)
              ? cur
              : prev,
          points[0],
        );
  return (
    <section className="distribution">
      <div className="section-title">
        <h3>다른 세계의 도전들</h3>
        <span>
          {benchmark.method === 'sampled' ? '50만 표본 · 추정 분포' : '확률 모형으로 계산'}
        </span>
      </div>
      <p>같은 목표를 이 비용 안에 달성할 확률이에요.</p>
      <svg
        viewBox="0 0 600 185"
        role="img"
        aria-label="목표 달성 비용 누적 분포"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.min(1, Math.max(0, (((e.clientX - r.left) / r.width) * 600 - 36) / 524)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="chartFill" x1="0" x2="0" y1="0" y2="1">
            <stop stopColor="var(--accent)" stopOpacity=".2" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((y) => (
          <g key={y}>
            <line x1="36" x2="560" y1={144 - y * 120} y2={144 - y * 120} className="chart-grid" />
            <text x="28" y={148 - y * 120} textAnchor="end" className="chart-tick">
              {y * 100}%
            </text>
          </g>
        ))}
        {points.length > 1 && (
          <>
            <path
              d={`${line} L${36 + (points[points.length - 1].cost / maxCost) * 524},144 Z`}
              fill="url(#chartFill)"
            />
            <path d={line} className="chart-line" />
          </>
        )}
        {markers.map(([name, cost]) => (
          <g key={name}>
            <line
              x1={36 + (cost / maxCost) * 524}
              x2={36 + (cost / maxCost) * 524}
              y1="22"
              y2="144"
              className="chart-marker"
            />
            <text
              x={36 + (cost / maxCost) * 524}
              y="162"
              textAnchor="middle"
              className="chart-tick"
            >
              {name}
            </text>
          </g>
        ))}
        {done && (
          <g>
            <line
              x1={36 + (actualCost / maxCost) * 524}
              x2={36 + (actualCost / maxCost) * 524}
              y1="15"
              y2="144"
              className="chart-actual"
            />
            <text
              x={Math.min(540, Math.max(55, 36 + (actualCost / maxCost) * 524))}
              y="12"
              textAnchor="middle"
              className="chart-actual-label"
            >
              이번의 나
            </text>
          </g>
        )}
        {hovered && (
          <circle
            cx={36 + (hovered.cost / maxCost) * 524}
            cy={144 - hovered.cdf * 120}
            r="4"
            fill="var(--accent)"
          />
        )}
      </svg>
      <div className="quantile-row">
        {markers.map(([name, value]) => (
          <div key={name}>
            <span>{name === 'P50' ? '중앙값' : name}</span>
            <strong>
              {formatAmount(value)} <small>{benchmark.unit === 'meso' ? '메소' : '개'}</small>
            </strong>
          </div>
        ))}
      </div>
      {hovered && (
        <div className="chart-tooltip">
          {formatAmount(hovered.cost)} {benchmark.unit === 'meso' ? '메소' : '개'} 이내 ·{' '}
          {(hovered.cdf * 100).toFixed(1)}%
        </div>
      )}
    </section>
  );
}
export function Sources({ fetchedAt }: { fetchedAt: string }) {
  return (
    <details className="sources">
      <summary>
        <CircleHelp size={15} /> 계산 기준과 출처 <ChevronDown size={14} />
      </summary>
      <div>
        <p>
          2026년 9월 17일 한국 본서버 · 평상시 확률. 공개 표의 반올림된 확률을 정규화한 모형이며
          실제 게임의 내부 난수와는 독립적입니다.
        </p>
        <p>
          현재와 같은 등급·줄 순서·표시값의 결과는 다시 추첨합니다. 도전에서는 기존 옵션을 유지하고
          등급 상승은 적용합니다. 3회 비교는 같은 시작 옵션에서 독립 추첨하고 세 번 모두 비용에
          포함합니다.
        </p>
        <p>
          기본 캐릭터 조회: {new Date(fetchedAt).toLocaleDateString('ko-KR')}. API에 없는 보장
          진척은 0에서 시작하며 직접 바꿀 수 있습니다.
        </p>
        <div className="source-links">
          {[
            ['본서버 업데이트', 'https://maplestory.nexon.com/News/Update/813'],
            ['블랙·프라임', 'https://maplestory.nexon.com/Guide/OtherProbability/cube/black'],
            [
              '에디셔널·프라임 에디셔널',
              'https://maplestory.nexon.com/Guide/OtherProbability/cube/addi',
            ],
            ['골드·명장', 'https://maplestory.nexon.com/Guide/OtherProbability/cube/artisan'],
            ['어빌리티', 'https://maplestory.nexon.com/Guide/OtherProbability/ability/reputevalue'],
            ['소울 잠재', 'https://maplestory.nexon.com/Guide/OtherProbability/cube/Soulpotential'],
            ['참고 시뮬레이터', 'https://smrong98.github.io/cubesimul/'],
          ].map(([label, url]) => (
            <a href={url} target="_blank" rel="noreferrer" key={url}>
              {label}
              <ArrowUpRight size={12} />
            </a>
          ))}
        </div>
      </div>
    </details>
  );
}
export function GoalChips({ goal }: { goal: Goal }) {
  return (
    <div className="goal-chips">
      {goal.mode === 'stage' ? (
        <span>
          <Check size={12} />
          {goal.stage}단계 도달
        </span>
      ) : (
        <>
          <span>{GRADE_NAMES[goal.minimumGrade]} 이상</span>
          {goal.mode === 'exact' ? (
            <span>정확한 세 줄 재현</span>
          ) : (
            goal.conditions.map((x, i) => (
              <span key={i}>
                {METRIC_LABELS[x.type] ?? x.type} {x.minValue}↑
              </span>
            ))
          )}
        </>
      )}
    </div>
  );
}
