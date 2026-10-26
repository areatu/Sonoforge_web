#!/usr/bin/env node
/**
 * Stage 0 Empirical Bundle Size & Dependency Audit Comparison:
 * 1. `domain-ts` pure calculation core
 * 2. Modular `dicom-parser` + lazy `@cornerstonejs/codec-*` WASM decoders (Recommended)
 * 3. `dwv@0.36.4` + pure-JS worker scripts
 * 4. Monolithic `@cornerstonejs/core` + `@cornerstonejs/dicom-image-loader` (pulls `@kitware/vtk.js` + `dcmjs`)
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const REPO_ROOT = process.cwd();
const OUT_FILE = join(REPO_ROOT, 'docs', 'spike', 'results', 'bundle_size_bench.json');

function measureFile(filePath) {
  const buf = readFileSync(filePath);
  const gz = gzipSync(buf, { level: 9 });
  return {
    rawKiB: Number((buf.byteLength / 1024).toFixed(1)),
    gzipKiB: Number((gz.byteLength / 1024).toFixed(1)),
  };
}

function sumDirAssets(dir) {
  let rawBytes = 0;
  let gzipBytes = 0;
  const files = [];
  function walk(d) {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (!ent.name.endsWith('.map')) {
        const buf = readFileSync(full);
        const gz = gzipSync(buf, { level: 9 });
        rawBytes += buf.byteLength;
        gzipBytes += gz.byteLength;
        files.push({
          file: ent.name,
          rawKiB: Number((buf.byteLength / 1024).toFixed(1)),
          gzipKiB: Number((gz.byteLength / 1024).toFixed(1)),
        });
      }
    }
  }
  walk(dir);
  files.sort((a, b) => b.rawKiB - a.rawKiB);
  return {
    totalRawKiB: Number((rawBytes / 1024).toFixed(1)),
    totalGzipKiB: Number((gzipBytes / 1024).toFixed(1)),
    files,
  };
}

async function bundleEntry(name, entryCode) {
  const tmpBase = join(REPO_ROOT, '.spike-bench-data', 'bundle-tmp');
  mkdirSync(tmpBase, { recursive: true });
  const workDir = mkdtempSync(join(tmpBase, `${name}-`));
  const entryPath = join(workDir, 'entry.ts');
  const outDir = join(workDir, 'dist');
  writeFileSync(entryPath, entryCode, 'utf8');
  try {
    await build({
      root: REPO_ROOT,
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir,
        emptyOutDir: true,
        minify: true,
        sourcemap: false,
        rollupOptions: {
          input: entryPath,
        },
      },
    });
    return sumDirAssets(outDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  // 1. Pure TypeScript calculation domain
  const domainBundle = await bundleEntry(
    'domain-ts',
    `import * as domain from '${join(REPO_ROOT, 'spike/domain-ts/index.ts')}'; console.log(domain);`,
  );

  // 2. Modular DICOM adapter (eager parser + lazy WASM codecs split into async chunks!)
  const modularAdapterBundle = await bundleEntry(
    'modular-dicom-ts',
    `import { DicomParserFileReader, DefaultSeriesAssembler, WasmCodecFrameSource, LruFrameCache } from '${join(REPO_ROOT, 'spike/dicom-ts/index.ts')}';
     console.log(DicomParserFileReader, DefaultSeriesAssembler, WasmCodecFrameSource, LruFrameCache);`,
  );

  // 3. DWV 0.36.4 main library + worker files
  const dwvBundle = await bundleEntry(
    'dwv',
    `import * as dwv from 'dwv'; console.log(dwv.App, dwv.DicomParser);`,
  );
  const dwvWorkerFiles = [
    'jpeg2000.worker.min.js',
    'jpegbaseline.worker.min.js',
    'jpegloss.worker.min.js',
    'rle.worker.min.js',
  ].map((f) => ({
    file: f,
    ...measureFile(join(REPO_ROOT, 'node_modules/dwv/dist/assets/workers', f)),
  }));

  // 4. Full @cornerstonejs/core + @cornerstonejs/dicom-image-loader
  const cornerstoneFullBundle = await bundleEntry(
    'cornerstone-full',
    `import * as csCore from '@cornerstonejs/core';
     import * as csLoader from '@cornerstonejs/dicom-image-loader';
     console.log(csCore.RenderingEngine, csLoader.init);`,
  );

  // 5. Individual WASM codec binary sizes (loaded lazily only when study uses that Transfer Syntax)
  const wasmCodecBinaries = {
    openjpegDecodeWasm: measureFile(
      join(REPO_ROOT, 'node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.wasm'),
    ),
    libjpegTurboDecodeWasm: measureFile(
      join(
        REPO_ROOT,
        'node_modules/@cornerstonejs/codec-libjpeg-turbo-8bit/dist/libjpegturbowasm_decode.wasm',
      ),
    ),
    charlsDecodeWasm: measureFile(
      join(REPO_ROOT, 'node_modules/@cornerstonejs/codec-charls/dist/charlswasm_decode.wasm'),
    ),
    openjphDecodeWasm: measureFile(
      join(REPO_ROOT, 'node_modules/@cornerstonejs/codec-openjph/dist/openjphjs.wasm'),
    ),
  };

  const report = {
    generatedAt: '2026-10-26',
    domainTsCore: domainBundle,
    modularDicomAdapterWithLazyCodecs: modularAdapterBundle,
    wasmCodecBinaries,
    dwv036: {
      mainBundle: dwvBundle,
      workerScripts: dwvWorkerFiles,
    },
    cornerstone3dMonolithic: cornerstoneFullBundle,
  };

  mkdirSync(join(REPO_ROOT, 'docs', 'spike', 'results'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`Wrote bundle size benchmark -> ${OUT_FILE}`);
  console.log(
    JSON.stringify(
      {
        domainTsGzipKiB: domainBundle.totalGzipKiB,
        modularAdapterTotalWithAllLazyCodecsGzipKiB: modularAdapterBundle.totalGzipKiB,
        dwvMainGzipKiB: dwvBundle.totalGzipKiB,
        cornerstoneMonolithicGzipKiB: cornerstoneFullBundle.totalGzipKiB,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
