/**
 * Invertible Display <-> Image coordinate transforms and calibrated linear geometry.
 *
 * Guarantees Spec §4 & §6 invariants:
 * 1. Measurements are stored in image pixel coordinates (`[col, row]`) and remain invariant
 *    under pan, zoom, canvas resize, and HiDPI `devicePixelRatio` changes.
 * 2. Uncalibrated images NEVER report millimeters (`millimeterLength: null`, `unit: 'px'`).
 */

import type { Point2D } from '../domain-ts';

export interface ViewportTransform {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly canvasCssWidth: number;
  readonly canvasCssHeight: number;
  readonly devicePixelRatio: number;
  readonly zoom: number;
  readonly panCssX: number;
  readonly panCssY: number;
}

export interface LinearDistanceResult {
  readonly pixelLength: number;
  readonly millimeterLength: number | null;
  readonly displayValue: number;
  readonly unit: 'mm' | 'px';
  readonly calibrated: boolean;
  readonly spacingSource: string | null;
}

export function baseFitScale(transform: ViewportTransform): number {
  const w = Math.max(transform.imageWidth, 1);
  const h = Math.max(transform.imageHeight, 1);
  const cw = Math.max(transform.canvasCssWidth, 1);
  const ch = Math.max(transform.canvasCssHeight, 1);
  return Math.min(cw / w, ch / h);
}

/**
 * Convert image coordinates `(col, row)` to CSS pixel coordinates on the viewport canvas.
 */
export function imageToScreenCss(point: Point2D, transform: ViewportTransform): Point2D {
  const scale = baseFitScale(transform) * Math.max(transform.zoom, 0.05);
  const centerX = transform.canvasCssWidth / 2 + transform.panCssX;
  const centerY = transform.canvasCssHeight / 2 + transform.panCssY;
  const dx = point[0] - transform.imageWidth / 2;
  const dy = point[1] - transform.imageHeight / 2;
  return [centerX + dx * scale, centerY + dy * scale];
}

/**
 * Convert image coordinates `(col, row)` to physical backing-store canvas pixels (HiDPI).
 */
export function imageToDevicePixels(point: Point2D, transform: ViewportTransform): Point2D {
  const [cssX, cssY] = imageToScreenCss(point, transform);
  const dpr = Math.max(transform.devicePixelRatio, 1);
  return [cssX * dpr, cssY * dpr];
}

/**
 * Convert pointer CSS coordinates `(clientX - rect.left, clientY - rect.top)` back to image `(col, row)`.
 */
export function screenCssToImage(screenCss: Point2D, transform: ViewportTransform): Point2D {
  const scale = baseFitScale(transform) * Math.max(transform.zoom, 0.05);
  const centerX = transform.canvasCssWidth / 2 + transform.panCssX;
  const centerY = transform.canvasCssHeight / 2 + transform.panCssY;
  const col = (screenCss[0] - centerX) / scale + transform.imageWidth / 2;
  const row = (screenCss[1] - centerY) / scale + transform.imageHeight / 2;
  return [col, row];
}

/**
 * Compute Euclidean physical distance supporting anisotropic `[rowMm, colMm]` spacing.
 * Never fabricates `mm` when `pixelSpacingMm` is absent.
 */
export function measureLinearDistance(
  startImage: Point2D,
  endImage: Point2D,
  pixelSpacingMm: readonly [rowMm: number, colMm: number] | null,
  spacingSource: string | null = null,
): LinearDistanceResult {
  const dCol = endImage[0] - startImage[0];
  const dRow = endImage[1] - startImage[1];
  const pixelLength = Math.hypot(dCol, dRow);

  if (
    pixelSpacingMm !== null &&
    Number.isFinite(pixelSpacingMm[0]) &&
    Number.isFinite(pixelSpacingMm[1]) &&
    pixelSpacingMm[0] > 0 &&
    pixelSpacingMm[1] > 0
  ) {
    const [rowMm, colMm] = pixelSpacingMm;
    const millimeterLength = Math.hypot(dCol * colMm, dRow * rowMm);
    return {
      pixelLength,
      millimeterLength,
      displayValue: millimeterLength,
      unit: 'mm',
      calibrated: true,
      spacingSource: spacingSource ?? 'calibrated',
    };
  }

  return {
    pixelLength,
    millimeterLength: null,
    displayValue: pixelLength,
    unit: 'px',
    calibrated: false,
    spacingSource: null,
  };
}

/**
 * Derive isotropic manual spacing `[mmPerPx, mmPerPx]` from a user-drawn ruler line.
 * Matches `spacing_from_known_distance` in `pixel_spacing_resolver.py`.
 */
export function spacingFromKnownDistance(
  startImage: Point2D,
  endImage: Point2D,
  knownMm: number,
): readonly [number, number] {
  const pxLen = Math.hypot(endImage[0] - startImage[0], endImage[1] - startImage[1]);
  if (!Number.isFinite(pxLen) || pxLen <= 0) {
    throw new RangeError('Calibration line pixel length must be positive');
  }
  if (!Number.isFinite(knownMm) || knownMm <= 0) {
    throw new RangeError('Known calibration distance (mm) must be positive');
  }
  const mmPerPx = knownMm / pxLen;
  return [mmPerPx, mmPerPx];
}
