# 이세계 직작 아이콘

주황·금색 단풍잎과 작은 강화 빛을 짙은 녹색 타일에 담은 아이콘이다. 내장 `image_gen` 도구로 제작했으며, 원본은 `docs/assets/brand-icon-source.png`에 보관한다. 최종본은 회색 체크무늬 없이 녹색 배경이 모서리까지 이어지는 불투명 PNG다.

공통 아이콘은 `public/brand-icon.png`(256px), 기본 PNG 파비콘은 `public/favicon.png`(96px)이다. 32px PNG, 16·32·48px 프레임의 ICO, 180px Apple touch icon도 같은 원본에서 내보낸다. 사이트 헤더·로딩 화면·하단·닉네임 공유 페이지와 루트 홈페이지가 같은 그림을 사용한다.

크기별 파일을 다시 만들려면 `node scripts/build-brand-icons.mjs`를 실행한다. 도구가 만든 그림을 새로 수정하지 않고 브라우저 Canvas로 각 크기의 PNG를 내보내며, `public/`과 `site-root/` 양쪽에 같은 파일을 저장한다.

## 최초 생성 프롬프트

Use case: logo-brand

Asset type: one square website brand icon, to be used as a tiny browser favicon and a 42px header icon for the Korean MapleStory equipment enhancement simulator '이세계 직작'.

Primary request: Create an original MapleStory-inspired icon with a bold, immediately recognizable warm orange maple leaf and one small magical enhancement sparkle. No text.

Style/medium: polished 2D game UI item icon, very simple clean shapes, warm amber-orange leaf with subtle golden bevel/highlight, dark chocolate outline, gentle nostalgic fantasy RPG feeling. Readable and distinct when reduced to 32x32 or 16x16. This is a finished standalone icon, NOT a mockup or multi-logo sheet.

Composition/framing: square 1024x1024 canvas. Center one large 5-lobed maple leaf filling about 76 percent of the canvas; a very small four-point cream-gold sparkle by the upper right leaf tip. On a deep forest-green rounded-square tile filling the canvas, softly rounded corners. Outside the rounded-square tile must be genuinely transparent. Keep the silhouette crisp and iconic, very restrained detail and shading.

Color palette: bright amber/orange/gold maple leaf against deep forest green #172017, compatible with a dark green website and a light website theme.

Constraints: one icon only, no text, no typography, no letters, no watermark, no official wordmark, no frame around canvas, no scene, no character, no tiny decorative particles, no complex texture, no isometric cube. Preserve a strong silhouette for favicon use.

## 최종 보정 프롬프트

Use case: precise-object-edit. This is the generated website favicon edit target. Make ONE precise design correction: replace the smooth rounded flower-petal silhouette of the orange leaf with a unmistakable real maple-leaf silhouette: five pointed lobes with angular, serrated notches and jagged smaller side tips, like an autumn sugar maple leaf associated with MapleStory. Keep it simple enough to read at 16px. Keep the dark forest-green rounded-square tile, amber and golden orange coloring, golden highlights, small upper-right four-point sparkle, central composition, transparent outside corners, and square canvas otherwise unchanged. Do not add anything else. No text. Output just the finished single icon.

## 투명 배경 보정 프롬프트

Use case: background-extraction. This image is the edit target. Remove the entire gray checkerboard surrounding the dark green rounded-square icon and replace it with GENUINE TRANSPARENCY in the PNG alpha channel. The current checkerboard is baked into the pixels and must be removed, not redrawn. Output a transparent PNG cutout of only the rounded-square icon. Keep EVERY pixel of the dark green tile, angular serrated orange maple leaf, yellow highlights and star sparkle otherwise unchanged. Preserve square composition and dimensions. No new background, no checkerboard pattern anywhere, no fake transparency pattern, no additional border, no text. Outside the rounded-square silhouette must have alpha 0.

## 최종 채택본 프롬프트

투명 배경 보정 결과에도 체크무늬가 남아 다음 요청으로 단색 배경을 적용한 버전을 최종 채택했다.

Change the background ONLY. Replace ALL gray checkerboard around the existing icon with flat solid dark forest green color #172017. The ENTIRE canvas must be opaque: no transparency, no checkerboard, no gray squares, no white margin. Preserve the angular orange maple leaf and its gold sparkle exactly. The final image is an opaque SQUARE app icon with a dark green background extending all the way to all four edges and corners. Do not present a mockup. Just the single square icon artwork. No text. Again: the gray checkerboard is unwanted visual content. Paint the full outer gray checkerboard area solid #172017.
