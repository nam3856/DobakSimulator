# 기능별 검색 유입과 랜딩페이지

## 공개 주소

| 검색 의도                       | 정적 안내 페이지                                 | 실행 주소                            |
| ------------------------------- | ------------------------------------------------ | ------------------------------------ |
| 큐브 시뮬레이터                 | `/DobakSimulator/simulators/cube/`               | `/DobakSimulator/#cube`              |
| 어빌리티 고급 재설정 시뮬레이터 | `/DobakSimulator/simulators/ability/`            | `/DobakSimulator/#ability`           |
| 소울 증폭 시뮬레이터            | `/DobakSimulator/simulators/soul-amplification/` | `/DobakSimulator/#soulAmplification` |
| 소울 잠재 시뮬레이터            | `/DobakSimulator/simulators/soul-potential/`     | `/DobakSimulator/#soulPotential`     |

호스트는 `https://nam3856.github.io`입니다. `#ability`는 고급 재설정이며 일반 재설정 주소 `#abilityNormal`과 구분합니다.

어빌리티 최적화 안내는 `/DobakSimulator/simulators/ability-optimizer/`, 실행 주소는 `/DobakSimulator/#abilityOptimizer`입니다.

랜딩페이지에서 카드의 제목·설명·빈 영역을 누르면 해당 기능이 선택됩니다. 키보드는 각 카드의 선택 버튼을 사용합니다. 닉네임은 선택사항이며 입력한 값의 앞뒤 공백을 제거한 뒤 `?character=닉네임#기능` 주소로 전달합니다. 카드의 바로가기와 선택한 기능의 시작 버튼 모두 같은 닉네임을 사용하고, 입력란의 Enter로도 선택한 기능을 시작할 수 있습니다. 어빌리티 최적화는 기존 흐름에 따라 시작 화면에서 ‘시작하기’를 누른 뒤 캐릭터를 조회합니다. 닉네임 입력만으로 API를 조회하거나 별도로 저장하지 않습니다.

각 안내 페이지는 해당 기능의 사용 순서와 비용 계산 범위를 설명하는 독립 HTML입니다. JavaScript 없이도 제목·본문·실행 링크를 읽을 수 있고 직접 요청과 새로고침에 정상 응답합니다. 검색용 title, description, canonical, Open Graph/Twitter, 구조화 데이터는 초기 HTML에 포함합니다. 실행 버튼은 기존 앱의 지정 탭으로 이동하며 자동 리디렉션하지 않습니다.

랜딩페이지와 실행 앱의 이용 안내에서 다섯 개의 안내 페이지를 실제 링크로 연결합니다. 사이트맵에는 대표 HTML 주소만 넣고 탭 해시·캐릭터 쿼리 주소는 넣지 않습니다. 검색 결과 노출이나 순위를 보장하는 설정은 없습니다. 관련성 있는 본문과 링크, 고유 주소는 검색엔진이 내용을 발견하고 이해하도록 돕습니다.

## 로컬 검증

```powershell
npm.cmd run build
npx.cmd playwright test tests/e2e/seo-landing.spec.ts tests/e2e/metadata-sharing.spec.ts tests/e2e/navigation.spec.ts
```

테스트 서버는 `/`에서 `site-root/`, `/DobakSimulator/`에서 실제 `dist/` 빌드를 제공합니다. 모바일에서 기능 선택과 실제 탭 이동, 작은 화면의 가로 넘침, JavaScript 없는 링크, 정적 메타 정보와 사이트맵을 확인합니다. 수동 확인은 `node scripts/serve-test.mjs` 실행 후 `http://127.0.0.1:4173/`에서 진행합니다.

## 배포와 색인 확인

1. `DobakSimulator` 저장소를 기존 GitHub Pages 절차로 배포합니다. 다섯 개의 안내 페이지는 `public/`에서 `dist/`로 복사되므로 별도의 서버 라우팅은 필요하지 않습니다.
2. `site-root/`의 홈페이지 변경과 사이트맵을 별도 `nam3856/nam3856.github.io` 저장소에 반영해 배포합니다. 앱 배포만으로 도메인 루트가 바뀌지는 않습니다. 새 안내 페이지를 먼저 배포하면 랜딩페이지에서 깨진 링크가 노출되는 시간을 피할 수 있습니다.
3. 공개 주소 다섯 개에서 HTTP 200, 자기 주소를 가리키는 canonical, 스타일·아이콘 로딩과 실행 버튼을 확인합니다.
4. Google Search Console에서 `https://nam3856.github.io/sitemap.xml` 또는 `https://nam3856.github.io/DobakSimulator/sitemap.xml`을 제출하고, URL 검사로 다섯 개의 안내 페이지의 크롤링·색인 상태를 확인합니다. 계정 소유자만 수행할 수 있는 제출 작업은 코드 변경에 포함되지 않습니다.
5. 네이버 검색 유입도 관리하려면 사이트 소유자의 Search Advisor에서 도메인 소유 확인과 같은 사이트맵 제출을 진행합니다. 확인 토큰은 해당 계정에서 발급받은 실제 값만 사용합니다.

검색 반영에는 시간이 걸리며 색인 및 순위는 검색엔진이 결정합니다. 메타 정보나 구조화 데이터가 특정 검색 결과 표시 형식을 보장하지 않습니다.

## 참고

- [Google JavaScript SEO 기본 가이드](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics): 콘텐츠별 해시 주소 대신 크롤링 가능한 고유 URL 제공.
- [Google의 크롤링 가능한 링크](https://developers.google.com/search/docs/crawling-indexing/links-crawlable): 실제 `a href` 링크와 설명적인 링크 텍스트.
- [Google SEO 기본 가이드](https://developers.google.com/search/docs/fundamentals/seo-starter-guide): 유용한 본문과 검색 노출·반영 시간의 한계.
- [네이버 사이트 등록 및 소유확인](https://searchadvisor.naver.com/guide/faq-start-register), [사이트맵 제출](https://searchadvisor.naver.com/guide/request-feed): 사이트 소유 확인 후 수집·색인 상태 확인과 사이트맵 제출.
