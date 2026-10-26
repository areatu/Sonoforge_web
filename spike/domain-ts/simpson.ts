/**
 * 20-Disk Simpson Biplane & Monoplane LV Volume / LVEF + Planimetry.
 * Ported 1:1 from `echo_personal_tool.domain.calculations.{lvef_simpson,simpson_contours}`
 * and `echo_personal_tool.domain.services.contour_geometry` (SonoForge@7f9f056).
 */

export type Point2D = readonly [number, number];
export type PixelSpacingMm = readonly [rowMm: number, colMm: number];
export type MitralAnnulus = readonly [septal: Point2D, lateral: Point2D];

export interface SimpsonContourInput {
  readonly phase: string;
  readonly view?: string;
  readonly chamber?: string;
  readonly points: readonly Point2D[];
  readonly mitralAnnulus?: MitralAnnulus | null;
  readonly reviewPending?: boolean;
}

export interface LvViewVolumeMetrics {
  readonly edvMl: number | null;
  readonly esvMl: number | null;
}

export interface SimpsonLvefResult {
  readonly a4c: LvViewVolumeMetrics | null;
  readonly a2c: LvViewVolumeMetrics | null;
  readonly lvefPercent: number | null;
  readonly method: 'simpson_biplan' | 'simpson_monoplan' | null;
  readonly edvBiMl: number | null;
  readonly esvBiMl: number | null;
  readonly svMl: number | null;
}

export interface SimpsonLines {
  readonly centralLine: readonly [Point2D, Point2D];
  readonly diskLines: readonly (readonly [Point2D, Point2D])[];
}

const SIMPSON_N_DISKS = 20;
const SIMPSON_VIEWS = ['A4C', 'A2C'] as const;

export function closedPolygonPoints(contour: SimpsonContourInput): Point2D[] {
  if (!contour.mitralAnnulus) {
    return [...contour.points];
  }
  const [septal, lateral] = contour.mitralAnnulus;
  return [...contour.points, lateral, septal];
}

export function pointLineDistance(point: Point2D, start: Point2D, end: Point2D): number {
  const [x0, y0] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return Math.hypot(x0 - x1, y0 - y1);
  }
  const numerator = Math.abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1);
  const denominator = Math.hypot(dx, dy);
  return numerator / denominator;
}

export function apexPoint(arc: readonly Point2D[], annulus: MitralAnnulus): Point2D {
  if (arc.length === 0) {
    throw new RangeError('arc must contain at least one point');
  }
  const [start, end] = annulus;
  let best = arc[0]!;
  let bestDist = -1;
  for (const pt of arc) {
    const dist = pointLineDistance(pt, start, end);
    if (dist > bestDist) {
      bestDist = dist;
      best = pt;
    }
  }
  return best;
}

export function longAxisEndpoints(
  arc: readonly Point2D[],
  annulus: MitralAnnulus,
): readonly [Point2D, Point2D] {
  const [baseStart, baseEnd] = annulus;
  const base: Point2D = [(baseStart[0] + baseEnd[0]) / 2.0, (baseStart[1] + baseEnd[1]) / 2.0];
  return [base, apexPoint(arc, annulus)];
}

export function polygonAreaMm2(
  polygonPoints: readonly Point2D[],
  pixelSpacing: PixelSpacingMm,
): number {
  if (polygonPoints.length < 3) {
    return 0.0;
  }
  const [rowSpacing, colSpacing] = pixelSpacing;
  const mmPoints: Point2D[] = polygonPoints.map(([col, row]) => [col * colSpacing, row * rowSpacing]);
  let area = 0.0;
  for (let i = 0; i < mmPoints.length; i++) {
    const [x1, y1] = mmPoints[i]!;
    const [x2, y2] = mmPoints[(i + 1) % mmPoints.length]!;
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2.0;
}

function contourToMm(
  contour: SimpsonContourInput,
  pixelSpacing: PixelSpacingMm,
): { pointsMm: Point2D[]; annulusMm: MitralAnnulus | null } {
  const [rowSpacing, colSpacing] = pixelSpacing;
  const poly = closedPolygonPoints(contour);
  const pointsMm: Point2D[] = poly.map(([col, row]) => [col * colSpacing, row * rowSpacing]);
  const annulusMm: MitralAnnulus | null = contour.mitralAnnulus
    ? [
        [contour.mitralAnnulus[0][0] * colSpacing, contour.mitralAnnulus[0][1] * rowSpacing],
        [contour.mitralAnnulus[1][0] * colSpacing, contour.mitralAnnulus[1][1] * rowSpacing],
      ]
    : null;
  return { pointsMm, annulusMm };
}

function simpsonDiskCenters(axisBase: Point2D, axisTip: Point2D, nDisks = SIMPSON_N_DISKS): Point2D[] {
  const dx = axisTip[0] - axisBase[0];
  const dy = axisTip[1] - axisBase[1];
  const centers: Point2D[] = [];
  for (let i = 0; i < nDisks; i++) {
    const f = (i + 0.5) / nDisks;
    centers.push([axisBase[0] + f * dx, axisBase[1] + f * dy]);
  }
  return centers;
}

function perpendicularChord(
  polygon: readonly Point2D[],
  axisBase: Point2D,
  axisTip: Point2D,
  center: Point2D,
): readonly [Point2D, Point2D] | null {
  const axisDx = axisTip[0] - axisBase[0];
  const axisDy = axisTip[1] - axisBase[1];
  const axisLen = Math.hypot(axisDx, axisDy);
  if (axisLen <= 0 || polygon.length < 2) {
    return null;
  }
  const perpX = -axisDy / axisLen;
  const perpY = axisDx / axisLen;

  const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

  const intersections: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    const edgeDx = x2 - x1;
    const edgeDy = y2 - y1;
    const denom = cross(perpX, perpY, edgeDx, edgeDy);
    if (Math.abs(denom) <= 1e-12) continue;

    const relX = x1 - center[0];
    const relY = y1 - center[1];
    const s = cross(relX, relY, edgeDx, edgeDy) / denom;
    const t = cross(relX, relY, perpX, perpY) / denom;
    if (t >= -1e-9 && t <= 1.0 + 1e-9) {
      intersections.push(s);
    }
  }

  if (intersections.length < 2) {
    return null;
  }
  const sMin = Math.min(...intersections);
  const sMax = Math.max(...intersections);
  if (sMax - sMin <= 0) {
    return null;
  }
  const left: Point2D = [center[0] + sMin * perpX, center[1] + sMin * perpY];
  const right: Point2D = [center[0] + sMax * perpX, center[1] + sMax * perpY];
  return [left, right];
}

function findWidthAtY(polygon: readonly Point2D[], yMm: number): number {
  if (polygon.length < 2) return 0.0;
  const intersections: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    if (y1 === y2) continue;
    if ((y1 <= yMm && yMm < y2) || (y2 <= yMm && yMm < y1)) {
      intersections.push(x1 + ((yMm - y1) * (x2 - x1)) / (y2 - y1));
    }
  }
  if (intersections.length < 2) return 0.0;
  return Math.max(...intersections) - Math.min(...intersections);
}

function longAxisMm(pointsMm: readonly Point2D[], annulusMm: MitralAnnulus | null): number {
  if (annulusMm !== null) {
    const [base, tip] = longAxisEndpoints(pointsMm, annulusMm);
    return Math.hypot(tip[0] - base[0], tip[1] - base[1]);
  }
  const ys = pointsMm.map((p) => p[1]);
  return Math.max(...ys) - Math.min(...ys);
}

function diskDiametersMm(pointsMm: readonly Point2D[], annulusMm: MitralAnnulus | null): number[] {
  if (pointsMm.length < 3) return [];

  if (annulusMm !== null) {
    const [base, tip] = longAxisEndpoints(pointsMm, annulusMm);
    const lengthMm = Math.hypot(tip[0] - base[0], tip[1] - base[1]);
    if (lengthMm <= 0) return [];
    return simpsonDiskCenters(base, tip).map((center) => {
      const chord = perpendicularChord(pointsMm, base, tip, center);
      if (!chord) return 0.0;
      return Math.hypot(chord[1][0] - chord[0][0], chord[1][1] - chord[0][1]);
    });
  }

  const ys = pointsMm.map((p) => p[1]);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const lengthMm = maxY - minY;
  if (lengthMm <= 0) return [];

  const diskHeight = lengthMm / SIMPSON_N_DISKS;
  const diameters: number[] = [];
  for (let i = 0; i < SIMPSON_N_DISKS; i++) {
    diameters.push(findWidthAtY(pointsMm, minY + (i + 0.5) * diskHeight));
  }
  return diameters;
}

function monoplaneVolumeMl(pointsMm: readonly Point2D[], annulusMm: MitralAnnulus | null): number {
  const diameters = diskDiametersMm(pointsMm, annulusMm);
  if (diameters.length === 0 || Math.max(...diameters) <= 0) return 0.0;
  const lengthMm = longAxisMm(pointsMm, annulusMm);
  if (lengthMm <= 0) return 0.0;

  const diskHeightMm = lengthMm / SIMPSON_N_DISKS;
  let volumeMm3 = 0.0;
  for (const d of diameters) {
    volumeMm3 += (Math.PI / 4.0) * d * d * diskHeightMm;
  }
  return volumeMm3 / 1000.0;
}

function biplaneVolumeMl(
  pointsA: readonly Point2D[],
  annulusA: MitralAnnulus | null,
  pointsB: readonly Point2D[],
  annulusB: MitralAnnulus | null,
): number | null {
  const diametersA = diskDiametersMm(pointsA, annulusA);
  const diametersB = diskDiametersMm(pointsB, annulusB);
  if (diametersA.length === 0 || diametersB.length === 0 || diametersA.length !== diametersB.length) {
    return null;
  }
  const lenA = longAxisMm(pointsA, annulusA);
  const lenB = longAxisMm(pointsB, annulusB);
  if (lenA <= 0 || lenB <= 0) return null;

  // ASE foreshortening rule: max(L4C, L2C) / 20
  const diskHeightMm = Math.max(lenA, lenB) / SIMPSON_N_DISKS;
  let volumeMm3 = 0.0;
  for (let i = 0; i < diametersA.length; i++) {
    const dA = diametersA[i]!;
    const dB = diametersB[i]!;
    if (dA <= 0 || dB <= 0) continue;
    volumeMm3 += (Math.PI / 4.0) * dA * dB * diskHeightMm;
  }
  return volumeMm3 / 1000.0;
}

export function calculateSimpsonLvef(
  contours: readonly SimpsonContourInput[],
  pixelSpacing: PixelSpacingMm | null | undefined,
): SimpsonLvefResult | null {
  if (!pixelSpacing) return null;
  const [rowSpacing, colSpacing] = pixelSpacing;
  if (!Number.isFinite(rowSpacing) || !Number.isFinite(colSpacing) || rowSpacing <= 0 || colSpacing <= 0) {
    return null;
  }

  type Geom = { pointsMm: Point2D[]; annulusMm: MitralAnnulus | null };
  const grouped: Record<'A4C' | 'A2C', Partial<Record<'ed' | 'es', Geom>>> = {
    A4C: {},
    A2C: {},
  };

  for (const c of contours) {
    if ((c.chamber ?? 'LV').toUpperCase() !== 'LV' || c.reviewPending) continue;
    const phase = c.phase.toLowerCase();
    const view = (c.view ?? 'A4C').toUpperCase();
    if ((phase !== 'ed' && phase !== 'es') || (view !== 'A4C' && view !== 'A2C')) continue;
    grouped[view][phase] = contourToMm(c, pixelSpacing);
  }

  const buildView = (viewMap: Partial<Record<'ed' | 'es', Geom>>): LvViewVolumeMetrics | null => {
    const ed = viewMap.ed ? monoplaneVolumeMl(viewMap.ed.pointsMm, viewMap.ed.annulusMm) : null;
    const es = viewMap.es ? monoplaneVolumeMl(viewMap.es.pointsMm, viewMap.es.annulusMm) : null;
    const edVal = ed !== null && ed > 0 ? ed : null;
    const esVal = es !== null && es > 0 ? es : null;
    if (edVal === null && esVal === null) return null;
    return { edvMl: edVal, esvMl: esVal };
  };

  const a4c = buildView(grouped.A4C);
  const a2c = buildView(grouped.A2C);
  if (a4c === null && a2c === null) return null;

  let lvefPercent: number | null = null;
  let method: 'simpson_biplan' | 'simpson_monoplan' | null = null;
  let edvBiMl: number | null = null;
  let esvBiMl: number | null = null;
  let svMl: number | null = null;

  if (
    a4c !== null &&
    a2c !== null &&
    grouped.A4C.ed?.annulusMm &&
    grouped.A4C.es?.annulusMm &&
    grouped.A2C.ed?.annulusMm &&
    grouped.A2C.es?.annulusMm
  ) {
    const edv = biplaneVolumeMl(
      grouped.A4C.ed.pointsMm,
      grouped.A4C.ed.annulusMm,
      grouped.A2C.ed.pointsMm,
      grouped.A2C.ed.annulusMm,
    );
    const esv = biplaneVolumeMl(
      grouped.A4C.es.pointsMm,
      grouped.A4C.es.annulusMm,
      grouped.A2C.es.pointsMm,
      grouped.A2C.es.annulusMm,
    );
    if (edv !== null && esv !== null && edv > 0 && esv <= edv) {
      lvefPercent = ((edv - esv) / edv) * 100.0;
      method = 'simpson_biplan';
      edvBiMl = edv;
      esvBiMl = esv;
      svMl = edv - esv;
    }
  }

  if (lvefPercent === null) {
    const pairs: [number, number][] = [];
    for (const v of SIMPSON_VIEWS) {
      const m = v === 'A4C' ? a4c : a2c;
      if (m && m.edvMl !== null && m.esvMl !== null) {
        pairs.push([m.edvMl, m.esvMl]);
      }
    }
    if (pairs.length > 0) {
      const edv = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
      const esv = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
      if (edv > 0 && esv <= edv) {
        lvefPercent = ((edv - esv) / edv) * 100.0;
        method = 'simpson_monoplan';
        svMl = edv - esv;
      }
    }
  }

  return {
    a4c,
    a2c,
    lvefPercent,
    method,
    edvBiMl,
    esvBiMl,
    svMl,
  };
}

export function computeSimpsonLines(
  contour: SimpsonContourInput,
  pixelSpacing?: PixelSpacingMm | null,
): SimpsonLines | null {
  if (!contour.mitralAnnulus || contour.points.length < 4) {
    return null;
  }

  const useMm =
    pixelSpacing !== null &&
    pixelSpacing !== undefined &&
    pixelSpacing[0] > 0 &&
    pixelSpacing[1] > 0;
  const rowSpacing = useMm ? pixelSpacing[0] : 1.0;
  const colSpacing = useMm ? pixelSpacing[1] : 1.0;

  const { pointsMm: polygon, annulusMm: annulus } = useMm
    ? contourToMm(contour, [rowSpacing, colSpacing])
    : { pointsMm: closedPolygonPoints(contour), annulusMm: contour.mitralAnnulus };

  if (!annulus || polygon.length < 3) return null;

  let [base, tip] = longAxisEndpoints(polygon, annulus);
  if (Math.hypot(tip[0] - base[0], tip[1] - base[1]) <= 0) return null;

  let diskLines: (readonly [Point2D, Point2D])[] = [];
  for (const center of simpsonDiskCenters(base, tip)) {
    const chord = perpendicularChord(polygon, base, tip, center);
    if (chord) diskLines.push(chord);
  }

  if (useMm) {
    const toPx = (pt: Point2D): Point2D => [pt[0] / colSpacing, pt[1] / rowSpacing];
    base = toPx(base);
    tip = toPx(tip);
    diskLines = diskLines.map(([l, r]) => [toPx(l), toPx(r)]);
  }

  return { centralLine: [base, tip], diskLines };
}
