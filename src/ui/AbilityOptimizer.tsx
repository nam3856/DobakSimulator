import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Calculator,
  Check,
  ChevronDown,
  LoaderCircle,
  Search,
  Square,
  Trophy,
} from 'lucide-react';
import type { CharacterSnapshot, OptionLine, SimulationConfig } from '../types';
import {
  allCandidates,
  resolveOptionLine,
  type AbilityOption,
  type RuleData,
} from '../engine/rules';
import type {
  AbilityOptimizerTarget,
  AbilityOptimizerResult,
  AbilityOptimizerStrategyResult,
} from '../engine/ability-optimizer';
import type { OptimizerRequest, OptimizerResponse } from '../workers/ability-optimizer.worker';
import type { NormalAbilityOptimizerResult } from '../engine/ability-normal-optimizer';
import type {
  NormalOptimizerRequest,
  NormalOptimizerResponse,
} from '../workers/ability-normal-optimizer.worker';
import {
  ABILITY_JOB_PRESETS,
  makeAbilityPresetGoal,
  resolveAbilityPreset,
} from '../character/ability-presets';
import { getCharacter } from '../character/client';
import { getSharedCharacter } from '../character/shared';
import {
  createOptimizerAvatar,
  type OptimizerAvatarDescriptor,
} from '../character/optimizer-avatar';
import { OptimizerWalkingAvatar } from './OptimizerWalkingAvatar';
import { OptimizerIntro } from './OptimizerIntro';
import { groupOptimizerStrategies, optimizerLockCondition } from './optimizer-strategies';
import { Field, GradeBadge, LineEditor, OptionLines } from './components';
import { formatAmount } from './format';
import './ability-optimizer.css';
import './optimizer-motion.css';

const PRICE_KEY = 'isekai:ability-optimizer:prices:v1';
const ABILITY_CONFIG = { mode: 'ability', start: { grade: 'legendary' } } as SimulationConfig;
const EMPTY_LINES: OptionLine[] = [];
const TIPS = [
  '고급 재설정의 첫 줄은 항상 레전드리예요. 둘째·셋째 줄은 각각 2% 확률로 레전드리가 등장해요.',
  '같은 종류의 어빌리티는 중복으로 등장하지 않아요.',
  '잠근 줄이 많을수록 재설정에 필요한 명성치와 메소가 늘어나요.',
  '심연의 서큘레이터는 등급과 종류를 유지하고 세 줄의 수치를 함께 바꿔요.',
  '목표 종류와 등급을 갖췄다면, 서큘레이터로 수치만 완성하는 방법도 비교해 보세요.',
  '기댓값은 평균이에요. 실제로 필요한 비용은 도전마다 달라질 수 있어요.',
];
type Step = 'intro' | 'character' | 'target' | 'prices' | 'calculating' | 'result';
type TargetGrade = 'none' | 'unique' | 'legendary';
type TargetGrades = ['legendary', TargetGrade, TargetGrade];
const DEFAULT_TARGET_GRADES: TargetGrades = ['legendary', 'legendary', 'legendary'];
const gradeName = (grade: TargetGrade) => (grade === 'unique' ? '유니크' : '레전드리');
const count = (value: number) =>
  Number.isFinite(value) ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—';
const money = (value: number) => `${formatAmount(value)} 메소`;
const maximum = (option: AbilityOption) =>
  option.values.reduce((a, b) =>
    (option.valueDirection === 'lower' ? b.value < a.value : b.value > a.value) ? b : a,
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
function fetchedTime(value: string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? '조회 시각 없음'
    : `${time.toLocaleString('ko-KR', { year: time.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} 조회`;
}

export function AbilityOptimizer({
  character,
  data,
  apiBase,
  searchReady = true,
  personalApiKey = '',
  linkedName = '',
}: {
  character: CharacterSnapshot;
  data: RuleData;
  apiBase?: string;
  searchReady?: boolean;
  personalApiKey?: string;
  linkedName?: string;
}) {
  const initialCharacter =
    (!linkedName || linkedName === character.name) && character.name !== '깽미니'
      ? character
      : undefined;
  const [selectedCharacter, setSelectedCharacter] = useState(initialCharacter);
  const [nickname, setNickname] = useState(linkedName || initialCharacter?.name || '');
  const [step, setStep] = useState<Step>('intro');
  const [direction, setDirection] = useState<'next' | 'back'>('next');
  function goToStep(next: Step, movement: 'next' | 'back' = 'next') {
    setDirection(movement);
    setStep(next);
  }
  const [manual, setManual] = useState(false);
  const [manualLines, setManualLines] = useState<OptionLine[]>([]);
  const [personal, setPersonal] = useState(false);
  const [key, setKey] = useState(personalApiKey);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const searchAbort = useRef<AbortController | null>(null);
  const searchVersion = useRef(0);
  const pendingLink = useRef(linkedName && linkedName !== initialCharacter?.name ? linkedName : '');
  const options = useMemo(
    () => data.ability.grades.legendary?.options.filter((o) => o.type && o.values.length) ?? [],
    [data],
  );
  const uniqueOptions = useMemo(
    () => data.ability.grades.unique?.options.filter((o) => o.type && o.values.length) ?? [],
    [data],
  );
  const goalOptions = (grade: TargetGrade) => (grade === 'unique' ? uniqueOptions : options);
  const pools = useMemo(
    () =>
      [0, 1, 2].map((slot) =>
        allCandidates(data, ABILITY_CONFIG, 'legendary', slot).map((row) => row.line),
      ),
    [data],
  );
  function settings(next?: CharacterSnapshot) {
    const manualOrCharacter = stored(
      `isekai:ability-optimizer:settings:v1:${next?.name ?? 'manual'}`,
    );
    const saved =
      !next && !Object.keys(manualOrCharacter).length
        ? stored(`isekai:ability-optimizer:settings:v1:${character.name}`)
        : manualOrCharacter;
    let defaults: string[];
    try {
      defaults = makeAbilityPresetGoal(data, next?.job ?? character.job).conditions.map(
        (c) => c.type,
      );
    } catch {
      defaults = options.slice(0, 3).map((o) => o.type!);
    }
    const grades: TargetGrades =
      Array.isArray(saved.targetGrades) &&
      saved.targetGrades.length === 3 &&
      saved.targetGrades[0] === 'legendary' &&
      saved.targetGrades.every((g) => ['none', 'unique', 'legendary'].includes(g))
        ? (saved.targetGrades as TargetGrades)
        : DEFAULT_TARGET_GRADES;
    const target =
      Array.isArray(saved.targetTypes) &&
      saved.targetTypes.length === 3 &&
      saved.targetTypes.every((t) => typeof t === 'string')
        ? (saved.targetTypes as string[]).map((t, i) =>
            grades[i] === 'none' || goalOptions(grades[i]).some((o) => o.type === t) ? t : '',
          )
        : defaults;
    const selectedJob =
      typeof saved.job === 'string'
        ? saved.job
        : (resolveAbilityPreset(next?.job ?? character.job)?.job ?? '');
    let job = '';
    try {
      if (
        grades.every((g) => g === 'legendary') &&
        makeAbilityPresetGoal(data, selectedJob).conditions.every((c, i) => c.type === target[i])
      )
        job = selectedJob;
    } catch {
      /* Custom goals. */
    }
    return {
      target: target as [string, string, string],
      grades,
      job,
      preset:
        typeof saved.preset === 'string' && next?.abilityPresets[saved.preset]
          ? saved.preset
          : (next?.activeAbilityPreset ?? '1'),
      batch: saved.batchSize === 1 ? (1 as const) : (3 as const),
    };
  }
  const [initial] = useState(() => settings(initialCharacter));
  const [savedPrices] = useState(() => stored(PRICE_KEY));
  const [targetTypes, setTargetTypes] = useState(initial.target);
  const [targetGrades, setTargetGrades] = useState<TargetGrades>(initial.grades);
  const [job, setJob] = useState(initial.job);
  const [preset, setPreset] = useState(initial.preset);
  const [batchSize, setBatchSize] = useState<1 | 3>(initial.batch);
  const [medalPrice, setMedalPrice] = useState(
    typeof savedPrices.medal === 'string' && savedPrices.medal.trim()
      ? savedPrices.medal
      : '4000000',
  );
  const [circulatorPrice, setCirculatorPrice] = useState(
    typeof savedPrices.circulator === 'string' && savedPrices.circulator.trim()
      ? savedPrices.circulator
      : '200000000',
  );
  const [availableHonor, setAvailableHonor] = useState(
    String(initialCharacter?.abilityPresets[initial.preset]?.honor ?? 0),
  );
  const [saved, setSaved] = useState(true);
  const [result, setResult] = useState<AbilityOptimizerResult>();
  const [normalResult, setNormalResult] = useState<NormalAbilityOptimizerResult>();
  const [error, setError] = useState('');
  const [avatar, setAvatar] = useState<OptimizerAvatarDescriptor>();
  const [introAvatar] = useState(() => createOptimizerAvatar());
  const introCharacters = useMemo(
    () => (selectedCharacter ? [character, selectedCharacter] : [character]),
    [character, selectedCharacter],
  );
  const [tip, setTip] = useState('');
  const worker = useRef<Worker | null>(null);
  const requestId = useRef('');
  const inFlight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const imported = selectedCharacter?.abilityPresets[preset];
  const rawLines = manual ? manualLines : (imported?.lines ?? EMPTY_LINES);
  const lines = useMemo(
    () => rawLines.map((line, slot) => line && resolveOptionLine(data, ABILITY_CONFIG, line, slot)),
    [data, rawLines],
  );
  const selected = targetTypes.map((t, i) =>
    targetGrades[i] === 'none' ? undefined : goalOptions(targetGrades[i]).find((o) => o.type === t),
  );
  const targets = useMemo<AbilityOptimizerTarget[]>(
    () =>
      targetTypes.flatMap((type, i) =>
        targetGrades[i] === 'none'
          ? []
          : [{ type, grade: targetGrades[i] as 'unique' | 'legendary' }],
      ),
    [targetTypes, targetGrades],
  );
  const allLegendary = targets.every((target) => target.grade === 'legendary');
  const normalOptimization = targets.filter((target) => target.grade === 'legendary').length === 1;
  const medal = price(medalPrice),
    circulator = price(circulatorPrice),
    honor = price(availableHonor);
  const startValidation =
    !manual && !selectedCharacter
      ? '닉네임을 조회하거나 현재 세 줄을 직접 입력해 주세요.'
      : !manual && imported?.grade !== 'legendary'
        ? '레전드리 어빌리티 프리셋을 선택해 주세요.'
        : lines.length !== 3 || [0, 1, 2].some((slot) => !lines[slot])
          ? '현재 어빌리티 세 줄을 모두 선택해 주세요.'
          : lines.some(
                (line, slot) =>
                  !pools[slot].some((o) => o.id === line.id && o.grade === line.grade),
              )
            ? '공식 옵션 목록에서 현재 세 줄을 다시 선택해 주세요.'
            : new Set(lines.map((l) => l.type)).size !== 3
              ? '현재 세 줄은 서로 다른 종류여야 합니다.'
              : '';
  const targetValidation =
    new Set(targets.map((target) => target.type)).size !== targets.length
      ? '선택한 목표는 서로 다른 옵션이어야 합니다.'
      : selected.some((o, i) => targetGrades[i] !== 'none' && !o)
        ? '사용할 목표 옵션을 모두 선택해 주세요.'
        : '';
  const priceValidation =
    honor === undefined || honor > 999999999
      ? '보유 명성치는 0부터 999,999,999까지 정수로 입력해 주세요.'
      : medal === undefined || circulator === undefined
        ? '훈장과 서큘레이터의 개당 메소 가격을 입력해 주세요. 무료라면 0을 입력할 수 있습니다.'
        : '';
  const acquired = selected.map(
    (option, i) =>
      option &&
      lines.find(
        (line) =>
          line?.type === option.type &&
          (line.grade === 'legendary' || (targetGrades[i] === 'unique' && line.grade === 'unique')),
      ),
  );
  const allTypesAcquired =
    !startValidation &&
    !targetValidation &&
    acquired.every((line, i) => targetGrades[i] === 'none' || !!line);
  const allValuesComplete =
    allTypesAcquired &&
    selected.every(
      (option, i) =>
        !option ||
        (option.valueDirection === 'lower'
          ? acquired[i]!.value <= maximum(option).value
          : acquired[i]!.value >= maximum(option).value),
    );
  const sharedSearch = !!apiBase && !personal;

  useEffect(() => {
    try {
      localStorage.setItem(
        PRICE_KEY,
        JSON.stringify({ medal: medalPrice, circulator: circulatorPrice }),
      );
      localStorage.setItem(
        `isekai:ability-optimizer:settings:v1:${selectedCharacter?.name ?? 'manual'}`,
        JSON.stringify({ targetTypes, targetGrades, preset, batchSize, job }),
      );
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
    setResult(undefined);
    setNormalResult(undefined);
    setError('');
  }, [
    medalPrice,
    circulatorPrice,
    targetTypes,
    targetGrades,
    preset,
    batchSize,
    job,
    selectedCharacter,
    data,
    lines,
    availableHonor,
  ]);
  useEffect(
    () => () => {
      worker.current?.terminate();
      searchAbort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [step]);
  useEffect(() => {
    if (step !== 'character' || !pendingLink.current || !searchReady || !apiBase) return;
    const nextName = pendingLink.current;
    pendingLink.current = '';
    void lookup(nextName);
  }, [step, searchReady, apiBase]);

  function stopSearch() {
    searchVersion.current++;
    searchAbort.current?.abort();
    setSearchBusy(false);
  }
  async function lookup(name = nickname, refresh = false) {
    if (!name.trim() || !searchReady || (!sharedSearch && !key.trim())) return;
    stopSearch();
    const version = searchVersion.current;
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearchBusy(true);
    setSearchError('');
    try {
      const next = sharedSearch
        ? await getSharedCharacter(name, apiBase!, controller.signal, { refresh })
        : await getCharacter(name, key, controller.signal, { refresh });
      if (controller.signal.aborted || version !== searchVersion.current) return;
      const nextSettings = settings(next);
      setSelectedCharacter(next);
      setNickname(next.name);
      setPreset(nextSettings.preset);
      setTargetTypes(nextSettings.target);
      setTargetGrades(nextSettings.grades);
      setJob(nextSettings.job);
      setBatchSize(nextSettings.batch);
      setAvailableHonor(String(next.abilityPresets[nextSettings.preset]?.honor ?? 0));
      setManualLines([]);
      setManual(false);
    } catch (e) {
      if (!controller.signal.aborted && version === searchVersion.current)
        setSearchError(e instanceof Error ? e.message : '캐릭터를 불러오지 못했습니다.');
    } finally {
      if (version === searchVersion.current) setSearchBusy(false);
    }
  }
  function back() {
    stopSearch();
    if (step === 'calculating') cancel();
    else
      goToStep(
        step === 'character'
          ? 'intro'
          : step === 'target'
            ? 'character'
            : step === 'prices'
              ? 'target'
              : normalOptimization
                ? 'target'
                : 'prices',
        'back',
      );
  }
  function calculateNormal() {
    if (startValidation || targetValidation) return;
    if (allValuesComplete) {
      goToStep('result');
      return;
    }
    worker.current?.terminate();
    const next = new Worker(
      new URL('../workers/ability-normal-optimizer.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.current = next;
    const id = crypto.randomUUID();
    requestId.current = id;
    inFlight.current = true;
    setAvatar(createOptimizerAvatar(selectedCharacter));
    setTip('일반 최적화는 명성치와 서큘레이터 종류별 사용 개수를 각각 비교해요.');
    setError('');
    setNormalResult(undefined);
    goToStep('calculating');
    next.onmessage = ({ data: response }: MessageEvent<NormalOptimizerResponse>) => {
      if (response.id !== requestId.current) return;
      inFlight.current = false;
      next.terminate();
      worker.current = null;
      if ('error' in response) {
        setError(response.error);
        goToStep('target', 'back');
      } else {
        setNormalResult(response.result);
        goToStep('result');
      }
    };
    next.onerror = () => {
      if (requestId.current !== id) return;
      setError('계산을 완료하지 못했습니다. 다시 계산해 주세요.');
      goToStep('target', 'back');
      inFlight.current = false;
      next.terminate();
      worker.current = null;
    };
    next.postMessage({
      id,
      baseUrl: new URL(import.meta.env.BASE_URL, document.baseURI).href,
      input: { start: lines, targets },
    } satisfies NormalOptimizerRequest);
  }
  function calculate() {
    if (normalOptimization) {
      calculateNormal();
      return;
    }
    if (
      startValidation ||
      targetValidation ||
      priceValidation ||
      medal === undefined ||
      circulator === undefined ||
      honor === undefined
    )
      return;
    const next =
      worker.current ??
      new Worker(new URL('../workers/ability-optimizer.worker.ts', import.meta.url), {
        type: 'module',
      });
    worker.current = next;
    const id = crypto.randomUUID();
    requestId.current = id;
    inFlight.current = true;
    setAvatar(createOptimizerAvatar(selectedCharacter));
    setTip(TIPS[Math.floor(Math.random() * TIPS.length)]);
    setError('');
    setResult(undefined);
    goToStep('calculating');
    next.onmessage = ({ data: response }: MessageEvent<OptimizerResponse>) => {
      if (response.id !== requestId.current) return;
      inFlight.current = false;
      if ('error' in response) {
        setError(response.error);
        goToStep('prices', 'back');
      } else {
        setResult(response.result);
        goToStep('result');
      }
    };
    next.onerror = () => {
      if (requestId.current !== id) return;
      setError('계산을 완료하지 못했습니다. 다시 계산해 주세요.');
      goToStep('prices', 'back');
      inFlight.current = false;
      next.terminate();
      worker.current = null;
    };
    next.postMessage({
      id,
      baseUrl: new URL(import.meta.env.BASE_URL, document.baseURI).href,
      input: {
        start: lines,
        targets,
        medalPrice: medal,
        circulatorPrice: circulator,
        batchSize,
        availableHonor: honor,
      },
    } satisfies OptimizerRequest);
  }
  function cancel() {
    requestId.current = '';
    inFlight.current = false;
    worker.current?.terminate();
    worker.current = null;
    goToStep(normalOptimization ? 'target' : 'prices', 'back');
  }
  function prepareNormalTarget() {
    if (!normalOptimization || targetValidation) return;
    const conditions = selected.flatMap((option, i) => {
      if (!option) return [];
      const value = maximum(option).value;
      return [
        {
          type: option.type,
          minValue: option.valueDirection === 'lower' ? 0 : value,
          ...(option.valueDirection === 'lower' ? { maxValue: value } : {}),
          minGrade: targetGrades[i],
          ...(targetGrades[i] === 'legendary' ? { slot: 0 } : { slots: [1, 2] }),
        },
      ];
    });
    try {
      sessionStorage.setItem(
        'isekai:ability-normal:target',
        JSON.stringify({ conditions, start: lines }),
      );
    } catch {
      // The tab link remains usable when browser storage is unavailable.
    }
  }
  const best = result?.strategies.find((s) => s.id === result.bestStrategyId);
  const methodGroups = useMemo(
    () => groupOptimizerStrategies(result?.strategies ?? [], targets),
    [result, targets],
  );
  const titles: Record<Step, string> = {
    intro: '어빌리티 최적화',
    character: '어떤 캐릭터로 돌릴까요?',
    target: '어떤 옵션을 뽑을까요?',
    prices: '재화를 얼마나 준비할까요?',
    calculating: '계산중',
    result: '이렇게 완성해 보세요',
  };

  return (
    <section
      key={step}
      className={`optimizer optimizer-wizard optimizer-${step}`}
      aria-label="어빌리티 최적화"
      data-step={step}
      data-direction={direction}
    >
      {step === 'intro' ? (
        <OptimizerIntro
          avatar={introAvatar}
          data={data}
          characters={introCharacters}
          onStart={() => goToStep('character')}
        />
      ) : (
        <>
          {step !== 'calculating' && (
            <div className="optimizer-wizard-top">
              <button className="text-button optimizer-back" onClick={back}>
                <ArrowLeft size={16} /> 뒤로가기
              </button>
              <span>
                {step === 'character'
                  ? '1 / 3'
                  : step === 'target'
                    ? '2 / 3'
                    : step === 'prices'
                      ? '3 / 3'
                      : normalOptimization
                        ? '추천 결과'
                        : '계산 결과'}
              </span>
            </div>
          )}
          <div className="optimizer-wizard-heading">
            <h2 ref={heading} tabIndex={-1}>
              {titles[step]}
            </h2>
            {step === 'target' && <p>필요한 옵션만 선택 · 선택한 등급의 최대치 기준</p>}
          </div>
          {step === 'character' && (
            <div className="panel optimizer-step-panel">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void lookup();
                }}
              >
                <Field label="캐릭터 닉네임">
                  <div className="optimizer-search-row">
                    <input
                      aria-label="최적화 캐릭터 닉네임"
                      value={nickname}
                      maxLength={20}
                      placeholder="닉네임을 입력하세요"
                      onChange={(e) => {
                        stopSearch();
                        pendingLink.current = '';
                        setNickname(e.target.value);
                        setSelectedCharacter(undefined);
                        setSearchError('');
                        if (!manual) setAvailableHonor('0');
                      }}
                    />
                    <button
                      type="submit"
                      className="button"
                      aria-label="최적화 캐릭터 조회"
                      disabled={
                        !searchReady ||
                        searchBusy ||
                        !nickname.trim() ||
                        (!sharedSearch && !key.trim())
                      }
                    >
                      {searchBusy ? (
                        <LoaderCircle size={17} className="spin" />
                      ) : (
                        <Search size={17} />
                      )}{' '}
                      조회
                    </button>
                  </div>
                </Field>
                {(!sharedSearch || personal) && (
                  <Field label="개인 Nexon Open API 키">
                    <input
                      aria-label="최적화 개인 API 키"
                      type="password"
                      autoComplete="off"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                    />
                  </Field>
                )}
                <div className="optimizer-search-meta">
                  <span>
                    {selectedCharacter
                      ? fetchedTime(selectedCharacter.fetchedAt)
                      : '같은 캐릭터는 5분간 조회 정보를 재사용해요.'}
                  </span>
                  {selectedCharacter && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={searchBusy}
                      onClick={() => void lookup(selectedCharacter.name, true)}
                    >
                      최신 정보로 조회
                    </button>
                  )}
                  {apiBase && (
                    <button
                      type="button"
                      className="text-button optimizer-personal-toggle"
                      onClick={() => {
                        stopSearch();
                        setPersonal(!personal);
                      }}
                    >
                      {personal ? '공용 검색 사용' : '개인 키 사용'}
                    </button>
                  )}
                </div>
              </form>
              {searchError && (
                <p className="notice error" role="alert">
                  {searchError}
                </p>
              )}
              {!manual && (
                <>
                  <Field label="어빌리티 프리셋">
                    <select
                      aria-label="최적화 어빌리티 프리셋"
                      value={selectedCharacter ? preset : ''}
                      disabled={!selectedCharacter || searchBusy}
                      onChange={(e) => {
                        setPreset(e.target.value);
                        setManualLines([]);
                        setAvailableHonor(
                          String(selectedCharacter?.abilityPresets[e.target.value]?.honor ?? 0),
                        );
                      }}
                    >
                      {!selectedCharacter && <option value="">캐릭터를 조회해 주세요</option>}
                      {selectedCharacter &&
                        Object.keys(selectedCharacter.abilityPresets)
                          .sort()
                          .map((p) => (
                            <option key={p} value={p}>
                              프리셋 {p}
                              {p === selectedCharacter.activeAbilityPreset ? ' · 사용 중' : ''}
                            </option>
                          ))}
                    </select>
                  </Field>
                  {imported && (
                    <div className="optimizer-start">
                      <GradeBadge grade={imported.grade} />
                      <OptionLines lines={imported.lines} />
                    </div>
                  )}
                </>
              )}
              <button
                className="text-button optimizer-manual-toggle"
                onClick={() => {
                  stopSearch();
                  pendingLink.current = '';
                  if (!manual) {
                    setManualLines(
                      manualLines.length
                        ? manualLines
                        : imported?.lines
                          ? imported.lines.map((l, i) =>
                              resolveOptionLine(data, ABILITY_CONFIG, l, i),
                            )
                          : manualLines,
                    );
                    if (!selectedCharacter) setAvailableHonor('0');
                  }
                  setManual(!manual);
                }}
              >
                {manual ? '프리셋에서 선택할게요' : '직접 입력할게요'}
              </button>
              {manual && (
                <div className="optimizer-manual">
                  <p className="optimizer-help">현재 어빌리티 세 줄을 선택해 주세요.</p>
                  <LineEditor lines={manualLines} options={pools} onChange={setManualLines} />
                </div>
              )}
              {(manual || selectedCharacter) && startValidation && (
                <p className="optimizer-validation" role="status">
                  {startValidation}
                </p>
              )}
              <div className="optimizer-actions">
                <button
                  className="button primary"
                  disabled={!!startValidation || searchBusy}
                  onClick={() => goToStep('target')}
                >
                  다음 <ArrowRight size={16} />
                </button>
              </div>
            </div>
          )}
          {step === 'target' && (
            <div className="panel optimizer-step-panel">
              <Field label="직업별 종결 조합">
                <select
                  aria-label="최적화 직업 프리셋"
                  value={job}
                  onChange={(e) => {
                    setJob(e.target.value);
                    if (e.target.value) {
                      setTargetGrades(DEFAULT_TARGET_GRADES);
                      setTargetTypes(
                        makeAbilityPresetGoal(data, e.target.value).conditions.map(
                          (c) => c.type,
                        ) as [string, string, string],
                      );
                    }
                  }}
                >
                  <option value="">직접 선택</option>
                  {ABILITY_JOB_PRESETS.map((p) => (
                    <option key={p.job} value={p.job}>
                      {p.job} · {p.code}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="optimizer-target-lines">
                {selected.map((option, index) => (
                  <div className="field optimizer-target-field" key={index}>
                    <label htmlFor={`optimizer-target-${index}`}>
                      목표 옵션 {index + 1} {index === 0 && <GradeBadge grade="legendary" />}
                    </label>
                    <div className={`optimizer-target-choice ${index === 0 ? 'required' : ''}`}>
                      {index > 0 && (
                        <select
                          aria-label={`목표 옵션 ${index + 1} 등급`}
                          value={targetGrades[index]}
                          onChange={(e) => {
                            const grade = e.target.value as TargetGrade;
                            const nextGrades = [...targetGrades] as TargetGrades;
                            nextGrades[index] = grade;
                            setTargetGrades(nextGrades);
                            if (
                              grade !== 'none' &&
                              !goalOptions(grade).some((o) => o.type === targetTypes[index])
                            ) {
                              const nextTypes = [...targetTypes] as [string, string, string];
                              nextTypes[index] = '';
                              setTargetTypes(nextTypes);
                            }
                            setJob('');
                          }}
                        >
                          <option value="none">선택 안 함</option>
                          <option value="unique">유니크 옵션</option>
                          <option value="legendary">레전드리 옵션</option>
                        </select>
                      )}
                      <select
                        id={`optimizer-target-${index}`}
                        aria-label={`목표 옵션 ${index + 1}`}
                        value={targetGrades[index] === 'none' ? '' : targetTypes[index]}
                        disabled={targetGrades[index] === 'none'}
                        onChange={(e) => {
                          const next = [...targetTypes] as [string, string, string];
                          next[index] = e.target.value;
                          setTargetTypes(next);
                          setJob('');
                        }}
                      >
                        <option value="">
                          {targetGrades[index] === 'none'
                            ? '목표에서 제외'
                            : '옵션을 선택해 주세요'}
                        </option>
                        {targetGrades[index] !== 'none' &&
                          goalOptions(targetGrades[index]).map((o) => (
                            <option key={o.id} value={o.type}>
                              {maximum(o).label}
                            </option>
                          ))}
                      </select>
                    </div>
                    {option && (
                      <small>
                        {gradeName(targetGrades[index])} 최대치 · {maximum(option).label}
                      </small>
                    )}
                  </div>
                ))}
              </div>
              {!allTypesAcquired && (
                <p className="optimizer-help optimizer-target-help">
                  {normalOptimization
                    ? '레전드리 목표가 1개라면 일반 재설정과 미라클·블랙·카오스 서큘레이터를 비교해요. 유니크 목표는 둘째·셋째 줄에서 노려요.'
                    : '줄 순서는 무관해요. 선택 안 함은 계산에서 제외하고, 유니크 목표는 목표 수치를 충족한 레전드리도 인정해요.'}
                </p>
              )}
              {allTypesAcquired && (
                <div className="optimizer-start-status" role="status">
                  <Check size={15} />
                  <span>
                    {allValuesComplete
                      ? targets.length === 3 && allLegendary
                        ? '세 줄 모두 최대치입니다.'
                        : '선택한 목표를 이미 달성했어요.'
                      : normalOptimization
                        ? '선택한 종류·등급 확보 완료 · 일반 재설정과 서큘레이터 사용량을 비교해요.'
                        : '선택한 종류·등급 확보 완료 · 수치만 완성하는 방법도 비교해요.'}
                  </span>
                </div>
              )}
              {targetValidation && (
                <p className="optimizer-validation" role="status">
                  {targetValidation}
                </p>
              )}
              {error && (
                <p className="notice error" role="alert">
                  {error}
                </p>
              )}
              <div className="optimizer-actions">
                <button
                  className="button primary"
                  disabled={!!targetValidation}
                  onClick={() => (normalOptimization ? calculateNormal() : goToStep('prices'))}
                >
                  다음 <ArrowRight size={16} />
                </button>
              </div>
            </div>
          )}
          {step === 'prices' && (
            <div className="panel optimizer-step-panel">
              <Field label="현재 보유 명성치">
                <div className="optimizer-price">
                  <input
                    aria-label="현재 보유 명성치"
                    inputMode="numeric"
                    value={availableHonor}
                    onChange={(e) => setAvailableHonor(e.target.value.replaceAll(',', ''))}
                  />
                  <span>명성치</span>
                </div>
              </Field>
              <Field label="명예의 훈장 가격 · 명성치 5,000당">
                <div className="optimizer-price">
                  <input
                    aria-label="명예의 훈장 가격"
                    inputMode="numeric"
                    value={medalPrice}
                    onChange={(e) => setMedalPrice(e.target.value.replaceAll(',', ''))}
                  />
                  <span>메소</span>
                </div>
                {medal !== undefined && <small>{money(medal)} / 명성치 5,000</small>}
              </Field>
              <Field label="심연의 서큘레이터 가격 · 1개">
                <div className="optimizer-price">
                  <input
                    aria-label="심연의 서큘레이터 가격"
                    inputMode="numeric"
                    value={circulatorPrice}
                    onChange={(e) => setCirculatorPrice(e.target.value.replaceAll(',', ''))}
                  />
                  <span>메소</span>
                </div>
                {circulator !== undefined && <small>{money(circulator)} / 개</small>}
              </Field>
              <details className="optimizer-extra">
                <summary>추가 설정</summary>
                <Field label="고급 재설정 실행 단위">
                  <select
                    aria-label="최적화 재설정 실행 단위"
                    value={batchSize}
                    onChange={(e) => setBatchSize(Number(e.target.value) as 1 | 3)}
                  >
                    <option value={3}>3회 비교 · 3회분 모두 사용</option>
                    <option value={1}>1회씩 재설정</option>
                  </select>
                </Field>
              </details>
              <p className="optimizer-help">
                보유 명성치를 먼저 사용하고, 부족한 명성치의 구매비용을 더해 비교해요.
              </p>
              {priceValidation && (
                <p className="optimizer-validation" role="status">
                  {priceValidation}
                </p>
              )}
              {error && (
                <p className="notice error" role="alert">
                  {error}
                </p>
              )}
              <div className="optimizer-actions">
                <button
                  className="button primary"
                  disabled={!!startValidation || !!targetValidation || !!priceValidation}
                  onClick={calculate}
                >
                  <Calculator size={17} /> 계산 <ArrowRight size={16} />
                </button>
              </div>
              {!saved && (
                <p className="optimizer-help">
                  브라우저 저장을 사용할 수 없어 현재 탭에서만 설정이 유지됩니다.
                </p>
              )}
            </div>
          )}
          {step === 'calculating' && (
            <div className="optimizer-calculation" aria-busy="true">
              <div className="optimizer-walk-stage">
                {avatar && <OptimizerWalkingAvatar avatar={avatar} />}
              </div>
              <p role="status">내 어빌리티에 맞는 순서를 찾고 있어요.</p>
              <div className="optimizer-tip">
                <span>알아두면 좋은 팁</span>
                <p>{tip}</p>
              </div>
              <button className="button" onClick={cancel}>
                <Square size={14} /> 계산 취소
              </button>
            </div>
          )}
          {step === 'result' &&
            (result || normalResult || (normalOptimization && allValuesComplete)) && (
              <div className="optimizer-results" aria-busy="false">
                <section className="optimizer-target-summary" aria-label="완성할 목표">
                  <div>
                    <h3>완성할 목표</h3>
                    <span>
                      {targets.length}개 옵션 ·{' '}
                      {allLegendary ? '레전드리 최대치' : '선택한 등급 이상 · 목표 수치 충족'} ·{' '}
                      {normalOptimization && !allValuesComplete
                        ? targets.length === 1
                          ? '첫째 줄에서 획득'
                          : '레전드리 첫째 줄 · 유니크 아랫줄'
                        : '줄 순서 무관'}
                    </span>
                  </div>
                  <ul>
                    {selected.map(
                      (option, i) =>
                        option && (
                          <li key={option.id}>
                            <GradeBadge grade={targetGrades[i] as 'unique' | 'legendary'} />{' '}
                            {maximum(option).label}
                          </li>
                        ),
                    )}
                  </ul>
                </section>
                {normalOptimization ? (
                  <section className="panel optimizer-best" aria-label="추천 전략">
                    <span className="optimizer-best-tag">
                      {allValuesComplete ? <Check size={16} /> : <Calculator size={16} />}
                      {allValuesComplete ? '목표 달성' : '레전드리 목표 1개 · 일반 최적화'}
                    </span>
                    <h3>
                      {allValuesComplete
                        ? '이미 완성됐어요'
                        : '일반 재설정과 서큘레이터를 비교해 보세요'}
                    </h3>
                    <p>
                      {allValuesComplete
                        ? '선택한 목표를 이미 최대치로 달성했어요. 추가 재설정 없이 그대로 사용하면 돼요.'
                        : '레전드리 목표가 1개라면 고급 재설정 대신 일반 재설정을 사용하세요. 명성치와 미라클·블랙·카오스 서큘레이터의 예상 사용량을 각각 비교해요.'}
                    </p>
                    {allValuesComplete ? (
                      <>
                        <strong className="optimizer-total">추가 소모 없음</strong>
                        <p className="optimizer-help">명성치 0 · 서큘레이터 0개</p>
                      </>
                    ) : (
                      <>
                        <p className="optimizer-help">
                          서큘레이터는 종류별 사용 개수로 표시해요. 필요한 명성치와 아이템을 보고
                          사용할 방법을 선택하세요.
                        </p>
                        <div className="optimizer-actions">
                          <a
                            className="button primary"
                            href="#abilityNormal"
                            onClick={prepareNormalTarget}
                          >
                            일반 재설정으로 이동 <ArrowRight size={16} />
                          </a>
                        </div>
                      </>
                    )}
                  </section>
                ) : best ? (
                  <section className="panel optimizer-best" aria-label="추천 전략">
                    <span className="optimizer-best-tag">
                      {best.status === 'already' ? <Check size={16} /> : <Trophy size={16} />}
                      {best.status === 'already' ? '목표 달성' : '비교 전략 중 예상 추가비용 최저'}
                    </span>
                    <h3>{best.status === 'already' ? '이미 완성됐어요' : best.name}</h3>
                    <p>
                      {best.status === 'already'
                        ? '선택한 목표를 모두 달성했어요. 추가 재설정 없이 그대로 사용하면 돼요.'
                        : best.description}
                    </p>
                    <strong className="optimizer-total">{money(best.totalCost)}</strong>
                    <p className="optimizer-help">
                      보유 명성치 {count(honor ?? 0)}를 반영한 예상 추가비용
                    </p>
                    {best.status !== 'already' && (
                      <div className="optimizer-best-condition">
                        <LockCondition strategy={best} options={options} targets={targets} />
                        {best.policy.kind !== 'current-types' && (
                          <p className="optimizer-help">아랫줄은 둘째·셋째 줄을 말해요.</p>
                        )}
                      </div>
                    )}
                    <CostBreakdown strategy={best} circulatorPrice={circulator!} />
                    {best.status !== 'already' && <StrategySteps steps={best.steps} />}
                  </section>
                ) : (
                  <p className="notice error" role="alert">
                    현재 조건으로 달성할 수 있는 전략이 없습니다. 목표를 확인해 주세요.
                  </p>
                )}
                {normalOptimization && !allValuesComplete && normalResult && (
                  <NormalOptimizationStrategies result={normalResult} />
                )}
                {!normalOptimization && result && (
                  <>
                    <section
                      className="panel optimizer-comparison"
                      aria-labelledby="optimizer-comparison-title"
                    >
                      <div className="panel-heading">
                        <h3 id="optimizer-comparison-title">다른 방법과 비교해 보세요</h3>
                        <span>
                          {methodGroups.length}가지 방법 · {result.strategies.length}개 조건 비교
                        </span>
                      </div>
                      <p className="optimizer-help">
                        방법을 펼치면 어떤 옵션부터 잠글지에 따른 비용을 볼 수 있어요. 아랫줄은
                        둘째·셋째 줄을 말해요.
                      </p>
                      <div className="optimizer-method-list">
                        {methodGroups.map((group) => (
                          <details
                            className={`optimizer-method-group ${group.best.id === best?.id ? 'best' : ''}`}
                            key={group.method}
                            data-method={group.method}
                            data-best-strategy={group.best.id}
                          >
                            <summary className="optimizer-method-summary">
                              <span className="optimizer-method-name">
                                <span>{group.title}</span>
                                <small>{group.strategies.length}개 조건 비교</small>
                              </span>
                              <strong>
                                <small>최저 예상 추가비용</small>
                                {group.best.status === 'impossible'
                                  ? '달성 불가'
                                  : money(group.best.totalCost)}
                              </strong>
                              <ChevronDown
                                className="optimizer-method-chevron"
                                size={18}
                                aria-hidden="true"
                              />
                              <LockCondition
                                strategy={group.best}
                                options={options}
                                targets={targets}
                              />
                            </summary>
                            <div className="optimizer-strategy-list">
                              {group.strategies.map((strategy, i) => (
                                <details
                                  className={`optimizer-strategy ${strategy.id === best?.id ? 'best' : ''}`}
                                  key={strategy.id}
                                  data-strategy={strategy.id}
                                >
                                  <summary>
                                    <span className="optimizer-rank">{i + 1}</span>
                                    <LockCondition
                                      strategy={strategy}
                                      options={options}
                                      targets={targets}
                                    />
                                    <strong>
                                      {strategy.status === 'impossible'
                                        ? '달성 불가'
                                        : money(strategy.totalCost)}
                                    </strong>
                                  </summary>
                                  <div className="optimizer-strategy-detail">
                                    <p className="optimizer-help">
                                      {strategy.status === 'already'
                                        ? '선택한 목표를 모두 달성해 추가 재설정이 필요 없어요.'
                                        : strategy.description}
                                    </p>
                                    <CostBreakdown
                                      strategy={strategy}
                                      circulatorPrice={circulator!}
                                    />
                                    {strategy.status !== 'already' && (
                                      <StrategySteps steps={strategy.steps} />
                                    )}
                                  </div>
                                </details>
                              ))}
                            </div>
                          </details>
                        ))}
                      </div>
                    </section>
                    <details className="panel optimizer-notes">
                      <summary>계산 기준과 공식 자료</summary>
                      <ul>
                        <li>
                          예상 추가비용은 필요 명성치의 기댓값에서 보유분을 차감한 추정치입니다.
                          개별 도전의 추가 구매비용을 정확히 평균한 값은 아닙니다.
                        </li>
                        <li>
                          훈장 개수는 명성치 5,000 단위의 환산 수량이며 정수 구매 개수가 아닙니다.
                        </li>
                        {result.notes.map((note, i) => (
                          <li key={i}>{note}</li>
                        ))}
                      </ul>
                      <div className="optimizer-sources">
                        <a
                          href="https://maplestory.nexon.com/Guide/OtherProbability/ability/reputevalue"
                          target="_blank"
                          rel="noreferrer"
                        >
                          공식 확률표 ↗
                        </a>
                        <a
                          href="https://maplestory.nexon.com/Guide/N23GameInformation/Articles/392"
                          target="_blank"
                          rel="noreferrer"
                        >
                          공식 어빌리티 가이드 ↗
                        </a>
                      </div>
                    </details>
                  </>
                )}
              </div>
            )}
        </>
      )}
    </section>
  );
}
function NormalOptimizationStrategies({ result }: { result: NormalAbilityOptimizerResult }) {
  const honorStrategies = result.strategies.filter(
    (strategy) =>
      strategy.id.startsWith('normal-honor') &&
      strategy.status === 'ready' &&
      strategy.expectedHonor !== null &&
      Number.isFinite(strategy.expectedHonor),
  );
  const minimumHonor =
    honorStrategies.length > 1
      ? Math.min(...honorStrategies.map((strategy) => strategy.expectedHonor!))
      : undefined;
  const usage = (value: number | null, available: string) =>
    available !== 'unavailable' &&
    available !== 'impossible' &&
    value !== null &&
    Number.isFinite(value)
      ? count(value)
      : '—';
  const status = (value: NormalAbilityOptimizerResult['strategies'][number]['status']) =>
    value === 'already'
      ? '목표 달성'
      : value === 'impossible'
        ? '달성 불가'
        : value === 'unavailable'
          ? '비교 제외'
          : '사용량 기댓값';
  return (
    <>
      <section
        className="panel optimizer-normal-comparison"
        aria-labelledby="optimizer-normal-title"
      >
        <div className="panel-heading">
          <h3 id="optimizer-normal-title">방법별 예상 사용량</h3>
        </div>
        <p className="optimizer-help">
          명성치와 아이템 개수는 서로 다른 단위예요. 기댓값은 평균이며 실제 사용량은 달라질 수
          있어요.
        </p>
        <div className="optimizer-normal-table-wrap">
          <table className="optimizer-normal-table" aria-label="일반 최적화 재화별 기댓값">
            <thead>
              <tr>
                <th scope="col">방법</th>
                <th scope="col">명성치</th>
                <th scope="col">
                  미라클
                  <br />
                  서큘레이터
                </th>
                <th scope="col">
                  블랙
                  <br />
                  서큘레이터
                </th>
                <th scope="col">
                  카오스
                  <br />
                  서큘레이터
                </th>
              </tr>
            </thead>
            <tbody>
              {result.strategies.map((strategy) => (
                <tr key={strategy.id} data-normal-strategy={strategy.id}>
                  <th scope="row">
                    {strategy.name}
                    <small>{status(strategy.status)}</small>
                    {minimumHonor !== undefined &&
                      strategy.id.startsWith('normal-honor') &&
                      strategy.expectedHonor === minimumHonor && (
                        <small className="optimizer-normal-minimum">
                          비교한 명성치 전용 전략 중 최소
                        </small>
                      )}
                  </th>
                  <td>
                    {usage(strategy.expectedHonor, strategy.status)}
                    {strategy.expectedResets !== null &&
                      strategy.status !== 'unavailable' &&
                      strategy.status !== 'impossible' &&
                      Number.isFinite(strategy.expectedResets) && (
                        <small>재설정 {count(strategy.expectedResets)}회</small>
                      )}
                  </td>
                  <td>
                    {usage(strategy.expectedMiracle, strategy.status)}
                    <small>개</small>
                  </td>
                  <td>
                    {usage(strategy.expectedBlack, strategy.status)}
                    <small>개</small>
                  </td>
                  <td>
                    {usage(strategy.expectedChaos, strategy.status)}
                    <small>개</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="optimizer-normal-methods">
          {result.strategies.map((strategy) => (
            <details className="optimizer-normal-method" key={strategy.id}>
              <summary>
                <span>{strategy.name}</span>
                <span>{status(strategy.status)}</span>
              </summary>
              <p className="optimizer-help">{strategy.description}</p>
              {strategy.steps.length > 0 && <StrategySteps steps={strategy.steps} />}
              {strategy.notes.length > 0 && (
                <ul className="optimizer-help">
                  {strategy.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              )}
            </details>
          ))}
        </div>
      </section>
      <details className="panel optimizer-notes">
        <summary>계산 기준과 공식 자료</summary>
        <ul>
          {result.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
        <div className="optimizer-sources">
          <a
            href="https://maplestory.nexon.com/Guide/OtherProbability/ability/reputevalue"
            target="_blank"
            rel="noreferrer"
          >
            공식 확률표 ↗
          </a>
          <a
            href="https://maplestory.nexon.com/Guide/N23GameInformation/Articles/392"
            target="_blank"
            rel="noreferrer"
          >
            공식 어빌리티 가이드 ↗
          </a>
        </div>
      </details>
    </>
  );
}
function LockCondition({
  strategy,
  options,
  targets,
}: {
  strategy: AbilityOptimizerStrategyResult;
  options: AbilityOption[];
  targets: AbilityOptimizerTarget[];
}) {
  const condition = optimizerLockCondition(strategy, options, targets);
  return (
    <span className="optimizer-lock-condition">
      <small>{condition.label}</small>
      <span>{condition.title}</span>
      <small>{condition.detail}</small>
    </span>
  );
}
function StrategySteps({ steps }: { steps: string[] }) {
  return (
    <ol className="optimizer-steps" aria-label="진행 순서">
      {steps.map((step, i) => (
        <li key={i}>
          <span className="optimizer-step-number" aria-hidden="true">
            {i + 1}
          </span>
          <span>
            <span className="sr-only">{i + 1}단계: </span>
            {step}
          </span>
        </li>
      ))}
    </ol>
  );
}
function CostBreakdown({
  strategy,
  circulatorPrice,
}: {
  strategy: AbilityOptimizerStrategyResult;
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
        <dt>명성치 추가 구매</dt>
        <dd>
          {money(strategy.estimatedHonorPurchaseCost)}
          <small>
            필요 {count(strategy.expectedHonor)} · 부족분 {count(strategy.estimatedAdditionalHonor)}
          </small>
          <small>훈장 {count(strategy.estimatedAdditionalHonor / 5000)}개분</small>
        </dd>
      </div>
      <div>
        <dt>서큘레이터</dt>
        <dd>
          {money(
            strategy.expectedCirculators === Infinity
              ? Infinity
              : strategy.expectedCirculators * circulatorPrice,
          )}
          <small>{count(strategy.expectedCirculators)}개 사용</small>
        </dd>
      </div>
    </dl>
  );
}
