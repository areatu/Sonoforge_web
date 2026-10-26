#!/usr/bin/env python3
"""Generate golden differential test vectors directly from SonoForge Python domain.

Usage:
  SONOFORGE_SRC=/tmp/SonoForge/src python3 spike/scripts/generate_golden_vectors.py
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
SONOFORGE_ROOT = Path(os.environ.get("SONOFORGE_ROOT", "/tmp/SonoForge"))
SONOFORGE_SRC = Path(os.environ.get("SONOFORGE_SRC", str(SONOFORGE_ROOT / "src")))
sys.path.insert(0, str(SONOFORGE_SRC))

from echo_personal_tool.domain.calculations import (  # noqa: E402
    bernoulli,
    body_surface,
    continuity,
    doppler_metrics,
    lvef_simpson,
    lvm,
    rwt,
    teichholz,
)
from echo_personal_tool.domain.models.contour import Contour  # noqa: E402
from echo_personal_tool.domain.models.doppler import (  # noqa: E402
    DopplerIntervalMarker,
    DopplerMeasurementDTO,
    DopplerPeakMarker,
    DopplerTrace,
)
from echo_personal_tool.domain.models.linear_measurement import LinearMeasurement  # noqa: E402
from echo_personal_tool.domain.services.contour_geometry import polygon_area_mm2  # noqa: E402


def _git_commit(repo: Path) -> str:
    try:
        return (
            subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True)
            .strip()
        )
    except Exception:
        return "unknown"


def _make_semi_ellipse_arc(
    *,
    septal: tuple[float, float],
    lateral: tuple[float, float],
    apex_y: float,
    bulge: float = 1.0,
    n_points: int = 25,
) -> list[tuple[float, float]]:
    """Create an open-arc LV endocardial contour from septal MA -> apex -> lateral MA."""
    mid_x = (septal[0] + lateral[0]) / 2.0
    base_y = (septal[1] + lateral[1]) / 2.0
    half_w = (lateral[0] - septal[0]) / 2.0
    pts: list[tuple[float, float]] = []
    for idx in range(n_points):
        # parameter t in [0, pi]: 0 -> septal, pi/2 -> apex, pi -> lateral
        t = math.pi * idx / (n_points - 1)
        s = math.sin(t)
        c = -math.cos(t)  # -1 at 0 (septal), +1 at pi (lateral)
        # Widen mid-ventricle relative to mitral annulus when bulge > 1
        radial = half_w * c * (1.0 + (bulge - 1.0) * (s**0.75))
        x = mid_x + radial
        y = base_y + (apex_y - base_y) * (s**0.88)
        pts.append((round(x, 4), round(y, 4)))
    pts[0] = septal
    pts[-1] = lateral
    return pts


def build_vectors() -> dict[str, Any]:
    commit = _git_commit(SONOFORGE_ROOT)

    # 1. BSA & Indexation cases
    bsa_cases = []
    for case_id, h_cm, w_kg, manual_bsa in [
        ("normal_adult_male", 178.0, 82.0, None),
        ("normal_adult_female", 164.0, 61.5, None),
        ("small_pediatric", 112.0, 19.5, None),
        ("tall_heavy", 198.0, 125.0, None),
        ("manual_override_wins", 178.0, 82.0, 1.95),
        ("manual_only_missing_hw", None, None, 1.82),
        ("missing_weight", 175.0, None, None),
        ("zero_height_invalid", 0.0, 75.0, None),
        ("negative_weight_invalid", 175.0, -70.0, None),
        ("nan_manual_falls_back_to_derived", 170.0, 70.0, float("nan")),
    ]:
        du_bois = (
            body_surface.bsa_du_bois_m2(h_cm, w_kg)
            if (h_cm is not None and w_kg is not None)
            else None
        )
        basis = body_surface.resolve_bsa_basis(
            height_cm=h_cm,
            weight_kg=w_kg,
            manual_bsa_m2=manual_bsa,
        )
        bsa_cases.append(
            {
                "id": case_id,
                "input": {
                    "heightCm": None if (h_cm is not None and math.isnan(h_cm)) else h_cm,
                    "weightKg": None if (w_kg is not None and math.isnan(w_kg)) else w_kg,
                    "manualBsaM2": "NaN"
                    if (manual_bsa is not None and math.isnan(manual_bsa))
                    else manual_bsa,
                },
                "expected": {
                    "duBoisM2": du_bois,
                    "resolvedBsaM2": basis.value,
                    "source": basis.source,
                    "indexedEdv120MlM2": continuity.indexed_to_bsa(120.0, basis.value),
                },
            }
        )

    # 2. Teichholz & Fractional Shortening
    teichholz_cases = []
    for case_id, calipers in [
        (
            "normal_lv_calipers",
            [("LVEDD", 48.0), ("LVESD", 31.0)],
        ),
        (
            "dilated_reduced_ef",
            [("LVIDd", 64.5), ("LVIDs", 52.0)],
        ),
        (
            "hyperdynamic_small_lv",
            [("lv_end_diastolic_diameter", 42.0), ("lv_end_systolic_diameter", 24.0)],
        ),
        (
            "swapped_es_ge_ed_rejected",
            [("LVEDD", 35.0), ("LVESD", 40.0)],
        ),
        (
            "equal_es_ed_rejected",
            [("LVEDD", 45.0), ("LVESD", 45.0)],
        ),
        (
            "uncalibrated_none_mm_ignored",
            [("LVEDD", None), ("LVESD", 30.0)],
        ),
        (
            "zero_diameter_rejected",
            [("LVEDD", 0.0), ("LVESD", 30.0)],
        ),
    ]:
        lms = tuple(
            LinearMeasurement(
                label=lbl,
                start=(10.0, 10.0),
                end=(50.0, 10.0),
                pixel_length=40.0,
                millimeter_length=mm,
            )
            for lbl, mm in calipers
        )
        res = teichholz.from_linear_measurements(lms)
        lvedd_mm = next((mm for lbl, mm in calipers if "ed" in lbl.lower() or "idd" in lbl.lower()), None)
        lvesd_mm = next((mm for lbl, mm in calipers if "es" in lbl.lower() or "ids" in lbl.lower()), None)
        fs = teichholz.fractional_shortening_percent(
            lvedd_mm / 10.0 if lvedd_mm is not None else None,
            lvesd_mm / 10.0 if lvesd_mm is not None else None,
        )
        teichholz_cases.append(
            {
                "id": case_id,
                "input": {"calipers": [{"label": lbl, "mm": mm} for lbl, mm in calipers]},
                "expected": {
                    "edvMl": res.edv_ml if res else None,
                    "esvMl": res.esv_ml if res else None,
                    "svMl": res.sv_ml if res else None,
                    "lvefPercent": res.lvef_percent if res else None,
                    "fsPercent": fs,
                },
            }
        )

    # 3. LV Mass (ASE 2015 Cube) & RWT
    lvm_rwt_cases = []
    for case_id, ivsd, lvedd, lvpwd, bsa_m2 in [
        ("normal_geometry", 9.5, 48.0, 9.0, 1.92),
        ("concentric_hypertrophy", 13.5, 49.0, 13.0, 1.85),
        ("eccentric_hypertrophy", 10.5, 62.0, 10.5, 2.05),
        ("concentric_remodeling", 11.0, 43.0, 10.5, 1.78),
        ("invalid_zero_lvedd", 10.0, 0.0, 10.0, 1.80),
        ("missing_ivsd", None, 50.0, 10.0, 1.80),
    ]:
        calipers = []
        if ivsd is not None:
            calipers.append(("IVSd", ivsd))
        if lvedd is not None:
            calipers.append(("LVEDD", lvedd))
        if lvpwd is not None:
            calipers.append(("LVPWd", lvpwd))
        lms = tuple(
            LinearMeasurement(
                label=lbl,
                start=(0.0, 0.0),
                end=(10.0, 0.0),
                pixel_length=10.0,
                millimeter_length=mm,
            )
            for lbl, mm in calipers
        )
        mass_g = lvm.from_linear_measurements(lms) if (lvedd is not None and lvedd > 0) else None
        rwt_val = rwt.from_linear_measurements(lms)
        lvmi = continuity.indexed_to_bsa(mass_g, bsa_m2) if mass_g is not None else None
        lvm_rwt_cases.append(
            {
                "id": case_id,
                "input": {
                    "ivsdMm": ivsd,
                    "lveddMm": lvedd,
                    "lvpwdMm": lvpwd,
                    "bsaM2": bsa_m2,
                },
                "expected": {
                    "lvmGrams": mass_g,
                    "lvmiGM2": lvmi,
                    "rwtRatio": rwt_val,
                },
            }
        )

    # 4. Simpson 20-Disk Monoplane & Biplane + Planimetry
    a4c_ed_ann = ((110.0, 210.0), (210.0, 212.0))
    a4c_ed_pts = _make_semi_ellipse_arc(septal=a4c_ed_ann[0], lateral=a4c_ed_ann[1], apex_y=45.0, bulge=1.22)
    a4c_es_ann = ((122.0, 206.0), (198.0, 208.0))
    a4c_es_pts = _make_semi_ellipse_arc(septal=a4c_es_ann[0], lateral=a4c_es_ann[1], apex_y=68.0, bulge=1.08)

    a2c_ed_ann = ((114.0, 214.0), (208.0, 210.0))
    a2c_ed_pts = _make_semi_ellipse_arc(septal=a2c_ed_ann[0], lateral=a2c_ed_ann[1], apex_y=40.0, bulge=1.18)
    a2c_es_ann = ((125.0, 209.0), (195.0, 206.0))
    a2c_es_pts = _make_semi_ellipse_arc(septal=a2c_es_ann[0], lateral=a2c_es_ann[1], apex_y=64.0, bulge=1.05)

    simpson_scenarios = [
        (
            "monoplane_a4c_isotropic",
            (0.35, 0.35),
            [
                Contour(phase="ed", view="A4C", chamber="LV", points=a4c_ed_pts, mitral_annulus=a4c_ed_ann),
                Contour(phase="es", view="A4C", chamber="LV", points=a4c_es_pts, mitral_annulus=a4c_es_ann),
            ],
        ),
        (
            "biplane_a4c_a2c_isotropic",
            (0.35, 0.35),
            [
                Contour(phase="ed", view="A4C", chamber="LV", points=a4c_ed_pts, mitral_annulus=a4c_ed_ann),
                Contour(phase="es", view="A4C", chamber="LV", points=a4c_es_pts, mitral_annulus=a4c_es_ann),
                Contour(phase="ed", view="A2C", chamber="LV", points=a2c_ed_pts, mitral_annulus=a2c_ed_ann),
                Contour(phase="es", view="A2C", chamber="LV", points=a2c_es_pts, mitral_annulus=a2c_es_ann),
            ],
        ),
        (
            "biplane_anisotropic_spacing",
            (0.38, 0.31),
            [
                Contour(phase="ed", view="A4C", chamber="LV", points=a4c_ed_pts, mitral_annulus=a4c_ed_ann),
                Contour(phase="es", view="A4C", chamber="LV", points=a4c_es_pts, mitral_annulus=a4c_es_ann),
                Contour(phase="ed", view="A2C", chamber="LV", points=a2c_ed_pts, mitral_annulus=a2c_ed_ann),
                Contour(phase="es", view="A2C", chamber="LV", points=a2c_es_pts, mitral_annulus=a2c_es_ann),
            ],
        ),
        (
            "pending_review_ignored_falls_back_monoplane",
            (0.35, 0.35),
            [
                Contour(phase="ed", view="A4C", chamber="LV", points=a4c_ed_pts, mitral_annulus=a4c_ed_ann),
                Contour(phase="es", view="A4C", chamber="LV", points=a4c_es_pts, mitral_annulus=a4c_es_ann),
                Contour(
                    phase="ed",
                    view="A2C",
                    chamber="LV",
                    points=a2c_ed_pts,
                    mitral_annulus=a2c_ed_ann,
                    review_pending=True,
                ),
                Contour(phase="es", view="A2C", chamber="LV", points=a2c_es_pts, mitral_annulus=a2c_es_ann),
            ],
        ),
        (
            "swapped_es_gt_ed_lvef_none",
            (0.35, 0.35),
            [
                Contour(phase="ed", view="A4C", chamber="LV", points=a4c_es_pts, mitral_annulus=a4c_es_ann),
                Contour(phase="es", view="A4C", chamber="LV", points=a4c_ed_pts, mitral_annulus=a4c_ed_ann),
            ],
        ),
        (
            "missing_pixel_spacing_returns_none",
            None,
            [
                Contour(phase="ed", view="A4C", chamber="LV", points=a4c_ed_pts, mitral_annulus=a4c_ed_ann),
                Contour(phase="es", view="A4C", chamber="LV", points=a4c_es_pts, mitral_annulus=a4c_es_ann),
            ],
        ),
    ]

    simpson_cases = []
    for case_id, spacing, contours in simpson_scenarios:
        res = lvef_simpson.calculate(tuple(contours), spacing)
        first_c = contours[0]
        area_mm2 = (
            polygon_area_mm2(first_c.closed_polygon_points(), spacing)
            if spacing is not None
            else None
        )
        lines = lvef_simpson.compute_simpson_lines(first_c, spacing)
        simpson_cases.append(
            {
                "id": case_id,
                "input": {
                    "pixelSpacing": list(spacing) if spacing is not None else None,
                    "contours": [
                        {
                            "phase": c.phase,
                            "view": c.view,
                            "chamber": c.chamber,
                            "points": [list(pt) for pt in c.points],
                            "mitralAnnulus": [list(c.mitral_annulus[0]), list(c.mitral_annulus[1])]
                            if c.mitral_annulus
                            else None,
                            "reviewPending": c.review_pending,
                        }
                        for c in contours
                    ],
                },
                "expected": {
                    "result": None
                    if res is None
                    else {
                        "method": res.method,
                        "lvefPercent": res.lvef_percent,
                        "edvBiMl": res.edv_bi_ml,
                        "esvBiMl": res.esv_bi_ml,
                        "svMl": res.sv_ml,
                        "a4cEdvMl": res.a4c.edv_ml if res.a4c else None,
                        "a4cEsvMl": res.a4c.esv_ml if res.a4c else None,
                        "a2cEdvMl": res.a2c.edv_ml if res.a2c else None,
                        "a2cEsvMl": res.a2c.esv_ml if res.a2c else None,
                    },
                    "firstContourAreaMm2": area_mm2,
                    "firstContourDiskCount": len(lines.disk_lines) if lines else 0,
                },
            }
        )

    # 5. Bernoulli & Continuity Hemodynamics
    hemodynamics_cases = []
    for case_id, lvot_d_cm, lvot_vti_cm, av_vti_cm, av_vmax_cm_s, hr_bpm, bsa_m2, rvot_sv_ml in [
        ("normal_aortic_valve", 2.1, 21.5, 24.0, 125.0, 68.0, 1.90, 74.0),
        ("severe_aortic_stenosis", 2.0, 19.0, 92.0, 435.0, 74.0, 1.82, 59.7),
        ("low_flow_low_gradient", 1.9, 13.5, 48.0, 290.0, 62.0, 1.75, 38.3),
        ("shunt_qp_qs_elevated", 2.0, 18.0, 21.0, 115.0, 80.0, 1.65, 102.0),
        ("missing_av_vti", 2.1, 20.0, None, 130.0, 70.0, 1.85, None),
        ("zero_lvot_diameter_invalid", 0.0, 20.0, 50.0, 250.0, 70.0, 1.85, None),
    ]:
        area = continuity.lvot_area_cm2(lvot_d_cm)
        sv = continuity.stroke_volume_ml(area, lvot_vti_cm)
        co = continuity.cardiac_output_l_min(sv, hr_bpm)
        ava = continuity.ava_continuity_cm2(area, lvot_vti_cm, av_vti_cm)
        avai = continuity.indexed_to_bsa(ava, bsa_m2)
        svi = continuity.indexed_to_bsa(sv, bsa_m2)
        ci = continuity.indexed_to_bsa(co, bsa_m2)
        dvi = continuity.dimensionless_index(lvot_vti_cm, av_vti_cm)
        pg = bernoulli.pressure_gradient_mmhg(av_vmax_cm_s)
        qp_qs = continuity.qp_qs_ratio(rvot_sv_ml, sv)
        hemodynamics_cases.append(
            {
                "id": case_id,
                "input": {
                    "lvotDiameterCm": lvot_d_cm,
                    "lvotVtiCm": lvot_vti_cm,
                    "avVtiCm": av_vti_cm,
                    "avVmaxCmS": av_vmax_cm_s,
                    "heartRateBpm": hr_bpm,
                    "bsaM2": bsa_m2,
                    "rvotSvMl": rvot_sv_ml,
                },
                "expected": {
                    "lvotAreaCm2": area,
                    "strokeVolumeMl": sv,
                    "sviMlM2": svi,
                    "cardiacOutputLMin": co,
                    "cardiacIndexLMinM2": ci,
                    "avaCm2": ava,
                    "avaiCm2M2": avai,
                    "dviRatio": dvi,
                    "avPeakGradientMmHg": pg,
                    "qpQsRatio": qp_qs,
                },
            }
        )

    # 6. Doppler Trapezoidal VTI & Multi-beat Averaging (REPORT_WINDOW=3)
    doppler_cases = []
    trace_single = [(0.0, 0.0), (80.0, 120.0), (160.0, 95.0), (280.0, 40.0), (340.0, 0.0)]
    trace_neg = [(0.0, 0.0), (100.0, -320.0), (220.0, -410.0), (350.0, -180.0), (420.0, 0.0)]
    trace_beat1 = [(0.0, 0.0), (100.0, 100.0), (300.0, 0.0)]
    trace_beat2 = [(0.0, 0.0), (100.0, 110.0), (300.0, 0.0)]
    trace_beat3 = [(0.0, 0.0), (100.0, 130.0), (300.0, 0.0)]
    trace_beat4 = [(0.0, 0.0), (100.0, 140.0), (300.0, 0.0)]

    for case_id, traces, rr_intervals_ms in [
        ("single_lvot_trace", [("VTI LVOT", trace_single)], [880.0]),
        ("negative_cw_aortic_jet", [("VTI AV", trace_neg)], [810.0]),
        (
            "four_beats_averages_last_three",
            [
                ("VTI LVOT", trace_beat1),
                ("VTI LVOT", trace_beat2),
                ("VTI LVOT", trace_beat3),
                ("VTI LVOT", trace_beat4),
            ],
            [920.0, 860.0, 840.0, 800.0],
        ),
        ("invalid_zero_rr", [], [0.0, -500.0]),
    ]:
        dto = DopplerMeasurementDTO(
            peaks=[DopplerPeakMarker(label="AV Vmax", time_ms=120.0, velocity_cm_s=-410.0)],
            traces=[DopplerTrace(label=lbl, points=pts) for lbl, pts in traces],
            intervals=[
                DopplerIntervalMarker(label="RR", start_time_ms=0.0, end_time_ms=rr)
                for rr in rr_intervals_ms
                if rr > 0
            ],
        )
        vti_cm = doppler_metrics._find_vti_cm(dto)
        hr_bpm = doppler_metrics._find_heart_rate_bpm(dto)
        single_rr_hr = (
            doppler_metrics.heart_rate_from_interval_ms(rr_intervals_ms[0])
            if rr_intervals_ms
            else None
        )
        doppler_cases.append(
            {
                "id": case_id,
                "input": {
                    "traces": [{"label": lbl, "points": [list(p) for p in pts]} for lbl, pts in traces],
                    "rrIntervalsMs": rr_intervals_ms,
                },
                "expected": {
                    "vtiCm": vti_cm,
                    "meanHeartRateBpm": hr_bpm,
                    "firstIntervalHrBpm": single_rr_hr,
                },
            }
        )

    return {
        "schemaVersion": 1,
        "generatedAt": "2026-10-26",
        "sourceRepo": "https://github.com/areatu/SonoForge",
        "sourceCommit": commit,
        "tolerances": {
            "m2": 1e-9,
            "ml": 1e-6,
            "ml_m2": 1e-6,
            "percent": 1e-6,
            "grams": 1e-6,
            "g_m2": 1e-6,
            "ratio": 1e-9,
            "mmhg": 1e-6,
            "cm2": 1e-6,
            "cm2_m2": 1e-6,
            "l_min": 1e-6,
            "l_min_m2": 1e-6,
            "cm": 1e-6,
            "bpm": 1e-6,
            "mm2": 1e-6,
        },
        "suites": {
            "bsa": bsa_cases,
            "teichholz": teichholz_cases,
            "lvmAndRwt": lvm_rwt_cases,
            "simpson": simpson_cases,
            "hemodynamics": hemodynamics_cases,
            "doppler": doppler_cases,
        },
    }


def main() -> None:
    out_path = REPO_ROOT / "tests" / "golden" / "domain_vectors_v1.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = build_vectors()
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    total_cases = sum(len(v) for v in payload["suites"].values())
    print(
        f"Wrote {total_cases} golden vectors from SonoForge@{payload['sourceCommit'][:7]} -> {out_path}"
    )


if __name__ == "__main__":
    main()
