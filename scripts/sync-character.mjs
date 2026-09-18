import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getCharacter } from '../src/character/client.ts';
import { buildAvatarUrl, AVATAR_POSES } from '../src/character/avatar.ts';

// Run with NEXON_API_KEY in the environment, or node --env-file=<private file>.
// Credentials and raw API responses are intentionally never written or logged.
const name = process.argv[2] || '깽미니';
const key = process.env.NEXON_API_KEY;
if (!key) {
  console.error('NEXON_API_KEY 환경 변수를 설정한 후 다시 실행해 주세요.');
  process.exitCode = 1;
} else {
  try {
    const snapshot = await getCharacter(name, key);
    const destination = fileURLToPath(new URL('../public/character/', import.meta.url));
    await mkdir(destination, { recursive: true });
    for (const reaction of Object.keys(AVATAR_POSES)) {
      const url = buildAvatarUrl(snapshot.imageUrl, reaction);
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`캐릭터 ${reaction} 이미지를 불러오지 못했습니다.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length < 8 || bytes.length > 5_000_000 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) {
        throw new Error('캐릭터 이미지가 올바른 PNG 형식이 아닙니다.');
      }
      await writeFile(new URL(`../public/character/${reaction}.png`, import.meta.url), bytes);
    }
    await writeFile(new URL('../public/character/snapshot.json', import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`${snapshot.name}: 캐릭터 프리셋과 표정 이미지 ${Object.keys(AVATAR_POSES).length}종을 갱신했습니다. (${snapshot.fetchedAt})`);
  } catch (error) {
    // Never print request headers, HTTP bodies, stack traces or identifiers.
    console.error(error instanceof Error ? error.message : '캐릭터 갱신에 실패했습니다.');
    process.exitCode = 1;
  }
}
