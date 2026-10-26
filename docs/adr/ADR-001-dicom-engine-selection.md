# ADR-001: Выбор клиентского DICOM-движка и кодек-архитектуры

- **Статус:** Принято (Accepted)
- **Дата:** 2026-10-26
- **Контекст:** Этап 0 технического спайка SonoForge Web (Спецификация §4, §5.1, Этап 0)

---

## 1. Контекст и проблема

SonoForge Web должен локально в браузере (без загрузки файлов пациента на сервер) импортировать одиночные и многокадровые эхокардиографические DICOM-исследования разных производителей УЗ-сканеров (GE Vivid, Philips EPIQ/iE33, Siemens Acuson, Samsung, Mindray, Canon), извлекать калибровку (`SequenceOfUltrasoundRegions (0018,6011)` и стандартные spacing-теги), обеспечивать плавный cine-просмотр (цель: 25–30 fps на 720p) и сохранять исходный декодированный буфер кадра без потерь отдельно от display-преобразований (`Window/Level` → RGBA).

На Этапе 0 эмпирически протестированы три архитектурных кандидата:
- **Кандидат C1 — Монолитный стек Cornerstone3D** (`@cornerstonejs/core@5.13.2` + `@cornerstonejs/dicom-image-loader@5.13.2`).
- **Кандидат C2 — DWV (`dwv@0.36.4`)** с собственным парсером и JS-воркерами декодирования.
- **Кандидат C3 — Модульный адаптер (`dicom-parser@1.8.21` + ленивые WASM-кодеки `@cornerstonejs/codec-*`)** за собственными портами `DicomFileReader`, `FrameSource`, `SeriesAssembler` (`spike/dicom-ts/`).

---

## 2. Эмпирические результаты бенчмарков

Измерения воспроизводятся командами `npm run spike:bench-dicom`, `npm run spike:bench-bundles` и `npm test` (артефакты: `docs/spike/results/dicom_engine_bench.json`, `docs/spike/results/bundle_size_bench.json`).

### 2.1. Производительность декодирования cine 720p (`1280×720`, 30 кадров)

| Transfer Syntax | Размер 30f | C3: Модульный WASM (parse / avg decode / полный пайплайн FPS) | C2: DWV 0.36.4 (parse / avg decode / FPS) | Побитовая точность с `pydicom` |
|---|---:|---|---|---|
| Explicit VR Little Endian (`.1.2.1`) | 26.37 MiB | `0.22 ms` / `2.60 ms` / **98.9 fps** | `14.32 ms` (65× медленнее parse) / `0.68 ms` | **100% SHA-256 exact** |
| RLE Lossless (`.1.2.5`) | 7.84 MiB | `2.98 ms` / `3.24 ms` / **102.8 fps** | `3.73 ms` / `1.59 ms` | **100% SHA-256 exact** |
| JPEG Baseline 8-bit (`.4.50`) | 1.70 MiB | `0.39 ms` / `4.14 ms` (`libjpeg-turbo` WASM) / **99.2 fps** | `3.67 ms` / `10.97 ms` (**2.65× медленнее**) / 91.2 fps | Lossy (`YBR_FULL_422` проверен) |
| JPEG Lossless P14SV1 (`.4.70`) | фикстура `06` | `0.15 ms` / `2.8 ms` / **>120 fps** | Поддерживается (JS) | **100% SHA-256 exact** |
| JPEG-LS Lossless (`.4.80`) | 2.22 MiB | `0.50 ms` / `7.70 ms` (`charls` WASM) / **67.3 fps** | **НЕ ПОДДЕРЖИВАЕТСЯ** (исключение в `DicomParser.parse()`) | **100% SHA-256 exact** |
| JPEG 2000 Lossless (`.4.90`) | 2.53 MiB | `2.32 ms` / `31.04 ms` (`openjpeg` WASM) / **26.0 fps** | `3.69 ms` / `102.68 ms` (**3.3× медленнее**, **9.7 fps**) | **100% SHA-256 exact** |
| JPEG 2000 Lossy (`.4.91`) | 0.33 MiB | `1.52 ms` / `13.98 ms` (`openjpeg` WASM) / **47.6 fps** | `3.10 ms` / `55.47 ms` (**4.0× медленнее**, **18.0 fps**) | Lossy |
| HTJ2K (`.4.201`–`.203`) | WASM готов | Поддерживается (`openjph` WASM) | **НЕ ПОДДЕРЖИВАЕТСЯ** | Поддерживается |

### 2.2. Размер бандла и безопасность цепочки поставок (`npm audit`)

| Показатель | C1: Monolithic Cornerstone3D | C2: DWV `0.36.4` | C3: Modular `dicom-parser` + Lazy WASM |
|---|---:|---:|---:|
| Начальный JS-чанк парсера/вьюера (gzip) | **829.8 KiB** (`vtk.js` + `dcmjs`) | **223.8 KiB** (вкл. `konva`) | **13.2 KiB** (только парсер и порты) |
| Полный вес со всеми кодеками (gzip) | **1,562.6 KiB** (вкл. `jpegxlwasm` 368 KiB) | **246.5 KiB** (чистый JS, без JPEG-LS/HTJ2K) | **350.1 KiB** (кодеки грузятся лениво по требованию) |
| Уязвимости `npm audit` (runtime) | **9 уязвимостей (6 High, 3 Moderate)** из-за `dcmjs -> adm-zip<=0.6.0` | **0** | **0** |
| Совместимость с Node LTS (`v22`) | Предупреждение `EBADENGINE` (`codec-libjxl` требует `node >=24`) | Совместимо | Совместимо |
| Лицензия | MIT | GPL-3.0 | MIT + BSD-2/3 / IJG (совместимо с GPL-3.0) |

---

## 3. Решение

Принят **Кандидат C3**: собственная тонкая адаптерная прослойка (`packages/dicom`, прототип в `spike/dicom-ts/`) за доменными интерфейсами `DicomFileReader`, `FrameSource` и `SeriesAssembler`, использующая:
1. `dicom-parser@1.8.21` для быстрого чтения метаданных, `SequenceOfUltrasoundRegions (0018,6011)` и таблицы смещений кадров без eager-аллокации всех кадров при открытии файла.
2. Изолированные официальные WASM-кодеки `@cornerstonejs/codec-libjpeg-turbo-8bit`, `@cornerstonejs/codec-charls`, `@cornerstonejs/codec-openjpeg`, `@cornerstonejs/codec-openjph` и `@cornerstonejs/jpeg-lossless-decoder-js`, загружаемые **лениво (`import()`) внутри выделенного Web Worker** только при встрече соответствующего `TransferSyntaxUID`.
3. Нативный 2D/HiDPI `<canvas>` рендерер с инвертируемой матрицей координат вместо тяжёлого 3D WebGL-графа `@kitware/vtk.js`.

### Почему отклонены альтернативы
- **C1 (полный `@cornerstonejs/core` + `@cornerstonejs/dicom-image-loader`):** тянет `3.02 MiB` исходного JS (`@kitware/vtk.js` для 3D MPR/Volume rendering, ненужного для 2D ЭхоКГ) и `dcmjs`, вносящий **6 High CVE** через устаревший `adm-zip`. При этом сами высококачественные WASM-кодеки Cornerstone опубликованы отдельными чистыми пакетами без зависимостей — мы используем именно их напрямую.
- **C2 (`dwv@0.36.4`):** не поддерживает `JPEG-LS (.80/.81)` и `HTJ2K (.201-.203)`, декодирует JPEG 2000 на чистом JS в 3.3–4.0× медленнее (`9.7 fps` вместо целевых `25–30 fps` на 720p cine) и на этапе `DicomParser.parse()` синхронно нарезает `ArrayBuffer` для всех кадров клипа.

---

## 4. Явная стратегия для неподдерживаемых синтаксисов (MPEG-2 / H.264 / HEVC)

Инкапсулированные видеопотоки (`1.2.840.10008.1.2.4.100`..`.108`: MPEG-2, MPEG-4 AVC/H.264, HEVC/H.265) классифицируются в матрице совместимости как **неподдерживаемые для покадровых локальных измерений в v1**:
1. `DicomParserFileReader` безопасно читает метаданные и корректно учитывает однофрагментный элементарный видеопоток (`BasicOffsetTable.length === 1` при `NumberOfFrames > 1`), помечая серию `supportedInBrowser: false`.
2. При выборе серии выбрасывается типизированная ошибка `UnsupportedTransferSyntaxError` без падения воркера или потери текущей сессии измерений.
3. **Fallback-пути:**
   - при работе через `DICOMweb` (Этап 6) — запрос серверного рендеринга `WADO-RS Rendered` для обзорного просмотра с блокировкой калибровочно-чувствительных измерений при отсутствии подтверждённого spacing;
   - при локальном импорте — понятная инструкция экспортировать серию со сканера/PACS в `Explicit VR Little Endian`, `RLE Lossless`, `JPEG-LS` или `JPEG 2000 Lossless` (либо офлайн-транскодирование `gdcmconv --raw` / `dcmtk`).
