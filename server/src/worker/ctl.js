// Command-line control of the worker, run inside its container by scripts/update.sh:
//   node src/worker/ctl.js status
//   node src/worker/ctl.js drain <seconds>     (0 releases the drain)
// Prints the worker status as JSON.
import { config } from '../common/config.js';
import { workerToken } from '../common/token.js';

const [cmd = 'status', arg] = process.argv.slice(2);
const base = `http://127.0.0.1:${config.workerPort}`;
const res = cmd === 'drain'
  ? await fetch(`${base}/v1/drain`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${workerToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ seconds: Number(arg) || 0 }),
  })
  : await fetch(`${base}/v1/health`);
console.log(JSON.stringify(await res.json()));
process.exit(res.ok ? 0 : 1);
