#!/usr/bin/env node
/** Build-time official probability collection. No API credentials or runtime proxy.
 * Re-run safely: successful requests are checkpointed in a compressed cache.
 * node scripts/sync-rules.mjs [--concurrency 3] [--offline] [--refresh]
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDisplayedTable, normalizeDisplayedOptions, deriveLowerGradePool,
  assertEquivalentDerivedPools, toRulePool, sha256 } from './rules-cube-helpers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'public/rules');
const snapshots = join(output, 'snapshots');
const endpoint = 'https://maplestory.nexon.com/Guide/OtherProbability/cube/GetSearchProbList';
const checkedAt = new Date().toISOString().slice(0, 10);
const flag = (name) => process.argv.includes(name);
const arg = (name, fallback) => process.argv[process.argv.indexOf(name) + 1] ?? fallback;
const concurrency = flag('--concurrency') ? Number(arg('--concurrency', 3)) : 3;
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) throw Error('Concurrency must be 1–6.');
const grades = ['rare', 'epic', 'unique', 'legendary'];
export const levelBands = [{ minimumLevel: 1, maximumLevel: 9, representativeLevel: 1 }];
for (let level = 10; level <= 110; level += 10) {
  levelBands.push({ minimumLevel: level, maximumLevel: level, representativeLevel: level });
  levelBands.push({ minimumLevel: level + 1, maximumLevel: level + 9, representativeLevel: level + 1 });
}
levelBands.push({ minimumLevel: 120, maximumLevel: 200, representativeLevel: 160 },
  { minimumLevel: 201, maximumLevel: 250, representativeLevel: 250 });

const importedPath = join(snapshots, 'imported-cube-pools.json');
const importedText = await readFile(importedPath, 'utf8');
const imported = JSON.parse(importedText);
const parts = imported.equipmentParts;
const cubes = [
  { kind: 'potential', cubeItemId: '5062010', file: 'potential.json', page: 'black', upper: [.2, .2, .2, .2], third: [.05, .05, .05, .05] },
  { kind: 'additionalPotential', cubeItemId: '5062500', file: 'additional-potential.json', page: 'addi', upper: [.019608, .047619, .019608, .004975], third: [.019608, .047619, .019608, .004975] },
  { kind: 'gold', cubeItemId: '2711004', file: 'gold.json', page: 'artisan', upper: [.166667, .079994, .016959, .001996], third: [.166667, .079994, .016959, .001996] },
].map(cube => ({ ...cube, sourcePage: `https://maplestory.nexon.com/Guide/OtherProbability/cube/${cube.page}` }));
await mkdir(snapshots, { recursive: true });
const cachePath = join(snapshots, 'cube-requests.json.gz');
let cache = { schemaVersion: 1, endpoint, importedSnapshotSha256: sha256(importedText), entries: {} };
try { cache = JSON.parse(gunzipSync(await readFile(cachePath))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (flag('--refresh')) cache.entries = {};
const keyFor = (cube, grade, part, band) => `${cube.kind}/${grade}/${part.code}/${band.minimumLevel}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const atomic = async (path, bytes) => { await writeFile(`${path}.tmp`, bytes); await rename(`${path}.tmp`, path); };
const checkpoint = () => atomic(cachePath, gzipSync(JSON.stringify(cache), { level: 6 }));
const importedEntries = pool => pool.options.map(option => ({ displayText: option.displayText,
  probability: option.normalizedProbability, displayedProbabilityPercent: option.displayedProbabilityPercent }));

const jobs = [];
for (const cube of cubes) for (const band of levelBands) for (const part of parts) for (const grade of grades) {
  const key = keyFor(cube, grade, part, band);
  if (cache.entries[key]) continue;
  const oldCube = !flag('--refresh') && imported.cubes.find(entry => entry.kind === cube.kind);
  const oldPool = oldCube?.pools.find(pool => pool.grade === grade && pool.category === part.category &&
    pool.minimumLevel === band.minimumLevel && pool.maximumLevel === band.maximumLevel);
  const unavailable = oldCube?.unavailableQueries.find(query => query.grade === grade &&
    query.category === part.category && query.representativeLevel === band.representativeLevel);
  if (oldPool || unavailable) {
    const oldNormal = grade === 'rare' && oldCube.pools.find(pool => pool.grade === 'normal' &&
      pool.category === part.category && pool.minimumLevel === band.minimumLevel && pool.maximumLevel === band.maximumLevel);
    cache.entries[key] = { available: !!oldPool, checkedAt: imported.scope.sourceCheckedAtByRepresentativeLevel[band.representativeLevel],
      source: 'JIJAKBI official snapshot', responseSha256: sha256(JSON.stringify(oldPool ?? unavailable)),
      ...(oldPool ? { first: importedEntries(oldPool), ...(oldNormal ? { normal: importedEntries(oldNormal) } : {}) } : {}) };
  } else jobs.push({ cube, band, part, grade, key });
}
if (flag('--offline') && jobs.length) throw Error(`Offline cache incomplete: ${jobs.length} requests missing.`);
console.log(`Official cube coverage: ${6000 - jobs.length}/6000 cached; ${jobs.length} requests remaining.`);
await checkpoint();
let cursor = 0;
let completed = 0;
let checkpointChain = Promise.resolve();
async function fetchJob(job) {
  const { cube, band, part, grade, key } = job;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(25000),
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-requested-with': 'XMLHttpRequest', referer: cube.sourcePage,
          'user-agent': 'DobakSimulator official probability snapshot/1.0' },
        body: new URLSearchParams({ nCubeItemID: cube.cubeItemId, nGrade: String(grades.indexOf(grade) + 1),
          nPartsType: String(part.code), nReqLev: String(band.representativeLevel) }) });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const html = await response.text();
      const available = !html.includes('장비 분류 및 장비 레벨에 해당하는 장비 아이템이 없습니다.');
      const tables = available ? [1, 2, 3].map(slot => normalizeDisplayedOptions(extractDisplayedTable(html, slot))) : undefined;
      cache.entries[key] = { available, checkedAt, source: endpoint, responseSha256: sha256(html),
        request: { nCubeItemID: cube.cubeItemId, nGrade: grades.indexOf(grade) + 1, nPartsType: part.code, nReqLev: band.representativeLevel },
        ...(available ? { tables } : { reason: 'officialGuideReturnedNoApplicableEquipment' }) };
      return;
    } catch (error) {
      if (attempt === 5) throw Error(`${key}: ${error.message}`);
      await delay(500 * attempt * attempt);
    }
  }
}
const failures = [];
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    try { await fetchJob(job); } catch (error) { failures.push(error.message); console.error(error.message); }
    completed++;
    if (completed % 100 === 0) {
      console.log(`Fetched ${completed}/${jobs.length}; available ${Object.values(cache.entries).filter(entry => entry.available).length}.`);
      checkpointChain = checkpointChain.then(checkpoint);
    }
    await delay(100);
  }
}));
await checkpointChain;
await checkpoint();
if (failures.length) throw Error(`${failures.length} requests failed; cache saved. Re-run to resume.`);

const coverage = [];
for (const cube of cubes) {
  const pools = [];
  const unavailableQueries = [];
  for (const band of levelBands) for (const part of parts) {
    let rare;
    for (const grade of grades) {
      const entry = cache.entries[keyFor(cube, grade, part, band)];
      if (!entry.available) {
        unavailableQueries.push({ grade, category: part.category, minimumLevel: band.minimumLevel, maximumLevel: band.maximumLevel });
        continue;
      }
      const first = entry.first ?? entry.tables[0];
      pools.push(toRulePool(cube, grade, part, band, first));
      if (grade === 'rare') rare = entry;
    }
    if (rare) {
      // Rounded published mixtures can leave small residuals. Both suffix tables
      // independently reconstruct Normal; reject discrepancies > 0.00005.
      const normal = rare.normal ?? deriveLowerGradePool(rare.tables[0], rare.tables[1], cube.upper[0], .00002);
      if (!rare.normal) {
        const check = deriveLowerGradePool(rare.tables[0], rare.tables[2], cube.third[0], .00002);
        assertEquivalentDerivedPools(normal, check, cube, part, band);
      }
      pools.push(toRulePool(cube, 'normal', part, band, normal));
    }
  }
  let rule;
  if (cube.kind !== 'gold') {
    rule = JSON.parse(await readFile(join(output, cube.file), 'utf8'));
    const failuresBeforeGuarantee = cube.kind === 'potential' ? [10, 42, 107] : [62, 152, 214];
    for (const [index, grade] of rule.grades.entries()) {
      grade.guaranteedAfterFailures = failuresBeforeGuarantee[index] ?? null;
      grade.pityThreshold = grade.guaranteedAfterFailures === null ? null : grade.guaranteedAfterFailures + 1;
    }
    rule.primeCube = { ...rule.primeCube, preview: false, checkedAt, sourceUrl: 'https://maplestory.nexon.com/news/update/813',
      identicalResultExclusionInferred: false, firstLinePolicy: 'preserveExistingValue',
      saleEndsAt: '2026-11-18T23:59:59+09:00', currency: 'mapleCredit' };
    if (cube.kind === 'potential') rule.grades[0].gradeUpChance = .150000001275;
  } else {
    rule = { kind: 'gold', currency: 'goldCube', unitItemCost: 1, mesoCostMode: 'userEnteredItemPrice', costBands: [],
      grades: grades.map((grade, index) => ({ grade, rank: index + 1,
        gradeUpChance: [.079994, .016959, .001996, 0][index], pityThreshold: null,
        lineGrades: [1, 2, 3].map(slot => ({ slot, chances: slot === 1 ? [{ grade, probability: 1 }] :
          [{ grade, probability: cube.upper[index] }, { grade: index ? grades[index - 1] : 'normal', probability: 1 - cube.upper[index] }] })) })) };
  }
  rule.ruleId = `kms-${cube.kind}-2026-09-17`;
  rule.checkedAt = checkedAt;
  rule.sourceUrl = cube.sourcePage;
  rule.preview = false;
  rule.pityConvention = 'pityThreshold is the one-based guaranteed attempt; currentPity counts completed consecutive failures';
  rule.equipmentParts = parts;
  rule.levelBands = levelBands;
  rule.unavailableQueries = unavailableQueries;
  rule.optionPools = pools;
  const bytes = JSON.stringify(rule);
  await atomic(join(output, cube.file), `${bytes}\n`);
  coverage.push({ kind: cube.kind, file: cube.file, sha256: sha256(`${bytes}\n`), optionPoolCount: pools.length,
    queryCount: 2000, availableQueries: 2000 - unavailableQueries.length, unavailableQueries: unavailableQueries.length,
    sourceUrl: cube.sourcePage, checkedAt });
}
const manifest = { ruleSetId: 'kms-2026-09-17', schemaVersion: 1, checkedAt, sources: coverage,
  scope: { minimumEquipmentLevel: 1, maximumEquipmentLevel: 250, equipmentParts: 20, levelBands: levelBands.length, grades },
  importedSnapshotSha256: sha256(importedText), cacheSha256: sha256(JSON.stringify(cache)),
  normalization: { pureGrades: 'Official first-line distributions; Normal algebraically derived and independently cross-checked from Rare suffix tables.',
    roundedMass: 'Displayed rows with the same text are combined and normalized to one.',
    normalRoundingNoise: 'Residual magnitude <= 0.00002 is treated as rounding noise; cross-table maximum absolute discrepancy <= 0.00005.',
    sequentialLimits: 'Choose line grade first; normalize eligible options within that grade. Never renormalize a mixed-grade table after exclusions.' },
  unavailablePolicy: 'Officially unavailable equipment combinations are explicitly recorded, never extrapolated.',
  credits: { sourceUrl: 'https://maplestory.nexon.com/news/update/813', primeCube: 10000, primeAdditionalCube: 20000 },
  costsSources: ['https://maplestory.nexon.com/news/update/737', 'https://maplestory.nexon.com/news/update/746'],
  pitySource: 'https://maplestory.nexon.com/News/Notice/Notice/144849',
  goldSource: 'https://maplestory.nexon.com/news/update/799' };
await atomic(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${coverage.map(entry => `${entry.file}: ${entry.optionPoolCount} pools`).join(', ')}.`);
