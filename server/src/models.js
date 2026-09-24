// Каталог моделей: какие файлы нужны, откуда их скачать и как подготовить.
// Платформа сама докачивает недостающее (с продолжением после обрыва) и умеет удалять.
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { postprocessors } from './safetensors.js';
import { readJson, statePath } from './store.js';

const MODELS = config.dirs.models;

function mergeById(base, local) {
  const map = new Map(base.map((x) => [x.id, x]));
  for (const x of local) map.set(x.id, { ...(map.get(x.id) || {}), ...x });
  return [...map.values()];
}

export function loadCatalog() {
  return mergeById(
    readJson(path.join(config.catalogDir, 'models.json'), []),
    readJson(statePath('models.local.json'), []),
  );
}

export const modelPath = (entry) => path.join(MODELS, entry.file);

// Состояние загрузок живёт в памяти: id -> { status, received, total, rate, error, abort }
const downloads = new Map();
const queue = [];
let active = null;

export function isInstalled(entry) {
  return fs.existsSync(modelPath(entry)) && !downloads.has(entry.id);
}

export function modelStatus(entry) {
  const d = downloads.get(entry.id);
  if (d) {
    const { abort, ...rest } = d;
    return rest;
  }
  try {
    const st = fs.statSync(modelPath(entry));
    return { status: 'installed', installedSize: st.size };
  } catch {
    let partial = 0;
    try {
      partial = fs.statSync(modelPath(entry) + '.part').size;
    } catch {}
    return { status: 'missing', partial };
  }
}

export function diskUsage() {
  try {
    const s = fs.statfsSync(MODELS);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return {};
  }
}

export function enqueueDownloads(ids) {
  const catalog = loadCatalog();
  const added = [];
  for (const id of ids) {
    const entry = catalog.find((m) => m.id === id);
    if (!entry) throw new Error(`Нет модели ${id} в каталоге`);
    if (downloads.has(id) || isInstalled(entry)) continue;
    downloads.set(id, { status: 'queued', received: 0, total: entry.size || 0, rate: 0 });
    queue.push(entry);
    added.push(id);
  }
  pump();
  return added;
}

export function cancelDownload(id) {
  const d = downloads.get(id);
  if (!d) return false;
  const i = queue.findIndex((e) => e.id === id);
  if (i >= 0) queue.splice(i, 1);
  d.abort?.abort();
  downloads.delete(id);
  return true;
}

export function deleteModel(entry) {
  cancelDownload(entry.id);
  for (const f of [modelPath(entry), modelPath(entry) + '.part', modelPath(entry) + '.tmp']) {
    fs.rmSync(f, { force: true });
  }
}

async function pump() {
  if (active || !queue.length) return;
  const entry = queue.shift();
  active = entry.id;
  const d = downloads.get(entry.id);
  try {
    await download(entry, d);
    downloads.delete(entry.id);
    console.log(`[models] ${entry.id}: готово`);
  } catch (e) {
    if (downloads.get(entry.id) === d) {
      d.status = 'error';
      d.error = e.name === 'AbortError' ? 'отменено' : e.message;
      console.error(`[models] ${entry.id}: ${d.error}`);
    }
  } finally {
    active = null;
    pump();
  }
}

async function download(entry, d) {
  const dest = modelPath(entry);
  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  d.abort = new AbortController();
  d.status = 'downloading';

  let start = 0;
  try {
    start = fs.statSync(part).size;
  } catch {}
  if (entry.size && start > entry.size) start = 0;

  if (!entry.size || start < entry.size) {
    const headers = {};
    if (start) headers.Range = `bytes=${start}-`;
    if (config.hfToken && new URL(entry.url).hostname.endsWith('huggingface.co')) {
      headers.Authorization = `Bearer ${config.hfToken}`;
    }
    const res = await fetch(entry.url, { headers, signal: d.abort.signal, redirect: 'follow' });
    if (res.status === 200 && start) start = 0; // сервер не поддержал Range — качаем заново
    if (!res.ok) throw new Error(`HTTP ${res.status} при загрузке ${entry.url}`);
    const len = Number(res.headers.get('content-length')) || 0;
    d.total = entry.size || start + len;
    d.received = start;

    let last = { t: Date.now(), bytes: start };
    const counter = new Transform({
      transform(chunk, enc, cb) {
        d.received += chunk.length;
        const now = Date.now();
        if (now - last.t >= 1000) {
          d.rate = ((d.received - last.bytes) * 1000) / (now - last.t);
          last = { t: now, bytes: d.received };
        }
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body),
      counter,
      fs.createWriteStream(part, { flags: start ? 'a' : 'w' }),
      { signal: d.abort.signal },
    );
  }

  const got = fs.statSync(part).size;
  if (entry.size && got !== entry.size) {
    throw new Error(`размер не совпал: ${got} вместо ${entry.size}, запустите загрузку ещё раз`);
  }

  if (entry.postprocess) {
    d.status = 'processing';
    const fn = postprocessors[entry.postprocess];
    if (!fn) throw new Error(`неизвестная обработка ${entry.postprocess}`);
    const tmp = dest + '.tmp';
    fn(part, tmp);
    fs.renameSync(tmp, dest);
    fs.rmSync(part, { force: true });
  } else {
    fs.renameSync(part, dest);
  }
}
