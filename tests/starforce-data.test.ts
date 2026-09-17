import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import rules from '../public/rules/starforce.json';

const snapshot = (path: string) =>
  gunzipSync(readFileSync(new URL(`../public/rules/${path}`, import.meta.url)));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('frozen normal KMS Star Force data', () => {
  it('preserves every official source and the explicitly beta cost reference', () => {
    for (const source of Object.values(rules.sources)) {
      expect(source.url).toMatch(/^https:\/\/(?:archive\.)?maplestory\.nexon\.com\//);
      expect(sha256(snapshot(source.snapshot))).toBe(source.sha256);
    }
    expect(sha256(snapshot(rules.costProvenance.snapshot))).toBe(rules.costProvenance.sha256);
    expect(sha256(snapshot(rules.costProvenance.verificationSnapshot))).toBe(
      rules.costProvenance.verificationSha256,
    );
    expect(rules.probabilityStatus).toBe('official');
    expect(rules.costStatus).toBe('jijakbi-cross-validated-beta');
    expect(rules.costProvenance.officialStaticCostTableAvailable).toBe(false);
  });

  it('has thirty normalized stages without ordinary downgrade or chance time', () => {
    expect(rules.transitions).toHaveLength(30);
    rules.transitions.forEach((row, index) => {
      expect(row.star).toBe(index);
      expect(row.successStar).toBe(index + 1);
      expect(row.decreaseProbability).toBe(0);
      expect(row.successProbability).toBeGreaterThan(0);
      expect(row.maintainProbability).toBeGreaterThanOrEqual(0);
      expect(row.destroyProbability).toBeGreaterThanOrEqual(0);
      expect(row.successProbability + row.maintainProbability + row.destroyProbability).toBeCloseTo(
        1,
        12,
      );
      if (index < 15) expect(row.destroyProbability).toBe(0);
      else expect(row.traceStar).toBe(Math.min(index, 22));
    });
    expect(rules.mechanics).toMatchObject({
      chanceTime: false,
      normalDecrease: false,
      starCatchAvailable: false,
      automaticStarCatchIncluded: true,
      normalRuleEffectiveFrom: '2025-03-20',
    });
    expect(rules.scope.supported).toEqual(['normal']);
    expect(rules.scope.excluded).toContain('superior');
  });

  it('retains automatic starcatch probabilities without applying the bonus twice', () => {
    expect(rules.transitions[0].successProbability).toBe(0.9975);
    expect(rules.transitions[14].successProbability).toBe(0.315);
    expect(rules.transitions[15]).toMatchObject({
      successProbability: 0.315,
      maintainProbability: 0.66445,
      destroyProbability: 0.02055,
    });
    expect(rules.transitions[21].destroyProbability).toBe(0.126375);
    expect(rules.transitions[29]).toMatchObject({
      successProbability: 0.0105,
      maintainProbability: 0.7916,
      destroyProbability: 0.1979,
      traceStar: 22,
    });
    const reference = JSON.parse(snapshot(rules.costProvenance.snapshot).toString('utf8'));
    expect(rules.transitions).toEqual(reference.transitions);
  });

  it('preserves level cap boundaries and the 200% safeguard surcharge', () => {
    expect(rules.minimumLevel).toBe(1);
    expect(rules.maximumLevel).toBe(250);
    let next = 1;
    for (const band of rules.maximumStarBands) {
      expect(band.minimumLevel).toBe(next);
      next = band.maximumLevel + 1;
    }
    expect(next).toBe(251);
    expect(rules.maximumStarBands.map((band) => band.maximumStar)).toEqual([5, 8, 10, 15, 20, 30]);
    expect(rules.safeguard).toMatchObject({
      eligibleStars: [15, 16, 17],
      additionalBaseCostMultiplier: 2,
      destroyProbabilityMultiplier: 0,
    });
  });

  it('keeps restoration costs only for the independently recorded levels and exact trace stages', () => {
    expect(rules.restoration.restoreToBase).toEqual({
      restoredStar: 12,
      mesoCost: '0',
      equipmentCount: 1,
    });
    expect([...new Set(rules.restoration.fullRestoreBands.map((row) => row.minimumLevel))]).toEqual(
      [130, 135, 140, 145, 150, 160, 200, 250],
    );
    const seen = new Set<string>();
    for (const row of rules.restoration.fullRestoreBands) {
      expect(row.minimumLevel).toBe(row.maximumLevel);
      expect(row.minimumTraceStar).toBe(row.maximumTraceStar);
      expect(BigInt(row.mesoCost)).toBeGreaterThan(0n);
      const key = `${row.minimumLevel}:${row.minimumTraceStar}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      const copies =
        row.minimumTraceStar <= 18 ? 1 : row.minimumTraceStar <= 20 ? 2 : row.minimumTraceStar - 18;
      expect(row.equipmentCount).toBe(copies);
    }
    expect(seen.size).toBe(58);
    expect(
      rules.restoration.fullRestoreBands.find(
        (row) => row.minimumLevel === 250 && row.minimumTraceStar === 22,
      )?.mesoCost,
    ).toBe('47300000000');
  });

  it('preserves the checked cost model and isolates optional event effects', () => {
    const reference = JSON.parse(snapshot(rules.costProvenance.snapshot).toString('utf8'));
    expect(rules.costFormula).toEqual(reference.costFormula);
    expect(rules.restoration).toEqual(reference.restoration);
    expect(rules.events.map((event) => event.id)).toEqual([
      'none',
      'costDiscount30',
      'destroyReduction30',
      'shiningWithout1516',
    ]);
    expect(rules.events.find((event) => event.id === 'none')).toMatchObject({
      attemptCostMultiplier: 1,
      destroyProbabilityMultiplier: 1,
      fullRestoreCostMultiplier: 1,
      guaranteedSuccessStars: [],
    });
    expect(rules.events.find((event) => event.id === 'destroyReduction30')).toMatchObject({
      destroyProbabilityMultiplier: 0.7,
      maximumDestroyReductionStarInclusive: 21,
    });
    expect(rules.events.find((event) => event.id === 'shiningWithout1516')).toMatchObject({
      attemptCostMultiplier: 0.7,
      destroyProbabilityMultiplier: 0.7,
      maximumDestroyReductionStarInclusive: 21,
      fullRestoreCostMultiplier: 0.8,
      guaranteedSuccessStars: [],
    });
    expect(sha256(snapshot(rules.shiningEvidence.snapshot))).toBe(rules.shiningEvidence.sha256);
    expect(rules.shiningEvidence.pageUrl).toBe(
      'https://maplestory.nexon.com/News/Event/Closed/1377',
    );
  });
});
