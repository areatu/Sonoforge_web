# SonoForge Web — Каталог функционального паритета (`PARITY_CATALOG.md`)

**Эталонная версия настольного SonoForge:** [`areatu/SonoForge@7f9f0564717a7343bd9c513ca0ebd414f17c5757`](https://github.com/areatu/SonoForge)  
**Дата фиксации:** 2026-10-26  
**Статус:** Этап 0 завершён (ядро из 8 расчётных модулей портировано в `spike/domain-ts/` и верифицировано 39 дифференциальными golden-векторами).

---

## 1. Правила численной эквивалентности и допусков

Все расчётные функции в TypeScript (`spike/domain-ts/`, далее `packages/domain` на Этапе 1+) обязаны строго сохранять:
1. **Входные и выходные физические единицы** настольного `SonoForge` без неявных пересчётов (`mm` vs `cm`, `cm/s` vs `m/s`, `mL` vs `mm³`).
2. **Семантику `null` / невалидных и граничных входов** (`<= 0`, `NaN`, `Infinity`, `LVESD >= LVEDD`, `ESV > EDV`, отсутствие калибровки `mm/px`).
3. **Дифференциальные допуски (`tests/golden/domain_vectors_v1.json`)** до округления на уровне UI:

| Тип величины | Единица | Численный допуск (`absTol`) | Отображение в UI |
|---|---|---:|---|
| Объёмы камер (`EDV`, `ESV`, `SV`, `LAV`) | `mL` | `1e-6` (межъязыковой IEEE-754) / `<= 0.01` при дискретизации контура | `0.1 mL` |
| Фракции и укорочение (`LVEF`, `FS`, `FAC`) | `%` | `1e-6` | `0.1 %` |
| Площадь поверхности тела (`BSA`) | `m²` | `1e-9` | `0.01 m²` |
| Масса миокарда и индекс (`LVM`, `LVMI`) | `g`, `g/m²` | `1e-6` | `0.1 g`, `0.1 g/m²` |
| Площади отверстий и камер (`AVA`, `LVOT area`, `MVA`) | `cm²`, `mm²` | `1e-6` | `0.01 cm²` |
| Градиенты давления (`ΔP`, `RVSP`, `sPAP`) | `mmHg` | `1e-6` | `0.1 mmHg` |
| Индексы и отношения (`RWT`, `DVI`, `Qp/Qs`, `E/A`, `E/e'`) | безразмерн. | `1e-9` | `0.01` |
| Допплеровский интеграл и ЧСС (`VTI`, `HR`) | `cm`, `bpm` | `1e-6` | `0.1 cm`, `1 bpm` |

---

## 2. Модули `echo_personal_tool/domain/calculations/` (19 модулей)

| № | Python-модуль (`SonoForge`) | Ключевые функции и формулы | TS-модуль | Целевой этап | Статус на Этапе 0 |
|---:|---|---|---|---|---|
| 1 | `body_surface.py` | `bsa_dubois_m2`, `resolve_bsa_basis` (`manual` > `derived` > `missing`), `indexed_to_bsa` | `spike/domain-ts/bsa.ts` | Этап 0 / Этап 3 | **Портировано и проверено** (golden vectors) |
| 2 | `teichholz.py` | `teichholz_volume_ml` (`7/(2.4+L)·L³`), `teichholz_from_linear_measurements`, `FS %`, `EF %` | `spike/domain-ts/teichholz.ts` | Этап 0 / Этап 3 | **Портировано и проверено** (golden vectors) |
| 3 | `lvm.py` | `lvm_grams` (`0.8·1.04·((IVSd+LVEDD+LVPWd)³ - LVEDD³)+0.6`), `lvm_from_linear_measurements` | `spike/domain-ts/lvMassAndRwt.ts` | Этап 0 / Этап 3 | **Портировано и проверено** (golden vectors) |
| 4 | `rwt.py` | `relative_wall_thickness` (`2·LVPWd / LVEDD`), `rwt_from_linear_measurements` | `spike/domain-ts/lvMassAndRwt.ts` | Этап 0 / Этап 3 | **Портировано и проверено** (golden vectors) |
| 5 | `lvef_simpson.py` | 20-дисковый метод Симпсона (`A4C`, `A2C`, `simpson_biplan` с `max(L4C, L2C)/20`, fallback `simpson_monoplan`) | `spike/domain-ts/simpson.ts` | Этап 0 / Этап 3 | **Портировано и проверено** (golden vectors) |
| 6 | `simpson_contours.py` | `compute_simpson_lines` (длинная ось от середины кольца МК до верхушки + 20 перпендикулярных хорд) | `spike/domain-ts/simpson.ts` | Этап 0 / Этап 2 | **Портировано и проверено** (отрисовка в прототипе) |
| 7 | `planimeter.py` | Площадь замкнутого полигона по формуле Гаусса с учётом анизотропного `[rowMm, colMm]` | `spike/domain-ts/simpson.ts` (`polygonAreaMm2`) | Этап 0 / Этап 2 | **Портировано и проверено** (golden vectors) |
| 8 | `bernoulli.py` | Упрощённое уравнение Бернулли `ΔP = 4·V²` (`velocity_cm_s -> mmHg`) | `spike/domain-ts/hemodynamics.ts` | Этап 0 / Этап 3 | **Портировано и проверено** (golden vectors) |
| 9 | `continuity.py` | `lvot_area_cm2`, `stroke_volume_ml`, `cardiac_output_l_min`, `ava_continuity_cm2`, `dimensionless_index`, `qp_qs_ratio` | `spike/domain-ts/hemodynamics.ts` | Этап 0 / Этап 3 | **Портировано и проверено** (golden vectors) |
| 10 | `doppler_metrics.py` | Интеграл трапеций `VTI (cm)`, ЧСС по R-R интервалу (`60000 / ms`), усреднение по окну последних циклов (`DOPPLER_REPORT_WINDOW = 3`) | `spike/domain-ts/hemodynamics.ts` | Этап 0 / Этап 3 | **Портировано (базовое ядро)**; полный реестр профилей клапанов — Этап 3 |
| 11 | `teichholz_mmode.py` | Расчёт Тейхольца по точкам ручной M-mode разметки | `packages/domain/mmode` | Этап 3 | Запланировано (ручной M-mode) |
| 12 | `chamber_simpson.py` | Одноплоскостной/биплановый объём ЛП (`LA volume`, `LAVi`) и ПП (`RA volume`) методом дисков | `packages/domain/chambers` | Этап 3 | Запланировано (высокое переиспользование `simpson.ts`) |
| 13 | `la_area_length.py` | Объём ЛП методом «площадь–длина» (`0.85 · A1 · A2 / L`) и `LAVi` | `packages/domain/chambers` | Этап 3 | Запланировано |
| 14 | `rv_fac.py` | Fractional Area Change ПЖ (`(RVEDA - RVESA) / RVEDA · 100%`) по ручным контурам | `packages/domain/rv` | Этап 5 | Запланировано |
| 15 | `diastology_grade.py` | Алгоритм ASE/EACVI оценки диастолической функции (`E/A`, `e'` септ./лат., `E/e'`, `LAVi`, `TR Vmax`) | `packages/domain/diastology` | Этап 5 | Запланировано |
| 16 | `pisa.py` | Метод PISA (`r`, `V_aliasing`, `V_max` → `EROA`, `Regurgitant Volume`, `RF %`) для MR/AR/TR | `packages/domain/valves` | Этап 5 | Запланировано |
| 17 | `mitral_stenosis.py` | Площадь МК по `PHT` (`220 / PHT`), градиент и непрерывность потока | `packages/domain/valves` | Этап 5 | Запланировано |
| 18 | `pulmonary_hemodynamics.py` | `RVSP / sPAP = 4·(TR Vmax)² + RAP`, `mPAP`, `PVR` (Abbas) | `packages/domain/pulmonary` | Этап 3 / 5 | Запланировано |
| 19 | `contractility.py` & `vessel_metrics.py` | `dP/dt` ЛЖ/ПЖ (1→3 м/с МР), диаметры и индексы корня/восходящей аорты и НПВ (`IVC collapsibility`) | `packages/domain/vessels` | Этап 5 | Запланировано |

---

## 3. Калькуляторы `echo_personal_tool/domain/calculators/` (`registry.py`)

| ID калькулятора (`registry.py`) | Описание | Целевой этап |
|---|---|---|
| `teichholz` | Объёмы ЛЖ, УО, ФВ и ФУ по Тейхольцу | Этап 0 (готово в прототипе) / Этап 3 |
| `stroke_volume` | Ударный объём и сердечный выброс через ВТЛЖ (`LVOTd + LVOT VTI + HR`) | Этап 0 (готово в прототипе) / Этап 3 |
| `aortic_valve_area` | Площадь АК по уравнению непрерывности (`AVA`, `AVAi`, `DVI`) | Этап 0 (готово в прототипе) / Этап 3 |
| `pulmonary_pressure` | Расчётное систолическое давление в ЛА (`TR Vmax + RAP`) | Этап 3 |
| `qp_qs` | Отношение лёгочного и системного кровотока (`Qp/Qs`) | Этап 5 |
| `mitral_valve_area` | Площадь митрального отверстия (`PHT` / непрерывность / планиметрия) | Этап 5 |
| `pisa_mr`, `pisa_ar`, `pisa_tr` | Количественная оценка регургитации методом PISA | Этап 5 |
| `orifice_area` | Эффективная площадь отверстия по потоку | Этап 5 |
| `dpdt` | Скорость нарастания давления `dP/dt` | Этап 5 |

---

## 4. Сервисы `echo_personal_tool/domain/services/` — границы переноса

### Входят в ручной браузерный контур (Этапы 1–5)
- **Калибровка и геометрия:** `pixel_spacing_resolver.py` (**портировано на Этапе 0** в `spike/dicom-ts/dicomParserAdapter.ts` и `coordinates.ts`), `ultrasound_region_physics.py`, `doppler_calibration.py`, `mmode_calibration.py`, `contour_geometry.py` (ядро портировано), `lv_bezier_contour.py` (ручной сплайн без AI-refinement).
- **Справочники норм, свежесть производных метрик и отчётность:** `ase_reference_norms.py`, `reference_card.py`, `bsa_provenance.py`, `bsa_freshness.py`, `simpson_freshness.py`, `doppler_freshness.py`, `derived_freshness.py`, `report_sections.py`, `report_phrases.py`, `report_builder.py`, `indexed_results_formatter.py`, `measurement_results_formatter.py`.
- **Приватность и гигиена метаданных:** `patient_display.py`, `phi_mask.py` (скрытие PHI по умолчанию реализовано в прототипе Этапа 0).

### Явно исключены из веб-проекта (Out of Scope согласно Спецификации §1)
- **AI / ONNX сегментация и авто-детекторы:** `segmentation_service.py`, `la_segmentation_service.py`, `mbs_lite_service.py`, `spectrogram_detector.py`, `auto_depth_calibration.py`, `auto_doppler_velocity_calibration.py`, `depth_scale_detector.py`, `velocity_scale_detector.py`, `doppler_grid_detector.py`, `doppler_envelope.py`, `phi_text_detector.py`.
- **Speckle Tracking (STE), оптический поток и авто-трекинг границ:** `speckle_tracking.py`, `optical_flow_refine.py`, `border_tracking.py`, `active_contour_refine.py`, `stepped_border_refine.py`, `contour_edge_snap.py`, `lv_temporal_fusion.py`, `tracking_smoothing.py`, `strain_computation.py`, `strain_metrics.py`.
- **Десктопное хранилище эталонов:** `gold_store.py`.
