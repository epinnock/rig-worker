// Bone-heat skin weights (Baran & Popovic 2007, the method behind Blender's "Automatic Weights"), pure JS, no Blender code.
//
// The input mesh can be a broken shell (TRELLIS meshes are hollow double shells with hundreds of pieces), which heat
// diffusion cannot solve. So, like a typical Blender auto-rig clean-up script, we:
//   1. voxelize the mesh, close small gaps, flood-fill the outside -> one solid
//   2. extract a closed surface from the solid (surface nets) and smooth it   = the proxy
//   3. on the proxy solve  (L + A H) w_b = A H p_b  for every bone b             = heat weights
//      L: cotangent Laplacian, A: vertex areas, H: 1/d^2 to the nearest visible bone, p_b: 1 where b is that bone
//   4. copy weights back to the real mesh by nearest point on the proxy (barycentric)
//   5. optional distance-falloff bones (small twitch bones like a nose), then at most 4 influences, normalised
//
// Coordinates are whatever the caller uses (glTF: Y up). Everything is typed arrays; peak memory is a few tens of MB
// for a ~60k-vertex mesh, so it fits a Cloudflare Worker isolate (128 MB).

const now = () => (globalThis.performance ? performance.now() : Date.now());

export function bindHeat(pos, idx, bones, opt = {}) {
  const t0 = now();
  const T = {};
  const mark = (k, s) => { T[k] = Math.round(now() - s); opt.onPhase?.(k); return now(); };
  const h = opt.voxel ?? 0.01;
  const nb = bones.length;

  // ---- 1. voxelize -----------------------------------------------------------------------------------------------
  let s = now();
  const nVin = pos.length / 3;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nVin; i++) for (let a = 0; a < 3; a++) {
    const v = pos[i * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v;
  }
  const PAD = 4;
  const org = lo.map((v) => v - PAD * h);
  const nx = Math.ceil((hi[0] - lo[0]) / h) + 2 * PAD, ny = Math.ceil((hi[1] - lo[1]) / h) + 2 * PAD,
    nz = Math.ceil((hi[2] - lo[2]) / h) + 2 * PAD;
  if (nx * ny * nz > 8e6) throw new Error(`voxel grid ${nx}x${ny}x${nz} too large; raise opt.voxel`);
  const NXY = nx * ny;
  const vid = (i, j, k) => i + j * nx + k * NXY;
  const surf = new Uint8Array(nx * ny * nz);
  const markPt = (x, y, z) => {
    const i = Math.floor((x - org[0]) / h), j = Math.floor((y - org[1]) / h), k = Math.floor((z - org[2]) / h);
    surf[vid(i, j, k)] = 1;
  };
  const nT = idx.length / 3;
  for (let t = 0; t < nT; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const e = Math.max(
      Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]),
      Math.hypot(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]),
      Math.hypot(pos[c] - pos[b], pos[c + 1] - pos[b + 1], pos[c + 2] - pos[b + 2]));
    const n = Math.max(1, Math.ceil(e / (0.5 * h)));
    for (let u = 0; u <= n; u++) for (let v = 0; v <= n - u; v++) {
      const fu = u / n, fv = v / n, fw = 1 - fu - fv;
      markPt(fw * pos[a] + fu * pos[b] + fv * pos[c], fw * pos[a + 1] + fu * pos[b + 1] + fv * pos[c + 1],
        fw * pos[a + 2] + fu * pos[b + 2] + fv * pos[c + 2]);
    }
  }
  // close gaps up to ~2 voxels: dilate the surface (26-neighbourhood) before the flood fill
  const close = opt.close ?? 0; // 0 = like Blender's voxel remesh; 1+ bridges nearby parts (arms to head), so off by default
  let wall = surf;
  for (let r = 0; r < close; r++) {
    const d = wall.slice();
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      if (!wall[vid(i, j, k)]) continue;
      for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) d[vid(i + di, j + dj, k + dk)] = 1;
    }
    wall = d;
  }
  // flood fill the outside (6-connected) through non-wall voxels
  const outside = new Uint8Array(nx * ny * nz);
  const queue = new Int32Array(nx * ny * nz);
  let qh = 0, qt = 0;
  outside[0] = 1; queue[qt++] = 0;
  while (qh < qt) {
    const v = queue[qh++];
    const i = v % nx, j = ((v / nx) | 0) % ny, k = (v / NXY) | 0;
    const nbrs = [i > 0 ? v - 1 : -1, i < nx - 1 ? v + 1 : -1, j > 0 ? v - nx : -1, j < ny - 1 ? v + nx : -1,
      k > 0 ? v - NXY : -1, k < nz - 1 ? v + NXY : -1];
    for (const w of nbrs) if (w >= 0 && !outside[w] && !wall[w]) { outside[w] = 1; queue[qt++] = w; }
  }
  // solid = not outside; undo the dilation by eroding the outer layer, but keep voxels the real surface touches
  const solid = new Uint8Array(nx * ny * nz);
  for (let v = 0; v < solid.length; v++) solid[v] = outside[v] ? 0 : 1;
  for (let r = 0; r < close; r++) {
    const e = solid.slice();
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const v = vid(i, j, k);
      if (!solid[v] || surf[v]) continue;
      if (!solid[v - 1] || !solid[v + 1] || !solid[v - nx] || !solid[v + nx] || !solid[v - NXY] || !solid[v + NXY]) e[v] = 0;
    }
    solid.set(e);
  }
  let nSolid = 0; for (let v = 0; v < solid.length; v++) nSolid += solid[v];
  s = mark("voxelize", s);

  // ---- 2. surface nets proxy -------------------------------------------------------------------------------------
  const cx = nx - 1, cy = ny - 1, CXY = cx * cy;
  const cellV = new Int32Array(cx * cy * (nz - 1)).fill(-1);
  const pv = []; // proxy vertex positions (grown, then typed)
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let m = 0;
    for (let c = 0; c < 8; c++) m |= solid[vid(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))] << c;
    if (m === 0 || m === 255) continue;
    // average of the midpoints of the cube edges that cross the surface
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let c = 0; c < 8; c++) for (const bit of [1, 2, 4]) {
      if (c & bit) continue;
      const d = c | bit;
      if (((m >> c) & 1) === ((m >> d) & 1)) continue;
      sx += ((c & 1) + (d & 1)) * 0.5; sy += (((c >> 1) & 1) + ((d >> 1) & 1)) * 0.5; sz += (((c >> 2) & 1) + ((d >> 2) & 1)) * 0.5; n++;
    }
    cellV[i + j * cx + k * CXY] = pv.length / 3;
    pv.push(org[0] + (i + 0.5 + sx / n) * h, org[1] + (j + 0.5 + sy / n) * h, org[2] + (k + 0.5 + sz / n) * h);
  }
  const pt = [];
  const cell = (i, j, k) => cellV[i + j * cx + k * CXY];
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v = vid(i, j, k), sv = solid[v];
    // edges along +x, +y, +z from voxel (i,j,k); the 4 cells around each edge make a quad
    if (i < nx - 1 && sv !== solid[v + 1]) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), sv);
    if (j < ny - 1 && sv !== solid[v + nx]) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), sv);
    if (k < nz - 1 && sv !== solid[v + NXY]) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), sv);
  }
  function quad(a, b, c, d, lowerSolid) {
    if (lowerSolid) pt.push(a, b, c, a, c, d); else pt.push(a, c, b, a, d, c);
  }
  const nV = pv.length / 3;
  const P = new Float64Array(pv);
  const F = new Int32Array(pt);
  const nF = F.length / 3;
  pv.length = 0; pt.length = 0;
  // vertex adjacency (CSR) from triangle edges
  const adj = buildAdjacency(nV, F);
  // Taubin smoothing (no shrink): removes the voxel staircase
  const tmp = new Float64Array(nV * 3);
  for (let it = 0; it < (opt.smooth ?? 4); it++) for (const lam of [0.5, -0.53]) {
    for (let i = 0; i < nV; i++) {
      let ax = 0, ay = 0, az = 0; const r0 = adj.ptr[i], r1 = adj.ptr[i + 1];
      for (let q = r0; q < r1; q++) { const j = adj.idx[q]; ax += P[j * 3]; ay += P[j * 3 + 1]; az += P[j * 3 + 2]; }
      const n = r1 - r0 || 1;
      tmp[i * 3] = P[i * 3] + lam * (ax / n - P[i * 3]);
      tmp[i * 3 + 1] = P[i * 3 + 1] + lam * (ay / n - P[i * 3 + 1]);
      tmp[i * 3 + 2] = P[i * 3 + 2] + lam * (az / n - P[i * 3 + 2]);
    }
    P.set(tmp);
  }
  s = mark("proxy", s);

  // ---- 3a. cotangent Laplacian + vertex areas --------------------------------------------------------------------
  const W = new Float64Array(adj.idx.length); // weight per CSR entry (i -> adj.idx[q])
  const area = new Float64Array(nV);
  const slot = (i, j) => { for (let q = adj.ptr[i]; q < adj.ptr[i + 1]; q++) if (adj.idx[q] === j) return q; return -1; };
  for (let f = 0; f < nF; f++) {
    const v = [F[f * 3], F[f * 3 + 1], F[f * 3 + 2]];
    const ar = triArea(P, v[0], v[1], v[2]);
    for (let c = 0; c < 3; c++) area[v[c]] += ar / 3;
    for (let c = 0; c < 3; c++) {
      const o = v[c], a = v[(c + 1) % 3], b = v[(c + 2) % 3];
      const ct = cotAt(P, o, a, b) * 0.5;
      W[slot(a, b)] += ct; W[slot(b, a)] += ct;
    }
  }
  // Blender divides each edge's cotangent by the number of faces sharing it (2 on a closed surface) and scales rows by
  // 0.5 / area, i.e. half the textbook (cot a + cot b) / 2A. measured: 0.2 matches Blender's output best on a test creature mesh (L1 0.046), so the constants differ again by ~2 from my reading.
  const ls = opt.lapScale ?? 0.2;
  for (let q = 0; q < W.length; q++) W[q] = W[q] < 0 ? 0 : W[q] * ls; // clamp obtuse-angle negatives: keeps the system SPD
  const diagL = new Float64Array(nV);
  for (let i = 0; i < nV; i++) for (let q = adj.ptr[i]; q < adj.ptr[i + 1]; q++) diagL[i] += W[q];

  // ---- 3b. heat sources, Blender's rules (meshlaplacian.cc heat_set_H / heat_source_closest) ----------------------
  //   distance to a bone grows when the vertex normal faces away from it: d / (0.5 (cos + 1.001))
  //   mindist is over ALL bones; only bones within (1 + 1e-4) of it AND visible (unblocked segment) are sources
  //   p = 1 / nclosest, H = nclosest / max(mindist, 1e-4)^2
  const bvh = buildBVH(P, F);
  const N = vertexNormals(P, F, nV);
  const seg = bones.map((b) => ({ a: b.head, b: b.tail }));
  const Hd = new Float64Array(nV);              // A * H on the diagonal
  const src = new Int16Array(nV * 4).fill(-1);  // source bones per vertex
  const pv1 = new Float64Array(nV);             // p value for each source of the vertex
  const dist = new Float64Array(nb), cp = new Float64Array(3);
  const blenderRules = opt.rules !== 'nearestVisible';
  let nVisible = 0, nRays = 0;
  for (let i = 0; i < nV; i++) {
    const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    let md = Infinity;
    for (let b = 0; b < nb; b++) {
      const e = segDist(p, seg[b].a, seg[b].b, cp);
      let d = e;
      if (blenderRules && e > 0) {
        const cos = ((p[0] - cp[0]) * N[i * 3] + (p[1] - cp[1]) * N[i * 3 + 1] + (p[2] - cp[2]) * N[i * 3 + 2]) / e;
        d = e / (0.5 * (cos + 1.001));
      }
      dist[b] = d; if (d < md) md = d;
    }
    let ns = 0;
    for (let b = 0; b < nb && ns < 4; b++) {
      if (dist[b] > md * (1 + 1e-4)) continue;
      segDist(p, seg[b].a, seg[b].b, cp); nRays++;
      if (segmentBlocked(bvh, P, F, p, cp, i)) continue;
      src[i * 4 + ns++] = b;
    }
    if (!ns && !blenderRules) { // fallback mode: nearest visible bone, any distance
      const order = Array.from(dist.keys()).sort((x, y) => dist[x] - dist[y]);
      for (const b of order) { segDist(p, seg[b].a, seg[b].b, cp); nRays++; if (!segmentBlocked(bvh, P, F, p, cp, i)) { src[i * 4] = b; ns = 1; md = dist[b]; break; } }
    }
    if (!ns) continue;
    nVisible++;
    const m = Math.max(md, 1e-4);
    Hd[i] = area[i] * ns / (m * m);
    pv1[i] = 1 / ns;
  }
  s = mark("visibility", s);

  // ---- 3c. solve (L + diag(Hd)) X = B for all bones at once (Jacobi-preconditioned CG, one column per bone) ----
  const K = nb;
  const B = new Float64Array(nV * K);
  for (let i = 0; i < nV; i++) for (let c = 0; c < 4; c++) { const b = src[i * 4 + c]; if (b >= 0) B[i * K + b] = Hd[i] * pv1[i]; }
  const diag = new Float64Array(nV);
  for (let i = 0; i < nV; i++) diag[i] = diagL[i] + Hd[i] || 1;
  const X = new Float64Array(nV * K), R = B.slice(), Z = new Float64Array(nV * K), Pd = new Float64Array(nV * K),
    AP = new Float64Array(nV * K);
  for (let i = 0; i < nV; i++) for (let b = 0; b < K; b++) Z[i * K + b] = R[i * K + b] / diag[i];
  Pd.set(Z);
  const rz = new Float64Array(K), bn = new Float64Array(K), done = new Uint8Array(K);
  for (let i = 0; i < nV * K; i++) { rz[i % K] += R[i] * Z[i]; bn[i % K] += B[i] * B[i]; }
  for (let b = 0; b < K; b++) { bn[b] = Math.sqrt(bn[b]); if (bn[b] === 0) done[b] = 1; }
  const tol = opt.tol ?? 1e-6, maxIt = opt.maxIter ?? 4000;
  let it = 0;
  const pAp = new Float64Array(K), rr = new Float64Array(K), rzN = new Float64Array(K);
  for (; it < maxIt && done.some((d) => !d); it++) {
    // AP = (L + Hd) P, with L = diagL - W
    for (let i = 0; i < nV; i++) {
      const o = i * K, dd = diagL[i] + Hd[i];
      for (let b = 0; b < K; b++) AP[o + b] = dd * Pd[o + b];
      for (let q = adj.ptr[i]; q < adj.ptr[i + 1]; q++) {
        const w = W[q], oj = adj.idx[q] * K;
        for (let b = 0; b < K; b++) AP[o + b] -= w * Pd[oj + b];
      }
    }
    pAp.fill(0);
    for (let i = 0; i < nV; i++) { const o = i * K; for (let b = 0; b < K; b++) pAp[b] += Pd[o + b] * AP[o + b]; }
    rr.fill(0); rzN.fill(0);
    for (let i = 0; i < nV; i++) {
      const o = i * K, inv = 1 / diag[i];
      for (let b = 0; b < K; b++) {
        if (done[b]) continue;
        const al = rz[b] / pAp[b];
        X[o + b] += al * Pd[o + b];
        R[o + b] -= al * AP[o + b];
        Z[o + b] = R[o + b] * inv;
        rr[b] += R[o + b] * R[o + b]; rzN[b] += R[o + b] * Z[o + b];
      }
    }
    for (let b = 0; b < K; b++) {
      if (done[b]) continue;
      if (Math.sqrt(rr[b]) <= tol * bn[b]) { done[b] = 1; continue; }
      const be = rzN[b] / rz[b]; rz[b] = rzN[b];
      for (let i = 0; i < nV; i++) Pd[i * K + b] = Z[i * K + b] + be * Pd[i * K + b];
    }
  }
  const unconverged = bones.filter((_, b) => !done[b]).map((b) => b.name);
  // Blender-style cut-off: drop weights under 0.025, fade 0.025..0.05
  const PW = new Float32Array(nV * K);
  for (let q = 0; q < nV * K; q++) {
    const w = X[q];
    PW[q] = w > 0.05 ? w : w > 0.025 ? w * (w - 0.025) / 0.025 : 0;
  }
  s = mark("solve", s);

  // ---- 4. transfer to the real mesh: nearest point on the proxy, barycentric --------------------------------------
  const out = new Float32Array(nVin * K);
  const near = { tri: -1, u: 0, v: 0, w: 0, d2: 0 };
  let maxGap = 0;
  for (let i = 0; i < nVin; i++) {
    closestPoint(bvh, P, F, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], near);
    maxGap = Math.max(maxGap, Math.sqrt(near.d2));
    const a = F[near.tri * 3] * K, b = F[near.tri * 3 + 1] * K, c = F[near.tri * 3 + 2] * K, o = i * K;
    for (let k = 0; k < K; k++) out[o + k] = near.u * PW[a + k] + near.v * PW[b + k] + near.w * PW[c + k];
  }

  // ---- 5. falloff bones, fill empty vertices, top 4 ---------------------------------------------------------------
  const fall = bones.map((b, k) => (b.falloff ? k : -1)).filter((k) => k >= 0);
  for (const k of fall) for (let i = 0; i < nVin; i++) out[i * K + k] = 0;
  const sum = (i) => { let t = 0; for (let k = 0; k < K; k++) t += out[i * K + k]; return t; };
  const empty = [];
  for (let i = 0; i < nVin; i++) if (sum(i) < 1e-3) empty.push(i);
  if (empty.length) fillFromNearest(pos, out, K, empty, h * 2);
  for (let i = 0; i < nVin; i++) { const t = sum(i); if (t > 0) for (let k = 0; k < K; k++) out[i * K + k] /= t; }
  for (const k of fall) {
    const f = bones[k].falloff, c = f.at === "head" ? bones[k].head : bones[k].tail;
    for (let i = 0; i < nVin; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (f.above && [x, y, z]["xyz".indexOf(f.above.axis)] < f.above.value) continue;
      const d = Math.hypot(x - c[0], y - c[1], z - c[2]);
      const wn = Math.pow(Math.max(0, 1 - d / f.radius), f.power ?? 1);
      if (wn <= 0) continue;
      for (let q = 0; q < K; q++) out[i * K + q] *= 1 - wn;
      out[i * K + k] = wn;
    }
  }
  const joints = new Uint8Array(nVin * 4), weights = new Float32Array(nVin * 4);
  const tmpw = new Float32Array(K);
  for (let i = 0; i < nVin; i++) {
    tmpw.set(out.subarray(i * K, i * K + K));
    let t = 0;
    for (let s4 = 0; s4 < 4; s4++) {
      let m = 0; for (let k = 1; k < K; k++) if (tmpw[k] > tmpw[m]) m = k;
      joints[i * 4 + s4] = m; weights[i * 4 + s4] = tmpw[m] > 0 ? tmpw[m] : 0; t += weights[i * 4 + s4]; tmpw[m] = -1;
    }
    for (let s4 = 0; s4 < 4; s4++) weights[i * 4 + s4] = t > 0 ? weights[i * 4 + s4] / t : (s4 === 0 ? 1 : 0);
  }
  mark("transfer", s);
  T.total = Math.round(now() - t0);
  return {
    joints, weights, dense: opt.keepDense ? out : undefined,
    stats: {
      grid: [nx, ny, nz], voxel: h, solidVoxels: nSolid, proxyVerts: nV, proxyTris: nF,
      proxyVisible: +(nVisible / nV * 100).toFixed(2), rays: nRays, cgIterations: it, unconverged,
      emptyFilled: empty.length, maxProxyGap: +maxGap.toFixed(4), ms: T,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
function buildAdjacency(nV, F) {
  const deg = new Int32Array(nV);
  const nF = F.length / 3;
  const keys = new Set();
  for (let f = 0; f < nF; f++) for (let c = 0; c < 3; c++) {
    const a = F[f * 3 + c], b = F[f * 3 + (c + 1) % 3];
    const k = a < b ? a * nV + b : b * nV + a;
    if (!keys.has(k)) { keys.add(k); deg[a]++; deg[b]++; }
  }
  const ptr = new Int32Array(nV + 1);
  for (let i = 0; i < nV; i++) ptr[i + 1] = ptr[i] + deg[i];
  const idx = new Int32Array(ptr[nV]), fill = ptr.slice(0, nV);
  for (const k of keys) { const a = Math.floor(k / nV), b = k - a * nV; idx[fill[a]++] = b; idx[fill[b]++] = a; }
  return { ptr, idx };
}

function vertexNormals(P, F, nV) { // area-weighted, outward (surface nets winds faces solid -> empty)
  const N = new Float64Array(nV * 3);
  for (let f = 0; f < F.length / 3; f++) {
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { N[v * 3] += nx; N[v * 3 + 1] += ny; N[v * 3 + 2] += nz; }
  }
  for (let v = 0; v < nV; v++) { const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1; N[v * 3] /= l; N[v * 3 + 1] /= l; N[v * 3 + 2] /= l; }
  return N;
}

function triArea(P, a, b, c) {
  const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

function cotAt(P, o, a, b) { // cotangent of the angle at o in triangle (o, a, b)
  const ux = P[a * 3] - P[o * 3], uy = P[a * 3 + 1] - P[o * 3 + 1], uz = P[a * 3 + 2] - P[o * 3 + 2];
  const vx = P[b * 3] - P[o * 3], vy = P[b * 3 + 1] - P[o * 3 + 1], vz = P[b * 3 + 2] - P[o * 3 + 2];
  const dot = ux * vx + uy * vy + uz * vz;
  const cr = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  return cr > 1e-12 ? Math.min(dot / cr, 1e3) : 0;
}

function segDist(p, a, b, outPt) { // distance from p to segment ab; closest point into outPt
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L = dx * dx + dy * dy + dz * dz;
  let t = L > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = a[0] + t * dx, y = a[1] + t * dy, z = a[2] + t * dz;
  if (outPt) { outPt[0] = x; outPt[1] = y; outPt[2] = z; }
  return Math.hypot(p[0] - x, p[1] - y, p[2] - z);
}

// ---- BVH over triangles: flat arrays, median split, leaves of <= 4 --------------------------------------------------
function buildBVH(P, F) {
  const nF = F.length / 3;
  const cen = new Float64Array(nF * 3), tb = new Float64Array(nF * 6);
  for (let f = 0; f < nF; f++) for (let a = 0; a < 3; a++) {
    const x0 = P[F[f * 3] * 3 + a], x1 = P[F[f * 3 + 1] * 3 + a], x2 = P[F[f * 3 + 2] * 3 + a];
    tb[f * 6 + a] = Math.min(x0, x1, x2); tb[f * 6 + 3 + a] = Math.max(x0, x1, x2); cen[f * 3 + a] = (x0 + x1 + x2) / 3;
  }
  const items = new Int32Array(nF); for (let f = 0; f < nF; f++) items[f] = f;
  const maxN = 2 * Math.ceil(nF / 2) + 1;
  const box = new Float64Array(maxN * 6), left = new Int32Array(maxN), start = new Int32Array(maxN), count = new Int32Array(maxN);
  let n = 0;
  const stack = [[0, nF, n++]];
  while (stack.length) {
    const [s0, s1, node] = stack.pop();
    const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let q = s0; q < s1; q++) { const f = items[q]; for (let a = 0; a < 3; a++) { bb[a] = Math.min(bb[a], tb[f * 6 + a]); bb[3 + a] = Math.max(bb[3 + a], tb[f * 6 + 3 + a]); } }
    box.set(bb, node * 6);
    if (s1 - s0 <= 4) { left[node] = -1; start[node] = s0; count[node] = s1 - s0; continue; }
    const ax = [0, 1, 2].reduce((m, a) => (bb[3 + a] - bb[a] > bb[3 + m] - bb[m] ? a : m), 0);
    const sub = Array.from(items.subarray(s0, s1)).sort((x, y) => cen[x * 3 + ax] - cen[y * 3 + ax]);
    items.set(sub, s0);
    const mid = (s0 + s1) >> 1;
    const l = n++, r = n++;
    left[node] = l; count[node] = 0;
    stack.push([s0, mid, l], [mid, s1, r]);
  }
  return { box, left, start, count, items };
}

function segmentBlocked(bvh, P, F, p, q, skipVert) {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const inv = [1 / dx, 1 / dy, 1 / dz];
  const st = [0];
  while (st.length) {
    const nd = st.pop();
    // slab test against t in [0, 1]
    let t0 = 0, t1 = 1;
    for (let a = 0; a < 3; a++) {
      const o = a === 0 ? p[0] : a === 1 ? p[1] : p[2];
      let ta = (bvh.box[nd * 6 + a] - o) * inv[a], tb = (bvh.box[nd * 6 + 3 + a] - o) * inv[a];
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      if (t0 > t1) break;
    }
    if (t0 > t1) continue;
    if (bvh.left[nd] >= 0) { st.push(bvh.left[nd], bvh.left[nd] + 1); continue; }
    for (let k = bvh.start[nd]; k < bvh.start[nd] + bvh.count[nd]; k++) {
      const f = bvh.items[k];
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      if (a === skipVert || b === skipVert || c === skipVert) continue;
      const t = rayTri(p, dx, dy, dz, P, a, b, c);
      if (t > 1e-6 && t < 1 - 1e-6) return true;
    }
  }
  return false;
}

function rayTri(p, dx, dy, dz, P, a, b, c) { // Moller-Trumbore, returns t or -1
  const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
  const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-14) return -1;
  const f = 1 / det;
  const sx = p[0] - P[a * 3], sy = p[1] - P[a * 3 + 1], sz = p[2] - P[a * 3 + 2];
  const u = f * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return -1;
  return f * (e2x * qx + e2y * qy + e2z * qz);
}

function closestPoint(bvh, P, F, x, y, z, res) {
  res.d2 = Infinity;
  const st = [0];
  while (st.length) {
    const nd = st.pop();
    const bx = bvh.box;
    const ddx = Math.max(bx[nd * 6] - x, 0, x - bx[nd * 6 + 3]), ddy = Math.max(bx[nd * 6 + 1] - y, 0, y - bx[nd * 6 + 4]),
      ddz = Math.max(bx[nd * 6 + 2] - z, 0, z - bx[nd * 6 + 5]);
    if (ddx * ddx + ddy * ddy + ddz * ddz >= res.d2) continue;
    if (bvh.left[nd] >= 0) { st.push(bvh.left[nd], bvh.left[nd] + 1); continue; }
    for (let k = bvh.start[nd]; k < bvh.start[nd] + bvh.count[nd]; k++) {
      const f = bvh.items[k];
      closestOnTri(P, F[f * 3], F[f * 3 + 1], F[f * 3 + 2], x, y, z, f, res);
    }
  }
}

function closestOnTri(P, ia, ib, ic, px, py, pz, f, res) { // Ericson, Real-Time Collision Detection 5.1.5
  const ax = P[ia * 3], ay = P[ia * 3 + 1], az = P[ia * 3 + 2];
  const abx = P[ib * 3] - ax, aby = P[ib * 3 + 1] - ay, abz = P[ib * 3 + 2] - az;
  const acx = P[ic * 3] - ax, acy = P[ic * 3 + 1] - ay, acz = P[ic * 3 + 2] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v, w; // barycentric for a, b, c
  const bpx = px - P[ib * 3], bpy = py - P[ib * 3 + 1], bpz = pz - P[ib * 3 + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = px - P[ic * 3], cpy = py - P[ic * 3 + 1], cpz = pz - P[ic * 3 + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
  if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; }
  else if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; }
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); u = 1 - t; v = t; w = 0; }
  else if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; }
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); u = 1 - t; v = 0; w = t; }
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 0; v = 1 - t; w = t; }
  else { const dn = 1 / (va + vb + vc); v = vb * dn; w = vc * dn; u = 1 - v - w; }
  const qx = ax + abx * v + acx * w, qy = ay + aby * v + acy * w, qz = az + abz * v + acz * w;
  const d = (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  if (d < res.d2) { res.d2 = d; res.tri = f; res.u = u; res.v = v; res.w = w; }
}

// copy weights to empty vertices from the nearest vertex that has some (uniform hash grid, growing search)
function fillFromNearest(pos, out, K, empty, cellSize) {
  const nV = pos.length / 3, isEmpty = new Uint8Array(nV);
  for (const i of empty) isEmpty[i] = 1;
  const key = (i, j, k) => `${i},${j},${k}`;
  const grid = new Map();
  for (let i = 0; i < nV; i++) {
    if (isEmpty[i]) continue;
    const k = key(Math.floor(pos[i * 3] / cellSize), Math.floor(pos[i * 3 + 1] / cellSize), Math.floor(pos[i * 3 + 2] / cellSize));
    let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i);
  }
  for (const i of empty) {
    const ci = Math.floor(pos[i * 3] / cellSize), cj = Math.floor(pos[i * 3 + 1] / cellSize), ck = Math.floor(pos[i * 3 + 2] / cellSize);
    let best = -1, bd = Infinity;
    for (let r = 0; r < 64 && best < 0; r++) {
      for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) for (let dk = -r; dk <= r; dk++) {
        if (Math.max(Math.abs(di), Math.abs(dj), Math.abs(dk)) !== r) continue;
        const a = grid.get(key(ci + di, cj + dj, ck + dk)); if (!a) continue;
        for (const j of a) {
          const d = (pos[i * 3] - pos[j * 3]) ** 2 + (pos[i * 3 + 1] - pos[j * 3 + 1]) ** 2 + (pos[i * 3 + 2] - pos[j * 3 + 2]) ** 2;
          if (d < bd) { bd = d; best = j; }
        }
      }
    }
    if (best >= 0) for (let k = 0; k < K; k++) out[i * K + k] = out[best * K + k];
  }
}
