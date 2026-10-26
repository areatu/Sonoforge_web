/**
 * Stage 0 DICOM & Viewer Port Interfaces (Spec §3.6, §4, §5.1).
 *
 * Hides any third-party DICOM parser/decoder library behind domain-aligned interfaces:
 * - `DicomFileReader`
 * - `FrameSource`
 * - `SeriesAssembler`
 */

export type ClipMode = '2d' | 'doppler' | 'm_mode';

export interface PixelSpacingResolution {
  readonly spacingMm: readonly [rowMm: number, colMm: number];
  readonly source: string;
}

export interface TransferSyntaxCapability {
  readonly uid: string;
  readonly name: string;
  readonly compressed: boolean;
  readonly lossless: boolean;
  readonly supportedInBrowser: boolean;
  readonly fallbackStrategy: string | null;
}

export interface RedactablePatientMetadata {
  readonly patientName: string;
  readonly patientId: string;
  readonly patientBirthDate: string;
  readonly patientSex: string;
  readonly institutionName: string;
}

export interface ParsedDicomInstance {
  readonly fileId: string;
  readonly fileName: string;
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly sopInstanceUid: string;
  readonly sopClassUid: string;
  readonly transferSyntax: TransferSyntaxCapability;
  readonly modality: string;
  readonly studyDate: string;
  readonly studyDescription: string;
  readonly seriesDescription: string;
  readonly seriesNumber: number;
  readonly instanceNumber: number;
  readonly manufacturer: string;
  readonly modelName: string;
  readonly rows: number;
  readonly columns: number;
  readonly numberOfFrames: number;
  readonly samplesPerPixel: number;
  readonly photometricInterpretation: string;
  readonly planarConfiguration: number;
  readonly bitsAllocated: number;
  readonly bitsStored: number;
  readonly pixelRepresentation: number;
  readonly frameTimeMs: number | null;
  readonly pixelSpacing: PixelSpacingResolution | null;
  readonly patientHeightCm: number | null;
  readonly patientWeightKg: number | null;
  readonly heartRateBpm: number | null;
  readonly clipMode: ClipMode;
  readonly windowCenter: number | null;
  readonly windowWidth: number | null;
  readonly phi: RedactablePatientMetadata;
  /** Internal byte offsets for fast random-access frame extraction without re-parsing header. */
  readonly pixelLayout:
    | {
        readonly kind: 'uncompressed';
        readonly dataOffset: number;
        readonly frameByteLength: number;
        readonly bigEndian: boolean;
      }
    | {
        readonly kind: 'encapsulated';
        readonly frameSlices: readonly Uint8Array[];
      };
}

export interface ImageFrameRef {
  readonly sopInstanceUid: string;
  readonly frameIndex: number;
  readonly rows: number;
  readonly columns: number;
  readonly pixelSpacingMm: readonly [number, number] | null;
  readonly pixelSpacingSource: string | null;
  readonly timestampMs: number | null;
}

export interface SeriesRef {
  readonly seriesInstanceUid: string;
  readonly modality: string;
  readonly description: string;
  readonly seriesNumber: number;
  readonly rows: number;
  readonly columns: number;
  readonly totalFrames: number;
  readonly transferSyntaxUid: string;
  readonly transferSyntaxName: string;
  readonly supportedInBrowser: boolean;
  readonly isLossless: boolean;
  readonly clipMode: ClipMode;
  readonly instances: readonly ParsedDicomInstance[];
  readonly frames: readonly ImageFrameRef[];
}

export interface StudyRef {
  readonly studyInstanceUid: string;
  readonly studyDate: string;
  readonly description: string;
  readonly source: 'local' | 'dicomweb';
  readonly equipmentLabel: string;
  readonly series: readonly SeriesRef[];
}

export type RawPixelArray = Uint8Array | Uint16Array | Int16Array;

/**
 * Lossless/native decoded frame preserved for measurement accuracy (Spec §4, §6).
 * Display window/level and RGBA conversion are performed downstream without mutating `pixels`.
 */
export interface DecodedMeasurementFrame {
  readonly sopInstanceUid: string;
  readonly frameIndex: number;
  readonly rows: number;
  readonly columns: number;
  readonly samplesPerPixel: number;
  readonly bitsAllocated: number;
  readonly bitsStored: number;
  readonly pixelRepresentation: number;
  readonly photometricInterpretation: string;
  readonly isLossless: boolean;
  readonly pixels: RawPixelArray;
  readonly minPixel: number;
  readonly maxPixel: number;
  readonly decodeTimeMs: number;
  readonly decoderId: string;
}

export class UnsupportedTransferSyntaxError extends Error {
  public readonly transferSyntaxUid: string;
  public readonly transferSyntaxName: string;
  public readonly fallbackStrategy: string;

  constructor(cap: TransferSyntaxCapability) {
    const fallback =
      cap.fallbackStrategy ??
      'Use DICOMweb WADO-RS rendered frames for preview, or transcode offline to Explicit VR Little Endian / JPEG 2000 Lossless.';
    super(
      `Unsupported DICOM Transfer Syntax: ${cap.name} (${cap.uid}). ${fallback}`,
    );
    this.name = 'UnsupportedTransferSyntaxError';
    this.transferSyntaxUid = cap.uid;
    this.transferSyntaxName = cap.name;
    this.fallbackStrategy = fallback;
  }
}

export interface DicomFileReader {
  readMetadata(bytes: Uint8Array, fileId: string, fileName: string): ParsedDicomInstance;
}

export interface FrameSource {
  decodeFrame(
    instance: ParsedDicomInstance,
    fileBytes: Uint8Array,
    frameIndex: number,
  ): Promise<DecodedMeasurementFrame>;
  renderPreviewRgba(
    frame: DecodedMeasurementFrame,
    options?: { windowCenter?: number; windowWidth?: number },
  ): Uint8ClampedArray;
}

export interface SeriesAssembler {
  assembleStudies(
    instances: readonly ParsedDicomInstance[],
    source?: 'local' | 'dicomweb',
  ): StudyRef[];
}
