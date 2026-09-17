import { useEffect, useState } from 'react';

const EVENT_URL = 'https://maplestory.nexon.com/News/Event/Ongoing/1389';

const BANNERS = [
  { file: 'ad-2.png', name: '스타포스 지금 누르러 가기' },
  { file: 'ad-3.png', name: '메이플스토리 헬스장' },
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

export function FakeAdBanner({ onStarforce }: { onStarforce: () => void }) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * BANNERS.length));

  useEffect(() => {
    const interval = window.setInterval(() => {
      const step = 1 + Math.floor(Math.random() * (BANNERS.length - 1));
      setIndex((current) => (current + step) % BANNERS.length);
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  function openEvent() {
    if (
      window.confirm(
        `외부 링크로 이동합니다.\n메이플스토리 이벤트 페이지를 새 탭에서 엽니다.\n\n${EVENT_URL}`,
      )
    )
      window.open(EVENT_URL, '_blank', 'noopener,noreferrer');
  }

  const banner = BANNERS[index];
  return (
    <div className="hero-banner">
      <button
        type="button"
        className="fake-ad-banner"
        aria-label={
          banner.file === 'ad-2.png'
            ? '스타포스 시뮬레이터로 이동'
            : `${banner.name} 이벤트 페이지 열기 (외부 링크, 새 탭)`
        }
        onClick={() => {
          if (banner.file !== 'ad-2.png') return openEvent();
          onStarforce();
        }}
      >
        <BannerImage
          key={banner.file}
          src={`${import.meta.env.BASE_URL}banners/${banner.file}`}
          name={banner.name}
        />
      </button>
    </div>
  );
}
