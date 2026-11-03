// Agent tools on GLB documents. Pure functions of (doc, args); storage and transport live in worker.js / mcp.js.
import { bindDoc, readSkeleton } from './glb.js';
import { evalWorld, gatherAll, posedPositions, weightInfo, skeletonLines, sampleAnim, animDuration, eulerDeg, qmul, mul, slerp, jointRot, jointMove } from './scene.js';
import { renderTiles, encodePNG, palette, heat, fitFrame } from './render.js';
import { build, toDocument, applyPatch, storedModel, normalizeModel } from './sdf.js';

const r4 = (v) => +v.toFixed(4);
const findAnim = (doc, name) => {
  const all = doc.getRoot().listAnimations();
  if (!all.length) return null;
  if (name == null) return all[0];
  const a = all.find((x) => x.getName() === name);
  if (!a) throw new Error(`no animation ${name}; have ${all.map((x) => x.getName()).join(', ')}`);
  return a;
};
const jointByName = (doc) => {
  const m = new Map();
  for (const s of doc.getRoot().listSkins()) for (const j of s.listJoints()) m.set(j.getName(), j);
  return m;
};
// pose: {bone: [xDeg, yDeg, zDeg]} -> Map(node -> quat), applied on top of rest/animation
function poseMap(doc, pose) {
  if (!pose) return null;
  const J = jointByName(doc), m = new Map();
  for (const [b, e] of Object.entries(pose)) {
    const n = J.get(b); if (!n) throw new Error(`pose: no bone ${b}`);
    m.set(n, jointRot(n, eulerDeg(...e)));
  }
  return m;
}

function bbox(pos) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pos[i + a]); hi[a] = Math.max(hi[a], pos[i + a]); }
  return { min: lo.map(r4), max: hi.map(r4) };
}

// ---------- inspect ----------
// Facts an agent needs to place bones without seeing: bounds, and blobs in horizontal slices (legs, arms, tail show
// up as separate x-z clusters), plus the skin and animations if present.
export function inspect(doc, { slices = 16 } = {}) {
  const G = gatherAll(doc), W = evalWorld(doc), pos = posedPositions(G, W);
  const bb = bbox(pos);
  const out = {
    axes: 'glTF: +Y up, +Z = front of a character facing the viewer, +X = the character\'s left',
    meshes: G.parts.map((p) => ({ node: p.node.getName(), vertices: p.count, skinned: !!p.skin })),
    vertices: G.nV, triangles: G.idx.length / 3, bounds: bb,
    skin: null, animations: doc.getRoot().listAnimations().map((a) => ({ name: a.getName(), duration: r4(animDuration(a)), channels: a.listChannels().length })),
  };
  const sk = readSkeleton(doc);
  if (sk) out.skin = { bones: sk.bones.length, skeleton: sk };
  // slices along Y: cluster vertices in each slab on the X-Z plane by a coarse occupancy grid + flood fill
  const h = (bb.max[1] - bb.min[1]) / slices, cell = Math.max(bb.max[0] - bb.min[0], bb.max[2] - bb.min[2]) / 48;
  out.slices = [];
  for (let s = 0; s < slices; s++) {
    const y0 = bb.min[1] + s * h, y1 = y0 + h, occ = new Map();
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 1] < y0 || pos[i + 1] >= (s === slices - 1 ? y1 + 1e-9 : y1)) continue;
      const k = `${Math.floor((pos[i] - bb.min[0]) / cell)},${Math.floor((pos[i + 2] - bb.min[2]) / cell)}`;
      const c = occ.get(k); if (c) { c.n++; c.x0 = Math.min(c.x0, pos[i]); c.x1 = Math.max(c.x1, pos[i]); c.z0 = Math.min(c.z0, pos[i + 2]); c.z1 = Math.max(c.z1, pos[i + 2]); }
      else occ.set(k, { n: 1, x0: pos[i], x1: pos[i], z0: pos[i + 2], z1: pos[i + 2] });
    }
    const seen = new Set(), blobs = [];
    for (const k of occ.keys()) {
      if (seen.has(k)) continue;
      const st = [k], b = { n: 0, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }; seen.add(k);
      while (st.length) {
        const q = st.pop(), c = occ.get(q), [a, d] = q.split(',').map(Number);
        b.n += c.n; b.x0 = Math.min(b.x0, c.x0); b.x1 = Math.max(b.x1, c.x1); b.z0 = Math.min(b.z0, c.z0); b.z1 = Math.max(b.z1, c.z1);
        for (let da = -1; da <= 1; da++) for (let dd = -1; dd <= 1; dd++) { const nk = `${a + da},${d + dd}`; if (occ.has(nk) && !seen.has(nk)) { seen.add(nk); st.push(nk); } }
      }
      if (b.n >= 8) blobs.push({ x: [r4(b.x0), r4(b.x1)], z: [r4(b.z0), r4(b.z1)], centre: [r4((b.x0 + b.x1) / 2), r4((b.z0 + b.z1) / 2)], verts: b.n });
    }
    blobs.sort((p, q) => p.centre[0] - q.centre[0]);
    out.slices.push({ y: [r4(y0), r4(y1)], blobs });
  }
  return out;
}

// ---------- preview ----------
// shaded colours: COLOR_0 (linear) or the material base colour, as sRGB bytes; null when every part is plain white/none
function surfaceColours(G) {
  const col = new Uint8Array(G.nV * 3), e = [0, 0, 0, 0], toS = (c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
  let any = false;
  for (const p of G.parts) {
    const C = p.prim.getAttribute('COLOR_0'), bc = p.prim.getMaterial()?.getBaseColorFactor() ?? [1, 1, 1, 1];
    const hasTex = !!p.prim.getMaterial()?.getBaseColorTexture();
    if (C || (!hasTex && bc.slice(0, 3).some((v) => v < 0.98))) any = true;
    for (let i = 0; i < p.count; i++) {
      if (C) C.getElement(i, e); else e[0] = e[1] = e[2] = 1; // getElement returns 0..1 for normalized ints too
      for (let q = 0; q < 3; q++) col[(p.offset + i) * 3 + q] = hasTex && !C ? 200 : Math.min(255, toS(Math.max(0, e[q] * bc[q])));
    }
  }
  return any ? col : null;
}

// mode: shaded | weights (dominant bone colours) | bone (one bone's weight, blue->red) ; skeleton overlay on top.
// views: azimuth degrees (0 = front, 90 = character's left side); or frames: n frames of an animation at one view.
export async function preview(doc, a = {}) {
  const G = gatherAll(doc);
  const mode = a.mode ?? 'shaded', views = a.views ?? [0, 90, 180, 270];
  const pm = poseMap(doc, a.pose);
  const anim = a.animation !== undefined || a.frames ? findAnim(doc, a.animation ?? null) : null;
  let col = mode === 'shaded' ? surfaceColours(G) : null, legend = null;
  if (mode !== 'shaded') {
    if (!G.parts.some((p) => p.skin)) throw new Error(`mode ${mode} needs a skinned mesh (bind first)`);
    const { dom, wOf } = weightInfo(G, mode === 'bone' ? a.bone : null);
    col = new Uint8Array(G.nV * 3);
    if (mode === 'bone') {
      if (!a.bone) throw new Error('mode bone needs bone');
      for (let i = 0; i < G.nV; i++) col.set(heat(wOf[i]), i * 3);
      legend = `${a.bone}: blue 0 -> red 1`;
    } else {
      const names = [...new Set(doc.getRoot().listSkins().flatMap((s) => s.listJoints().map((j) => j.getName())))];
      const cmap = new Map(names.map((n, i) => [n, palette(i)]));
      for (let i = 0; i < G.nV; i++) col.set(dom[i] ? cmap.get(dom[i]) : [255, 0, 255], i * 3);
      legend = Object.fromEntries(names.map((n) => [n, '#' + cmap.get(n).map((c) => c.toString(16).padStart(2, '0')).join('')]));
      legend['(none)'] = '#ff00ff';
    }
  }
  const overlay = a.skeleton === true || a.skeleton === undefined && mode !== 'shaded' ? 'skin' : a.skeleton && typeof a.skeleton === 'object' ? 'given' : null;
  const tiles = [];
  const frameTimes = [];
  if (anim && a.frames) {
    const n = Math.min(16, Math.max(1, a.frames)), d = animDuration(anim);
    for (let k = 0; k < n; k++) frameTimes.push(n === 1 ? 0 : (d * k) / (a.loop === false ? n - 1 : n));
  }
  const shots = frameTimes.length ? frameTimes.map((t) => ({ t, az: views[0] })) : views.slice(0, 8).map((az) => ({ t: anim ? (a.time ?? 0) : null, az }));
  for (const s of shots) {
    const W = evalWorld(doc, s.t != null && anim ? sampleAnim(anim, s.t) : null, pm);
    const pos = posedPositions(G, W);
    let lines = [], dots = [];
    if (overlay === 'skin') ({ lines, dots } = skeletonLines(doc, W));
    if (overlay === 'given') for (const b of a.skeleton.bones) { lines.push([...b.head, ...b.tail]); dots.push(b.head); }
    tiles.push({ pos, idx: G.idx, col, lines, dots, az: s.az, elev: a.elev ?? 10 });
  }
  const res = Math.min(512, Math.max(128, a.res ?? (tiles.length > 4 ? 256 : 320)));
  // camera: focus if given, else the rest-pose bounds (same scale in every call), grown only if a pose leaves them
  let frame;
  if (a.focus) frame = { centre: a.focus.centre, radius: a.focus.radius };
  else {
    const restPos = posedPositions(G, evalWorld(doc)), fr = fitFrame([restPos]), fa = fitFrame([restPos, ...tiles.map((t) => t.pos)]);
    frame = fa.radius > fr.radius * 1.05 ? fa : fr;
  }
  const img = renderTiles(tiles, { res, frame });
  const png = await encodePNG(img);
  return { png, info: { tiles: shots.map((s) => (s.t != null ? { t: r4(s.t), az: s.az } : { az: s.az })), layout: `${Math.min(4, tiles.length)} per row, left to right`,
    camera: { centre: frame.centre.map(r4), radius: r4(frame.radius), pxPerMetre: r4(img.pxPerMetre), note: 'tile centre = camera centre; screen right = +X at az 0' }, legend } };
}

// ---------- bind ----------
export function bind(doc, a) {
  if (!a.skeleton?.bones?.length) throw new Error('skeleton.bones required');
  const r = bindDoc(doc, a.skeleton, a.options ?? {});
  const s = r.stats, perBone = {};
  const K = a.skeleton.bones.length, n = r.joints.length / 4;
  for (let i = 0; i < n; i++) {
    let m = 0; for (let q = 1; q < 4; q++) if (r.weights[i * 4 + q] > r.weights[i * 4 + m]) m = q;
    const b = a.skeleton.bones[r.joints[i * 4 + m]].name; perBone[b] = (perBone[b] ?? 0) + 1;
  }
  const empty = a.skeleton.bones.filter((b) => !perBone[b.name] && !b.falloff).map((b) => b.name);
  return {
    createdSkin: s.createdSkin, vertices: n, bones: K, proxyVertices: s.proxyVerts, unconverged: s.unconverged, emptyFilled: s.emptyFilled,
    dominantVerticesPerBone: perBone, bonesOwningNoVertex: empty,
    hint: empty.length ? 'bones owning no vertex usually sit outside the mesh or behind another bone; check with preview skeleton overlay' : undefined,
  };
}

// ---------- paint_weights ----------
// region: {sphere: {centre, radius}} | {box: {min, max}}; op: set | add | scale; value; falloff 'smooth' softens a sphere edge
export function paintWeights(doc, a) {
  const J = jointByName(doc); const bone = J.get(a.bone);
  if (!bone) throw new Error(`no bone ${a.bone}`);
  const G = gatherAll(doc), W = evalWorld(doc), pos = posedPositions(G, W);
  const inside = (x, y, z) => {
    if (a.region?.sphere) { const { centre: c, radius: r } = a.region.sphere, d = Math.hypot(x - c[0], y - c[1], z - c[2]); return d > r ? 0 : a.falloff === 'smooth' ? 0.5 + 0.5 * Math.cos(Math.PI * d / r) : 1; }
    if (a.region?.box) { const { min, max } = a.region.box; return x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2] ? 1 : 0; }
    throw new Error('region.sphere or region.box required');
  };
  let changed = 0, touched = 0; const j4 = [0, 0, 0, 0], w4 = [0, 0, 0, 0];
  for (const p of G.parts) {
    if (!p.skin) continue;
    const joints = p.skin.listJoints(), bi = joints.indexOf(bone); if (bi < 0) continue;
    const JA = p.prim.getAttribute('JOINTS_0'), WA = p.prim.getAttribute('WEIGHTS_0');
    const Jn = new Uint16Array(p.count * 4), Wn = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      JA.getElement(i, j4); WA.getElement(i, w4);
      const g = p.offset + i, f = inside(pos[g * 3], pos[g * 3 + 1], pos[g * 3 + 2]);
      const m = new Map(); for (let s = 0; s < 4; s++) if (w4[s] > 0) m.set(j4[s], (m.get(j4[s]) ?? 0) + w4[s]);
      if (f > 0) {
        const cur = m.get(bi) ?? 0;
        let target = a.op === 'add' ? cur + a.value : a.op === 'scale' ? cur * a.value : a.value;
        target = Math.min(1, Math.max(0, cur + (target - cur) * f));
        // other bones share the rest in their old proportions
        const others = [...m].filter(([k]) => k !== bi), os = others.reduce((s, [, v]) => s + v, 0);
        m.clear();
        if (target > 0) m.set(bi, target);
        if (os > 0) for (const [k, v] of others) m.set(k, (v / os) * (1 - target));
        else if (target < 1 && target > 0) m.set(bi, 1); // nothing to share with
        touched++;
        const before = new Map(); for (let q = 0; q < 4; q++) if (w4[q] > 0) before.set(j4[q], (before.get(j4[q]) ?? 0) + w4[q]);
        const keys = new Set([...before.keys(), ...m.keys()]);
        if ([...keys].some((k) => Math.abs((before.get(k) ?? 0) - (m.get(k) ?? 0)) > 1e-3)) changed++;
      }
      const top = [...m].filter(([, v]) => v > 1e-4).sort((x, y) => y[1] - x[1]).slice(0, 4), s = top.reduce((t, [, v]) => t + v, 0) || 1;
      top.forEach(([k, v], q) => { Jn[i * 4 + q] = k; Wn[i * 4 + q] = v / s; });
    }
    const buf = doc.getRoot().listBuffers()[0];
    const Jt = joints.length < 256 ? new Uint8Array(Jn) : Jn;
    p.prim.setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(Jt).setBuffer(buf));
    p.prim.setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(Wn).setBuffer(buf));
  }
  for (const acc of doc.getRoot().listAccessors()) if (acc.listParents().length <= 1) acc.dispose();
  return { bone: a.bone, verticesInRegion: touched, verticesChanged: changed,
    ...(touched ? changed ? {} : { hint: 'vertices are in the region but already had that weight' } : { hint: 'no surface vertex inside the region (joint heads sit inside the mesh; use a bigger radius, a box, or a hotspot restBox from qa)' }) };
}

// ---------- animate ----------
// tracks: [{bone, keys: [{t, rot?: [xDeg,yDeg,zDeg], move?: [dx,dy,dz]}]}]; rotation is relative to the bone's rest
// (joints made by bind have world-aligned rest axes), move is an offset from the rest translation (in parent space).
export function animate(doc, a) {
  if (!a.name) throw new Error('name required');
  if (!a.tracks?.length) throw new Error('tracks required');
  const J = jointByName(doc), root = doc.getRoot(), buf = root.listBuffers()[0];
  const old = root.listAnimations().find((x) => x.getName() === a.name);
  if (old) { for (const c of old.listChannels()) c.dispose(); for (const s of old.listSamplers()) s.dispose(); old.dispose(); }
  const anim = doc.createAnimation(a.name);
  const loop = a.loop !== false;
  let dur = 0;
  for (const tr of a.tracks) {
    const n = J.get(tr.bone); if (!n) throw new Error(`animate: no bone ${tr.bone}`);
    const keys = [...tr.keys].sort((p, q) => p.t - q.t);
    if (loop && a.duration && keys[keys.length - 1].t < a.duration) keys.push({ ...keys[0], t: a.duration });
    dur = Math.max(dur, keys[keys.length - 1].t);
    const T = new Float32Array(keys.map((k) => k.t));
    const rest = n.getRotation(), rt = n.getTranslation();
    if (keys.some((k) => k.rot)) {
      const qs = []; let prev = null;
      for (const k of keys) {
        let q = qmul(rest, jointRot(n, eulerDeg(...(k.rot ?? [0, 0, 0]))));
        if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = q.map((v) => -v);
        qs.push(q); prev = q;
      }
      // glTF LINEAR rotations are slerped, but Blender (and some engines) blend quaternion components linearly between
      // keys, which drifts on big turns. Extra keys on the same slerp path every 20 degrees or less keep them all equal.
      const tq = [keys[0].t], oq = [qs[0]];
      for (let i = 1; i < keys.length; i++) {
        const d = Math.min(1, Math.abs(qs[i - 1].reduce((s, v, c) => s + v * qs[i][c], 0)));
        const steps = (a.interpolation ?? 'LINEAR') === 'LINEAR' ? Math.max(1, Math.ceil((2 * Math.acos(d) * 180 / Math.PI) / 20)) : 1;
        for (let j = 1; j <= steps; j++) {
          tq.push(keys[i - 1].t + (keys[i].t - keys[i - 1].t) * j / steps);
          oq.push(j === steps ? qs[i] : slerp(qs[i - 1], qs[i], j / steps));
        }
      }
      const R = new Float32Array(oq.flat()), TR = new Float32Array(tq);
      const s = doc.createAnimationSampler().setInput(doc.createAccessor().setArray(TR).setType('SCALAR').setBuffer(buf))
        .setOutput(doc.createAccessor().setArray(R).setType('VEC4').setBuffer(buf)).setInterpolation(a.interpolation ?? 'LINEAR');
      anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(n).setTargetPath('rotation').setSampler(s));
    }
    if (keys.some((k) => k.move)) {
      const P = new Float32Array(keys.length * 3);
      keys.forEach((k, i) => { const m = jointMove(n, k.move ?? [0, 0, 0]); P.set([rt[0] + m[0], rt[1] + m[1], rt[2] + m[2]], i * 3); });
      const s = doc.createAnimationSampler().setInput(doc.createAccessor().setArray(T).setType('SCALAR').setBuffer(buf))
        .setOutput(doc.createAccessor().setArray(P).setType('VEC3').setBuffer(buf)).setInterpolation(a.interpolation ?? 'LINEAR');
      anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(n).setTargetPath('translation').setSampler(s));
    }
  }
  // Every joint gets a channel for rotation and translation, holding rest where the clip does not move it. glTF says
  // untouched joints sit at rest, but Blender (and engines that blend clips) leave them wherever the last clip put them.
  if (a.holdRest !== false && dur > 0) {
    const keyed = new Set(anim.listChannels().map((c) => `${c.getTargetNode().getName()}|${c.getTargetPath()}`));
    const T2 = doc.createAccessor().setArray(new Float32Array([0, dur])).setType('SCALAR').setBuffer(buf);
    for (const n of new Set(J.values())) for (const [path, v, type] of [['rotation', n.getRotation(), 'VEC4'], ['translation', n.getTranslation(), 'VEC3']]) {
      if (keyed.has(`${n.getName()}|${path}`)) continue;
      const s = doc.createAnimationSampler().setInput(T2).setOutput(doc.createAccessor().setArray(new Float32Array([...v, ...v])).setType(type).setBuffer(buf)).setInterpolation('LINEAR');
      anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(n).setTargetPath(path).setSampler(s));
    }
  }
  return { animation: a.name, duration: r4(dur), channels: anim.listChannels().length, loop };
}

// ---------- qa ----------
// Per frame: lowest point vs the rest pose's lowest point (ground), triangles stretched or squashed past a ratio
// (candy-wrapper twists, weight spikes), and vertices that move far from their bone neighbours (spikes).
export function qa(doc, a = {}) {
  const G = gatherAll(doc), rest = posedPositions(G, evalWorld(doc));
  const anim = findAnim(doc, a.animation ?? null), pm = poseMap(doc, a.pose);
  if (!anim && !pm) throw new Error('qa needs an animation in the file or a pose');
  const n = anim ? Math.min(48, a.frames ?? 24) : 1, d = anim ? animDuration(anim) : 0;
  const nT = G.idx.length / 3, restLen = new Float32Array(nT * 3), idx = G.idx;
  const edge = (P, u, v) => Math.hypot(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
  for (let f = 0; f < nT; f++) { restLen[f * 3] = edge(rest, idx[f * 3], idx[f * 3 + 1]); restLen[f * 3 + 1] = edge(rest, idx[f * 3 + 1], idx[f * 3 + 2]); restLen[f * 3 + 2] = edge(rest, idx[f * 3 + 2], idx[f * 3]); }
  const restMin = bbox(rest).min[1], ratio = a.stretch ?? 2.0, tol = a.sinkTolerance ?? 0.005;
  const { dom } = weightInfo(G, null);
  const frames = [], worstTris = new Map();
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : (d * k) / n;
    const P = posedPositions(G, evalWorld(doc, anim ? sampleAnim(anim, t) : null, pm));
    let bad = 0, worst = 1;
    for (let f = 0; f < nT; f++) for (let e = 0; e < 3; e++) {
      const r0 = restLen[f * 3 + e]; if (r0 < 1e-6) continue;
      const u = idx[f * 3 + e], v = idx[f * 3 + (e + 1) % 3];
      const r = edge(P, u, v) / r0, q = Math.max(r, 1 / Math.max(r, 1e-6));
      if (q > ratio) {
        bad++; const b = dom[u] ?? '(none)', h = worstTris.get(b) ?? worstTris.set(b, { n: 0, s: [0, 0, 0], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], vs: new Set(), worst: 0, at: null }).get(b);
        h.n++; h.vs.add(u); for (let c = 0; c < 3; c++) { const x = rest[u * 3 + c]; h.s[c] += x; if (x < h.lo[c]) h.lo[c] = x; if (x > h.hi[c]) h.hi[c] = x; }
        if (q > h.worst) { h.worst = q; h.at = r4(t); }
      }
      worst = Math.max(worst, q);
    }
    const bb = bbox(P);
    frames.push({ t: r4(t), lowestY: bb.min[1], belowRestGround: r4(Math.max(0, restMin - bb.min[1])), stretchedEdges: bad, worstEdgeRatio: r4(worst) });
  }
  const sinks = frames.filter((f) => f.belowRestGround > tol).length;
  const totalBad = frames.reduce((s, f) => s + f.stretchedEdges, 0);
  return {
    animation: anim?.getName() ?? null, frames: frames.length, restLowestY: restMin, stretchRatio: ratio, sinkTolerance: tol,
    summary: {
      framesSinkingBelowGround: sinks,
      maxSink: Math.max(...frames.map((f) => f.belowRestGround)),
      stretchedEdgesTotal: totalBad,
      worstEdgeRatio: Math.max(...frames.map((f) => f.worstEdgeRatio)),
    },
    // where stretched edges sit, grouped by the dominant bone of their vertex. restBox (padded 1 cm) can be passed
    // straight to paint_weights as region.box; surfacePoint is the flagged vertex nearest the centroid (a sphere
    // centre that is on the skin; the centroid itself can fall inside the body); points = the flagged vertices (up to 12),
    // for small spheres when they are scattered and the box would catch far more than them
    hotspots: [...worstTris].sort((x, y) => y[1].n - x[1].n).slice(0, 8)
      .map(([bone, h]) => {
        const cen = h.s.map((v) => v / h.n); let best = -1, bd = Infinity;
        for (const v of h.vs) { const d = Math.hypot(rest[v * 3] - cen[0], rest[v * 3 + 1] - cen[1], rest[v * 3 + 2] - cen[2]); if (d < bd) { bd = d; best = v; } }
        return { dominantBone: bone, edges: h.n, vertices: h.vs.size, restCentroid: cen.map(r4), surfacePoint: [0, 1, 2].map((c) => r4(rest[best * 3 + c])),
          restBox: { min: h.lo.map((v) => r4(v - 0.01)), max: h.hi.map((v) => r4(v + 0.01)) },
          points: [...h.vs].slice(0, 12).map((v) => [0, 1, 2].map((c) => r4(rest[v * 3 + c]))), worstRatio: r4(h.worst), worstAt: h.at };
      }),
    perFrame: frames,
  };
}

export { readSkeleton };

// ---------- model ----------
// a.model = full model JSON, or baseDoc (a file made by model) + a.patch; returns the new unrigged document
export function model(a, baseDoc = null, limits = {}) {
  let m;
  if (a.model) m = a.model;
  else {
    if (!baseDoc) throw new Error('give model, or from + patch');
    const old = storedModel(baseDoc);
    if (!old) throw new Error('that file was not made by the model tool (no model JSON inside)');
    m = a.patch ? applyPatch(old, a.patch) : old;
    if (a.res !== undefined) m = { ...m, res: a.res ?? undefined };
  }
  if (a.model && a.res !== undefined) m = { ...m, res: a.res };
  const b = build(m, limits);
  return { doc: toDocument(b, a.name ?? 'model'), info: b.info };
}
export function getModel(doc) {
  const m = storedModel(doc);
  if (!m) throw new Error('that file was not made by the model tool');
  return normalizeModel(m);
}
