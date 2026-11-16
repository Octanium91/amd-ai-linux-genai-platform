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
  // than a single prompt does; empty means the same model.
  // device says where the language model runs: 'npu' (a FastFlowLM server at npuUrl with npuModel:
  // it takes no GPU memory and slows a running generation the least), 'gpu' or 'cpu' (the Ollama
  // server, with the model kept off the GPU for 'cpu'), or 'auto': the NPU when its server
  // answers, the GPU otherwise
  promptAssistant: {
    enabled: false, url: 'http://host.docker.internal:11434', model: 'dolphin-llama3', storyboardModel: 'dolphin-llama3',
    device: 'auto', npuUrl: 'http://host.docker.internal:52625', npuModel: 'qwen3:4b',
  },
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
