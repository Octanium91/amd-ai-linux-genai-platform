// Background removal: BiRefNet-lite (ONNX, MIT) finds the main subject and returns a soft mask.
// It runs on the CPU in the web container through ONNX Runtime, so it takes seconds and never
// waits for the GPU queue. The browser then refines the mask with "keep" and "remove" brushes and
// exports the PNG with transparency itself.
import fs from 'node:fs';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { config } from '../common/config.js';
import { loadCatalog } from './models.js';

const SIZE = 1024; // the model's input size
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export function segmenterEntry() {
  return loadCatalog().find((m) => m.category === 'segmenter' && fs.existsSync(path.join(config.dirs.models, m.file)));
}

// One model session, loaded on first use and kept (about 300 MB of RAM)
let session = null;
let sessionFile = null;
// ONNX Runtime can upload usage telemetry; the platform sends nothing anywhere. The variable must be
// set before the library initializes (the web image sets it too).
process.env.ORT_DISABLE_TELEMETRY = '1';
async function getSession(file) {
  if (session && sessionFile === file) return session;
  const ort = await import('onnxruntime-node');
  session = await ort.InferenceSession.create(file, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
  sessionFile = file;
  return session;
}

// PNG or JPEG into RGBA pixels (the browser re-encodes every photo to one of the two)
export function decodeImage(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw Object.assign(new Error('Only PNG and JPEG images are accepted'), { status: 400 });
}

// Bilinear sample of channel c (stride 4 or 1) at (x, y) in source pixel coordinates
function sample(data, w, h, stride, c, x, y) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)));
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = Math.min(1, Math.max(0, x - x0));
  const fy = Math.min(1, Math.max(0, y - y0));
  const a = data[(y0 * w + x0) * stride + c];
  const b = data[(y0 * w + x1) * stride + c];
  const d = data[(y1 * w + x0) * stride + c];
  const e = data[(y1 * w + x1) * stride + c];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
}

// The mask of the main subject as a grayscale PNG the size of the image (white = subject)
export async function subjectMask(imageBuf, modelFile) {
  const img = decodeImage(imageBuf);
  const input = new Float32Array(3 * SIZE * SIZE);
  const sx = img.width / SIZE;
  const sy = img.height / SIZE;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      for (let c = 0; c < 3; c++) {
        const v = sample(img.data, img.width, img.height, 4, c, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) / 255;
        input[c * SIZE * SIZE + i] = (v - MEAN[c]) / STD[c];
      }
    }
  }
  const ort = await import('onnxruntime-node');
  const s = await getSession(modelFile);
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  // The last output is the final prediction (logits); earlier ones, if any, are side outputs
  const logits = out[s.outputNames[s.outputNames.length - 1]].data;
  const prob = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < prob.length; i++) prob[i] = 1 / (1 + Math.exp(-logits[i]));

  const png = new PNG({ width: img.width, height: img.height, colorType: 0 });
  const kx = SIZE / img.width;
  const ky = SIZE / img.height;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const v = Math.round(sample(prob, SIZE, SIZE, 1, 0, (x + 0.5) * kx - 0.5, (y + 0.5) * ky - 0.5) * 255);
      const o = (y * img.width + x) * 4;
      png.data[o] = png.data[o + 1] = png.data[o + 2] = v;
      png.data[o + 3] = 255;
    }
  }
  return { png: PNG.sync.write(png, { colorType: 0 }), width: img.width, height: img.height };
}
