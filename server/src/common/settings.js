// Platform settings changed from the UI (data/state/settings.json). The web container writes them,
// the worker reads them when a job starts, so no restart is needed after a change.
import { readJson, statePath, writeJson } from './store.js';

const FILE = statePath('settings.json');

export const DEFAULT_SETTINGS = {
  // Generation telemetry: a JSON document per job in /data/telemetry, off by default
  telemetry: { enabled: false, maxMb: 250 },
  // The "to prompt" assistant: an Ollama server turns the user's idea into a prompt for the mode.
  // host.docker.internal is the Docker host (see docker-compose.yml), where Ollama usually runs.
  // storyboardModel writes the scenes of long videos: a story of dozens of parts needs a larger model
  // than a single prompt does; empty means the same model
  promptAssistant: { enabled: false, url: 'http://host.docker.internal:11434', model: 'dolphin-llama3', storyboardModel: 'dolphin-llama3' },
};

export function readSettings() {
  const s = readJson(FILE, {});
  return {
    telemetry: { ...DEFAULT_SETTINGS.telemetry, ...(s.telemetry || {}) },
    promptAssistant: { ...DEFAULT_SETTINGS.promptAssistant, ...(s.promptAssistant || {}) },
  };
}

export function writeSettings(settings) {
  writeJson(FILE, settings);
}
