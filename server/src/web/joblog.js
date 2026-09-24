// sd-cli logs are written by the worker to /data/state/logs; the web container reads them directly,
// so logs stay viewable even while the worker restarts.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../common/config.js';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function jobLog(id, tail) {
  const file = path.join(config.dirs.logs, path.basename(id) + '.log');
  let text = '';
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, st.size - len);
    fs.closeSync(fd);
    text = b.toString('utf8');
  } catch {}
  return text.replace(ANSI, '').split(/[\r\n]+/).filter((l) => l.trim()).slice(-tail);
}
