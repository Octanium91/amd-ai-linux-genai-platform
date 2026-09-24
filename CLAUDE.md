# AMD AI Linux GenAI Platform — conventions

## Language

- **Everything in the repository is written in English:** code, identifiers, comments, commit messages, documentation (`README.md`, `docs/`), catalog data (`catalog/*.json`), script output and server messages.
- **The web UI defaults to English.** Ukrainian (`uk`) and Russian (`ru`) are additional languages.
  - UI strings go through `t()` from `web/src/i18n.js`; the English text itself is the key.
  - Translations live in `web/src/locales/uk.js` and `web/src/locales/ru.js`. A missing translation falls back to English.
  - Every new UI string must get `uk` and `ru` translations in the same change.
  - Server error messages are plain English; the UI translates them via the same dictionaries when a translation exists.
  - Catalog entries (`models.json`, `presets.json`, `packs.json`) keep `name`/`description` in English and may carry translations in an `i18n` field: `{"uk": {"name": "…", "description": "…"}, "ru": {…}}`.

## Platform

- Target hardware: AMD Ryzen AI APUs (Strix Point, Krackan Point, Strix Halo) on Linux. Acceleration is **Vulkan only** (Mesa RADV via stable-diffusion.cpp). Do not introduce ROCm.
- Reference machine for measurements: Sapphire EDGE AI 370 (Ryzen AI 9 HX 370, Radeon 890M, 32 GB, GTT 24 GB, Debian 13). Benchmarks in `docs/benchmarks.md` must be real measurements, not estimates.
- Models are never baked into the image; they are downloaded at runtime from `catalog/models.json` into `MODELS_PATH`. Results go to `OUTPUT_PATH`, state to `DATA_PATH`.

## Deployment

- Before restarting a running deployment, check that no job is `running` or `queued` in `data/state/jobs.json` — a restart aborts the current generation.
