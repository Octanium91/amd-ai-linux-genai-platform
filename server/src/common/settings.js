// Platform settings changed from the UI (data/state/settings.json). The web container writes them,
// the worker reads them when a job starts, so no restart is needed after a change.
import { readJson, statePath, writeJson } from './store.js';

const FILE = statePath('settings.json');

export const DEFAULT_SETTINGS = {
  // Generation telemetry: a JSON document per job in /data/telemetry, off by default
  telemetry: { enabled: false, maxMb: 250 },
};

export function readSettings() {
  const s = readJson(FILE, {});
  return { telemetry: { ...DEFAULT_SETTINGS.telemetry, ...(s.telemetry || {}) } };
}

export function writeSettings(settings) {
  writeJson(FILE, settings);
}
