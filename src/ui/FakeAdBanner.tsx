import { useEffect, useRef, useState } from 'react';

const BANNERS = [
  { file: 'ad-1.png', name: '메이플스토리 불족발' },
  { file: 'ad-2.png', name: '스타포스 지금 누르러 가기' },
  { file: 'ad-3.png', name: '메이플스토리 헬스장' },
  { file: 'ad-4.png?v=2', name: '메이플스토리 연애 시뮬레이터' },
];

function BannerImage({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="fake-ad-fallback">배너 이미지를 불러오지 못했어요.</span>
  ) : (
    <img
      src={src}
      alt={`${name} 패러디 광고`}
      width={1028}
      height={382}
      onError={() => setFailed(true)}
    />
  );
}

export function FakeAdBanner() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * BANNERS.length));
  const [notice, setNotice] = useState(false);
  const noticeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const step = 1 + Math.floor(Math.random() * (BANNERS.length - 1));
      setIndex((current) => (current + step) % BANNERS.length);
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  function showNotice() {
    window.clearTimeout(noticeTimer.current);
    setNotice(true);
    noticeTimer.current = window.setTimeout(() => setNotice(false), 3_000);
  }

  const banner = BANNERS[index];
  return (
    <div className="hero-banner">
      <button
        type="button"
        className="fake-ad-banner"
        aria-label={`${banner.name} 가짜 광고 안내 보기`}
        onClick={showNotice}
      >
        <BannerImage
          key={banner.file}
          src={`${import.meta.env.BASE_URL}banners/${banner.file}`}
          name={banner.name}
        />
      </button>
      <div className="fake-ad-status" role="status" aria-atomic="true">
        {notice && (
          <div className="fake-ad-toast">가짜 광고입니다. 실제 광고나 외부 링크가 아니에요.</div>
        )}
      </div>
    </div>
  );
}
