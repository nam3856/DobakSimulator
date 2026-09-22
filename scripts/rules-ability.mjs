import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanHtmlText, sha256 } from './rules-cube-helpers.mjs';

const sourceUrl = 'https://maplestory.nexon.com/Guide/OtherProbability/ability/reputevalue';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'public/rules');
const normalize = text => text.replace(/[\s%()]/g, '');
const optionTypes = ['strFlat', 'dexFlat', 'intFlat', 'lukFlat', 'hpFlat', 'mpFlat', 'attackFlat', 'magicAttackFlat',
  'criticalRatePercent', 'allStatFlat', 'attackSpeedStep', 'apStrToDexPercent', 'apDexToStrPercent', 'apIntToLukPercent',
  'apLukToDexPercent', 'attackPerLevels', 'magicAttackPerLevels', 'hpPercent', 'mpPercent', 'bossDamagePercent',
  'normalMonsterDamagePercent', 'statusAilmentDamagePercent', 'defenseToFlatDamagePercent', 'cooldownSkipPercent',
  'passiveSkillLevel', 'extraAttackTargets', 'buffDurationPercent', 'dropRatePercent', 'mesoRatePercent',
  'strDexFlat', 'strIntFlat', 'strLukFlat', 'dexIntFlat', 'dexLukFlat', 'intLukFlat', 'dexStrFlat', 'intStrFlat',
  'lukStrFlat', 'intDexFlat', 'lukDexFlat', 'lukIntFlat'];
const rows = table => [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(row =>
  [...row[1].matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map(cell =>
    ({ attributes: cell[1], html: cell[2], text: cleanHtmlText(cell[2]) })));

function valueLabel(option, value, secondaryValue) {
  const pair = /^(STR|DEX|INT|LUK), (STR|DEX|INT|LUK) 증가$/.exec(option);
  if (pair) return `${pair[1]} ${value} 증가, ${pair[2]} ${secondaryValue} 증가`;
  if (option.includes('일정 레벨마다')) return option.replace('일정 레벨마다', `${value}레벨마다`);
  if (option === '공격 속도 단계 증가') return `공격 속도 ${value}단계 증가`;
  if (option.includes('%')) return option.replace('%', `${value}%`);
  if (option.startsWith('버프 스킬의 지속 시간')) return `버프 스킬의 지속 시간 ${value}% 증가`;
  return option.replace(' 증가', ` ${value} 증가`);
}

export async function collectAbilityRules({ offline = false } = {}) {
  const snapshotPath = join(output, 'snapshots/ability-reputevalue.html.gz');
  let html;
  if (offline) html = gunzipSync(await readFile(snapshotPath)).toString('utf8');
  else {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw Error(`Ability source HTTP ${response.status}`);
    html = await response.text();
    await writeFile(snapshotPath, gzipSync(html));
  }
  const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)].map(match => match[1]);
  if (tables.length !== 5) throw Error(`Ability guide structure changed: ${tables.length} tables.`);
  const types = rows(tables[3]).slice(2);
  if (types.length !== 41) throw Error(`Ability guide option count changed: ${types.length}.`);
  const valueRows = rows(tables[4]).slice(2);
  const groups = [];
  let current;
  for (const row of valueRows) {
    if (row.length === 6) {
      current = { label: row[0].text, rows: [] };
      groups.push(current);
    }
    if (!current || ![5, 6].includes(row.length)) throw Error('Unrecognized ability value row.');
    const cells = row.slice(-5);
    current.rows.push({ weight: parseFloat(cells[0].text) / 100, values: cells.slice(1).map(cell => cell.text) });
  }
  if (groups.some(group => group.rows.length !== 6)) throw Error('Expected six value weights per ability family.');
  const grades = {};
  for (const [gradeIndex, grade] of ['rare', 'epic', 'unique', 'legendary'].entries()) {
    if (grade === 'rare') continue; // Advanced reset never draws Rare lines.
    const options = [];
    for (const [optionIndex, row] of types.entries()) {
      const label = row[0].text;
      const weight = parseFloat(row[gradeIndex + 1].text) / 100;
      if (!(weight > 0)) continue;
      const isStat = /^(STR|DEX|INT|LUK)(, (STR|DEX|INT|LUK))? 증가$/.test(label);
      const group = isStat ? groups[0] : groups.find(entry =>
        normalize(entry.label).includes(normalize(label)) &&
        (!label.includes('%') || entry.label.includes('%')));
      if (!group) throw Error(`No value family for ${label}.`);
      const valuesByLabel = new Map();
      const combined = /^(STR|DEX|INT|LUK),/.test(label);
      for (const valueRow of group.rows) {
        const sourceValue = valueRow.values[gradeIndex];
        const numbers = sourceValue.match(/\d+(?:\.\d+)?/g)?.map(Number);
        if (!numbers?.length) throw Error(`Missing ${grade} value for ${label}.`);
        const [value, second] = numbers;
        const secondaryValue = combined ? second : undefined;
        if (combined && secondaryValue === undefined) throw Error(`Missing second stat value for ${label}.`);
        const key = `${value}/${secondaryValue ?? ''}`;
        const previous = valuesByLabel.get(key);
        if (previous) previous.weight += valueRow.weight;
        else valuesByLabel.set(key, { value, ...(combined ? { secondaryValue } : {}),
          label: valueLabel(label, value, secondaryValue), weight: valueRow.weight });
      }
      const values = [...valuesByLabel.values()];
      const totalValueWeight = values.reduce((sum, value) => sum + value.weight, 0);
      for (const value of values) value.weight /= totalValueWeight;
      options.push({ id: `ability-${sha256(label).slice(0, 16)}`, type: optionTypes[optionIndex], label, weight,
        displayedProbabilityPercent: row[gradeIndex + 1].text,
        valueDirection: label.startsWith('일정 레벨마다') ? 'lower' : 'higher', values });
    }
    const displayedMass = options.reduce((sum, option) => sum + option.weight, 0);
    if (Math.abs(displayedMass - 1) > .0001) throw Error(`Ability ${grade} probability mass ${displayedMass}.`);
    for (const option of options) option.weight /= displayedMass;
    grades[grade] = { displayedMass, options };
  }
  const rule = { ruleId: 'kms-ability-advanced-2026-09-17-v2', version: 'official-v2', checkedAt: '2026-09-17',
    sourceUrl, updateSourceUrl: 'https://maplestory.nexon.com/news/update/813', sourceSha256: sha256(html),
    requiredGrade: 'legendary', confidence: 'verified', preview: false,
    advancedLineGrades: [{ legendary: 1 }, { epic: .83, unique: .15, legendary: .02 }, { epic: .83, unique: .15, legendary: .02 }],
    costs: [{ locked: 0, honor: 20000, meso: '2000000' }, { locked: 1, honor: 30000, meso: '6000000' },
      { locked: 2, honor: 40000, meso: '15000000' }],
    exclusion: { sameTypeAcrossLines: true, lockedTypesExcludedBeforeDrawing: true, identicalCompleteResult: true },
    normalization: 'Type probabilities normalized within grade. Six published value rows collapsed by identical visible values, preserving summed weight. Pair stat values stay paired.',
    grades };
  await writeFile(join(output, 'ability.json'), `${JSON.stringify(rule, null, 2)}\n`);
  console.log(`Wrote ability.json: ${Object.entries(grades).map(([grade, value]) => `${grade} ${value.options.length}`).join(', ')} types.`);
  return rule;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await collectAbilityRules({ offline: process.argv.includes('--offline') });
}
