// Agent modelling without Blender: a model is a JSON list of shapes (signed distance fields) combined in order with
// union / subtract / intersect / paint, optional smooth blend and left-right mirror. build() samples the field on a
// sparse grid, meshes it with surface nets, projects vertices onto the true surface, colours them, and writes one
// closed mesh with vertex colours into a glTF document. Pure JS, runs in a Worker.
//
// Shape: {name, type, op?: union|subtract|intersect|paint, blend?: metres, mirror?: 'x', at?: [x,y,z], rot?: [x,y,z]
//         degrees (X then Y then Z), color?: '#rrggbb', ...type params}
//   sphere {radius} | ellipsoid {radii: [x,y,z]} | box {size: [x,y,z], round?} | cylinder {radius, height, round?}
//   cone {radius, radiusTop?, height} | torus {radius, thickness} | capsule {from, to, radius, radiusTo?}
//   tube {points: [[x,y,z,r], ...]} | lathe {profile: [[r,y], ...]} (closed outline revolved around local Y)
// Cylinder, cone, lathe and torus axes are local Y; params are in the shape's local frame (at/rot move it).
import { Document } from '@gltf-transform/core';

const TYPES = new Set(['sphere', 'ellipsoid', 'box', 'cylinder', 'cone', 'torus', 'capsule', 'tube', 'lathe', 'group']);
const OPS = new Set(['union', 'subtract', 'intersect', 'paint']);
const MAX_SHAPES = 200, MAX_POINTS = 8e6;

// ---------- model JSON: validation and patching ----------
// group {shapes: [...]}: a sub-model built on its own and then combined as ONE shape (its op/blend/at/rot/mirror
// apply to the whole group), so a cut inside a group only cuts the group (a cap = sphere minus a box, in a group).
export function normalizeModel(m, maxShapes = MAX_SHAPES) {
  if (!m || !Array.isArray(m.shapes) || !m.shapes.length) throw new Error('model.shapes: non-empty array required');
  const names = new Set();
  let count = 0;
  const norm = (list, path) => list.map((s, i) => {
    if (++count > maxShapes) throw new Error(`at most ${maxShapes} shapes (groups and their children all count)`);
    if (!TYPES.has(s?.type)) throw new Error(`shape ${s?.name ?? path + i}: type must be one of ${[...TYPES].join(', ')}`);
    const name = s.name ?? `${path}${s.type}${i}`;
    if (names.has(name)) throw new Error(`duplicate shape name ${name}`);
    names.add(name);
    if (s.op && !OPS.has(s.op)) throw new Error(`shape ${name}: op must be one of ${[...OPS].join(', ')}`);
    if (s.mirror && s.mirror !== 'x') throw new Error(`shape ${name}: mirror can only be 'x'`);
    if (s.color && !/^#[0-9a-fA-F]{6}$/.test(s.color)) throw new Error(`shape ${name}: color must be #rrggbb`);
    for (const k of NEED[s.type]) if (s[k] == null) throw new Error(`shape ${name} (${s.type}) needs ${k}`);
    for (const k of ['at', 'rot', 'from', 'to']) if (s[k] != null && !(Array.isArray(s[k]) && s[k].length === 3 && s[k].every(Number.isFinite))) throw new Error(`shape ${name}: ${k} must be [x,y,z] numbers`);
    if (s.type === 'tube' && !(s.points.length >= 2 && s.points.every((p) => p.length === 4 && p.every(Number.isFinite)))) throw new Error(`shape ${name}: tube points are [x,y,z,radius], at least 2`);
    if (s.type === 'lathe' && !(s.profile.length >= 3 && s.profile.every((p) => p.length === 2 && p.every(Number.isFinite)))) throw new Error(`shape ${name}: lathe profile is [[r,y], ...], at least 3 points`);
    if (s.type === 'group') {
      if (!Array.isArray(s.shapes) || !s.shapes.length) throw new Error(`group ${name}: shapes must be a non-empty array`);
      return { ...s, name, shapes: norm(s.shapes, name + '.') };
    }
    return { ...s, name };
  });
  return { ...m, shapes: norm(m.shapes, '') };
}
const NEED = { sphere: ['radius'], ellipsoid: ['radii'], box: ['size'], cylinder: ['radius', 'height'], cone: ['radius', 'height'], torus: ['radius', 'thickness'], capsule: ['from', 'to', 'radius'], tube: ['points'], lathe: ['profile'], group: ['shapes'] };

function locate(shapes, name) { // {arr, i} of the shape with that name anywhere in the tree
  for (let i = 0; i < shapes.length; i++) {
    if (shapes[i].name === name) return { arr: shapes, i };
    if (shapes[i].shapes) { const r = locate(shapes[i].shapes, name); if (r) return r; }
  }
  return null;
}
const deepCopy = (x) => JSON.parse(JSON.stringify(x));

// patch: [{name, ...fields}] merges into the shape of that name (anywhere, also inside groups); {name, remove: true}
// deletes it; a new name is added at the end of the top list, or into the group named in `into`, or just before the
// shape named in `before`. A field set to null is removed from the shape.
export function applyPatch(model, patch) {
  if (!Array.isArray(patch)) throw new Error('patch must be an array');
  const out = deepCopy(model);
  for (const p of patch) {
    if (!p?.name) throw new Error('every patch entry needs name');
    const at = locate(out.shapes, p.name);
    if (p.remove) { if (!at) throw new Error(`patch: no shape ${p.name} to remove`); at.arr.splice(at.i, 1); continue; }
    const { before, into, ...fields } = p;
    if (at) {
      const sh = { ...at.arr[at.i], ...fields };
      for (const k of Object.keys(sh)) if (sh[k] === null) delete sh[k];
      at.arr[at.i] = sh;
    } else if (before) {
      const b = locate(out.shapes, before); if (!b) throw new Error(`patch: no shape ${before} to insert before`);
      b.arr.splice(b.i, 0, fields);
    } else if (into) {
      const g = locate(out.shapes, into); if (!g || !g.arr[g.i].shapes) throw new Error(`patch: no group ${into}`);
      g.arr[g.i].shapes.push(fields);
    } else out.shapes.push(fields);
  }
  return out;
}

// ---------- compiled shapes ----------
function rotMat(rot) { // world <- local, X then Y then Z (matches eulerDeg in scene.js); row-major 3x3
  const [x, y, z] = (rot ?? [0, 0, 0]).map((v) => (v * Math.PI) / 180);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  // R = Rz * Ry * Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx];
}
const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);

function compile(s, ALL) {
  const at = s.at ?? [0, 0, 0], R = rotMat(s.rot), rotated = !!s.rot && s.rot.some((v) => v);
  const c = { gi: ALL.length, name: s.name, op: s.op ?? 'union', k: Math.max(0, s.blend ?? 0), mirror: s.mirror === 'x', color: s.color ? hex(s.color) : null, ax: at[0], ay: at[1], az: at[2], R, rotated };
  ALL.push(c);
  let f, rad; // local sdf, bounding radius around the local origin (or a world sphere for capsule/tube)
  const T = s.type;
  if (T === 'sphere') { const r = s.radius; f = (x, y, z) => Math.hypot(x, y, z) - r; rad = r; }
  else if (T === 'ellipsoid') {
    const [a, b, d] = s.radii;
    f = (x, y, z) => {
      const k0 = Math.hypot(x / a, y / b, z / d), k1 = Math.hypot(x / (a * a), y / (b * b), z / (d * d));
      return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b, d);
    };
    rad = Math.max(a, b, d);
  } else if (T === 'box') {
    const r = Math.max(0, s.round ?? 0), bx = s.size[0] / 2 - r, by = s.size[1] / 2 - r, bz = s.size[2] / 2 - r;
    f = (x, y, z) => {
      const qx = Math.abs(x) - bx, qy = Math.abs(y) - by, qz = Math.abs(z) - bz;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
    };
    rad = Math.hypot(...s.size) / 2;
  } else if (T === 'cylinder') {
    const r = Math.max(0, s.round ?? 0), R0 = s.radius - r, h = s.height / 2 - r;
    f = (x, y, z) => {
      const dx = Math.hypot(x, z) - R0, dy = Math.abs(y) - h;
      return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - r;
    };
    rad = Math.hypot(s.radius, s.height / 2);
  } else if (T === 'cone') {
    const r1 = s.radius, r2 = s.radiusTop ?? 0, h = s.height / 2;
    const k2x = r2 - r1, k2y = 2 * h, k2d = k2x * k2x + k2y * k2y;
    f = (x, y, z) => { // capped cone, base radius r1 at y = -h, top r2 at y = +h (Quilez)
      const qx = Math.hypot(x, z), qy = y;
      const cax = qx - Math.min(qx, qy < 0 ? r1 : r2), cay = Math.abs(qy) - h;
      const t = Math.min(1, Math.max(0, ((r2 - qx) * k2x + (h - qy) * k2y) / k2d));
      const cbx = qx - r2 + k2x * t, cby = qy - h + k2y * t;
      const s0 = cbx < 0 && cay < 0 ? -1 : 1;
      return s0 * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
    };
    rad = Math.hypot(Math.max(r1, r2), h);
  } else if (T === 'torus') {
    const R0 = s.radius, r = s.thickness;
    f = (x, y, z) => Math.hypot(Math.hypot(x, z) - R0, y) - r; rad = R0 + r;
  } else if (T === 'capsule' || T === 'tube') {
    const pts = T === 'capsule' ? [[...s.from, s.radius], [...s.to, s.radiusTo ?? s.radius]] : s.points;
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) segs.push(roundCone(pts[i], pts[i + 1]));
    f = segs.length === 1 ? segs[0] : (x, y, z) => { let d = Infinity; for (const g of segs) { const v = g(x, y, z); if (v < d) d = v; } return d; };
    // bounding sphere of the points (local)
    const lo = [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a] - p[3]))), hi = [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a] + p[3])));
    c.bc = lo.map((v, a) => (v + hi[a]) / 2); rad = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
  } else if (T === 'lathe') {
    const P = s.profile;
    f = (x, y, z) => polySdf(P, Math.hypot(x, z), y);
    rad = Math.max(...P.map(([r, y]) => Math.hypot(r, y)));
  } else if (T === 'group') {
    c.children = s.shapes.map((ch) => compile(ch, ALL));
    c.colA = new Float64Array(3); c.colB = new Float64Array(3); c.colM = new Float64Array(3);
    const bs = c.children.filter((ch) => ch.op === 'union').flatMap((ch) => ch.bounds);
    if (!bs.length) throw new Error(`group ${s.name} has no union shape`);
    const lo = [0, 1, 2].map((a) => Math.min(...bs.map((b) => b.c[a] - b.r))), hi = [0, 1, 2].map((a) => Math.max(...bs.map((b) => b.c[a] + b.r)));
    c.bc = lo.map((v, a) => (v + hi[a]) / 2);
    rad = Math.max(...bs.map((b) => Math.hypot(b.c[0] - c.bc[0], b.c[1] - c.bc[1], b.c[2] - c.bc[2]) + b.r));
  }
  c.f = f;
  // world bounding sphere
  const bc = c.bc ?? [0, 0, 0];
  const w = [0, 1, 2].map((r) => R[r * 3] * bc[0] + R[r * 3 + 1] * bc[1] + R[r * 3 + 2] * bc[2] + at[r]);
  c.bounds = [{ c: w, r: rad }]; // the shape lies inside these spheres (a lower bound for its distance)
  if (c.mirror) c.bounds.push({ c: [-w[0], w[1], w[2]], r: rad });
  return c;
}

function roundCone(A, B) { // Quilez sdRoundCone between spheres (A, ra) and (B, rb)
  const [ax, ay, az, r1] = A, [bx, by, bz, r2] = B;
  const bax = bx - ax, bay = by - ay, baz = bz - az, l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr;
  if (l2 < 1e-12 || a2 <= 1e-12) { // one sphere holds the other
    return (x, y, z) => Math.min(Math.hypot(x - ax, y - ay, z - az) - r1, Math.hypot(x - bx, y - by, z - bz) - r2);
  }
  const il2 = 1 / l2;
  return (x, y, z) => {
    const pax = x - ax, pay = y - ay, paz = z - az, yy = pax * bax + pay * bay + paz * baz, zz = yy - l2;
    const cx = pax * l2 - bax * yy, cy = pay * l2 - bay * yy, cz = paz * l2 - baz * yy;
    const x2 = cx * cx + cy * cy + cz * cz, y2 = yy * yy * l2, z2 = zz * zz * l2, k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
}

function polySdf(P, px, py) { // Quilez sdPolygon, closed outline
  const n = P.length;
  let d = (px - P[0][0]) ** 2 + (py - P[0][1]) ** 2, s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const ex = P[j][0] - P[i][0], ey = P[j][1] - P[i][1], wx = px - P[i][0], wy = py - P[i][1];
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= P[i][1], c2 = py < P[j][1], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

function lowerBound(c, x, y, z) {
  let m = Infinity;
  for (const b of c.bounds) { const v = Math.hypot(x - b.c[0], y - b.c[1], z - b.c[2]) - b.r; if (v < m) m = v; }
  return m;
}

// distance of one shape; with out (Float64Array(3)) a group also returns its colour there and the owner in out.owner
function shapeD(c, x, y, z, out) {
  const ev = (px, o) => {
    let dx = px - c.ax, dy = y - c.ay, dz = z - c.az;
    if (c.rotated) { const R = c.R; const lx = R[0] * dx + R[3] * dy + R[6] * dz, ly = R[1] * dx + R[4] * dy + R[7] * dz, lz = R[2] * dx + R[5] * dy + R[8] * dz; dx = lx; dy = ly; dz = lz; }
    return c.children ? field(c.children, dx, dy, dz, o) : c.f(dx, dy, dz);
  };
  if (!c.mirror) return ev(x, out);
  if (!out || !c.children) return Math.min(ev(x), ev(-x));
  const a = ev(x, c.colA), oa = c.colA.owner, b = ev(-x, c.colB);
  const src = a <= b ? c.colA : c.colB; out[0] = src[0]; out[1] = src[1]; out[2] = src[2]; out.owner = a <= b ? oa : c.colB.owner;
  return Math.min(a, b);
}

// the whole field; with col (Float64Array(3)) also the colour, the gi of the shape whose surface this is (col.owner)
// and the last paint that covers it (col.painted)
function field(C, x, y, z, col) {
  let d = Infinity, owner = -1;
  if (col) { col[0] = col[1] = col[2] = 0.8; }
  for (let i = 0; i < C.length; i++) {
    const c = C[i], k = c.k, op = c.op;
    if (op === 'paint' && !col) continue;
    if (d !== Infinity && op !== 'intersect') { // skip shapes that cannot change anything here
      const lb = lowerBound(c, x, y, z);
      if (op === 'union' ? lb >= d + k : op === 'subtract' ? lb >= k - d : lb >= k / 2) continue;
    }
    const gc = col && c.children ? c.colA : null; // a group writes its colour here (colA is free again after shapeD)
    let s;
    if (gc && c.mirror) { const m = c.colM; s = shapeD(c, x, y, z, m); gc[0] = m[0]; gc[1] = m[1]; gc[2] = m[2]; gc.owner = m.owner; }
    else s = shapeD(c, x, y, z, gc);
    const sc = c.color ?? (gc ? gc : null), so = gc ? gc.owner : c.gi;
    if (op === 'union') {
      if (d === Infinity) { d = s; owner = so; if (col && sc) col.set(sc); continue; }
      let h;
      if (k > 0) { h = Math.min(1, Math.max(0, 0.5 + (0.5 * (d - s)) / k)); d = d + (s - d) * h - k * h * (1 - h); }
      else { h = s < d ? 1 : 0; if (h) d = s; }
      if (col) { if (sc) for (let q = 0; q < 3; q++) col[q] += (sc[q] - col[q]) * h; if (h > 0.5) owner = so; }
    } else if (op === 'subtract') {
      let h;
      if (k > 0) { h = Math.min(1, Math.max(0, 0.5 - (0.5 * (d + s)) / k)); d = d + (-s - d) * h + k * h * (1 - h); }
      else { h = -s > d ? 1 : 0; if (h) d = -s; }
      if (col) { if (sc) for (let q = 0; q < 3; q++) col[q] += (sc[q] - col[q]) * h; if (h > 0.5) owner = so; }
    } else if (op === 'intersect') {
      let h;
      if (k > 0) { h = Math.min(1, Math.max(0, 0.5 - (0.5 * (s - d)) / k)); d = s + (d - s) * h + k * h * (1 - h); }
      else { h = s > d ? 0 : 1; d = Math.max(d, s); }
      if (col) { if (sc) for (let q = 0; q < 3; q++) col[q] += (sc[q] - col[q]) * (1 - h); if (h < 0.5) owner = so; }
    } else if (sc) { // paint: colour only, inside the shape (soft edge = blend)
      const w = k > 0 ? Math.min(1, Math.max(0, 0.5 - s / k)) : s < 0 ? 1 : 0;
      if (w > 0) { for (let q = 0; q < 3; q++) col[q] += (sc[q] - col[q]) * w; if (w > 0.5) col.painted = c.gi; }
    }
  }
  if (col) col.owner = owner;
  return d;
}

// ---------- build ----------
export function build(modelIn, opt = {}) {
  const t0 = Date.now();
  const model = normalizeModel(modelIn, opt.maxShapes), MAXP = opt.maxPoints ?? MAX_POINTS;
  const ALL = [], C = model.shapes.map((sh) => compile(sh, ALL));
  // bounds from the union shapes
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const c of C) if (c.op === 'union') for (const b of c.bounds) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b.c[a] - b.r); hi[a] = Math.max(hi[a], b.c[a] + b.r); }
  if (!(lo[0] < hi[0])) throw new Error('no union shape: nothing to build');
  const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  let res = model.res ?? opt.res ?? ext / 160;
  const warnings = [];
  const pointsAt = (r) => [0, 1, 2].reduce((n, a) => n * (Math.ceil((hi[a] - lo[a]) / r) + 7), 1);
  if (pointsAt(res) > MAXP) { const r2 = res * Math.cbrt(pointsAt(res) / MAXP) * 1.02; warnings.push(`res ${res} needs too many grid points; used ${r2.toFixed(4)}`); res = r2; }
  const o = lo.map((v) => v - 3 * res), N = [0, 1, 2].map((a) => Math.ceil((hi[a] - lo[a]) / res) + 7);
  const [nx, ny, nz] = N, G = new Float32Array(nx * ny * nz), id = (i, j, k) => (k * ny + j) * nx + i;
  // sparse: one sample per 4^3 block, full samples only near the surface
  const B = 4, thr = 1.6 * 4 * res;
  let evaluated = 0;
  for (let bk = 0; bk < nz; bk += B) for (let bj = 0; bj < ny; bj += B) for (let bi = 0; bi < nx; bi += B) {
    const dc = field(C, o[0] + (bi + 1.5) * res, o[1] + (bj + 1.5) * res, o[2] + (bk + 1.5) * res); evaluated++;
    const far = Math.abs(dc) > thr;
    for (let k = bk; k < Math.min(nz, bk + B); k++) for (let j = bj; j < Math.min(ny, bj + B); j++) for (let i = bi; i < Math.min(nx, bi + B); i++) {
      G[id(i, j, k)] = far ? dc : field(C, o[0] + i * res, o[1] + j * res, o[2] + k * res);
      if (!far) evaluated++;
    }
  }
  // surface nets: one vertex per sign-changing cell
  const cellV = new Map(), P = []; // surface cells only
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let m = 0;
    for (let q = 0; q < 8; q++) { cv[q] = G[id(i + (q & 1), j + ((q >> 1) & 1), k + ((q >> 2) & 1))]; if (cv[q] < 0) m |= 1 << q; }
    if (m === 0 || m === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of E) {
      if ((cv[a] < 0) === (cv[b] < 0)) continue;
      const t = cv[a] / (cv[a] - cv[b]);
      sx += (a & 1) + t * ((b & 1) - (a & 1)); sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1)); sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1)); n++;
    }
    cellV.set(id(i, j, k), P.length / 3);
    P.push(o[0] + (i + sx / n) * res, o[1] + (j + sy / n) * res, o[2] + (k + sz / n) * res);
  }
  const F = [];
  const quad = (a, b, c, d, flip) => { // split along the shorter diagonal
    if (flip) { const t = b; b = d; d = t; }
    const dac = (P[a * 3] - P[c * 3]) ** 2 + (P[a * 3 + 1] - P[c * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[c * 3 + 2]) ** 2;
    const dbd = (P[b * 3] - P[d * 3]) ** 2 + (P[b * 3 + 1] - P[d * 3 + 1]) ** 2 + (P[b * 3 + 2] - P[d * 3 + 2]) ** 2;
    if (dac <= dbd) F.push(a, b, c, a, c, d); else F.push(a, b, d, b, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const inside = G[id(i, j, k)] < 0;
    if (i < nx - 1 && inside !== (G[id(i + 1, j, k)] < 0)) // x edge: cells around it in (y, z)
      quad(cellV.get(id(i, j - 1, k - 1)), cellV.get(id(i, j, k - 1)), cellV.get(id(i, j, k)), cellV.get(id(i, j - 1, k)), !inside);
    if (j < ny - 1 && inside !== (G[id(i, j + 1, k)] < 0)) // y edge: (z, x)
      quad(cellV.get(id(i - 1, j, k - 1)), cellV.get(id(i - 1, j, k)), cellV.get(id(i, j, k)), cellV.get(id(i, j, k - 1)), !inside);
    if (k < nz - 1 && inside !== (G[id(i, j, k + 1)] < 0)) // z edge: (x, y)
      quad(cellV.get(id(i - 1, j - 1, k)), cellV.get(id(i, j - 1, k)), cellV.get(id(i, j, k)), cellV.get(id(i - 1, j, k)), !inside);
  }
  const nV = P.length / 3;
  if (!nV) throw new Error('the model has no surface (everything subtracted, or shapes smaller than res)');
  // project onto the true surface (2 Newton steps), normals from the gradient, colours
  const pos = new Float32Array(nV * 3), nrm = new Float32Array(nV * 3), colr = new Float32Array(nV * 3);
  const owned = new Int32Array(ALL.length), painted = new Int32Array(ALL.length), col = new Float64Array(3), h = res * 0.25;
  for (let v = 0; v < nV; v++) {
    let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], gx = 0, gy = 1, gz = 0;
    for (let it = 0; it < 3; it++) { // tetrahedral samples: value and gradient from 4 evaluations
      const f0 = field(C, x + h, y - h, z - h), f1 = field(C, x - h, y - h, z + h), f2 = field(C, x - h, y + h, z - h), f3 = field(C, x + h, y + h, z + h);
      const d = (f0 + f1 + f2 + f3) / 4;
      gx = f0 - f1 - f2 + f3; gy = -f0 - f1 + f2 + f3; gz = -f0 + f1 - f2 + f3; // = 4h * grad
      const g2 = gx * gx + gy * gy + gz * gz; if (!(g2 > 0) || it === 2) break;
      let sx = (d * gx * 4 * h) / g2, sy = (d * gy * 4 * h) / g2, sz = (d * gz * 4 * h) / g2;
      const sl = Math.hypot(sx, sy, sz); if (sl > res * 0.75) { const f = (res * 0.75) / sl; sx *= f; sy *= f; sz *= f; }
      x -= sx; y -= sy; z -= sz;
    }
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    const gl = Math.hypot(gx, gy, gz) || 1; nrm[v * 3] = gx / gl; nrm[v * 3 + 1] = gy / gl; nrm[v * 3 + 2] = gz / gl;
    col.painted = -1; field(C, x, y, z, col);
    if (col.owner >= 0) owned[col.owner]++;
    if (col.painted >= 0) painted[col.painted]++;
    for (let q = 0; q < 3; q++) colr[v * 3 + q] = srgbToLinear(col[q]);
  }
  const idx = new Uint32Array(F);
  const comps = components(nV, idx);
  // per-shape surface vertices; a group counts all its children
  const count = (c) => (c.children ? c.children.reduce((n, ch) => n + count(ch), 0) : c.op === 'paint' ? painted[c.gi] : owned[c.gi]);
  const perShape = {}, noEffect = [];
  for (const c of ALL) { perShape[c.name] = count(c); if (!perShape[c.name]) noEffect.push(c.name); }
  if (noEffect.length) warnings.push(`no visible effect (hidden inside other shapes, cut away, smaller than res ${+res.toFixed(4)}, or a paint/cut that misses): ${noEffect.join(', ')}`);
  if (comps.length > 1) warnings.push(`${comps.length} separate pieces (vertices: ${comps.slice(0, 6).join(', ')}); floating parts bind poorly, overlap or blend them into the body`);
  const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let v = 0; v < nV; v++) for (let a = 0; a < 3; a++) { const x = pos[v * 3 + a]; if (x < bb.min[a]) bb.min[a] = x; if (x > bb.max[a]) bb.max[a] = x; }
  return {
    model, pos, nrm, col: colr, idx,
    info: {
      vertices: nV, triangles: idx.length / 3, res: +res.toFixed(5), grid: N, gridPoints: nx * ny * nz, evaluatedPoints: evaluated,
      bounds: { min: bb.min.map(r4), max: bb.max.map(r4) }, pieces: comps.length, ms: Date.now() - t0,
      verticesPerShape: perShape,
      warnings: warnings.length ? warnings : undefined,
    },
  };
}

const r4 = (v) => +v.toFixed(4);
function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

function components(nV, idx) {
  const p = new Int32Array(nV).map((_, i) => i);
  const find = (a) => { while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; } return a; };
  for (let f = 0; f < idx.length; f += 3) { const a = find(idx[f]), b = find(idx[f + 1]), c = find(idx[f + 2]); p[b] = a; p[find(c)] = a; }
  const n = new Map(); for (let v = 0; v < nV; v++) { const r = find(v); n.set(r, (n.get(r) ?? 0) + 1); }
  return [...n.values()].sort((a, b) => b - a);
}

// a fresh glTF document holding the built mesh; the model JSON rides along in the scene extras for patching
export function toDocument(b, name = 'model') {
  const doc = new Document(), buf = doc.createBuffer();
  const acc = (arr, type) => doc.createAccessor().setArray(arr).setType(type).setBuffer(buf);
  const mat = doc.createMaterial('vertexColor').setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(0).setRoughnessFactor(0.8);
  const col16 = new Uint16Array(b.col.length); for (let i = 0; i < col16.length; i++) col16[i] = Math.round(Math.min(1, Math.max(0, b.col[i])) * 65535);
  const idx = b.pos.length / 3 <= 65535 ? Uint16Array.from(b.idx) : b.idx;
  const prim = doc.createPrimitive().setAttribute('POSITION', acc(b.pos, 'VEC3')).setAttribute('NORMAL', acc(b.nrm, 'VEC3'))
    .setAttribute('COLOR_0', acc(col16, 'VEC3').setNormalized(true)).setIndices(acc(idx, 'SCALAR')).setMaterial(mat);
  const mesh = doc.createMesh(name).addPrimitive(prim);
  const node = doc.createNode(name).setMesh(mesh);
  doc.createScene('Scene').addChild(node).setExtras({ rigWorkerModel: b.model });
  doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]);
  return doc;
}

export function storedModel(doc) {
  for (const s of doc.getRoot().listScenes()) { const m = s.getExtras()?.rigWorkerModel; if (m) return m; }
  return null;
}
