import { TABS } from '../src/ui/constants.ts';
import { characterShareHeadline } from '../src/share-metadata.ts';

const SITE_URL = 'https://nam3856.github.io/DobakSimulator/';
const PREVIEW_IMAGE_URL = `${SITE_URL}social-preview.png`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

/** A crawlable share card; visiting it opens the existing static simulator. */
export function handleShareRequest(request: Request): Response {
  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, follow',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  const response = (body: string, status = 200) =>
    new Response(request.method === 'HEAD' ? null : body, { status, headers });

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    headers.set('Allow', 'GET, HEAD');
    headers.set('Cache-Control', 'no-store');
    return response('공유 링크는 GET 또는 HEAD 요청만 지원합니다.', 405);
  }

  const url = new URL(request.url);
  const names = url.searchParams.getAll('character');
  const nickname = names[0]?.trim() ?? '';
  if (names.length !== 1 || [...nickname].length > 20 || !/^[\p{L}\p{N}]+$/u.test(nickname)) {
    headers.set('Cache-Control', 'no-store');
    return response('닉네임은 한글·영문·숫자 등 문자와 숫자 1~20자로 입력해 주세요.', 400);
  }

  const requestedMode = url.searchParams.get('mode');
  const mode = TABS.find((tab) => tab.id === requestedMode)?.id ?? 'cube';
  const destination = new URL(SITE_URL);
  destination.searchParams.set('character', nickname);
  destination.hash = mode;
  const shareUrl = new URL('/share', url.origin);
  shareUrl.searchParams.set('character', nickname);
  shareUrl.searchParams.set('mode', mode);

  const invitation = characterShareHeadline(nickname);
  const title = `${invitation} | 이세계 직작`;
  const description = `${invitation}. 메이플스토리 통합 강화 시뮬레이터에서 큐브·추가옵션·스타포스·어빌리티·소울 강화를 체험해 보세요.`;
  // Never let a value close this script, even if nickname rules later change.
  const redirectScriptUrl = JSON.stringify(destination.href).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

  return response(`<!doctype html>
<html lang="ko" prefix="og: https://ogp.me/ns#">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, follow" />
    <title>${escapeHtml(title)}</title>
    <link rel="icon" type="image/png" sizes="96x96" href="${SITE_URL}favicon.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="${SITE_URL}apple-touch-icon.png" />
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${SITE_URL}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="ko_KR" />
    <meta property="og:site_name" content="이세계 직작" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(shareUrl.href)}" />
    <meta property="og:image" content="${PREVIEW_IMAGE_URL}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="이세계 직작 · 메이플스토리 통합 강화 시뮬레이터" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${PREVIEW_IMAGE_URL}" />
    <meta name="twitter:image:alt" content="이세계 직작 · 메이플스토리 통합 강화 시뮬레이터" />
  </head>
  <body>
    <h1>${escapeHtml(invitation)}</h1>
    <p>${escapeHtml(description)}</p>
    <p><a href="${escapeHtml(destination.href)}">시뮬레이터에서 강화하기</a></p>
    <script>window.location.replace(${redirectScriptUrl});</script>
  </body>
</html>`);
}
