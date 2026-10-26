/**
 * ASE 2015 Cube Left Ventricular Mass (LVM) and Relative Wall Thickness (RWT).
 * Ported 1:1 from `echo_personal_tool.domain.calculations.{lvm,rwt}` (SonoForge@7f9f056).
 */

import type { LinearCaliperInput } from './teichholz';

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function lvmGrams(ivsdMm: number, lveddMm: number, lvpwdMm: number): number | null {
  if (!isPositiveFinite(ivsdMm) || !isPositiveFinite(lveddMm) || !isPositiveFinite(lvpwdMm)) {
    return null;
  }
  const ivsdCm = ivsdMm / 10.0;
  const lveddCm = lveddMm / 10.0;
  const lvpwdCm = lvpwdMm / 10.0;
  const innerSum = ivsdCm + lveddCm + lvpwdCm;
  return 0.8 * 1.04 * (Math.pow(innerSum, 3) - Math.pow(lveddCm, 3)) + 0.6;
}

export function relativeWallThickness(lvpwdMm: number, lveddMm: number): number | null {
  if (!isPositiveFinite(lvpwdMm) || !isPositiveFinite(lveddMm)) {
    return null;
  }
  return (2.0 * lvpwdMm) / lveddMm;
}

export function lvmFromLinearMeasurements(measurements: readonly LinearCaliperInput[]): number | null {
  const values = new Map<string, number>();
  for (const m of measurements) {
    if (m.millimeterLength === null) continue;
    const key = m.label.trim().toUpperCase();
    if (key === 'IVSD' || key === 'LVEDD' || key === 'LVPWD') {
      values.set(key, m.millimeterLength);
    }
  }
  const ivsd = values.get('IVSD');
  const lvedd = values.get('LVEDD');
  const lvpwd = values.get('LVPWD');
  if (ivsd === undefined || lvedd === undefined || lvpwd === undefined) {
    return null;
  }
  return lvmGrams(ivsd, lvedd, lvpwd);
}

export function rwtFromLinearMeasurements(measurements: readonly LinearCaliperInput[]): number | null {
  let lvpwdMm: number | null = null;
  let lveddMm: number | null = null;
  for (const m of measurements) {
    if (m.millimeterLength === null) continue;
    const key = m.label.trim().toUpperCase();
    if (key === 'LVPWD') lvpwdMm = m.millimeterLength;
    else if (key === 'LVEDD') lveddMm = m.millimeterLength;
  }
  if (lvpwdMm === null || lveddMm === null) {
    return null;
  }
  return relativeWallThickness(lvpwdMm, lveddMm);
}
