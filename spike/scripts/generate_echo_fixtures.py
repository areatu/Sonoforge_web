#!/usr/bin/env python3
"""Generate 100% synthetic, PHI-free multi-vendor echo DICOM fixtures for Stage 0 Spike.

Creates:
1. Compact committed fixtures in `spike/fixtures/` (also mirrored to `spike/web-proto/public/samples/`)
   for automated Vitest pixel-parity checks and interactive browser demo.
2. Full-scale 1280x720 (720p) 60-frame cine benchmark fixtures in `.spike-bench-data/` (gitignored)
   for measuring decode latency, achievable cine FPS, and memory footprint across codecs.

Zero patient data is read or copied: all pixel arrays are mathematically synthesized
(ultrasound sector fan, speckle texture, beating LV cavity, mitral leaflets, depth ticks).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import shutil
from pathlib import Path
from typing import Any

import gdcm
import numpy as np
import pydicom
from PIL import Image
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.pixels.encoders import (
    JPEG2000Encoder,
    JPEG2000LosslessEncoder,
    JPEGLSLosslessEncoder,
    RLELosslessEncoder,
)
from pydicom.sequence import Sequence
from pydicom.uid import (
    ExplicitVRLittleEndian,
    ImplicitVRLittleEndian,
    JPEG2000,
    JPEG2000Lossless,
    JPEGBaseline8Bit,
    JPEGLosslessSV1,
    JPEGLSLossless,
    MPEG2MPML,
    RLELossless,
    UID,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "spike" / "fixtures"
PUBLIC_SAMPLES_DIR = REPO_ROOT / "spike" / "web-proto" / "public" / "samples"
BENCH_DIR = REPO_ROOT / ".spike-bench-data"

ULTRASOUND_IMAGE_STORAGE = UID("1.2.840.10008.5.1.4.1.1.6.1")
ULTRASOUND_MULTIFRAME_STORAGE = UID("1.2.840.10008.5.1.4.1.1.3.1")


def _det_uid(seed: str) -> UID:
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    numeric = str(int(digest[:24], 16))[:26]
    return UID(f"2.25.{numeric}")


def synthesize_echo_frame(
    rows: int,
    cols: int,
    frame_index: int = 0,
    frame_count: int = 1,
    *,
    color_doppler: bool = False,
    bit_depth: int = 8,
) -> np.ndarray:
    """Synthesize a realistic-looking 2D apical 4-chamber ultrasound sector with beating LV."""
    yy, xx = np.mgrid[0:rows, 0:cols].astype(np.float32)
    apex_x = cols * 0.50
    apex_y = rows * 0.08
    dx = xx - apex_x
    dy = yy - apex_y
    r = np.hypot(dx, dy)
    theta = np.arctan2(dx, np.maximum(dy, 1e-3))

    max_r = rows * 0.88
    in_sector = (dy > rows * 0.02) & (r <= max_r) & (np.abs(theta) <= 0.68)

    # Deterministic deterministic pseudo-speckle texture (no random state drift)
    speckle = (
        np.sin(xx * 0.37 + yy * 0.23) * np.cos(xx * 0.19 - yy * 0.41) * 0.5 + 0.5
    )
    attenuation = np.clip(1.0 - (r / max_r) * 0.38, 0.25, 1.0)
    tissue = (38.0 + 72.0 * speckle) * attenuation

    # Cardiac phase: 0 = End-Diastole (largest LV cavity), 0.5 = End-Systole (smallest LV cavity)
    phase = (
        0.5 * (1.0 - math.cos(2.0 * math.pi * frame_index / max(frame_count, 1)))
        if frame_count > 1
        else 0.0
    )
    lv_rx = cols * (0.145 - 0.042 * phase)
    lv_ry = rows * (0.295 - 0.055 * phase)
    lv_cx = cols * 0.45
    lv_cy = rows * 0.46

    lv_norm = ((xx - lv_cx) / max(lv_rx, 1.0)) ** 2 + ((yy - lv_cy) / max(lv_ry, 1.0)) ** 2
    myo_norm = ((xx - lv_cx) / max(lv_rx * 1.28, 1.0)) ** 2 + (
        (yy - lv_cy) / max(lv_ry * 1.18, 1.0)
    ) ** 2

    # Bright myocardium + endocardial border, dark blood pool
    img = np.where(in_sector, tissue, 0.0)
    img = np.where(in_sector & (myo_norm <= 1.0) & (lv_norm > 1.0), img + 88.0, img)
    img = np.where(in_sector & (np.abs(lv_norm - 1.0) < 0.09), 225.0, img)
    img = np.where(in_sector & (lv_norm <= 0.94), 12.0 + 8.0 * speckle, img)

    # Left atrium below mitral plane
    la_cx = cols * 0.46
    la_cy = rows * 0.76
    la_norm = ((xx - la_cx) / max(cols * 0.11, 1.0)) ** 2 + (
        (yy - la_cy) / max(rows * 0.11, 1.0)
    ) ** 2
    img = np.where(in_sector & (la_norm <= 1.0), 14.0 + 7.0 * speckle, img)

    # Mitral annulus bright hinge points
    ann_y = rows * 0.65
    for ann_x in (lv_cx - lv_rx * 0.82, lv_cx + lv_rx * 0.82):
        hinge = (xx - ann_x) ** 2 + (yy - ann_y) ** 2 <= max(3.0, (cols * 0.012) ** 2)
        img = np.where(hinge, 248.0, img)

    # Right-side depth ruler ticks every 10% of height
    ruler_x = int(cols * 0.94)
    if ruler_x + 4 < cols:
        for tick_idx in range(1, 10):
            ty = int(rows * 0.08 + (rows * 0.80) * (tick_idx / 10.0))
            if 0 <= ty < rows:
                img[ty, ruler_x : min(cols, ruler_x + (6 if tick_idx % 2 == 0 else 3))] = 210.0

    # Deterministic per-frame calibration marker in corner (0, 0..3)
    img[0, 0] = float((frame_index * 13 + 17) % 250)

    if bit_depth == 16:
        scaled = np.clip(img * 16.0, 0, 4095).astype(np.uint16)
        return scaled

    gray = np.clip(np.rint(img), 0, 255).astype(np.uint8)
    if not color_doppler:
        return gray

    rgb = np.stack([gray, gray, gray], axis=-1)
    # Synthesize color Doppler jet across mitral inflow / LV cavity
    jet_rx = lv_rx * 0.58
    jet_ry = lv_ry * 0.65
    jet_norm = ((xx - lv_cx) / max(jet_rx, 1.0)) ** 2 + (
        (yy - (lv_cy + rows * 0.06)) / max(jet_ry, 1.0)
    ) ** 2
    in_jet = in_sector & (jet_norm < 1.0)
    velocity = np.sin((yy - lv_cy) * 0.12 + phase * math.pi * 2.0)
    red_mask = in_jet & (velocity >= 0)
    blue_mask = in_jet & (velocity < 0)
    rgb[red_mask, 0] = np.clip(150 + np.abs(velocity[red_mask]) * 100, 0, 255).astype(np.uint8)
    rgb[red_mask, 1] = np.clip(55 + np.abs(velocity[red_mask]) * 60, 0, 255).astype(np.uint8)
    rgb[red_mask, 2] = 20
    rgb[blue_mask, 0] = 20
    rgb[blue_mask, 1] = np.clip(80 + np.abs(velocity[blue_mask]) * 85, 0, 255).astype(np.uint8)
    rgb[blue_mask, 2] = np.clip(165 + np.abs(velocity[blue_mask]) * 88, 0, 255).astype(np.uint8)
    return rgb


def _base_dataset(
    *,
    key: str,
    transfer_syntax: UID,
    study_key: str,
    series_description: str,
    manufacturer: str,
    model_name: str,
    rows: int,
    cols: int,
    frame_count: int,
    samples_per_pixel: int = 1,
    photometric: str = "MONOCHROME2",
    bits_allocated: int = 8,
    bits_stored: int = 8,
    pixel_spacing_mm: tuple[float, float] | None = (0.30, 0.30),
    us_region_cm: tuple[float, float] | None = None,
    include_color_region: bool = False,
    frame_time_ms: float | None = 33.33,
) -> FileDataset:
    sop_class = ULTRASOUND_MULTIFRAME_STORAGE if frame_count > 1 else ULTRASOUND_IMAGE_STORAGE
    study_uid = _det_uid(f"study:{study_key}")
    series_uid = _det_uid(f"series:{key}")
    sop_uid = _det_uid(f"sop:{key}")

    file_meta = FileMetaDataset()
    file_meta.FileMetaInformationVersion = b"\x00\x01"
    file_meta.MediaStorageSOPClassUID = sop_class
    file_meta.MediaStorageSOPInstanceUID = sop_uid
    file_meta.TransferSyntaxUID = transfer_syntax
    file_meta.ImplementationClassUID = _det_uid("impl:sonoforge-web-spike")
    file_meta.ImplementationVersionName = "SFWEB_SPIKE_0"

    ds = FileDataset(None, {}, file_meta=file_meta, preamble=b"\x00" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = transfer_syntax == ImplicitVRLittleEndian

    ds.SOPClassUID = sop_class
    ds.SOPInstanceUID = sop_uid
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.Modality = "US"
    ds.Manufacturer = manufacturer
    ds.ManufacturerModelName = model_name
    ds.InstitutionName = "SYNTHETIC_ECHO_LAB"
    ds.PatientName = "SYNTHETIC^ECHO^PHANTOM"
    ds.PatientID = f"SYN-{study_key.upper()}"
    ds.PatientBirthDate = "19800101"
    ds.PatientSex = "O"
    ds.PatientSize = 1.76
    ds.PatientWeight = 74.0
    ds.HeartRate = 68
    ds.StudyDate = "20261026"
    ds.StudyTime = "120000"
    ds.StudyDescription = f"Synthetic Echo Study ({study_key})"
    ds.SeriesDescription = series_description
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    ds.ImageType = ["DERIVED", "PRIMARY", "CARDIAC"]

    ds.SamplesPerPixel = samples_per_pixel
    ds.PhotometricInterpretation = photometric
    if samples_per_pixel > 1:
        ds.PlanarConfiguration = 0
    ds.Rows = rows
    ds.Columns = cols
    ds.BitsAllocated = bits_allocated
    ds.BitsStored = bits_stored
    ds.HighBit = bits_stored - 1
    ds.PixelRepresentation = 0
    if frame_count > 1:
        ds.NumberOfFrames = frame_count
        if frame_time_ms is not None:
            ds.FrameTime = round(frame_time_ms, 2)
            ds.CineRate = int(round(1000.0 / frame_time_ms))

    if pixel_spacing_mm is not None:
        ds.PixelSpacing = [float(pixel_spacing_mm[0]), float(pixel_spacing_mm[1])]

    if us_region_cm is not None:
        regions = []
        r2d = Dataset()
        r2d.RegionSpatialFormat = 1  # 2D tissue
        r2d.RegionDataType = 1  # Tissue
        r2d.RegionFlags = 0
        r2d.RegionLocationMinX0 = 0
        r2d.RegionLocationMinY0 = 0
        r2d.RegionLocationMaxX1 = cols - 1
        r2d.RegionLocationMaxY1 = rows - 1
        r2d.PhysicalUnitsXDirection = 3  # cm
        r2d.PhysicalUnitsYDirection = 3  # cm
        r2d.PhysicalDeltaX = float(us_region_cm[1])
        r2d.PhysicalDeltaY = float(us_region_cm[0])
        regions.append(r2d)

        if include_color_region:
            rcf = Dataset()
            rcf.RegionSpatialFormat = 1
            rcf.RegionDataType = 2  # Color Flow
            rcf.RegionFlags = 1
            rcf.RegionLocationMinX0 = int(cols * 0.25)
            rcf.RegionLocationMinY0 = int(rows * 0.20)
            rcf.RegionLocationMaxX1 = int(cols * 0.75)
            rcf.RegionLocationMaxY1 = int(rows * 0.80)
            rcf.PhysicalUnitsXDirection = 3
            rcf.PhysicalUnitsYDirection = 3
            rcf.PhysicalDeltaX = float(us_region_cm[1])
            rcf.PhysicalDeltaY = float(us_region_cm[0])
            regions.append(rcf)
        ds.SequenceOfUltrasoundRegions = Sequence(regions)

    return ds


def _transcode_with_gdcm(src_path: Path, dst_path: Path, ts_type: Any) -> None:
    reader = gdcm.ImageReader()
    reader.SetFileName(str(src_path))
    if not reader.Read():
        raise RuntimeError(f"GDCM failed reading {src_path}")
    change = gdcm.ImageChangeTransferSyntax()
    change.SetTransferSyntax(gdcm.TransferSyntax(ts_type))
    change.SetInput(reader.GetImage())
    if not change.Change():
        raise RuntimeError(f"GDCM failed transcoding {src_path} -> {ts_type}")
    writer = gdcm.ImageWriter()
    writer.SetFileName(str(dst_path))
    writer.SetFile(reader.GetFile())
    writer.SetImage(change.GetOutput())
    if not writer.Write():
        raise RuntimeError(f"GDCM failed writing {dst_path}")


def _encode_jpeg_frames(
    frames: list[np.ndarray], *, ybr422: bool = False, quality: int = 90
) -> bytes:
    blobs: list[bytes] = []
    for frame in frames:
        buf = io.BytesIO()
        if frame.ndim == 2:
            Image.fromarray(frame, mode="L").save(buf, format="JPEG", quality=quality)
        elif ybr422:
            # PIL encodes RGB -> YCbCr 4:2:2 baseline JPEG when subsampling=1 ("4:2:2")
            Image.fromarray(frame, mode="RGB").save(
                buf, format="JPEG", quality=quality, subsampling=1
            )
        else:
            Image.fromarray(frame, mode="RGB").convert("YCbCr").save(
                buf, format="JPEG", quality=quality, subsampling=0
            )
        blobs.append(buf.getvalue())
    return encapsulate(blobs, has_bot=True)


def _encode_pydicom_frames(
    encoder: Any,
    frames: list[np.ndarray],
    *,
    rows: int,
    cols: int,
    samples_per_pixel: int = 1,
    bits_allocated: int = 8,
    bits_stored: int = 8,
    photometric: str = "MONOCHROME2",
    extra_kwargs: dict[str, Any] | None = None,
) -> bytes:
    stacked = np.stack(frames, axis=0) if len(frames) > 1 else frames[0]
    kwargs: dict[str, Any] = {
        "rows": rows,
        "columns": cols,
        "samples_per_pixel": samples_per_pixel,
        "bits_allocated": bits_allocated,
        "bits_stored": bits_stored,
        "pixel_representation": 0,
        "photometric_interpretation": photometric,
        "number_of_frames": len(frames),
    }
    if extra_kwargs:
        kwargs.update(extra_kwargs)
    blobs = [
        encoder.encode(
            stacked,
            index=idx,
            **kwargs,
        )
        for idx in range(len(frames))
    ]
    return encapsulate(blobs, has_bot=True)


def _frame_reference_stats(path: Path) -> dict[str, Any]:
    ds = pydicom.dcmread(path)
    ts_uid = str(ds.file_meta.TransferSyntaxUID)
    result: dict[str, Any] = {
        "file": path.name,
        "sizeBytes": path.stat().st_size,
        "transferSyntaxUid": ts_uid,
        "rows": int(ds.Rows),
        "columns": int(ds.Columns),
        "samplesPerPixel": int(getattr(ds, "SamplesPerPixel", 1)),
        "bitsAllocated": int(ds.BitsAllocated),
        "bitsStored": int(ds.BitsStored),
        "photometricInterpretation": str(ds.PhotometricInterpretation),
        "numberOfFrames": int(getattr(ds, "NumberOfFrames", 1)),
        "manufacturer": str(getattr(ds, "Manufacturer", "")),
        "modelName": str(getattr(ds, "ManufacturerModelName", "")),
    }
    if ts_uid == str(MPEG2MPML):
        result["decodableInPydicom"] = False
        return result

    arr = ds.pixel_array
    if arr.ndim == 2:
        frame0 = arr
    elif arr.ndim == 3 and int(getattr(ds, "SamplesPerPixel", 1)) == 3 and int(getattr(ds, "NumberOfFrames", 1)) == 1:
        frame0 = arr
    else:
        frame0 = arr[0]
    frame0_contig = np.ascontiguousarray(frame0)
    result["decodableInPydicom"] = True
    result["frame0Sha256"] = hashlib.sha256(frame0_contig.tobytes()).hexdigest()
    result["frame0Min"] = int(frame0_contig.min())
    result["frame0Max"] = int(frame0_contig.max())
    result["frame0Mean"] = round(float(frame0_contig.mean()), 4)
    h, w = frame0_contig.shape[:2]
    sample_coords = [(0, 0), (h // 2, w // 2), (int(h * 0.46), int(w * 0.45)), (h - 1, w - 1)]
    samples = []
    for r, c in sample_coords:
        val = frame0_contig[r, c]
        samples.append(
            {
                "row": r,
                "col": c,
                "value": [int(x) for x in val.tolist()] if np.ndim(val) > 0 else int(val),
            }
        )
    result["frame0Samples"] = samples
    return result


def build_compact_suite(out_dir: Path) -> list[dict[str, Any]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict[str, Any]] = []

    # 1. GE Vivid E95: Single-frame 2D Explicit VR LE, calibrated ONLY via UltrasoundRegions (0018,6011)
    p1 = out_dir / "01_ge_vivid_2d_uncompressed.dcm"
    f1 = synthesize_echo_frame(240, 320, 0, 1)
    ds1 = _base_dataset(
        key="01_ge_vivid_2d",
        transfer_syntax=ExplicitVRLittleEndian,
        study_key="echo_multivendor_01",
        series_description="A4C 2D Tissue (US Region Calibrated)",
        manufacturer="GE Healthcare",
        model_name="Vivid E95",
        rows=240,
        cols=320,
        frame_count=1,
        pixel_spacing_mm=None,
        us_region_cm=(0.035, 0.035),  # 0.35 mm/px via SequenceOfUltrasoundRegions
    )
    ds1.PixelData = f1.tobytes()
    ds1.save_as(p1, write_like_original=False)
    manifest.append({**_frame_reference_stats(p1), "lossless": True, "expectedSpacingMm": [0.35, 0.35], "expectedSpacingSource": "SequenceOfUltrasoundRegions"})

    # 2. Philips EPIQ 7G: 16-frame 2D Cine Uncompressed Explicit VR LE
    p2 = out_dir / "02_philips_epiq_cine_uncompressed.dcm"
    frames2 = [synthesize_echo_frame(192, 256, i, 16) for i in range(16)]
    ds2 = _base_dataset(
        key="02_philips_cine",
        transfer_syntax=ExplicitVRLittleEndian,
        study_key="echo_multivendor_01",
        series_description="A4C LV Cine 16f (Uncompressed)",
        manufacturer="Philips Medical Systems",
        model_name="EPIQ 7G",
        rows=192,
        cols=256,
        frame_count=16,
        pixel_spacing_mm=(0.30, 0.30),
    )
    ds2.PixelData = np.stack(frames2, axis=0).tobytes()
    ds2.save_as(p2, write_like_original=False)
    manifest.append({**_frame_reference_stats(p2), "lossless": True, "expectedSpacingMm": [0.30, 0.30], "expectedSpacingSource": "PixelSpacing"})

    # 3. Siemens Acuson SC2000: 16-bit Implicit VR LE
    p3 = out_dir / "03_siemens_acuson_16bit_implicit.dcm"
    f3 = synthesize_echo_frame(240, 240, 0, 1, bit_depth=16)
    ds3 = _base_dataset(
        key="03_siemens_16bit",
        transfer_syntax=ImplicitVRLittleEndian,
        study_key="echo_multivendor_02",
        series_description="PLAX 16-bit High Dynamic Range",
        manufacturer="SIEMENS",
        model_name="ACUSON SC2000",
        rows=240,
        cols=240,
        frame_count=1,
        bits_allocated=16,
        bits_stored=12,
        pixel_spacing_mm=(0.28, 0.28),
    )
    ds3.PixelData = f3.tobytes()
    ds3["PixelData"].VR = "OW"
    ds3.save_as(p3, write_like_original=False)
    manifest.append({**_frame_reference_stats(p3), "lossless": True, "expectedSpacingMm": [0.28, 0.28], "expectedSpacingSource": "PixelSpacing"})

    # 4. Samsung V8: 10-frame JPEG Baseline Grayscale Cine (.50)
    p4 = out_dir / "04_samsung_v8_cine_jpeg_baseline.dcm"
    frames4 = [synthesize_echo_frame(192, 256, i, 10) for i in range(10)]
    ds4 = _base_dataset(
        key="04_samsung_jpeg_baseline",
        transfer_syntax=JPEGBaseline8Bit,
        study_key="echo_multivendor_02",
        series_description="A2C Cine JPEG Baseline 8-bit",
        manufacturer="SAMSUNG MEDISON",
        model_name="V8",
        rows=192,
        cols=256,
        frame_count=10,
        pixel_spacing_mm=(0.32, 0.32),
    )
    ds4.PixelData = _encode_jpeg_frames(frames4, quality=92)
    ds4["PixelData"].VR = "OB"
    ds4.save_as(p4, write_like_original=False)
    manifest.append({**_frame_reference_stats(p4), "lossless": False, "expectedSpacingMm": [0.32, 0.32], "expectedSpacingSource": "PixelSpacing"})

    # 5. GE Vivid S70N: 8-frame Color Doppler JPEG Baseline YBR_FULL_422 (.50)
    p5 = out_dir / "05_ge_vivid_color_jpeg_ybr422.dcm"
    frames5 = [synthesize_echo_frame(192, 256, i, 8, color_doppler=True) for i in range(8)]
    ds5 = _base_dataset(
        key="05_ge_color_ybr422",
        transfer_syntax=JPEGBaseline8Bit,
        study_key="echo_multivendor_01",
        series_description="A4C Color Doppler (JPEG YBR_FULL_422)",
        manufacturer="GE Healthcare",
        model_name="Vivid S70N",
        rows=192,
        cols=256,
        frame_count=8,
        samples_per_pixel=3,
        photometric="YBR_FULL_422",
        pixel_spacing_mm=None,
        us_region_cm=(0.034, 0.034),
        include_color_region=True,
    )
    ds5.PixelData = _encode_jpeg_frames(frames5, ybr422=True, quality=92)
    ds5["PixelData"].VR = "OB"
    ds5.save_as(p5, write_like_original=False)
    manifest.append({**_frame_reference_stats(p5), "lossless": False, "expectedSpacingMm": [0.34, 0.34], "expectedSpacingSource": "SequenceOfUltrasoundRegions"})

    # 6. Mindray Resona I9: 8-frame JPEG Lossless P14SV1 (.70) via GDCM lossless transcode
    p6_tmp = out_dir / "_tmp_p6.dcm"
    p6 = out_dir / "06_mindray_resona_jpeg_lossless_p14sv1.dcm"
    frames6 = [synthesize_echo_frame(192, 256, i, 8) for i in range(8)]
    ds6 = _base_dataset(
        key="06_mindray_jpeg_lossless",
        transfer_syntax=ExplicitVRLittleEndian,
        study_key="echo_multivendor_03",
        series_description="A4C Cine JPEG Lossless P14SV1",
        manufacturer="Mindray",
        model_name="Resona I9",
        rows=192,
        cols=256,
        frame_count=8,
        pixel_spacing_mm=(0.31, 0.31),
    )
    ds6.PixelData = np.stack(frames6, axis=0).tobytes()
    ds6.save_as(p6_tmp, write_like_original=False)
    _transcode_with_gdcm(p6_tmp, p6, gdcm.TransferSyntax.JPEGLosslessProcess14_1)
    p6_tmp.unlink(missing_ok=True)
    #Verify it saved as .70
    assert str(pydicom.dcmread(p6, stop_before_pixels=True).file_meta.TransferSyntaxUID) == str(JPEGLosslessSV1)
    manifest.append({**_frame_reference_stats(p6), "lossless": True, "expectedSpacingMm": [0.31, 0.31], "expectedSpacingSource": "PixelSpacing"})

    # 7. Canon Aplio i900: 8-frame JPEG-LS Lossless (.80)
    p7 = out_dir / "07_canon_aplio_jpegls_lossless.dcm"
    frames7 = [synthesize_echo_frame(192, 256, i, 8) for i in range(8)]
    ds7 = _base_dataset(
        key="07_canon_jpegls",
        transfer_syntax=JPEGLSLossless,
        study_key="echo_multivendor_03",
        series_description="PLAX Cine JPEG-LS Lossless",
        manufacturer="Canon Medical Systems",
        model_name="Aplio i900",
        rows=192,
        cols=256,
        frame_count=8,
        pixel_spacing_mm=(0.29, 0.29),
    )
    ds7.PixelData = _encode_pydicom_frames(JPEGLSLosslessEncoder, frames7, rows=192, cols=256)
    ds7["PixelData"].VR = "OB"
    ds7.save_as(p7, write_like_original=False)
    manifest.append({**_frame_reference_stats(p7), "lossless": True, "expectedSpacingMm": [0.29, 0.29], "expectedSpacingSource": "PixelSpacing"})

    # 8. Philips EPIQ CVx: 12-frame JPEG 2000 Lossless (.90)
    p8 = out_dir / "08_philips_epiq_jpeg2000_lossless.dcm"
    frames8 = [synthesize_echo_frame(240, 320, i, 12) for i in range(12)]
    ds8 = _base_dataset(
        key="08_philips_j2k_lossless",
        transfer_syntax=JPEG2000Lossless,
        study_key="echo_multivendor_01",
        series_description="A4C LV Cine JPEG2000 Lossless",
        manufacturer="Philips Medical Systems",
        model_name="EPIQ CVx",
        rows=240,
        cols=320,
        frame_count=12,
        pixel_spacing_mm=(0.27, 0.27),
    )
    ds8.PixelData = _encode_pydicom_frames(JPEG2000LosslessEncoder, frames8, rows=240, cols=320)
    ds8["PixelData"].VR = "OB"
    ds8.save_as(p8, write_like_original=False)
    manifest.append({**_frame_reference_stats(p8), "lossless": True, "expectedSpacingMm": [0.27, 0.27], "expectedSpacingSource": "PixelSpacing"})

    # 9. Philips iE33: 8-frame RLE Lossless (.5)
    p9 = out_dir / "09_philips_ie33_rle_lossless.dcm"
    frames9 = [synthesize_echo_frame(192, 256, i, 8) for i in range(8)]
    ds9 = _base_dataset(
        key="09_philips_rle",
        transfer_syntax=RLELossless,
        study_key="echo_multivendor_03",
        series_description="PSAX Cine RLE Lossless",
        manufacturer="Philips Medical Systems",
        model_name="iE33",
        rows=192,
        cols=256,
        frame_count=8,
        pixel_spacing_mm=(0.30, 0.30),
    )
    ds9.PixelData = _encode_pydicom_frames(RLELosslessEncoder, frames9, rows=192, cols=256)
    ds9["PixelData"].VR = "OB"
    ds9.save_as(p9, write_like_original=False)
    manifest.append({**_frame_reference_stats(p9), "lossless": True, "expectedSpacingMm": [0.30, 0.30], "expectedSpacingSource": "PixelSpacing"})

    # 10. Uncalibrated Handheld US (missing PixelSpacing & SequenceOfUltrasoundRegions -> px only!)
    p10 = out_dir / "10_uncalibrated_handheld_us.dcm"
    f10 = synthesize_echo_frame(192, 256, 0, 1)
    ds10 = _base_dataset(
        key="10_uncalibrated_us",
        transfer_syntax=ExplicitVRLittleEndian,
        study_key="echo_uncalibrated_04",
        series_description="Subcostal Uncalibrated Clip (px only)",
        manufacturer="Handheld Ultrasound",
        model_name="PocketProbe P1",
        rows=192,
        cols=256,
        frame_count=1,
        pixel_spacing_mm=None,
        us_region_cm=None,
    )
    ds10.PixelData = f10.tobytes()
    ds10.save_as(p10, write_like_original=False)
    manifest.append({**_frame_reference_stats(p10), "lossless": True, "expectedSpacingMm": None, "expectedSpacingSource": None})

    # 11. Unsupported Video Transfer Syntax Stub (MPEG2 Main Profile 1.2.840.10008.1.2.4.100)
    p11 = out_dir / "11_unsupported_mpeg2_stub.dcm"
    ds11 = _base_dataset(
        key="11_unsupported_mpeg2",
        transfer_syntax=MPEG2MPML,
        study_key="echo_unsupported_05",
        series_description="Vendor MPEG2 Video Export (Unsupported Codec Test)",
        manufacturer="Legacy Vendor",
        model_name="EchoStation Video",
        rows=240,
        cols=320,
        frame_count=30,
        pixel_spacing_mm=(0.30, 0.30),
    )
    ds11.PixelData = encapsulate([b"\x00\x00\x01\xb3\x14\x00\xf0\x24" + b"\x00" * 56], has_bot=True)
    ds11["PixelData"].VR = "OB"
    ds11.save_as(p11, write_like_original=False)
    manifest.append({**_frame_reference_stats(p11), "lossless": False, "expectedSpacingMm": [0.30, 0.30], "expectedSpacingSource": "PixelSpacing"})

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    # Mirror to web prototype public/samples/ so Vite dev & preview serve them locally
    PUBLIC_SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    for item in manifest:
        shutil.copy2(out_dir / item["file"], PUBLIC_SAMPLES_DIR / item["file"])
    shutil.copy2(out_dir / "manifest.json", PUBLIC_SAMPLES_DIR / "manifest.json")
    return manifest


def build_720p_bench_suite(bench_dir: Path, frame_count: int = 30) -> list[dict[str, Any]]:
    bench_dir.mkdir(parents=True, exist_ok=True)
    rows, cols = 720, 1280
    print(f"Synthesizing {frame_count} frames at {cols}x{rows} (720p)...")
    # Generate 6 distinct cardiac phase templates and cycle them to build realistic 30-60f cine quickly
    phase_templates = [synthesize_echo_frame(rows, cols, i, 6) for i in range(6)]
    frames = []
    for idx in range(frame_count):
        frame = phase_templates[idx % 6].copy()
        frame[0, 0] = (idx * 7 + 19) % 250
        frames.append(frame)

    manifest: list[dict[str, Any]] = []

    specs = [
        ("bench_720p_uncompressed.dcm", ExplicitVRLittleEndian, None, True, {}),
        ("bench_720p_rle_lossless.dcm", RLELossless, RLELosslessEncoder, True, {}),
        ("bench_720p_jpeg_baseline.dcm", JPEGBaseline8Bit, "PIL_JPEG", False, {}),
        ("bench_720p_jpegls_lossless.dcm", JPEGLSLossless, JPEGLSLosslessEncoder, True, {}),
        ("bench_720p_jpeg2000_lossless.dcm", JPEG2000Lossless, JPEG2000LosslessEncoder, True, {}),
        ("bench_720p_jpeg2000_lossy.dcm", JPEG2000, JPEG2000Encoder, False, {"j2k_psnr": [42]}),
    ]

    for filename, ts_uid, encoder, lossless, extra in specs:
        out_path = bench_dir / filename
        ds = _base_dataset(
            key=filename,
            transfer_syntax=ts_uid,
            study_key="bench_720p",
            series_description=f"720p {frame_count}f Benchmark ({ts_uid.name})",
            manufacturer="SonoForge Bench",
            model_name="Phantom720p",
            rows=rows,
            cols=cols,
            frame_count=frame_count,
            pixel_spacing_mm=(0.25, 0.25),
        )
        if encoder is None:
            ds.PixelData = np.stack(frames, axis=0).tobytes()
        elif encoder == "PIL_JPEG":
            ds.PixelData = _encode_jpeg_frames(frames, quality=90)
            ds["PixelData"].VR = "OB"
        else:
            ds.PixelData = _encode_pydicom_frames(
                encoder, frames, rows=rows, cols=cols, extra_kwargs=extra
            )
            ds["PixelData"].VR = "OB"
        ds.save_as(out_path, write_like_original=False)
        info = _frame_reference_stats(out_path)
        info["lossless"] = lossless
        manifest.append(info)
        print(f"  wrote {filename}: {info['sizeBytes'] / (1024 * 1024):.2f} MiB")

    (bench_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-bench", action="store_true", help="Skip 720p cine benchmark files")
    parser.add_argument("--bench-frames", type=int, default=30, help="Frames per 720p benchmark cine")
    args = parser.parse_args()

    compact = build_compact_suite(FIXTURES_DIR)
    total_kb = sum(item["sizeBytes"] for item in compact) / 1024.0
    print(f"Generated {len(compact)} compact fixtures in {FIXTURES_DIR} ({total_kb:.1f} KiB total)")
    if not args.skip_bench:
        build_720p_bench_suite(BENCH_DIR, frame_count=args.bench_frames)


if __name__ == "__main__":
    main()
