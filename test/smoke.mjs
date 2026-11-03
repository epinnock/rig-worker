// npm test: model -> bind -> paint -> animate -> qa on the Pip example, in Node (no Worker, no network).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { build } from '../src/sdf.js';
import * as T from '../src/tools.js';
import { readGLB, writeGLB } from '../src/glb.js';

const ex = (f) => JSON.parse(readFileSync(new URL(`../examples/pip/${f}`, import.meta.url), 'utf8'));
const step = async (name, fn) => { const t = Date.now(); const r = await fn(); console.log(`ok  ${name} (${Date.now() - t} ms)`); return r; };

// closed and outward-facing: every edge used by two triangles, winding agrees with the field gradient
function topology(b) {
  let agree = 0; const E = new Map();
  for (let f = 0; f < b.idx.length; f += 3) {
    const [a, c, d] = [b.idx[f], b.idx[f + 1], b.idx[f + 2]], P = (v, k) => b.pos[v * 3 + k];
    const u = [0, 1, 2].map((k) => P(c, k) - P(a, k)), w = [0, 1, 2].map((k) => P(d, k) - P(a, k));
    const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const n = [0, 1, 2].map((k) => b.nrm[a * 3 + k] + b.nrm[c * 3 + k] + b.nrm[d * 3 + k]);
    if (cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] > 0) agree++;
    for (const [p, q] of [[a, c], [c, d], [d, a]]) { const k = p < q ? p * 1e7 + q : q * 1e7 + p; E.set(k, (E.get(k) ?? 0) + 1); }
  }
  let open = 0; for (const v of E.values()) if (v !== 2) open++;
  return { outward: agree / (b.idx.length / 3), open };
}

await step('sphere is closed and outward', () => {
  const s = build({ shapes: [{ type: 'sphere', radius: 0.5 }] }), t = topology(s);
  assert.equal(t.open, 0); assert.equal(t.outward, 1);
  const r = Math.hypot(s.pos[0], s.pos[1], s.pos[2]); assert.ok(Math.abs(r - 0.5) < 0.002, `radius ${r}`);
});
const pip = ex('model.json');
await step('pip builds as one closed piece', () => {
  const b = build({ ...pip, res: 0.01 }), t = topology(b);
  assert.equal(b.info.pieces, 1); assert.ok(t.outward > 0.999, `outward ${t.outward}`); assert.ok(t.open <= 8, `open edges ${t.open}`);
  assert.deepEqual(b.info.warnings ?? [], []);
});
await step('patch: recolour, add, remove', () => {
  const m = T.model({ model: { ...pip, res: 0.012 } });
  const doc2 = T.model({ from: 'x', patch: [{ name: 'beanie', color: '#cc3344' }, { name: 'scarf', type: 'torus', at: [0, 0.66, 0], radius: 0.12, thickness: 0.03, before: 'head' }, { name: 'pocket', remove: true }] }, m.doc);
  const names = T.getModel(doc2.doc).shapes.map((s) => s.name);
  assert.ok(names.includes('scarf') && !names.includes('pocket')); assert.ok(names.indexOf('scarf') < names.indexOf('head'));
});
const doc = await step('model at res 0.01 + round trip', async () => readGLB(await writeGLB(T.model({ model: { ...pip, res: 0.01 } }).doc)));
const bind = await step('bind', () => T.bind(doc, { skeleton: ex('skeleton.json') }));
assert.equal(bind.createdSkin, true); assert.deepEqual(bind.bonesOwningNoVertex, []);
await step('paint_weights', () => { for (const p of ex('paint.json')) assert.ok(T.paintWeights(doc, p).verticesChanged > 0); });
await step('animate', () => assert.equal(T.animate(doc, ex('walk.json')).channels, 28)); // 14 bones x (rotation + translation): walk keys 14 rotations + the hips move, the rest hold rest
const qa = await step('qa', () => T.qa(doc, { animation: 'walk', frames: 16 }));
assert.equal(qa.summary.framesSinkingBelowGround, 0, JSON.stringify(qa.summary));
const pv = await step('preview', () => T.preview(doc, { frames: 4, views: [90], res: 128 }));
assert.equal(Buffer.from(pv.png.subarray(1, 4)).toString(), 'PNG');
console.log('all good');
