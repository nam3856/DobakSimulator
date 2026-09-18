import { useId, type CSSProperties } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import './soul-amplification.css';

// Failure runs at roughly 3x the reference; success keeps its full sequence at 1.5x.
export const SOUL_CHARGE_MS = 550;
export const SOUL_RESULT_MS = 450;
export const SOUL_SUCCESS_RESULT_MS = 1450;

type SoulAmplificationDisplayProps = {
  stage: number;
  targetStage: number;
  phase: 'idle' | 'charging' | 'success' | 'failure';
  attemptKey: string;
};

const SPARK_ANGLES = [12, 48, 92, 134, 178, 222, 266, 312];
const SMOKE_OFFSETS = [
  [-88, -8],
  [-66, -27],
  [-43, 7],
  [-23, -32],
  [0, -13],
  [24, -30],
  [45, 7],
  [68, -23],
  [87, -7],
];

export function SoulAmplificationDisplay({
  stage,
  targetStage,
  phase,
  attemptKey,
}: SoulAmplificationDisplayProps) {
  const id = useId();
  const status =
    phase === 'charging'
      ? '소울 증폭 중'
      : phase === 'success'
        ? `증폭 성공 · ${stage}단계`
        : phase === 'failure'
          ? '증폭 실패 · 단계 유지'
          : '소울 증폭 준비 완료';
  const timing = {
    '--soul-charge-ms': `${SOUL_CHARGE_MS}ms`,
    '--soul-result-ms': `${phase === 'success' ? SOUL_SUCCESS_RESULT_MS : SOUL_RESULT_MS}ms`,
  } as CSSProperties;

  return (
    <div className="amplification-display soul-amplification" data-phase={phase} style={timing}>
      <div
        key={`${attemptKey}-${phase}`}
        className={`soul-scene soul-scene--${phase}`}
        aria-hidden="true"
      >
        <span className="soul-scene-label">SOUL AMPLIFICATION</span>
        <div className="soul-energy-field">
          <span className="soul-item-frame" />
          <span className="soul-ground-glow" />
          <svg className="soul-orb" viewBox="0 0 80 80" fill="none">
            <defs>
              <radialGradient id={`${id}-orb`} cx=".35" cy=".28" r=".74">
                <stop stopColor="#fff0ff" />
                <stop offset=".23" stopColor="#da9ef6" />
                <stop offset=".58" stopColor="#9055c8" />
                <stop offset="1" stopColor="#362755" />
              </radialGradient>
              <radialGradient id={`${id}-rim`} cx=".28" cy=".18" r=".86">
                <stop stopColor="#fffce7" />
                <stop offset=".44" stopColor="#e4d2a5" />
                <stop offset=".73" stopColor="#847296" />
                <stop offset="1" stopColor="#eddce9" />
              </radialGradient>
              <linearGradient
                id={`${id}-soul`}
                x1="28"
                y1="22"
                x2="52"
                y2="59"
                gradientUnits="userSpaceOnUse"
              >
                <stop stopColor="#fff" />
                <stop offset="1" stopColor="#d9faff" />
              </linearGradient>
            </defs>
            <circle cx="40" cy="40" r="30" fill={`url(#${id}-rim)`} />
            <circle cx="40" cy="40" r="26.5" fill={`url(#${id}-orb)`} stroke="#edc9ff" />
            <path
              d="M20 47C17 33 24 21 35 17M47 64C58 60 65 51 65 40"
              stroke="#fff4f9"
              strokeWidth="2"
              strokeLinecap="round"
              opacity=".6"
            />
            <path
              d="M44 19C34 23 28 30 29 39C22 37 23 29 23 29C15 44 27 59 40 60C52 62 60 54 59 45C58 37 50 34 48 28C44 34 46 41 49 43C42 44 36 38 38 31C39 26 43 23 44 19Z"
              fill={`url(#${id}-soul)`}
              stroke="#f8eaff"
              strokeWidth=".8"
            />
            <path
              d="M35 45L37 49M45 47L46 51"
              stroke="#755690"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
            <ellipse
              cx="29"
              cy="23"
              rx="8"
              ry="3.5"
              transform="rotate(-31 29 23)"
              fill="white"
              opacity=".55"
            />
            <path d="M59 15L61 20L66 22L61 24L59 29L57 24L52 22L57 20Z" fill="#fff1d3" />
            <path
              d="M18 54L19.5 57.5L23 59L19.5 60.5L18 64L16.5 60.5L13 59L16.5 57.5Z"
              fill="#f4d9ff"
            />
          </svg>
          {phase === 'charging' && (
            <div className="soul-charge">
              <span className="soul-charge-ring" />
              <svg className="soul-orbit soul-orbit--outer" viewBox="0 0 180 180" fill="none">
                <circle cx="90" cy="90" r="76" stroke="currentColor" strokeWidth="1" opacity=".2" />
                <circle
                  cx="90"
                  cy="90"
                  r="76"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray="72 165"
                />
              </svg>
              <svg className="soul-orbit soul-orbit--inner" viewBox="0 0 180 180" fill="none">
                <circle
                  cx="90"
                  cy="90"
                  r="61"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray="38 154"
                />
              </svg>
              {SPARK_ANGLES.map((angle, index) => (
                <span
                  key={angle}
                  className="soul-charge-spark"
                  style={
                    {
                      '--spark-angle': `${angle}deg`,
                      '--spark-delay': `${index * 13}ms`,
                    } as CSSProperties
                  }
                />
              ))}
              <span className="soul-charge-flash" />
            </div>
          )}
          {phase === 'success' && (
            <div className="soul-success">
              <svg className="soul-fusion-orbits" viewBox="0 0 200 200" fill="none">
                <defs>
                  <linearGradient
                    id={`${id}-trail`}
                    x1="100"
                    y1="24"
                    x2="166"
                    y2="138"
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop stopColor="#f0ffff" />
                    <stop offset=".2" stopColor="#83ffff" />
                    <stop offset=".65" stopColor="#23dcff" stopOpacity=".65" />
                    <stop offset="1" stopColor="#23dcff" stopOpacity="0" />
                  </linearGradient>
                  <radialGradient id={`${id}-comet`}>
                    <stop stopColor="#fff" />
                    <stop offset=".2" stopColor="#e2ffff" />
                    <stop offset=".45" stopColor="#58f8ff" stopOpacity=".9" />
                    <stop offset="1" stopColor="#26dfff" stopOpacity="0" />
                  </radialGradient>
                </defs>
                {[0, 180].map((angle) => (
                  <g key={angle} transform={`rotate(${angle} 100 100)`}>
                    <path
                      d="M100 24A76 76 0 0 1 165.82 138"
                      stroke={`url(#${id}-trail)`}
                      strokeWidth="9"
                      opacity=".28"
                    />
                    <path
                      d="M100 24A76 76 0 0 1 165.82 138"
                      stroke={`url(#${id}-trail)`}
                      strokeWidth="3.5"
                      strokeLinecap="round"
                    />
                    <circle cx="100" cy="24" r="19" fill={`url(#${id}-comet)`} />
                    <circle cx="100" cy="24" r="3.5" fill="#f5ffff" />
                  </g>
                ))}
              </svg>
              <span className="soul-success-burst" />
              <span className="soul-success-ring" />
              {[-2, -1, 0, 1, 2].map((line) => (
                <span
                  key={line}
                  className="soul-success-ray"
                  style={
                    {
                      '--ray-y': `${line * 10}px`,
                      '--ray-width': `${250 - Math.abs(line) * 31}px`,
                    } as CSSProperties
                  }
                />
              ))}
              <span className="soul-outcome soul-outcome--success">SUCCESS!</span>
            </div>
          )}
          {phase === 'failure' && (
            <div className="soul-failure">
              {SMOKE_OFFSETS.map(([x, y], index) => (
                <span
                  key={index}
                  className="soul-smoke"
                  style={
                    {
                      '--smoke-x': `${x}px`,
                      '--smoke-y': `${y}px`,
                      '--smoke-turn': `${index * 37}deg`,
                    } as CSSProperties
                  }
                />
              ))}
              <span className="soul-outcome soul-outcome--failure">FAILED</span>
            </div>
          )}
        </div>
        <span className="soul-scene-caption">
          {phase === 'idle' ? '소울에 깃든 힘을 깨워보세요' : status}
        </span>
      </div>
      <div className="soul-stage-row">
        <div>
          <span className="small-label">현재 소울 증폭</span>
          <div className="amp-stage">
            {stage}
            <small>단계</small>
            <ArrowRight size={20} aria-label="목표" />
            <span>
              {targetStage}
              <small>단계</small>
            </span>
          </div>
        </div>
        <div className="amp-steps" aria-label={`현재 ${stage}단계, 최대 4단계`}>
          {[1, 2, 3, 4].map((step) => (
            <span key={step} className={step <= stage ? 'complete' : ''} aria-hidden="true">
              {step <= stage ? <Check size={15} /> : step}
            </span>
          ))}
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </span>
    </div>
  );
}
