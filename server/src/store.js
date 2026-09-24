import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Маленькие JSON-файлы состояния в /data/state с атомарной записью
export function statePath(name) {
  return path.join(config.dirs.state, name);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

// Отложенная запись для часто меняющихся данных (прогресс задач)
export function debouncedWriter(file, getValue, delay = 2000) {
  let timer = null;
  return (now = false) => {
    if (now) {
      if (timer) clearTimeout(timer);
      timer = null;
      writeJson(file, getValue());
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        writeJson(file, getValue());
      }, delay);
    }
  };
}
