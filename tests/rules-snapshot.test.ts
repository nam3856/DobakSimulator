import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Grade, LineGrade, SimulationConfig } from '../src/types';
import type { GradeRule, OptionPool } from '../src/engine/rules';
import { computeBenchmark, createState, seededRandom, type RuleData } from '../src/engine';

const bytes = (path: string) => readFileSync(new URL(`../public/rules/${path}`, import.meta.url));
const json = (path: string) => JSON.parse(bytes(path).toString('utf8'));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const manifest = json('manifest.json');
const imported = json('snapshots/imported-cube-pools.json');
const cacheText = gunzipSync(bytes('snapshots/cube-requests.json.gz')).toString('utf8');
const cache = JSON.parse(cacheText);
const grades: Grade[] = ['rare', 'epic', 'unique', 'legendary'];
const ruleFiles = ['potential.json', 'additional-potential.json', 'gold.json'];
const probabilityMap = (rows: { displayText: string; probability: number }[]) => {
  const result = new Map<string, number>();
  for (const row of rows)
    result.set(row.displayText, (result.get(row.displayText) ?? 0) + row.probability);
  return result;
};
const difference = (a: Map<string, number>, b: Map<string, number>) =>
  Math.max(
    0,
    ...[...new Set([...a.keys(), ...b.keys()])].map((label) =>
      Math.abs((a.get(label) ?? 0) - (b.get(label) ?? 0)),
    ),
  );
const poolKey = (grade: string, category: string, level: number) => `${grade}/${category}/${level}`;
function poolIndex(pools: OptionPool[]): Map<string, OptionPool> {
  return new Map(
    pools.map((pool) => [poolKey(pool.grade, pool.categories[0], pool.minimumLevel), pool]),
  );
}
function mixture(
  rule: GradeRule,
  slot: number,
  getPool: (grade: LineGrade) => OptionPool,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const chance of rule.lineGrades[slot].chances) {
    for (const option of getPool(chance.grade).options) {
      const text = option.displayText!;
      result.set(text, (result.get(text) ?? 0) + chance.probability * option.probability);
    }
  }
  return result;
}
function auditPools(pools: OptionPool[]) {
  expect(pools.length).toBeGreaterThan(0);
  const keys = new Set<string>();
  for (const pool of pools) {
    const key = poolKey(pool.grade, pool.categories[0], pool.minimumLevel);
    expect(keys.has(key), `duplicate pool ${key}`).toBe(false);
    keys.add(key);
    expect(
      pool.options.reduce((sum, option) => sum + option.probability, 0),
      key,
    ).toBeCloseTo(1, 12);
    expect(
      pool.options.every(
        (option) =>
          Number.isFinite(option.probability) &&
          option.probability > 0 &&
          Number.isFinite(option.value) &&
          !!option.displayText &&
          option.maxLines! >= 1 &&
          option.maxLines! <= 3,
      ),
      key,
    ).toBe(true);
    expect(new Set(pool.options.map((option) => option.displayText)).size, key).toBe(
      pool.options.length,
    );
  }
}
function auditLineGrades(rules: GradeRule[]) {
  expect(rules.map((rule) => rule.grade)).toEqual(grades);
  for (const rule of rules)
    for (const [slot, lottery] of rule.lineGrades.entries()) {
      expect(lottery.slot).toBe(slot + 1);
      expect(lottery.chances.reduce((sum, chance) => sum + chance.probability, 0)).toBeCloseTo(
        1,
        12,
      );
      expect(
        lottery.chances.every((chance) => chance.probability > 0 && chance.probability <= 1),
      ).toBe(true);
      if (slot === 0) expect(lottery.chances).toEqual([{ grade: rule.grade, probability: 1 }]);
    }
}

describe('complete frozen official cube collection', () => {
  it('verifies source hashes and exactly 6,000 grade/category/level queries without invented availability', () => {
    expect(digest(bytes('snapshots/imported-cube-pools.json'))).toBe(
      manifest.importedSnapshotSha256,
    );
    expect(digest(JSON.stringify(cache))).toBe(manifest.cacheSha256);
    expect(cache.importedSnapshotSha256).toBe(manifest.importedSnapshotSha256);
    expect(Object.keys(cache.entries)).toHaveLength(6000);
    expect(manifest.scope).toMatchObject({
      minimumEquipmentLevel: 1,
      maximumEquipmentLevel: 250,
      equipmentParts: 20,
      levelBands: 25,
    });
    let available = 0,
      withTables = 0,
      importedQueries = 0;
    for (const source of manifest.sources) {
      expect(digest(bytes(source.file)), source.file).toBe(source.sha256);
      const rule = json(source.file),
        pools = poolIndex(rule.optionPools);
      expect(rule.equipmentParts).toHaveLength(20);
      expect(rule.levelBands).toHaveLength(25);
      expect(rule.levelBands[0].minimumLevel).toBe(1);
      expect(rule.levelBands.at(-1).maximumLevel).toBe(250);
      for (let index = 1; index < rule.levelBands.length; index++)
        expect(rule.levelBands[index].minimumLevel).toBe(
          rule.levelBands[index - 1].maximumLevel + 1,
        );
      const unavailable = new Set(
        rule.unavailableQueries.map(
          (q: { grade: string; category: string; minimumLevel: number }) =>
            poolKey(q.grade, q.category, q.minimumLevel),
        ),
      );
      let localAvailable = 0;
      for (const band of rule.levelBands)
        for (const part of rule.equipmentParts)
          for (const grade of grades) {
            const queryKey = `${source.kind}/${grade}/${part.code}/${band.minimumLevel}`;
            const entry = cache.entries[queryKey];
            expect(entry, queryKey).toBeDefined();
            expect(entry.responseSha256, queryKey).toMatch(/^[a-f0-9]{64}$/);
            const key = poolKey(grade, part.category, band.minimumLevel);
            expect(pools.has(key), queryKey).toBe(entry.available);
            expect(unavailable.has(key), queryKey).toBe(!entry.available);
            if (entry.available) {
              available++;
              localAvailable++;
            }
            if (entry.tables) withTables++;
            if (entry.source === 'JIJAKBI official snapshot') {
              importedQueries++;
              const sourceCube = imported.cubes.find(
                (cube: { kind: string }) => cube.kind === source.kind,
              );
              const original = entry.available
                ? sourceCube.pools.find(
                    (p: {
                      grade: string;
                      category: string;
                      minimumLevel: number;
                      maximumLevel: number;
                    }) =>
                      p.grade === grade &&
                      p.category === part.category &&
                      p.minimumLevel === band.minimumLevel &&
                      p.maximumLevel === band.maximumLevel,
                  )
                : sourceCube.unavailableQueries.find(
                    (q: { grade: string; category: string; representativeLevel: number }) =>
                      q.grade === grade &&
                      q.category === part.category &&
                      q.representativeLevel === band.representativeLevel,
                  );
              expect(digest(JSON.stringify(original)), queryKey).toBe(entry.responseSha256);
            } else
              expect(entry.request).toMatchObject({
                nGrade: grades.indexOf(grade) + 1,
                nPartsType: part.code,
                nReqLev: band.representativeLevel,
              });
          }
      expect(localAvailable).toBe(source.availableQueries);
      expect(unavailable.size).toBe(source.unavailableQueries);
      expect(localAvailable + unavailable.size).toBe(2000);
      expect(rule.optionPools).toHaveLength(source.optionPoolCount);
    }
    expect(available).toBe(4344);
    expect(withTables).toBe(4064);
    expect(importedQueries).toBe(344);
  });

  for (const file of ruleFiles)
    it(`${file}: all pools normalize and reconstruct every retained displayed table before sequential exclusions`, () => {
      const rule = json(file),
        source = manifest.sources.find((s: { file: string }) => s.file === file);
      const pools = poolIndex(rule.optionPools);
      auditPools(rule.optionPools);
      auditLineGrades(rule.grades);
      let worst = { difference: 0, query: '' };
      for (const band of rule.levelBands)
        for (const part of rule.equipmentParts)
          for (const grade of grades) {
            const query = `${source.kind}/${grade}/${part.code}/${band.minimumLevel}`,
              entry = cache.entries[query];
            if (!entry.available) continue;
            const getPool = (lineGrade: LineGrade) =>
              pools.get(poolKey(lineGrade, part.category, band.minimumLevel))!;
            const gradeRule = rule.grades.find((r: GradeRule) => r.grade === grade);
            const tables = entry.tables ?? [entry.first];
            for (const [slot, table] of tables.entries()) {
              const error = difference(mixture(gradeRule, slot, getPool), probabilityMap(table));
              if (error > worst.difference)
                worst = { difference: error, query: `${query}/slot-${slot + 1}` };
            }
            if (entry.normal)
              expect(
                difference(
                  probabilityMap(
                    getPool('normal').options as { displayText: string; probability: number }[],
                  ),
                  probabilityMap(entry.normal),
                ),
              ).toBeLessThan(1e-12);
          }
      // Published percentages are rounded; Normal is a subtraction of two such
      // tables. This is 0.005 percentage points, not a five-percent tolerance.
      expect(worst.difference, JSON.stringify(worst)).toBeLessThan(0.00005);
    });
});

const clean = (value: string) =>
  value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const tableRows = (table: string) =>
  [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => clean(cell[1])),
  );
describe('advanced ability and all soul stages', () => {
  it('checks the complete ability type/value weights against the frozen official HTML', () => {
    const ability = json('ability.json'),
      html = gunzipSync(bytes('snapshots/ability-reputevalue.html.gz')).toString('utf8');
    expect(digest(html)).toBe(ability.sourceSha256);
    const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map((match) => match[1]);
    const types = tableRows(tables[3]).slice(2);
    expect(types).toHaveLength(41);
    const groups: { label: string; rows: string[][] }[] = [];
    for (const row of tableRows(tables[4]).slice(2)) {
      if (row.length === 6) groups.push({ label: row[0], rows: [] });
      groups.at(-1)!.rows.push(row.slice(-5));
    }
    const normalize = (label: string) => label.replace(/[\s%()]/g, '');
    for (const [gradeIndex, grade] of grades.entries()) {
      if (grade === 'rare') continue;
      const rule = ability.grades[grade];
      const expected = types.filter((row) => parseFloat(row[gradeIndex + 1]) > 0);
      expect(rule.options).toHaveLength(expected.length);
      expect(
        rule.options.reduce((sum: number, o: { weight: number }) => sum + o.weight, 0),
      ).toBeCloseTo(1, 12);
      const mass = expected.reduce((sum, row) => sum + parseFloat(row[gradeIndex + 1]) / 100, 0);
      for (const row of expected) {
        const option = rule.options.find((o: { label: string }) => o.label === row[0]);
        expect(option).toBeDefined();
        expect(option.weight).toBeCloseTo(parseFloat(row[gradeIndex + 1]) / 100 / mass, 12);
        const group = /^(STR|DEX|INT|LUK)(, (STR|DEX|INT|LUK))? 증가$/.test(row[0])
          ? groups[0]
          : groups.find((g) =>
              normalize(g.label).includes(normalize(row[0])) &&
              (!row[0].includes('%') || g.label.includes('%')),
            )!;
        expect(group.rows).toHaveLength(6);
        const expectedValues = new Map<string, number>();
        for (const source of group.rows) {
          const numbers = source[gradeIndex + 1].match(/\d+(?:\.\d+)?/g)!.map(Number);
          const pair = /^(STR|DEX|INT|LUK),/.test(row[0]);
          const key = `${numbers[0]}/${pair ? numbers[1] : ''}`;
          expectedValues.set(key, (expectedValues.get(key) ?? 0) + parseFloat(source[0]) / 100);
        }
        expect(option.values).toHaveLength(expectedValues.size);
        for (const value of option.values)
          expect(value.weight).toBeCloseTo(
            expectedValues.get(`${value.value}/${value.secondaryValue ?? ''}`)!,
            12,
          );
        expect(
          option.values.reduce((sum: number, value: { weight: number }) => sum + value.weight, 0),
        ).toBeCloseTo(1, 12);
      }
    }
    expect(ability.advancedLineGrades).toEqual([
      { legendary: 1 },
      { epic: 0.83, unique: 0.15, legendary: 0.02 },
      { epic: 0.83, unique: 0.15, legendary: 0.02 },
    ]);
    expect(html).toContain('기존과 완전히 동일한 옵션');
    expect(ability.exclusion).toEqual({
      sameTypeAcrossLines: true,
      lockedTypesExcludedBeforeDrawing: true,
      identicalCompleteResult: true,
    });
  });

  it('reconstructs all 16 soul probability responses and preserves every cost and guarantee', () => {
    const soul = json('soul.json'),
      snapshot = json('snapshots/soul-live-2026-09-17.json');
    expect(snapshot.queries).toHaveLength(16);
    expect(soul.optionStages.map((s: { stage: number }) => s.stage)).toEqual([1, 2, 3, 4]);
    expect(soul.amplificationStages).toEqual(snapshot.amplificationStages);
    expect(soul.potentialResetCosts).toEqual(snapshot.potentialResetCosts);
    expect(soul.potentialGrades).toEqual(snapshot.potentialGrades);
    expect(
      soul.amplificationStages.map(
        (s: { guaranteedAfterFailures: number }) => s.guaranteedAfterFailures,
      ),
    ).toEqual([25, 33, 43, 50]);
    expect(soul.potentialGrades.map((g: GradeRule) => g.pityThreshold)).toEqual([
      101,
      257,
      452,
      null,
    ]);
    auditLineGrades(soul.potentialGrades);
    for (const stage of soul.optionStages) {
      auditPools(stage.optionPools);
      expect(stage.optionPools.map((p: OptionPool) => p.grade).sort()).toEqual(
        ['normal', ...grades].sort(),
      );
      for (const grade of grades) {
        const query = snapshot.queries.find(
          (q: { stage: number; grade: string }) => q.stage === stage.stage && q.grade === grade,
        );
        expect(query.request).toEqual({ nGrade: grades.indexOf(grade) + 1, nLevel: stage.stage });
        expect(query.htmlSha256).toMatch(/^[a-f0-9]{64}$/);
        const gradeRule = soul.potentialGrades.find((g: GradeRule) => g.grade === grade);
        for (const table of query.tables) {
          const total = table.rows.reduce(
            (sum: number, row: { displayedProbabilityPercent: string }) =>
              sum + Number(row.displayedProbabilityPercent),
            0,
          );
          const displayed = probabilityMap(
            table.rows.map((row: { displayText: string; displayedProbabilityPercent: string }) => ({
              displayText: row.displayText,
              probability: Number(row.displayedProbabilityPercent) / total,
            })),
          );
          const actual = mixture(gradeRule, table.slot - 1, (lineGrade) =>
            stage.optionPools.find((p: OptionPool) => p.grade === lineGrade),
          );
          expect(
            difference(actual, displayed),
            `soul/${stage.stage}/${grade}/${table.slot}`,
          ).toBeLessThan(0.00005);
        }
      }
    }
  });
});

describe('independent reference calculation checks', () => {
  const data = (): RuleData => ({
    potential: json('potential.json'),
    additional: json('additional-potential.json'),
    gold: json('gold.json'),
    ability: json('ability.json'),
    soul: json('soul.json'),
  });
  const config = (): SimulationConfig => ({
    mode: 'soulPotential',
    cubeType: 'black',
    category: 'weapon',
    level: 200,
    start: { grade: 'rare', lines: [], stage: 4, failures: 0 },
    lockedSlots: [],
    batchSize: 1,
    target: {
      mode: 'grade',
      minimumGrade: 'legendary',
      conditions: [],
      lines: [],
      stage: 4,
      match: 'all',
    },
    ruleVersion: 'reference-cross-check',
    unitPrices: {},
  });

  it('matches JIJAKBI FreeInitialAndPromotionRollsAreNeverChargedAgain: 810 resets and 41.68 billion meso', () => {
    // Reference: tests/Jijakbi.Calculation.Tests/SoulCalculatorTests.cs in JIJAKBI.
    // A grade-only goal has identical semantics under both keep/apply policies.
    const rules = data(),
      cfg = config();
    rules.soul.potentialGrades = rules.soul.potentialGrades.map((grade) => ({
      ...grade,
      gradeUpChance: 0,
    }));
    cfg.start.lines = createState(rules, cfg, seededRandom('jijakbi-reference')).lines;
    const result = computeBenchmark(rules, cfg, undefined, { sampleCount: 1000 });
    expect(result.expectedAttempts).toBe(810);
    expect(result.expectedCost).toBe(41_680_000_000);
    expect(result.quantiles).toEqual({
      p10: 41_680_000_000,
      p50: 41_680_000_000,
      p90: 41_680_000_000,
    });
  });

  it('cross-checks full amplification against independent integer-rational survival sums', () => {
    const rules = data(),
      cfg = config();
    cfg.mode = 'soulAmplification';
    cfg.start.stage = 0;
    cfg.target.mode = 'stage';
    let exactMeanCost = 0;
    for (const stage of rules.soul.amplificationStages) {
      let denominator = 1n,
        survival = 1n,
        mean = 0n;
      for (let failure = 0; failure <= stage.guaranteedAfterFailures; failure++) {
        mean = 1000n * (mean + survival);
        const chance =
          failure === stage.guaranteedAfterFailures
            ? 1000n
            : BigInt(
                Math.round(
                  1000 *
                    (stage.initialSuccessProbability +
                      stage.successProbabilityIncreasePerFailure * failure),
                ),
              );
        survival *= 1000n - chance;
        denominator *= 1000n;
      }
      exactMeanCost += (Number(mean) / Number(denominator)) * Number(stage.systemCostPerAttempt);
    }
    expect(exactMeanCost).toBeCloseTo(98_004_135_592.14827, 3);
    expect(computeBenchmark(rules, cfg).expectedCost).toBeCloseTo(exactMeanCost, 3);
  });
});
