import { createHash } from "node:crypto";
function extractDisplayedTable(html, slot) {
  const tablePattern = new RegExp(
    `<table\\s+class=["']cube_data\\s+_${slot}["'][^>]*>([\\s\\S]*?)<\\/table>`,
    "i",
  );
  const table = tablePattern.exec(html)?.[1];
  if (!table) {
    throw new Error(`Official response is missing option table ${slot}.`);
  }

  const entries = [];
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const rowMatch of table.matchAll(rowPattern)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => cleanHtmlText(match[1]));
    if (cells.length < 2) {
      continue;
    }
    const percentMatch = /([0-9]+(?:\.[0-9]+)?)%/.exec(cells.at(-1));
    if (!percentMatch) {
      continue;
    }
    entries.push({
      displayText: cells[0],
      displayedProbabilityPercent: percentMatch[1],
      probability: Number(percentMatch[1]) / 100,
    });
  }

  if (entries.length === 0) {
    throw new Error(`Official option table ${slot} contained no probability rows.`);
  }
  return entries;
}

function normalizeDisplayedOptions(entries) {
  const combined = new Map();
  for (const entry of entries) {
    const previous = combined.get(entry.displayText) ?? {
      displayText: entry.displayText,
      displayedProbabilityPercent: 0,
      probability: 0,
    };
    previous.displayedProbabilityPercent += Number(entry.displayedProbabilityPercent);
    previous.probability += entry.probability;
    combined.set(entry.displayText, previous);
  }
  return normalizeProbabilities([...combined.values()]);
}

function deriveLowerGradePool(upperEntries, mixedEntries, upperWeight, roundingNoiseFloor) {
  const upper = new Map(upperEntries.map((entry) => [entry.displayText, entry.probability]));
  const mixed = new Map(mixedEntries.map((entry) => [entry.displayText, entry.probability]));
  const labels = [...new Set([...upper.keys(), ...mixed.keys()])];
  const lower = [];
  for (const displayText of labels) {
    const probability = ((mixed.get(displayText) ?? 0) - upperWeight * (upper.get(displayText) ?? 0)) /
      (1 - upperWeight);
    if (probability < -0.00002) {
      throw new Error(`Normal-pool derivation produced ${probability} for '${displayText}'.`);
    }
    if (probability > roundingNoiseFloor) {
      lower.push({
        displayText,
        displayedProbabilityPercent: null,
        probability: Math.max(0, probability),
      });
    }
  }
  return normalizeProbabilities(lower);
}

function normalizeProbabilities(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.probability, 0);
  if (!(total > 0)) {
    throw new Error("Cannot normalize an empty or zero-probability option pool.");
  }

  let assigned = 0;
  return entries.map((entry, index) => {
    const probability = index === entries.length - 1
      ? 1 - assigned
      : entry.probability / total;
    assigned += probability;
    return { ...entry, probability };
  });
}

function assertEquivalentDerivedPools(second, third, cube, part, band) {
  const left = new Map(second.map((entry) => [entry.displayText, entry.probability]));
  const right = new Map(third.map((entry) => [entry.displayText, entry.probability]));
  const labels = new Set([...left.keys(), ...right.keys()]);
  const maximumDifference = Math.max(...[...labels].map((label) =>
    Math.abs((left.get(label) ?? 0) - (right.get(label) ?? 0))));
  if (maximumDifference > 0.00005) {
    throw new Error(
      `Rare-line Normal derivation mismatch (${maximumDifference}) for ` +
      `${cube.kind}/${part.category}/level-${band.representativeLevel}.`,
    );
  }
}

function toSnapshotPool(cube, grade, part, band, entries, derivation) {
  return {
    grade,
    category: part.category,
    partCode: part.code,
    minimumLevel: band.minimumLevel,
    maximumLevel: band.maximumLevel,
    representativeLevel: band.representativeLevel,
    derivation,
    displayedProbabilitySumPercent: grade === "normal"
      ? null
      : round(entries.reduce((sum, entry) => sum + entry.displayedProbabilityPercent, 0), 8),
    options: entries.map((entry) => ({
      displayText: entry.displayText,
      displayedProbabilityPercent: entry.displayedProbabilityPercent === null
        ? null
        : String(round(entry.displayedProbabilityPercent, 8)),
      normalizedProbability: entry.probability,
      ...parseOption(entry.displayText),
      ...lineLimit(entry.displayText),
    })),
  };
}

function toRulePool(cube, grade, part, band, entries) {
  return {
    grade,
    slot: null,
    minimumLevel: band.minimumLevel,
    maximumLevel: band.maximumLevel,
    categories: [part.category],
    options: entries.map((entry) => {
      const parsed = parseOption(entry.displayText);
      const limit = lineLimit(entry.displayText);
      const idMaterial = [cube.kind, grade, part.category, band.minimumLevel, entry.displayText].join("|");
      return {
        id: `${cube.kind === "potential" ? "pot" : "addi"}-${sha256(idMaterial).slice(0, 16)}`,
        ...parsed,
        probability: entry.probability,
        ...limit,
        displayText: entry.displayText,
      };
    }),
  };
}

function parseOption(displayText) {
  const patterns = [
    [/^캐릭터 기준 9레벨 당 (STR|DEX|INT|LUK)(?:\s*[:：])? \+([0-9]+(?:\.[0-9]+)?)$/, (match) => ({
      type: `${match[1].toLowerCase()}PerLevel`,
      value: Number(match[2]),
      unit: "level",
    })],
    [/^(STR|DEX|INT|LUK) \+([0-9]+(?:\.[0-9]+)?)(%)?$/, (match) => ({
      type: `${match[1].toLowerCase()}${match[3] ? "Percent" : "Flat"}`,
      value: Number(match[2]),
      unit: match[3] ? "percent" : "flat",
    })],
    [/^올스탯 \+([0-9]+(?:\.[0-9]+)?)(%)?$/, (match) => ({
      type: match[2] ? "allStatPercent" : "allStatFlat",
      value: Number(match[1]),
      unit: match[2] ? "percent" : "flat",
    })],
    [/^최대 HP \+([0-9]+(?:\.[0-9]+)?)(%)?$/, statParser("hp")],
    [/^최대 MP \+([0-9]+(?:\.[0-9]+)?)(%)?$/, statParser("mp")],
    [/^공격력 \+([0-9]+(?:\.[0-9]+)?)(%)?$/, statParser("attack")],
    [/^마력 \+([0-9]+(?:\.[0-9]+)?)(%)?$/, statParser("magicAttack")],
    [/^보스 몬스터(?: 공격 시)? 데미지 \+([0-9]+(?:\.[0-9]+)?)%$/, percentParser("bossDamagePercent")],
    [/^몬스터 방어율 무시 \+([0-9]+(?:\.[0-9]+)?)%$/, percentParser("ignoreDefensePercent")],
    [/^데미지 \+([0-9]+(?:\.[0-9]+)?)%$/, percentParser("damagePercent")],
    [/^크리티컬 확률 \+([0-9]+(?:\.[0-9]+)?)%$/, percentParser("criticalRatePercent")],
    [/^크리티컬 데미지 \+([0-9]+(?:\.[0-9]+)?)%$/, percentParser("criticalDamagePercent")],
    [/^아이템 드롭률 \+([0-9]+(?:\.[0-9]+)?)%$/, percentParser("dropRatePercent")],
    [/^메소 획득량 \+([0-9]+(?:\.[0-9]+)?)%$/, percentParser("mesoRatePercent")],
    [/^(?:모든 )?스킬(?:의)? 재사용 대기시간 -([0-9]+(?:\.[0-9]+)?)초/, (match) => ({
      type: "cooldownReductionSecond",
      value: Number(match[1]),
      unit: "second",
    })],
  ];

  for (const [pattern, parser] of patterns) {
    const match = pattern.exec(displayText);
    if (match) {
      return parser(match);
    }
  }
  return { type: "unknown", value: 0, unit: "text" };
}

function statParser(prefix) {
  return (match) => ({
    type: `${prefix}${match[2] ? "Percent" : "Flat"}`,
    value: Number(match[1]),
    unit: match[2] ? "percent" : "flat",
  });
}

function percentParser(type) {
  return (match) => ({ type, value: Number(match[1]), unit: "percent" });
}

function lineLimit(displayText) {
  if (displayText.includes("쓸만한 ") || displayText.includes("피격 후 무적시간")) {
    return { maxLines: 1, limitGroup: "utility-or-after-hit-invincibility" };
  }
  if (/^피격 시 .*데미지.*무시/.test(displayText) || /^피격 시 .*무적/.test(displayText)) {
    return { maxLines: 2, limitGroup: "on-hit-damage-ignore-or-invincibility" };
  }
  return { maxLines: 3 };
}

function applyRareNormalMixture(rules, cube) {
  const rare = rules.grades.find((grade) => grade.grade === "rare");
  if (!rare) {
    throw new Error(`${cube.productionFile} does not define the Rare grade.`);
  }
  rare.lineGrades = [
    { slot: 1, chances: [{ grade: "rare", probability: 1 }] },
    {
      slot: 2,
      chances: [
        { grade: "rare", probability: cube.rareSecondLineUpperWeight },
        { grade: "normal", probability: 1 - cube.rareSecondLineUpperWeight },
      ],
    },
    {
      slot: 3,
      chances: [
        { grade: "rare", probability: cube.rareThirdLineUpperWeight },
        { grade: "normal", probability: 1 - cube.rareThirdLineUpperWeight },
      ],
    },
  ];
}

function cleanHtmlText(value) {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"], ["nbsp", " "],
  ]);
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    }
    return named.get(code.toLowerCase()) ?? entity;
  });
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function delay(milliseconds) {
  return milliseconds === 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function atomicWrite(path, contents) {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, path);
}

export { extractDisplayedTable, normalizeDisplayedOptions, deriveLowerGradePool, assertEquivalentDerivedPools, toRulePool, parseOption, cleanHtmlText, sha256, normalizeProbabilities };
