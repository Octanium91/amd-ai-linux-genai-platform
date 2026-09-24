# Модели и режимы

Платформа не хранит модели в образе. Их список с источниками лежит в [catalog/models.json](../catalog/models.json), а скачиваются они в каталог `MODELS_PATH` на хосте (по умолчанию `./models`). При холодном старте каталог пуст: раздел «Модели» или кнопка «Скачать» в форме режима загружает недостающее. Загрузка продолжается после обрыва, размер проверяется, при необходимости файл конвертируется в формат stable-diffusion.cpp. Удалить модель можно там же, если она не занята текущей генерацией.

Скачивать и удалять модели может только администратор.

## Каталог по умолчанию

| id | Модель | Для чего | Размер | Лицензия |
|---|---|---|---|---|
| `realistic-vision-v6` | [Realistic Vision 6.0 B1](https://huggingface.co/SG161222/Realistic_Vision_V6.0_B1_noVAE) (SD 1.5, fp16) | изображения, AnimateLCM, AnimateDiff | 2.0 ГБ | CreativeML OpenRAIL-M |
| `sd-vae-ft-mse` | [SD VAE ft-MSE 840000](https://huggingface.co/stabilityai/sd-vae-ft-mse-original) | VAE для SD 1.5 | 0.3 ГБ | MIT |
| `animatelcm-mm` | [AnimateLCM](https://huggingface.co/wangfuyun/AnimateLCM) — модуль движения | быстрое видео | 0.9 ГБ | не указана в карточке |
| `animatelcm-lora` | AnimateLCM — LoRA | быстрое видео | 0.1 ГБ | не указана в карточке |
| `animatediff-v3-mm` | [AnimateDiff v3](https://huggingface.co/guoyww/animatediff) — модуль движения (переупаковка [conrevo](https://huggingface.co/conrevo/AnimateDiff-A1111)) | детальное видео | 0.8 ГБ | Apache-2.0 |
| `animatediff-v3-adapter` | AnimateDiff v3 Domain Adapter LoRA | детальное видео | 0.1 ГБ | Apache-2.0 |
| `wan22-ti2v-5b-q8` | [Wan 2.2 TI2V 5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B), GGUF Q8_0 ([QuantStack](https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF)) | видео со связным движением | 5.0 ГБ | Apache-2.0 |
| `wan22-vae` | Wan 2.2 VAE | Wan 2.2 | 1.3 ГБ | Apache-2.0 |
| `umt5-xxl-q8` | [UMT5-XXL encoder](https://huggingface.co/city96/umt5-xxl-encoder-gguf), GGUF Q8_0 | текстовый энкодер Wan | 5.6 ГБ | Apache-2.0 |
| `wan21-t2v-1.3b` | [Wan 2.1 T2V 1.3B](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B) | лёгкая Wan (экспериментально) | 2.6 ГБ | Apache-2.0 |
| `wan21-vae` | Wan 2.1 VAE | Wan 2.1 | 0.2 ГБ | Apache-2.0 |

Лицензии взяты из карточек моделей на Hugging Face. Проверяйте их сами, если собираетесь использовать результаты коммерчески.

## Режимы (пресеты)

Режим — это готовая связка моделей и параметров. Описания лежат в [catalog/presets.json](../catalog/presets.json).

| Режим | Тип | Модели | По умолчанию | Время на Radeon 890M |
|---|---|---|---|---|
| Realistic Vision 6 · фото | изображение | RV6 + VAE | 512×768, 25 шагов, dpm++2m karras, CFG 5.5 | ~1 мин на картинку |
| AnimateLCM · Realistic Vision | видео | RV6 + VAE + AnimateLCM + LoRA | 512×512, 16 кадров (2 с при 8 к/с → 24 fps), 6 шагов, lcm, CFG 1 | **~2.5 мин** |
| AnimateDiff v3 · Realistic Vision | видео | RV6 + VAE + AnimateDiff v3 + adapter | 512×512, 16 кадров, 20 шагов, euler, CFG 8 | ~16 мин |
| Wan 2.2 TI2V 5B | видео | Wan 2.2 5B + VAE + UMT5 | 832×480, 49 кадров при 24 к/с, 25 шагов | часы (для Strix Halo) |
| Wan 2.1 T2V 1.3B | видео | Wan 2.1 1.3B + VAE + UMT5 | 832×480, 16 к/с | не замерено (экспериментально) |

Качество «Черновик / Стандарт / Высокое» задаёт число шагов, которое у каждого режима своё (см. `defaults.quality`).

## Конвертация AnimateLCM

stable-diffusion.cpp ожидает модуль движения в исходном формате AnimateDiff, а на Hugging Face AnimateLCM есть в двух видах:

- `AnimateLCM_sd15_t2v.ckpt` (1.8 ГБ, pickle): для чтения нужен PyTorch, и в нём нет буферов `pos_encoder.pe`, которые sd.cpp ищет в файле.
- `diffusion_pytorch_model.fp16.safetensors` (0.9 ГБ, формат diffusers): другие имена тензоров и одна таблица `pos_embed.pe` на блок.

Платформа качает второй файл и переупаковывает его потоково, без загрузки в память (`animatediff-from-diffusers` в [server/src/safetensors.js](../server/src/safetensors.js)):

- `attn1`/`attn2` → `attention_blocks.0`/`attention_blocks.1`;
- `norm1`/`norm2`/`norm3` → `norms.0`/`norms.1`/`ff_norm`;
- всё остальное получает префикс `temporal_transformer.`;
- `pos_embed.pe` копируется в `pos_encoder.pe` обоих блоков внимания.

Результат — 588 тензоров fp16, как у эталонной конвертации через PyTorch. Совпадение проверено потензорно на тестовой машине.

## Свои модели и режимы

Не меняя образ, можно добавить свои файлы. Они объединяются с каталогом по `id`, запись с тем же `id` переопределяет встроенную.

`data/state/models.local.json`:
```json
[
  {
    "id": "dreamshaper-8",
    "name": "DreamShaper 8 (SD 1.5)",
    "category": "checkpoint",
    "file": "checkpoints/dreamshaper_8.safetensors",
    "url": "https://huggingface.co/<repo>/resolve/main/dreamshaper_8.safetensors",
    "size": 2132625894,
    "license": "CreativeML OpenRAIL-M",
    "homepage": "https://huggingface.co/<repo>"
  }
]
```
`size` в байтах — по нему проверяется целостность загрузки (посмотреть можно в заголовке `Content-Length`). Если модель уже лежит в `MODELS_PATH` по пути `file`, она сразу считается установленной, `url` можно не указывать.

`data/state/presets.local.json` — режим строится из моделей по ролям:
```json
[
  {
    "id": "img-dreamshaper",
    "kind": "image",
    "name": "DreamShaper 8",
    "models": { "model": "dreamshaper-8", "vae": "sd-vae-ft-mse" },
    "defaults": { "width": 512, "height": 768, "cfg": 6, "sampler": "dpm++2m", "quality": { "draft": 12, "normal": 25, "high": 40 } },
    "extraArgs": ["--scheduler", "karras", "--diffusion-fa"]
  }
]
```

Роли, которые превращаются во флаги `sd-cli`: `model` (`--model`), `diffusion` (`--diffusion-model`), `high_noise`, `vae`, `t5xxl`, `clip_vision`, `motion_module`. Роли с другими именами (например, `lora`) нужны только для проверки наличия файлов; саму LoRA подключает `promptSuffix` вида `<lora:имя:вес>` вместе с `loraDir`. Поля видеорежимов: `nativeFps`, `frameRule` (`exact` или правило Wan 4n+1), `minFrames`/`maxFrames`, `outFps`, `flowShift`.

Закрытые (gated) модели Hugging Face скачиваются с токеном `HF_TOKEN` из `.env`.
