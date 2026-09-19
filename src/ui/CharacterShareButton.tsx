import { useEffect, useRef, useState } from 'react';
import { Check, Link } from 'lucide-react';
import type { AppTab } from './constants';
import { buildCharacterShareLink } from './character-link';

export function CharacterShareButton({
  name,
  mode,
  apiBase,
}: {
  name: string;
  mode: AppTab;
  apiBase?: string;
}) {
  const url = buildCharacterShareLink(name, mode, apiBase);
  const [result, setResult] = useState<{ url: string; copied: boolean }>();
  const fallback = useRef<HTMLInputElement>(null);
  const current = result?.url === url ? result : undefined;
  useEffect(() => {
    if (!current) return;
    if (!current.copied) {
      fallback.current?.focus();
      fallback.current?.select();
      return;
    }
    const timeout = setTimeout(() => setResult(undefined), 2500);
    return () => clearTimeout(timeout);
  }, [current]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setResult({ url, copied: true });
    } catch {
      setResult({ url, copied: false });
    }
  }

  return (
    <div className="character-share">
      <button
        type="button"
        className="character-share-button"
        onClick={copyLink}
        aria-label="캐릭터 공유 링크 복사"
      >
        {current?.copied ? <Check size={14} /> : <Link size={14} />}
        <span aria-live="polite">{current?.copied ? '복사했어요' : '캐릭터 링크 복사'}</span>
      </button>
      {current && !current.copied && (
        <div className="character-share-fallback">
          <label>
            캐릭터 공유 링크
            <input
              ref={fallback}
              type="text"
              value={url}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <small role="status">자동 복사가 안 돼요. 위 링크를 직접 복사해 주세요.</small>
        </div>
      )}
    </div>
  );
}
