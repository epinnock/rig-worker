// Blender side, step 3 (the way back): rig-worker opens Blender's re-exports (<dir>/from_blender/<case>.glb, written
// by check.py) and must see the same mesh, bones, weights and motion it made, then keep working on them (qa, bind, animate).
//   node test/blender/reimport.mjs <dir>
// Blender may split vertices at UV or normal seams on export, so vertices are matched by rest position.
import { readFileSync, writeFileSync } from 'node:fs';
import * as T from '../../src/tools.js';
import { readGLB, writeGLB } from '../../src/glb.js';
import { gatherAll, evalWorld, posedPositions, sampleAnim } from '../../src/scene.js';

const dir = process.argv[2] ?? 'work/blender';
const ref = JSON.parse(readFileSync(`${dir}/ref.json`, 'utf8'));
const f32 = (n) => { const b = readFileSync(`${dir}/${n}.f32`); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const TOL = { rest: 1e-4, anim: 1e-3, weight: 5e-3 };

function nearest(src, dst) { // for each src point, index of the nearest dst point (hash grid)
  const h = 0.02, key = (x, y, z) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`, g = new Map();
  for (let i = 0; i < dst.length / 3; i++) { const k = key(dst[3 * i], dst[3 * i + 1], dst[3 * i + 2]); (g.get(k) ?? g.set(k, []).get(k)).push(i); }
  const out = new Int32Array(src.length / 3);
  for (let i = 0; i < out.length; i++) {
    const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2], cx = Math.floor(x / h), cy = Math.floor(y / h), cz = Math.floor(z / h);
    let best = -1, bd = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++)
      for (const j of g.get(`${cx + a},${cy + b},${cz + c}`) ?? []) { const d = (dst[3 * j] - x) ** 2 + (dst[3 * j + 1] - y) ** 2 + (dst[3 * j + 2] - z) ** 2; if (d < bd) { bd = d; best = j; } }
    out[i] = best;
  }
  return out;
}
const maxErr = (a, b, map) => { let m = 0; for (let i = 0; i < map.length; i++) for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(a[3 * i + c] - b[3 * map[i] + c])); return m; };

const report = {}; const failed = [];
for (const [name, R] of Object.entries(ref.cases)) {
  const doc = await readGLB(new Uint8Array(readFileSync(`${dir}/from_blender/${name}.glb`)));
  const G = gatherAll(doc), C = { vertices: { reimport: G.nV, original: R.nV } };
  const rest = posedPositions(G, evalWorld(doc)), map = nearest(rest, f32(`${name}.rest`));
  C.restMaxError = maxErr(rest, f32(`${name}.rest`), map);
  let ok = C.restMaxError < TOL.rest;
  C.hasColor = G.parts.some((p) => p.prim.getAttribute('COLOR_0'));
  C.uvs = G.parts.some((p) => p.prim.getAttribute('TEXCOORD_0'));
  ok &&= C.hasColor === R.hasColor && C.uvs === R.uvs;
  const skin = doc.getRoot().listSkins()[0];
  if (R.bones.length) {
    const sk = T.readSkeleton(doc), names = sk.bones.map((b) => b.name);
    C.bonesMatch = R.bones.every((b, i) => names.includes(b) && sk.bones.find((x) => x.name === b).parent === R.parents[i]);
    ok &&= C.bonesMatch;
    // weights, by bone name
    const W = new Float32Array(G.nV * R.bones.length), jn = skin.listJoints().map((j) => R.bones.indexOf(j.getName())), j4 = [0, 0, 0, 0], w4 = [0, 0, 0, 0];
    for (const p of G.parts) { const J = p.prim.getAttribute('JOINTS_0'), Wt = p.prim.getAttribute('WEIGHTS_0'); for (let i = 0; i < p.count; i++) { J.getElement(i, j4); Wt.getElement(i, w4); for (let s = 0; s < 4; s++) if (w4[s] > 0) W[(p.offset + i) * R.bones.length + jn[j4[s]]] += w4[s]; } }
    const Wr = f32(`${name}.w`); let we = 0;
    for (let i = 0; i < G.nV; i++) for (let b = 0; b < R.bones.length; b++) we = Math.max(we, Math.abs(W[i * R.bones.length + b] - Wr[map[i] * R.bones.length + b]));
    C.weightMaxError = we; ok &&= we < TOL.weight;
    C.clips = {};
    for (const [clip, A] of Object.entries(R.anims)) {
      const an = doc.getRoot().listAnimations().find((x) => x.getName() === clip);
      if (!an) { C.clips[clip] = 'missing'; ok = false; continue; }
      const P = f32(`${name}.anim.${clip}`), per = P.length / A.times.length;
      const errs = A.times.map((t, k) => maxErr(posedPositions(G, evalWorld(doc, sampleAnim(an, t))), P.subarray(k * per, (k + 1) * per), map));
      C.clips[clip] = { maxError: Math.max(...errs), perSample: errs.map((e) => +e.toFixed(5)) }; ok &&= Math.max(...errs) < TOL.anim;
    }
    // keep working on it: qa a clip, then re-bind and add a clip
    const q = T.qa(doc, { animation: Object.keys(R.anims)[0] });
    C.qa = { worst: q.worst ?? q.summary?.worst ?? null };
    T.bind(doc, { skeleton: sk });
    T.animate(doc, { name: 'again', duration: 1, tracks: [{ bone: R.bones[1] ?? R.bones[0], keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.5, rot: [0, 0, 25] }] }] });
    const out = await readGLB(await writeGLB(doc));
    C.reworked = out.getRoot().listAnimations().map((a) => a.getName());
  }
  C.ok = !!ok; if (!ok) failed.push(name);
  report[name] = C;
  console.log(`REIMPORT ${name}: ${ok ? 'ok' : 'FAIL'}  verts ${G.nV}/${R.nV}  rest ${C.restMaxError.toExponential(1)}` +
    (C.clips ? `  clips ${Object.entries(C.clips).map(([k, v]) => `${k} ${v.maxError?.toExponential(1) ?? v}`).join(', ')}` : ''));
}
writeFileSync(`${dir}/reimport_report.json`, JSON.stringify(report, null, 1));
console.log('REIMPORT_CHECK', failed.length ? 'FAILED ' + failed.join(', ') : 'OK');
process.exit(failed.length ? 1 : 0);
