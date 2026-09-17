import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Boxes,
  Check,
  ChevronDown,
  CircleHelp,
  ExternalLink,
  Gem,
  Infinity as InfinityIcon,
  LoaderCircle,
  Moon,
  Orbit,
  Pause,
  Play,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  WandSparkles,
  X,
} from 'lucide-react';
import type {
  BenchmarkResult,
  CharacterSnapshot,
  CubeType,
  EquipmentSnapshot,
  Grade,
  SimulationConfig,
  SimulationState,
  SimulatorMode,
  WorkerResponse,
} from './types';
import { getCharacter, loadDefaultCharacter } from './character';
import { getSharedCharacter, resolveSharedApiBase } from './character/shared';
import {
  ABILITY_JOB_PRESETS,
  makeAbilityPresetGoal,
  resolveAbilityPreset,
} from './character/ability-presets';
import {
  abilityProgress,
  abilityStrategyErrors,
  usesLowerFirstAbility,
} from './engine/ability-strategy';
import {
  createState,
  effectiveBatchSize,
  evaluateLuck,
  getLineOptions,
  loadRuleData,
  rollBatch,
  validateConfig,
} from './engine';
import type { RuleData } from './engine/rules';
import {
  Avatar,
  DistributionChart,
  Field,
  GoalEditor,
  GradeBadge,
  LineEditor,
  OptionLines,
  ReactionStage,
  Sources,
} from './ui/components';
import {
  CATEGORIES,
  CUBES,
  getModeFromHash,
  GRADE_NAMES,
  GRADES,
  isItemCube,
  isPrime,
  METRIC_LABELS,
  MODES,
  RULE_VERSION,
} from './ui/constants';
import { formatAmount, formatPercent, safePrice } from './ui/format';
import { archiveSession, readSession, saveSession } from './ui/storage';
import { lowerFirstGoal, makeConfig, reconcileLines, resizeAbilityGoal } from './ui/setup';
import { boundAbilityCondition, clampConditionValue } from './ui/ability-bounds';
import { getPotentialConditionBounds } from './ui/potential-bounds';
import { FakeAdBanner } from './ui/FakeAdBanner';
import { getLinkedCharacter, replaceCharacterLink } from './ui/character-link';

const baseUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href;
const forMode = (items: EquipmentSnapshot[], mode: SimulatorMode) =>
  mode === 'soulAmplification' || mode === 'soulPotential'
    ? items.filter((item) => item.eligibleSoul)
    : items;
const tabIcons = { cube: Boxes, ability: Sparkles, soulAmplification: Orbit, soulPotential: Gem };
const workerFactory = () =>
  new Worker(new URL('./workers/simulator.worker.ts', import.meta.url), { type: 'module' });

export default function App() {
  const [data, setData] = useState<RuleData>();
  const [character, setCharacter] = useState<CharacterSnapshot>();
  const [config, setConfig] = useState<SimulationConfig>();
  const [state, setState] = useState<SimulationState>();
  const [equipmentPreset, setEquipmentPreset] = useState('1');
  const [abilityPreset, setAbilityPreset] = useState('1');
  const [equipmentId, setEquipmentId] = useState('');
  const [benchmark, setBenchmark] = useState<BenchmarkResult>();
  const [bootError, setBootError] = useState('');
  const [message, setMessage] = useState('');
  const [auto, setAuto] = useState(false);
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [sharedApiBase, setSharedApiBase] = useState<string>();
  const [searchReady, setSearchReady] = useState(false);
  const [personalSearch, setPersonalSearch] = useState(false);
  const sharedSearch = !!sharedApiBase && !personalSearch;
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('isekai:theme') ?? 'dark';
    } catch {
      return 'dark';
    }
  });
  const [saved, setSaved] = useState(true);
  const benchWorker = useRef<Worker | null>(null);
  const runWorker = useRef<Worker | null>(null);
  const benchId = useRef('');
  const runId = useRef('');
  const searchAbort = useRef<AbortController | null>(null);
  const backdropPress = useRef(false);
  const latest = useRef({ config, state });
  latest.current = { config, state };
  const sessionRef = useRef<Parameters<typeof saveSession>[0] | null>(null);
  if (character && config && state)
    sessionRef.current = {
      version: 1,
      character,
      config,
      state,
      equipmentPreset,
      abilityPreset,
      equipmentId,
      playMode: 'upgrade',
    };
  useEffect(() => {
    const flush = () => {
      if (sessionRef.current) saveSession(sessionRef.current);
    };
    addEventListener('pagehide', flush);
    return () => removeEventListener('pagehide', flush);
  }, []);
  const equipment = useMemo(
    () => character?.equipmentPresets[equipmentPreset] ?? [],
    [character, equipmentPreset],
  );
  const item = equipment.find((x) => x.id === equipmentId);
  const isSoul = config?.mode === 'soulAmplification' || config?.mode === 'soulPotential';
  const itemOptions = equipment.filter((x) =>
    isSoul
      ? x.eligibleSoul
      : x.category !== 'unsupported' && (x.potentialGrade || x.additionalGrade),
  );
  const errors = useMemo(() => {
    if (!data || !config) return [];
    try {
      return validateConfig(data, config);
    } catch (e) {
      return [e instanceof Error ? e.message : '설정을 확인해 주세요.'];
    }
  }, [data, config]);
  const editorOptions = useMemo(
    () =>
      [0, 1, 2].map((slot) => {
        if (!data || !config || config.mode === 'soulAmplification') return [];
        try {
          return getLineOptions(data, config, slot);
        } catch {
          return [];
        }
      }),
    [data, config],
  );
  const targetOptions = useMemo(() => {
    if (!data || !config || config.mode === 'soulAmplification') return [];
    const map = new Map<string, ReturnType<typeof getLineOptions>[number]>();
    for (const grade of GRADES)
      for (let slot = 0; slot < 3; slot++) {
        try {
          for (const option of getLineOptions(
            data,
            { ...config, start: { ...config.start, grade } },
            slot,
          ))
            map.set(`${option.grade}:${option.id}`, option);
        } catch {
          /* Unsupported pools remain unavailable. */
        }
      }
    return [...map.values()];
  }, [data, config?.mode, config?.cubeType, config?.category, config?.level, config?.start.stage]);
  const conditionBounds = useMemo(
    () =>
      data && config
        ? config.target.conditions.map((condition) =>
            getPotentialConditionBounds(data, config, condition),
          )
        : [],
    [data, config],
  );
  const canRun =
    !!data &&
    !!config &&
    !!state &&
    !errors.length &&
    state.status !== 'success' &&
    state.status !== 'impossible' &&
    benchmark?.status !== 'impossible' &&
    benchmark?.status !== 'already';
  const automaticAbilityTarget =
    config?.mode === 'ability' &&
    !usesLowerFirstAbility(config) &&
    usesLowerFirstAbility({ ...config, abilityStrategy: 'lowerFirst' }) &&
    !abilityStrategyErrors({ ...config, abilityStrategy: 'lowerFirst', lockedSlots: [] }).length
      ? config.target
      : undefined;
  const requiredAbilityLower = config ? abilityProgress(config, []).requiredLower : 0;
  const canAutoRun =
    canRun ||
    (!!data &&
      !!config &&
      !!state &&
      state.status !== 'success' &&
      !errors.length &&
      !!automaticAbilityTarget);
  const canRestartAuto =
    !!data && !!config && !errors.length && state?.status === 'success' && state.attempts > 0n;
  const itemBased = config?.mode === 'cube' && isItemCube(config.cubeType);
  const actualCost = state ? Number(itemBased ? state.spent.cubes : state.spent.meso) : 0;
  const reaction =
    state?.status === 'success' && state.attempts > 0n && benchmark?.cdfAtActual !== undefined
      ? evaluateLuck(benchmark, actualCost)
      : undefined;
  const modeInfo = MODES.find((x) => x.id === config?.mode) ?? MODES[1];
  const selectedCube = CUBES.find((x) => x.id === config?.cubeType) ?? CUBES[0];
  const displayName =
    config?.mode === 'cube'
      ? selectedCube.name
      : config?.mode === 'ability'
        ? '고급 어빌리티'
        : config?.mode === 'soulAmplification'
          ? '소울 증폭'
          : '소울 잠재';

  useEffect(() => {
    if (!searchOpen) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = oldOverflow;
      document.querySelector<HTMLButtonElement>('.character-card')?.focus();
    };
  }, [searchOpen]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('isekai:theme', theme);
    } catch {
      /* Theme works without storage. */
    }
  }, [theme]);
  const stop = useCallback(() => {
    if (runWorker.current) {
      runWorker.current.postMessage({ type: 'stop', id: runId.current });
    }
    setAuto(false);
    setState((x) => (x && x.status === 'running' ? { ...x, status: 'paused' } : x));
  }, []);
  const begin = useCallback(
    (draft: SimulationConfig, ruleData: RuleData = data!, preserve = true) => {
      runWorker.current?.terminate();
      runWorker.current = null;
      runId.current = '';
      setAuto(false);
      setMessage('');
      if (preserve && latest.current.config && latest.current.state)
        archiveSession(latest.current.config, latest.current.state);
      try {
        const next = createState(ruleData, draft);
        const frozen = {
          ...draft,
          start: {
            grade: next.grade,
            lines: next.lines,
            stage: next.stage,
            failures: next.failures,
          },
        };
        setConfig(frozen);
        setState(next);
        setBenchmark(undefined);
        return { config: frozen, state: next };
      } catch (e) {
        setConfig(draft);
        setState(undefined);
        setBenchmark(undefined);
        setMessage(e instanceof Error ? e.message : '시작 설정을 확인해 주세요.');
      }
    },
    [data],
  );

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    const apiBasePromise = resolveSharedApiBase({
      pageBase: baseUrl,
      configuredUrl: import.meta.env.VITE_CHARACTER_API_URL,
      development: import.meta.env.DEV,
      signal: controller.signal,
    }).catch(() => undefined);
    void apiBasePromise.then((url) => {
      if (disposed) return;
      setSharedApiBase(url);
      setSearchReady(true);
    });
    Promise.all([loadRuleData(baseUrl), loadDefaultCharacter(import.meta.env.BASE_URL)])
      .then(async ([rules, defaultCharacter]) => {
        if (disposed) return;
        setData(rules);
        const savedSession = readSession();
        const stored = savedSession?.config.ruleVersion === RULE_VERSION ? savedSession : null;
        const linkedName = getLinkedCharacter();
        let linkError = '';
        if (linkedName && stored?.character.name !== linkedName) {
          setName(linkedName);
          try {
            const apiBase = await apiBasePromise;
            if (disposed) return;
            if (!apiBase)
              throw new Error('주소의 캐릭터를 불러오려면 개인 API 키를 입력해 주세요.');
            const next = await getSharedCharacter(linkedName, apiBase, controller.signal);
            if (disposed) return;
            if (stored) archiveSession(stored.config, stored.state);
            adoptCharacter(next, rules, getModeFromHash(), 'black', false);
            setMessage(`${next.name}의 최신 장비와 어빌리티를 불러왔어요.`);
            return;
          } catch (error) {
            if (disposed) return;
            linkError = error instanceof Error ? error.message : '캐릭터를 불러오지 못했습니다.';
          }
        }
        if (stored) {
          setCharacter(stored.character);
          setEquipmentPreset(stored.equipmentPreset);
          setAbilityPreset(stored.abilityPreset);
          setEquipmentId(stored.equipmentId);
          if (stored.playMode === 'recreate') archiveSession(stored.config, stored.state);
          const requested = linkError ? stored.config.mode : getModeFromHash();
          if (location.hash && requested !== stored.config.mode) {
            if (stored.playMode !== 'recreate') archiveSession(stored.config, stored.state);
            const items = stored.character.equipmentPresets[stored.equipmentPreset] ?? [];
            const selected =
              requested === 'soulAmplification' || requested === 'soulPotential'
                ? items.find((x) => x.eligibleSoul)
                : items.find((x) => x.id === stored.equipmentId);
            setEquipmentId(selected?.id ?? '');
            begin(
              makeConfig(
                rules,
                stored.character,
                selected,
                requested,
                stored.config.cubeType,
                stored.abilityPreset,
              ),
              rules,
              false,
            );
          } else if (stored.playMode === 'recreate') {
            const items = forMode(
              stored.character.equipmentPresets[stored.equipmentPreset] ?? [],
              stored.config.mode,
            );
            const selected =
              items.find((x) => x.id === stored.equipmentId) ??
              items.find((x) => x.category === 'weapon') ??
              items[0];
            setEquipmentId(selected?.id ?? '');
            const draft = makeConfig(
              rules,
              stored.character,
              selected,
              stored.config.mode,
              stored.config.cubeType,
              stored.abilityPreset,
            );
            begin(
              {
                ...draft,
                target: stored.config.mode === 'ability' ? draft.target : stored.config.target,
                batchSize: stored.config.batchSize,
                unitPrices: stored.config.unitPrices,
              },
              rules,
              false,
            );
            setMessage(
              stored.config.mode === 'ability'
                ? '어빌리티는 현재 옵션에서 업그레이드합니다. 불러온 어빌리티와 내 직업 목표로 새 도전을 시작했어요.'
                : '현재 장비에서 업그레이드하도록 변경되었습니다. 이전 기록을 보관하고 불러온 장비의 옵션과 단계에서 새 도전을 시작했어요.',
            );
          } else if (
            stored.config.mode === 'ability' &&
            !stored.config.abilityStrategy &&
            lowerFirstGoal(stored.config.target)
          ) {
            archiveSession(stored.config, stored.state);
            begin(
              {
                ...stored.config,
                abilityStrategy: 'lowerFirst',
                batchSize: 3,
                lockedSlots: [],
                target: lowerFirstGoal(stored.config.target)!,
                start: {
                  grade: stored.state.grade,
                  lines: stored.state.lines,
                  stage: stored.state.stage,
                  failures: stored.state.failures,
                },
              },
              rules,
              false,
            );
            setMessage(
              '아랫줄 우선 방식으로 변경되었습니다. 기존 보관 옵션에서 새 도전을 시작합니다.',
            );
          } else {
            setConfig(stored.config);
            setState({
              ...stored.state,
              status: stored.state.status === 'running' ? 'paused' : stored.state.status,
            });
            history.replaceState(null, '', `#${stored.config.mode}`);
          }
        } else {
          setCharacter(defaultCharacter);
          setEquipmentPreset(defaultCharacter.activeEquipmentPreset);
          setAbilityPreset(defaultCharacter.activeAbilityPreset);
          const items = defaultCharacter.equipmentPresets[defaultCharacter.activeEquipmentPreset];
          const available = forMode(items, getModeFromHash());
          const first = available.find((x) => x.category === 'weapon') ?? available[0];
          setEquipmentId(first?.id ?? '');
          begin(
            makeConfig(
              rules,
              defaultCharacter,
              first,
              getModeFromHash(),
              'black',
              defaultCharacter.activeAbilityPreset,
            ),
            rules,
            false,
          );
        }
        if (linkError) {
          setName(linkedName);
          setSearchError(linkError);
          setSearchOpen(true);
        }
      })
      .catch((e) => {
        if (!disposed) setBootError(e.message);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!config || !data) return;
    benchWorker.current?.terminate();
    benchWorker.current = null;
    setBenchmark(undefined);
    if (errors.length) {
      setBenchmarkBusy(false);
      return;
    }
    setBenchmarkBusy(true);
    const timeout = setTimeout(() => {
      const worker = workerFactory();
      benchWorker.current = worker;
      const id = crypto.randomUUID();
      benchId.current = id;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;
        if (response.id !== benchId.current) return;
        if (response.type === 'benchmark') {
          setBenchmark(response.result);
          setBenchmarkBusy(false);
        } else if (response.type === 'error') {
          setBenchmarkBusy(false);
          setMessage(response.message);
        }
      };
      worker.onerror = () => {
        setBenchmarkBusy(false);
        setMessage('분포 계산을 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요.');
      };
      const current = latest.current.state;
      worker.postMessage({
        type: 'benchmark',
        id,
        config,
        baseUrl,
        ...(current?.status === 'success' && current.attempts > 0n
          ? {
              actualCost: Number(
                config.mode === 'cube' && isItemCube(config.cubeType)
                  ? current.spent.cubes
                  : current.spent.meso,
              ),
            }
          : {}),
      });
    }, 250);
    return () => {
      clearTimeout(timeout);
      benchWorker.current?.terminate();
      benchWorker.current = null;
    };
  }, [config, data, errors.length]);

  useEffect(() => {
    if (
      !config ||
      !state ||
      state.status !== 'success' ||
      state.attempts === 0n ||
      !benchWorker.current
    )
      return;
    const id = crypto.randomUUID();
    benchId.current = id;
    setBenchmarkBusy(true);
    benchWorker.current.postMessage({ type: 'benchmark', id, config, baseUrl, actualCost });
  }, [state?.status, state?.attempts, actualCost]);
  useEffect(() => {
    if (!character || !config || !state) return;
    const handle = setTimeout(
      () =>
        setSaved(
          saveSession({
            version: 1,
            character,
            config,
            state,
            equipmentPreset,
            abilityPreset,
            equipmentId,
            playMode: 'upgrade',
          }),
        ),
      300,
    );
    return () => clearTimeout(handle);
  }, [character, config, state, equipmentPreset, abilityPreset, equipmentId]);
  useEffect(
    () => () => {
      benchWorker.current?.terminate();
      runWorker.current?.terminate();
      searchAbort.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!data || !character || !config) return;
    const listener = () => {
      const mode = getModeFromHash();
      if (mode !== latest.current.config?.mode) switchMode(mode);
    };
    addEventListener('hashchange', listener);
    return () => removeEventListener('hashchange', listener);
  }, [data, character, config, equipmentId, equipmentPreset]);

  function patchConfig(patch: Partial<SimulationConfig>, resetLines = false) {
    if (!config || !data) return;
    if (Object.keys(patch).length === 1 && patch.unitPrices) {
      setConfig({ ...config, unitPrices: patch.unitPrices });
      return;
    }
    const currentStart =
      state && (patch.target || patch.lockedSlots || patch.batchSize || patch.abilityStrategy)
        ? { grade: state.grade, lines: state.lines, stage: state.stage, failures: state.failures }
        : config.start;
    const draft = { ...config, start: currentStart, ...patch };
    if (patch.target && !('abilityPresetJob' in patch)) draft.abilityPresetJob = undefined;
    let strategyNotice = '';
    if (
      draft.abilityStrategy === 'lowerFirst' &&
      (!usesLowerFirstAbility(draft) || abilityStrategyErrors(draft).length)
    ) {
      draft.abilityStrategy = 'fixed';
      draft.lockedSlots = state?.lockedSlots ?? config.lockedSlots;
      strategyNotice =
        '변경한 목표는 수동 잠금 방식으로 진행합니다. 아랫줄 우선 방식은 첫 줄 목표 하나와 보조 줄 목표 한두 개가 필요합니다.';
    }
    if (resetLines) draft.start = { ...draft.start, lines: [], failures: 0 };
    if ((draft.mode === 'cube' || draft.mode === 'soulPotential') && draft.target.mode === 'sum') {
      draft.target = {
        ...draft.target,
        conditions: draft.target.conditions.map((condition) => {
          const bounds = getPotentialConditionBounds(data, draft, condition);
          if (!bounds) return condition;
          const value = clampConditionValue(condition.maxValue ?? condition.minValue, bounds);
          return condition.maxValue === undefined
            ? { ...condition, minValue: value }
            : { ...condition, maxValue: value };
        }),
      };
    }
    begin(draft);
    if (strategyNotice) setMessage(strategyNotice);
  }
  function chooseAbilityJob(job: string) {
    if (!data || !config) return;
    const preset = resolveAbilityPreset(job);
    if (!preset) return;
    const target = makeAbilityPresetGoal(data, preset.job, 'minimum');
    if (lowerFirstGoal(config.target) && config.target.conditions.length === 2)
      target.conditions = target.conditions.slice(0, 2);
    patchConfig({
      target,
      abilityPresetJob: preset.job,
      abilityStrategy: 'lowerFirst',
      lockedSlots: [],
    });
  }
  function chooseAbilityGoalCount(count: 2 | 3) {
    if (!data || !config || !character) return;
    const preset = resolveAbilityPreset(config.abilityPresetJob ?? character.job);
    const alternatives = [
      ...(preset ? makeAbilityPresetGoal(data, preset.job, 'minimum').conditions : []),
      ...targetOptions
        .filter((option) => option.grade === 'legendary')
        .map((option) =>
          boundAbilityCondition(
            targetOptions,
            { type: option.type, minValue: option.value, minGrade: 'legendary', slots: [1, 2] },
            true,
          ),
        ),
    ];
    const target = resizeAbilityGoal(config.target, count, alternatives);
    if (target)
      patchConfig({
        target,
        abilityPresetJob: config.abilityPresetJob,
        abilityStrategy: 'lowerFirst',
        lockedSlots: [],
      });
  }
  function toggleAbilityLock(slot: number) {
    if (!config || !state || config.mode !== 'ability' || auto) return;
    const currentLocks = usesLowerFirstAbility(config)
      ? (state.lockedSlots ?? abilityProgress(config, state.lines).lockedSlots)
      : config.lockedSlots;
    const locks = currentLocks.includes(slot)
      ? currentLocks.filter((value) => value !== slot)
      : [...currentLocks, slot].sort((a, b) => a - b);
    if (locks.length > 2) {
      setMessage('어빌리티는 최대 두 줄까지 고정할 수 있어요.');
      return;
    }
    patchConfig({ abilityStrategy: 'fixed', lockedSlots: locks });
  }
  function switchMode(mode: SimulatorMode) {
    if (!data || !character || !config) return;
    let nextItem = item;
    if ((mode === 'soulPotential' || mode === 'soulAmplification') && !nextItem?.eligibleSoul) {
      nextItem = equipment.find((x) => x.eligibleSoul);
      setEquipmentId(nextItem?.id ?? '');
    }
    history.replaceState(null, '', `#${mode}`);
    begin(makeConfig(data, character, nextItem, mode, config.cubeType, abilityPreset));
  }
  function chooseItem(id: string) {
    if (!data || !character || !config) return;
    setEquipmentId(id);
    begin(
      makeConfig(
        data,
        character,
        equipment.find((x) => x.id === id),
        config.mode,
        config.cubeType,
        abilityPreset,
      ),
    );
  }
  function choosePreset(value: string) {
    if (!data || !character || !config) return;
    setEquipmentPreset(value);
    const next = forMode(character.equipmentPresets[value] ?? [], config.mode);
    const selected =
      next.find((x) => x.slot === item?.slot) ??
      next.find((x) => x.category === 'weapon') ??
      next[0];
    setEquipmentId(selected?.id ?? '');
    begin(makeConfig(data, character, selected, config.mode, config.cubeType, abilityPreset));
  }
  function chooseCube(cubeType: CubeType) {
    if (!data || !character || !config) return;
    begin(makeConfig(data, character, item, 'cube', cubeType, abilityPreset));
  }
  function openSearch() {
    setName('');
    setSearchError('');
    backdropPress.current = false;
    setSearchOpen(true);
  }
  function closeSearch() {
    searchAbort.current?.abort();
    setSearchBusy(false);
    backdropPress.current = false;
    setSearchOpen(false);
  }
  function adoptCharacter(
    next: CharacterSnapshot,
    rules: RuleData,
    mode: SimulatorMode,
    cubeType: CubeType,
    preserve = true,
  ) {
    setCharacter(next);
    setEquipmentPreset(next.activeEquipmentPreset);
    setAbilityPreset(next.activeAbilityPreset);
    const nextItems = forMode(next.equipmentPresets[next.activeEquipmentPreset], mode);
    const selected = nextItems.find((x) => x.category === 'weapon') ?? nextItems[0];
    setEquipmentId(selected?.id ?? '');
    begin(
      makeConfig(rules, next, selected, mode, cubeType, next.activeAbilityPreset),
      rules,
      preserve,
    );
    replaceCharacterLink(next.name, mode);
  }
  async function searchCharacter(event: React.FormEvent) {
    event.preventDefault();
    if (!searchReady || !name.trim() || (!sharedSearch && !apiKey.trim())) return;
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearchBusy(true);
    setSearchError('');
    try {
      const next = sharedSearch
        ? await getSharedCharacter(name.trim(), sharedApiBase!, controller.signal)
        : await getCharacter(name.trim(), apiKey.trim(), controller.signal);
      if (controller.signal.aborted) return;
      adoptCharacter(next, data!, config!.mode, config!.cubeType);
      setSearchOpen(false);
      setMessage(`${next.name}의 최신 장비와 어빌리티를 불러왔어요.`);
    } catch (e) {
      if (!controller.signal.aborted)
        setSearchError(e instanceof Error ? e.message : '캐릭터를 불러오지 못했습니다.');
    } finally {
      if (!controller.signal.aborted) setSearchBusy(false);
    }
  }
  function oneRoll() {
    if (!canRun || !config || !state || !data) return;
    try {
      setMessage('');
      setState(rollBatch(data, config, state));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '재설정에 실패했습니다.');
    }
  }
  function startAuto() {
    if ((!canAutoRun && !canRestartAuto) || !config || !state) return;
    setMessage('');
    let runConfig = config;
    let runState = state;
    if (canRestartAuto || automaticAbilityTarget) {
      const prepared = begin({
        ...config,
        start: canRestartAuto
          ? config.start
          : {
              grade: state.grade,
              lines: state.lines,
              stage: state.stage,
              failures: state.failures,
            },
        ...(automaticAbilityTarget
          ? {
              target: automaticAbilityTarget,
              abilityStrategy: 'lowerFirst' as const,
              lockedSlots: [],
            }
          : {}),
      });
      if (!prepared) return;
      runConfig = prepared.config;
      runState = prepared.state;
      if (runState.status === 'success' || runState.status === 'impossible') return;
      if (automaticAbilityTarget && !canRestartAuto)
        setMessage('목표에 맞게 잠금을 다시 설정했어요. 현재 옵션에서 자동 도전을 시작합니다.');
    }
    setAuto(true);
    runWorker.current?.terminate();
    const worker = workerFactory();
    runWorker.current = worker;
    const id = crypto.randomUUID();
    runId.current = id;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.id !== runId.current) return;
      if (response.type === 'state') {
        setState(response.state);
        if (response.done) {
          setAuto(false);
          if (response.state.status !== 'success' && response.state.status !== 'impossible')
            setMessage('자동 실행을 중지했어요. 이어서 도전할 수 있습니다.');
        }
      } else if (response.type === 'error') {
        setAuto(false);
        setMessage(response.message);
      }
    };
    worker.onerror = () => {
      setAuto(false);
      setMessage('자동 실행 중 오류가 발생했습니다. 현재 기록은 보관되어 있어요.');
    };
    setState({ ...runState, status: 'running' });
    worker.postMessage({ type: 'run', id, config: runConfig, state: runState, baseUrl });
  }

  if (bootError)
    return (
      <div className="boot-screen">
        <div className="brand-mark">
          <InfinityIcon />
        </div>
        <h1>다른 세계로 가는 문이 잠시 닫혔어요.</h1>
        <p>{bootError}</p>
        <button className="button primary" onClick={() => location.reload()}>
          다시 불러오기
        </button>
      </div>
    );
  if (!data || !character || !config)
    return (
      <div className="boot-screen">
        <div className="brand-mark">
          <InfinityIcon />
        </div>
        <LoaderCircle className="spin" />
        <h1>또 다른 세계를 준비하고 있어요.</h1>
        <p>
          {name ? `${name}의 캐릭터 정보를 불러옵니다.` : '공식 확률과 깽미니의 장비를 불러옵니다.'}
        </p>
      </div>
    );
  const modeIcon = tabIcons[config.mode];
  const effectiveItem = equipment.find((x) => x.id === equipmentId);
  const importedLines =
    config.mode === 'ability'
      ? (character.abilityPresets[abilityPreset]?.lines ?? [])
      : config.mode === 'soulPotential'
        ? (item?.soul?.lines ?? [])
        : config.cubeType === 'additional' || config.cubeType === 'primeAdditional'
          ? (item?.additional ?? [])
          : (item?.potential ?? []);
  const marketValue = state
    ? (config.mode === 'cube' && isItemCube(config.cubeType)
        ? state.spent.cubes * safePrice(config.unitPrices[config.cubeType])
        : 0n) +
      state.spent.ethers.reduce(
        (n, x, i) => n + x * safePrice(config.unitPrices[`ether${i + 1}`]),
        0n,
      )
    : 0n;

  return (
    <div className="app-shell">
      <header className="site-header">
        <a
          className="brand"
          href="#cube"
          onClick={(e) => {
            e.preventDefault();
            switchMode('cube');
          }}
        >
          <span className="brand-mark">
            <InfinityIcon size={23} />
          </span>
          <span>
            이세계 직작<small>ANOTHER WORLD SIMULATOR</small>
          </span>
        </a>
        <div className="header-actions">
          <span className="version-pill">
            <span /> KMS 2026.09.17
          </span>
          <button
            className="icon-button theme-button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? '밝은 테마' : '어두운 테마'}
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <a
            className="header-link"
            href="https://maplestory.nexon.com/Guide/OtherProbability/ability/reputevalue"
            target="_blank"
            rel="noreferrer"
          >
            공식 확률표 <ArrowUpRight size={14} />
          </a>
        </div>
      </header>
      <main>
        <h1 className="sr-only">이세계 직작 시뮬레이터</h1>
        <section className="hero">
          <FakeAdBanner />
          <button className="character-card" onClick={openSearch} aria-label="캐릭터 검색 열기">
            <div className="portrait-frame">
              <Avatar character={character} />
            </div>
            <div>
              <span className="small-label">함께 도전할 캐릭터</span>
              <strong>
                {character.name} <Search size={14} />
              </strong>
              <small>
                {character.world} · Lv.{character.level} {character.job}
              </small>
            </div>
            <ArrowRight size={17} />
          </button>
        </section>
        <nav className="sim-tabs" aria-label="시뮬레이터">
          {MODES.map((tab) => {
            const Icon = tabIcons[tab.id];
            return (
              <button
                key={tab.id}
                className={config.mode === tab.id ? 'active' : ''}
                aria-current={config.mode === tab.id ? 'page' : undefined}
                onClick={() => switchMode(tab.id)}
              >
                <Icon size={19} />
                <span>{tab.name}</span>
                {config.mode === tab.id && <span className="tab-active-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="workspace">
          <aside className="setup-column">
            <section className="panel settings-panel">
              <div className="panel-heading">
                <h2>
                  <Settings2 size={17} /> 도전 설정
                </h2>
                <span className="panel-step">01</span>
              </div>
              <div className="mode-fixed">
                <span>
                  <ArrowUpRight size={16} /> 지금부터 업그레이드
                </span>
                <small>
                  {config.mode === 'ability'
                    ? '불러온 현재 어빌리티에서 목표 옵션을 완성합니다.'
                    : config.mode === 'soulAmplification'
                      ? '불러온 현재 소울 증폭 단계에서 목표 단계에 도전합니다.'
                      : '불러온 현재 장비 옵션에서 목표 옵션을 완성합니다.'}
                </small>
              </div>
              {config.mode !== 'ability' ? (
                <>
                  <div className="field-row equipment-fields">
                    <Field label="장비 프리셋">
                      <select
                        aria-label="장비 프리셋"
                        value={equipmentPreset}
                        onChange={(e) => choosePreset(e.target.value)}
                      >
                        {['1', '2', '3'].map((x) => (
                          <option key={x} value={x}>
                            프리셋 {x}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="장비 선택">
                      <select
                        aria-label="장비 선택"
                        value={equipmentId}
                        onChange={(e) => chooseItem(e.target.value)}
                      >
                        <option value="">직접 설정</option>
                        {itemOptions.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.slot} · {x.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  {effectiveItem && (
                    <div className="selected-item">
                      <img
                        src={effectiveItem.imageUrl}
                        alt=""
                        onError={(e) => {
                          e.currentTarget.style.visibility = 'hidden';
                        }}
                      />
                      <div>
                        <strong>{effectiveItem.name}</strong>
                        <span>
                          Lv.{effectiveItem.level} · {effectiveItem.slot}
                        </span>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <Field label="어빌리티 프리셋">
                  <select
                    aria-label="어빌리티 프리셋"
                    value={abilityPreset}
                    onChange={(e) => {
                      setAbilityPreset(e.target.value);
                      begin(
                        makeConfig(
                          data,
                          character,
                          item,
                          config.mode,
                          config.cubeType,
                          e.target.value,
                        ),
                      );
                    }}
                  >
                    {['1', '2', '3'].map((x) => (
                      <option key={x} value={x}>
                        프리셋 {x}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {config.mode === 'cube' && (
                <>
                  <div className="field-label">재설정 종류</div>
                  <div className="cube-picker">
                    {CUBES.map((cube) => (
                      <button
                        key={cube.id}
                        className={cube.id === config.cubeType ? 'selected' : ''}
                        onClick={() => chooseCube(cube.id)}
                      >
                        <span
                          className="cube-icon"
                          style={{ '--cube-color': cube.color } as React.CSSProperties}
                        >
                          <Boxes size={20} />
                        </span>
                        <span>
                          {cube.name}
                          <small>{cube.short}</small>
                        </span>
                        {cube.id === config.cubeType && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                  <p className="inline-note">
                    <CircleHelp size={13} />
                    {selectedCube.description}
                  </p>
                </>
              )}
              {config.mode === 'cube' && (
                <div className="field-row">
                  <Field label="장비 부위">
                    <select
                      aria-label="장비 부위"
                      value={config.category}
                      onChange={(e) => {
                        setEquipmentId('');
                        patchConfig({ category: e.target.value }, true);
                      }}
                    >
                      {CATEGORIES.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="장비 레벨">
                    <input
                      aria-label="장비 레벨"
                      type="number"
                      min="1"
                      max="250"
                      value={config.level}
                      onChange={(e) => {
                        setEquipmentId('');
                        patchConfig({ level: Number(e.target.value) }, true);
                      }}
                    />
                  </Field>
                </div>
              )}
              {config.mode === 'soulAmplification' ? (
                <>
                  <div className="field-row">
                    <Field label="시작 증폭">
                      <select
                        aria-label="시작 증폭"
                        value={config.start.stage}
                        onChange={(e) =>
                          patchConfig({
                            start: { ...config.start, stage: Number(e.target.value), failures: 0 },
                          })
                        }
                      >
                        {[0, 1, 2, 3, 4].map((x) => (
                          <option value={x} key={x}>
                            {x}단계
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="누적 실패">
                      <input
                        aria-label="누적 실패"
                        type="number"
                        min="0"
                        max="50"
                        value={config.start.failures}
                        onChange={(e) =>
                          patchConfig({
                            start: { ...config.start, failures: Number(e.target.value) },
                          })
                        }
                      />
                    </Field>
                  </div>
                  <p className="inline-note">
                    200레벨 이상, 위대한 소울이 있는 영구 무기 기준입니다. 단계마다 에테르 1개와
                    메소를 사용합니다.
                  </p>
                </>
              ) : (
                <>
                  <div className="field-row">
                    <Field label="시작 등급">
                      <select
                        aria-label="시작 등급"
                        value={config.start.grade}
                        disabled={
                          config.mode === 'ability' ||
                          (config.mode === 'cube' && isPrime(config.cubeType))
                        }
                        onChange={(e) =>
                          patchConfig({
                            start: {
                              ...config.start,
                              grade: e.target.value as Grade,
                              lines: [],
                              failures: 0,
                            },
                          })
                        }
                      >
                        {GRADES.map((x) => (
                          <option value={x} key={x}>
                            {GRADE_NAMES[x]}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {config.mode === 'soulPotential' ? (
                      <Field label="증폭 단계">
                        <select
                          value={config.start.stage}
                          onChange={(e) =>
                            patchConfig({
                              start: { ...config.start, stage: Number(e.target.value), lines: [] },
                            })
                          }
                        >
                          {[1, 2, 3, 4].map((x) => (
                            <option value={x} key={x}>
                              {x}단계
                            </option>
                          ))}
                        </select>
                      </Field>
                    ) : config.mode !== 'ability' ? (
                      <Field label="등급 상승 누적 실패">
                        <input
                          aria-label="등급 상승 누적 실패"
                          type="number"
                          min="0"
                          value={config.start.failures}
                          disabled={
                            config.start.grade === 'legendary' || config.cubeType === 'gold'
                          }
                          onChange={(e) =>
                            patchConfig({
                              start: { ...config.start, failures: Number(e.target.value) },
                            })
                          }
                        />
                      </Field>
                    ) : (
                      <div className="ability-lock-count">
                        <span>고정 옵션</span>
                        <strong>
                          {usesLowerFirstAbility(config) && state
                            ? (
                                state.lockedSlots ??
                                abilityProgress(config, state.lines).lockedSlots
                              ).length
                            : config.lockedSlots.length}
                          <small> / 2줄</small>
                        </strong>
                      </div>
                    )}
                  </div>
                  {config.mode === 'soulPotential' && (
                    <Field label="등급 상승 누적 실패">
                      <input
                        aria-label="등급 상승 누적 실패"
                        type="number"
                        min="0"
                        value={config.start.failures}
                        onChange={(e) =>
                          patchConfig({
                            start: { ...config.start, failures: Number(e.target.value) },
                          })
                        }
                      />
                    </Field>
                  )}
                  <details
                    className="start-details"
                    open={
                      config.mode === 'ability' ||
                      (config.mode === 'cube' && isPrime(config.cubeType))
                    }
                  >
                    <summary>
                      시작 옵션{' '}
                      {config.mode === 'ability'
                        ? usesLowerFirstAbility(config)
                          ? '· 목표 보조 줄 자동 잠금'
                          : '· 잠금 설정'
                        : '직접 설정'}
                      <ChevronDown size={14} />
                    </summary>
                    <LineEditor
                      lines={config.start.lines}
                      options={editorOptions}
                      onChange={(lines) => patchConfig({ start: { ...config.start, lines } })}
                      canLock={config.mode === 'ability' && !usesLowerFirstAbility(config)}
                      locks={config.lockedSlots}
                      onLock={toggleAbilityLock}
                    />
                    {config.mode === 'cube' && isPrime(config.cubeType) && (
                      <small className="inline-note">
                        첫 번째 옵션은 고정됩니다. 확보 과정은 비용에 포함되지 않습니다.
                      </small>
                    )}
                  </details>
                </>
              )}
              {(config.mode === 'soulAmplification' ||
                (config.mode === 'cube' && isItemCube(config.cubeType))) && (
                <details className="advanced-settings">
                  <summary>
                    재료 단가 (선택) <ChevronDown size={14} />
                  </summary>
                  {config.mode === 'cube' && isItemCube(config.cubeType) && (
                    <Field label="큐브 1개 시세 (메소, 선택)">
                      <input
                        aria-label="큐브 단가"
                        type="text"
                        inputMode="numeric"
                        value={config.unitPrices[config.cubeType] ?? ''}
                        placeholder="미입력"
                        onChange={(e) => {
                          if (/^\d*$/.test(e.target.value))
                            patchConfig({
                              unitPrices: {
                                ...config.unitPrices,
                                [config.cubeType]: e.target.value,
                              },
                            });
                        }}
                      />
                    </Field>
                  )}
                  {config.mode === 'soulAmplification' &&
                    [1, 2, 3, 4].map((x) => (
                      <Field label={`${x}단계 에테르 단가 (메소, 선택)`} key={x}>
                        <input
                          inputMode="numeric"
                          value={config.unitPrices[`ether${x}`] ?? ''}
                          placeholder="미입력"
                          onChange={(e) => {
                            if (/^\d*$/.test(e.target.value))
                              patchConfig({
                                unitPrices: { ...config.unitPrices, [`ether${x}`]: e.target.value },
                              });
                          }}
                        />
                      </Field>
                    ))}
                  <small className="inline-note">
                    시세 환산은 별도 표시합니다. 행운 판정은 공식 메소 또는 큐브 개수를 기준으로
                    합니다.
                  </small>
                </details>
              )}
            </section>
            <section className="panel goal-panel">
              <div className="panel-heading">
                <h2>
                  <WandSparkles size={17} /> 이 세계의 목표
                </h2>
                <span className="panel-step">02</span>
              </div>
              {config.mode === 'ability' && (
                <div className="ability-presets">
                  <Field label="직업별 종결 어빌리티">
                    <select
                      aria-label="직업별 종결 어빌리티"
                      value={config.abilityPresetJob ?? ''}
                      onChange={(e) => chooseAbilityJob(e.target.value)}
                    >
                      <option value="" disabled>
                        프리셋 선택 · 현재 목표 직접 설정
                      </option>
                      {ABILITY_JOB_PRESETS.map((preset) => (
                        <option key={preset.job} value={preset.job}>
                          {preset.job} · {preset.code}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {resolveAbilityPreset(character.job) && (
                    <button className="text-button" onClick={() => chooseAbilityJob(character.job)}>
                      내 직업 종결 적용 · {character.job}
                    </button>
                  )}
                  <p className="inline-note">
                    모든 목표는 레전드리 조합입니다. 목표 수치는 옵션의 최저치로 시작하며 직접 높일
                    수 있습니다. 첫 글자는 1번째 줄, 보조 옵션은 2·3번째 줄 순서 무관입니다.
                  </p>
                  {lowerFirstGoal(config.target) && (
                    <Field label="어빌리티 목표 줄 수">
                      <select
                        aria-label="어빌리티 목표 줄 수"
                        value={config.target.conditions.length}
                        onChange={(e) => chooseAbilityGoalCount(Number(e.target.value) as 2 | 3)}
                      >
                        <option value={2}>2줄 · 첫 줄 + 보조 줄 하나</option>
                        <option value={3}>3줄 · 첫 줄 + 보조 줄 두 개</option>
                      </select>
                    </Field>
                  )}
                  <details className="ability-legend">
                    <summary>
                      패·재·상·보·크·공 뜻 <ChevronDown size={13} />
                    </summary>
                    <p>
                      패: 패시브 스킬 레벨 · 재: 재사용 대기시간 미적용 · 상: 상태 이상 대상 데미지
                      · 보: 보스 데미지 · 크: 크리티컬 확률 · 공: 공격력/마력
                    </p>
                  </details>
                  <Field label="어빌리티 진행 방식">
                    <select
                      aria-label="어빌리티 진행 방식"
                      value={usesLowerFirstAbility(config) ? 'lowerFirst' : 'fixed'}
                      onChange={(e) => {
                        const strategy = e.target.value as 'lowerFirst' | 'fixed';
                        const target = lowerFirstGoal(config.target);
                        patchConfig({
                          abilityStrategy: strategy,
                          lockedSlots:
                            strategy === 'lowerFirst'
                              ? []
                              : (state?.lockedSlots ?? config.lockedSlots),
                          ...(strategy === 'lowerFirst' && target ? { target } : {}),
                        });
                      }}
                    >
                      <option value="lowerFirst" disabled={!lowerFirstGoal(config.target)}>
                        아랫줄부터 자동 잠금 → 첫 줄
                      </option>
                      <option value="fixed">수동 잠금 유지</option>
                    </select>
                  </Field>
                  <p className="inline-note">
                    {usesLowerFirstAbility(config)
                      ? requiredAbilityLower === 1
                        ? '2·3번째 줄 중 하나에 보조 목표 확보 → 해당 줄 잠금 → 첫 줄 완성. 남은 한 줄은 무관하며, 기댓값도 이 순서로 계산합니다.'
                        : '보조 목표 중 하나 확보 → 해당 줄 잠금 → 남은 보조 줄 확보·잠금 → 첫 줄 완성. 기댓값도 이 순서로 계산합니다.'
                      : automaticAbilityTarget
                        ? '직접 재설정은 선택한 잠금을 유지합니다. 자동 실행은 목표에 맞게 잠금을 다시 판단하고 아랫줄부터 완성합니다.'
                        : '선택한 줄의 잠금을 유지하며 목표 전체가 완성될 때까지 재설정합니다.'}
                  </p>
                </div>
              )}
              <GoalEditor
                goal={config.target}
                mode={config.mode}
                options={targetOptions}
                conditionBounds={conditionBounds}
                onChange={(target) => patchConfig({ target })}
              />
              <details className="imported-details">
                <summary>
                  불러온 현재 옵션 <ChevronDown size={14} />
                </summary>
                <OptionLines lines={importedLines} empty="직접 목표를 설정하는 도전입니다." />
              </details>
            </section>
          </aside>
          <div className="result-column">
            <section
              className={`panel simulation-panel mode-${config.mode}`}
              data-batch-size={effectiveBatchSize(config, state?.grade ?? config.start.grade)}
            >
              <div className="simulation-heading">
                <div>
                  <div className="eyebrow">YOUR PARALLEL UNIVERSE</div>
                  <h2>
                    {displayName} <span>시뮬레이터</span>
                  </h2>
                  <p>{modeInfo.caption}</p>
                </div>
                <span className="simulation-icon">
                  {(() => {
                    const Icon = modeIcon;
                    return <Icon size={28} />;
                  })()}
                </span>
              </div>
              <div className="status-line">
                <span
                  className={`status-badge ${state?.status === 'success' ? 'is-success' : auto ? 'is-running' : ''}`}
                >
                  <i />
                  {state?.status === 'success'
                    ? '목표 달성'
                    : auto
                      ? '다른 세계에서 도전 중'
                      : state?.attempts
                        ? '다음 도전을 기다리는 중'
                        : '준비 완료'}
                </span>
                <span className="source-stamp">
                  <ShieldCheck size={12} /> 공식 확률 적용
                </span>
              </div>
              {config.mode === 'soulAmplification' ? (
                <div className="amplification-display">
                  <span className="amp-orb">
                    <Orbit size={54} />
                  </span>
                  <div>
                    <span className="small-label">현재 소울 증폭</span>
                    <div className="amp-stage">
                      {state?.stage ?? config.start.stage}
                      <small>단계</small>
                      <ArrowRight size={22} />
                      <span>
                        {config.target.stage}
                        <small>단계</small>
                      </span>
                    </div>
                  </div>
                  <div className="amp-steps">
                    {[1, 2, 3, 4].map((x) => (
                      <span key={x} className={x <= (state?.stage ?? 0) ? 'complete' : ''}>
                        {x <= (state?.stage ?? 0) ? <Check size={16} /> : x}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="current-result">
                  <div className="card-title">
                    <span>현재 보관 옵션</span>
                    <GradeBadge grade={state?.grade ?? config.start.grade} />
                  </div>
                  <OptionLines
                    lines={state?.lines ?? config.start.lines}
                    locks={
                      config.mode === 'ability'
                        ? usesLowerFirstAbility(config)
                          ? state?.lockedSlots
                          : config.lockedSlots
                        : undefined
                    }
                    onToggleLock={config.mode === 'ability' ? toggleAbilityLock : undefined}
                    locksDisabled={auto || !state}
                    automaticLocks={usesLowerFirstAbility(config)}
                  />
                  {config.mode === 'ability' && (
                    <p className="inline-note">
                      최대 두 줄까지 직접 잠글 수 있습니다.
                      {(usesLowerFirstAbility(config) || automaticAbilityTarget) &&
                        ' 자동 실행은 목표에 맞게 잠금을 다시 설정합니다.'}
                    </p>
                  )}
                  {config.mode === 'cube' && isPrime(config.cubeType) && (
                    <span className="kept-label">첫 번째 옵션 고정</span>
                  )}
                </div>
              )}
              {config.mode === 'ability' && (
                <div className="ability-progress-slot">
                  {usesLowerFirstAbility(config) && state ? (
                    <div className="ability-progress" aria-label="어빌리티 자동 잠금 진행">
                      <strong>
                        {state.status === 'success'
                          ? requiredAbilityLower === 1
                            ? '두 줄 완성'
                            : '세 줄 완성'
                          : (state.lockedSlots?.length ?? 0) === requiredAbilityLower
                            ? '첫 번째 줄 도전 중'
                            : (state.lockedSlots?.length ?? 0) === 1
                              ? '남은 보조 줄 도전 중'
                              : '첫 보조 줄 도전 중'}
                      </strong>
                      <div className="ability-progress-steps">
                        {(requiredAbilityLower === 1
                          ? ['보조 줄 하나', '첫 줄 완성']
                          : ['보조 줄 하나', '보조 줄 두 개', '첫 줄 완성']
                        ).map((label, index) => (
                          <span
                            key={label}
                            className={
                              index < (state.lockedSlots?.length ?? 0) || state.status === 'success'
                                ? 'complete'
                                : ''
                            }
                          >
                            {index < (state.lockedSlots?.length ?? 0) ||
                            state.status === 'success' ? (
                              <Check size={13} />
                            ) : (
                              index + 1
                            )}{' '}
                            {label}
                          </span>
                        ))}
                      </div>
                      {state.status !== 'success' && (
                        <small>
                          자동 잠금 {state.lockedSlots?.length ?? 0}/{requiredAbilityLower}줄 · 다음
                          1회{' '}
                          {formatAmount(
                            Number(
                              data.ability.costs.find(
                                (cost) => cost.locked === (state.lockedSlots?.length ?? 0),
                              )!.meso,
                            ),
                          )}{' '}
                          메소 · 명성치{' '}
                          {formatAmount(
                            data.ability.costs.find(
                              (cost) => cost.locked === (state.lockedSlots?.length ?? 0),
                            )!.honor,
                          )}
                        </small>
                      )}
                    </div>
                  ) : (
                    <div className="ability-progress">
                      <strong>직접 잠금 설정</strong>
                      <p className="inline-note">
                        보관 옵션 오른쪽에서 잠금을 선택하세요. 직접 재설정은 선택한 잠금을
                        유지합니다.
                      </p>
                      <small>
                        {automaticAbilityTarget
                          ? '자동 실행은 목표에 맞춰 잠금을 다시 판단합니다.'
                          : '현재 목표와 선택한 잠금으로 도전합니다.'}
                      </small>
                    </div>
                  )}
                </div>
              )}
              {state && <ProgressDisplay data={data} config={config} state={state} />}
              {state?.candidates.length ? (
                config.mode !== 'soulAmplification' && (
                  <div className={`candidate-grid count-${state.candidates.length}`}>
                    {state.candidates.map((candidate, i) => (
                      <article
                        className={`candidate-card ${candidate.hit ? 'is-hit' : ''}`}
                        key={`${candidate.sequence}-${i}`}
                      >
                        <div className="card-title">
                          <span>
                            {candidate.hit ? (
                              <>
                                <Check size={13} />
                                목표 달성
                              </>
                            ) : (
                              `재설정 ${state.candidates.length === 1 ? formatAmount(candidate.sequence) : i + 1}`
                            )}
                          </span>
                          <GradeBadge grade={candidate.grade} />
                        </div>
                        <OptionLines lines={candidate.lines} />
                        <div className="candidate-footer">
                          {candidate.adopted && candidate.progressed && (
                            <span className="kept-label">보조 목표 확보 · 자동 잠금</span>
                          )}
                          {!candidate.hit && (
                            <button
                              className="text-button accept-option"
                              disabled={auto}
                              onClick={() =>
                                begin({
                                  ...config,
                                  start: {
                                    grade: candidate.grade,
                                    lines: candidate.lines,
                                    stage: candidate.stage,
                                    failures: state.failures,
                                  },
                                })
                              }
                            >
                              이 옵션에서 새 도전 <ArrowUpRight size={12} />
                            </button>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                )
              ) : config.mode === 'ability' ? (
                <div className={`candidate-grid count-${config.batchSize}`}>
                  {Array.from({ length: config.batchSize }, (_, index) => (
                    <article className="candidate-placeholder" key={index}>
                      <div className="card-title">
                        <span>재설정 {index + 1}</span>
                        <GradeBadge grade="legendary" />
                      </div>
                      <div className="option-lines" aria-hidden="true">
                        {[0, 1, 2].map((slot) => (
                          <div className="option-row" key={slot}>
                            <i className="grade-dot grade-legendary" />
                            <span>—</span>
                          </div>
                        ))}
                      </div>
                      <div className="candidate-footer">
                        <span>재설정 결과가 표시됩니다.</span>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                config.mode !== 'soulAmplification' && (
                  <div className="empty-result">
                    <span className="empty-cube">
                      <Boxes size={24} />
                    </span>
                    <p>아직 열어보지 않은 가능성</p>
                    <span>아래 버튼을 눌러 첫 번째 결과를 만나보세요.</span>
                  </div>
                )
              )}
              <div className="roll-controls">
                <div className="roll-options">
                  <span>한 번에</span>
                  <div className="segmented mini">
                    <button
                      className={config.batchSize === 1 ? 'selected' : ''}
                      disabled={auto}
                      onClick={() => config.batchSize !== 1 && patchConfig({ batchSize: 1 })}
                    >
                      1회
                    </button>
                    <button
                      className={config.batchSize === 3 ? 'selected' : ''}
                      disabled={auto || config.mode === 'soulAmplification'}
                      onClick={() => config.batchSize !== 3 && patchConfig({ batchSize: 3 })}
                    >
                      3회 비교
                    </button>
                  </div>
                  <button className="text-button reset-button" onClick={() => begin(config)}>
                    <RotateCcw size={13} /> 새 도전
                  </button>
                </div>
                <div className="roll-button-row">
                  <button
                    className="button primary roll-button"
                    disabled={!canRun || auto}
                    onClick={oneRoll}
                  >
                    <Boxes size={18} />
                    {config.mode === 'soulAmplification'
                      ? '증폭 시도하기'
                      : `${effectiveBatchSize(config, state?.grade ?? config.start.grade)}회 재설정하기`}
                    <ArrowRight size={17} />
                  </button>
                  <button
                    className={`button auto-button ${auto ? 'stop' : ''}`}
                    disabled={!auto && !canAutoRun && !canRestartAuto}
                    onClick={auto ? stop : startAuto}
                  >
                    {auto ? (
                      <>
                        <Pause size={16} />
                        중지
                      </>
                    ) : canRestartAuto ? (
                      <>
                        <RotateCcw size={16} />
                        다시 자동재설정
                      </>
                    ) : (
                      <>
                        <Play size={15} />
                        자동 재설정
                      </>
                    )}
                  </button>
                </div>
                <p className="control-hint">
                  {config.batchSize === 3
                    ? effectiveBatchSize(config, state?.grade ?? config.start.grade) === 1
                      ? '등급 상승 구간은 1회씩 진행하고, 레전드리에 도달하면 3회 비교로 자동 전환합니다.'
                      : usesLowerFirstAbility(config)
                        ? '같은 잠금 상태에서 3회분을 모두 사용하고, 목표 달성 또는 보조 줄을 더 많이 확보한 결과를 채택합니다.'
                        : '3개를 모두 뽑고 비용도 3회분을 사용합니다.'
                    : usesLowerFirstAbility(config)
                      ? '목표 보조 줄을 확보하면 채택·잠금합니다. 나머지 결과는 기존 옵션을 유지합니다.'
                      : '목표 미달 시 기존 옵션을 유지하며, 등급 상승은 적용합니다.'}
                </p>
              </div>
              {errors.length > 0 && (
                <div className="notice error" role="alert">
                  {errors.map((error, i) => (
                    <p key={i}>{error}</p>
                  ))}
                </div>
              )}
              {message && (
                <div className="notice" role="status">
                  {message}
                  <button
                    className="icon-button"
                    aria-label="안내 닫기"
                    onClick={() => setMessage('')}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </section>
            {state && (
              <>
                <section className="stats-row" aria-label="도전 통계">
                  <div className="stat-card">
                    <span>누적 시도</span>
                    <strong>
                      {formatAmount(state.attempts)}
                      <small>회</small>
                    </strong>
                    <div>
                      {config.batchSize === 3
                        ? effectiveBatchSize(config, state.grade) === 3
                          ? '3회 비교 모드'
                          : '승급까지 1회 · 이후 3회 비교'
                        : '한 번 한 번 쌓이는 가능성'}
                    </div>
                  </div>
                  <div className="stat-card spent-stat">
                    <span>{itemBased ? '사용한 큐브' : '사용한 메소'}</span>
                    <strong
                      title={formatAmount(itemBased ? state.spent.cubes : state.spent.meso, false)}
                    >
                      {formatAmount(itemBased ? state.spent.cubes : state.spent.meso)}
                      <small>{itemBased ? '개' : '메소'}</small>
                    </strong>
                    <div>
                      {config.mode === 'ability'
                        ? `명성치 ${formatAmount(state.spent.honor)} 소모`
                        : state.spent.credits > 0n
                          ? `${formatAmount(state.spent.credits)} 크레딧`
                          : config.mode === 'soulAmplification'
                            ? `에테르 총 ${formatAmount(state.spent.ethers.reduce((a, b) => a + b, 0n))}개`
                            : '이번 세계에서 사용한 비용'}
                    </div>
                  </div>
                  <div className="stat-card expected-stat">
                    <span>
                      목표까지 기댓값 {benchmarkBusy && <LoaderCircle size={12} className="spin" />}
                    </span>
                    <strong>
                      {benchmark ? formatAmount(benchmark.expectedCost) : '계산 중'}
                      <small>{benchmark?.unit === 'cubes' ? '개' : benchmark ? '메소' : ''}</small>
                    </strong>
                    <div>
                      {benchmark?.status === 'partial'
                        ? '목표에 도달하지 못할 가능성 있음'
                        : benchmark?.status === 'impossible'
                          ? '현재 설정으로 달성할 수 없음'
                          : benchmark?.status === 'already'
                            ? '시작 상태가 이미 목표를 만족'
                            : benchmark
                              ? '같은 조건의 평균 소비'
                              : '같은 목표의 다른 세계를 살피는 중'}
                    </div>
                  </div>
                </section>
                {(state.spent.credits > 0n ||
                  config.mode === 'soulAmplification' ||
                  marketValue > 0n) && (
                  <div className="resource-ledger">
                    {config.mode === 'soulAmplification' &&
                      state.spent.ethers.map((x, i) => (
                        <span key={i}>
                          {i + 1}단계 에테르 <b>{formatAmount(x)}개</b>
                        </span>
                      ))}
                    {state.spent.credits > 0n && (
                      <span>
                        소모 크레딧 <b>{formatAmount(state.spent.credits)}</b>
                      </span>
                    )}
                    {marketValue > 0n && (
                      <span>
                        입력 시세 환산 <b>{formatAmount(marketValue)} 메소</b>
                      </span>
                    )}
                  </div>
                )}
                <ReactionStage
                  character={character}
                  state={state}
                  benchmark={benchmark}
                  reaction={reaction}
                  actualCost={actualCost}
                />
                {benchmark &&
                  benchmark.status === 'ready' &&
                  Number.isFinite(benchmark.expectedCost) && (
                    <DistributionChart
                      benchmark={benchmark}
                      actualCost={actualCost}
                      done={state.status === 'success' && state.attempts > 0n}
                    />
                  )}
                {benchmark?.note && (
                  <p className="benchmark-note">
                    <CircleHelp size={13} />
                    {benchmark.note}
                  </p>
                )}
                <details className="panel history-panel">
                  <summary>
                    <span>
                      <BookOpen size={15} /> 이 세계의 기록 <b>{state.history.length}</b>
                    </span>
                    <span>
                      최근 100회 <ChevronDown size={14} />
                    </span>
                  </summary>
                  {state.history.length ? (
                    <div className="history-list">
                      {[...state.history]
                        .sort((a, b) => (a.sequence > b.sequence ? -1 : 1))
                        .map((entry, i) => (
                          <div
                            className={`history-row ${entry.hit ? 'hit' : ''}`}
                            key={`${entry.sequence}-${i}`}
                          >
                            <span className="history-number">#{formatAmount(entry.sequence)}</span>
                            <div>
                              {config.mode === 'soulAmplification' ? (
                                <strong>
                                  {entry.amplified ? `${entry.stage}단계 증폭 성공` : '증폭 실패'}
                                </strong>
                              ) : (
                                <>
                                  <GradeBadge grade={entry.grade} />
                                  <span>{entry.lines.map((x) => x.text).join(' / ')}</span>
                                </>
                              )}
                            </div>
                            <small>
                              {formatAmount(itemBased ? entry.cost.cubes : entry.cost.meso)}{' '}
                              {itemBased ? '개' : '메소'}
                            </small>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="empty-history">첫 번째 도전이 기록될 자리예요.</p>
                  )}
                </details>
              </>
            )}
            {!state && (
              <div className="notice error">
                시작 상태를 만들 수 없습니다. 장비 부위·등급·시작 옵션을 확인해 주세요.
              </div>
            )}
          </div>
        </div>
        <Sources fetchedAt={character.fetchedAt} />
      </main>
      <footer className="site-footer">
        <div className="footer-brand">
          <InfinityIcon size={18} />
          <span>이세계 직작</span>
          <small>또 다른 나의 가능성</small>
        </div>
        <div>
          <span>
            {saved
              ? '설정과 도전 기록은 이 브라우저에 저장돼요.'
              : '브라우저 저장을 사용할 수 없어 이번 탭에서만 유지됩니다.'}
          </span>
          <small>Data based on NEXON Open API. 넥슨과 관련 없는 비공식 팬 시뮬레이터입니다.</small>
        </div>
      </footer>
      {searchOpen && (
        <div
          className="modal-backdrop"
          onPointerDown={(e) => {
            backdropPress.current = e.button === 0 && e.target === e.currentTarget;
          }}
          onPointerUp={(e) => {
            backdropPress.current = backdropPress.current && e.target === e.currentTarget;
          }}
          onPointerCancel={() => {
            backdropPress.current = false;
          }}
          onClick={(e) => {
            const dismiss = backdropPress.current && e.target === e.currentTarget;
            backdropPress.current = false;
            if (dismiss) closeSearch();
          }}
        >
          <section
            className="search-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="search-title"
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                const nodes = [
                  ...e.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)',
                  ),
                ];
                const first = nodes[0],
                  last = nodes.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                  e.preventDefault();
                  last?.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first?.focus();
                }
              }
              if (e.key === 'Escape') {
                closeSearch();
              }
            }}
          >
            <button
              className="icon-button modal-close"
              aria-label="캐릭터 검색 닫기"
              onClick={closeSearch}
            >
              <X size={20} />
            </button>
            <div className="modal-symbol">
              <Search size={25} />
            </div>
            <h2 id="search-title">또 다른 나를 불러오기</h2>
            <p>
              캐릭터 외형과 장비, 어빌리티를 가져와
              <br />이 세계에서 같은 옵션에 도전해 보세요.
            </p>
            <form onSubmit={searchCharacter}>
              <Field label="캐릭터 닉네임">
                <input
                  autoFocus
                  aria-label="캐릭터 닉네임"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="캐릭터 닉네임을 입력하세요"
                  maxLength={20}
                />
              </Field>
              {sharedApiBase && (
                <div className="shared-search-choice">
                  <span>
                    {sharedSearch ? '공용 검색 · 닉네임만 입력하세요' : '개인 API 키로 검색 중'}
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    disabled={searchBusy}
                    onClick={() => {
                      setPersonalSearch(!personalSearch);
                      setSearchError('');
                    }}
                  >
                    {sharedSearch ? '개인 키로 전환' : '공용 검색으로 전환'}
                  </button>
                </div>
              )}
              {!sharedSearch && (
                <>
                  <Field
                    label="개인 Nexon Open API 키"
                    hint="키는 현재 탭의 메모리에서만 사용하고 넥슨 API로 직접 전송합니다."
                  >
                    <input
                      aria-label="개인 Nexon Open API 키"
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="발급받은 키를 입력하세요"
                    />
                  </Field>
                  <div className="key-actions">
                    <a
                      href="https://openapi.nexon.com/ko/guide/prepare-in-advance/"
                      target="_blank"
                      rel="noreferrer"
                    >
                      API 키 발급 안내 <ExternalLink size={12} />
                    </a>
                    {apiKey && (
                      <button type="button" className="text-button" onClick={() => setApiKey('')}>
                        입력한 키 지우기
                      </button>
                    )}
                  </div>
                </>
              )}
              {searchError && (
                <div className="notice error" role="alert">
                  {searchError}
                </div>
              )}
              <button
                className="button primary"
                disabled={
                  !searchReady || searchBusy || !name.trim() || (!sharedSearch && !apiKey.trim())
                }
              >
                {searchBusy ? (
                  <>
                    <LoaderCircle size={17} className="spin" />
                    불러오는 중
                  </>
                ) : (
                  <>
                    <Search size={17} />
                    캐릭터 불러오기
                  </>
                )}
              </button>
            </form>
            <small className="modal-note">
              최신 API 정보는 게임 반영까지 시간이 걸릴 수 있습니다.
              <br />
              불러온 뒤에도 모든 시작 상태와 목표를 직접 수정할 수 있어요.
            </small>
          </section>
        </div>
      )}
    </div>
  );
}

function ProgressDisplay({
  data,
  config,
  state,
}: {
  data: RuleData;
  config: SimulationConfig;
  state: SimulationState;
}) {
  if (config.mode === 'soulAmplification') {
    const rule = data.soul.amplificationStages.find((x) => x.stage === state.stage + 1);
    if (!rule)
      return (
        <div className="pity-progress">
          <span>최대 증폭 단계 달성</span>
          <Check size={14} />
        </div>
      );
    const probability =
      state.failures >= rule.guaranteedAfterFailures
        ? 1
        : rule.initialSuccessProbability +
          state.failures * rule.successProbabilityIncreasePerFailure;
    return (
      <div className="pity-area">
        <div>
          <span>
            다음 증폭 성공 확률 <b>{(probability * 100).toFixed(1)}%</b>
          </span>
          <span>보장까지 {Math.max(0, rule.guaranteedAfterFailures - state.failures)}회 실패</span>
        </div>
        <progress max={rule.guaranteedAfterFailures} value={state.failures} />
      </div>
    );
  }
  if (
    config.mode === 'ability' ||
    state.grade === 'legendary' ||
    (config.mode === 'cube' && isItemCube(config.cubeType))
  )
    return null;
  const rules =
    config.mode === 'soulPotential'
      ? data.soul.potentialGrades
      : config.cubeType === 'additional'
        ? data.additional.grades
        : data.potential.grades;
  const rule = rules.find((x) => x.grade === state.grade);
  if (!rule) return null;
  const threshold = rule.guaranteedAfterFailures ?? (rule.pityThreshold ?? 0) - 1;
  return (
    <div className="pity-area">
      <div>
        <span>
          등급 상승 보장{' '}
          <b>
            {state.failures} / {threshold}
          </b>
        </span>
        <span>자연 상승률 {(rule.gradeUpChance * 100).toFixed(4)}%</span>
      </div>
      <progress max={Math.max(1, threshold)} value={state.failures} />
    </div>
  );
}
