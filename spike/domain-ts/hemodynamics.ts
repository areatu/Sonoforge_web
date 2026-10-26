/**
 * Simplified Bernoulli, Continuity Equation Hemodynamics, and Doppler VTI / HR.
 * Ported 1:1 from `echo_personal_tool.domain.calculations.{bernoulli,continuity,doppler_metrics}`
 * (SonoForge@7f9f056).
 */

export const DOPPLER_REPORT_WINDOW = 3;

export interface DopplerTracePoint {
  readonly timeMs: number;
  readonly velocityCmS: number;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function pressureGradientMmHg(velocityCmS: number | null | undefined): number | null {
  if (velocityCmS === null || velocityCmS === undefined || !Number.isFinite(velocityCmS)) {
    return null;
  }
  const vMS = velocityCmS / 100.0;
  return 4.0 * vMS * vMS;
}

export function circleAreaCm2(diameterCm: number | null | undefined): number | null {
  if (!isPositiveFinite(diameterCm)) return null;
  const radius = diameterCm / 2.0;
  return Math.PI * radius * radius;
}

export function lvotAreaCm2(lvotDiameterCm: number | null | undefined): number | null {
  return circleAreaCm2(lvotDiameterCm);
}

export function strokeVolumeMl(
  lvotArea: number | null | undefined,
  lvotVtiCm: number | null | undefined,
): number | null {
  if (!isPositiveFinite(lvotArea) || !isPositiveFinite(lvotVtiCm)) return null;
  return lvotArea * lvotVtiCm;
}

export function cardiacOutputLMin(
  strokeVolume: number | null | undefined,
  heartRateBpm: number | null | undefined,
): number | null {
  if (!isPositiveFinite(strokeVolume) || !isPositiveFinite(heartRateBpm)) return null;
  return (strokeVolume * heartRateBpm) / 1000.0;
}

export function avaContinuityCm2(
  lvotArea: number | null | undefined,
  lvotFlow: number | null | undefined,
  avFlow: number | null | undefined,
): number | null {
  if (!isPositiveFinite(lvotArea) || !isPositiveFinite(lvotFlow) || !isPositiveFinite(avFlow)) {
    return null;
  }
  return (lvotArea * lvotFlow) / avFlow;
}

export function dimensionlessIndex(
  lvotFlow: number | null | undefined,
  avFlow: number | null | undefined,
): number | null {
  if (!isPositiveFinite(lvotFlow) || !isPositiveFinite(avFlow)) return null;
  return lvotFlow / avFlow;
}

export function qpQsRatio(
  qpMl: number | null | undefined,
  qsMl: number | null | undefined,
): number | null {
  if (!isPositiveFinite(qpMl) || !isPositiveFinite(qsMl)) return null;
  return qpMl / qsMl;
}

export function heartRateFromIntervalMs(durationMs: number | null | undefined): number | null {
  if (!isPositiveFinite(durationMs)) return null;
  const bpm = 60000.0 / durationMs;
  return Number.isFinite(bpm) ? bpm : null;
}

export function meanOfLastBeats(values: readonly number[], window = DOPPLER_REPORT_WINDOW): number | null {
  const valid = values.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  const recent = valid.slice(-window);
  return recent.reduce((acc, v) => acc + v, 0) / recent.length;
}

/**
 * Trapezoidal integral of velocity (cm/s) over time (ms), divided by 1000 -> cm.
 * Matches `np.trapezoid(velocities, times) / 1000.0` in `doppler_metrics._find_vti_cm`.
 */
export function trapezoidalTraceIntegralCm(points: readonly (readonly [number, number])[]): number | null {
  if (points.length < 2) return null;
  let integral = 0.0;
  for (let i = 0; i < points.length - 1; i++) {
    const [t0, v0] = points[i]!;
    const [t1, v1] = points[i + 1]!;
    integral += 0.5 * (v0 + v1) * (t1 - t0);
  }
  return integral / 1000.0;
}

export function computeBeatAveragedVtiCm(
  traces: readonly (readonly (readonly [number, number])[])[],
  window = DOPPLER_REPORT_WINDOW,
): number | null {
  const validTraces = traces.filter((pts) => pts.length >= 2).slice(-window);
  if (validTraces.length === 0) return null;
  const integrals: number[] = [];
  for (const pts of validTraces) {
    const val = trapezoidalTraceIntegralCm(pts);
    if (val !== null) integrals.push(val);
  }
  if (integrals.length === 0) return null;
  const mean = integrals.reduce((s, x) => s + x, 0) / integrals.length;
  return Math.abs(mean);
}
