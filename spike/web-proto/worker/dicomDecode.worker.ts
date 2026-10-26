/**
 * Dedicated Web Worker for non-blocking DICOM parsing, WASM codec frame decoding,
 * task cancellation, and byte-bounded LRU frame caching (Spec §4, §6).
 *
 * No PHI or DICOM pixel bytes ever leave the browser.
 */

import {
  DefaultSeriesAssembler,
  DicomParserFileReader,
  LruFrameCache,
  UnsupportedTransferSyntaxError,
  WasmCodecFrameSource,
  type DecodedMeasurementFrame,
  type FrameCacheStats,
  type ParsedDicomInstance,
  type StudyRef,
} from '../../dicom-ts';

export interface WorkerInputFile {
  readonly fileId: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export type WorkerRequest =
  | {
      readonly id: number;
      readonly type: 'ingestFiles';
      readonly files: readonly WorkerInputFile[];
    }
  | {
      readonly id: number;
      readonly type: 'decodeFrame';
      readonly sopInstanceUid: string;
      readonly frameIndex: number;
      readonly windowCenter?: number;
      readonly windowWidth?: number;
    }
  | {
      readonly id: number;
      readonly type: 'cancelTask';
      readonly targetRequestId: number;
    }
  | {
      readonly id: number;
      readonly type: 'setCacheBudgetMiB';
      readonly budgetMiB: number;
    }
  | {
      readonly id: number;
      readonly type: 'clearAll';
    }
  | {
      readonly id: number;
      readonly type: 'runBrowserBench';
      readonly files: readonly WorkerInputFile[];
    };

export interface SerializedInstanceSummary {
  readonly fileId: string;
  readonly fileName: string;
  readonly studyInstanceUid: string;
  readonly seriesInstanceUid: string;
  readonly sopInstanceUid: string;
  readonly transferSyntax: ParsedDicomInstance['transferSyntax'];
  readonly modality: string;
  readonly studyDate: string;
  readonly studyDescription: string;
  readonly seriesDescription: string;
  readonly manufacturer: string;
  readonly modelName: string;
  readonly rows: number;
  readonly columns: number;
  readonly numberOfFrames: number;
  readonly samplesPerPixel: number;
  readonly photometricInterpretation: string;
  readonly bitsAllocated: number;
  readonly bitsStored: number;
  readonly frameTimeMs: number | null;
  readonly pixelSpacing: ParsedDicomInstance['pixelSpacing'];
  readonly patientHeightCm: number | null;
  readonly patientWeightKg: number | null;
  readonly heartRateBpm: number | null;
  readonly clipMode: ParsedDicomInstance['clipMode'];
  readonly windowCenter: number | null;
  readonly windowWidth: number | null;
  readonly phi: ParsedDicomInstance['phi'];
}

export interface BrowserBenchRow {
  readonly fileName: string;
  readonly transferSyntaxUid: string;
  readonly transferSyntaxName: string;
  readonly dimensions: string;
  readonly supported: boolean;
  readonly decoderId: string;
  readonly parseMs: number;
  readonly coldFrame0Ms: number | null;
  readonly warmAvgMs: number | null;
  readonly estimatedFps: number | null;
  readonly note: string | null;
}

export type WorkerResponse =
  | {
      readonly id: number;
      readonly type: 'progress';
      readonly completed: number;
      readonly total: number;
      readonly label: string;
    }
  | {
      readonly id: number;
      readonly type: 'ingestComplete';
      readonly studies: StudyRef[];
      readonly instances: Record<string, SerializedInstanceSummary>;
      readonly errors: readonly { fileName: string; message: string }[];
      readonly totalParseMs: number;
      readonly cacheStats: FrameCacheStats;
    }
  | {
      readonly id: number;
      readonly type: 'frameDecoded';
      readonly sopInstanceUid: string;
      readonly frameIndex: number;
      readonly rows: number;
      readonly columns: number;
      readonly minPixel: number;
      readonly maxPixel: number;
      readonly bitsStored: number;
      readonly samplesPerPixel: number;
      readonly isLossless: boolean;
      readonly decoderId: string;
      readonly decodeTimeMs: number;
      readonly renderTimeMs: number;
      readonly fromCache: boolean;
      readonly rgbaBuffer: ArrayBuffer;
      readonly cacheStats: FrameCacheStats;
    }
  | {
      readonly id: number;
      readonly type: 'benchComplete';
      readonly rows: readonly BrowserBenchRow[];
      readonly cacheStats: FrameCacheStats;
    }
  | {
      readonly id: number;
      readonly type: 'ack';
      readonly cacheStats: FrameCacheStats;
    }
  | {
      readonly id: number;
      readonly type: 'error';
      readonly code: 'UNSUPPORTED_SYNTAX' | 'CANCELLED' | 'DECODE_ERROR';
      readonly message: string;
      readonly fallbackStrategy?: string;
    };

const reader = new DicomParserFileReader();
const assembler = new DefaultSeriesAssembler();
const frameSource = new WasmCodecFrameSource();

const storedBytesBySop = new Map<string, Uint8Array>();
const storedInstancesBySop = new Map<string, ParsedDicomInstance>();
const cancelledRequests = new Set<number>();
let frameCache = new LruFrameCache(96 * 1024 * 1024);

function toSummary(inst: ParsedDicomInstance): SerializedInstanceSummary {
  const { pixelLayout: _omitLayout, ...rest } = inst;
  void _omitLayout;
  return rest;
}

function rebuildStudies(): {
  studies: StudyRef[];
  instances: Record<string, SerializedInstanceSummary>;
} {
  const all = [...storedInstancesBySop.values()];
  const studies = assembler.assembleStudies(all, 'local');
  const instances: Record<string, SerializedInstanceSummary> = {};
  for (const inst of all) {
    instances[inst.sopInstanceUid] = toSummary(inst);
  }
  return { studies, instances };
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'cancelTask') {
    cancelledRequests.add(msg.targetRequestId);
    workerScope.postMessage({
      id: msg.id,
      type: 'ack',
      cacheStats: frameCache.stats(),
    } satisfies WorkerResponse);
    return;
  }

  if (msg.type === 'setCacheBudgetMiB') {
    frameCache = new LruFrameCache(Math.max(8, msg.budgetMiB) * 1024 * 1024);
    workerScope.postMessage({
      id: msg.id,
      type: 'ack',
      cacheStats: frameCache.stats(),
    } satisfies WorkerResponse);
    return;
  }

  if (msg.type === 'clearAll') {
    storedBytesBySop.clear();
    storedInstancesBySop.clear();
    frameCache.clear();
    workerScope.postMessage({
      id: msg.id,
      type: 'ack',
      cacheStats: frameCache.stats(),
    } satisfies WorkerResponse);
    return;
  }

  if (msg.type === 'ingestFiles') {
    const t0 = performance.now();
    const errors: { fileName: string; message: string }[] = [];

    for (let i = 0; i < msg.files.length; i++) {
      if (cancelledRequests.has(msg.id)) {
        cancelledRequests.delete(msg.id);
        workerScope.postMessage({
          id: msg.id,
          type: 'error',
          code: 'CANCELLED',
          message: 'Import cancelled by user.',
        } satisfies WorkerResponse);
        return;
      }
      const f = msg.files[i]!;
      workerScope.postMessage({
        id: msg.id,
        type: 'progress',
        completed: i,
        total: msg.files.length,
        label: f.fileName,
      } satisfies WorkerResponse);

      try {
        const parsed = reader.readMetadata(f.bytes, f.fileId, f.fileName);
        storedBytesBySop.set(parsed.sopInstanceUid, f.bytes);
        storedInstancesBySop.set(parsed.sopInstanceUid, parsed);
      } catch (err) {
        errors.push({
          fileName: f.fileName,
          message: err instanceof Error ? err.message : 'Invalid DICOM file',
        });
      }
    }

    const { studies, instances } = rebuildStudies();
    workerScope.postMessage({
      id: msg.id,
      type: 'ingestComplete',
      studies,
      instances,
      errors,
      totalParseMs: Number((performance.now() - t0).toFixed(2)),
      cacheStats: frameCache.stats(),
    } satisfies WorkerResponse);
    return;
  }

  if (msg.type === 'decodeFrame') {
    if (cancelledRequests.has(msg.id)) {
      cancelledRequests.delete(msg.id);
      workerScope.postMessage({
        id: msg.id,
        type: 'error',
        code: 'CANCELLED',
        message: 'Frame decode cancelled.',
      } satisfies WorkerResponse);
      return;
    }

    const inst = storedInstancesBySop.get(msg.sopInstanceUid);
    const bytes = storedBytesBySop.get(msg.sopInstanceUid);
    if (!inst || !bytes) {
      workerScope.postMessage({
        id: msg.id,
        type: 'error',
        code: 'DECODE_ERROR',
        message: 'Requested DICOM instance is not loaded in worker memory.',
      } satisfies WorkerResponse);
      return;
    }

    try {
      let decoded: DecodedMeasurementFrame | undefined = frameCache.get(
        msg.sopInstanceUid,
        msg.frameIndex,
      );
      let fromCache = true;
      if (!decoded) {
        fromCache = false;
        decoded = await frameSource.decodeFrame(inst, bytes, msg.frameIndex);
        frameCache.put(decoded);
      }

      const tr0 = performance.now();
      const rgba = frameSource.renderPreviewRgba(decoded, {
        windowCenter: msg.windowCenter,
        windowWidth: msg.windowWidth,
      });
      const renderTimeMs = Number((performance.now() - tr0).toFixed(2));
      const rgbaCopy = new Uint8Array(rgba.byteLength);
      rgbaCopy.set(rgba);
      const rgbaBuffer: ArrayBuffer = rgbaCopy.buffer;

      workerScope.postMessage(
        {
          id: msg.id,
          type: 'frameDecoded',
          sopInstanceUid: msg.sopInstanceUid,
          frameIndex: msg.frameIndex,
          rows: decoded.rows,
          columns: decoded.columns,
          minPixel: decoded.minPixel,
          maxPixel: decoded.maxPixel,
          bitsStored: decoded.bitsStored,
          samplesPerPixel: decoded.samplesPerPixel,
          isLossless: decoded.isLossless,
          decoderId: decoded.decoderId,
          decodeTimeMs: Number(decoded.decodeTimeMs.toFixed(2)),
          renderTimeMs,
          fromCache,
          rgbaBuffer,
          cacheStats: frameCache.stats(),
        } satisfies WorkerResponse,
        [rgbaBuffer],
      );
    } catch (err) {
      if (err instanceof UnsupportedTransferSyntaxError) {
        workerScope.postMessage({
          id: msg.id,
          type: 'error',
          code: 'UNSUPPORTED_SYNTAX',
          message: err.message,
          fallbackStrategy: err.fallbackStrategy,
        } satisfies WorkerResponse);
      } else {
        workerScope.postMessage({
          id: msg.id,
          type: 'error',
          code: 'DECODE_ERROR',
          message: err instanceof Error ? err.message : 'Failed to decode DICOM frame.',
        } satisfies WorkerResponse);
      }
    }
    return;
  }

  if (msg.type === 'runBrowserBench') {
    const rows: BrowserBenchRow[] = [];
    for (let i = 0; i < msg.files.length; i++) {
      const f = msg.files[i]!;
      workerScope.postMessage({
        id: msg.id,
        type: 'progress',
        completed: i,
        total: msg.files.length,
        label: `Bench: ${f.fileName}`,
      } satisfies WorkerResponse);

      const tp0 = performance.now();
      const inst = reader.readMetadata(f.bytes, f.fileId, f.fileName);
      const parseMs = Number((performance.now() - tp0).toFixed(2));

      if (!inst.transferSyntax.supportedInBrowser) {
        rows.push({
          fileName: f.fileName,
          transferSyntaxUid: inst.transferSyntax.uid,
          transferSyntaxName: inst.transferSyntax.name,
          dimensions: `${inst.columns}×${inst.rows}×${inst.numberOfFrames}`,
          supported: false,
          decoderId: 'none',
          parseMs,
          coldFrame0Ms: null,
          warmAvgMs: null,
          estimatedFps: null,
          note: inst.transferSyntax.fallbackStrategy,
        });
        continue;
      }

      const f0 = await frameSource.decodeFrame(inst, f.bytes, 0);
      const framesToMeasure = Math.min(inst.numberOfFrames, 8);
      const warmTimes: number[] = [];
      for (let k = 0; k < framesToMeasure; k++) {
        const fk = await frameSource.decodeFrame(inst, f.bytes, k);
        const tr0 = performance.now();
        frameSource.renderPreviewRgba(fk);
        warmTimes.push(fk.decodeTimeMs + (performance.now() - tr0));
      }
      const warmAvg = warmTimes.reduce((s, v) => s + v, 0) / warmTimes.length;
      rows.push({
        fileName: f.fileName,
        transferSyntaxUid: inst.transferSyntax.uid,
        transferSyntaxName: inst.transferSyntax.name,
        dimensions: `${inst.columns}×${inst.rows}×${inst.numberOfFrames}`,
        supported: true,
        decoderId: f0.decoderId,
        parseMs,
        coldFrame0Ms: Number(f0.decodeTimeMs.toFixed(2)),
        warmAvgMs: Number(warmAvg.toFixed(2)),
        estimatedFps: Number((1000 / Math.max(warmAvg, 0.05)).toFixed(1)),
        note: inst.pixelSpacing
          ? `${inst.pixelSpacing.spacingMm[0]} mm/px (${inst.pixelSpacing.source})`
          : 'Uncalibrated (px only)',
      });
    }

    workerScope.postMessage({
      id: msg.id,
      type: 'benchComplete',
      rows,
      cacheStats: frameCache.stats(),
    } satisfies WorkerResponse);
  }
});
