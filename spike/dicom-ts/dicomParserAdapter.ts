/**
 * `DicomFileReader` implementation backed by `dicom-parser` (MIT, 32 KB min).
 *
 * Implements SonoForge's full 6-tier ultrasound calibration resolution chain:
 *   1. `PixelSpacing` (0028,0030)
 *   2. `ImagerPixelSpacing` (0018,1164)
 *   3. `NominalScannedPixelSpacing` (0018,2010)
 *   4. `SequenceOfUltrasoundRegions` (0018,6011) — preferring 2D tissue (`RegionSpatialFormat=1`,
 *      `RegionDataType=1`) over Color Flow / Doppler regions, converting cm (3) -> mm (*10)
 *   5. `SharedFunctionalGroupsSequence` (5200,9229) -> `PixelMeasuresSequence` (0028,9110)
 *   6. `PerFrameFunctionalGroupsSequence` (5200,9230) -> `PixelMeasuresSequence` (0028,9110)
 */

import * as dicomParserNs from 'dicom-parser';
import type { DataSet, Element } from 'dicom-parser';

const dicomParser: typeof dicomParserNs =
  typeof (dicomParserNs as { parseDicom?: unknown }).parseDicom === 'function'
    ? dicomParserNs
    : ((dicomParserNs as unknown as { default: typeof dicomParserNs }).default ?? dicomParserNs);
import type {
  ClipMode,
  DicomFileReader,
  ParsedDicomInstance,
  PixelSpacingResolution,
  TransferSyntaxCapability,
} from './ports';

const IMPLICIT_SEQUENCE_TAGS = new Set([
  'x00186011', // SequenceOfUltrasoundRegions
  'x52009229', // SharedFunctionalGroupsSequence
  'x52009230', // PerFrameFunctionalGroupsSequence
  'x00289110', // PixelMeasuresSequence
  'x54000100', // WaveformSequence
]);

const TRANSFER_SYNTAX_CATALOG: Record<string, Omit<TransferSyntaxCapability, 'uid'>> = {
  '1.2.840.10008.1.2': {
    name: 'Implicit VR Little Endian',
    compressed: false,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.1': {
    name: 'Explicit VR Little Endian',
    compressed: false,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.2': {
    name: 'Explicit VR Big Endian (Retired)',
    compressed: false,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.5': {
    name: 'RLE Lossless',
    compressed: true,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.50': {
    name: 'JPEG Baseline (Process 1, 8-bit)',
    compressed: true,
    lossless: false,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.57': {
    name: 'JPEG Lossless Non-Hierarchical (Process 14)',
    compressed: true,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.70': {
    name: 'JPEG Lossless First-Order Prediction (P14SV1)',
    compressed: true,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.80': {
    name: 'JPEG-LS Lossless',
    compressed: true,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.81': {
    name: 'JPEG-LS Near-Lossless',
    compressed: true,
    lossless: false,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.90': {
    name: 'JPEG 2000 Image Compression (Lossless Only)',
    compressed: true,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.91': {
    name: 'JPEG 2000 Image Compression',
    compressed: true,
    lossless: false,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.201': {
    name: 'High-Throughput JPEG 2000 (HTJ2K Lossless Only)',
    compressed: true,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.202': {
    name: 'High-Throughput JPEG 2000 RPCL (Lossless Only)',
    compressed: true,
    lossless: true,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
  '1.2.840.10008.1.2.4.203': {
    name: 'High-Throughput JPEG 2000 (HTJ2K)',
    compressed: true,
    lossless: false,
    supportedInBrowser: true,
    fallbackStrategy: null,
  },
};

export function describeTransferSyntax(uid: string): TransferSyntaxCapability {
  const clean = uid.replace(/\0/g, '').trim() || '1.2.840.10008.1.2.1';
  const known = TRANSFER_SYNTAX_CATALOG[clean];
  if (known) {
    return { uid: clean, ...known };
  }
  const isVideo =
    clean.startsWith('1.2.840.10008.1.2.4.10') && clean.length >= '1.2.840.10008.1.2.4.100'.length;
  return {
    uid: clean,
    name: isVideo ? `DICOM Encapsulated Video (${clean})` : `Unsupported Syntax (${clean})`,
    compressed: true,
    lossless: false,
    supportedInBrowser: false,
    fallbackStrategy: isVideo
      ? 'Encapsulated MPEG2/H.264/HEVC video is lossy and excluded from measurement path; use DICOMweb WADO-RS rendered preview or transcode offline.'
      : 'Syntax is not in the browser WASM codec matrix; use DICOMweb WADO-RS rendered preview or transcode to Explicit VR Little Endian / JPEG 2000 Lossless.',
  };
}

function cleanStr(ds: DataSet, tag: string, fallback = ''): string {
  const raw = ds.string(tag);
  if (!raw) return fallback;
  return raw.replace(/\0/g, '').trim() || fallback;
}

function parseSpacingPair(ds: DataSet, tag: string, source: string): PixelSpacingResolution | null {
  const raw = cleanStr(ds, tag);
  if (!raw) return null;
  const parts = raw.split('\\').map((s) => Number.parseFloat(s.trim()));
  if (parts.length < 2) return null;
  const row = parts[0]!;
  const col = parts[1]!;
  if (!Number.isFinite(row) || !Number.isFinite(col) || row <= 0 || col <= 0) {
    return null;
  }
  return { spacingMm: [row, col], source };
}

function resolveUltrasoundRegionsSpacing(ds: DataSet): PixelSpacingResolution | null {
  const seq = ds.elements.x00186011;
  if (!seq?.items || seq.items.length === 0) return null;

  let preferred: PixelSpacingResolution | null = null;
  let fallback: PixelSpacingResolution | null = null;

  for (const item of seq.items) {
    const rds = item.dataSet;
    if (!rds) continue;
    const spatialFormat = rds.uint16('x00186012') ?? 0;
    const dataType = rds.uint16('x00186014') ?? 0;
    // Spatial calibration applies to 2D tissue (spatialFormat === 1)
    if (spatialFormat !== 1) continue;

    const unitsX = rds.uint16('x00186024'); // 3 = cm, 4 = mm (or 0018,6024 PhysicalUnitsXDirection)
    const unitsY = rds.uint16('x00186026'); // PhysicalUnitsYDirection
    const deltaX = rds.double('x0018602c'); // PhysicalDeltaX
    const deltaY = rds.double('x0018602e'); // PhysicalDeltaY
    if (deltaX === undefined || deltaY === undefined) continue;

    const toMm = (delta: number, units: number | undefined): number | null => {
      if (!Number.isFinite(delta) || delta === 0) return null;
      if (units === undefined || units === 3) return Math.abs(delta) * 10.0; // cm -> mm
      if (units === 4) return Math.abs(delta); // mm
      return null;
    };

    const colMm = toMm(deltaX, unitsX);
    const rowMm = toMm(deltaY, unitsY);
    if (colMm === null || rowMm === null || colMm <= 0 || rowMm <= 0) continue;

    const candidate: PixelSpacingResolution = {
      spacingMm: [Number(rowMm.toFixed(8)), Number(colMm.toFixed(8))],
      source: 'SequenceOfUltrasoundRegions',
    };
    if (spatialFormat === 1 && dataType === 1) {
      preferred = candidate;
      break;
    }
    if (!fallback) fallback = candidate;
  }

  return preferred ?? fallback;
}

function resolveFunctionalGroupSpacing(
  ds: DataSet,
  seqTag: string,
  sourcePrefix: string,
): PixelSpacingResolution | null {
  const seq = ds.elements[seqTag];
  const firstGroup = seq?.items?.[0]?.dataSet;
  if (!firstGroup) return null;
  const pixelMeasures = firstGroup.elements.x00289110?.items?.[0]?.dataSet;
  if (!pixelMeasures) return null;
  return parseSpacingPair(pixelMeasures, 'x00280030', `${sourcePrefix}/PixelSpacing`);
}

export function resolveDicomPixelSpacing(ds: DataSet): PixelSpacingResolution | null {
  return (
    parseSpacingPair(ds, 'x00280030', 'PixelSpacing') ??
    parseSpacingPair(ds, 'x00181164', 'ImagerPixelSpacing') ??
    parseSpacingPair(ds, 'x00182010', 'NominalScannedPixelSpacing') ??
    resolveUltrasoundRegionsSpacing(ds) ??
    resolveFunctionalGroupSpacing(ds, 'x52009229', 'SharedFunctionalGroupsSequence') ??
    resolveFunctionalGroupSpacing(ds, 'x52009230', 'PerFrameFunctionalGroupsSequence')
  );
}

function classifyClipMode(ds: DataSet, seriesDescription: string): ClipMode {
  const seq = ds.elements.x00186011;
  if (seq?.items) {
    let hasMMode = false;
    let hasDoppler = false;
    for (const item of seq.items) {
      const rds = item.dataSet;
      if (!rds) continue;
      const spatial = rds.uint16('x00186012') ?? 0;
      const dtype = rds.uint16('x00186014') ?? 0;
      if (spatial === 2) hasMMode = true;
      if (spatial === 3 || dtype === 2 || dtype === 3 || dtype === 4) hasDoppler = true;
    }
    if (hasMMode) return 'm_mode';
    if (hasDoppler) return 'doppler';
  }
  const imageType = cleanStr(ds, 'x00080008');
  const text = `${seriesDescription} ${imageType}`.toLowerCase();
  if (text.includes('m-mode') || text.includes('m mode') || text.includes('mmode') || text.includes('м-реж')) {
    return 'm_mode';
  }
  if (
    text.includes('doppler') ||
    text.includes('допплер') ||
    text.includes('spectral') ||
    text.includes('color flow') ||
    /\b(pw|cw|tdi)\b/i.test(text)
  ) {
    return 'doppler';
  }
  return '2d';
}

function extractEncapsulatedFrames(
  ds: DataSet,
  pixelElement: Element,
  declaredFrames: number,
): Uint8Array[] {
  const fragments = pixelElement.fragments ?? [];
  if (fragments.length === 0) {
    return [];
  }

  // Case 1: Non-empty Basic Offset Table (note: encapsulated MPEG2/H.264 video has 1 stream in BOT while NumberOfFrames=N)
  const bot = pixelElement.basicOffsetTable;
  if (bot && bot.length > 0) {
    const slices: Uint8Array[] = [];
    for (let i = 0; i < bot.length; i++) {
      slices.push(dicomParser.readEncapsulatedImageFrame(ds, pixelElement, i, bot));
    }
    return slices;
  }

  // Case 2: Single frame across all fragments
  if (declaredFrames <= 1) {
    return [
      dicomParser.readEncapsulatedPixelDataFromFragments(
        ds,
        pixelElement,
        0,
        fragments.length,
        fragments,
      ),
    ];
  }

  // Case 3: 1-to-1 fragments === declaredFrames (standard multi-frame without BOT)
  if (fragments.length === declaredFrames) {
    return fragments.map((_, idx) =>
      dicomParser.readEncapsulatedPixelDataFromFragments(ds, pixelElement, idx, 1, fragments),
    );
  }

  // Case 4: Reconstruct JPEG/J2K Basic Offset Table by scanning 0xFFD8 / 0xFF4F SOI markers
  try {
    const builtBot = dicomParser.createJPEGBasicOffsetTable(ds, pixelElement, fragments);
    if (builtBot.length >= declaredFrames) {
      const slices: Uint8Array[] = [];
      for (let i = 0; i < declaredFrames; i++) {
        slices.push(dicomParser.readEncapsulatedImageFrame(ds, pixelElement, i, builtBot));
      }
      return slices;
    }
  } catch {
    // Fall back to fragment-per-frame best effort below
  }

  const limit = Math.min(declaredFrames, fragments.length);
  const fallbackSlices: Uint8Array[] = [];
  for (let i = 0; i < limit; i++) {
    fallbackSlices.push(
      dicomParser.readEncapsulatedPixelDataFromFragments(ds, pixelElement, i, 1, fragments),
    );
  }
  return fallbackSlices;
}

export class DicomParserFileReader implements DicomFileReader {
  public readMetadata(bytes: Uint8Array, fileId: string, fileName: string): ParsedDicomInstance {
    const ds = dicomParser.parseDicom(bytes, {
      vrCallback: (tag: string) => (IMPLICIT_SEQUENCE_TAGS.has(tag) ? 'SQ' : 'UN'),
    });

    const tsUid = cleanStr(ds, 'x00020010', '1.2.840.10008.1.2.1');
    const transferSyntax = describeTransferSyntax(tsUid);

    const rows = ds.uint16('x00280010') ?? 0;
    const columns = ds.uint16('x00280011') ?? 0;
    const samplesPerPixel = ds.uint16('x00280002') ?? 1;
    const bitsAllocated = ds.uint16('x00280100') ?? 8;
    const bitsStored = ds.uint16('x00280101') ?? bitsAllocated;
    const pixelRepresentation = ds.uint16('x00280103') ?? 0;
    const planarConfiguration = ds.uint16('x00280006') ?? 0;
    const photometricInterpretation = cleanStr(ds, 'x00280004', 'MONOCHROME2');

    const pixelElement = ds.elements.x7fe00010;
    if (!pixelElement || rows <= 0 || columns <= 0) {
      throw new Error(
        `File "${fileName}" has no decodable image PixelData (may be Structured Report or Presentation State).`,
      );
    }

    const declaredFrames = Math.max(1, ds.intString('x00280008') ?? 1);
    let numberOfFrames = declaredFrames;
    let pixelLayout: ParsedDicomInstance['pixelLayout'];

    if (pixelElement.encapsulatedPixelData) {
      const frameSlices = extractEncapsulatedFrames(ds, pixelElement, declaredFrames);
      numberOfFrames = transferSyntax.supportedInBrowser
        ? Math.max(1, frameSlices.length || declaredFrames)
        : declaredFrames;
      pixelLayout = {
        kind: 'encapsulated',
        frameSlices,
      };
    } else {
      const bytesPerSample = Math.max(1, Math.ceil(bitsAllocated / 8));
      const frameByteLength =
        photometricInterpretation === 'YBR_FULL_422'
          ? rows * columns * 2
          : rows * columns * samplesPerPixel * bytesPerSample;
      if (declaredFrames === 1 && frameByteLength > 0 && pixelElement.length >= frameByteLength * 2) {
        numberOfFrames = Math.floor(pixelElement.length / frameByteLength);
      }
      pixelLayout = {
        kind: 'uncompressed',
        dataOffset: pixelElement.dataOffset,
        frameByteLength,
        bigEndian: tsUid === '1.2.840.10008.1.2.2',
      };
    }

    const frameTimeTag = ds.floatString('x00181063');
    const cineRateTag = ds.intString('x00180040');
    const frameTimeMs =
      frameTimeTag !== undefined && frameTimeTag > 0
        ? frameTimeTag
        : cineRateTag !== undefined && cineRateTag > 0
          ? 1000.0 / cineRateTag
          : null;

    const patientSizeM = ds.floatString('x00101020');
    const patientHeightCm =
      patientSizeM !== undefined && Number.isFinite(patientSizeM) && patientSizeM > 0
        ? patientSizeM < 3.0
          ? patientSizeM * 100.0
          : patientSizeM
        : null;
    const weightRaw = ds.floatString('x00101030');
    const patientWeightKg =
      weightRaw !== undefined && Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : null;
    const hrRaw = ds.intString('x00181088');
    const heartRateBpm = hrRaw !== undefined && Number.isFinite(hrRaw) && hrRaw > 0 ? hrRaw : null;

    const seriesDescription = cleanStr(ds, 'x0008103e', 'Unnamed Ultrasound Series');
    const wc = ds.floatString('x00281050') ?? null;
    const ww = ds.floatString('x00281051') ?? null;

    return {
      fileId,
      fileName,
      studyInstanceUid: cleanStr(ds, 'x0020000d', `local-study-${fileId}`),
      seriesInstanceUid: cleanStr(ds, 'x0020000e', `local-series-${fileId}`),
      sopInstanceUid: cleanStr(ds, 'x00080018', `local-sop-${fileId}`),
      sopClassUid: cleanStr(ds, 'x00080016'),
      transferSyntax,
      modality: cleanStr(ds, 'x00080060', 'US'),
      studyDate: cleanStr(ds, 'x00080020'),
      studyDescription: cleanStr(ds, 'x00081030', 'Local Echo Study'),
      seriesDescription,
      seriesNumber: ds.intString('x00200011') ?? 1,
      instanceNumber: ds.intString('x00200013') ?? 1,
      manufacturer: cleanStr(ds, 'x00080070'),
      modelName: cleanStr(ds, 'x00081090'),
      rows,
      columns,
      numberOfFrames,
      samplesPerPixel,
      photometricInterpretation,
      planarConfiguration,
      bitsAllocated,
      bitsStored,
      pixelRepresentation,
      frameTimeMs,
      pixelSpacing: resolveDicomPixelSpacing(ds),
      patientHeightCm,
      patientWeightKg,
      heartRateBpm,
      clipMode: classifyClipMode(ds, seriesDescription),
      windowCenter: wc,
      windowWidth: ww,
      phi: {
        patientName: cleanStr(ds, 'x00100010'),
        patientId: cleanStr(ds, 'x00100020'),
        patientBirthDate: cleanStr(ds, 'x00100030'),
        patientSex: cleanStr(ds, 'x00100040'),
        institutionName: cleanStr(ds, 'x00080080'),
      },
      pixelLayout,
    };
  }
}
