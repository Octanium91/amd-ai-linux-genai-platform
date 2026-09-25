import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Small JSON state files in /data/state with atomic writes
export function statePath(name) {
  return path.join(config.dirs.state, name);
}

export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // Never replace a damaged state file silently: keep it aside for recovery and say so
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
    } catch {}
    console.error(`[state] ${path.basename(file)} is damaged (${e.message}); kept as ${path.basename(aside)}, starting empty`);
    return fallback;
  }
}

export function writeJson(file, value, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

// Debounced writes for frequently changing data (job progress). Important changes (now = true)
// are written synchronously; the frequent progress writes are asynchronous, so a slow disk under
// memory pressure does not stall the event loop. A progress write that finishes after a newer
// synchronous one is dropped instead of overwriting it.
export function debouncedWriter(file, getValue, delay = 2000) {
  let timer = null;
  let version = 0;
  // At most one asynchronous write at a time: two writes into the same temporary file on a slow
  // disk would interleave and leave broken JSON. Changes made meanwhile are written right after.
  let writing = false;
  let dirty = false;
  const writeLater = async () => {
    if (writing) {
      dirty = true;
      return;
    }
    writing = true;
    const tmp = file + '.progress.tmp';
    try {
      do {
        dirty = false;
        const mine = ++version;
        await fs.promises.writeFile(tmp, JSON.stringify(getValue(), null, 1));
        if (mine === version) fs.renameSync(tmp, file);
        else await fs.promises.rm(tmp, { force: true });
      } while (dirty);
    } catch (e) {
      console.error(`[state] could not write ${path.basename(file)}: ${e.message}`);
    } finally {
      writing = false;
    }
  };
  return (now = false) => {
    if (now) {
      if (timer) clearTimeout(timer);
      timer = null;
      version++;
      writeJson(file, getValue());
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        writeLater();
      }, delay);
    }
  };
}
