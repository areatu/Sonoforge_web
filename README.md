# SonoForge Web

> **Research & Engineering Notice (Non-Diagnostic Software):**  
> `SonoForge Web` is an open-source (`GPL-3.0`), local-first browser echocardiography workstation in active development based on [`areatu/SonoForge`](https://github.com/areatu/SonoForge). It is **not** a certified medical device and must **not** be used for primary clinical diagnosis. Local DICOM processing runs 100% inside the user's browser with zero server upload of patient files.

---

## Current Status: Stage 0 Technical Spike Complete (`PASSED`)

Stage 0 (`Этап 0 — Спайк и архитектурные решения`) empirically validates the browser DICOM pipeline, WebAssembly codec performance, pure TypeScript calculation parity against the Python `SonoForge` reference implementation, memory bounds for multi-frame ultrasound cine loops, and GPL-3.0 compliance.

### Key Stage 0 Empirical Findings

| Metric | Result | Reference Artifact |
|---|---|---|
| **Python ↔ TypeScript Formula Parity** | **39 / 39** golden differential vectors pass (`< 1e-9 .. 1e-6` tolerance) in `23 ms` | [`tests/domain_differential.test.ts`](tests/domain_differential.test.ts) |
| **Lossless DICOM Pixel Parity vs `pydicom`** | **100% SHA-256 bit-exact** across Explicit LE, Implicit 16-bit, RLE, JPEG Lossless SV1, JPEG-LS, and JPEG 2000 Lossless | [`tests/dicom_adapters.test.ts`](tests/dicom_adapters.test.ts) |
| **720p (`1280×720`, 30f) Cine Throughput** | **98.9 fps** Uncompressed · **99.2 fps** JPEG · **67.3 fps** JPEG-LS · **26.0 fps** JPEG 2000 Lossless (`3.3×` faster than DWV `9.7 fps`) | [`docs/spike/results/dicom_engine_bench.json`](docs/spike/results/dicom_engine_bench.json) |
| **Calculation Runtime Footprint** | **`3.2 KiB` gzip** pure TypeScript (`1.925 µs/call`) vs **`5.52 MiB+` gzip** Pyodide WASM (`1,469.8 ms` cold start, `+83.8 MiB` RSS) | [`docs/spike/results/pyodide_eval.json`](docs/spike/results/pyodide_eval.json) |
| **Initial App Shell Bundle** | **`88.7 KiB` gzip** JS + **`2.1 KiB` gzip** CSS; DICOM worker & WASM codecs load lazily on demand; **0 runtime CVEs** | [`docs/spike/results/bundle_size_bench.json`](docs/spike/results/bundle_size_bench.json) |
| **Cine Memory Protection** | `LruFrameCache(96 MiB)` caps a `316.4 MiB` 120-frame 720p RGB loop at **`94.93 MiB`** while preserving raw lossless pixels for calipers | [`spike/dicom-ts/lruFrameCache.ts`](spike/dicom-ts/lruFrameCache.ts) |

---

## Quick Start

```bash
# Install dependencies
npm install

# Run strict TypeScript check + 68 automated Vitest tests
npm run typecheck
npm test

# Start the interactive Stage 0 Browser Prototype (http://localhost:5173)
npm run dev

# Build production static bundle (dist/)
npm run build
```

### Re-running Stage 0 Benchmarks

```bash
# Bundle size comparison (domain-ts vs modular WASM vs DWV vs monolithic Cornerstone3D)
npm run spike:bench-bundles

# Pyodide 0.27.5 WASM cold-start, memory, and FFI evaluation
npm run spike:bench-pyodide

# Head-to-head DICOM engine & 720p cine benchmark (requires synthetic 720p bench data)
npm run spike:bench-dicom
```

---

## Repository Structure

```text
├── docs/
│   ├── SPECIFICATION.md                # Canonical migration plan & stage gates (RU)
│   ├── PARITY_CATALOG.md               # Formula-by-formula parity catalog vs SonoForge Python
│   ├── adr/
│   │   ├── ADR-001-dicom-engine-selection.md
│   │   ├── ADR-002-calculation-runtime.md
│   │   ├── ADR-003-browser-support-security-and-memory.md
│   │   ├── ADR-004-local-session-storage-and-migrations.md
│   │   └── ADR-005-licensing-and-third-party-notices.md
│   └── spike/
│       ├── STAGE0_SPIKE_REPORT.md      # Full Stage 0 Spike Report & Gate Checklist
│       └── results/                    # Measured JSON benchmark outputs
├── spike/
│   ├── domain-ts/                      # Pure TS port (BSA, Teichholz, LVM, RWT, 20-disk Simpson, Bernoulli, Continuity, VTI)
│   ├── dicom-ts/                       # Ports (DicomFileReader, FrameSource, SeriesAssembler), WASM codecs, LRU cache, coordinates
│   ├── fixtures/                       # 11 synthetic zero-PHI multi-vendor echo DICOM files + manifest.json
│   ├── scripts/                        # Fixture generator, golden vector extractor, and benchmark harnesses
│   └── web-proto/                      # Working React + Web Worker + Canvas 2D/Cine Stage 0 prototype
└── tests/
    ├── golden/domain_vectors_v1.json   # 39 golden vectors generated from SonoForge@7f9f056
    ├── domain_differential.test.ts     # Differential parity suite (TS vs Python reference)
    ├── dicom_adapters.test.ts          # SHA-256 lossless decode parity, US Region calibration & fallback tests
    ├── coordinate_mapping.test.ts      # Pan/zoom/HiDPI coordinate round-trip & uncalibrated px-only guardrails
    └── architecture_purity.test.ts     # Enforces zero UI/DOM/DICOM/ML imports in domain-ts & zero PHI in fixtures
```

---

## Scope Guardrails

In accordance with [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md):
- **Included:** Local-first DICOM import, multi-frame cine viewing, manual linear/area/Simpson/Doppler measurements, calibrated physical geometry (`(0018,6011)` US Regions + manual ruler), exact SonoForge echocardiographic formulas, structured local session export/import.
- **Explicitly Excluded:** ONNX/ML neural network inference, automated segmentation or contour propagation, Speckle Tracking Echocardiography (STE) / optical flow, DIMSE SCP/SCU listeners, mandatory cloud upload of patient data.

## License

Licensed under the **GNU General Public License v3.0 (`GPL-3.0`)** — see [`LICENSE`](LICENSE) and [`docs/adr/ADR-005-licensing-and-third-party-notices.md`](docs/adr/ADR-005-licensing-and-third-party-notices.md).
