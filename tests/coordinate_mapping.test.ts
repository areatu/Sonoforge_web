import { describe, expect, it } from 'vitest';
import {
  imageToDevicePixels,
  imageToScreenCss,
  measureLinearDistance,
  screenCssToImage,
  spacingFromKnownDistance,
  type ViewportTransform,
} from '../spike/dicom-ts';
import type { Point2D } from '../spike/domain-ts';

describe('Viewport Coordinate Transforms & Calibration Safety Invariants', () => {
  const samplePoints: Point2D[] = [
    [0, 0],
    [640, 360],
    [412.75, 198.25],
    [1279, 719],
  ];

  const viewportStates: ViewportTransform[] = [
    {
      imageWidth: 1280,
      imageHeight: 720,
      canvasCssWidth: 960,
      canvasCssHeight: 600,
      devicePixelRatio: 1,
      zoom: 1,
      panCssX: 0,
      panCssY: 0,
    },
    {
      imageWidth: 1280,
      imageHeight: 720,
      canvasCssWidth: 1440,
      canvasCssHeight: 900,
      devicePixelRatio: 2,
      zoom: 2.75,
      panCssX: -135.5,
      panCssY: 84.25,
    },
    {
      imageWidth: 800,
      imageHeight: 600,
      canvasCssWidth: 390,
      canvasCssHeight: 520,
      devicePixelRatio: 3,
      zoom: 0.65,
      panCssX: 42,
      panCssY: -19,
    },
  ];

  it('preserves exact image coordinates and physical mm length across pan/zoom/resize/HiDPI', () => {
    const pStart: Point2D = [310.4, 180.2];
    const pEnd: Point2D = [512.9, 442.7];
    const spacing: readonly [number, number] = [0.32, 0.28]; // anisotropic [rowMm, colMm]
    const reference = measureLinearDistance(pStart, pEnd, spacing, 'PixelSpacing');

    for (const vp of viewportStates) {
      for (const pt of samplePoints) {
        const css = imageToScreenCss(pt, vp);
        const roundTrip = screenCssToImage(css, vp);
        expect(roundTrip[0]).toBeCloseTo(pt[0], 9);
        expect(roundTrip[1]).toBeCloseTo(pt[1], 9);

        const dev = imageToDevicePixels(pt, vp);
        expect(dev[0]).toBeCloseTo(css[0] * vp.devicePixelRatio, 9);
        expect(dev[1]).toBeCloseTo(css[1] * vp.devicePixelRatio, 9);
      }

      const startAfterTransform = screenCssToImage(imageToScreenCss(pStart, vp), vp);
      const endAfterTransform = screenCssToImage(imageToScreenCss(pEnd, vp), vp);
      const measured = measureLinearDistance(
        startAfterTransform,
        endAfterTransform,
        spacing,
        'PixelSpacing',
      );
      expect(measured.calibrated).toBe(true);
      expect(measured.unit).toBe('mm');
      expect(measured.millimeterLength!).toBeCloseTo(reference.millimeterLength!, 9);
    }
  });

  it('never reports millimeters on uncalibrated clips until manual calibration is supplied', () => {
    const p1: Point2D = [100, 100];
    const p2: Point2D = [100, 200]; // 100 px vertical

    const uncal = measureLinearDistance(p1, p2, null);
    expect(uncal.calibrated).toBe(false);
    expect(uncal.millimeterLength).toBeNull();
    expect(uncal.unit).toBe('px');
    expect(uncal.displayValue).toBeCloseTo(100, 9);

    const manualSpacing = spacingFromKnownDistance(p1, p2, 50.0); // 100 px = 50 mm -> 0.5 mm/px
    const cal = measureLinearDistance(p1, p2, manualSpacing, 'manual_ruler');
    expect(cal.calibrated).toBe(true);
    expect(cal.unit).toBe('mm');
    expect(cal.millimeterLength).toBeCloseTo(50.0, 9);
    expect(cal.spacingSource).toBe('manual_ruler');
  });
});
