/**
 * `FrameSource` implementation backed by lazy-loaded WebAssembly medical codecs:
 * - Uncompressed (Implicit/Explicit LE & BE, 8-bit & 16-bit)
 * - RLE Lossless (`1.2.840.10008.1.2.5`)
 * - JPEG Baseline 8-bit (`1.2.840.10008.1.2.4.50`) via `@cornerstonejs/codec-libjpeg-turbo-8bit` WASM
 * - JPEG Lossless P14 / SV1 (`1.2.840.10008.1.2.4.57`, `.70`) via `@cornerstonejs/jpeg-lossless-decoder-js`
 * - JPEG-LS Lossless & Near-Lossless (`1.2.840.10008.1.2.4.80`, `.81`) via `@cornerstonejs/codec-charls` WASM
 * - JPEG 2000 Lossless & Lossy (`1.2.840.10008.1.2.4.90`, `.91`) via `@cornerstonejs/codec-openjpeg` WASM
 * - HTJ2K (`1.2.840.10008.1.2.4.201`–`.203`) via `@cornerstonejs/codec-openjph` WASM
 *
 * Keeps decoded measurement pixels strictly separated from display window/level RGBA conversion.
 */

import type { CharlsInstance } from '@cornerstonejs/codec-charls/decodewasmjs';
import type { LibJpegTurboInstance } from '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs';
import type { OpenJpegInstance } from '@cornerstonejs/codec-openjpeg/decodewasmjs';
import type { OpenJphInstance } from '@cornerstonejs/codec-openjph';
import {
  UnsupportedTransferSyntaxError,
  type DecodedMeasurementFrame,
  type FrameSource,
  type ParsedDicomInstance,
  type RawPixelArray,
} from './ports';

const isNodeRuntime =
  typeof process !== 'undefined' &&
  typeof process.versions?.node === 'string' &&
  typeof window === 'undefined';

function resolveWasmAsset(browserUrl: URL, nodePkgExport: string): string {
  if (isNodeRuntime && typeof import.meta.resolve === 'function') {
    return import.meta.resolve(nodePkgExport);
  }
  return browserUrl.href;
}

let openJpegPromise: Promise<OpenJpegInstance> | null = null;
let libJpegTurboPromise: Promise<LibJpegTurboInstance> | null = null;
let charlsPromise: Promise<CharlsInstance> | null = null;
let openJphPromise: Promise<OpenJphInstance> | null = null;
let jpegLosslessDecoderCtor: (new () => {
  decode: (buffer: ArrayBufferLike, offset: number, length: number, byteOutput: number) => DataView;
}) | null = null;

async function getOpenJpeg(): Promise<OpenJpegInstance> {
  if (!openJpegPromise) {
    openJpegPromise = (async () => {
      const mod = await import('@cornerstonejs/codec-openjpeg/decodewasmjs');
      const wasmUrl = new URL(
        '../../node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.wasm',
        import.meta.url,
      );
      return mod.default({
        print: () => {},
        locateFile: (f: string) =>
          f.endsWith('.wasm')
            ? resolveWasmAsset(wasmUrl, '@cornerstonejs/codec-openjpeg/decodewasm')
            : f,
      } as Parameters<typeof mod.default>[0]);
    })();
  }
  return openJpegPromise;
}

async function getLibJpegTurbo(): Promise<LibJpegTurboInstance> {
  if (!libJpegTurboPromise) {
    libJpegTurboPromise = (async () => {
      const mod = await import('@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs');
      const wasmUrl = new URL(
        '../../node_modules/@cornerstonejs/codec-libjpeg-turbo-8bit/dist/libjpegturbowasm_decode.wasm',
        import.meta.url,
      );
      return mod.default({
        locateFile: (f: string) =>
          f.endsWith('.wasm')
            ? resolveWasmAsset(wasmUrl, '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasm')
            : f,
      });
    })();
  }
  return libJpegTurboPromise;
}

async function getCharls(): Promise<CharlsInstance> {
  if (!charlsPromise) {
    charlsPromise = (async () => {
      const mod = await import('@cornerstonejs/codec-charls/decodewasmjs');
      const wasmUrl = new URL(
        '../../node_modules/@cornerstonejs/codec-charls/dist/charlswasm_decode.wasm',
        import.meta.url,
      );
      return mod.default({
        locateFile: (f: string) =>
          f.endsWith('.wasm') ? resolveWasmAsset(wasmUrl, '@cornerstonejs/codec-charls/decodewasm') : f,
      });
    })();
  }
  return charlsPromise;
}

async function getOpenJph(): Promise<OpenJphInstance> {
  if (!openJphPromise) {
    openJphPromise = (async () => {
      const mod = await import('@cornerstonejs/codec-openjph');
      const wasmUrl = new URL(
        '../../node_modules/@cornerstonejs/codec-openjph/dist/openjphjs.wasm',
        import.meta.url,
      );
      return mod.default({
        locateFile: (f: string) =>
          f.endsWith('.wasm')
            ? isNodeRuntime
              ? new URL('../../node_modules/@cornerstonejs/codec-openjph/dist/openjphjs.wasm', import.meta.url).href
              : wasmUrl.href
            : f,
      });
    })();
  }
  return openJphPromise;
}

async function getJpegLosslessDecoder() {
  if (!jpegLosslessDecoderCtor) {
    const mod = await import('@cornerstonejs/jpeg-lossless-decoder-js');
    jpegLosslessDecoderCtor = mod.Decoder as unknown as typeof jpegLosslessDecoderCtor;
  }
  return jpegLosslessDecoderCtor!;
}

function copyWasmDecodedPixels(
  wasmView: Uint8Array,
  bitsPerSample: number,
  isSigned: boolean,
): RawPixelArray {
  if (bitsPerSample > 8) {
    const aligned = new ArrayBuffer(wasmView.byteLength);
    new Uint8Array(aligned).set(wasmView);
    return isSigned ? new Int16Array(aligned) : new Uint16Array(aligned);
  }
  const out = new Uint8Array(wasmView.length);
  out.set(wasmView);
  return out;
}

function decodeRleFrame(instance: ParsedDicomInstance, compressed: Uint8Array): RawPixelArray {
  const pixelCount = instance.rows * instance.columns;
  const view = new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  const inSigned = new Int8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
  const numSegments = view.getInt32(0, true);

  if (instance.bitsAllocated === 8) {
    const out = new Int8Array(pixelCount * instance.samplesPerPixel);
    const planar = instance.planarConfiguration === 1;
    for (let s = 0; s < numSegments; s++) {
      let outIdx = planar ? s * pixelCount : s;
      const step = planar ? 1 : instance.samplesPerPixel;
      let inIdx = view.getInt32((s + 1) * 4, true);
      let maxIdx = s + 1 < numSegments ? view.getInt32((s + 2) * 4, true) : compressed.byteLength;
      if (maxIdx === 0) maxIdx = compressed.byteLength;
      const limit = pixelCount * numSegments;
      while (inIdx < maxIdx) {
        const n = inSigned[inIdx++]!;
        if (n >= 0 && n <= 127) {
          for (let i = 0; i < n + 1 && outIdx < limit; i++) {
            out[outIdx] = inSigned[inIdx++]!;
            outIdx += step;
          }
        } else if (n <= -1 && n >= -127) {
          const val = inSigned[inIdx++]!;
          for (let j = 0; j < -n + 1 && outIdx < limit; j++) {
            out[outIdx] = val;
            outIdx += step;
          }
        }
      }
    }
    return new Uint8Array(out.buffer);
  }

  if (instance.bitsAllocated === 16) {
    const outBytes = new Int8Array(pixelCount * instance.samplesPerPixel * 2);
    for (let s = 0; s < numSegments; s++) {
      const highOrLow = 1 - (s % 2); // RLE stores MSB segment first, then LSB segment
      const sampleIdx = Math.floor(s / 2);
      let outIdx = sampleIdx * 2 + highOrLow;
      const step = instance.samplesPerPixel * 2;
      let inIdx = view.getInt32((s + 1) * 4, true);
      let maxIdx = s + 1 < numSegments ? view.getInt32((s + 2) * 4, true) : compressed.byteLength;
      if (maxIdx === 0) maxIdx = compressed.byteLength;
      const limit = outBytes.length;
      while (inIdx < maxIdx) {
        const n = inSigned[inIdx++]!;
        if (n >= 0 && n <= 127) {
          for (let i = 0; i < n + 1 && outIdx < limit; i++) {
            outBytes[outIdx] = inSigned[inIdx++]!;
            outIdx += step;
          }
        } else if (n <= -1 && n >= -127) {
          const val = inSigned[inIdx++]!;
          for (let j = 0; j < -n + 1 && outIdx < limit; j++) {
            outBytes[outIdx] = val;
            outIdx += step;
          }
        }
      }
    }
    return instance.pixelRepresentation === 1
      ? new Int16Array(outBytes.buffer)
      : new Uint16Array(outBytes.buffer);
  }

  throw new Error(`Unsupported RLE bitsAllocated=${instance.bitsAllocated}`);
}

function decodeUncompressedSlice(instance: ParsedDicomInstance, slice: Uint8Array, bigEndian: boolean): RawPixelArray {
  if (instance.bitsAllocated <= 8) {
    const copy = new Uint8Array(slice.byteLength);
    copy.set(slice);
    return copy;
  }
  if (instance.bitsAllocated === 16) {
    const aligned = new ArrayBuffer(slice.byteLength);
    const dstBytes = new Uint8Array(aligned);
    if (bigEndian) {
      for (let i = 0; i + 1 < slice.byteLength; i += 2) {
        dstBytes[i] = slice[i + 1]!;
        dstBytes[i + 1] = slice[i]!;
      }
    } else {
      dstBytes.set(slice);
    }
    return instance.pixelRepresentation === 1 ? new Int16Array(aligned) : new Uint16Array(aligned);
  }
  throw new Error(`Unsupported uncompressed bitsAllocated=${instance.bitsAllocated}`);
}

function convertPlanarRgbToInterleaved(planar: Uint8Array, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount * 3);
  for (let i = 0; i < pixelCount; i++) {
    out[i * 3] = planar[i]!;
    out[i * 3 + 1] = planar[pixelCount + i]!;
    out[i * 3 + 2] = planar[pixelCount * 2 + i]!;
  }
  return out;
}

function convertYbrFull422ToRgb(ybr: Uint8Array, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount * 3);
  let src = 0;
  let dst = 0;
  while (src + 3 < ybr.length && dst + 5 < out.length) {
    const y1 = ybr[src]!;
    const y2 = ybr[src + 1]!;
    const cb = ybr[src + 2]! - 128;
    const cr = ybr[src + 3]! - 128;
    src += 4;

    out[dst++] = Math.min(255, Math.max(0, Math.round(y1 + 1.402 * cr)));
    out[dst++] = Math.min(255, Math.max(0, Math.round(y1 - 0.344136 * cb - 0.714136 * cr)));
    out[dst++] = Math.min(255, Math.max(0, Math.round(y1 + 1.772 * cb)));

    out[dst++] = Math.min(255, Math.max(0, Math.round(y2 + 1.402 * cr)));
    out[dst++] = Math.min(255, Math.max(0, Math.round(y2 - 0.344136 * cb - 0.714136 * cr)));
    out[dst++] = Math.min(255, Math.max(0, Math.round(y2 + 1.772 * cb)));
  }
  return out;
}

function computeMinMax(pixels: RawPixelArray): { min: number; max: number } {
  if (pixels.length === 0) return { min: 0, max: 0 };
  let min = pixels[0]!;
  let max = pixels[0]!;
  for (let i = 1; i < pixels.length; i++) {
    const v = pixels[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

export class WasmCodecFrameSource implements FrameSource {
  public async decodeFrame(
    instance: ParsedDicomInstance,
    fileBytes: Uint8Array,
    frameIndex: number,
  ): Promise<DecodedMeasurementFrame> {
    if (!instance.transferSyntax.supportedInBrowser) {
      throw new UnsupportedTransferSyntaxError(instance.transferSyntax);
    }
    if (frameIndex < 0 || frameIndex >= instance.numberOfFrames) {
      throw new RangeError(
        `Frame index ${frameIndex} out of bounds [0, ${instance.numberOfFrames})`,
      );
    }

    const t0 = performance.now();
    const uid = instance.transferSyntax.uid;
    let pixels: RawPixelArray;
    let effectivePhotometric = instance.photometricInterpretation;
    let decoderId = 'uncompressed';

    if (instance.pixelLayout.kind === 'uncompressed') {
      const { dataOffset, frameByteLength, bigEndian } = instance.pixelLayout;
      const start = dataOffset + frameIndex * frameByteLength;
      const end = start + frameByteLength;
      if (end > fileBytes.byteLength) {
        throw new Error(`Truncated uncompressed PixelData at frame ${frameIndex}`);
      }
      const rawSlice = fileBytes.subarray(start, end);
      let decoded = decodeUncompressedSlice(instance, rawSlice, bigEndian);
      const pixelCount = instance.rows * instance.columns;
      if (
        decoded instanceof Uint8Array &&
        instance.photometricInterpretation === 'YBR_FULL_422' &&
        decoded.length === pixelCount * 2
      ) {
        decoded = convertYbrFull422ToRgb(decoded, pixelCount);
        effectivePhotometric = 'RGB';
      } else if (
        decoded instanceof Uint8Array &&
        instance.samplesPerPixel === 3 &&
        instance.planarConfiguration === 1
      ) {
        decoded = convertPlanarRgbToInterleaved(decoded, pixelCount);
      }
      pixels = decoded;
    } else {
      const compressed = instance.pixelLayout.frameSlices[frameIndex];
      if (!compressed || compressed.byteLength === 0) {
        throw new Error(`Missing encapsulated fragment for frame ${frameIndex}`);
      }

      if (uid === '1.2.840.10008.1.2.5') {
        decoderId = 'rle-js';
        pixels = decodeRleFrame(instance, compressed);
      } else if (uid === '1.2.840.10008.1.2.4.50') {
        decoderId = 'libjpeg-turbo-wasm';
        const mod = await getLibJpegTurbo();
        const dec = new mod.JPEGDecoder();
        try {
          const enc = dec.getEncodedBuffer(compressed.byteLength);
          enc.set(compressed);
          dec.decode();
          const info = dec.getFrameInfo();
          pixels = copyWasmDecodedPixels(dec.getDecodedBuffer(), info.bitsPerSample, false);
          if (info.componentCount === 3) {
            // libjpeg-turbo automatically upsamples 4:2:2 and converts YCbCr -> RGB
            effectivePhotometric = 'RGB';
          }
        } finally {
          dec.delete?.();
        }
      } else if (uid === '1.2.840.10008.1.2.4.57' || uid === '1.2.840.10008.1.2.4.70') {
        decoderId = 'jpeg-lossless-js';
        const Decoder = await getJpegLosslessDecoder();
        const dec = new Decoder();
        const byteOutput = instance.bitsAllocated <= 8 ? 1 : 2;
        const view = dec.decode(
          compressed.buffer,
          compressed.byteOffset,
          compressed.byteLength,
          byteOutput,
        );
        const aligned = new ArrayBuffer(view.byteLength);
        new Uint8Array(aligned).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        pixels =
          byteOutput === 1
            ? new Uint8Array(aligned)
            : instance.pixelRepresentation === 1
              ? new Int16Array(aligned)
              : new Uint16Array(aligned);
      } else if (uid === '1.2.840.10008.1.2.4.80' || uid === '1.2.840.10008.1.2.4.81') {
        decoderId = 'charls-wasm';
        const mod = await getCharls();
        const dec = new mod.JpegLSDecoder();
        try {
          const enc = dec.getEncodedBuffer(compressed.byteLength);
          enc.set(compressed);
          dec.decode();
          const info = dec.getFrameInfo();
          pixels = copyWasmDecodedPixels(
            dec.getDecodedBuffer(),
            info.bitsPerSample,
            instance.pixelRepresentation === 1,
          );
        } finally {
          dec.delete?.();
        }
      } else if (uid === '1.2.840.10008.1.2.4.90' || uid === '1.2.840.10008.1.2.4.91') {
        decoderId = 'openjpeg-wasm';
        const mod = await getOpenJpeg();
        const dec = new mod.J2KDecoder();
        try {
          const enc = dec.getEncodedBuffer(compressed.byteLength);
          enc.set(compressed);
          dec.decode();
          const info = dec.getFrameInfo();
          pixels = copyWasmDecodedPixels(dec.getDecodedBuffer(), info.bitsPerSample, info.isSigned);
          if (info.componentCount === 3) {
            effectivePhotometric = 'RGB';
          }
        } finally {
          dec.delete?.();
        }
      } else if (
        uid === '1.2.840.10008.1.2.4.201' ||
        uid === '1.2.840.10008.1.2.4.202' ||
        uid === '1.2.840.10008.1.2.4.203'
      ) {
        decoderId = 'openjph-wasm';
        const mod = await getOpenJph();
        const dec = new mod.HTJ2KDecoder();
        const enc = dec.getEncodedBuffer(compressed.byteLength);
        enc.set(compressed);
        dec.decode();
        const info = dec.getFrameInfo();
        pixels = copyWasmDecodedPixels(dec.getDecodedBuffer(), info.bitsPerSample, info.isSigned);
      } else {
        throw new UnsupportedTransferSyntaxError(instance.transferSyntax);
      }
    }

    const { min, max } = computeMinMax(pixels);
    const decodeTimeMs = performance.now() - t0;

    return {
      sopInstanceUid: instance.sopInstanceUid,
      frameIndex,
      rows: instance.rows,
      columns: instance.columns,
      samplesPerPixel: instance.samplesPerPixel,
      bitsAllocated: instance.bitsAllocated,
      bitsStored: instance.bitsStored,
      pixelRepresentation: instance.pixelRepresentation,
      photometricInterpretation: effectivePhotometric,
      isLossless: instance.transferSyntax.lossless,
      pixels,
      minPixel: min,
      maxPixel: max,
      decodeTimeMs,
      decoderId,
    };
  }

  /**
   * Separate preview display path: maps `DecodedMeasurementFrame` to RGBA8 (`Uint8ClampedArray`)
   * with Window/Level without mutating `frame.pixels`.
   */
  public renderPreviewRgba(
    frame: DecodedMeasurementFrame,
    options?: { windowCenter?: number; windowWidth?: number },
  ): Uint8ClampedArray {
    const pixelCount = frame.rows * frame.columns;
    const rgba = new Uint8ClampedArray(pixelCount * 4);

    if (frame.samplesPerPixel === 3) {
      const wc = options?.windowCenter ?? 128;
      const ww = Math.max(1, options?.windowWidth ?? 256);
      const low = wc - ww / 2;
      const scale = 255 / ww;
      const src = frame.pixels;
      for (let i = 0; i < pixelCount; i++) {
        const s = i * 3;
        const d = i * 4;
        rgba[d] = ((src[s]! - low) * scale) | 0;
        rgba[d + 1] = ((src[s + 1]! - low) * scale) | 0;
        rgba[d + 2] = ((src[s + 2]! - low) * scale) | 0;
        rgba[d + 3] = 255;
      }
      return rgba;
    }

    const fullRange = Math.max(1, frame.maxPixel - frame.minPixel);
    const defaultWw = frame.bitsStored <= 8 ? 255 : fullRange;
    const defaultWc = frame.bitsStored <= 8 ? 127.5 : frame.minPixel + fullRange / 2;
    const wc = options?.windowCenter ?? defaultWc;
    const ww = Math.max(1, options?.windowWidth ?? defaultWw);
    const low = wc - ww / 2;
    const scale = 255 / ww;
    const invert = frame.photometricInterpretation === 'MONOCHROME1';
    const src = frame.pixels;

    for (let i = 0; i < pixelCount; i++) {
      let lum = (src[i]! - low) * scale;
      if (lum < 0) lum = 0;
      else if (lum > 255) lum = 255;
      const v = invert ? 255 - lum : lum;
      const d = i * 4;
      rgba[d] = v;
      rgba[d + 1] = v;
      rgba[d + 2] = v;
      rgba[d + 3] = 255;
    }
    return rgba;
  }
}
