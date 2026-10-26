# SonoForge Web — Отчёт по Этапу 0 (Технический спайк и архитектурные решения)

**Дата:** 2026-10-26  
**Репозиторий:** `areatu/Sonoforge_web`  
**Эталон настольного проекта:** `areatu/SonoForge@7f9f0564717a7343bd9c513ca0ebd414f17c5757` (GPL-3.0)  
**Статус Gate Этапа 0:** **ПРОЙДЕН (PASSED)** — все критерии приёмки выполнены и подтверждены воспроизводимыми тестами и бенчмарками.

> **Важное уведомление:** Артефакты Этапа 0 являются исследовательским инженерным спайком, не предназначены для первичной клинической диагностики и не содержат персональных медицинских данных пациентов (PHI).

---

## 1. Резюме ключевых архитектурных решений

| Область | Выбранное решение | Ключевое эмпирическое обоснование | ADR |
|---|---|---|---|
| **DICOM-движок и кодеки** | Модульная связка `dicom-parser@1.8.21` + ленивые WASM-кодеки `@cornerstonejs/codec-{libjpeg-turbo-8bit,charls,openjpeg,openjph}` + `jpeg-lossless-decoder-js` в выделенном Web Worker за портами `DicomFileReader`, `FrameSource`, `SeriesAssembler` | Начальный чанк воркера **13.2 KiB gzip** (против **829.8 KiB gzip** и **9 CVE** у монолитного Cornerstone3D и **223.8 KiB gzip** у DWV); **26.0 fps** на 720p JPEG2000 Lossless (против **9.7 fps** у DWV); поддержка JPEG-LS и HTJ2K; **100% SHA-256 побитовое совпадение** с `pydicom` | [ADR-001](../adr/ADR-001-dicom-engine-selection.md) |
| **Среда расчётов (`domain`)** | Чистый порт на TypeScript (`spike/domain-ts/` → `packages/domain`) с дифференциальными golden-тестами против Python `SonoForge` | **3.2 KiB gzip**, холодный старт **< 1 ms**, **1.925 µs/вызов** (против **5.52 MiB gzip** ядра Pyodide + **~25–30 MiB** `numpy`/`scipy`, холодный старт **1,469.8 ms**, **+83.8 MiB RSS** и `ModuleNotFoundError: numpy` при пакетном импорте `domain.calculations`) | [ADR-002](../adr/ADR-002-calculation-runtime.md) |
| **Память, потоки и браузеры** | Браузеры Desktop Chrome/Edge/Firefox/Safari + планшеты >=1024px; ленивый модуль-воркер с `cancelTask`, zero-copy `Transferable` RGBA и байтовым лимитом `LruFrameCache(96 MiB)` | 120-кадровый 720p RGB клип без лимита занимает **316.41 MiB**, а с `LruFrameCache(96 MiB)` пик жёстко ограничен **94.93 MiB** при сохранении исходного lossless буфера для измерений | [ADR-003](../adr/ADR-003-browser-support-security-and-memory.md) |
| **Локальное хранение сессий** | `IndexedDB` (`schemaVersion` + монотонная `revision` + `BroadcastChannel`) для измерений + опциональный `OPFS` для локального кеширования DICOM | Исключает тихую перезапись между вкладками, сохраняет режим Ephemeral PHI-Safe по умолчанию и поддерживает чистый экспорт/импорт JSON без PHI | [ADR-004](../adr/ADR-004-local-session-storage-and-migrations.md) |
| **Лицензирование** | `GPL-3.0-or-later` с аудитом всех runtime-пакетов (`MIT` / `BSD-2` / `BSD-3` / `IJG`) и **0 production CVE** | Полная совместимость с лицензией `areatu/SonoForge` (`GPL-3.0`) и чистота `npm audit --omit=dev` | [ADR-005](../adr/ADR-005-licensing-and-third-party-notices.md) |

---

## 2. Тестовый набор деидентифицированных (100% синтетических) ЭхоКГ DICOM-фикстур

Скрипт `spike/scripts/generate_echo_fixtures.py` синтезирует реалистичный сектор фазированной УЗ-решётки (спекл-шум, сокращающаяся полость ЛЖ во времени, створки МК, шкала глубины, допплеровское цветовое картирование `YBR_FULL_422`) **без чтения или копирования каких-либо файлов пациентов**. Тест `tests/architecture_purity.test.ts` автоматически проверяет отсутствие реальных PHI во всех 11 файлах (`spike/fixtures/`).

| № | Файл фикстуры | Сценарий / Вендор | Transfer Syntax | Размеры и кадры | Калибровка spacing | Побитовый паритет с `pydicom` |
|---:|---|---|---|---|---|---|
| 01 | `01_ge_vivid_2d_uncompressed.dcm` | GE Vivid E95 (2D статика) | `1.2.840.10008.1.2.1` (Explicit VR LE) | `320×240 × 1`, 8-bit Mono | `US Region (0018,6011)`: `0.28 mm` | **SHA-256 exact** |
| 02 | `02_philips_epiq_cine_uncompressed.dcm` | Philips EPIQ 7C (2D cine) | `1.2.840.10008.1.2.1` (Explicit VR LE) | `320×240 × 10`, 8-bit Mono | `US Region` приоритетнее `PixelSpacing`: `0.31 mm` | **SHA-256 exact** |
| 03 | `03_siemens_acuson_16bit_implicit.dcm` | Siemens Acuson SC2000 | `1.2.840.10008.1.2` (Implicit VR LE) | `256×224 × 1`, 16-bit (`12 stored`) | `PixelSpacing`: `[0.34, 0.34] mm` | **SHA-256 exact** |
| 04 | `04_samsung_v8_cine_jpeg_baseline.dcm` | Samsung V8 (2D cine) | `1.2.840.10008.1.2.4.50` (JPEG Baseline) | `320×240 × 8`, 8-bit Mono | `US Region`: `0.29 mm` | Lossy (PSNR проверен) |
| 05 | `05_ge_vivid_color_jpeg_ybr422.dcm` | GE Vivid Color Doppler | `1.2.840.10008.1.2.4.50` (`YBR_FULL_422`) | `320×240 × 6`, 8-bit 3ch | 2D region выбран мимо Color ROI: `0.30 mm` | Цветовая конверсия RGB проверена |
| 06 | `06_mindray_resona_jpeg_lossless_p14sv1.dcm` | Mindray Resona I9 | `1.2.840.10008.1.2.4.70` (JPEG Lossless SV1) | `256×200 × 4`, 8-bit Mono | `ImagerPixelSpacing`: `0.33 mm` | **SHA-256 exact** |
| 07 | `07_canon_aplio_jpegls_lossless.dcm` | Canon Aplio i900 | `1.2.840.10008.1.2.4.80` (JPEG-LS Lossless) | `320×240 × 6`, 8-bit Mono | `US Region`: `0.27 mm` | **SHA-256 exact** |
| 08 | `08_philips_epiq_jpeg2000_lossless.dcm` | Philips EPIQ CVx | `1.2.840.10008.1.2.4.90` (JPEG 2000 Lossless) | `320×240 × 6`, 8-bit Mono | Анизотропный `US Region`: `[0.25, 0.30] mm` | **SHA-256 exact** |
| 09 | `09_philips_ie33_rle_lossless.dcm` | Philips iE33 | `1.2.840.10008.1.2.5` (RLE Lossless, RGB planar) | `320×240 × 4`, 8-bit RGB | `NominalScannedPixelSpacing`: `0.32 mm` | **SHA-256 exact** |
| 10 | `10_uncalibrated_handheld_us.dcm` | Портативный датчик без калибровки | `1.2.840.10008.1.2.1` | `256×192 × 1`, 8-bit Mono | `null` (**строго `px` до ручной калибровки**) | **SHA-256 exact** |
| 11 | `11_unsupported_mpeg2_stub.dcm` | Инкапсулированное видео MPEG-2 | `1.2.840.10008.1.2.4.100` (MPEG2 MP@ML) | `640×480 × 30` (1 ES фрагмент) | `PixelSpacing`: `0.30 mm` | **Безопасный `UnsupportedTransferSyntaxError`** |

Дополнительно для нагрузочного измерения FPS и памяти генерируются 6 полноразмерных 720p (`1280×720`, 30 кадров) cine-петель в `.spike-bench-data/` (`~41 MiB`, не коммитятся в Git).

---

## 3. Результаты измерения производительности и памяти

### 3.1. Холодный старт и размер клиентской сборки (`npm run build`, `docs/spike/results/bundle_size_bench.json`)
- **Production-бандл оболочки (`dist/assets/index-*.js` + CSS):** `292.9 kB` raw / **`88.7 kB` gzip** (+ `2.1 kB` gzip CSS).
- **Ядро расчётов `spike/domain-ts` отдельно:** `8.3 KiB` raw / **`3.2 KiB` gzip**.
- **Выделенный воркер `dicomDecode.worker.js`:** `53.6 kB` raw (загружается лениво после отрисовки UI).
- **Ленивые WASM-декодеры (подгружаются только по мере необходимости):**
  - `charls` (JPEG-LS): `45.5 KiB` gzip
  - `libjpeg-turbo` (JPEG Baseline): `68.4 KiB` gzip
  - `openjpeg` (JPEG 2000): `84.3 KiB` gzip
  - `openjph` (HTJ2K): `94.0 KiB` gzip

### 3.2. Скорость декодирования 720p (`1280×720`, 30 кадров) Cine: Модульный WASM vs DWV `0.36.4`
Полные данные сохранены в `docs/spike/results/dicom_engine_bench.json`:

| Кодек (`1280×720 × 30`) | Модульный WASM: среднее время кадра | Модульный WASM: полный пайплайн (Decode + W/L RGBA) FPS | DWV `0.36.4`: среднее время кадра | DWV FPS | Вывод против цели `25–30 fps` |
|---|---:|---:|---:|---:|---|
| Uncompressed Explicit LE | `2.60 ms` | **98.9 fps** | `0.68 ms` *(после 14.32 ms eager parse)* | >120 fps | Цель перевыполнена (>3×) |
| RLE Lossless | `3.24 ms` | **102.8 fps** | `1.59 ms` | >120 fps | Цель перевыполнена (>3×) |
| JPEG Baseline 8-bit | `4.14 ms` | **99.2 fps** | `10.97 ms` | 91.2 fps | WASM быстрее в **2.65×** |
| JPEG-LS Lossless | `7.70 ms` | **67.3 fps** | **Не поддерживается (краш `parse()`)** | — | Только модульный WASM проходит |
| JPEG 2000 Lossless | `31.04 ms` | **26.0 fps** | `102.68 ms` | **9.7 fps** | **Только WASM достигает 25–30 fps (быстрее в 3.3×)** |
| JPEG 2000 Lossy | `13.98 ms` | **47.6 fps** | `55.47 ms` | **18.0 fps** | **Только WASM достигает >30 fps (быстрее в 4.0×)** |

### 3.3. Дифференциальное тестирование формул (`tests/domain_differential.test.ts`)
- Сгенерировано **39 эталонных тест-векторов** (`tests/golden/domain_vectors_v1.json`) напрямую из Python-пакета `echo_personal_tool.domain` (`SonoForge@7f9f0564717a7343bd9c513ca0ebd414f17c5757`).
- Покрыты: `BSA (Du Bois)` + правила приоритета `manual > derived > missing`, `Teichholz (EDV, ESV, SV, LVEF, FS)`, `ASE Cube LVM & RWT`, `20-дисковый Simpson (A4C/A2C monoplane, biplane с правилом max(L4C, L2C)/20, построение 20 перпендикулярных хорд, полигональная планиметрия с анизотропным spacing)`, `Modified Bernoulli (4V²)`, `Continuity Equation (LVOT area, SV, CO, AVA, DVI, Qp/Qs)`, `Doppler VTI & HR`.
- **Результат:** `39 / 39` тестов проходят с расхождением `< 1e-9 .. 1e-6` за `23 ms`.

---

## 4. Чеклист прохождения Gate Этапа 0 (согласно Спецификации)

| Требование Gate Этапа 0 | Артефакт / Доказательство | Статус |
|---|---|---|
| Репрезентативный набор деидентифицированных ЭхоКГ DICOM разных синтаксисов и вендоров (0 PHI) | `spike/fixtures/01..11_*.dcm` + `tests/architecture_purity.test.ts` | ✅ Выполнено |
| Рабочий браузерный прототип импорта, чтения metadata, одиночного кадра и cine за чистыми портами | `spike/dicom-ts/ports.ts`, `spike/web-proto/App.tsx`, `spike/web-proto/worker/dicomDecode.worker.ts` | ✅ Выполнено |
| Сравнение Cornerstone3D и DWV на многокадровом УЗ, воркерах, памяти, лицензиях и бандле | `docs/spike/results/dicom_engine_bench.json`, `bundle_size_bench.json`, `ADR-001` | ✅ Выполнено |
| Пробный порт >= 3–5 базовых формул в TS + автоматический дифференциальный тест против Python | 8 модулей в `spike/domain-ts/`, 39 golden-векторов в `tests/domain_differential.test.ts` (`39/39 pass`) | ✅ Выполнено |
| Практическая проверка альтернативы Pyodide (cold start, колёса, память, вызов `domain`) | `spike/scripts/eval_pyodide.mjs`, `docs/spike/results/pyodide_eval.json`, `ADR-002` | ✅ Выполнено |
| Зафиксированы ADR по DICOM-движку, runtime расчётов, браузерам, локальному хранилищу и GPL-3.0 | `docs/adr/ADR-001` .. `ADR-005` | ✅ Выполнено |
| Несовместимые синтаксисы (MPEG-2/H.264/HEVC) имеют явную стратегию и безопасный fallback | `UnsupportedTransferSyntaxError` + карточка fallback в UI + `ADR-001 §4` | ✅ Выполнено |
| Никаких ONNX/ML-моделей, AI-сегментации и Speckle Tracking; настольный репозиторий не изменён | Проверено `tests/architecture_purity.test.ts` и `npm audit --omit=dev` (0 CVE) | ✅ Выполнено |

---

## 5. План перехода к Этапу 1 (Каркас репозитория, доменное ядро и CI)

На основе успешного завершения Этапа 0 рекомендована следующая последовательность работ Этапа 1:
1. Реорганизовать `Sonoforge_web` в npm-workspaces монорепозиторий (`apps/web`, `packages/domain`, `packages/dicom`, `packages/storage`, `packages/test-vectors`), перенеся проверенные модули из `spike/domain-ts/` и `spike/dicom-ts/` без потери 68 существующих тестов.
2. Перенести оставшиеся чистые расчётные модули из `docs/PARITY_CATALOG.md` (`chamber_simpson`, `la_area_length`, `pulmonary_hemodynamics`, `teichholz_mmode`) с расширением `domain_vectors_v1.json`.
3. Реализовать адаптер `packages/storage` (`IndexedDB` + `BroadcastChannel` + мигратор схем согласно `ADR-004`).
4. Подключить headless браузерный E2E-контур (Playwright) поверх существующего пайплайна `.github/workflows/spike-ci.yml`.
