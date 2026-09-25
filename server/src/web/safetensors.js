// Streaming .safetensors repacking without loading the file into memory.
// Used to convert models into the layout stable-diffusion.cpp expects.
import fs from 'node:fs';

export function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Buffer.alloc(8);
    fs.readSync(fd, len, 0, 8, 0);
    const n = Number(len.readBigUInt64LE());
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 8);
    const header = JSON.parse(buf.toString('utf8'));
    const meta = header.__metadata__;
    delete header.__metadata__;
    return { header, meta, dataStart: 8 + n };
  } finally {
    fs.closeSync(fd);
  }
}

// entries: [{ name, src }] — src is the tensor name in the source file (may repeat)
export function rewrite(srcFile, dstFile, entries, meta) {
  const { header, dataStart } = readHeader(srcFile);
  const out = {};
  if (meta) out.__metadata__ = meta;
  let offset = 0;
  const srcSize = fs.statSync(srcFile).size;
  for (const e of entries) {
    const t = header[e.src];
    if (!t) throw new Error(`missing tensor ${e.src}`);
    const [a, b] = t.data_offsets || [];
    // Offsets come from a downloaded file: out-of-range values would make the copy loop spin forever
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < a || dataStart + b > srcSize) {
      throw new Error(`invalid offsets of tensor ${e.src}`);
    }
    const size = t.data_offsets[1] - t.data_offsets[0];
    out[e.name] = { dtype: t.dtype, shape: t.shape, data_offsets: [offset, offset + size] };
    offset += size;
  }
  let json = Buffer.from(JSON.stringify(out), 'utf8');
  const pad = (8 - (json.length % 8)) % 8; // padding, as in the reference implementation
  json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);

  const src = fs.openSync(srcFile, 'r');
  const dst = fs.openSync(dstFile, 'w');
  try {
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(json.length));
    fs.writeSync(dst, len);
    fs.writeSync(dst, json);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    for (const e of entries) {
      const [a, b] = header[e.src].data_offsets;
      for (let pos = a; pos < b; ) {
        const n = fs.readSync(src, chunk, 0, Math.min(chunk.length, b - pos), dataStart + pos);
        if (n <= 0) throw new Error('unexpected end of the source file');
        fs.writeSync(dst, chunk, 0, n);
        pos += n;
      }
    }
  } finally {
    fs.closeSync(src);
    fs.closeSync(dst);
  }
}

// AnimateDiff motion module in diffusers (MotionAdapter) format -> original AnimateDiff layout
// expected by sd.cpp: temporal_transformer prefix, attention_blocks.N, norms.N, ff_norm
// and a separate pos_encoder.pe table for each of the two attention blocks.
export function animatediffFromDiffusers(srcFile, dstFile) {
  const { header, meta } = readHeader(srcFile);
  const entries = [];
  const re = /^((?:down_blocks|up_blocks)\.\d+\.motion_modules\.\d+|mid_block\.motion_modules\.\d+)\.(.+)$/;
  for (const name of Object.keys(header)) {
    const m = name.match(re);
    if (!m) throw new Error(`unexpected tensor ${name}`);
    const [, prefix, rest] = m;
    const tb = 'transformer_blocks.0.';
    let mapped;
    if (rest.startsWith(tb)) {
      const r = rest.slice(tb.length);
      if (r === 'pos_embed.pe') {
        for (const i of [0, 1]) {
          entries.push({ name: `${prefix}.temporal_transformer.${tb}attention_blocks.${i}.pos_encoder.pe`, src: name });
        }
        continue;
      }
      mapped = r
        .replace(/^attn1\./, 'attention_blocks.0.')
        .replace(/^attn2\./, 'attention_blocks.1.')
        .replace(/^norm1\./, 'norms.0.')
        .replace(/^norm2\./, 'norms.1.')
        .replace(/^norm3\./, 'ff_norm.');
      mapped = tb + mapped;
    } else {
      mapped = rest; // norm, proj_in, proj_out
    }
    entries.push({ name: `${prefix}.temporal_transformer.${mapped}`, src: name });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  rewrite(srcFile, dstFile, entries, meta);
  return entries.length;
}

export const postprocessors = {
  'animatediff-from-diffusers': animatediffFromDiffusers,
};
