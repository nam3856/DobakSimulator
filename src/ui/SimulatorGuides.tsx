const guides = [
  ['cube', '큐브 시뮬레이터'],
  ['ability', '어빌리티 고급 재설정 시뮬레이터'],
  ['ability-optimizer', '어빌리티 최적화'],
  ['soul-amplification', '소울 증폭 시뮬레이터'],
  ['soul-potential', '소울 잠재 시뮬레이터'],
] as const;

export function SimulatorGuides() {
  return (
    <nav className="simulator-guides" aria-label="시뮬레이터 이용 안내">
      <h2>시뮬레이터 이용 안내</h2>
      <p>기능별 사용 방법과 비용 계산 범위를 확인하세요.</p>
      <ul>
        {guides.map(([slug, title]) => (
          <li key={slug}>
            <a href={`${import.meta.env.BASE_URL}simulators/${slug}/`}>{title}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
