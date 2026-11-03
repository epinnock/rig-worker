// GLB in -> heat weights -> GLB out. Works in Workers and Node (WebIO.readBinary / writeBinary only).
import { WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { bindHeat } from './heat.js';

const io = () => new WebIO().registerExtensions(ALL_EXTENSIONS);

// Skinned primitives, their bind-pose positions (world space) and triangles, concatenated into one mesh.
export function gather(doc) {
  const parts = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh(), skin = node.getSkin();
    if (!mesh || !skin) continue;
    const M = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) parts.push({ node, skin, prim, M });
  }
  if (!parts.length) throw new Error('no skinned mesh in the GLB');
  let nV = 0, nI = 0;
  for (const p of parts) { nV += p.prim.getAttribute('POSITION').getCount(); nI += p.prim.getIndices()?.getCount() ?? 0; }
  const pos = new Float32Array(nV * 3), idx = new Uint32Array(nI);
  let vo = 0, io2 = 0;
  for (const p of parts) {
    const a = p.prim.getAttribute('POSITION'), n = a.getCount(), M = p.M, el = [0, 0, 0];
    p.offset = vo; p.count = n;
    for (let i = 0; i < n; i++) {
      a.getElement(i, el);
      for (let r = 0; r < 3; r++) pos[(vo + i) * 3 + r] = M[r] * el[0] + M[4 + r] * el[1] + M[8 + r] * el[2] + M[12 + r];
    }
    const ind = p.prim.getIndices();
    if (ind) { const arr = ind.getArray(); for (let k = 0; k < arr.length; k++) idx[io2 + k] = arr[k] + vo; io2 += arr.length; }
    vo += n;
  }
  return { parts, pos, idx };
}

// Dense (nV x bones) weights currently in the GLB, in skeleton bone order (for comparisons).
export function denseWeights(parts, nV, bones) {
  const K = bones.length, out = new Float32Array(nV * K), j = [0, 0, 0, 0], w = [0, 0, 0, 0];
  for (const p of parts) {
    const jn = p.skin.listJoints().map((n) => n.getName());
    const col = jn.map((n) => bones.findIndex((b) => b.name === n));
    const J = p.prim.getAttribute('JOINTS_0'), W = p.prim.getAttribute('WEIGHTS_0');
    if (!J || !W) continue;
    for (let i = 0; i < p.count; i++) {
      J.getElement(i, j); W.getElement(i, w);
      for (let s = 0; s < 4; s++) if (w[s] > 0 && col[j[s]] >= 0) out[(p.offset + i) * K + col[j[s]]] += w[s];
    }
  }
  return out;
}

export const readGLB = (bytes) => io().readBinary(bytes);
export const writeGLB = (doc) => io().writeBinary(doc);

export async function rebind(bytes, skeleton, opt = {}) {
  const doc = await io().readBinary(bytes);
  const r = bindDoc(doc, skeleton, opt);
  const glb = await io().writeBinary(doc);
  return { glb, ...r };
}

// Bind a document in place: re-weights an existing skin whose joints carry the bone names, or, when no mesh is
// skinned yet, builds the skeleton (joint nodes under an "Armature" node) and the skin first.
export function bindDoc(doc, skeleton, opt = {}) {
  const skinned = doc.getRoot().listNodes().some((n) => n.getMesh() && n.getSkin());
  let created = null;
  if (!skinned) created = createSkin(doc, skeleton);
  const { parts, pos, idx } = gather(doc);
  const bones = skeleton.bones;
  const before = opt.compare ? denseWeights(parts, pos.length / 3, bones) : null;
  const res = bindHeat(pos, idx, bones, opt);
  for (const p of parts) {
    const jn = p.skin.listJoints().map((n) => n.getName());
    const map = bones.map((b) => {
      const k = jn.indexOf(b.name);
      if (k < 0) throw new Error(`bone ${b.name} is not a joint of skin ${p.skin.getName()}`);
      return k;
    });
    const J = new Uint8Array(p.count * 4), W = res.weights.slice(p.offset * 4, (p.offset + p.count) * 4);
    for (let q = 0; q < p.count * 4; q++) J[q] = W[q] > 0 ? map[res.joints[p.offset * 4 + q]] : 0;
    const buf = doc.getRoot().listBuffers()[0];
    p.prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(J).setBuffer(buf));
    p.prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(W).setBuffer(buf));
  }
  // drop the old, now unused accessors so the file does not grow
  for (const a of doc.getRoot().listAccessors()) if (a.listParents().length <= 1) a.dispose();
  return { stats: { ...res.stats, createdSkin: !!created }, before, joints: res.joints, weights: res.weights, pos };
}

// Joints are world-axis aligned in rest (identity rotation), translated to each bone head. A pose rotation of
// [x, y, z] degrees on a joint therefore turns about the world X/Y/Z axes through the joint, which is easy to reason about.
export function createSkin(doc, skeleton) {
  const root = doc.getRoot(), scene = root.getDefaultScene() ?? root.listScenes()[0] ?? doc.createScene('Scene');
  if (!root.getDefaultScene()) root.setDefaultScene(scene);
  const meshNodes = root.listNodes().filter((n) => n.getMesh());
  if (!meshNodes.length) throw new Error('no mesh in the GLB');
  const bones = skeleton.bones, byName = new Map(bones.map((b) => [b.name, b]));
  if (byName.size !== bones.length) throw new Error('duplicate bone names');
  for (const b of bones) if (b.parent && !byName.has(b.parent)) throw new Error(`bone ${b.name}: unknown parent ${b.parent}`);
  // cycle check
  for (const b of bones) { let c = b, k = 0; while (c.parent) { c = byName.get(c.parent); if (++k > bones.length) throw new Error(`parent cycle at ${b.name}`); } }
  const arm = doc.createNode('Armature');
  scene.addChild(arm);
  const nodes = new Map(bones.map((b) => [b.name, doc.createNode(b.name)]));
  for (const b of bones) {
    const n = nodes.get(b.name), ph = b.parent ? byName.get(b.parent).head : [0, 0, 0];
    n.setTranslation([b.head[0] - ph[0], b.head[1] - ph[1], b.head[2] - ph[2]]);
    n.setExtras({ tail: b.tail, ...(b.falloff ? { falloff: b.falloff } : {}) });
    (b.parent ? nodes.get(b.parent) : arm).addChild(n);
  }
  const skin = doc.createSkin('Armature');
  for (const b of bones) skin.addJoint(nodes.get(b.name));
  skin.setSkeleton(nodes.get(bones.find((b) => !b.parent).name));
  const buf = root.listBuffers()[0] ?? doc.createBuffer();
  // IBM_j = inverse(jointWorld_j) * meshWorld; meshes are expected to share one world transform (TRELLIS/Meshy: identity)
  const M = meshNodes[0].getWorldMatrix();
  const ibm = new Float32Array(bones.length * 16);
  bones.forEach((b, j) => {
    const T = [...M]; T[12] -= b.head[0]; T[13] -= b.head[1]; T[14] -= b.head[2];
    ibm.set(T, j * 16);
  });
  skin.setInverseBindMatrices(doc.createAccessor('IBM').setType('MAT4').setArray(ibm).setBuffer(buf));
  for (const n of meshNodes) n.setSkin(skin);
  return skin;
}

// skeleton JSON back out of a skinned document (heads from joint world positions, tails from extras or first child)
export function readSkeleton(doc) {
  const skin = doc.getRoot().listSkins()[0];
  if (!skin) return null;
  const joints = skin.listJoints(), set = new Set(joints);
  return {
    bones: joints.map((j) => {
      const M = j.getWorldMatrix(), head = [M[12], M[13], M[14]].map((v) => +v.toFixed(5));
      const pn = j.getParentNode(), parent = pn && set.has(pn) ? pn.getName() : null;
      const ex = j.getExtras() ?? {};
      let tail = ex.tail;
      if (!tail) { const c = j.listChildren().find((k) => set.has(k)); if (c) { const C = c.getWorldMatrix(); tail = [C[12], C[13], C[14]].map((v) => +v.toFixed(5)); } }
      return { name: j.getName(), head, tail: tail ?? head, parent, ...(ex.falloff ? { falloff: ex.falloff } : {}) };
    }),
  };
}
