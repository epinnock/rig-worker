// Tiny software renderer for agent previews: orthographic orbit views, z-buffer, Lambert, 2x supersampling, PNG out.
// No GPU, no canvas: works in a Worker. One image = a row-major grid of tiles (views or animation frames).

const BG = [52, 56, 66];

// tiles: [{pos Float32Array, idx Uint32Array, col Uint8Array(nV*3)|null, lines?, dots?, az, elev}]
// frame: {centre, radius} fixes the camera (stable between calls); else it fits all tiles
export function renderTiles(tiles, { res = 300, ss = 2, frame = null } = {}) {
  const R = res * ss;
  let c, rad;
  if (frame) { c = frame.centre; rad = frame.radius; } else ({ centre: c, radius: rad } = fitFrame(tiles.map((t) => t.pos)));
  rad = Math.max(1e-6, rad);
  const scale = (R * 0.94) / (2 * rad);
  const cols = Math.min(4, tiles.length), rows = Math.ceil(tiles.length / cols);
  const out = new Uint8Array(cols * res * rows * res * 3);
  const img = new Uint8Array(R * R * 3), zb = new Float32Array(R * R);
  tiles.forEach((t, ti) => {
    for (let q = 0; q < R * R; q++) { img.set(BG, q * 3); zb[q] = -Infinity; }
    const az = (t.az ?? 0) * Math.PI / 180, el = (t.elev ?? 12) * Math.PI / 180;
    const dir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    const right = norm([dir[2], 0, -dir[0]]);
    const up = cross(dir, right);
    const L = norm([dir[0] * 0.6 + up[0] * 0.7 - right[0] * 0.45, dir[1] * 0.6 + up[1] * 0.7 - right[1] * 0.45, dir[2] * 0.6 + up[2] * 0.7 - right[2] * 0.45]);
    const nV = t.pos.length / 3, sx = new Float32Array(nV), sy = new Float32Array(nV), sz = new Float32Array(nV);
    for (let i = 0; i < nV; i++) {
      const x = t.pos[i * 3] - c[0], y = t.pos[i * 3 + 1] - c[1], z = t.pos[i * 3 + 2] - c[2];
      sx[i] = R / 2 + (x * right[0] + y * right[1] + z * right[2]) * scale;
      sy[i] = R / 2 - (x * up[0] + y * up[1] + z * up[2]) * scale;
      sz[i] = x * dir[0] + y * dir[1] + z * dir[2];
    }
    const idx = t.idx, col = t.col;
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f], b = idx[f + 1], d = idx[f + 2];
      // face normal (world), two-sided
      const ux = t.pos[b * 3] - t.pos[a * 3], uy = t.pos[b * 3 + 1] - t.pos[a * 3 + 1], uz = t.pos[b * 3 + 2] - t.pos[a * 3 + 2];
      const vx = t.pos[d * 3] - t.pos[a * 3], vy = t.pos[d * 3 + 1] - t.pos[a * 3 + 1], vz = t.pos[d * 3 + 2] - t.pos[a * 3 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz); if (!(nl > 0)) continue;
      nx /= nl; ny /= nl; nz /= nl;
      if (nx * dir[0] + ny * dir[1] + nz * dir[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const lum = 0.28 + 0.72 * Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
      const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[d]))), x1 = Math.min(R - 1, Math.ceil(Math.max(sx[a], sx[b], sx[d])));
      const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[d]))), y1 = Math.min(R - 1, Math.ceil(Math.max(sy[a], sy[b], sy[d])));
      if (x0 > x1 || y0 > y1) continue;
      const area = (sx[b] - sx[a]) * (sy[d] - sy[a]) - (sx[d] - sx[a]) * (sy[b] - sy[a]);
      if (Math.abs(area) < 1e-12) continue;
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const qx = px + 0.5, qy = py + 0.5;
        const w0 = ((sx[b] - qx) * (sy[d] - qy) - (sx[d] - qx) * (sy[b] - qy)) / area;
        const w1 = ((sx[d] - qx) * (sy[a] - qy) - (sx[a] - qx) * (sy[d] - qy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * sz[a] + w1 * sz[b] + w2 * sz[d], q = py * R + px;
        if (z <= zb[q]) continue;
        zb[q] = z;
        for (let k = 0; k < 3; k++) {
          const base = col ? w0 * col[a * 3 + k] + w1 * col[b * 3 + k] + w2 * col[d * 3 + k] : 200;
          img[q * 3 + k] = Math.min(255, base * lum);
        }
      }
    }
    const P = (p) => {
      const x = p[0] - c[0], y = p[1] - c[1], z = p[2] - c[2];
      return [R / 2 + (x * right[0] + y * right[1] + z * right[2]) * scale, R / 2 - (x * up[0] + y * up[1] + z * up[2]) * scale];
    };
    for (const l of t.lines ?? []) { const [ax, ay] = P(l), [bx, by] = P(l.slice(3)); line(img, R, ax, ay, bx, by, 1.6 * ss, [20, 20, 20]); line(img, R, ax, ay, bx, by, 0.8 * ss, [255, 214, 40]); }
    for (const d of t.dots ?? []) { const [x, y] = P(d); disc(img, R, x, y, 2.6 * ss, [20, 20, 20]); disc(img, R, x, y, 1.8 * ss, [255, 90, 60]); }
    // downsample into the grid
    const ox = (ti % cols) * res, oy = Math.floor(ti / cols) * res, W = cols * res;
    for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) for (let k = 0; k < 3; k++) {
      let s = 0; for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) s += img[((y * ss + dy) * R + x * ss + dx) * 3 + k];
      out[((oy + y) * W + ox + x) * 3 + k] = s / (ss * ss);
    }
    // thin tile border
    for (let x = 0; x < res; x++) for (const y of [0, res - 1]) out.set([30, 32, 38], ((oy + y) * W + ox + x) * 3);
    for (let y = 0; y < res; y++) for (const x of [0, res - 1]) out.set([30, 32, 38], ((oy + y) * W + ox + x) * 3);
  });
  return { w: cols * res, h: rows * res, rgb: out, pxPerMetre: (res * 0.94) / (2 * rad) };
}

export function fitFrame(posList) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const pos of posList) for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = pos[i + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v;
  }
  return { centre: lo.map((v, a) => (v + hi[a]) / 2), radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 };
}

function norm(v) { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function disc(img, R, cx, cy, r, c) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= R || y >= R || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
    img.set(c, (y * R + x) * 3);
  }
}
function line(img, R, ax, ay, bx, by, r, c) {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(0.5, r * 0.5)));
  for (let i = 0; i <= n; i++) disc(img, R, ax + (bx - ax) * i / n, ay + (by - ay) * i / n, r, c);
}

// colour helpers
// 22 hand-picked distinct colours (Kelly / Tol style) first, then golden-ratio hues for big skeletons
const FIXED = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe',
  '#008080', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075', '#808080', '#ffffff', '#000000', '#e6beff']
  .map((h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)));
export function palette(i) {
  if (i < FIXED.length) return FIXED[i];
  const h = (i * 0.618034) % 1, s = 0.7, v = 0.95;
  const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}
export function heat(w) { // 0 blue -> 1 red
  const t = Math.max(0, Math.min(1, w));
  return [Math.round(40 + 200 * t), Math.round(60 + 120 * Math.sin(Math.PI * t)), Math.round(200 - 170 * t)];
}

// ---- PNG (RGB8) via CompressionStream('deflate') = zlib, which is what IDAT wants ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export async function encodePNG({ w, h, rgb }) {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
