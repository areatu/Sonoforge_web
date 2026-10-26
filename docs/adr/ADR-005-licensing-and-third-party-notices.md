# ADR-005: Лицензионная модель GPL-3.0 и аудит сторонних компонентов

- **Статус:** Принято (Accepted)
- **Дата:** 2026-10-26
- **Контекст:** Этап 0 технического спайка SonoForge Web (Спецификация §1, §5.1, §7, Этап 0)

---

## 1. Контекст и правовая преемственность

Базовый настольный проект [`areatu/SonoForge`](https://github.com/areatu/SonoForge) распространяется на условиях **GNU General Public License v3.0 (`GPL-3.0`)**. Поскольку SonoForge Web напрямую портирует доменные алгоритмы, правила резолюции калибровки, структуру эхокардиографических расчётов и протоколов отчётности из `SonoForge`, репозиторий `areatu/Sonoforge_web` является производным/родственным свободным проектом и лицензируется под **`GPL-3.0-or-later` (`LICENSE`)**.

---

## 2. Аудит лицензионной совместимости runtime-зависимостей

Все выбранные на Этапе 0 runtime-пакеты проверены на полную совместимость с `GPL-3.0`:

| Пакет | Версия | Лицензия | Назначение в SonoForge Web | Совместимость с GPL-3.0 |
|---|---|---|---|---|
| `react`, `react-dom` | `^19.2.5` | `MIT` | UI-оболочка и управление вьюпортом | Да (пермиссивная) |
| `dicom-parser` | `^1.8.21` | `MIT` | Парсинг DICOM Part 10, VR-тегов и инкапсулированных фрагментов | Да (пермиссивная) |
| `@cornerstonejs/codec-libjpeg-turbo-8bit` | `^1.2.4` | `MIT` (обёртка) + `BSD-3-Clause / IJG / zlib` (`libjpeg-turbo`) | WASM-декодер JPEG Baseline 8-bit | Да (GPL-3.0 совместима с BSD-3/IJG/zlib) |
| `@cornerstonejs/codec-charls` | `^1.2.6` | `MIT` (обёртка) + `BSD-3-Clause` (`CharLS`) | WASM-декодер JPEG-LS Lossless / Near-Lossless | Да (пермиссивная) |
| `@cornerstonejs/codec-openjpeg` | `^1.2.5` | `MIT` (обёртка) + `BSD-2-Clause` (`OpenJPEG`) | WASM-декодер JPEG 2000 Lossless / Lossy | Да (пермиссивная) |
| `@cornerstonejs/codec-openjph` | `^2.6.2` | `MIT` (обёртка) + `BSD-2-Clause` (`OpenJPH`) | WASM-декодер High-Throughput JPEG 2000 (HTJ2K) | Да (пермиссивная) |
| `@cornerstonejs/jpeg-lossless-decoder-js` | `^1.1.3` | `MIT` / `BSD-3-Clause` | Декодер JPEG Lossless Process 14 SV1 | Да (пермиссивная) |

*Примечание по dev/benchmark-зависимостям Этапа 0:* пакеты `@cornerstonejs/core`, `@cornerstonejs/dicom-image-loader`, `dwv` (`GPL-3.0`) и `pyodide` (`MPL-2.0`) находятся исключительно в `devDependencies` для воспроизводимого прогона сравнительных бенчмарков Этапа 0 (`npm run spike:*`) и **не входят** в клиентскую production-сборку `dist/`. На Этапе 1 после архивации спайковых бенчмарков тяжёлые сравнительные пакеты могут быть вынесены в изолированный `benchmarks/package.json`.

---

## 3. Обязательства при распространении и публикации сборок

1. Сохранять файл `LICENSE` (`GPL-3.0`) в корне репозитория и включать файл `THIRD_PARTY_NOTICES.md` при выпуске публичных релизов (Этап 7), содержащий тексты уведомлений об авторских правах `SonoForge`, `dicom-parser`, `CharLS`, `OpenJPEG`, `OpenJPH`, `libjpeg-turbo` и `React`.
2. Предоставлять ссылку на открытый исходный код `areatu/Sonoforge_web` в интерфейсе приложения («О программе / Лицензия GPL-3.0»).
3. Не включать проприетарные бинарные кодеки, закрытые SDK или лицензионно несовместимые компоненты без явного юридического пересмотра настоящего ADR.
