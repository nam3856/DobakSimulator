import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Run only when refreshing the bundled artwork, never as part of a visitor request/build.
// node --env-file=.env.local scripts/sync-optimizer-avatars.mjs
// Pose reference: https://openapi.nexon.com/ko/support/notice/2715682/
const characters = [
  { name: '깽미니', directory: 'kkangmini' },
  { name: '깽쿤', directory: 'kkangkun' },
  { name: '렌내여친임', directory: 'rennae' },
];
const base = 'https://open.api.nexon.com/maplestory/v1';
const destination = new URL('../public/character/optimizer/', import.meta.url);
const snapshot = JSON.parse(
  await readFile(new URL('../public/character/snapshot.json', import.meta.url), 'utf8'),
);
const key = process.env.NEXON_API_KEY?.trim();

async function request(path) {
  if (!key) throw new Error('NEXON_API_KEY 환경 변수를 설정해 주세요.');
  const response = await fetch(`${base}${path}`, {
    headers: { 'x-nxopen-api-key': key },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`캐릭터 이미지 조회에 실패했습니다. (HTTP ${response.status})`);
  return response.json();
}

function imageUrl(url, frame) {
  const result = new URL(url);
  if (result.protocol !== 'https:' || result.hostname !== 'open.api.nexon.com')
    throw new Error('캐릭터 이미지 주소가 올바르지 않습니다.');
  for (const [name, value] of Object.entries({
    action: `A02.${frame}`,
    emotion: 'E00.0',
    width: '240',
    height: '200',
    x: '120',
    y: '150',
  }))
    result.searchParams.set(name, value);
  return result;
}

try {
  const assets = [];
  for (const character of characters) {
    let url;
    if (snapshot.name === character.name) url = snapshot.imageUrl;
    else {
      const id = await request(`/id?character_name=${encodeURIComponent(character.name)}`);
      if (typeof id.ocid !== 'string' || !id.ocid)
        throw new Error(`${character.name}: 캐릭터를 찾을 수 없습니다.`);
      const basic = await request(`/character/basic?ocid=${encodeURIComponent(id.ocid)}`);
      url = basic.character_image;
    }
    for (const frame of [1, 2, 3]) {
      const response = await fetch(imageUrl(url, frame), { signal: AbortSignal.timeout(20_000) });
      if (!response.ok)
        throw new Error(
          `${character.name}: 걷기 이미지 조회에 실패했습니다. (HTTP ${response.status})`,
        );
      const bytes = Buffer.from(await response.arrayBuffer());
      if (
        bytes.length < 24 ||
        bytes.length > 5_000_000 ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ||
        bytes.readUInt32BE(16) !== 300 ||
        bytes.readUInt32BE(20) !== 300
      )
        throw new Error(`${character.name}: 걷기 이미지가 예상한 300×300 PNG가 아닙니다.`);
      assets.push({
        path: new URL(`${character.directory}/walk-${frame}.png`, destination),
        bytes,
      });
    }
  }
  // Fetch and validate everything before replacing any existing artwork.
  for (const asset of assets) {
    await mkdir(fileURLToPath(new URL('./', asset.path)), { recursive: true });
    await writeFile(asset.path, asset.bytes);
  }
  await writeFile(
    new URL('manifest.json', destination),
    `${JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        source: 'https://openapi.nexon.com/ko/support/notice/2715682/',
        action: 'walk1',
        // Nexon's renderer currently returns a 300×300 canvas even when requesting 240×200.
        imageSize: { width: 300, height: 300 },
        frameOrder: [1, 2, 3, 2],
        characters: characters.map((character) => ({
          name: character.name,
          frames: [1, 2, 3].map((frame) => `${character.directory}/walk-${frame}.png`),
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `걷기 이미지 ${assets.length}개를 저장했습니다. 런타임 캐릭터 API 요청은 필요 없습니다.`,
  );
} catch (error) {
  // Never print headers, raw API responses, OCIDs, or errors containing request URLs.
  console.error(
    error instanceof Error && !error.message.includes('fetch')
      ? error.message
      : '걷기 이미지를 저장하지 못했습니다. 네트워크 연결을 확인해 주세요.',
  );
  process.exitCode = 1;
}
