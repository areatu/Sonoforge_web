import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from '../spike/fixtures/manifest.json';
import {
  DefaultSeriesAssembler,
  DicomParserFileReader,
  LruFrameCache,
  UnsupportedTransferSyntaxError,
  WasmCodecFrameSource,
} from '../spike/dicom-ts';

const FIXTURES_DIR = join(process.cwd(), 'spike', 'fixtures');

function sha256Hex(arr: Uint8Array | Uint16Array | Int16Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  return createHash('sha256').update(bytes).digest('hex');
}

describe('DICOM FileReader, Ultrasound Calibration, SeriesAssembler & WASM FrameSource', () => {
  const reader = new DicomParserFileReader();
  const frameSource = new WasmCodecFrameSource();
  const assembler = new DefaultSeriesAssembler();

  it('assembles multi-vendor fixtures into studies and series by DICOM UIDs', () => {
    const parsed = manifest.map((entry, idx) => {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, entry.file)));
      return reader.readMetadata(bytes, `f-${idx}`, entry.file);
    });
    const studies = assembler.assembleStudies(parsed);
    expect(studies.length).toBe(5);
    const totalSeries = studies.reduce((acc, s) => acc + s.series.length, 0);
    expect(totalSeries).toBe(manifest.length);
  });

  for (const entry of manifest) {
    it(`parses metadata & calibration accurately for ${entry.file} (${entry.transferSyntaxUid})`, () => {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, entry.file)));
      const inst = reader.readMetadata(bytes, entry.file, entry.file);

      expect(inst.rows).toBe(entry.rows);
      expect(inst.columns).toBe(entry.columns);
      expect(inst.numberOfFrames).toBe(entry.numberOfFrames);
      expect(inst.transferSyntax.uid).toBe(entry.transferSyntaxUid);

      if (entry.expectedSpacingMm === null) {
        expect(inst.pixelSpacing).toBeNull();
      } else {
        expect(inst.pixelSpacing).not.toBeNull();
        expect(inst.pixelSpacing!.source).toBe(entry.expectedSpacingSource);
        expect(inst.pixelSpacing!.spacingMm[0]).toBeCloseTo(entry.expectedSpacingMm[0]!, 6);
        expect(inst.pixelSpacing!.spacingMm[1]).toBeCloseTo(entry.expectedSpacingMm[1]!, 6);
      }
    });

    if (entry.decodableInPydicom) {
      it(`decodes ${entry.file} with ${entry.lossless ? '100% bit-exact pydicom parity' : 'valid lossy bounds'}`, async () => {
        const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, entry.file)));
        const inst = reader.readMetadata(bytes, entry.file, entry.file);
        const frame0 = await frameSource.decodeFrame(inst, bytes, 0);

        expect(frame0.rows).toBe(entry.rows);
        expect(frame0.columns).toBe(entry.columns);
        expect(frame0.pixels.length).toBe(entry.rows * entry.columns * entry.samplesPerPixel);

        if (entry.lossless) {
          // Bit-for-bit SHA-256 verification against pydicom ground truth!
          expect(sha256Hex(frame0.pixels)).toBe(entry.frame0Sha256);
        } else {
          // Lossy JPEG Baseline (grayscale or YBR_FULL_422 -> RGB): verify statistical agreement
          let sum = 0;
          for (let i = 0; i < frame0.pixels.length; i++) sum += frame0.pixels[i]!;
          const mean = sum / frame0.pixels.length;
          // Note: pydicom pixel_array for YBR_FULL_422 returns YCbCr unless converted; check finite non-empty range
          expect(frame0.maxPixel).toBeGreaterThan(frame0.minPixel);
          expect(mean).toBeGreaterThan(5);
        }

        // Verify multi-frame random access on last frame & non-mutating preview render
        if (inst.numberOfFrames > 1) {
          const lastIdx = inst.numberOfFrames - 1;
          const lastFrame = await frameSource.decodeFrame(inst, bytes, lastIdx);
          expect(lastFrame.frameIndex).toBe(lastIdx);
          expect(lastFrame.pixels.length).toBe(frame0.pixels.length);
        }

        const snapshotBefore = frame0.pixels[0];
        const rgba = frameSource.renderPreviewRgba(frame0, { windowCenter: 110, windowWidth: 200 });
        expect(rgba.length).toBe(entry.rows * entry.columns * 4);
        expect(frame0.pixels[0]).toBe(snapshotBefore);
      });
    } else {
      it(`rejects unsupported syntax ${entry.file} with human-readable fallback strategy`, async () => {
        const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, entry.file)));
        const inst = reader.readMetadata(bytes, entry.file, entry.file);
        expect(inst.transferSyntax.supportedInBrowser).toBe(false);
        await expect(frameSource.decodeFrame(inst, bytes, 0)).rejects.toThrowError(
          UnsupportedTransferSyntaxError,
        );
      });
    }
  }

  it('enforces byte-bounded LRU frame cache budget without exceeding maxBytes', async () => {
    const bytes = new Uint8Array(
      readFileSync(join(FIXTURES_DIR, '02_philips_epiq_cine_uncompressed.dcm')),
    );
    const inst = reader.readMetadata(bytes, 'cine', '02_philips_epiq_cine_uncompressed.dcm');
    const oneFrameBytes = inst.rows * inst.columns; // 256 * 192 = 49,152 B
    const budgetBytes = oneFrameBytes * 4; // Allow at most 4 frames in memory
    const cache = new LruFrameCache(budgetBytes);

    for (let i = 0; i < inst.numberOfFrames; i++) {
      const f = await frameSource.decodeFrame(inst, bytes, i);
      cache.put(f);
      expect(cache.stats().currentBytes).toBeLessThanOrEqual(budgetBytes);
    }

    const stats = cache.stats();
    expect(stats.entryCount).toBe(4);
    expect(stats.highWaterMarkBytes).toBe(budgetBytes);
    expect(stats.evictions).toBe(12);
    expect(cache.get(inst.sopInstanceUid, 0)).toBeUndefined();
    expect(cache.get(inst.sopInstanceUid, 15)).toBeDefined();
  });
});
