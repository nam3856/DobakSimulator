#!/usr/bin/env node
/** Collect the official shared ability value table without rewriting the ability simulator rules. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanHtmlText, sha256 } from './rules-cube-helpers.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rulesDirectory = join(root, 'public/rules');
const snapshotDirectory = join(rulesDirectory, 'snapshots/abyss-circulator');
const offline = process.argv.includes('--offline');
const checkedAt = '2026-09-18';
const sources = {
  probability: {
    url: 'https://maplestory.nexon.com/Guide/OtherProbability/ability/reputevalue',
    file: 'ability-probability.html.gz',
  },
  guide: {
    url: 'https://maplestory.nexon.com/Guide/N23GameInformation/Articles/392',
    file: 'ability-guide.html.gz',
  },
  update: {
    url: 'https://maplestory.nexon.com/News/Update/813',
    file: 'update-813.html.gz',
  },
  tooltip: {
    url: 'https://dszw1qtcnsa5e.cloudfront.net/quickboard/20260914/0b995060a68c40b785458dc6ac3239db/%EC%8B%AC%EC%97%B0%EC%9D%98%20%EC%84%9C%ED%81%98%EB%A0%88%EC%9D%B4%ED%84%B0.png',
    file: 'tooltip.png',
  },
};
await mkdir(snapshotDirectory, { recursive: true });
const content = {};
await Promise.all(
  Object.entries(sources).map(async ([name, source]) => {
    let bytes;
    const compressed = source.file.endsWith('.gz');
    if (offline) {
      const saved = await readFile(join(snapshotDirectory, source.file));
      bytes = compressed ? gunzipSync(saved) : saved;
    } else {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(25_000) });
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(join(snapshotDirectory, source.file), compressed ? gzipSync(bytes) : bytes);
    }
    source.sha256 = sha256(bytes);
    source.snapshot = `snapshots/abyss-circulator/${source.file}`;
    delete source.file;
    content[name] = bytes.toString('utf8');
  }),
);

const probabilityText = cleanHtmlText(content.probability);
const updateText = cleanHtmlText(content.update);
for (const statement of [
  '블랙, 심연의 서큘레이터 사용 시 등급과 옵션이 고정된 상태에서 수치만 재설정됩니다.',
  '기존과 완전히 동일한 옵션이 선택될 경우',
]) {
  if (!probabilityText.includes(statement))
    throw new Error(`Official probability notice changed: ${statement}`);
}
for (const statement of [
  '재설정 될 수치가 없는 어빌리티만 있을 경우 사용할 수 없습니다.',
  '재설정된 어빌리티를 적용할 것인지 선택할 수 있습니다.',
  '판매 가격 : 4,900캐시',
]) {
  if (!updateText.includes(statement))
    throw new Error(`Official update notice changed: ${statement}`);
}
if (!/심연의 서큘레이터\s+4,900/.test(updateText)) throw new Error('Credit-shop price changed.');

const tables = [...content.probability.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(
  (match) => match[1],
);
if (tables.length !== 5) throw new Error('Official ability table structure changed.');
const rows = [...tables[4].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
  .map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cleanHtmlText(cell[1])),
  )
  .slice(2);
const families = [];
let current;
for (const row of rows) {
  if (row.length === 6) {
    current = { label: row[0], rows: [] };
    families.push(current);
  }
  if (!current || ![5, 6].includes(row.length)) throw new Error('Unexpected ability value row.');
  const cells = row.slice(-5);
  current.rows.push({ weight: parseFloat(cells[0]) / 100, values: cells.slice(1) });
}
if (families.some((family) => family.rows.length !== 6))
  throw new Error('Expected six published value rows per family.');
const normalize = (text) => text.replace(/[\s%()]/g, '');
const ability = JSON.parse(await readFile(join(rulesDirectory, 'ability.json'), 'utf8'));
const grades = {};
for (const [grade, pool] of Object.entries(ability.grades)) {
  const gradeIndex = ['rare', 'epic', 'unique', 'legendary'].indexOf(grade);
  const options = [];
  for (const option of pool.options) {
    const isStat = /^(STR|DEX|INT|LUK)(, (STR|DEX|INT|LUK))? 증가$/.test(option.label);
    const family = isStat
      ? families[0]
      : families.find((entry) =>
          normalize(entry.label).includes(normalize(option.label)) &&
          (!option.label.includes('%') || entry.label.includes('%')),
        );
    if (!family) throw new Error(`Missing value family: ${grade}/${option.label}`);
    const combined = /^(STR|DEX|INT|LUK),/.test(option.label);
    const values = new Map();
    for (const row of family.rows) {
      const numbers = row.values[gradeIndex].match(/\d+(?:\.\d+)?/g)?.map(Number);
      if (!numbers?.length || (combined && numbers.length < 2))
        throw new Error(`Missing value: ${grade}/${option.label}`);
      const [value, second] = numbers;
      const secondaryValue = combined ? second : undefined;
      const key = `${value}/${secondaryValue ?? ''}`;
      if (values.has(key)) values.get(key).weight += row.weight;
      else {
        const existing = option.values.find(
          (entry) => entry.value === value && entry.secondaryValue === secondaryValue,
        );
        if (!existing)
          throw new Error(`Current ability rules lack ${grade}/${option.label}/${key}`);
        values.set(key, {
          value,
          ...(combined ? { secondaryValue } : {}),
          label: existing.label,
          weight: row.weight,
        });
      }
    }
    const valueRows = [...values.values()];
    const mass = valueRows.reduce((sum, value) => sum + value.weight, 0);
    if (Math.abs(mass - 1) > 1e-12)
      throw new Error(`Value probability mass ${mass} for ${option.label}`);
    for (const value of valueRows) {
      value.weight /= mass;
      const existing = option.values.find(
        (entry) => entry.value === value.value && entry.secondaryValue === value.secondaryValue,
      );
      if (Math.abs(existing.weight - value.weight) > 1e-12)
        throw new Error(`Current ability value probability differs: ${grade}/${option.label}`);
    }
    if (valueRows.length !== option.values.length)
      throw new Error(`Current ability value count differs: ${grade}/${option.label}`);
    const bestValue = (option.valueDirection === 'lower' ? Math.min : Math.max)(
      ...valueRows.map((value) => value.value),
    );
    options.push({
      id: option.id,
      type: option.type,
      label: option.label,
      valueDirection: option.valueDirection,
      values: valueRows,
      bestValue,
      bestValueProbability: valueRows
        .filter((value) => value.value === bestValue)
        .reduce((sum, value) => sum + value.weight, 0),
    });
  }
  grades[grade] = { options };
}

const rule = {
  ruleId: 'kms-abyss-circulator-2026-09-17',
  version: 'official-v2',
  checkedAt,
  scope:
    'Advanced-reset-reachable option types and grades for the legendary three-target optimizer; discontinued legacy-only options and Rare lines are not included.',
  sourceUrl: sources.probability.url,
  sources,
  requiredGrade: 'legendary',
  abilityValueRuleId: ability.ruleId,
  mechanics: {
    preservesGrade: true,
    preservesOptionTypes: true,
    rerollsAllLineValues: true,
    supportsSelectiveValueLocks: false,
    canKeepPreviousWholeResult: true,
    individualValuesMayRemainUnchanged: true,
    excludesIdenticalCompleteResult: true,
    cannotUseWhenAllValuesAreFixed: true,
  },
  modelingBasis: {
    valueDistribution:
      'The shared official ability value probability table explicitly covers Abyss Circulator. Same displayed values are combined by summing their six published row probabilities.',
    independence:
      'Each option uses its own published value distribution. Independence is the calculator model derived from the per-option probability table; no separate joint distribution is published.',
    identicalResult:
      'The shared ability probability notice excludes a completely identical reset result. This is interpreted as the ordered full three-line visible result, not exclusion of each individual old value.',
    selectiveLocks:
      'Official Circulator descriptions fix grades/types and reroll values together; no selective value-lock facility is specified. The optimizer does not apply advanced-reset line locks to Circulator value rerolls.',
    honorMedal:
      'The 5,000-honor conversion unit is explicitly user-requested; no claim is made that every named honor medal grants 5,000 honor.',
  },
  costPerUse: { items: 1, honor: 0, meso: '0', cashShopPrice: 4900, creditShopPrice: 4900 },
  honorPerMedal: 5000,
  grades,
};
await writeFile(
  join(rulesDirectory, 'abyss-circulator.json'),
  `${JSON.stringify(rule, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      file: 'public/rules/abyss-circulator.json',
      checkedAt,
      options: Object.fromEntries(
        Object.entries(grades).map(([grade, pool]) => [grade, pool.options.length]),
      ),
      existingAbilityValuesMatched: true,
      snapshotFiles: Object.keys(sources).length,
    },
    null,
    2,
  ),
);
