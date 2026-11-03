// rig-worker side: make the assets Blender has to open, and the numbers it has to reproduce.
//   node test/blender/make.mjs <dir>     (<dir> holds blender_mesh.glb and blender_rig.glb from make_inputs.py)
// Writes <case>.glb plus ref.json and <case>.*.f32: rest positions, colours, dense weights and posed positions at
// sample times of every clip, all in glTF space, all computed by rig-worker's own skinning (scene.js).
import { readFileSync, writeFileSync } from 'node:fs';
import * as T from '../../src/tools.js';
import { readGLB, writeGLB } from '../../src/glb.js';
import { gatherAll, evalWorld, posedPositions, sampleAnim, animDuration } from '../../src/scene.js';

const dir = process.argv[2] ?? 'work/blender';
const ex = (f) => JSON.parse(readFileSync(new URL(`../../examples/pip/${f}`, import.meta.url), 'utf8'));
const roundTrip = async (doc) => readGLB(await writeGLB(doc));

const cases = {};

// 1. model only: Pip, unrigged, vertex colours
const model = await roundTrip(T.model({ model: { ...ex('model.json'), res: 0.012 } }).doc);
cases.pip_model = model;

// 2. Pip rigged by bind, painted, three clips: walk (linear, root motion), wave (linear), pose (step)
const rig = await roundTrip(T.model({ model: { ...ex('model.json'), res: 0.012 } }).doc);
T.bind(rig, { skeleton: ex('skeleton.json') });
for (const p of ex('paint.json')) T.paintWeights(rig, p);
T.animate(rig, ex('walk.json'));
T.animate(rig, { name: 'wave', duration: 1, tracks: [
  { bone: 'UpperArm.L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.25, rot: [0, -10, 140] }, { t: 0.5, rot: [0, 10, 120] }, { t: 0.75, rot: [0, -10, 140] }] },
  { bone: 'LowerArm.L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.25, rot: [0, 0, 40] }, { t: 0.5, rot: [0, 0, 10] }, { t: 0.75, rot: [0, 0, 40] }] },
  { bone: 'Head', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.5, rot: [10, 25, 0] }] },
] });
T.animate(rig, { name: 'pose', duration: 1, loop: false, interpolation: 'STEP', tracks: [
  { bone: 'Hips', keys: [{ t: 0, move: [0, 0, 0] }, { t: 0.5, move: [0, -0.08, 0.05], rot: [20, 0, 0] }] },
  { bone: 'UpperLeg.L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.5, rot: [-70, 0, 0] }] },
  { bone: 'LowerLeg.L', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.5, rot: [80, 0, 0] }] },
] });
cases.pip_rig = await roundTrip(rig);

// 3. a Blender mesh with UVs and an image texture, rigged from scratch by bind
const bm = await readGLB(new Uint8Array(readFileSync(`${dir}/blender_mesh.glb`)));
T.bind(bm, { skeleton: { bones: [
  { name: 'Root', parent: null, head: [0, 0.05, 0], tail: [0, 0.55, 0] },
  { name: 'Mid', parent: 'Root', head: [0, 0.55, 0], tail: [0, 1.05, 0] },
  { name: 'Top', parent: 'Mid', head: [0, 1.05, 0], tail: [0, 1.58, 0] },
] } });
T.animate(bm, { name: 'sway', duration: 1, tracks: [
  { bone: 'Mid', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.5, rot: [0, 0, 30] }] },
  { bone: 'Top', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.5, rot: [15, 0, 20] }] },
] });
cases.from_blender_mesh = await roundTrip(bm);

// 4. a Blender rig (tilted bones with rolls, its own clip "bend"): re-weighted by bind, a clip added by animate
const br = await readGLB(new Uint8Array(readFileSync(`${dir}/blender_rig.glb`)));
const sk = T.readSkeleton(br);
const b4 = T.bind(br, { skeleton: sk });
if (b4.createdSkin) throw new Error('expected a re-weight of the existing skin');
T.animate(br, { name: 'twist', duration: 1, tracks: [{ bone: 'Top', keys: [{ t: 0, rot: [0, 0, 0] }, { t: 0.5, rot: [0, 40, 0] }] }] });
cases.from_blender_rig = await roundTrip(br);

// reference numbers
const ref = { cases: {} };
const f32 = (name, arr) => writeFileSync(`${dir}/${name}.f32`, Buffer.from(new Float32Array(arr).buffer));
for (const [name, doc] of Object.entries(cases)) {
  writeFileSync(`${dir}/${name}.glb`, await writeGLB(doc));
  const G = gatherAll(doc), skin = doc.getRoot().listSkins()[0];
  const bones = skin ? skin.listJoints().map((j) => j.getName()) : [];
  const parents = skin ? skin.listJoints().map((j) => { const p = j.getParentNode(); return p && skin.listJoints().includes(p) ? p.getName() : null; }) : [];
  f32(`${name}.rest`, posedPositions(G, evalWorld(doc)));
  const col = []; let hasCol = false;
  for (const p of G.parts) { const C = p.prim.getAttribute('COLOR_0'), e = [0, 0, 0, 0]; if (C) hasCol = true; for (let i = 0; i < p.count; i++) { if (C) C.getElement(i, e); col.push(e[0], e[1], e[2]); } }
  if (hasCol) f32(`${name}.col`, col);
  if (skin) { // dense weights [nV][nB]
    const W = new Float32Array(G.nV * bones.length), j = [0, 0, 0, 0], w = [0, 0, 0, 0];
    for (const p of G.parts) {
      const J = p.prim.getAttribute('JOINTS_0'), Wt = p.prim.getAttribute('WEIGHTS_0');
      for (let i = 0; i < p.count; i++) { J.getElement(i, j); Wt.getElement(i, w); for (let s = 0; s < 4; s++) W[(p.offset + i) * bones.length + j[s]] += w[s]; }
    }
    f32(`${name}.w`, W);
  }
  const anims = {};
  for (const a of doc.getRoot().listAnimations()) {
    const d = animDuration(a), times = [0, 0.13, 0.25, 0.4, 0.5, 0.62, 0.75, 0.9].map((f) => +(f * d).toFixed(4));
    const out = [];
    for (const t of times) out.push(...posedPositions(G, evalWorld(doc, sampleAnim(a, t))));
    f32(`${name}.anim.${a.getName()}`, out);
    anims[a.getName()] = { duration: d, times, interpolation: a.listSamplers()[0].getInterpolation() };
  }
  const mats = doc.getRoot().listMaterials().map((m) => ({ name: m.getName(), texture: !!m.getBaseColorTexture() }));
  ref.cases[name] = { nV: G.nV, triangles: G.idx.length / 3, bones, parents, hasColor: hasCol, anims, materials: mats,
    uvs: G.parts.some((p) => p.prim.getAttribute('TEXCOORD_0')),
    boneTails: skin ? Object.fromEntries(T.readSkeleton(doc).bones.map((b) => [b.name, [b.head, b.tail]])) : {} };
}
writeFileSync(`${dir}/ref.json`, JSON.stringify(ref, null, 1));
console.log(Object.entries(ref.cases).map(([k, v]) => `${k}: ${v.nV} verts, ${v.bones.length} bones, clips ${Object.keys(v.anims).join('/') || '-'}`).join('\n'));
