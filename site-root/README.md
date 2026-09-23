# 이세계 직작 루트 홈페이지

`https://nam3856.github.io/`에서 시뮬레이터로 안내하는 정적 홈페이지의 원본입니다. 공개 사이트는 별도 저장소 `nam3856/nam3856.github.io`의 `main` 브랜치에서 배포합니다. 이 폴더를 수정한 뒤에는 해당 저장소에도 변경 파일을 반영해야 합니다.

## 구성

- `index.html`: 단풍잎 아이콘, 서비스 소개, 기능별 인터랙티브 진입 요소와 시뮬레이터 바로가기. 실제 링크로 연결하며 자동 이동하지 않습니다.
- `brand-icon.png`: 본문과 공유 미리보기에 사용하는 256×256 아이콘.
- `favicon.png` (96×96), `favicon-32.png` (32×32), `favicon.ico`: 브라우저와 검색용 파비콘.
- `apple-touch-icon.png`: 180×180 홈 화면 아이콘.
- `sitemap.xml`: 루트 홈페이지·시뮬레이터 실행 페이지·다섯 가지 기능별 안내 페이지의 대표 주소.
- `robots.txt`: 크롤링을 허용하고 루트 사이트맵 주소를 안내합니다.
- `.nojekyll`: 정적 파일을 그대로 게시하기 위한 GitHub Pages 설정 파일.

아이콘 이미지는 시뮬레이터와 같은 브랜드 파일을 복사해 사용합니다. HTML의 이미지 경로는 상대 경로여서 이 폴더를 루트로 여는 로컬 서버에서도 확인할 수 있습니다.

## 로컬 미리보기

프로젝트 루트에서 실행합니다.

```powershell
npm.cmd run dev:root
```

`http://127.0.0.1:5174/`에서 디자인을 확인합니다. 시뮬레이터 연결은 같은 호스트의 `/DobakSimulator/` 경로를 사용합니다. 실제 앱까지 로컬 이동하려면 프로젝트 루트에서 `npm.cmd run build` 후 `node scripts/serve-test.mjs`를 실행하고 `http://127.0.0.1:4173/`을 여세요.

## 배포 위치

GitHub의 사용자 홈페이지는 **`nam3856/nam3856.github.io`** 저장소에서 게시해야 합니다. 배포 시에는 이 폴더의 내용과 아이콘 파일들을 해당 저장소의 루트에 넣고, GitHub Pages의 게시 소스를 설정합니다. 예를 들어 `main` 브랜치의 `/ (root)`를 게시 소스로 사용할 수 있습니다. 기존 `DobakSimulator` 저장소의 Vite 빌드는 이 폴더를 배포하지 않습니다.

루트 홈페이지의 canonical은 `https://nam3856.github.io/`, 시뮬레이터의 canonical은 `https://nam3856.github.io/DobakSimulator/`입니다. 루트 사이트맵에는 이 두 주소와 `/DobakSimulator/simulators/` 아래 `cube/`, `ability/`, `ability-optimizer/`, `soul-amplification/`, `soul-potential/` 안내 페이지를 포함합니다. 각 안내 페이지는 자기 주소를 canonical로 사용합니다. 탭의 해시 주소와 캐릭터별 쿼리 주소는 넣지 않습니다. 기존 프로젝트 사이트맵은 `https://nam3856.github.io/DobakSimulator/sitemap.xml`에서 계속 사용할 수 있습니다. 다섯 개의 안내 페이지는 이 폴더가 아니라 `DobakSimulator` 저장소의 `public/simulators/`에서 배포합니다.

루트 파비콘은 `https://nam3856.github.io/favicon.png` 등에서 제공됩니다. Google은 홈페이지의 아이콘 선언을 읽고 호스트 단위로 파비콘을 처리하므로 루트 페이지에도 같은 PNG를 선언합니다. 검색 결과 반영 여부와 시점은 크롤링에 따라 달라집니다.

배포 후 확인할 주소는 `/`, `/favicon.png`, `/favicon-32.png`, `/favicon.ico`, `/apple-touch-icon.png`, `/brand-icon.png`, `/sitemap.xml`, `/robots.txt`입니다.

참고: [GitHub Pages 사이트 종류](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [Google 사이트맵 작성](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), [Google robots.txt 위치](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt), [Google 검색용 파비콘](https://developers.google.com/search/docs/appearance/favicon-in-search).
