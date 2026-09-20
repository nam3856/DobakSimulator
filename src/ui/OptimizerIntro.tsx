import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { OptimizerAvatarDescriptor } from '../character/optimizer-avatar';
import './optimizer-intro.css';

const STEPS = ['현재 어빌리티', '목표 옵션', '보유 재화'];

export function OptimizerIntro({
  avatar,
  onStart,
}: {
  avatar: OptimizerAvatarDescriptor;
  onStart: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  return (
    <div className="optimizer-intro">
      <div className="optimizer-intro-portrait" aria-hidden="true">
        {fallbackFailed ? (
          <span className="optimizer-intro-placeholder">{avatar.name.slice(0, 1)}</span>
        ) : (
          <img
            src={failed ? avatar.fallbackSrc : avatar.frames[1]}
            alt=""
            width="300"
            height="300"
            onError={() => (failed ? setFallbackFailed(true) : setFailed(true))}
          />
        )}
      </div>
      <h2 className="optimizer-intro-title">
        <span>내 어빌리티,</span> <span>어떻게 완성할까요?</span>
      </h2>
      <p className="optimizer-intro-description">
        현재 옵션과 보유 명성치에 맞춰 강화 순서와 예상 추가비용을 비교해요.
      </p>
      <ol className="optimizer-intro-steps" aria-label="어빌리티 최적화 진행 순서">
        {STEPS.map((step, index) => (
          <li key={step}>
            <span>{step}</span>
            {index < STEPS.length - 1 && <ArrowRight size={13} aria-hidden="true" />}
          </li>
        ))}
      </ol>
      <div className="optimizer-intro-action">
        <button className="button primary optimizer-start-button" onClick={onStart}>
          시작하기 <ArrowRight size={18} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
