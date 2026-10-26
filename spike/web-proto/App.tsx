import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  avaContinuityCm2,
  calculateSimpsonLvef,
  cardiacOutputLMin,
  computeSimpsonLines,
  dimensionlessIndex,
  fractionalShorteningPercent,
  indexedToBsa,
  lvmFromLinearMeasurements,
  lvotAreaCm2,
  pressureGradientMmHg,
  resolveBsaBasis,
  rwtFromLinearMeasurements,
  strokeVolumeMl,
  teichholzFromLinearMeasurements,
  type LinearCaliperInput,
  type Point2D,
  type SimpsonContourInput,
} from '../domain-ts';
import {
  baseFitScale,
  imageToScreenCss,
  measureLinearDistance,
  screenCssToImage,
  spacingFromKnownDistance,
  type FrameCacheStats,
  type PixelSpacingResolution,
  type StudyRef,
  type ViewportTransform,
} from '../dicom-ts';
import type {
  BrowserBenchRow,
  SerializedInstanceSummary,
  WorkerInputFile,
  WorkerRequest,
  WorkerResponse,
} from './worker/dicomDecode.worker';

type Lang = 'ru' | 'en';
type ToolMode = 'pan' | 'caliper' | 'ruler' | 'simpson';
type CaliperRole = 'LVEDD' | 'LVESD' | 'IVSd' | 'LVPWd' | 'LVOTd' | 'Free';
type SimpsonSlot = 'a4c_ed' | 'a4c_es' | 'a2c_ed' | 'a2c_es';
type RightTab = 'calc' | 'meta' | 'bench';

interface LinearMeasurement {
  readonly id: string;
  readonly sopInstanceUid: string;
  readonly frameIndex: number;
  readonly role: CaliperRole;
  readonly p1: Point2D;
  readonly p2: Point2D;
}

interface SimpsonContourRecord {
  readonly sopInstanceUid: string;
  readonly frameIndex: number;
  readonly slot: SimpsonSlot;
  readonly pointsPx: readonly Point2D[];
}

interface ExportedSessionV1 {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly exportedAt: string;
  readonly patientContext: {
    readonly heightCm: number | null;
    readonly weightKg: number | null;
    readonly manualBsaM2: number | null;
    readonly lvotVtiCm: number | null;
    readonly avVtiCm: number | null;
    readonly avVmaxCmPerSec: number | null;
    readonly heartRateBpm: number | null;
  };
  readonly manualCalibrationsMmPerPx: Record<string, number>;
  readonly linearMeasurements: readonly LinearMeasurement[];
  readonly simpsonContours: Partial<Record<SimpsonSlot, SimpsonContourRecord>>;
}

const SAMPLE_FILES = [
  '01_ge_vivid_2d_uncompressed.dcm',
  '02_philips_epiq_cine_uncompressed.dcm',
  '03_siemens_acuson_16bit_implicit.dcm',
  '04_samsung_v8_cine_jpeg_baseline.dcm',
  '05_ge_vivid_color_jpeg_ybr422.dcm',
  '06_mindray_resona_jpeg_lossless_p14sv1.dcm',
  '07_canon_aplio_jpegls_lossless.dcm',
  '08_philips_epiq_jpeg2000_lossless.dcm',
  '09_philips_ie33_rle_lossless.dcm',
  '10_uncalibrated_handheld_us.dcm',
  '11_unsupported_mpeg2_stub.dcm',
] as const;

const COPY = {
  ru: {
    disclaimerPill: 'STAGE 0 SPIKE · НЕ ДЛЯ КЛИНИЧЕСКОЙ ДИАГНОСТИКИ',
    disclaimerText:
      'Исследовательский браузерный прототип SonoForge Web · 100% локальная обработка DICOM без загрузки на сервер',
    loadSamples: 'Загрузить тест-набор (11 DICOM)',
    openFiles: 'Открыть DICOM',
    openFolder: 'Папка DICOM',
    clearSession: 'Очистить',
    hidePhi: 'Скрывать PHI',
    studiesHeader: 'Исследования и серии',
    noStudies: 'Перетащите DICOM-файлы сюда или нажмите «Загрузить тест-набор (11 DICOM)».',
    tabCalc: 'Расчёты',
    tabMeta: 'Метаданные',
    tabBench: 'Stage 0 Bench',
    toolPan: 'Панорама',
    toolCaliper: 'Линейка',
    toolRuler: 'Калибровка (мм)',
    toolSimpson: 'Контур Симпсона',
    finishContour: 'Завершить контур',
    demoSimpson: 'Демо-контуры ED/ES',
    fitView: 'Вписать',
    exportJson: 'Экспорт JSON',
    importJson: 'Импорт JSON',
    runBench: 'Запустить WASM-бенчмарк в браузере',
  },
  en: {
    disclaimerPill: 'STAGE 0 SPIKE · NON-DIAGNOSTIC PROTOTYPE',
    disclaimerText:
      'SonoForge Web Stage 0 Technical Spike · 100% local in-browser DICOM processing (zero network upload)',
    loadSamples: 'Load Echo Suite (11 DICOMs)',
    openFiles: 'Open DICOMs',
    openFolder: 'Open Folder',
    clearSession: 'Clear',
    hidePhi: 'Hide PHI',
    studiesHeader: 'Studies & Series',
    noStudies: 'Drop local DICOM files anywhere or click "Load Echo Suite (11 DICOMs)".',
    tabCalc: 'Calculations',
    tabMeta: 'Metadata',
    tabBench: 'Stage 0 Bench',
    toolPan: 'Pan',
    toolCaliper: 'Caliper',
    toolRuler: 'Calibrate (mm)',
    toolSimpson: 'Simpson Trace',
    finishContour: 'Finish Trace',
    demoSimpson: 'Demo ED/ES Traces',
    fitView: 'Fit',
    exportJson: 'Export JSON',
    importJson: 'Import JSON',
    runBench: 'Run In-Browser WASM Benchmark',
  },
} as const;

function parseNumInput(raw: string): number | null {
  if (!raw.trim()) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

function fmt(val: number | null | undefined, digits = 1, suffix = ''): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  return `${val.toFixed(digits)}${suffix ? ` ${suffix}` : ''}`;
}

function recordToContourInput(rec: SimpsonContourRecord): SimpsonContourInput | null {
  if (rec.pointsPx.length < 4) return null;
  const septal = rec.pointsPx[0]!;
  const lateral = rec.pointsPx[rec.pointsPx.length - 1]!;
  const view = rec.slot.startsWith('a4c') ? 'A4C' : 'A2C';
  const phase = rec.slot.endsWith('ed') ? 'ed' : 'es';
  return {
    view,
    phase,
    chamber: 'LV',
    points: rec.pointsPx,
    mitralAnnulus: [septal, lateral],
  };
}

export function App({ shellBootMs }: { readonly shellBootMs: number }): React.ReactElement {
  const [lang, setLang] = useState<Lang>('ru');
  const t = COPY[lang];

  const [hidePhi, setHidePhi] = useState<boolean>(true);
  const [studies, setStudies] = useState<StudyRef[]>([]);
  const [instances, setInstances] = useState<Record<string, SerializedInstanceSummary>>({});
  const [selectedSopUid, setSelectedSopUid] = useState<string | null>(null);
  const [frameIndex, setFrameIndex] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);

  const [windowCenter, setWindowCenter] = useState<number>(128);
  const [windowWidth, setWindowWidth] = useState<number>(255);
  const [zoom, setZoom] = useState<number>(0.92);
  const [panCss, setPanCss] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [stageCssSize, setStageCssSize] = useState<{ w: number; h: number }>({ w: 640, h: 480 });

  const [toolMode, setToolMode] = useState<ToolMode>('caliper');
  const [caliperRole, setCaliperRole] = useState<CaliperRole>('LVEDD');
  const [simpsonSlot, setSimpsonSlot] = useState<SimpsonSlot>('a4c_ed');
  const [rulerKnownMm, setRulerKnownMm] = useState<string>('50');

  const [manualCalibrations, setManualCalibrations] = useState<Record<string, number>>({});
  const [linearMeasurements, setLinearMeasurements] = useState<LinearMeasurement[]>([]);
  const [simpsonContours, setSimpsonContours] = useState<
    Partial<Record<SimpsonSlot, SimpsonContourRecord>>
  >({});
  const [draftPoints, setDraftPoints] = useState<Point2D[]>([]);
  const [cursorImagePt, setCursorImagePt] = useState<Point2D | null>(null);
  const [revision, setRevision] = useState<number>(1);

  const [heightInput, setHeightInput] = useState<string>('176');
  const [weightInput, setWeightInput] = useState<string>('78');
  const [manualBsaInput, setManualBsaInput] = useState<string>('');
  const [lvotVtiInput, setLvotVtiInput] = useState<string>('21.5');
  const [avVtiInput, setAvVtiInput] = useState<string>('52.0');
  const [avVmaxInput, setAvVmaxInput] = useState<string>('265');
  const [hrInput, setHrInput] = useState<string>('68');

  const [rightTab, setRightTab] = useState<RightTab>('calc');
  const [workerInitMs, setWorkerInitMs] = useState<number | null>(null);
  const [lastParseMs, setLastParseMs] = useState<number | null>(null);
  const [lastDecodeInfo, setLastDecodeInfo] = useState<{
    decoderId: string;
    decodeMs: number;
    renderMs: number;
    fromCache: boolean;
    isLossless: boolean;
  } | null>(null);
  const [cacheStats, setCacheStats] = useState<FrameCacheStats | null>(null);
  const [cacheBudgetMiB, setCacheBudgetMiB] = useState<number>(96);
  const [busyStatus, setBusyStatus] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<number | null>(null);
  const [viewportError, setViewportError] = useState<{
    message: string;
    fallback?: string;
  } | null>(null);
  const [benchRows, setBenchRows] = useState<readonly BrowserBenchRow[]>([]);

  const workerRef = useRef<Worker | null>(null);
  const reqSeqRef = useRef<number>(1);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenFrameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragPanRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(
    null,
  );

  const selectedInstance = selectedSopUid ? instances[selectedSopUid] ?? null : null;

  const viewportTransform = useMemo<ViewportTransform>(
    () => ({
      imageWidth: selectedInstance?.columns ?? 640,
      imageHeight: selectedInstance?.rows ?? 480,
      canvasCssWidth: stageCssSize.w,
      canvasCssHeight: stageCssSize.h,
      devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
      zoom,
      panCssX: panCss.x,
      panCssY: panCss.y,
    }),
    [selectedInstance?.columns, selectedInstance?.rows, stageCssSize, zoom, panCss],
  );

  const effectiveCalibration = useMemo<PixelSpacingResolution | null>(() => {
    if (!selectedInstance) return null;
    const manualMm = manualCalibrations[selectedInstance.sopInstanceUid];
    if (manualMm !== undefined && manualMm > 0) {
      return {
        spacingMm: [manualMm, manualMm],
        source: 'manual_ruler',
      };
    }
    return selectedInstance.pixelSpacing;
  }, [selectedInstance, manualCalibrations]);

  useEffect(() => {
    const updateSize = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setStageCssSize({ w: r.width, h: r.height });
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  const drawImageCanvas = useCallback(() => {
    const canvas = imageCanvasRef.current;
    const stage = stageRef.current;
    const off = offscreenFrameCanvasRef.current;
    if (!canvas || !stage) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = stage.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!off || viewportError) return;

    const [topLeftX, topLeftY] = imageToScreenCss([0, 0], viewportTransform);
    const scale = baseFitScale(viewportTransform) * viewportTransform.zoom;
    ctx.imageSmoothingEnabled = scale < 2.5;
    ctx.drawImage(off, topLeftX, topLeftY, off.width * scale, off.height * scale);
  }, [viewportTransform, viewportError]);

  // Lazy Web Worker initialization after shell paints (Spec §6)
  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const t0 = performance.now();
    const w = new Worker(new URL('./worker/dicomDecode.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        setBusyStatus(`${msg.label} (${msg.completed + 1}/${msg.total})`);
        return;
      }
      if (msg.type === 'ingestComplete') {
        setBusyStatus(null);
        setActiveRequestId(null);
        setStudies(msg.studies);
        setInstances(msg.instances);
        setLastParseMs(msg.totalParseMs);
        setCacheStats(msg.cacheStats);

        const firstSop = msg.studies[0]?.series[0]?.instances[0]?.sopInstanceUid ?? null;
        if (firstSop) {
          const inst = msg.instances[firstSop];
          setSelectedSopUid(firstSop);
          setFrameIndex(0);
          if (inst?.patientHeightCm) setHeightInput(String(inst.patientHeightCm));
          if (inst?.patientWeightKg) setWeightInput(String(inst.patientWeightKg));
          if (inst?.heartRateBpm) setHrInput(String(inst.heartRateBpm));
          setWindowCenter(inst?.windowCenter ?? (inst?.bitsStored === 12 ? 2048 : 128));
          setWindowWidth(inst?.windowWidth ?? (inst?.bitsStored === 12 ? 4095 : 255));
        }
        return;
      }
      if (msg.type === 'frameDecoded') {
        setViewportError(null);
        setCacheStats(msg.cacheStats);
        setLastDecodeInfo({
          decoderId: msg.decoderId,
          decodeMs: msg.decodeTimeMs,
          renderMs: msg.renderTimeMs,
          fromCache: msg.fromCache,
          isLossless: msg.isLossless,
        });

        let off = offscreenFrameCanvasRef.current;
        if (!off) {
          off = document.createElement('canvas');
          offscreenFrameCanvasRef.current = off;
        }
        off.width = msg.columns;
        off.height = msg.rows;
        const offCtx = off.getContext('2d');
        if (offCtx) {
          const clamped = new Uint8ClampedArray(msg.rgbaBuffer);
          const imgData = new ImageData(clamped, msg.columns, msg.rows);
          offCtx.putImageData(imgData, 0, 0);
        }
        drawImageCanvas();
        return;
      }
      if (msg.type === 'benchComplete') {
        setBusyStatus(null);
        setActiveRequestId(null);
        setBenchRows(msg.rows);
        setCacheStats(msg.cacheStats);
        return;
      }
      if (msg.type === 'ack') {
        setCacheStats(msg.cacheStats);
        return;
      }
      if (msg.type === 'error') {
        setBusyStatus(null);
        setActiveRequestId(null);
        if (msg.code === 'UNSUPPORTED_SYNTAX') {
          setViewportError({
            message: msg.message,
            fallback: msg.fallbackStrategy,
          });
        } else if (msg.code !== 'CANCELLED') {
          setViewportError({ message: msg.message });
        }
      }
    });
    setWorkerInitMs(Number((performance.now() - t0).toFixed(2)));
    workerRef.current = w;
    return w;
  }, [drawImageCanvas]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const postWorker = useCallback(
    (payload: WorkerRequest, transfer?: Transferable[]) => {
      const w = ensureWorker();
      if (transfer && transfer.length > 0) {
        w.postMessage(payload, transfer);
      } else {
        w.postMessage(payload);
      }
    },
    [ensureWorker],
  );

  // Reset fit whenever selected instance changes
  useEffect(() => {
    setZoom(0.92);
    setPanCss({ x: 0, y: 0 });
    setDraftPoints([]);
  }, [selectedInstance?.sopInstanceUid]);

  // Request frame decode whenever instance, frameIndex, or W/L changes
  useEffect(() => {
    if (!selectedInstance) return;
    const id = reqSeqRef.current++;
    postWorker({
      id,
      type: 'decodeFrame',
      sopInstanceUid: selectedInstance.sopInstanceUid,
      frameIndex,
      windowCenter,
      windowWidth,
    });
  }, [selectedInstance?.sopInstanceUid, frameIndex, windowCenter, windowWidth, postWorker]);

  // Cine loop via requestAnimationFrame
  useEffect(() => {
    if (!isPlaying || !selectedInstance || selectedInstance.numberOfFrames <= 1) return;
    const baseMs =
      selectedInstance.frameTimeMs && selectedInstance.frameTimeMs > 5
        ? selectedInstance.frameTimeMs
        : 33.33;
    const intervalMs = baseMs / playbackSpeed;
    let rafId = 0;
    let lastTick = performance.now();

    const step = (now: number) => {
      if (now - lastTick >= intervalMs) {
        lastTick = now;
        setFrameIndex((prev) => (prev + 1) % selectedInstance.numberOfFrames);
      }
      rafId = requestAnimationFrame(step);
    };
    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, selectedInstance, playbackSpeed]);

  // Keyboard shortcuts (ignored inside text/number/select inputs per Spec §6)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!selectedInstance) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (selectedInstance.numberOfFrames > 1) {
          setIsPlaying((p) => !p);
        }
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setIsPlaying(false);
        setFrameIndex((f) => (f + 1) % Math.max(1, selectedInstance.numberOfFrames));
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setIsPlaying(false);
        setFrameIndex(
          (f) =>
            (f - 1 + Math.max(1, selectedInstance.numberOfFrames)) %
            Math.max(1, selectedInstance.numberOfFrames),
        );
      } else if (e.code === 'Escape') {
        setDraftPoints([]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedInstance]);

  const drawOverlayCanvas = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = stage.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!selectedInstance || viewportError) return;

    // 1. Draw linear calipers on current SOP + frame
    const activeCalipers = linearMeasurements.filter(
      (m) =>
        m.sopInstanceUid === selectedInstance.sopInstanceUid && m.frameIndex === frameIndex,
    );
    for (const m of activeCalipers) {
      const s1 = imageToScreenCss(m.p1, viewportTransform);
      const s2 = imageToScreenCss(m.p2, viewportTransform);
      const dist = measureLinearDistance(
        m.p1,
        m.p2,
        effectiveCalibration?.spacingMm ?? null,
        effectiveCalibration?.source ?? null,
      );

      ctx.strokeStyle = '#40e2de';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(s1[0], s1[1]);
      ctx.lineTo(s2[0], s2[1]);
      ctx.stroke();

      for (const pt of [s1, s2]) {
        ctx.fillStyle = '#070b11';
        ctx.strokeStyle = '#40e2de';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      const label =
        dist.millimeterLength !== null
          ? `${m.role}: ${dist.millimeterLength.toFixed(1)} mm`
          : `${m.role}: ${dist.pixelLength.toFixed(1)} px (uncal)`;
      const mx = (s1[0] + s2[0]) / 2 + 6;
      const my = (s1[1] + s2[1]) / 2 - 6;
      ctx.font = '600 11.5px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(7, 11, 17, 0.82)';
      const tw = ctx.measureText(label).width;
      ctx.fillRect(mx - 4, my - 12, tw + 8, 16);
      ctx.fillStyle = '#40e2de';
      ctx.fillText(label, mx, my);
    }

    // 2. Draw saved Simpson contours + 20 perpendicular disk chords directly via computeSimpsonLines
    for (const rec of Object.values(simpsonContours)) {
      if (
        !rec ||
        rec.sopInstanceUid !== selectedInstance.sopInstanceUid ||
        rec.frameIndex !== frameIndex
      ) {
        continue;
      }
      const screenPts = rec.pointsPx.map((p) => imageToScreenCss(p, viewportTransform));
      if (screenPts.length >= 2) {
        ctx.strokeStyle = '#34d399';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(screenPts[0]![0], screenPts[0]![1]);
        for (let i = 1; i < screenPts.length; i++) {
          ctx.lineTo(screenPts[i]![0], screenPts[i]![1]);
        }
        ctx.stroke();
      }

      const contourInput = recordToContourInput(rec);
      const lines = contourInput
        ? computeSimpsonLines(contourInput, effectiveCalibration?.spacingMm ?? null)
        : null;
      if (lines) {
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.4;
        const baseScreen = imageToScreenCss(lines.centralLine[0], viewportTransform);
        const apexScreen = imageToScreenCss(lines.centralLine[1], viewportTransform);
        ctx.beginPath();
        ctx.moveTo(baseScreen[0], baseScreen[1]);
        ctx.lineTo(apexScreen[0], apexScreen[1]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = 'rgba(64, 226, 222, 0.62)';
        ctx.lineWidth = 1.1;
        for (const [lPt, rPt] of lines.diskLines) {
          const lp = imageToScreenCss(lPt, viewportTransform);
          const rp = imageToScreenCss(rPt, viewportTransform);
          ctx.beginPath();
          ctx.moveTo(lp[0], lp[1]);
          ctx.lineTo(rp[0], rp[1]);
          ctx.stroke();
        }
      }
    }

    // 3. Draw in-progress draft points
    if (draftPoints.length > 0) {
      const pts = cursorImagePt ? [...draftPoints, cursorImagePt] : [...draftPoints];
      const sPts = pts.map((p) => imageToScreenCss(p, viewportTransform));
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(sPts[0]![0], sPts[0]![1]);
      for (let i = 1; i < sPts.length; i++) {
        ctx.lineTo(sPts[i]![0], sPts[i]![1]);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [
    selectedInstance,
    viewportError,
    linearMeasurements,
    simpsonContours,
    frameIndex,
    viewportTransform,
    effectiveCalibration,
    draftPoints,
    cursorImagePt,
  ]);

  useEffect(() => {
    drawImageCanvas();
    drawOverlayCanvas();
  }, [drawImageCanvas, drawOverlayCanvas]);

  const ingestWorkerFiles = useCallback(
    (workerFiles: WorkerInputFile[]) => {
      if (workerFiles.length === 0) return;
      const id = reqSeqRef.current++;
      setActiveRequestId(id);
      setBusyStatus(`Importing ${workerFiles.length} DICOM file(s)...`);
      postWorker(
        { id, type: 'ingestFiles', files: workerFiles },
        workerFiles.map((f) => f.bytes.buffer),
      );
    },
    [postWorker],
  );

  const handleLoadSamples = useCallback(async () => {
    setBusyStatus('Fetching local synthetic echo fixtures...');
    const loaded: WorkerInputFile[] = [];
    for (const name of SAMPLE_FILES) {
      const resp = await fetch(`./samples/${name}`);
      if (!resp.ok) continue;
      const buf = await resp.arrayBuffer();
      loaded.push({
        fileId: `sample:${name}`,
        fileName: name,
        bytes: new Uint8Array(buf),
      });
    }
    ingestWorkerFiles(loaded);
  }, [ingestWorkerFiles]);

  const handleLocalFileList = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setBusyStatus(`Reading ${fileList.length} local file(s)...`);
      const items: WorkerInputFile[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i]!;
        if (f.name.startsWith('.')) continue;
        const buf = await f.arrayBuffer();
        items.push({
          fileId: `local:${i}:${f.name}:${f.size}`,
          fileName: f.name,
          bytes: new Uint8Array(buf),
        });
      }
      ingestWorkerFiles(items);
    },
    [ingestWorkerFiles],
  );

  const handleRunBrowserBench = useCallback(async () => {
    setRightTab('bench');
    setBusyStatus('Loading sample suite for browser WASM benchmark...');
    const loaded: WorkerInputFile[] = [];
    for (const name of SAMPLE_FILES) {
      const resp = await fetch(`./samples/${name}`);
      if (!resp.ok) continue;
      const buf = await resp.arrayBuffer();
      loaded.push({
        fileId: `bench:${name}`,
        fileName: name,
        bytes: new Uint8Array(buf),
      });
    }
    const id = reqSeqRef.current++;
    setActiveRequestId(id);
    postWorker(
      { id, type: 'runBrowserBench', files: loaded },
      loaded.map((f) => f.bytes.buffer),
    );
  }, [postWorker]);

  const getEventImagePoint = (e: React.MouseEvent<HTMLCanvasElement>): Point2D | null => {
    if (!selectedInstance || !overlayCanvasRef.current) return null;
    const rect = overlayCanvasRef.current.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    const [ix, iy] = screenCssToImage([vx, vy], viewportTransform);
    return [
      Math.max(0, Math.min(selectedInstance.columns - 1, ix)),
      Math.max(0, Math.min(selectedInstance.rows - 1, iy)),
    ];
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!selectedInstance || viewportError) return;
    if (toolMode === 'pan' || e.button === 1) {
      dragPanRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: panCss.x,
        origY: panCss.y,
      };
      return;
    }

    const pt = getEventImagePoint(e);
    if (!pt) return;

    if (toolMode === 'caliper') {
      if (draftPoints.length === 0) {
        setDraftPoints([pt]);
      } else {
        const p1 = draftPoints[0]!;
        setLinearMeasurements((prev) => [
          ...prev.filter((m) => m.role === 'Free' || m.role !== caliperRole),
          {
            id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            sopInstanceUid: selectedInstance.sopInstanceUid,
            frameIndex,
            role: caliperRole,
            p1,
            p2: pt,
          },
        ]);
        setDraftPoints([]);
        setRevision((r) => r + 1);
      }
    } else if (toolMode === 'ruler') {
      if (draftPoints.length === 0) {
        setDraftPoints([pt]);
      } else {
        const p1 = draftPoints[0]!;
        const knownMm = parseNumInput(rulerKnownMm);
        if (knownMm && knownMm > 0) {
          try {
            const [mmPerPx] = spacingFromKnownDistance(p1, pt, knownMm);
            setManualCalibrations((prev) => ({
              ...prev,
              [selectedInstance.sopInstanceUid]: Number(mmPerPx.toFixed(6)),
            }));
            setRevision((r) => r + 1);
          } catch {
            // Ignore zero-length click
          }
        }
        setDraftPoints([]);
        setToolMode('caliper');
      }
    } else if (toolMode === 'simpson') {
      setDraftPoints((prev) => [...prev, pt]);
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragPanRef.current) {
      const dx = e.clientX - dragPanRef.current.startX;
      const dy = e.clientY - dragPanRef.current.startY;
      setPanCss({
        x: dragPanRef.current.origX + dx,
        y: dragPanRef.current.origY + dy,
      });
      return;
    }
    const pt = getEventImagePoint(e);
    if (pt) setCursorImagePt(pt);
  };

  const handleCanvasMouseUp = () => {
    dragPanRef.current = null;
  };

  const handleFinishSimpson = useCallback(() => {
    if (!selectedInstance || draftPoints.length < 5) return;
    setSimpsonContours((prev) => ({
      ...prev,
      [simpsonSlot]: {
        sopInstanceUid: selectedInstance.sopInstanceUid,
        frameIndex,
        slot: simpsonSlot,
        pointsPx: draftPoints,
      },
    }));
    setDraftPoints([]);
    setRevision((r) => r + 1);
  }, [selectedInstance, draftPoints, simpsonSlot, frameIndex]);

  const handlePopulateDemoSimpson = useCallback(() => {
    if (!selectedInstance) return;
    const cx = selectedInstance.columns * 0.5;
    const apexY = selectedInstance.rows * 0.24;
    const baseY = selectedInstance.rows * 0.72;
    // Septal mitral annulus -> apex -> lateral mitral annulus
    const makeChamber = (halfW: number): Point2D[] => {
      const pts: Point2D[] = [];
      const n = 25;
      for (let i = 0; i < n; i++) {
        const u = -1 + (2 * i) / (n - 1);
        const x = cx + u * halfW * Math.sqrt(Math.max(0.12, 1 - 0.25 * u * u));
        const y = apexY + (baseY - apexY) * u * u;
        pts.push([x, y]);
      }
      return pts;
    };
    const esFrame = Math.min(Math.max(0, selectedInstance.numberOfFrames - 1), 6);
    setSimpsonContours({
      a4c_ed: {
        sopInstanceUid: selectedInstance.sopInstanceUid,
        frameIndex: 0,
        slot: 'a4c_ed',
        pointsPx: makeChamber(selectedInstance.columns * 0.14),
      },
      a4c_es: {
        sopInstanceUid: selectedInstance.sopInstanceUid,
        frameIndex: esFrame,
        slot: 'a4c_es',
        pointsPx: makeChamber(selectedInstance.columns * 0.102),
      },
      a2c_ed: {
        sopInstanceUid: selectedInstance.sopInstanceUid,
        frameIndex: 0,
        slot: 'a2c_ed',
        pointsPx: makeChamber(selectedInstance.columns * 0.136),
      },
      a2c_es: {
        sopInstanceUid: selectedInstance.sopInstanceUid,
        frameIndex: esFrame,
        slot: 'a2c_es',
        pointsPx: makeChamber(selectedInstance.columns * 0.098),
      },
    });
    setFrameIndex(0);
    setRevision((r) => r + 1);
  }, [selectedInstance]);

  // Domain calculations strictly via spike/domain-ts
  const bsaBasis = useMemo(
    () =>
      resolveBsaBasis({
        heightCm: parseNumInput(heightInput),
        weightKg: parseNumInput(weightInput),
        manualBsaM2: parseNumInput(manualBsaInput),
      }),
    [heightInput, weightInput, manualBsaInput],
  );

  const caliperInputs = useMemo<LinearCaliperInput[]>(() => {
    const out: LinearCaliperInput[] = [];
    for (const m of linearMeasurements) {
      const inst = instances[m.sopInstanceUid];
      const manualMm = manualCalibrations[m.sopInstanceUid];
      const sp =
        manualMm !== undefined
          ? ([manualMm, manualMm] as const)
          : (inst?.pixelSpacing?.spacingMm ?? null);
      const dist = measureLinearDistance(m.p1, m.p2, sp);
      out.push({
        label: m.role,
        millimeterLength: dist.millimeterLength,
      });
    }
    return out;
  }, [linearMeasurements, instances, manualCalibrations]);

  const roleDistanceCm = useMemo(() => {
    const out: Partial<Record<CaliperRole, number>> = {};
    for (const item of caliperInputs) {
      if (item.millimeterLength !== null) {
        out[item.label as CaliperRole] = item.millimeterLength / 10.0;
      }
    }
    return out;
  }, [caliperInputs]);

  const teichholz = useMemo(
    () => teichholzFromLinearMeasurements(caliperInputs),
    [caliperInputs],
  );

  const fsPct = useMemo(
    () => fractionalShorteningPercent(roleDistanceCm.LVEDD ?? null, roleDistanceCm.LVESD ?? null),
    [roleDistanceCm.LVEDD, roleDistanceCm.LVESD],
  );

  const lvmG = useMemo(() => lvmFromLinearMeasurements(caliperInputs), [caliperInputs]);
  const lvmiGPerM2 = useMemo(() => indexedToBsa(lvmG, bsaBasis.value), [lvmG, bsaBasis.value]);
  const rwtVal = useMemo(() => rwtFromLinearMeasurements(caliperInputs), [caliperInputs]);

  const simpson = useMemo(() => {
    const inputs: SimpsonContourInput[] = [];
    let refSpacing: readonly [number, number] | null = effectiveCalibration?.spacingMm ?? null;
    for (const rec of Object.values(simpsonContours)) {
      if (!rec) continue;
      const ci = recordToContourInput(rec);
      if (ci) inputs.push(ci);
      if (!refSpacing) {
        const inst = instances[rec.sopInstanceUid];
        const manualMm = manualCalibrations[rec.sopInstanceUid];
        refSpacing =
          manualMm !== undefined
            ? ([manualMm, manualMm] as const)
            : (inst?.pixelSpacing?.spacingMm ?? null);
      }
    }
    return calculateSimpsonLvef(inputs, refSpacing);
  }, [simpsonContours, effectiveCalibration, instances, manualCalibrations]);

  const hemodynamics = useMemo(() => {
    const lvotDiamCm = roleDistanceCm.LVOTd ?? 2.1;
    const lvotVti = parseNumInput(lvotVtiInput);
    const avVti = parseNumInput(avVtiInput);
    const hr = parseNumInput(hrInput);
    const area = lvotAreaCm2(lvotDiamCm);
    const sv = strokeVolumeMl(area, lvotVti);
    const co = cardiacOutputLMin(sv, hr);
    const ava = avaContinuityCm2(area, lvotVti, avVti);
    const avai = indexedToBsa(ava, bsaBasis.value);
    const dvi = dimensionlessIndex(lvotVti, avVti);
    const avPg = pressureGradientMmHg(parseNumInput(avVmaxInput));
    return { area, sv, co, ava, avai, dvi, avPg };
  }, [roleDistanceCm.LVOTd, lvotVtiInput, avVtiInput, hrInput, avVmaxInput, bsaBasis.value]);

  const handleExportSession = () => {
    const payload: ExportedSessionV1 = {
      schemaVersion: 1,
      revision,
      exportedAt: new Date().toISOString(),
      patientContext: {
        heightCm: parseNumInput(heightInput),
        weightKg: parseNumInput(weightInput),
        manualBsaM2: parseNumInput(manualBsaInput),
        lvotVtiCm: parseNumInput(lvotVtiInput),
        avVtiCm: parseNumInput(avVtiInput),
        avVmaxCmPerSec: parseNumInput(avVmaxInput),
        heartRateBpm: parseNumInput(hrInput),
      },
      manualCalibrationsMmPerPx: manualCalibrations,
      linearMeasurements,
      simpsonContours,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sonoforge-session-v1-rev${revision}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSession = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const parsed = JSON.parse(text) as ExportedSessionV1;
    if (parsed.schemaVersion !== 1) return;
    setRevision(parsed.revision + 1);
    setManualCalibrations(parsed.manualCalibrationsMmPerPx ?? {});
    setLinearMeasurements([...(parsed.linearMeasurements ?? [])]);
    setSimpsonContours(parsed.simpsonContours ?? {});
    if (parsed.patientContext.heightCm !== null)
      setHeightInput(String(parsed.patientContext.heightCm));
    if (parsed.patientContext.weightKg !== null)
      setWeightInput(String(parsed.patientContext.weightKg));
    setManualBsaInput(
      parsed.patientContext.manualBsaM2 !== null
        ? String(parsed.patientContext.manualBsaM2)
        : '',
    );
  };

  return (
    <div
      className="app-shell"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void handleLocalFileList(e.dataTransfer.files);
      }}
    >
      <div className="disclaimer-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="disclaimer-pill">{t.disclaimerPill}</span>
          <span>{t.disclaimerText}</span>
        </div>
        <div className="toolbar-group">
          <label
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={hidePhi}
              onChange={(e) => setHidePhi(e.target.checked)}
            />
            <span>{t.hidePhi}</span>
          </label>
          <button
            type="button"
            className={lang === 'ru' ? 'active' : ''}
            onClick={() => setLang('ru')}
          >
            RU
          </button>
          <button
            type="button"
            className={lang === 'en' ? 'active' : ''}
            onClick={() => setLang('en')}
          >
            EN
          </button>
        </div>
      </div>

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">SF</div>
          <div>
            <div className="brand-title">SonoForge Web · Stage 0 Spike</div>
            <div className="brand-sub">
              dicom-parser + WASM Codecs (Web Worker) · TypeScript Domain Parity (39/39 Golden
              Vectors)
            </div>
          </div>
        </div>

        <div className="toolbar-group">
          <button type="button" className="primary" onClick={() => void handleLoadSamples()}>
            {t.loadSamples}
          </button>
          <label className="btn-label">
            {t.openFiles}
            <input
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => void handleLocalFileList(e.target.files)}
            />
          </label>
          <label className="btn-label">
            {t.openFolder}
            <input
              type="file"
              multiple
              // @ts-expect-error webkitdirectory is standard across desktop browsers
              webkitdirectory="true"
              style={{ display: 'none' }}
              onChange={(e) => void handleLocalFileList(e.target.files)}
            />
          </label>
          <button type="button" onClick={() => void handleRunBrowserBench()}>
            {t.runBench}
          </button>
          {activeRequestId !== null && (
            <button
              type="button"
              className="danger"
              onClick={() =>
                postWorker({
                  id: reqSeqRef.current++,
                  type: 'cancelTask',
                  targetRequestId: activeRequestId,
                })
              }
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setIsPlaying(false);
              setStudies([]);
              setInstances({});
              setSelectedSopUid(null);
              setLinearMeasurements([]);
              setSimpsonContours({});
              postWorker({ id: reqSeqRef.current++, type: 'clearAll' });
            }}
          >
            {t.clearSession}
          </button>
        </div>
      </header>

      <main className="workspace-grid">
        {/* LEFT: Study & Series Browser */}
        <aside className="panel panel-left">
          <div className="panel-header">
            <span>{t.studiesHeader}</span>
            <span className="badge">{Object.keys(instances).length} SOP</span>
          </div>
          <div className="panel-scroll">
            {studies.length === 0 ? (
              <div style={{ color: 'var(--text-2)', lineHeight: 1.5, padding: 8 }}>
                {t.noStudies}
              </div>
            ) : (
              studies.map((st) => (
                <div key={st.studyInstanceUid} className="study-card">
                  <div className="study-header">
                    <div>{st.description}</div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-2)', marginTop: 2 }}>
                      {st.studyDate || '—'} · {st.series.length} series
                    </div>
                  </div>
                  {st.series.map((ser) =>
                    ser.instances.map((instRef) => {
                      const inst = instances[instRef.sopInstanceUid];
                      if (!inst) return null;
                      const isSel = inst.sopInstanceUid === selectedSopUid;
                      const cal = manualCalibrations[inst.sopInstanceUid]
                        ? 'manual_ruler'
                        : (inst.pixelSpacing?.source ?? 'uncalibrated');
                      return (
                        <button
                          key={inst.sopInstanceUid}
                          type="button"
                          className={`instance-item ${isSel ? 'selected' : ''}`}
                          onClick={() => {
                            setIsPlaying(false);
                            setSelectedSopUid(inst.sopInstanceUid);
                            setFrameIndex(0);
                            setWindowCenter(
                              inst.windowCenter ?? (inst.bitsStored === 12 ? 2048 : 128),
                            );
                            setWindowWidth(
                              inst.windowWidth ?? (inst.bitsStored === 12 ? 4095 : 255),
                            );
                          }}
                        >
                          <div style={{ fontWeight: 600, fontSize: 11.5 }}>{inst.fileName}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--text-2)' }}>
                            {inst.manufacturer || 'Unknown'} · {inst.columns}×{inst.rows} ·{' '}
                            {inst.numberOfFrames}f
                          </div>
                          <div className="badge-row">
                            <span
                              className={`badge ${
                                !inst.transferSyntax.supportedInBrowser
                                  ? 'err'
                                  : inst.transferSyntax.lossless
                                    ? 'ok'
                                    : 'warn'
                              }`}
                            >
                              {inst.transferSyntax.supportedInBrowser
                                ? inst.transferSyntax.lossless
                                  ? 'Lossless'
                                  : 'Lossy'
                                : 'Unsupported'}
                            </span>
                            <span className={`badge ${cal === 'uncalibrated' ? 'warn' : ''}`}>
                              {cal}
                            </span>
                          </div>
                        </button>
                      );
                    }),
                  )}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* CENTER: Echo 2D / Cine Viewport + Measurement Overlay */}
        <section className="viewport-area">
          <div className="viewport-toolbar">
            <div className="toolbar-group">
              <button
                type="button"
                className={toolMode === 'pan' ? 'active' : ''}
                onClick={() => {
                  setToolMode('pan');
                  setDraftPoints([]);
                }}
              >
                {t.toolPan}
              </button>
              <button
                type="button"
                className={toolMode === 'caliper' ? 'active' : ''}
                onClick={() => {
                  setToolMode('caliper');
                  setDraftPoints([]);
                }}
              >
                {t.toolCaliper}
              </button>
              {toolMode === 'caliper' && (
                <select
                  value={caliperRole}
                  onChange={(e) => setCaliperRole(e.target.value as CaliperRole)}
                >
                  <option value="LVEDD">LVEDD</option>
                  <option value="LVESD">LVESD</option>
                  <option value="IVSd">IVSd</option>
                  <option value="LVPWd">LVPWd</option>
                  <option value="LVOTd">LVOTd</option>
                  <option value="Free">Free</option>
                </select>
              )}
              <button
                type="button"
                className={toolMode === 'simpson' ? 'active' : ''}
                onClick={() => {
                  setToolMode('simpson');
                  setDraftPoints([]);
                }}
              >
                {t.toolSimpson}
              </button>
              {toolMode === 'simpson' && (
                <>
                  <select
                    value={simpsonSlot}
                    onChange={(e) => setSimpsonSlot(e.target.value as SimpsonSlot)}
                  >
                    <option value="a4c_ed">A4C ED</option>
                    <option value="a4c_es">A4C ES</option>
                    <option value="a2c_ed">A2C ED</option>
                    <option value="a2c_es">A2C ES</option>
                  </select>
                  <button
                    type="button"
                    className="primary"
                    disabled={draftPoints.length < 5}
                    onClick={handleFinishSimpson}
                  >
                    {t.finishContour} ({draftPoints.length})
                  </button>
                </>
              )}
              <button
                type="button"
                className={toolMode === 'ruler' ? 'active' : ''}
                onClick={() => {
                  setToolMode('ruler');
                  setDraftPoints([]);
                }}
              >
                {t.toolRuler}
              </button>
              {toolMode === 'ruler' && (
                <input
                  type="number"
                  style={{ width: 68 }}
                  value={rulerKnownMm}
                  onChange={(e) => setRulerKnownMm(e.target.value)}
                  title="Known ruler distance in mm"
                />
              )}
              <button
                type="button"
                disabled={!selectedInstance}
                onClick={handlePopulateDemoSimpson}
              >
                {t.demoSimpson}
              </button>
            </div>

            <div className="toolbar-group">
              <span style={{ fontSize: 11, color: 'var(--text-2)' }}>W/L:</span>
              <input
                type="number"
                style={{ width: 62 }}
                value={Math.round(windowWidth)}
                onChange={(e) => setWindowWidth(Math.max(1, Number(e.target.value) || 255))}
                title="Window Width"
              />
              <input
                type="number"
                style={{ width: 62 }}
                value={Math.round(windowCenter)}
                onChange={(e) => setWindowCenter(Number(e.target.value) || 128)}
                title="Window Center"
              />
              <button
                type="button"
                disabled={!selectedInstance}
                onClick={() => {
                  setZoom(0.92);
                  setPanCss({ x: 0, y: 0 });
                }}
              >
                {t.fitView}
              </button>
            </div>
          </div>

          <div
            ref={stageRef}
            className="canvas-stage"
            onWheel={(e) => {
              if (!selectedInstance) return;
              e.preventDefault();
              const factor = e.deltaY < 0 ? 1.12 : 0.89;
              setZoom((prev) => Math.max(0.2, Math.min(12, prev * factor)));
            }}
          >
            <canvas ref={imageCanvasRef} className="canvas-layer" />
            <canvas
              ref={overlayCanvasRef}
              className="canvas-layer"
              style={{ cursor: toolMode === 'pan' ? 'grab' : 'crosshair' }}
              onMouseDown={handleCanvasMouseDown}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={handleCanvasMouseUp}
              onDoubleClick={() => {
                if (toolMode === 'simpson' && draftPoints.length >= 5) {
                  handleFinishSimpson();
                }
              }}
            />

            {selectedInstance && !viewportError && (
              <>
                <div className="hud-overlay">
                  <div>
                    {selectedInstance.manufacturer || 'Vendor'} ·{' '}
                    {selectedInstance.modelName || 'US'}
                  </div>
                  <div>
                    {selectedInstance.columns}×{selectedInstance.rows} ·{' '}
                    {selectedInstance.photometricInterpretation} ({selectedInstance.bitsStored}-bit)
                  </div>
                  <div>
                    Frame {frameIndex + 1} / {selectedInstance.numberOfFrames} · Zoom{' '}
                    {(zoom * 100).toFixed(0)}%
                  </div>
                </div>
                <div className="hud-overlay-right">
                  <div>{selectedInstance.transferSyntax.name}</div>
                  <div>
                    {effectiveCalibration
                      ? `${effectiveCalibration.spacingMm[0].toFixed(4)} mm/px (${effectiveCalibration.source})`
                      : 'UNCALIBRATED — px only (use Calibrate mm)'}
                  </div>
                  {lastDecodeInfo && (
                    <div>
                      {lastDecodeInfo.decoderId} ·{' '}
                      {lastDecodeInfo.fromCache
                        ? `cache hit (+${lastDecodeInfo.renderMs}ms W/L)`
                        : `${lastDecodeInfo.decodeMs}ms decode + ${lastDecodeInfo.renderMs}ms W/L`}
                    </div>
                  )}
                </div>
              </>
            )}

            {viewportError && (
              <div className="error-card">
                <div style={{ fontWeight: 700, color: 'var(--rose)', fontSize: 14 }}>
                  Unsupported Transfer Syntax — Session Protected
                </div>
                <div style={{ color: 'var(--text-1)', lineHeight: 1.45 }}>
                  {viewportError.message}
                </div>
                {viewportError.fallback && (
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 6,
                      background: 'var(--bg-1)',
                      border: '1px solid var(--border)',
                      color: 'var(--accent)',
                      fontSize: 12,
                      lineHeight: 1.45,
                    }}
                  >
                    <strong>Stage 0 Explicit Fallback Strategy:</strong> {viewportError.fallback}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="cine-bar">
            <button
              type="button"
              disabled={!selectedInstance || selectedInstance.numberOfFrames <= 1}
              onClick={() => setIsPlaying((p) => !p)}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>
            <button
              type="button"
              disabled={!selectedInstance || selectedInstance.numberOfFrames <= 1}
              onClick={() => {
                if (!selectedInstance) return;
                setIsPlaying(false);
                setFrameIndex(
                  (f) =>
                    (f - 1 + selectedInstance.numberOfFrames) % selectedInstance.numberOfFrames,
                );
              }}
            >
              ⏮
            </button>
            <input
              type="range"
              className="cine-slider"
              min={0}
              max={Math.max(0, (selectedInstance?.numberOfFrames ?? 1) - 1)}
              value={frameIndex}
              disabled={!selectedInstance || selectedInstance.numberOfFrames <= 1}
              onChange={(e) => {
                setIsPlaying(false);
                setFrameIndex(Number(e.target.value));
              }}
            />
            <button
              type="button"
              disabled={!selectedInstance || selectedInstance.numberOfFrames <= 1}
              onClick={() => {
                if (!selectedInstance) return;
                setIsPlaying(false);
                setFrameIndex((f) => (f + 1) % selectedInstance.numberOfFrames);
              }}
            >
              ⏭
            </button>
            <select
              value={String(playbackSpeed)}
              onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
            >
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1">1.0×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2.0×</option>
            </select>
          </div>
        </section>

        {/* RIGHT: Domain Calculations / Metadata / Browser Benchmark */}
        <aside className="panel panel-right">
          <div className="tabs">
            <button
              type="button"
              className={`tab-btn ${rightTab === 'calc' ? 'active' : ''}`}
              onClick={() => setRightTab('calc')}
            >
              {t.tabCalc}
            </button>
            <button
              type="button"
              className={`tab-btn ${rightTab === 'meta' ? 'active' : ''}`}
              onClick={() => setRightTab('meta')}
            >
              {t.tabMeta}
            </button>
            <button
              type="button"
              className={`tab-btn ${rightTab === 'bench' ? 'active' : ''}`}
              onClick={() => setRightTab('bench')}
            >
              {t.tabBench}
            </button>
          </div>

          <div className="panel-scroll">
            {rightTab === 'calc' && (
              <>
                <div className="metric-section">
                  <div className="metric-section-title">
                    <span>BSA (Du Bois) & Anthropometry</span>
                    <span className="badge ok">source: {bsaBasis.source}</span>
                  </div>
                  <div className="input-grid">
                    <div className="field">
                      <label>Height (cm)</label>
                      <input
                        type="number"
                        value={heightInput}
                        onChange={(e) => setHeightInput(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>Weight (kg)</label>
                      <input
                        type="number"
                        value={weightInput}
                        onChange={(e) => setWeightInput(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>Manual BSA override (m²)</label>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="auto"
                        value={manualBsaInput}
                        onChange={(e) => setManualBsaInput(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>Effective BSA</label>
                      <input type="text" readOnly value={fmt(bsaBasis.value, 2, 'm²')} />
                    </div>
                  </div>
                </div>

                <div className="metric-section">
                  <div className="metric-section-title">
                    <span>LV Linear · Teichholz · ASE Cube LVM</span>
                    <span className="badge">{linearMeasurements.length} calipers</span>
                  </div>
                  <div className="kv-grid">
                    <span className="kv-key">LVEDD / LVESD</span>
                    <span className="kv-val">
                      {fmt(roleDistanceCm.LVEDD, 2, 'cm')} / {fmt(roleDistanceCm.LVESD, 2, 'cm')}
                    </span>
                    <span className="kv-key">Teichholz EDV / ESV</span>
                    <span className="kv-val">
                      {fmt(teichholz?.edvMl, 1, 'mL')} / {fmt(teichholz?.esvMl, 1, 'mL')}
                    </span>
                    <span className="kv-key">Teichholz LVEF / FS</span>
                    <span className="kv-val">
                      {fmt(teichholz?.lvefPercent, 1, '%')} / {fmt(fsPct, 1, '%')}
                    </span>
                    <span className="kv-key">ASE LV Mass / LVMI</span>
                    <span className="kv-val">
                      {fmt(lvmG, 1, 'g')} / {fmt(lvmiGPerM2, 1, 'g/m²')}
                    </span>
                    <span className="kv-key">Relative Wall Thickness (RWT)</span>
                    <span className="kv-val">{fmt(rwtVal, 2)}</span>
                  </div>

                  {linearMeasurements.length > 0 && (
                    <div className="meas-list">
                      {linearMeasurements.map((m) => {
                        const inst = instances[m.sopInstanceUid];
                        const manualMm = manualCalibrations[m.sopInstanceUid];
                        const sp =
                          manualMm !== undefined
                            ? ([manualMm, manualMm] as const)
                            : (inst?.pixelSpacing?.spacingMm ?? null);
                        const d = measureLinearDistance(m.p1, m.p2, sp);
                        return (
                          <div key={m.id} className="meas-row">
                            <span>
                              <strong>{m.role}</strong> (f{m.frameIndex + 1}):{' '}
                              {d.millimeterLength !== null
                                ? `${d.millimeterLength.toFixed(1)} mm`
                                : `${d.pixelLength.toFixed(1)} px`}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setLinearMeasurements((prev) =>
                                  prev.filter((item) => item.id !== m.id),
                                )
                              }
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="metric-section">
                  <div className="metric-section-title">
                    <span>Simpson 20-Disk (Monoplane / Biplane)</span>
                    <span className="badge">{simpson?.method ?? 'awaiting traces'}</span>
                  </div>
                  <div className="kv-grid">
                    <span className="kv-key">A4C EDV / ESV</span>
                    <span className="kv-val">
                      {fmt(simpson?.a4c?.edvMl, 1, 'mL')} / {fmt(simpson?.a4c?.esvMl, 1, 'mL')}
                    </span>
                    <span className="kv-key">A2C EDV / ESV</span>
                    <span className="kv-val">
                      {fmt(simpson?.a2c?.edvMl, 1, 'mL')} / {fmt(simpson?.a2c?.esvMl, 1, 'mL')}
                    </span>
                    <span className="kv-key">Biplane EDV / ESV</span>
                    <span className="kv-val">
                      {fmt(simpson?.edvBiMl, 1, 'mL')} / {fmt(simpson?.esvBiMl, 1, 'mL')}
                    </span>
                    <span className="kv-key">Simpson SV / LVEF</span>
                    <span className="kv-val">
                      {fmt(simpson?.svMl, 1, 'mL')} / {fmt(simpson?.lvefPercent, 1, '%')}
                    </span>
                  </div>
                </div>

                <div className="metric-section">
                  <div className="metric-section-title">
                    <span>Continuity & Modified Bernoulli (4V²)</span>
                  </div>
                  <div className="input-grid" style={{ marginBottom: 8 }}>
                    <div className="field">
                      <label>LVOT VTI (cm)</label>
                      <input
                        type="number"
                        step="0.5"
                        value={lvotVtiInput}
                        onChange={(e) => setLvotVtiInput(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>AV VTI (cm)</label>
                      <input
                        type="number"
                        step="0.5"
                        value={avVtiInput}
                        onChange={(e) => setAvVtiInput(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>AV Vmax (cm/s)</label>
                      <input
                        type="number"
                        value={avVmaxInput}
                        onChange={(e) => setAvVmaxInput(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label>Heart Rate (bpm)</label>
                      <input
                        type="number"
                        value={hrInput}
                        onChange={(e) => setHrInput(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="kv-grid">
                    <span className="kv-key">LVOT Area / SV</span>
                    <span className="kv-val">
                      {fmt(hemodynamics.area, 2, 'cm²')} / {fmt(hemodynamics.sv, 1, 'mL')}
                    </span>
                    <span className="kv-key">AVA / AVAi</span>
                    <span className="kv-val">
                      {fmt(hemodynamics.ava, 2, 'cm²')} / {fmt(hemodynamics.avai, 2, 'cm²/m²')}
                    </span>
                    <span className="kv-key">DVI / Cardiac Output</span>
                    <span className="kv-val">
                      {fmt(hemodynamics.dvi, 2)} / {fmt(hemodynamics.co, 2, 'L/min')}
                    </span>
                    <span className="kv-key">AV Peak Gradient (4V²)</span>
                    <span className="kv-val">{fmt(hemodynamics.avPg, 1, 'mmHg')}</span>
                  </div>
                </div>

                <div className="toolbar-group">
                  <button type="button" onClick={handleExportSession}>
                    {t.exportJson} (rev {revision})
                  </button>
                  <label className="btn-label">
                    {t.importJson}
                    <input
                      type="file"
                      accept="application/json"
                      style={{ display: 'none' }}
                      onChange={(e) => void handleImportSession(e.target.files?.[0])}
                    />
                  </label>
                </div>
              </>
            )}

            {rightTab === 'meta' && (
              <div className="metric-section">
                <div className="metric-section-title">
                  <span>DICOM Header & Calibration</span>
                  <span className={`badge ${hidePhi ? 'ok' : 'warn'}`}>
                    {hidePhi ? 'PHI Redacted' : 'PHI Visible'}
                  </span>
                </div>
                {!selectedInstance ? (
                  <div style={{ color: 'var(--text-2)' }}>Select an instance on the left.</div>
                ) : (
                  <div className="kv-grid">
                    <span className="kv-key">Patient Name</span>
                    <span className="kv-val">
                      {hidePhi ? '[REDACTED]' : selectedInstance.phi.patientName || '—'}
                    </span>
                    <span className="kv-key">Patient ID</span>
                    <span className="kv-val">
                      {hidePhi ? '[REDACTED]' : selectedInstance.phi.patientId || '—'}
                    </span>
                    <span className="kv-key">Institution</span>
                    <span className="kv-val">
                      {hidePhi ? '[REDACTED]' : selectedInstance.phi.institutionName || '—'}
                    </span>
                    <span className="kv-key">Modality / Mode</span>
                    <span className="kv-val">
                      {selectedInstance.modality} / {selectedInstance.clipMode}
                    </span>
                    <span className="kv-key">Transfer Syntax UID</span>
                    <span className="kv-val">{selectedInstance.transferSyntax.uid}</span>
                    <span className="kv-key">Syntax Name</span>
                    <span className="kv-val">{selectedInstance.transferSyntax.name}</span>
                    <span className="kv-key">Dimensions</span>
                    <span className="kv-val">
                      {selectedInstance.columns}×{selectedInstance.rows}×
                      {selectedInstance.numberOfFrames}
                    </span>
                    <span className="kv-key">Photometric</span>
                    <span className="kv-val">{selectedInstance.photometricInterpretation}</span>
                    <span className="kv-key">Calibration Source</span>
                    <span className="kv-val">{effectiveCalibration?.source ?? 'uncalibrated'}</span>
                    <span className="kv-key">Spacing [row, col]</span>
                    <span className="kv-val">
                      {effectiveCalibration
                        ? `${effectiveCalibration.spacingMm[0].toFixed(4)}, ${effectiveCalibration.spacingMm[1].toFixed(4)} mm`
                        : 'px only'}
                    </span>
                  </div>
                )}
              </div>
            )}

            {rightTab === 'bench' && (
              <div className="metric-section">
                <div className="metric-section-title">
                  <span>In-Browser Worker Codec Benchmark</span>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void handleRunBrowserBench()}
                  >
                    Run
                  </button>
                </div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <label>Worker LRU Frame Cache Budget (MiB)</label>
                  <input
                    type="number"
                    value={cacheBudgetMiB}
                    onChange={(e) => {
                      const v = Math.max(8, Number(e.target.value) || 96);
                      setCacheBudgetMiB(v);
                      postWorker({
                        id: reqSeqRef.current++,
                        type: 'setCacheBudgetMiB',
                        budgetMiB: v,
                      });
                    }}
                  />
                </div>
                {benchRows.length === 0 ? (
                  <div style={{ color: 'var(--text-2)', lineHeight: 1.5 }}>
                    Click <strong>Run</strong> to benchmark all 11 synthetic ultrasound transfer
                    syntaxes directly inside your browser&apos;s Web Worker.
                  </div>
                ) : (
                  <table className="bench-table">
                    <thead>
                      <tr>
                        <th>Fixture</th>
                        <th>Decoder</th>
                        <th>Warm ms</th>
                        <th>FPS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {benchRows.map((r) => (
                        <tr key={r.fileName}>
                          <td title={r.transferSyntaxName}>{r.fileName.slice(0, 22)}</td>
                          <td>{r.supported ? r.decoderId : 'FALLBACK'}</td>
                          <td>{r.warmAvgMs !== null ? `${r.warmAvgMs}ms` : '—'}</td>
                          <td>{r.estimatedFps !== null ? r.estimatedFps : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </aside>
      </main>

      <footer className="statusbar">
        <div>
          Shell Cold Boot: <strong>{shellBootMs} ms</strong> · Worker Init:{' '}
          <strong>{workerInitMs !== null ? `${workerInitMs} ms` : 'lazy (not started)'}</strong>
          {lastParseMs !== null ? ` · Last Parse: ${lastParseMs} ms` : ''}
          {busyStatus ? ` · ⏳ ${busyStatus}` : ''}
        </div>
        <div>
          Worker LRU Cache:{' '}
          {cacheStats
            ? `${(cacheStats.currentBytes / 1048576).toFixed(1)} / ${(cacheStats.maxBytes / 1048576).toFixed(0)} MiB (${cacheStats.entryCount} frames, ${cacheStats.evictions} evictions, peak ${(cacheStats.highWaterMarkBytes / 1048576).toFixed(1)} MiB)`
            : '0.0 MiB'}
        </div>
      </footer>
    </div>
  );
}
