/**
 * Body surface area (Du Bois) and BSA provenance resolution.
 * Ported 1:1 from `echo_personal_tool.domain.calculations.body_surface` (SonoForge@7f9f056).
 * Pure TypeScript — zero UI, DOM, or DICOM dependencies.
 */

export type BsaSource = 'manual' | 'derived' | 'missing';

export interface BsaBasis {
  readonly value: number | null;
  readonly source: BsaSource;
  readonly heightCm: number | null;
  readonly weightKg: number | null;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function bsaDuBoisM2(heightCm: number, weightKg: number): number | null {
  if (!isPositiveFinite(heightCm) || !isPositiveFinite(weightKg)) {
    return null;
  }
  return 0.007184 * Math.pow(heightCm, 0.725) * Math.pow(weightKg, 0.425);
}

export function resolveBsaBasis(params: {
  heightCm?: number | null;
  weightKg?: number | null;
  manualBsaM2?: number | null;
}): BsaBasis {
  const usableHeight = isPositiveFinite(params.heightCm) ? params.heightCm : null;
  const usableWeight = isPositiveFinite(params.weightKg) ? params.weightKg : null;

  if (isPositiveFinite(params.manualBsaM2)) {
    return {
      value: params.manualBsaM2,
      source: 'manual',
      heightCm: usableHeight,
      weightKg: usableWeight,
    };
  }

  if (usableHeight !== null && usableWeight !== null) {
    const derived = bsaDuBoisM2(usableHeight, usableWeight);
    if (derived !== null && derived > 0) {
      return {
        value: derived,
        source: 'derived',
        heightCm: usableHeight,
        weightKg: usableWeight,
      };
    }
  }

  return {
    value: null,
    source: 'missing',
    heightCm: usableHeight,
    weightKg: usableWeight,
  };
}

export function indexedToBsa(value: number | null | undefined, bsaM2: number | null | undefined): number | null {
  if (!isPositiveFinite(value) || !isPositiveFinite(bsaM2)) {
    return null;
  }
  return value / bsaM2;
}
