// Settings and generation telemetry for administrators: /api/settings and /api/telemetry.
// Telemetry documents are written by the worker to /data/telemetry (see server/src/worker/telemetry.js);
// here they are listed, downloaded (one, or all as a single JSON array) and removed.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../common/config.js';
import { readSettings, writeSettings } from '../common/settings.js';

const DIR = config.dirs.telemetry;
const NAME = /^[\w.-]+\.json$/;

function listDocuments() {
  let files = [];
  try {
    files = fs.readdirSync(DIR).filter((f) => NAME.test(f));
  } catch {}
  return files
    .map((f) => {
      const st = fs.statSync(path.join(DIR, f), { throwIfNoEntry: false });
      return st && { name: f, size: st.size, modifiedAt: st.mtimeMs, jobId: f.split('_')[1]?.replace(/\.json$/, '') || null };
    })
    .filter(Boolean)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function settingsRoutes(api, requireAdmin) {
  api.get('/settings', requireAdmin, (req, res) => res.json(readSettings()));

  api.put('/settings', requireAdmin, (req, res) => {
    const t = req.body?.telemetry || {};
    const maxMb = Math.round(Number(t.maxMb));
    if (!Number.isFinite(maxMb) || maxMb < 10 || maxMb > 100000) {
      return res.status(400).json({ error: 'The telemetry limit must be between 10 and 100000 MB' });
    }
    const settings = { ...readSettings(), telemetry: { enabled: t.enabled === true, maxMb } };
    writeSettings(settings);
    res.json(settings);
  });

  api.get('/telemetry', requireAdmin, (req, res) => {
    const docs = listDocuments();
    res.json({ documents: docs.slice(0, 50), count: docs.length, bytes: docs.reduce((s, d) => s + d.size, 0), settings: readSettings().telemetry });
  });

  // All documents as one JSON array, streamed so large collections do not sit in memory
  api.get('/telemetry/export', requireAdmin, async (req, res) => {
    const docs = listDocuments().reverse();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="telemetry-${stamp}.json"`);
    res.write('[');
    let first = true;
    for (const d of docs) {
      let text;
      try {
        text = await fs.promises.readFile(path.join(DIR, d.name), 'utf8');
        JSON.parse(text);
      } catch {
        continue;
      }
      res.write((first ? '\n' : ',\n') + text);
      first = false;
    }
    res.end('\n]\n');
  });

  api.get('/telemetry/:name', requireAdmin, (req, res) => {
    if (!NAME.test(req.params.name)) return res.status(400).json({ error: 'Not found' });
    const file = path.join(DIR, req.params.name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    res.download(file, req.params.name);
  });

  api.delete('/telemetry', requireAdmin, (req, res) => {
    let removed = 0;
    for (const d of listDocuments()) {
      fs.rmSync(path.join(DIR, d.name), { force: true });
      removed++;
    }
    res.json({ removed });
  });
}
