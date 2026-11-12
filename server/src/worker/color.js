import { spawn } from 'node:child_process';

// Colour matching of a continuation part to the previous one: the mean and spread of each channel
// of a frame are brought to those of the frame the part started from (Reinhard), so colour and
// brightness do not drift from part to part. The correction is limited: a real change of scene
// lighting is kept. `frame` picks a frame of a video by its number (0 is the first).
export function frameStats(src, frame = 0) {
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-loglevel', 'error', '-i', src, '-vf', `select=eq(n\\,${frame}),scale=96:96`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
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

// A model drifts inside a part too: over the 49 frames of a Wan pass the picture grows redder and
// harder, and five parts chained from last frames ended in a scarlet sky. So a part is graded with
// a ramp: from the correction of its first frame (start) to the correction of its last frame (end),
// both towards the frame it started from. Its last frame, fully corrected, starts the next part, so
// nothing accumulates. `dropFirst`: the part loses its repeated first frame before the ramp.
// The labels carry the part number: the fragment is used inside larger filter graphs.
export function rampFilter(i, start, end, frames, dropFirst) {
  if (!end) return start || null;
  const w = `${dropFirst ? '(N+1)' : 'N'}/${Math.max(1, frames - 1)}`;
  return `format=gbrp,split[ga${i}][gb${i}];[ga${i}]${start || 'null'}[gc${i}];[gb${i}]${end}[gd${i}];[gc${i}][gd${i}]blend=all_expr='A*(1-${w})+B*${w}'`;
}
