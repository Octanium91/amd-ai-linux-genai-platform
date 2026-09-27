import { spawn } from 'node:child_process';

// Colour matching of a continuation part to the previous one: the mean and spread of each channel
// of its first frame are brought to those of the previous part's last frame (Reinhard), so colour
// and brightness do not drift from part to part. The correction is limited: a real change of
// scene lighting is kept.
export function frameStats(src) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-loglevel', 'error', '-i', src, '-frames:v', '1', '-vf', 'scale=96:-2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      const b = Buffer.concat(chunks);
      if (code !== 0 || b.length < 3) return resolve(null);
      const n = Math.floor(b.length / 3);
      const mean = [0, 0, 0];
      const sq = [0, 0, 0];
      for (let i = 0; i < n * 3; i++) {
        mean[i % 3] += b[i];
        sq[i % 3] += b[i] * b[i];
      }
      resolve(mean.map((m, c) => {
        const mu = m / n;
        return { mean: mu, std: Math.sqrt(Math.max(1, sq[c] / n - mu * mu)) };
      }));
    });
  });
}

export function colorMatchFilter(target, source) {
  if (!target || !source) return null;
  const ch = ['r', 'g', 'b'].map((name, c) => {
    const k = Math.min(1.25, Math.max(0.8, target[c].std / source[c].std));
    const shift = Math.min(40, Math.max(-40, target[c].mean - source[c].mean * k));
    return `${name}='clip(val*${k.toFixed(4)}+${shift.toFixed(2)},0,255)'`;
  });
  return `lutrgb=${ch.join(':')}`;
}
