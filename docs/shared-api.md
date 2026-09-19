# 공용 키로 캐릭터 검색

방문자는 닉네임만 입력하고, Nexon 키는 운영자의 서버에서 사용합니다. 화면·시뮬레이션은 기존 GitHub Pages에서 실행하며, 캐릭터 검색과 공유 미리보기는 Cloudflare Worker가 제공합니다.

```text
브라우저 → 공용 Worker /api/character?name=닉네임 → Nexon Open API
            서버 Secret의 키로 조회              기본·장비·어빌리티
브라우저 ← 정규화한 캐릭터 스냅샷
```

운영자 키는 `NEXON_API_KEY` Secret에만 등록합니다. 프런트엔드에는 공개 가능한 서버 주소만 설정합니다. 개인 키 검색도 선택할 수 있으며, 이 키는 Worker를 거치지 않고 기존처럼 Nexon에 직접 전송됩니다.

## 무료 운영 범위

2026-09-17 확인 기준 [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/)는 하루 100,000 요청, 요청당 CPU 10ms를 제공합니다. [무료 일일 한도 초과 시](https://developers.cloudflare.com/workers/platform/limits/#daily-requests) 요청이 차단됩니다. 서버에서 확률 계산은 하지 않으며, Nexon 응답을 기다리는 시간은 CPU 사용 시간이 아닙니다. 무료 플랜에서 운영하고 별도 유료 플랜을 선택할 필요는 없습니다. Nexon API 자체의 키별 호출 한도·권한은 별도로 적용됩니다.

현재 Worker는 IP당 분당 20회 검색 제한을 둡니다. Cloudflare [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) 카운터는 각 지역에서 근사적으로 적용되며 전 세계 요청 총량을 보장하는 과금 상한은 아닙니다. 동일 IP를 쓰는 방문자는 제한을 공유합니다. CORS는 브라우저 허용 출처 설정이며 사용자 인증 수단은 아닙니다.

## 처음 배포

Cloudflare 무료 계정을 만들고 **계정 이메일 인증까지 완료한 뒤** 프로젝트 폴더에서 실행합니다. 가입 메일의 인증 링크를 열고, 대시보드 My Profile에서 이메일에 `(verified)`가 표시되는지 확인합니다. 인증 메일이 없으면 같은 화면에서 다시 보낼 수 있습니다. [Cloudflare 이메일 인증 안내](https://developers.cloudflare.com/fundamentals/user-profiles/verify-email-address/)

```sh
npm ci
npx wrangler login --scopes account:read user:read workers_scripts:write
npm run api:check
npm run api:deploy
npx wrangler secret put NEXON_API_KEY
```

로그인 시 브라우저에서 연결을 허용합니다. 첫 배포 시 요청되면 `workers.dev` 하위 도메인을 생성합니다. Secret 입력 프롬프트에 운영자 Nexon 키를 입력합니다. Secret은 [Cloudflare 서버의 암호화된 설정](https://developers.cloudflare.com/workers/configuration/secrets/)으로 보관되며 소스·`dist/`·브라우저로 전달되지 않습니다. Cloudflare 대시보드에서 Worker → Settings → Variables and Secrets → Secret으로 추가해도 됩니다.

`wrangler.jsonc`의 `ALLOWED_ORIGINS`에는 실제 사이트 출처를 쉼표로 구분해 넣습니다. 예: `https://nam3856.github.io`. 저장소 경로나 끝의 `/`는 넣지 않습니다. 기본 설정에는 개발용 localhost도 포함합니다. 키를 이 공개 설정 파일의 `vars`에 넣지 마세요.

## 화면 연결

현재 배포된 Worker는 `https://dobak-character-api.isekai-jikjak.workers.dev`이며, [상태 확인 주소](https://dobak-character-api.isekai-jikjak.workers.dev/api/health)는 `/api/health`입니다. `public/app-config.json`에는 다음 공개 주소를 사용합니다.

```json
{
  "characterApiBaseUrl": "https://dobak-character-api.isekai-jikjak.workers.dev/api"
}
```

Worker를 옮길 때는 다음 중 하나로 연결 주소를 변경합니다.

- `public/app-config.json`의 `characterApiBaseUrl`을 새 Worker의 `/api` 주소로 설정하고 Pages를 배포합니다.
- GitHub 저장소의 Actions 변수 `VITE_CHARACTER_API_URL`에 새 주소를 설정합니다. Pages 워크플로가 최종 배포 빌드에 반영합니다.

주소는 **`/api`까지 포함**합니다. `VITE_CHARACTER_API_URL`이 있으면 `app-config.json`보다 우선합니다. 두 값이 비어 있는 정적 사이트는 기존 개인 키 검색을 제공합니다.

Pages 워크플로는 먼저 Actions의 주소 변수를 주입하지 않고 빌드한 뒤 브라우저 테스트를 실행합니다. 테스트는 `app-config.json`과 API 응답을 가로채므로 실제 서버나 키를 사용하지 않습니다. 테스트가 통과하면 `VITE_CHARACTER_API_URL` Actions 변수가 비어 있지 않은 경우에만 해당 값을 넣어 다시 빌드하고, 그 결과를 Pages 배포 파일로 업로드합니다. 변수가 비어 있으면 테스트한 빌드를 그대로 배포하며 `app-config.json`의 주소를 사용합니다.

연결된 사이트의 캐릭터 검색창에는 `공용 검색 · 닉네임만 입력하세요`가 표시됩니다. 호출 한도에 걸리거나 공용 서버에 문제가 있으면 안내를 표시하고 `개인 키로 전환`을 선택할 수 있습니다. 캐릭터는 성공적으로 조회된 경우에만 교체합니다.

## 닉네임 공유 미리보기

캐릭터의 **캐릭터 링크 복사** 버튼은 API와 같은 출처의 `/share?character=닉네임&mode=탭`을 복사합니다. 이 경로는 Nexon API를 호출하지 않고 닉네임을 포함한 Open Graph/Twitter HTML을 반환합니다. 링크 방문자는 JavaScript로 Pages의 캐릭터·탭 주소로 이동하며, JavaScript가 꺼져 있으면 이동 링크가 보입니다. 검색용 대표 주소는 Pages 루트로 고정하고 공유 중간 페이지는 `noindex`로 둡니다.

서버 변경은 `npm run api:check` 후 `npm run api:deploy`로 따로 배포합니다. Pages Actions만으로 Worker가 업데이트되지는 않습니다. 공유 카드 이미지는 Pages의 `social-preview.png`를 사용합니다. 도메인을 이전하면 `index.html`, `public/sitemap.xml`, `server/share-page.ts`, `src/ui/page-metadata.ts`의 대표 URL과 `src/ui/character-link.ts`의 기본 공유 서버 주소도 함께 변경하세요.

## 로컬 개발

`.env.example`을 참고해 Git에서 제외된 `.env.local`에 `NEXON_API_KEY`와 `VITE_CHARACTER_API_URL=http://127.0.0.1:5173/api`를 설정하고 `npm run dev`를 실행합니다. 개발 서버의 포트를 바꾸면 주소의 포트도 맞춥니다. 공개 설정 파일에 배포 서버 주소가 있으므로 이 주소 재정의가 로컬 Vite API를 선택합니다. 공개 서버 주소가 없는 경우에는 `/api/health`로 로컬 API를 자동 연결합니다. `NEXON_API_KEY`는 개발 서버에서만 읽고, `VITE_` 접두사는 공개 서버 주소에만 사용합니다. 최초 설정이나 값 변경 후에는 개발 서버를 다시 실행합니다.

Cloudflare 런타임을 로컬에서 직접 확인하려면 별도의 `.dev.vars`에 Secret을 넣고 `npm run api:dev`를 실행합니다. 이때 프런트엔드 주소는 `VITE_CHARACTER_API_URL=http://127.0.0.1:8787/api`로 지정합니다. `.dev.vars*`, `.env*`, `.wrangler/`는 공개 커밋에서 제외됩니다.

## API와 검증

- `GET /api/health` → `{ "configured": true }`. 키 값은 반환하지 않습니다.
- `GET /api/character?name=깽미니` → `CharacterSnapshot`.
- `GET /share?character=깽미니&mode=cube` → 닉네임 공유 미리보기 HTML. `HEAD`도 지원합니다.
- 검색당 ID, 기본 정보, 장비, 어빌리티의 고정된 Nexon API 4개를 조회합니다. 다른 URL을 지정하는 범용 프록시가 아닙니다.
- 성공 응답은 `no-store`이며 매 검색마다 최신 데이터를 요청합니다. 기존 캐릭터 스냅샷에는 실제 `fetchedAt`이 남습니다.
- 서버 시간 제한은 20초입니다. 잘못된 입력·없는 캐릭터·호출 제한·설정 누락·조회 실패를 처리하며 공급자 원문 오류·키·OCID를 응답에 넣지 않습니다.
- 서버·브라우저 테스트는 모의 응답으로 정상 검색, 개인 키 전환, 오류, 취소, 허용 출처와 요청 제한을 검사합니다. `npm test`, `npm run build`, `npm run test:e2e`, `npm run api:check`로 확인합니다.
