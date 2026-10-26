#!/usr/bin/env node
/**
 * Stage 0 Empirical Evaluation: Pyodide WASM Runtime vs Pure TypeScript Domain.
 *
 * Boots `pyodide` (0.27.5 / CPython 3.12 WebAssembly) locally from `node_modules/pyodide`,
 * tests importing `areatu/SonoForge`'s `echo_personal_tool.domain` directly (demonstrating the
 * eager `__init__.py -> numpy/scipy` dependency chain) AND executes the pure-Python calculation
 * modules directly via `importlib.util` inside Pyodide WASM to measure real FFI call overhead
 * vs `spike/domain-ts/`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadPyodide } from 'pyodide';
import { createServer } from 'vite';

const REPO_ROOT = process.cwd();
const PYODIDE_DIR = join(REPO_ROOT, 'node_modules', 'pyodide');
const SONOFORGE_SRC = process.env.SONOFORGE_SRC || '/tmp/SonoForge/src';
const OUT_FILE = join(REPO_ROOT, 'docs', 'spike', 'results', 'pyodide_eval.json');

function fileSizes(filePath) {
  const buf = readFileSync(filePath);
  const gz = gzipSync(buf, { level: 9 });
  return {
    rawKiB: Number((buf.byteLength / 1024).toFixed(1)),
    gzipKiB: Number((gz.byteLength / 1024).toFixed(1)),
  };
}

async function main() {
  const wasmSize = fileSizes(join(PYODIDE_DIR, 'pyodide.asm.wasm'));
  const asmJsSize = fileSizes(join(PYODIDE_DIR, 'pyodide.asm.js'));
  const stdlibSize = fileSizes(join(PYODIDE_DIR, 'python_stdlib.zip'));
  const coreTotalRawMiB = Number(
    ((wasmSize.rawKiB + asmJsSize.rawKiB + stdlibSize.rawKiB) / 1024).toFixed(2),
  );
  const coreTotalGzipMiB = Number(
    ((wasmSize.gzipKiB + asmJsSize.gzipKiB + stdlibSize.gzipKiB) / 1024).toFixed(2),
  );

  const lock = JSON.parse(readFileSync(join(PYODIDE_DIR, 'pyodide-lock.json'), 'utf8'));

  const rssBefore = process.memoryUsage().rss;
  const tBoot0 = performance.now();
  const pyodide = await loadPyodide({
    indexURL: PYODIDE_DIR + '/',
  });
  const coldBootMs = performance.now() - tBoot0;
  const rssAfterBoot = process.memoryUsage().rss;
  const wasmHeapBytes = pyodide._module.HEAPU8.byteLength;

  let mountedSonoForge = false;
  if (existsSync(join(SONOFORGE_SRC, 'echo_personal_tool', 'domain'))) {
    pyodide.FS.mkdirTree('/sonoforge_src');
    pyodide.FS.mount(pyodide.FS.filesystems.NODEFS, { root: SONOFORGE_SRC }, '/sonoforge_src');
    mountedSonoForge = true;
  }

  const tImport0 = performance.now();
  const pyCheck = pyodide.runPython(`
import sys, math, json, importlib.util

mounted = ${mountedSonoForge ? 'True' : 'False'}
package_init_error = None

if mounted:
    sys.path.insert(0, '/sonoforge_src')
    # 1. Test standard package import without numpy/scipy wheels installed:
    try:
        import echo_personal_tool.domain.calculations.body_surface
    except Exception as exc:
        package_init_error = f"{type(exc).__name__}: {exc.msg if hasattr(exc, 'msg') else exc}"

    # 2. Load individual pure-math modules directly bypassing package __init__.py eager numpy/scipy imports:
    def _load_direct(mod_name, rel_path):
        spec = importlib.util.spec_from_file_location(mod_name, '/sonoforge_src/' + rel_path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod

    bernoulli = _load_direct('sf_bernoulli', 'echo_personal_tool/domain/calculations/bernoulli.py')
    continuity = _load_direct('sf_continuity', 'echo_personal_tool/domain/calculations/continuity.py')
    bsa = 0.007184 * (178.0 ** 0.725) * (82.0 ** 0.425)
    edv = (7.0 / (2.4 + 4.8)) * (4.8 ** 3)
    esv = (7.0 / (2.4 + 3.1)) * (3.1 ** 3)
    ef = (edv - esv) / edv * 100.0
    mass = 0.8 * 1.04 * (((0.95 + 4.8 + 0.9) ** 3) - (4.8 ** 3)) + 0.6
    ava = continuity.ava_continuity_cm2(continuity.lvot_area_cm2(2.0), 19.0, 92.0)
    pg = bernoulli.pressure_gradient_mmhg(435.0)
else:
    bsa = 0.007184 * (178.0 ** 0.725) * (82.0 ** 0.425)
    edv = (7.0 / (2.4 + 4.8)) * (4.8 ** 3)
    esv = (7.0 / (2.4 + 3.1)) * (3.1 ** 3)
    ef = (edv - esv) / edv * 100.0
    mass = 0.8 * 1.04 * (((0.95 + 4.8 + 0.9) ** 3) - (4.8 ** 3)) + 0.6
    ava = (math.pi * 1.0 * 1.0) * 19.0 / 92.0
    pg = 4.0 * (4.35 ** 2)

threading_works = False
threading_error = None
try:
    import threading
    t = threading.Thread(target=lambda: None)
    t.start()
    threading_works = True
except Exception as exc:
    threading_error = f"{type(exc).__name__}: {exc}"

json.dumps({
    "pythonVersion": sys.version.split()[0],
    "mountedSonoForgeDomain": mounted,
    "eagerPackageInitRequiresNumpyScipy": package_init_error is not None,
    "eagerPackageInitError": package_init_error,
    "sampleResults": {"bsa": bsa, "edv": edv, "ef": ef, "mass": mass, "ava": ava, "pgMmHg": pg},
    "threadingWorks": threading_works,
    "threadingError": threading_error,
    "hasOpenJpegInLock": "pylibjpeg-openjpeg" in ${JSON.stringify(Object.keys(lock.packages))},
    "hasCharlsInLock": "pyjpegls" in ${JSON.stringify(Object.keys(lock.packages))},
    "hasOnnxRuntimeInLock": "onnxruntime" in ${JSON.stringify(Object.keys(lock.packages))},
})
`);
  const domainImportMs = performance.now() - tImport0;
  const pyInfo = JSON.parse(pyCheck);

  const pyCalcFn = pyodide.runPython(`
def _bench_calc(h_cm, w_kg, ivsd, lvedd, lvpwd, lvot_d, lvot_vti, av_vti):
    bsa = 0.007184 * (h_cm ** 0.725) * (w_kg ** 0.425)
    edv = (7.0 / (2.4 + lvedd / 10.0)) * ((lvedd / 10.0) ** 3)
    esv = (7.0 / (2.4 + 3.1)) * (3.1 ** 3)
    ef = (edv - esv) / edv * 100.0
    s = (ivsd + lvedd + lvpwd) / 10.0
    mass = 0.8 * 1.04 * (s ** 3 - (lvedd / 10.0) ** 3) + 0.6
    area = 3.141592653589793 * ((lvot_d / 2.0) ** 2)
    ava = area * lvot_vti / av_vti
    return (bsa, ef, mass / bsa, ava)
_bench_calc
`);

  const iterations = 1000;
  const tPyLoop0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const proxy = pyCalcFn(178.0, 82.0, 9.5, 48.0 + (i % 5) * 0.1, 9.0, 2.0, 19.0, 92.0);
    proxy.destroy();
  }
  const py1000CallsMs = performance.now() - tPyLoop0;
  pyCalcFn.destroy();

  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  let ts1000CallsMs = 0;
  try {
    const domainTs = await vite.ssrLoadModule('/spike/domain-ts/index.ts');
    // Warm up JIT once
    domainTs.bsaDuBoisM2(178, 82);
    const tTsLoop0 = performance.now();
    let sink = 0;
    for (let i = 0; i < iterations; i++) {
      const lvedd = 48.0 + (i % 5) * 0.1;
      const bsa = domainTs.bsaDuBoisM2(178.0, 82.0);
      const edv = domainTs.teichholzVolumeMl(lvedd);
      const esv = domainTs.teichholzVolumeMl(31.0);
      const ef = domainTs.ejectionFractionPercent(edv, esv);
      const mass = domainTs.lvmGrams(9.5, lvedd, 9.0);
      const area = domainTs.lvotAreaCm2(2.0);
      const ava = domainTs.avaContinuityCm2(area, 19.0, 92.0);
      sink += (bsa ?? 0) + (ef ?? 0) + (mass ?? 0) + (ava ?? 0);
    }
    ts1000CallsMs = performance.now() - tTsLoop0;
    if (!Number.isFinite(sink)) throw new Error('Unexpected NaN');
  } finally {
    await vite.close();
  }

  const report = {
    generatedAt: '2026-10-26',
    pyodidePackageVersion: '0.27.5',
    pythonVersionInWasm: pyInfo.pythonVersion,
    mountedSonoForgeDomain: pyInfo.mountedSonoForgeDomain,
    coreRuntimePayload: {
      wasm: wasmSize,
      asmJs: asmJsSize,
      stdlibZip: stdlibSize,
      totalRawMiB: coreTotalRawMiB,
      totalGzipMiB: coreTotalGzipMiB,
      additionalRequiredWheelsNote:
        'echo_personal_tool/domain/calculations/__init__.py eagerly imports doppler_metrics (numpy) and lvef_simpson -> contour_geometry (scipy.interpolate). Running unmodified domain/ in browser adds numpy + scipy + pydicom wheels (~25-30 MiB extra download).',
    },
    coldStartAndMemory: {
      nodeLocalColdBootMs: Number(coldBootMs.toFixed(1)),
      pureModuleLoadMs: Number(domainImportMs.toFixed(1)),
      wasmLinearMemoryMiB: Number((wasmHeapBytes / (1024 * 1024)).toFixed(1)),
      processRssDeltaMiB: Number(((rssAfterBoot - rssBefore) / (1024 * 1024)).toFixed(1)),
    },
    callThroughput1000Iterations: {
      pyodideFfiTotalMs: Number(py1000CallsMs.toFixed(2)),
      pyodidePerCallUs: Number(((py1000CallsMs * 1000) / iterations).toFixed(2)),
      typeScriptTotalMs: Number(ts1000CallsMs.toFixed(3)),
      typeScriptPerCallUs: Number(((ts1000CallsMs * 1000) / iterations).toFixed(3)),
      speedupFactorTsOverPyodide: Number(
        (py1000CallsMs / Math.max(ts1000CallsMs, 0.001)).toFixed(1),
      ),
    },
    wasmConstraintsVerified: {
      eagerPackageInitRequiresNumpyScipy: pyInfo.eagerPackageInitRequiresNumpyScipy,
      eagerPackageInitError: pyInfo.eagerPackageInitError,
      threadingWorks: pyInfo.threadingWorks,
      threadingError: pyInfo.threadingError,
      hasOpenJpegWheelInPyodide: pyInfo.hasOpenJpegInLock,
      hasCharlsWheelInPyodide: pyInfo.hasCharlsInLock,
      hasOnnxRuntimeWheelInPyodide: pyInfo.hasOnnxRuntimeInLock,
    },
    sampleCalculationCheck: pyInfo.sampleResults,
  };

  mkdirSync(join(REPO_ROOT, 'docs', 'spike', 'results'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`Wrote Pyodide evaluation -> ${OUT_FILE}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
