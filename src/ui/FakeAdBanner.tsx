import { useEffect, useState } from 'react';

const EVENT_URL = 'https://maplestory.nexon.com/News/Event/Ongoing/1389';
const AUCTION_URL = 'https://auction.maplestory.nexon.com/';

const BANNERS = [
  { file: 'ad-1.png', name: '메이플스토리 경매장' },
  { file: 'ad-2.png', name: '스타포스 지금 누르러 가기' },
  { file: 'ad-3.png', name: '메이플스토리 헬스장' },
  { file: 'ad-4.png', name: '메이플스토리 연애 시뮬레이터' },
];

// Clickable regions in the original 1028 × 382 banner image.
const YOUTUBE_LINKS = [
  {
    name: '키다리아저씨 고르기',
    href: 'https://www.youtube.com/@maplehooni',
    x: 196,
    y: 287,
    width: 290,
    height: 38,
  },
  {
    name: '남사친의정석 고르기',
    href: 'https://www.youtube.com/@%EB%95%A1',
    x: 583,
    y: 287,
    width: 290,
    height: 38,
  },
  {
    name: '메이플스토리 연애 시뮬레이터 영상 열기',
    href: 'https://www.youtube.com/watch?v=IP4RacpJHu0',
    x: 0,
    y: 337,
    width: 1028,
    height: 45,
  },
];

function BannerImage({
  src,
  name,
  width = 1028,
  height = 382,
}: {
  src: string;
  name: string;
  width?: number;
  height?: number;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="fake-ad-fallback">배너 이미지를 불러오지 못했어요.</span>
  ) : (
    <img
      src={src}
      alt={`${name} 패러디 광고`}
      width={width}
      height={height}
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
  const bannerImage = (
    <BannerImage
      key={banner.file}
      src={`${import.meta.env.BASE_URL}banners/${banner.file}${banner.file === 'ad-1.png' ? '?v=2' : ''}`}
      name={banner.name}
      width={banner.file === 'ad-1.png' ? 2057 : 1028}
      height={banner.file === 'ad-1.png' ? 764 : 382}
    />
  );

  return (
    <div className="hero-banner">
      {banner.file === 'ad-1.png' ? (
        <a
          className="fake-ad-banner"
          href={AUCTION_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="메이플스토리 경매장 열기 (외부 링크, 새 탭)"
        >
          {bannerImage}
        </a>
      ) : banner.file === 'ad-4.png' ? (
        <div className="fake-ad-banner" role="group" aria-label={banner.name}>
          {bannerImage}
          {YOUTUBE_LINKS.map((link) => (
            <a
              key={link.href}
              className="fake-ad-link"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${link.name} (유튜브, 새 탭)`}
              title={`${link.name} (유튜브, 새 탭)`}
              style={{
                left: `${(link.x / 1028) * 100}%`,
                top: `${(link.y / 382) * 100}%`,
                width: `${(link.width / 1028) * 100}%`,
                height: `${(link.height / 382) * 100}%`,
              }}
            />
          ))}
        </div>
      ) : (
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
          {bannerImage}
        </button>
      )}
    </div>
  );
}
