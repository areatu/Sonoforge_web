/**
 * Teichholz cube LV volume, Fractional Shortening, and Ejection Fraction.
 * Ported 1:1 from `echo_personal_tool.domain.calculations.teichholz` (SonoForge@7f9f056).
 */

export interface LinearCaliperInput {
  readonly label: string;
  readonly millimeterLength: number | null;
}

export interface TeichholzResult {
  readonly edvMl: number;
  readonly esvMl: number;
  readonly lvefPercent: number;
  readonly svMl: number;
}

const LVEDD_ALIASES = new Set([
  'lvedd',
  'lvidd',
  'lv_edd',
  'lv_end_diastolic_diameter',
]);

const LVESD_ALIASES = new Set([
  'lvesd',
  'lvids',
  'lv_esd',
  'lv_end_systolic_diameter',
]);

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function teichholzVolumeMl(dimensionMm: number): number {
  const lCm = dimensionMm / 10.0;
  if (!Number.isFinite(lCm) || lCm <= 0) {
    throw new RangeError('dimension must be positive and finite');
  }
  return (7.0 / (2.4 + lCm)) * Math.pow(lCm, 3);
}

export function teichholzVolumeFromCmMl(dimensionCm: number | null | undefined): number | null {
  if (!isPositiveFinite(dimensionCm)) {
    return null;
  }
  return teichholzVolumeMl(dimensionCm * 10.0);
}

export function fractionalShorteningPercent(
  lveddCm: number | null | undefined,
  lvesdCm: number | null | undefined,
): number | null {
  if (!isPositiveFinite(lveddCm) || !isPositiveFinite(lvesdCm) || lvesdCm >= lveddCm) {
    return null;
  }
  return ((lveddCm - lvesdCm) / lveddCm) * 100.0;
}

export function ejectionFractionPercent(
  edvMl: number | null | undefined,
  esvMl: number | null | undefined,
): number | null {
  if (!isPositiveFinite(edvMl) || !isPositiveFinite(esvMl) || esvMl >= edvMl) {
    return null;
  }
  return ((edvMl - esvMl) / edvMl) * 100.0;
}

export function teichholzFromLinearMeasurements(
  measurements: readonly LinearCaliperInput[],
): TeichholzResult | null {
  let lveddMm: number | null = null;
  let lvesdMm: number | null = null;

  for (const m of measurements) {
    if (m.millimeterLength === null) continue;
    const key = m.label.trim().toLowerCase();
    if (LVEDD_ALIASES.has(key)) {
      lveddMm = m.millimeterLength;
    } else if (LVESD_ALIASES.has(key)) {
      lvesdMm = m.millimeterLength;
    }
  }

  if (!isPositiveFinite(lveddMm) || !isPositiveFinite(lvesdMm) || lvesdMm >= lveddMm) {
    return null;
  }

  const edvMl = teichholzVolumeMl(lveddMm);
  const esvMl = teichholzVolumeMl(lvesdMm);
  const lvefPercent = ((edvMl - esvMl) / edvMl) * 100.0;
  const svMl = edvMl - esvMl;
  return { edvMl, esvMl, lvefPercent, svMl };
}
