import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { selectSimulator } from './helpers/navigation';
import type { CharacterSnapshot } from '../../src/types';

const ability = JSON.parse(
  readFileSync(new URL('../../public/rules/ability.json', import.meta.url), 'utf8'),
);
const wizard = (page: Page) => page.locator('.optimizer-wizard');
const INTRO_CHARACTERS: Record<string, { job: string; directory: string; types: string[] }> = {
  깽미니: {
    job: '메카닉',
    directory: 'kkangmini',
    types: ['bossDamagePercent', 'statusAilmentDamagePercent', 'attackFlat'],
  },
  깽쿤: {
    job: '레테',
    directory: 'kkangkun',
    types: ['cooldownSkipPercent', 'bossDamagePercent', 'passiveSkillLevel'],
  },
  렌내여친임: {
    job: '렌',
    directory: 'rennae',
    types: ['passiveSkillLevel', 'bossDamagePercent', 'statusAilmentDamagePercent'],
  },
};
const activeAvatar = (page: Page) =>
  page.locator('.optimizer-intro-avatar-layer[data-active="true"]');

async function pauseIntroClock(page: Page) {
  const time = new Date('2026-09-21T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
}

async function configureIntro(page: Page) {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().includes('open.api.nexon.com') ||
      /\/api\/character(?:[/?]|$)/.test(request.url())
    )
      apiRequests.push(request.url());
  });
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: 'https://fixture-api.example/api' } }),
  );
  await page.addInitScript(() => {
    const random = Number(new URL(location.href).searchParams.get('introRandom') ?? '0');
    Math.random = () => random;
  });
  return apiRequests;
}

async function expectLocalIntro(page: Page) {
  const scene = page.locator('.optimizer-intro-scene');
  await expect(scene).toHaveAttribute('aria-hidden', 'true');
  const name = (await scene.getAttribute('data-character'))!;
  expect(Object.keys(INTRO_CHARACTERS)).toContain(name);
  const character = INTRO_CHARACTERS[name];
  await expect(scene).toHaveAttribute('data-job', character.job);
  const frames = activeAvatar(page).locator('img');
  await expect(frames).toHaveCount(3);
  for (const [index, frame] of (await frames.all()).entries()) {
    await expect(frame).toHaveAttribute(
      'src',
      new RegExp(`character/optimizer/${character.directory}/walk-${index + 1}\\.png$`),
    );
    await expect(frame).toHaveJSProperty('naturalWidth', 300);
  }
  await expect(scene.locator('.optimizer-intro-options')).toHaveAttribute(
    'data-current-character',
    name,
  );
  const options = await scene.locator('.optimizer-intro-option').evaluateAll((elements) =>
    elements.map((element) => ({
      name: element.closest('[data-option-character]')?.getAttribute('data-option-character'),
      type: element.getAttribute('data-option-type'),
      text: element.textContent?.trim(),
    })),
  );
  for (const option of options) {
    const owner = INTRO_CHARACTERS[option.name ?? name];
    expect(owner.types).toContain(option.type);
    expect(option.text).toBe(optionLabel(option.type!));
  }
  await expect(scene.locator('.optimizer-intro-character-meta')).toHaveCount(0);
  const visibleText = await scene.innerText();
  for (const [nickname, profile] of Object.entries(INTRO_CHARACTERS)) {
    expect(visibleText).not.toContain(nickname);
    expect(visibleText).not.toContain(profile.job);
  }
  return name;
}

function optionLabel(type: string): string {
  const option = ability.grades.legendary.options.find(
    (row: { type: string }) => row.type === type,
  );
  return option.values.reduce(
    (best: { value: number; label: string }, value: { value: number; label: string }) =>
      value.value > best.value ? value : best,
  ).label;
}

async function openManualStart(page: Page) {
  await page.route('**/app-config.json', (route) =>
    route.fulfill({ json: { characterApiBaseUrl: 'https://fixture-api.example/api' } }),
  );
  await page.goto('./#abilityOptimizer');
  await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'character');
  await page.getByRole('button', { name: '직접 입력할게요', exact: true }).click();
  const types = ['passiveSkillLevel', 'bossDamagePercent', 'criticalRatePercent'];
  for (const [index, type] of types.entries()) {
    const option = ability.grades.legendary.options.find(
      (row: { type: string }) => row.type === type,
    );
    await page.getByLabel(`${index + 1}번째 시작 옵션`, { exact: true }).selectOption({
      label: `[레전드리] ${option.values[0].label}`,
    });
  }
}

async function next(page: Page, step: string) {
  await wizard(page).getByRole('button', { name: '다음', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', step);
}

test('step transitions remount with the chosen direction while keeping entered values', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openManualStart(page);
  const originalLines = await page
    .locator('.optimizer-manual select')
    .evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).value));
  const oldStep = await wizard(page).elementHandle();
  await next(page, 'target');
  await expect(wizard(page)).toHaveAttribute('data-direction', 'next');
  expect(await oldStep!.evaluate((element) => element.isConnected)).toBe(false);
  expect(await wizard(page).evaluate((element) => getComputedStyle(element).animationName)).toBe(
    'optimizer-step-in',
  );
  await next(page, 'prices');
  await page.getByLabel('현재 보유 명성치', { exact: true }).fill('123456');
  await page.getByLabel('명예의 훈장 가격', { exact: true }).fill('3456789');
  await page.getByLabel('심연의 서큘레이터 가격', { exact: true }).fill('198765432');

  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'target');
  await expect(wizard(page)).toHaveAttribute('data-direction', 'back');
  expect(
    await wizard(page).evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--optimizer-enter-x').trim(),
    ),
  ).toBe('-12px');
  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'character');
  expect(
    await page
      .locator('.optimizer-manual select')
      .evaluateAll((selects) => selects.map((select) => (select as HTMLSelectElement).value)),
  ).toEqual(originalLines);
  await next(page, 'target');
  await next(page, 'prices');
  await expect(page.getByLabel('현재 보유 명성치', { exact: true })).toHaveValue('123456');
  await expect(page.getByLabel('명예의 훈장 가격', { exact: true })).toHaveValue('3456789');
  await expect(page.getByLabel('심연의 서큘레이터 가격', { exact: true })).toHaveValue('198765432');
});

test('reduced motion removes entry and press animations without disrupting navigation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openManualStart(page);
  await next(page, 'target');
  expect(
    await wizard(page).evaluate((element) =>
      [element, ...element.querySelectorAll('*')].every((node) => {
        const style = getComputedStyle(node);
        return style.animationName === 'none' && style.transitionDuration === '0s';
      }),
    ),
  ).toBe(true);
  const nextButton = wizard(page).getByRole('button', { name: '다음', exact: true });
  const bounds = (await nextButton.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  expect(await nextButton.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
  await page.mouse.up();
  await expect(wizard(page)).toHaveAttribute('data-step', 'prices');
  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'target');
  await expect(wizard(page)).toHaveAttribute('data-direction', 'back');
});

test('intro walks locally, crossfades to another character every five seconds, and stops outside the intro', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await pauseIntroClock(page);
  const apiRequests = await configureIntro(page);
  await page.goto('./#abilityOptimizer');
  await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
  await expect(
    page.getByRole('heading', { name: '내 어빌리티, 어떻게 완성할까요?', exact: true }),
  ).toBeVisible();
  await expect(wizard(page).getByRole('button')).toHaveCount(1);
  await expect(
    page.getByRole('list', { name: '어빌리티 최적화 진행 순서' }).getByRole('listitem'),
  ).toHaveText(['현재 어빌리티', '목표 옵션', '보유 재화']);
  const scene = page.locator('.optimizer-intro-scene');
  const initial = await expectLocalIntro(page);
  const walking = activeAvatar(page).locator('.optimizer-walking-avatar');
  await expect(walking).toHaveAttribute('data-walk-frame', '1');
  for (const frame of ['2', '3', '2']) {
    await page.clock.fastForward(160);
    await expect(walking).toHaveAttribute('data-walk-frame', frame);
  }
  await page.getByRole('button', { name: /^(밝은|어두운) 테마$/ }).click();
  await expect(scene).toHaveAttribute('data-character', initial);
  let previous = initial;
  let elapsed = 480;
  for (const boundary of [5000, 10000, 15000]) {
    await page.clock.fastForward(boundary - elapsed - 1);
    await expect(scene).toHaveAttribute('data-character', previous);
    await page.clock.fastForward(1);
    await expect(scene).not.toHaveAttribute('data-character', previous);
    await expect(scene.locator('.optimizer-intro-avatar-layer')).toHaveCount(2);
    await expect(scene.locator('.optimizer-intro-avatar-layer[data-active="false"]')).toHaveCount(
      1,
    );
    previous = await expectLocalIntro(page);
    await page.clock.fastForward(319);
    await expect(scene.locator('.optimizer-intro-avatar-layer')).toHaveCount(2);
    await page.clock.fastForward(1);
    await expect(scene.locator('.optimizer-intro-avatar-layer')).toHaveCount(1);
    elapsed = boundary + 320;
  }
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'character');
  await expect(scene).toHaveCount(0);
  await page.clock.fastForward(20000);
  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
  await expectLocalIntro(page);
  await expect(scene.locator('.optimizer-intro-avatar-layer')).toHaveCount(1);
  expect(apiRequests).toEqual([]);
});

test('every saved character displays its real job goals behind the walking avatar', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await pauseIntroClock(page);
  const apiRequests = await configureIntro(page);
  const seen: string[] = [];
  for (const random of [0.1, 0.5, 0.9]) {
    await page.goto(`./?introRandom=${random}#abilityOptimizer`);
    await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
    const name = await expectLocalIntro(page);
    seen.push(name);
    const stacking = await page.locator('.optimizer-intro-scene').evaluate((element) => ({
      options: Number(getComputedStyle(element.querySelector('.optimizer-intro-options')!).zIndex),
      portrait: Number(
        getComputedStyle(element.querySelector('.optimizer-intro-portrait')!).zIndex,
      ),
    }));
    expect(stacking.options).toBeLessThan(stacking.portrait);
    await expect(page.locator('.optimizer-intro-option-runner')).toHaveCount(1);
    const option = page.locator('.optimizer-intro-option-runner').first();
    const movement = await option.evaluate((element) => {
      const animation = element.getAnimations()[0];
      if (!animation) return undefined;
      const timing = animation.effect!.getTiming();
      const duration = Number(timing.duration);
      const delay = timing.delay ?? 0;
      animation.pause();
      animation.currentTime = 0;
      const start = element.querySelector('.optimizer-intro-option')!.getBoundingClientRect();
      const leftEdge = element.closest('.optimizer-intro-scene')!.getBoundingClientRect().left;
      animation.currentTime = delay + duration * 0.25;
      const before = element.getBoundingClientRect().x;
      animation.currentTime = delay + duration * 0.5;
      const after = element.getBoundingClientRect().x;
      return {
        before,
        after,
        duration,
        delay,
        iterations: timing.iterations,
        startRight: start.right,
        leftEdge,
      };
    });
    expect(movement).toBeDefined();
    expect(movement!.duration).toBeGreaterThan(0);
    expect(movement!.delay).toBe(0);
    expect(movement!.iterations).toBe(1);
    expect(movement!.startRight).toBeLessThanOrEqual(movement!.leftEdge + 1);
    expect(movement!.after).toBeGreaterThan(movement!.before);
    for (const count of [2, 3]) {
      await page.clock.fastForward(733);
      await expect(page.locator('.optimizer-intro-option-runner')).toHaveCount(count);
    }
    const chips = page.locator(
      `.optimizer-intro-option-runner[data-option-character="${name}"] .optimizer-intro-option`,
    );
    await expect(chips).toHaveText(INTRO_CHARACTERS[name].types.map(optionLabel));
  }
  expect(new Set(seen)).toEqual(new Set(Object.keys(INTRO_CHARACTERS)));
  expect(apiRequests).toEqual([]);
});

test('an emitted option keeps its DOM node and animation when the avatar changes and only its own animation end removes it', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await pauseIntroClock(page);
  const apiRequests = await configureIntro(page);
  await page.goto('./#abilityOptimizer');
  const scene = page.locator('.optimizer-intro-scene');
  const name = await expectLocalIntro(page);
  const stream = await scene.locator('.optimizer-intro-options').elementHandle();
  // runFor executes each emission interval, unlike fastForward's skipped-interval behavior.
  await page.clock.runFor(4398);
  const runner = scene.locator('.optimizer-intro-option-runner').last();
  const token = await runner.elementHandle();
  const original = await token!.evaluate((element) => {
    const animation = element.getAnimations()[0];
    animation.pause();
    animation.currentTime = 400;
    (window as Window & { preservedIntroAnimation?: Animation }).preservedIntroAnimation =
      animation;
    return {
      id: element.getAttribute('data-option-id'),
      text: element.textContent,
      owner: element.getAttribute('data-option-character'),
    };
  });
  expect(original.id).toBeTruthy();
  expect(original.owner).toBe(name);
  await page.clock.fastForward(601);
  await expect(scene).toHaveAttribute('data-character', name);
  await page.clock.fastForward(1);
  await expect(scene).not.toHaveAttribute('data-character', name);
  expect(await stream!.evaluate((element) => element.isConnected)).toBe(true);
  const preserved = await token!.evaluate((element) => ({
    connected: element.isConnected,
    id: element.getAttribute('data-option-id'),
    text: element.textContent,
    owner: element.getAttribute('data-option-character'),
    sameAnimation:
      element.getAnimations()[0] ===
      (window as Window & { preservedIntroAnimation?: Animation }).preservedIntroAnimation,
    time: element.getAnimations()[0]?.currentTime,
  }));
  expect(preserved).toEqual({ ...original, connected: true, sameAnimation: true, time: 400 });
  const nextName = (await scene.getAttribute('data-character'))!;
  await page.clock.fastForward(733);
  const nextTokens = scene.locator(
    `.optimizer-intro-option-runner[data-option-character="${nextName}"]`,
  );
  await expect(nextTokens).toHaveCount(1);
  const nextType = await nextTokens
    .locator('.optimizer-intro-option')
    .getAttribute('data-option-type');
  expect(INTRO_CHARACTERS[nextName].types).toContain(nextType);
  const nextId = await nextTokens.getAttribute('data-option-id');
  await token!.evaluate((element) =>
    element.dispatchEvent(
      new AnimationEvent('animationend', {
        bubbles: true,
        animationName: getComputedStyle(element).animationName,
      }),
    ),
  );
  await expect(scene.locator(`[data-option-id="${original.id}"]`)).toHaveCount(0);
  await expect(scene.locator(`[data-option-id="${nextId}"]`)).toHaveCount(1);
  expect(await stream!.evaluate((element) => element.isConnected)).toBe(true);
  expect(apiRequests).toEqual([]);
});

test('intro rotation pauses while hidden and resumes with a fresh five-second interval', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await pauseIntroClock(page);
  const apiRequests = await configureIntro(page);
  await page.goto('./#abilityOptimizer');
  const scene = page.locator('.optimizer-intro-scene');
  const original = await expectLocalIntro(page);
  await page.clock.fastForward(2000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(scene).toHaveAttribute('data-paused', 'true');
  const pausedOptions = await scene
    .locator('.optimizer-intro-option-runner')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-option-id')));
  for (const runner of await scene.locator('.optimizer-intro-option-runner').all())
    await expect(runner).toHaveCSS('animation-play-state', 'paused');
  const pausedFrame = await activeAvatar(page)
    .locator('.optimizer-walking-avatar')
    .getAttribute('data-walk-frame');
  await page.clock.fastForward(20000);
  await expect(scene).toHaveAttribute('data-character', original);
  await expect(scene.locator('.optimizer-intro-avatar-layer')).toHaveCount(1);
  expect(
    await scene
      .locator('.optimizer-intro-option-runner')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-option-id'))),
  ).toEqual(pausedOptions);
  await expect(activeAvatar(page).locator('.optimizer-walking-avatar')).toHaveAttribute(
    'data-walk-frame',
    pausedFrame!,
  );
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(scene).toHaveAttribute('data-paused', 'false');
  await page.clock.fastForward(4999);
  await expect(scene).toHaveAttribute('data-character', original);
  await page.clock.fastForward(1);
  await expect(scene).not.toHaveAttribute('data-character', original);
  expect(apiRequests).toEqual([]);
});

test('reduced motion keeps a static local avatar and three job options without rotating', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pauseIntroClock(page);
  const apiRequests = await configureIntro(page);
  await page.goto('./#abilityOptimizer');
  const scene = page.locator('.optimizer-intro-scene');
  const name = await expectLocalIntro(page);
  await expect(scene.locator('.optimizer-intro-option')).toHaveText(
    INTRO_CHARACTERS[name].types.map(optionLabel),
  );
  await expect(activeAvatar(page).locator('.optimizer-walking-avatar')).toHaveAttribute(
    'data-walk-frame',
    '2',
  );
  await page.clock.fastForward(20000);
  await expect(scene).toHaveAttribute('data-character', name);
  await expect(scene.locator('.optimizer-intro-avatar-layer')).toHaveCount(1);
  await expect(activeAvatar(page).locator('.optimizer-walking-avatar')).toHaveAttribute(
    'data-walk-frame',
    '2',
  );
  expect(
    await scene.evaluate((element) =>
      [element, ...element.querySelectorAll('*')].every(
        (node) => getComputedStyle(node).animationName === 'none',
      ),
    ),
  ).toBe(true);
  expect(apiRequests).toEqual([]);
});

test('the intro includes a previously queried character and its cached job without another profile lookup', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await pauseIntroClock(page);
  const requests = await configureIntro(page);
  const character = JSON.parse(
    readFileSync(new URL('../../public/character/snapshot.json', import.meta.url), 'utf8'),
  ) as CharacterSnapshot;
  character.name = '조회한내캐릭터';
  character.job = '나이트로드';
  character.bundledAvatars = false;
  character.fetchedAt = new Date().toISOString();
  character.imageUrl =
    'https://open.api.nexon.com/static/maplestory/character/look/cached-optimizer-user';
  const image = readFileSync(
    new URL('../../public/character/optimizer/kkangmini/walk-1.png', import.meta.url),
  );
  await page.route(`${character.imageUrl}*`, (route) =>
    route.fulfill({ contentType: 'image/png', body: image }),
  );
  await page.route('https://fixture-api.example/api/character?*', (route) =>
    route.fulfill({ json: character }),
  );
  const profileRequests = () =>
    requests.filter((url) => /\/(?:maplestory\/v1|api\/character)(?:[/?]|$)/.test(url));
  await page.goto(`./?introRandom=0&character=${encodeURIComponent(character.name)}#cube`);
  await expect(page.getByRole('button', { name: '캐릭터 검색 열기', exact: true })).toContainText(
    character.name,
  );
  expect(profileRequests()).toHaveLength(1);
  await selectSimulator(page, '어빌리티 최적화');
  await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
  const scene = page.locator('.optimizer-intro-scene');
  const first = (await scene.getAttribute('data-character'))!;
  const seen: string[] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const name = (await scene.getAttribute('data-character'))!;
    seen.push(name);
    if (name === character.name) {
      await expect(scene).toHaveAttribute('data-job', '나이트로드');
      for (let emission = 0; emission < 3; emission++) await page.clock.fastForward(733);
      const types = await scene
        .locator(
          `.optimizer-intro-option-runner[data-option-character="${name}"] .optimizer-intro-option`,
        )
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-option-type')),
        );
      expect(new Set(types)).toEqual(
        new Set(['passiveSkillLevel', 'bossDamagePercent', 'statusAilmentDamagePercent']),
      );
      await expect(scene.locator('.optimizer-intro-character-meta')).toHaveCount(0);
      expect(await scene.innerText()).not.toContain(character.name);
      expect(await scene.innerText()).not.toContain(character.job);
      const frames = activeAvatar(page).locator('img');
      await expect(frames).toHaveCount(3);
      for (const [index, frame] of (await frames.all()).entries()) {
        await expect(frame).toHaveJSProperty('naturalWidth', 300);
        const url = new URL((await frame.getAttribute('src'))!);
        expect(`${url.origin}${url.pathname}`).toBe(character.imageUrl);
        expect(url.searchParams.get('action')).toBe(`A02.${index + 1}`);
      }
    }
    await page.clock.fastForward(5000);
    await expect(scene).not.toHaveAttribute('data-character', name);
  }
  expect(new Set(seen)).toEqual(new Set([...Object.keys(INTRO_CHARACTERS), character.name]));
  await expect(scene).toHaveAttribute('data-character', first);
  expect(profileRequests()).toHaveLength(1);
  await page.getByRole('button', { name: /^(밝은|어두운) 테마$/ }).click();
  await wizard(page).getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'character');
  await expect(page.getByLabel('최적화 캐릭터 닉네임', { exact: true })).toHaveValue(
    character.name,
  );
  await wizard(page).getByRole('button', { name: '뒤로가기', exact: true }).click();
  await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
  await page.clock.fastForward(5000);
  expect(profileRequests()).toHaveLength(1);
  expect(requests.filter((url) => url.includes('open.api.nexon.com/maplestory/v1'))).toEqual([]);
});

for (const width of [360, 390]) {
  test(`intro title, steps and start button fit the first mobile screen at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/app-config.json', (route) =>
      route.fulfill({ json: { characterApiBaseUrl: 'https://fixture-api.example/api' } }),
    );
    await page.goto('./#abilityOptimizer');
    await expect(wizard(page)).toHaveAttribute('data-step', 'intro');
    const start = wizard(page).getByRole('button', { name: '시작하기', exact: true });
    await expect(start).toBeVisible();
    const bounds = (await start.boundingBox())!;
    expect(bounds.y).toBeGreaterThan(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    expect(
      await wizard(page).evaluate((element) =>
        [element, ...element.querySelectorAll('*')].every(
          (node) => getComputedStyle(node).animationName === 'none',
        ),
      ),
    ).toBe(true);
  });
}
