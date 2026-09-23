import { characterShareHeadline } from '../share-metadata';

const SITE_TITLE = '이세계 직작 — 메이플스토리 통합 강화 시뮬레이터';
const SITE_DESCRIPTION =
  '메이플스토리 큐브·어빌리티 고급 재설정·소울 증폭·소울 잠재 시뮬레이터. 내 캐릭터로 목표까지의 비용과 기댓값을 비교하고 추가옵션·스타포스도 체험하는 통합 강화 시뮬레이터입니다.';
const SITE_URL = 'https://nam3856.github.io/DobakSimulator/';

/** Browser metadata supplements the server-rendered cards at /share. */
export function updateCharacterMetadata(name?: string, shareUrl?: string) {
  const headline = name ? characterShareHeadline(name) : undefined;
  const title = headline ? `${headline} | 이세계 직작` : SITE_TITLE;
  const description = headline
    ? `${headline}. 메이플스토리 큐브·어빌리티·소울·스타포스 강화를 이세계 직작에서 함께 체험해 보세요.`
    : SITE_DESCRIPTION;
  document.title = title;
  for (const [selector, content] of [
    ['meta[name="description"]', description],
    ['meta[property="og:title"]', title],
    ['meta[property="og:description"]', description],
    ['meta[property="og:url"]', name && shareUrl ? shareUrl : SITE_URL],
    ['meta[name="twitter:title"]', title],
    ['meta[name="twitter:description"]', description],
  ]) {
    const meta = document.querySelector<HTMLMetaElement>(selector);
    if (meta) meta.content = content;
  }
}
