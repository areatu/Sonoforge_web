#!/usr/bin/env node
/**
 * Stage 0 Empirical Benchmark: Cornerstone3D WASM Codec Engine vs DWV (0.36.4).
 *
 * Evaluates on both:
 *  - 11 multi-vendor synthetic echo fixtures (`spike/fixtures/`)
 *  - 6 full-scale 720p (1280x720, 30-frame cine) benchmark files (`.spike-bench-data/`)
 *
 * Measures:
 *  - Header / metadata parse latency (ms)
 *  - Ultrasound `SequenceOfUltrasoundRegions` (0018,6011) calibration support
 *  - Cold first-frame decode latency (ms, including WASM/worker init)
 *  - Warm per-frame cine decode latency (avg & p95 ms across 30 frames) & achievable cine FPS
 *  - Bit-exact SHA-256 parity on lossless syntaxes vs `pydicom`
 *  - Memory footprint: unbounded 120-frame 720p cine vs `LruFrameCache(96 MiB)` bounded cache
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { createServer } from 'vite';

const REPO_ROOT = process.cwd();
const FIXTURES_DIR = join(REPO_ROOT, 'spike', 'fixtures');
const BENCH_DIR = join(REPO_ROOT, '.spike-bench-data');
const OUT_FILE = join(REPO_ROOT, 'docs', 'spike', 'results', 'dicom_engine_bench.json');

function sha256Hex(typedArr) {
  const bytes = new Uint8Array(typedArr.buffer, typedArr.byteOffset, typedArr.byteLength);
  return createHash('sha256').update(bytes).digest('hex');
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function loadDwvWorkerHarness(workerFilename) {
  const scriptPath = join(
    REPO_ROOT,
    'node_modules',
    'dwv',
    'dist',
    'assets',
    'workers',
    workerFilename,
  );
  const code = readFileSync(scriptPath, 'utf8');
  let onMessage = null;
  let lastResult = null;
  const sandbox = {
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    ArrayBuffer,
    DataView,
    Math,
    console,
    self: {
      addEventListener: (type, fn) => {
        if (type === 'message') onMessage = fn;
      },
      postMessage: (msg) => {
        lastResult = msg[0];
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return (buffer, meta) => {
    lastResult = null;
    onMessage({ data: { buffer, meta } });
    return lastResult;
  };
}

async function main() {
  // Use Vite's SSR module loader to execute TypeScript modules directly in Node 22
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });

  try {
    const dicomTs = await vite.ssrLoadModule('/spike/dicom-ts/index.ts');
    const dwvMod = await import('dwv');

    const csReader = new dicomTs.DicomParserFileReader();
    const csFrameSource = new dicomTs.WasmCodecFrameSource();

    const dwvWorkers = {
      '1.2.840.10008.1.2.5': loadDwvWorkerHarness('rle.worker.min.js'),
      '1.2.840.10008.1.2.4.50': loadDwvWorkerHarness('jpegbaseline.worker.min.js'),
      '1.2.840.10008.1.2.4.57': loadDwvWorkerHarness('jpegloss.worker.min.js'),
      '1.2.840.10008.1.2.4.70': loadDwvWorkerHarness('jpegloss.worker.min.js'),
      '1.2.840.10008.1.2.4.90': loadDwvWorkerHarness('jpeg2000.worker.min.js'),
      '1.2.840.10008.1.2.4.91': loadDwvWorkerHarness('jpeg2000.worker.min.js'),
    };

    function runDwvParse(bytes) {
      const t0 = performance.now();
      const parser = new dwvMod.DicomParser();
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      parser.parse(ab);
      const parseMs = performance.now() - t0;
      const elems = parser.getDicomElements();
      // Check whether DWV exposes top-level PixelSpacing vs UltrasoundRegions
      const topSpacing = elems['00280030']?.value ?? null;
      const usRegionSeq = elems['00186011']?.value ?? null;
      const pixelElem = elems['7FE00010'];
      return { parseMs, elems, topSpacing, hasUsRegionSeq: Boolean(usRegionSeq), pixelElem };
    }

    function runDwvDecodeFrame(inst, bytes, dwvParsed, frameIndex) {
      const uid = inst.transferSyntax.uid;
      const t0 = performance.now();
      if (uid === '1.2.840.10008.1.2' || uid === '1.2.840.10008.1.2.1') {
        const rawVal = dwvParsed.pixelElem?.value;
        // DWV eagerly materializes frame buffers inside pixelElem.value during parse()!
        const buf = Array.isArray(rawVal) ? rawVal[frameIndex] : rawVal;
        const pixels =
          inst.bitsAllocated === 16 ? new Uint16Array(buf) : new Uint8Array(buf);
        return { ok: true, decodeMs: performance.now() - t0, pixels };
      }
      const workerDecode = dwvWorkers[uid];
      if (!workerDecode) {
        return {
          ok: false,
          reason: `DWV 0.36.4 has no built-in decoder worker for ${uid}`,
        };
      }
      const compressed = inst.pixelLayout.kind === 'encapsulated'
        ? inst.pixelLayout.frameSlices[frameIndex]
        : null;
      if (!compressed) {
        return { ok: false, reason: 'No encapsulated slice' };
      }
      try {
        const pixels = workerDecode(compressed, {
          bitsAllocated: inst.bitsAllocated,
          isSigned: inst.pixelRepresentation === 1,
          sliceSize: inst.rows * inst.columns,
          samplesPerPixel: inst.samplesPerPixel,
          planarConfiguration: inst.planarConfiguration,
        });
        const decodeMs = performance.now() - t0;
        if (!pixels) {
          return { ok: false, reason: 'DWV decoder returned null' };
        }
        return { ok: true, decodeMs, pixels };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }

    // 1. Multi-vendor compatibility matrix on all 11 compact fixtures
    const compactManifest = JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8'));
    const compatibilityMatrix = [];

    for (const entry of compactManifest) {
      const bytes = new Uint8Array(readFileSync(join(FIXTURES_DIR, entry.file)));
      const tParse0 = performance.now();
      const inst = csReader.readMetadata(bytes, entry.file, entry.file);
      const csParseMs = performance.now() - tParse0;

      let csDecodeOk = false;
      let csLosslessExact = null;
      let csDecodeMs = null;
      let csError = null;
      try {
        const f0 = await csFrameSource.decodeFrame(inst, bytes, 0);
        csDecodeOk = true;
        csDecodeMs = Number(f0.decodeTimeMs.toFixed(3));
        if (entry.lossless && entry.frame0Sha256) {
          csLosslessExact = sha256Hex(f0.pixels) === entry.frame0Sha256;
        }
      } catch (err) {
        csError = err instanceof Error ? err.message : String(err);
      }

      let dwvParseOk = false;
      let dwvParseMs = null;
      let dwvDecodeOk = false;
      let dwvDecodeMs = null;
      let dwvLosslessExact = null;
      let dwvNote = null;
      try {
        const dwvParsed = runDwvParse(bytes);
        dwvParseOk = true;
        dwvParseMs = Number(dwvParsed.parseMs.toFixed(3));
        const dwvDec = runDwvDecodeFrame(inst, bytes, dwvParsed, 0);
        dwvDecodeOk = dwvDec.ok;
        if (dwvDec.ok) {
          dwvDecodeMs = Number(dwvDec.decodeMs.toFixed(3));
          if (entry.lossless && entry.frame0Sha256) {
            dwvLosslessExact = sha256Hex(dwvDec.pixels) === entry.frame0Sha256;
          }
        } else {
          dwvNote = dwvDec.reason;
        }
      } catch (err) {
        dwvNote = err instanceof Error ? err.message : String(err);
      }

      compatibilityMatrix.push({
        file: entry.file,
        manufacturer: entry.manufacturer,
        modelName: entry.modelName,
        transferSyntaxUid: entry.transferSyntaxUid,
        transferSyntaxName: inst.transferSyntax.name,
        dimensions: `${entry.columns}x${entry.rows}x${entry.numberOfFrames}`,
        photometric: entry.photometricInterpretation,
        bitsAllocated: entry.bitsAllocated,
        calibrationResolved: inst.pixelSpacing,
        modularWasmAdapter: {
          parseMs: Number(csParseMs.toFixed(3)),
          decodeOk: csDecodeOk,
          coldFrame0Ms: csDecodeMs,
          losslessSha256Exact: csLosslessExact,
          error: csError,
        },
        dwv036: {
          parseOk: dwvParseOk,
          parseMs: dwvParseMs,
          decodeOk: dwvDecodeOk,
          frame0Ms: dwvDecodeMs,
          losslessSha256Exact: dwvLosslessExact,
          note: dwvNote,
        },
      });
    }

    // 2. Full-scale 720p (1280x720, 30-frame cine) performance benchmark
    const benchResults720p = [];
    if (existsSync(join(BENCH_DIR, 'manifest.json'))) {
      const benchManifest = JSON.parse(readFileSync(join(BENCH_DIR, 'manifest.json'), 'utf8'));
      for (const entry of benchManifest) {
        const bytes = new Uint8Array(readFileSync(join(BENCH_DIR, entry.file)));

        const tParse0 = performance.now();
        const inst = csReader.readMetadata(bytes, entry.file, entry.file);
        const csParseMs = performance.now() - tParse0;

        // Cold first frame
        const f0 = await csFrameSource.decodeFrame(inst, bytes, 0);
        const csColdFirstFrameMs = f0.decodeTimeMs;
        const csShaExact = entry.lossless ? sha256Hex(f0.pixels) === entry.frame0Sha256 : null;

        // Warm 30-frame cine decode + RGBA window/level preview render
        const frameDecodeTimes = [];
        const previewRenderTimes = [];
        for (let i = 0; i < inst.numberOfFrames; i++) {
          const decoded = await csFrameSource.decodeFrame(inst, bytes, i);
          frameDecodeTimes.push(decoded.decodeTimeMs);
          const tr0 = performance.now();
          csFrameSource.renderPreviewRgba(decoded, { windowCenter: 120, windowWidth: 230 });
          previewRenderTimes.push(performance.now() - tr0);
        }
        const sortedDecode = [...frameDecodeTimes].sort((a, b) => a - b);
        const avgDecodeMs =
          frameDecodeTimes.reduce((s, v) => s + v, 0) / frameDecodeTimes.length;
        const avgRenderMs =
          previewRenderTimes.reduce((s, v) => s + v, 0) / previewRenderTimes.length;
        const totalPerFrameMs = avgDecodeMs + avgRenderMs;

        // Compare DWV on the exact same 720p cine!
        let dwvStats = null;
        try {
          const dwvParsed = runDwvParse(bytes);
          // Decode up to 10 frames in DWV (pure-JS JPEG2000 at 720p is much slower!)
          const dwvFramesToRun =
            entry.transferSyntaxUid.startsWith('1.2.840.10008.1.2.4.9') ? 5 : inst.numberOfFrames;
          const dwvTimes = [];
          let dwvSupported = true;
          let dwvFailReason = null;
          let dwvExact = null;
          for (let i = 0; i < dwvFramesToRun; i++) {
            const dec = runDwvDecodeFrame(inst, bytes, dwvParsed, i);
            if (!dec.ok) {
              dwvSupported = false;
              dwvFailReason = dec.reason;
              break;
            }
            dwvTimes.push(dec.decodeMs);
            if (i === 0 && entry.lossless) {
              dwvExact = sha256Hex(dec.pixels) === entry.frame0Sha256;
            }
          }
          if (dwvSupported && dwvTimes.length > 0) {
            const dwvAvg = dwvTimes.reduce((s, v) => s + v, 0) / dwvTimes.length;
            dwvStats = {
              supported: true,
              parseMs: Number(dwvParsed.parseMs.toFixed(2)),
              avgDecodeMs: Number(dwvAvg.toFixed(2)),
              achievableDecodeFps: Number((1000 / Math.max(dwvAvg, 0.01)).toFixed(1)),
              losslessSha256Exact: dwvExact,
              sampledFrames: dwvFramesToRun,
            };
          } else {
            dwvStats = {
              supported: false,
              parseMs: Number(dwvParsed.parseMs.toFixed(2)),
              reason: dwvFailReason,
            };
          }
        } catch (err) {
          dwvStats = {
            supported: false,
            reason: err instanceof Error ? err.message : String(err),
          };
        }

        benchResults720p.push({
          file: entry.file,
          transferSyntaxUid: entry.transferSyntaxUid,
          transferSyntaxName: inst.transferSyntax.name,
          fileSizeMiB: Number((entry.sizeBytes / (1024 * 1024)).toFixed(2)),
          resolution: `${entry.columns}x${entry.rows}`,
          frames: entry.numberOfFrames,
          modularWasmEngine: {
            decoderId: f0.decoderId,
            parseMs: Number(csParseMs.toFixed(2)),
            coldFirstFrameMs: Number(csColdFirstFrameMs.toFixed(2)),
            warmAvgDecodeMs: Number(avgDecodeMs.toFixed(2)),
            warmP95DecodeMs: Number(percentile(sortedDecode, 95).toFixed(2)),
            avgRgbaWindowLevelMs: Number(avgRenderMs.toFixed(2)),
            totalFramePipelineMs: Number(totalPerFrameMs.toFixed(2)),
            achievableSingleWorkerFps: Number((1000 / Math.max(totalPerFrameMs, 0.01)).toFixed(1)),
            losslessSha256Exact: csShaExact,
          },
          dwv036Engine: dwvStats,
        });
      }
    }

    // 3. Memory budget simulation on a 120-frame 1280x720 RGB cine (331.8 MB uncompressed!)
    const frameRgbBytes = 1280 * 720 * 3; // 2,764,800 B (~2.64 MiB/frame)
    const cine120UnboundedBytes = frameRgbBytes * 120; // 331,776,000 B (~316.4 MiB)
    const cacheBudgetBytes = 96 * 1024 * 1024; // 96 MiB budget
    const simCache = new dicomTs.LruFrameCache(cacheBudgetBytes);
    for (let i = 0; i < 120; i++) {
      simCache.put({
        sopInstanceUid: 'sim-720p-rgb-120f',
        frameIndex: i,
        rows: 720,
        columns: 1280,
        samplesPerPixel: 3,
        bitsAllocated: 8,
        bitsStored: 8,
        pixelRepresentation: 0,
        photometricInterpretation: 'RGB',
        isLossless: true,
        pixels: new Uint8Array(frameRgbBytes),
        minPixel: 0,
        maxPixel: 255,
        decodeTimeMs: 0,
        decoderId: 'sim',
      });
    }
    const cacheStats = simCache.stats();

    const report = {
      generatedAt: '2026-10-26',
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      compatibilityMatrix,
      bench720p30f: benchResults720p,
      memoryBudget120f720pRgb: {
        singleFrameMiB: Number((frameRgbBytes / (1024 * 1024)).toFixed(2)),
        unbounded120FramesMiB: Number((cine120UnboundedBytes / (1024 * 1024)).toFixed(2)),
        configuredCacheBudgetMiB: 96,
        measuredHighWaterMarkMiB: Number(
          (cacheStats.highWaterMarkBytes / (1024 * 1024)).toFixed(2),
        ),
        residentFramesAtSteadyState: cacheStats.entryCount,
        evictionsDuring120FrameSweep: cacheStats.evictions,
      },
    };

    mkdirSync(join(REPO_ROOT, 'docs', 'spike', 'results'), { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`Wrote DICOM engine benchmark -> ${OUT_FILE}`);
    for (const row of benchResults720p) {
      const m = row.modularWasmEngine;
      const d = row.dwv036Engine;
      console.log(
        `  ${row.file.padEnd(36)} | WASM (${m.decoderId}): parse=${m.parseMs}ms, avgDecode=${m.warmAvgDecodeMs}ms (${m.achievableSingleWorkerFps} fps), exact=${m.losslessSha256Exact} | DWV: ${d?.supported ? `parse=${d.parseMs}ms, avgDecode=${d.avgDecodeMs}ms (${d.achievableDecodeFps} fps)` : `UNSUPPORTED (${d?.reason})`}`,
      );
    }
  } finally {
    await vite.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
