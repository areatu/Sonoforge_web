import { describe, expect, it } from 'vitest';
import golden from './golden/domain_vectors_v1.json';
import {
  avaContinuityCm2,
  bsaDuBoisM2,
  calculateSimpsonLvef,
  cardiacOutputLMin,
  computeBeatAveragedVtiCm,
  computeSimpsonLines,
  dimensionlessIndex,
  fractionalShorteningPercent,
  heartRateFromIntervalMs,
  indexedToBsa,
  lvmFromLinearMeasurements,
  lvotAreaCm2,
  meanOfLastBeats,
  polygonAreaMm2,
  pressureGradientMmHg,
  qpQsRatio,
  resolveBsaBasis,
  rwtFromLinearMeasurements,
  strokeVolumeMl,
  teichholzFromLinearMeasurements,
  type Point2D,
  type SimpsonContourInput,
} from '../spike/domain-ts';

function expectCloseOrNull(
  actual: number | null | undefined,
  expected: number | null | undefined,
  tolerance: number,
  label: string,
): void {
  if (expected === null || expected === undefined) {
    expect(actual ?? null, `${label} expected null`).toBeNull();
    return;
  }
  expect(actual, `${label} expected finite number, got ${actual}`).not.toBeNull();
  expect(actual, `${label} expected defined`).toBeDefined();
  const diff = Math.abs((actual as number) - expected);
  expect(diff, `${label}: |${actual} - ${expected}| = ${diff} > ${tolerance}`).toBeLessThanOrEqual(
    tolerance,
  );
}

describe(`Differential tests vs SonoForge Python (${golden.sourceCommit.slice(0, 7)})`, () => {
  const tol = golden.tolerances;

  describe('1. Body Surface Area (Du Bois) & BSA Provenance', () => {
    for (const tc of golden.suites.bsa) {
      it(`matches Python oracle: ${tc.id}`, () => {
        const manualBsa =
          tc.input.manualBsaM2 === 'NaN' ? Number.NaN : (tc.input.manualBsaM2 as number | null);
        const duBois =
          tc.input.heightCm !== null && tc.input.weightKg !== null
            ? bsaDuBoisM2(tc.input.heightCm, tc.input.weightKg)
            : null;
        const basis = resolveBsaBasis({
          heightCm: tc.input.heightCm,
          weightKg: tc.input.weightKg,
          manualBsaM2: manualBsa,
        });
        const indexed120 = indexedToBsa(120.0, basis.value);

        expectCloseOrNull(duBois, tc.expected.duBoisM2, tol.m2, 'duBoisM2');
        expectCloseOrNull(basis.value, tc.expected.resolvedBsaM2, tol.m2, 'resolvedBsaM2');
        expect(basis.source).toBe(tc.expected.source);
        expectCloseOrNull(indexed120, tc.expected.indexedEdv120MlM2, tol.ml_m2, 'indexedEdv120');
      });
    }
  });

  describe('2. Teichholz Cube LV Volumes, LVEF & Fractional Shortening', () => {
    for (const tc of golden.suites.teichholz) {
      it(`matches Python oracle: ${tc.id}`, () => {
        const calipers = tc.input.calipers.map((c) => ({
          label: c.label,
          millimeterLength: c.mm,
        }));
        const res = teichholzFromLinearMeasurements(calipers);

        const lveddMm =
          tc.input.calipers.find(
            (c) => c.label.toLowerCase().includes('ed') || c.label.toLowerCase().includes('idd'),
          )?.mm ?? null;
        const lvesdMm =
          tc.input.calipers.find(
            (c) => c.label.toLowerCase().includes('es') || c.label.toLowerCase().includes('ids'),
          )?.mm ?? null;
        const fs = fractionalShorteningPercent(
          lveddMm !== null ? lveddMm / 10.0 : null,
          lvesdMm !== null ? lvesdMm / 10.0 : null,
        );

        expectCloseOrNull(res?.edvMl ?? null, tc.expected.edvMl, tol.ml, 'edvMl');
        expectCloseOrNull(res?.esvMl ?? null, tc.expected.esvMl, tol.ml, 'esvMl');
        expectCloseOrNull(res?.svMl ?? null, tc.expected.svMl, tol.ml, 'svMl');
        expectCloseOrNull(res?.lvefPercent ?? null, tc.expected.lvefPercent, tol.percent, 'lvef');
        expectCloseOrNull(fs, tc.expected.fsPercent, tol.percent, 'fsPercent');
      });
    }
  });

  describe('3. ASE 2015 Cube LV Mass, LVMI & Relative Wall Thickness (RWT)', () => {
    for (const tc of golden.suites.lvmAndRwt) {
      it(`matches Python oracle: ${tc.id}`, () => {
        const calipers = [];
        if (tc.input.ivsdMm !== null) {
          calipers.push({ label: 'IVSd', millimeterLength: tc.input.ivsdMm });
        }
        if (tc.input.lveddMm !== null) {
          calipers.push({ label: 'LVEDD', millimeterLength: tc.input.lveddMm });
        }
        if (tc.input.lvpwdMm !== null) {
          calipers.push({ label: 'LVPWd', millimeterLength: tc.input.lvpwdMm });
        }

        const massG = lvmFromLinearMeasurements(calipers);
        const rwtVal = rwtFromLinearMeasurements(calipers);
        const lvmi = indexedToBsa(massG, tc.input.bsaM2);

        expectCloseOrNull(massG, tc.expected.lvmGrams, tol.grams, 'lvmGrams');
        expectCloseOrNull(lvmi, tc.expected.lvmiGM2, tol.g_m2, 'lvmiGM2');
        expectCloseOrNull(rwtVal, tc.expected.rwtRatio, tol.ratio, 'rwtRatio');
      });
    }
  });

  describe('4. Simpson 20-Disk Monoplane / Biplane LVEF & Shoelace Planimetry', () => {
    for (const tc of golden.suites.simpson) {
      it(`matches Python oracle: ${tc.id}`, () => {
        const spacing = tc.input.pixelSpacing
          ? ([tc.input.pixelSpacing[0]!, tc.input.pixelSpacing[1]!] as const)
          : null;

        const contours: SimpsonContourInput[] = tc.input.contours.map((c) => ({
          phase: c.phase,
          view: c.view,
          chamber: c.chamber,
          points: c.points.map((pt) => [pt[0]!, pt[1]!] as Point2D),
          mitralAnnulus: c.mitralAnnulus
            ? ([
                [c.mitralAnnulus[0]![0]!, c.mitralAnnulus[0]![1]!] as Point2D,
                [c.mitralAnnulus[1]![0]!, c.mitralAnnulus[1]![1]!] as Point2D,
              ] as const)
            : null,
          reviewPending: c.reviewPending,
        }));

        const res = calculateSimpsonLvef(contours, spacing);
        if (tc.expected.result === null) {
          expect(res).toBeNull();
        } else {
          expect(res).not.toBeNull();
          expect(res!.method).toBe(tc.expected.result.method);
          expectCloseOrNull(res!.lvefPercent, tc.expected.result.lvefPercent, tol.percent, 'lvef');
          expectCloseOrNull(res!.edvBiMl, tc.expected.result.edvBiMl, tol.ml, 'edvBiMl');
          expectCloseOrNull(res!.esvBiMl, tc.expected.result.esvBiMl, tol.ml, 'esvBiMl');
          expectCloseOrNull(res!.svMl, tc.expected.result.svMl, tol.ml, 'svMl');
          expectCloseOrNull(res!.a4c?.edvMl ?? null, tc.expected.result.a4cEdvMl, tol.ml, 'a4cEdv');
          expectCloseOrNull(res!.a4c?.esvMl ?? null, tc.expected.result.a4cEsvMl, tol.ml, 'a4cEsv');
          expectCloseOrNull(res!.a2c?.edvMl ?? null, tc.expected.result.a2cEdvMl, tol.ml, 'a2cEdv');
          expectCloseOrNull(res!.a2c?.esvMl ?? null, tc.expected.result.a2cEsvMl, tol.ml, 'a2cEsv');
        }

        const first = contours[0]!;
        const closedPoly = first.mitralAnnulus
          ? [...first.points, first.mitralAnnulus[1], first.mitralAnnulus[0]]
          : [...first.points];
        const areaMm2 = spacing ? polygonAreaMm2(closedPoly, spacing) : null;
        expectCloseOrNull(areaMm2, tc.expected.firstContourAreaMm2, tol.mm2, 'areaMm2');

        const lines = computeSimpsonLines(first, spacing);
        expect(lines?.diskLines.length ?? 0).toBe(tc.expected.firstContourDiskCount);
      });
    }
  });

  describe('5. Bernoulli & Continuity Hemodynamics (LVOT/AVA/SV/CO/DVI/Qp:Qs)', () => {
    for (const tc of golden.suites.hemodynamics) {
      it(`matches Python oracle: ${tc.id}`, () => {
        const area = lvotAreaCm2(tc.input.lvotDiameterCm);
        const sv = strokeVolumeMl(area, tc.input.lvotVtiCm);
        const co = cardiacOutputLMin(sv, tc.input.heartRateBpm);
        const ava = avaContinuityCm2(area, tc.input.lvotVtiCm, tc.input.avVtiCm);
        const avai = indexedToBsa(ava, tc.input.bsaM2);
        const svi = indexedToBsa(sv, tc.input.bsaM2);
        const ci = indexedToBsa(co, tc.input.bsaM2);
        const dvi = dimensionlessIndex(tc.input.lvotVtiCm, tc.input.avVtiCm);
        const pg = pressureGradientMmHg(tc.input.avVmaxCmS);
        const qpQs = qpQsRatio(tc.input.rvotSvMl, sv);

        expectCloseOrNull(area, tc.expected.lvotAreaCm2, tol.cm2, 'lvotAreaCm2');
        expectCloseOrNull(sv, tc.expected.strokeVolumeMl, tol.ml, 'strokeVolumeMl');
        expectCloseOrNull(svi, tc.expected.sviMlM2, tol.ml_m2, 'sviMlM2');
        expectCloseOrNull(co, tc.expected.cardiacOutputLMin, tol.l_min, 'cardiacOutputLMin');
        expectCloseOrNull(ci, tc.expected.cardiacIndexLMinM2, tol.l_min_m2, 'cardiacIndexLMinM2');
        expectCloseOrNull(ava, tc.expected.avaCm2, tol.cm2, 'avaCm2');
        expectCloseOrNull(avai, tc.expected.avaiCm2M2, tol.cm2_m2, 'avaiCm2M2');
        expectCloseOrNull(dvi, tc.expected.dviRatio, tol.ratio, 'dviRatio');
        expectCloseOrNull(pg, tc.expected.avPeakGradientMmHg, tol.mmhg, 'avPeakGradientMmHg');
        expectCloseOrNull(qpQs, tc.expected.qpQsRatio, tol.ratio, 'qpQsRatio');
      });
    }
  });

  describe('6. Doppler Trapezoidal VTI & Beat-Averaged Heart Rate', () => {
    for (const tc of golden.suites.doppler) {
      it(`matches Python oracle: ${tc.id}`, () => {
        const traces = tc.input.traces.map((t) =>
          t.points.map((pt) => [pt[0]!, pt[1]!] as const),
        );
        const vti = computeBeatAveragedVtiCm(traces);
        const validRates = tc.input.rrIntervalsMs
          .filter((rr) => rr > 0)
          .map((rr) => heartRateFromIntervalMs(rr))
          .filter((r): r is number => r !== null);
        const meanHr = meanOfLastBeats(validRates);
        const firstHr = heartRateFromIntervalMs(tc.input.rrIntervalsMs[0] ?? null);

        expectCloseOrNull(vti, tc.expected.vtiCm, tol.cm, 'vtiCm');
        expectCloseOrNull(meanHr, tc.expected.meanHeartRateBpm, tol.bpm, 'meanHeartRateBpm');
        expectCloseOrNull(firstHr, tc.expected.firstIntervalHrBpm, tol.bpm, 'firstIntervalHrBpm');
      });
    }
  });
});
