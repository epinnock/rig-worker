// Scene maths shared by preview, animate and qa: node world matrices, animation sampling, posed (skinned) positions.
// glTF conventions: column-major 4x4, quaternions [x, y, z, w].

export function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

export function trs(t, q, s) {
  const [x, y, z, w] = q, [sx, sy, sz] = s;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return Float64Array.of(
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1);
}

export function qmul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

// Euler degrees, applied X then Y then Z about the joint's own rest axes
export function eulerDeg(x, y, z) {
  const h = Math.PI / 360;
  const qx = [Math.sin(x * h), 0, 0, Math.cos(x * h)], qy = [0, Math.sin(y * h), 0, Math.cos(y * h)], qz = [0, 0, Math.sin(z * h), Math.cos(z * h)];
  return qmul(qz, qmul(qy, qx));
}

export const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
export function qrot(q, v) { // rotate vector v by unit quaternion q
  const [x, y, z, w] = q, [a, b, c] = v;
  const tx = 2 * (y * c - z * b), ty = 2 * (z * a - x * c), tz = 2 * (x * b - y * a);
  return [a + w * tx + y * tz - z * ty, b + w * ty + z * tx - x * tz, c + w * tz + x * ty - y * tx];
}
// rotation part of a column-major 4x4 (columns normalised, so a uniform scale is ignored) as a unit quaternion
export function matQuat(m) {
  const n = (i) => Math.hypot(m[i], m[i + 1], m[i + 2]) || 1, sx = n(0), sy = n(4), sz = n(8);
  const a = m[0] / sx, b = m[4] / sy, c = m[8] / sz, d = m[1] / sx, e = m[5] / sy, f = m[9] / sz, g = m[2] / sx, h = m[6] / sy, i = m[10] / sz;
  const tr = a + e + i; let q;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; q = [(h - f) / S, (c - g) / S, (d - b) / S, S / 4]; }
  else if (a > e && a > i) { const S = Math.sqrt(1 + a - e - i) * 2; q = [S / 4, (b + d) / S, (c + g) / S, (h - f) / S]; }
  else if (e > i) { const S = Math.sqrt(1 + e - a - i) * 2; q = [(b + d) / S, S / 4, (f + h) / S, (c - g) / S]; }
  else { const S = Math.sqrt(1 + i - a - e) * 2; q = [(c + g) / S, (f + h) / S, S / 4, (d - b) / S]; }
  const l = Math.hypot(...q); return q.map((v) => v / l);
}
// World rest orientation for a bone made by bind: local +Y runs head -> tail (what Blender, Maya and most tools expect,
// so bones import pointing along the limb), local X stays as close to world +X as it can (world +Z for bones along X).
export function boneFrame(head, tail) {
  const d = [tail[0] - head[0], tail[1] - head[1], tail[2] - head[2]], L = Math.hypot(...d);
  if (L < 1e-9) return [0, 0, 0, 1];
  const y = d.map((v) => v / L), ref = Math.abs(y[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0] * y[0] + ref[1] * y[1] + ref[2] * y[2];
  let x = [ref[0] - k * y[0], ref[1] - k * y[1], ref[2] - k * y[2]]; const lx = Math.hypot(...x); x = x.map((v) => v / lx);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return matQuat([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1]);
}
// Joints made by bind are marked extras.axes = "world": the tools' rotations and moves on them are about the world
// X/Y/Z axes as they stand at rest (the joint's own oriented axes are hidden from the API). Other joints (rigs made in
// Blender etc.) take rotations about their own rest axes and moves in their parent's axes, as before.
const worldAxes = (n) => n.getExtras?.()?.axes === 'world';
export function jointRot(n, e) {
  if (!worldAxes(n)) return e;
  const R = matQuat(n.getWorldMatrix());
  return qmul(qconj(R), qmul(e, R));
}
export function jointMove(n, m) {
  if (!worldAxes(n)) return m;
  const p = n.getParentNode();
  return p ? qrot(qconj(matQuat(p.getWorldMatrix())), m) : m;
}

export function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1; d *= s;
  if (d > 0.9995) {
    const o = a.map((v, i) => v + t * (s * b[i] - v)); const l = Math.hypot(...o); return o.map((v) => v / l);
  }
  const th = Math.acos(d), sa = Math.sin((1 - t) * th) / Math.sin(th), sb = (s * Math.sin(t * th)) / Math.sin(th);
  return a.map((v, i) => sa * v + sb * b[i]);
}

export function animDuration(anim) {
  let d = 0;
  for (const c of anim.listChannels()) { const a = c.getSampler().getInput().getArray(); d = Math.max(d, a[a.length - 1]); }
  return d;
}

// Map(node -> {translation?, rotation?, scale?}) at time t
export function sampleAnim(anim, t) {
  const out = new Map();
  for (const ch of anim.listChannels()) {
    const node = ch.getTargetNode(), path = ch.getTargetPath();
    if (!node || !['translation', 'rotation', 'scale'].includes(path)) continue;
    const smp = ch.getSampler(), T = smp.getInput().getArray(), Vacc = smp.getOutput();
    const n = path === 'rotation' ? 4 : 3, cubic = smp.getInterpolation() === 'CUBICSPLINE';
    const get = (k) => { const e = new Array(n).fill(0); Vacc.getElement(cubic ? k * 3 + 1 : k, e); return e; };
    let v;
    if (t <= T[0]) v = get(0);
    else if (t >= T[T.length - 1]) v = get(T.length - 1);
    else {
      let k = 0; while (T[k + 1] < t) k++;
      const f = (t - T[k]) / (T[k + 1] - T[k]), a = get(k), b = get(k + 1);
      v = smp.getInterpolation() === 'STEP' ? a : path === 'rotation' ? slerp(a, b, f) : a.map((x, i) => x + f * (b[i] - x));
    }
    (out.get(node) ?? out.set(node, {}).get(node))[path] = v;
  }
  return out;
}

// world matrix for every node in the default scene; anim: Map from sampleAnim; pose: Map(node -> quat) on top
export function evalWorld(doc, anim = null, pose = null) {
  const W = new Map();
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const visit = (node, parent) => {
    const a = anim?.get(node);
    let r = a?.rotation ?? node.getRotation();
    const p = pose?.get(node); if (p) r = qmul(r, p);
    const L = trs(a?.translation ?? node.getTranslation(), r, a?.scale ?? node.getScale());
    const M = parent ? mul(parent, L) : L;
    W.set(node, M);
    for (const c of node.listChildren()) visit(c, M);
  };
  for (const n of scene.listChildren()) visit(n, null);
  return W;
}

// all triangle primitives of mesh nodes in the scene, concatenated
export function gatherAll(doc) {
  const parts = [];
  const W = evalWorld(doc);
  for (const node of W.keys()) {
    const mesh = node.getMesh(); if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) if (prim.getMode() === 4 && prim.getAttribute('POSITION')) parts.push({ node, skin: node.getSkin(), prim });
  }
  let nV = 0, nI = 0;
  for (const p of parts) { const c = p.prim.getAttribute('POSITION').getCount(); p.offset = nV; p.count = c; nV += c; nI += p.prim.getIndices()?.getCount() ?? c; }
  const idx = new Uint32Array(nI);
  let o = 0;
  for (const p of parts) {
    const ind = p.prim.getIndices();
    if (ind) { const a = ind.getArray(); for (let k = 0; k < a.length; k++) idx[o + k] = a[k] + p.offset; o += a.length; }
    else { for (let k = 0; k < p.count; k++) idx[o + k] = p.offset + k; o += p.count; }
  }
  return { parts, nV, idx };
}

// posed world-space positions (linear blend skinning for skinned parts)
export function posedPositions(G, W) {
  const out = new Float32Array(G.nV * 3), e = [0, 0, 0], j = [0, 0, 0, 0], w = [0, 0, 0, 0];
  for (const p of G.parts) {
    const P = p.prim.getAttribute('POSITION');
    if (!p.skin) {
      const M = W.get(p.node);
      for (let i = 0; i < p.count; i++) {
        P.getElement(i, e);
        for (let r = 0; r < 3; r++) out[(p.offset + i) * 3 + r] = M[r] * e[0] + M[4 + r] * e[1] + M[8 + r] * e[2] + M[12 + r];
      }
      continue;
    }
    const joints = p.skin.listJoints(), ibmA = p.skin.getInverseBindMatrices();
    const JM = joints.map((jn, k) => {
      const ibm = new Float64Array(16); if (ibmA) { const t = new Array(16); ibmA.getElement(k, t); ibm.set(t); } else [0, 5, 10, 15].forEach((q) => (ibm[q] = 1));
      return mul(W.get(jn) ?? trs([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), ibm);
    });
    const J = p.prim.getAttribute('JOINTS_0'), Wt = p.prim.getAttribute('WEIGHTS_0');
    for (let i = 0; i < p.count; i++) {
      P.getElement(i, e); J.getElement(i, j); Wt.getElement(i, w);
      let x = 0, y = 0, z = 0;
      for (let s = 0; s < 4; s++) {
        if (!w[s]) continue; const M = JM[j[s]];
        x += w[s] * (M[0] * e[0] + M[4] * e[1] + M[8] * e[2] + M[12]);
        y += w[s] * (M[1] * e[0] + M[5] * e[1] + M[9] * e[2] + M[13]);
        z += w[s] * (M[2] * e[0] + M[6] * e[1] + M[10] * e[2] + M[14]);
      }
      out[(p.offset + i) * 3] = x; out[(p.offset + i) * 3 + 1] = y; out[(p.offset + i) * 3 + 2] = z;
    }
  }
  return out;
}

// per-vertex dominant joint name and weight of a given joint (for weight colouring)
export function weightInfo(G, boneName) {
  const dom = new Array(G.nV).fill(null), wOf = new Float32Array(G.nV), j = [0, 0, 0, 0], w = [0, 0, 0, 0];
  for (const p of G.parts) {
    if (!p.skin) continue;
    const names = p.skin.listJoints().map((n) => n.getName());
    const J = p.prim.getAttribute('JOINTS_0'), Wt = p.prim.getAttribute('WEIGHTS_0');
    for (let i = 0; i < p.count; i++) {
      J.getElement(i, j); Wt.getElement(i, w);
      let m = 0; for (let s = 1; s < 4; s++) if (w[s] > w[m]) m = s;
      dom[p.offset + i] = w[m] > 0 ? names[j[m]] : null;
      if (boneName) for (let s = 0; s < 4; s++) if (names[j[s]] === boneName) wOf[p.offset + i] += w[s];
    }
  }
  return { dom, wOf };
}

export function invert(m) {
  // affine 4x4 inverse (column-major)
  const a = m, o = new Float64Array(16);
  const det = a[0] * (a[5] * a[10] - a[9] * a[6]) - a[4] * (a[1] * a[10] - a[9] * a[2]) + a[8] * (a[1] * a[6] - a[5] * a[2]);
  const id = 1 / det;
  o[0] = (a[5] * a[10] - a[9] * a[6]) * id; o[4] = -(a[4] * a[10] - a[8] * a[6]) * id; o[8] = (a[4] * a[9] - a[8] * a[5]) * id;
  o[1] = -(a[1] * a[10] - a[9] * a[2]) * id; o[5] = (a[0] * a[10] - a[8] * a[2]) * id; o[9] = -(a[0] * a[9] - a[8] * a[1]) * id;
  o[2] = (a[1] * a[6] - a[5] * a[2]) * id; o[6] = -(a[0] * a[6] - a[4] * a[2]) * id; o[10] = (a[0] * a[5] - a[4] * a[1]) * id;
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * a[12] + o[4 + r] * a[13] + o[8 + r] * a[14]);
  o[15] = 1;
  return o;
}
const xf = (M, p) => [0, 1, 2].map((r) => M[r] * p[0] + M[4 + r] * p[1] + M[8 + r] * p[2] + M[12 + r]);

// skeleton overlay: one segment head -> tail per bone (tail from the joint extras written by bind, else its only
// child joint), dots at every head (world space, posed by W)
export function skeletonLines(doc, W) {
  const lines = [], dots = [];
  const joints = new Set(doc.getRoot().listSkins().flatMap((s) => s.listJoints()));
  const R = evalWorld(doc);
  const pos = (n) => { const M = W.get(n); return [M[12], M[13], M[14]]; };
  for (const n of joints) {
    if (!W.has(n)) continue;
    const h = pos(n); dots.push(h);
    const tail = n.getExtras()?.tail;
    if (tail) lines.push([...h, ...xf(W.get(n), xf(invert(R.get(n)), tail))]);
    else { const kids = n.listChildren().filter((c) => joints.has(c)); if (kids.length === 1) lines.push([...h, ...pos(kids[0])]); }
  }
  return { lines, dots };
}
