#!/usr/bin/env node
/** Rebuild normal KMS Star Force rules from frozen official sources and explicitly beta cost data. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanHtmlText, sha256 } from './rules-cube-helpers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, 'public/rules/snapshots/starforce');
const offline = process.argv.includes('--offline');
const checkedAt = '2026-09-18';
const sources = {
  guide: {
    url: 'https://maplestory.nexon.com/Guide/N23GameInformation/Articles/412',
    file: 'guide-412.html.gz',
  },
  update2025: { url: 'https://maplestory.nexon.com/News/Update/767', file: 'update-767.html.gz' },
  update2026: { url: 'https://maplestory.nexon.com/News/Update/799', file: 'update-799.html.gz' },
  lowStarProbabilities: {
    url: 'https://archive.maplestory.nexon.com/News/ProbabilityResult/MonthData/20240215',
    file: 'probabilities-20240215.html.gz',
  },
  starCatchMultiplier: {
    url: 'https://maplestory.nexon.com/News/Notice/All/133192',
    file: 'notice-133192.html.gz',
  },
  mvp: {
    url: 'https://maplestory.nexon.com/Guide/N23GameInformation/Articles/425',
    file: 'guide-425.html.gz',
  },
  pcRoom: {
    url: 'https://maplestory.nexon.com/Guide/N23GameInformation/Articles/444',
    file: 'guide-444.html.gz',
  },
  shining: {
    url: 'https://maplestory.nexon.com/News/Event/Closed/1377',
    file: 'event-1377.html.gz',
  },
};
await mkdir(directory, { recursive: true });
const html = {};
await Promise.all(
  Object.entries(sources).map(async ([key, source]) => {
    let bytes;
    if (offline) bytes = gunzipSync(await readFile(join(directory, source.file)));
    else {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(join(directory, source.file), gzipSync(bytes));
    }
    html[key] = bytes.toString('utf8');
    source.snapshot = `snapshots/starforce/${source.file}`;
    source.sha256 = sha256(bytes);
    source.checkedAt = checkedAt;
    delete source.file;
  }),
);
// The current event's three benefits are published in an image, not HTML text.
// Its fixed hash records the exact image visually checked on 2026-09-18.
const shiningImageUrl =
  'https://lwi.nexon.com/maplestory/2026/0820_board/290906_6A29969365697B3F.png';
const shiningImageFile = 'event-1377.png.gz';
if (!html.shining.includes('290906_6A29969365697B3F.png'))
  throw new Error('Official Shining event image changed. Recheck its stated benefits.');
let shiningImage;
if (offline) shiningImage = gunzipSync(await readFile(join(directory, shiningImageFile)));
else {
  const response = await fetch(shiningImageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Shining event image: HTTP ${response.status}`);
  shiningImage = Buffer.from(await response.arrayBuffer());
}
const shiningImageHash = sha256(shiningImage);
if (shiningImageHash !== '71e52ffbe200876c60ca09bc319e76ca808adf6de2640de6b17a8648f8546d73')
  throw new Error('Official Shining event image content changed. Recheck its stated benefits.');
if (!offline) await writeFile(join(directory, shiningImageFile), gzipSync(shiningImage));
const referenceBytes = gunzipSync(await readFile(join(directory, 'jijakbi-reference.json.gz')));
const verificationBytes = gunzipSync(
  await readFile(join(directory, 'jijakbi-cost-verification.json.gz')),
);
const reference = JSON.parse(referenceBytes);
const verification = JSON.parse(verificationBytes);
const text = Object.fromEntries(
  Object.entries(html).map(([key, value]) => [key, cleanHtmlText(value)]),
);
function requireText(source, statements) {
  for (const statement of statements)
    if (!text[source].includes(statement))
      throw new Error(`Official ${source} changed: ${statement}`);
}
requireText('guide', [
  'Lv138 ~',
  '30성',
  '15성~17성',
  '모든 단계에서 강화 시도 시',
  '동일한 장비 아이템 하나',
  '12성으로 복구 가능',
]);
requireText('update2025', [
  '스타포스 15성 이상에서 강화 실패 시 강화 단계가 하락하지 않게',
  '기본 메소의 100%에서 200%로 증가',
  '21성 이하에서 스타포스 강화 시 파괴 확률 30% 감소',
]);
requireText('update2026', [
  '스타캐치가 삭제되며',
  '항상 적용',
  '23성 이상 강화 도중 파괴될 경우 22성',
  '슈페리얼 장비 아이템의 경우 변경 사항이 적용되지 않고 최대 0성',
]);
requireText('starCatchMultiplier', ['1.05']);

function tables(source) {
  return [...html[source].matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map((match) => match[1]);
}
function rows(table) {
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cleanHtmlText(cell[1])),
  );
}
const percent = (value) => Number(value.replace('%', '')) / 100;
const rounded = (value) => Number(value.toFixed(12));
const lowTable = tables('lowStarProbabilities').find((table) =>
  cleanHtmlText(table).startsWith('파괴방지 X, 스타캐치 O'),
);
if (!lowTable) throw new Error('Non-event configured low-star probability table missing.');
const transitions = rows(lowTable)
  .filter((row) => row.length === 13 && /^\d+$/.test(row[0]) && Number(row[0]) < 15)
  .map((row) => ({
    star: Number(row[0]),
    successProbability: percent(row[5]),
    maintainProbability: percent(row[11]),
    decreaseProbability: percent(row[2]),
    destroyProbability: percent(row[8]),
    successStar: Number(row[0]) + 1,
  }));
const highTable = tables('update2025').find((table) =>
  cleanHtmlText(table).startsWith('강화 단계 성공 확률 실패(유지) 확률 파괴 확률'),
);
if (!highTable) throw new Error('2025 normal Star Force probability table missing.');
for (const row of rows(highTable).filter((row) => row.length === 4 && /^\d+성$/.test(row[0]))) {
  const star = Number(row[0].replace('성', ''));
  const oldSuccess = percent(row[1]);
  const successProbability = rounded(oldSuccess * 1.05);
  const destroyProbability = rounded(
    (percent(row[3]) * (1 - successProbability)) / (1 - oldSuccess),
  );
  transitions.push({
    star,
    successProbability,
    maintainProbability: rounded(1 - successProbability - destroyProbability),
    decreaseProbability: 0,
    destroyProbability,
    successStar: star + 1,
    traceStar: Math.min(star, 22),
  });
}
if (transitions.length !== 30 || transitions.some((row, index) => row.star !== index))
  throw new Error('Expected 30 consecutive probability rows.');
for (const row of transitions) {
  const legacy = reference.transitions[row.star];
  for (const key of [
    'successProbability',
    'maintainProbability',
    'decreaseProbability',
    'destroyProbability',
  ])
    if (Math.abs(row[key] - legacy[key]) > 1e-12)
      throw new Error(`Independent JIJAKBI transition differs at ${row.star}: ${key}`);
  if (
    Math.abs(
      row.successProbability +
        row.maintainProbability +
        row.decreaseProbability +
        row.destroyProbability -
        1,
    ) > 1e-12
  )
    throw new Error(`Probability sum differs at ${row.star}.`);
}
const caps = tables('guide').find((table) =>
  cleanHtmlText(table).startsWith('장비 레벨 구간 적용 가능한 최대 스타포스 수치'),
);
const parsedCaps = rows(caps)
  .filter((row) => row.length === 2 && /성$/.test(row[1]))
  .map((row) => Number(row[1].replace('성', '')));
if (
  JSON.stringify(parsedCaps) !==
  JSON.stringify(reference.maximumStarBands.map((band) => band.maximumStar))
)
  throw new Error('Level caps differ.');
const restoreTable = tables('guide').find((table) =>
  cleanHtmlText(table).startsWith('흔적 아이템 스타포스 수치 복구 시 필요한 장비 아이템 개수'),
);
if (
  JSON.stringify(
    rows(restoreTable)
      .slice(1)
      .map((row) => Number(row[1].replace('개', ''))),
  ) !== '[1,2,3,4]'
)
  throw new Error('Restore equipment counts changed.');

const rules = {
  ...reference,
  ruleId: 'kms-starforce-2026-09-17-beta-costs',
  version: 'official-probability-beta-costs-v1',
  effectiveDate: '2026-09-17',
  checkedAt,
  sourceUrl: sources.guide.url,
  status: 'beta-costs',
  probabilityStatus: 'official',
  costStatus: 'jijakbi-cross-validated-beta',
  scope: {
    equipment: 'normal',
    supported: ['normal'],
    excluded: ['superior', 'amazing-enhancement-scroll', 'fixed-star-equipment'],
    note: '슈페리얼은 별도 하락·파괴 규칙이며 확인된 확률·비용 자료가 없어 계산하지 않습니다.',
  },
  minimumLevel: 1,
  maximumLevel: 250,
  maximumStarBands: reference.maximumStarBands.map((band) => ({
    ...band,
    maximumLevel: Math.min(250, band.maximumLevel),
  })),
  mechanics: {
    normalDecrease: false,
    chanceTime: false,
    starCatchAvailable: false,
    automaticStarCatchIncluded: true,
    maximumTraceStar: 22,
    normalRuleEffectiveFrom: '2025-03-20',
    restorationEffectiveFrom: '2026-03-19',
  },
  transitions,
  // This exact three-effect bundle is confirmed by the 2026-09-06 official event image.
  events: reference.events.filter((event) =>
    ['none', 'costDiscount30', 'destroyReduction30', 'shiningWithout1516'].includes(event.id),
  ),
  shiningEvidence: {
    pageUrl: sources.shining.url,
    imageUrl: shiningImageUrl,
    snapshot: `snapshots/starforce/${shiningImageFile}`,
    sha256: shiningImageHash,
    checkedAt,
    eventDate: '2026-09-06',
    verifiedEffects: [
      '강화 비용 30% 할인, 파괴 방지 추가 비용 제외',
      '21성 이하 강화 시 파괴 확률 30% 감소',
      '흔적 복구 메소 20% 할인',
      '5/10/15성 확정 성공 없음',
      '슈페리얼 제외',
    ],
  },
  sources,
  costProvenance: {
    status: 'beta',
    sourceProject: 'JIJAKBI',
    sourceFile: 'rules/starforce.json',
    sourceRuleId: reference.ruleId,
    snapshot: 'snapshots/starforce/jijakbi-reference.json.gz',
    sha256: sha256(referenceBytes),
    verificationSnapshot: 'snapshots/starforce/jijakbi-cost-verification.json.gz',
    verificationSha256: sha256(verificationBytes),
    crossValidationSource: verification.source,
    crossValidationCheckedAt: verification.retrievedAt,
    officialStaticCostTableAvailable: false,
    note: '강화 비용 공식과 단계 보존 복구 메소는 JIJAKBI의 beta 자료를 이식했습니다. 공식 확률표와 구분하며 미등록 레벨의 단계 보존 복구 비용은 보간하지 않습니다.',
  },
  normalization: {
    lowStars:
      '공식 2024-02-15 이벤트 미적용·스타캐치 성공 표의 설정 확률 0~14성을 사용합니다. 실제 관측 비율은 사용하지 않습니다.',
    highStars:
      '공식 2025-03-20 표에 2026-03-19 상시 적용된 기존 스타캐치 배율을 반영합니다: 성공=기존성공×1.05, 파괴=기존파괴×(1−새성공)/(1−기존성공), 유지=1−성공−파괴.',
    validation: '공식 원문으로 재구성한 30개 전이를 JIJAKBI 독립 스냅샷과 1e-12 이내로 대조합니다.',
    costRounding:
      '기본 비용과 할인·파괴 방지 적용 후 비용은 100메소 단위 반올림(round half up)합니다.',
  },
};
await writeFile(join(root, 'public/rules/starforce.json'), `${JSON.stringify(rules, null, 2)}\n`);
console.log(
  `Star Force: ${transitions.length} official normal transitions; ${rules.restoration.fullRestoreBands.length} beta restoration rows; ${Object.keys(sources).length} official snapshots verified.`,
);
