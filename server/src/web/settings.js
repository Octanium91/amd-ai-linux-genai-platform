// Settings and generation telemetry for administrators: /api/settings and /api/telemetry.
// Telemetry documents are written by the worker to /data/telemetry (see server/src/worker/telemetry.js);
// here they are listed, downloaded (one, or all as a single JSON array, optionally anonymized)
// and removed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../common/config.js';
import { readSettings, writeSettings } from '../common/settings.js';
import { ollamaUrl } from './prompt.js';

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

// Anonymized copy of a document for sharing: no prompts, no user names, no file names that carry
// a piece of the prompt, no disk identifiers. User names become pseudonyms that stay the same
// within one download (a random salt per download), so jobs of one user can still be grouped.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DATA_FILE = /(\/data\/(?:output|input\/uploads|state\/thumbs|state\/previews))\/\S+?(\.[a-z0-9]+)?$/i;

export function anonymize(doc, salt) {
  const d = structuredClone(doc);
  const job = d.job || {};
  const p = job.params || {};
  const removed = (text) => (text ? `[removed, ${String(text).length} characters]` : text);
  if (job.user) job.user = 'user-' + crypto.createHash('sha256').update(salt + job.user).digest('hex').slice(0, 8);
  p.prompt = removed(p.prompt);
  p.negative = removed(p.negative);
  if (p.image) p.image = 'upload' + path.extname(p.image);
  job.files = (job.files || []).map((f, i) => ({ ...f, name: `result-${i + 1}${path.extname(f.name || '')}` }));
  if (job.thumb) job.thumb = 'thumbnail.jpg';
  for (const c of d.commands || []) {
    c.args = (c.args || []).map((a, i, all) => {
      if (all[i - 1] === '-p' || all[i - 1] === '-n') return removed(a);
      return typeof a === 'string' ? a.replace(DATA_FILE, (m, dir, ext = '') => `${dir}/[file]${ext}`) : a;
    });
  }
  if (d.resource?.['os.kernel.cmdline']) d.resource['os.kernel.cmdline'] = d.resource['os.kernel.cmdline'].replace(UUID, '[uuid]');
  d.anonymized = true;
  return d;
}

export function settingsRoutes(api, requireAdmin) {
  api.get('/settings', requireAdmin, (req, res) => res.json(readSettings()));

  // Every section is optional: a request changes only the sections it carries
  api.put('/settings', requireAdmin, (req, res) => {
    const settings = readSettings();
    if (req.body?.telemetry) {
      const t = req.body.telemetry;
      const maxMb = Math.round(Number(t.maxMb));
      if (!Number.isFinite(maxMb) || maxMb < 10 || maxMb > 100000) {
        return res.status(400).json({ error: 'The telemetry limit must be between 10 and 100000 MB' });
      }
      settings.telemetry = { enabled: t.enabled === true, maxMb };
    }
    if (req.body?.promptAssistant) {
      const p = req.body.promptAssistant;
      const url = ollamaUrl(p.url);
      if (!url) return res.status(400).json({ error: 'The Ollama address must be an http:// or https:// URL' });
      const model = String(p.model || '').trim();
      if (!/^[\w.:/-]{1,200}$/.test(model)) return res.status(400).json({ error: 'Enter the name of an Ollama model' });
      settings.promptAssistant = { enabled: p.enabled === true, url, model };
    }
    writeSettings(settings);
    res.json(settings);
  });

  api.get('/telemetry', requireAdmin, (req, res) => {
    const docs = listDocuments();
    res.json({ documents: docs.slice(0, 50), count: docs.length, bytes: docs.reduce((s, d) => s + d.size, 0), settings: readSettings().telemetry });
  });

  // All documents as one JSON array, streamed so large collections do not sit in memory;
  // ?anonymize=1 gives the anonymized copies (see anonymize())
  api.get('/telemetry/export', requireAdmin, async (req, res) => {
    const docs = listDocuments().reverse();
    const anon = req.query.anonymize === '1';
    const salt = crypto.randomBytes(16).toString('hex');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="telemetry-${stamp}${anon ? '-anonymized' : ''}.json"`);
    res.write('[');
    let first = true;
    for (const d of docs) {
      let text;
      try {
        text = await fs.promises.readFile(path.join(DIR, d.name), 'utf8');
        const doc = JSON.parse(text);
        if (anon) text = JSON.stringify(anonymize(doc, salt));
      } catch {
        continue;
      }
      res.write((first ? '\n' : ',\n') + text);
      first = false;
    }
    res.end('\n]\n');
  });

  api.get('/telemetry/:name', requireAdmin, async (req, res) => {
    if (!NAME.test(req.params.name)) return res.status(400).json({ error: 'Not found' });
    const file = path.join(DIR, req.params.name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
    if (req.query.anonymize !== '1') return res.download(file, req.params.name);
    const doc = anonymize(JSON.parse(await fs.promises.readFile(file, 'utf8')), crypto.randomBytes(16).toString('hex'));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name.replace(/\.json$/, '')}-anonymized.json"`);
    res.send(JSON.stringify(doc));
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
