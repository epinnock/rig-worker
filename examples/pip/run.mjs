// Model, rig and walk the Pip demo character through the MCP tools, saving every picture.
//   node examples/pip/run.mjs [url] [outdir]
//   url defaults to the public demo; for your own Worker set RIG_TOKEN in the environment.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const URL_ = (process.argv[2] ?? 'https://rig-worker-demo.epinnock.workers.dev').replace(/\/$/, '');
const OUT = process.argv[3] ?? 'out/pip';
const dir = new URL('.', import.meta.url).pathname, json = (f) => JSON.parse(readFileSync(dir + f, 'utf8'));
mkdirSync(OUT, { recursive: true });

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
if (process.env.RIG_TOKEN) headers.authorization = `Bearer ${process.env.RIG_TOKEN}`;
let id = 0;
async function tool(name, args, picture) {
  const t = Date.now();
  const r = await fetch(`${URL_}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await r.json();
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  const res = body.result, txt = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const img = res.content.find((c) => c.type === 'image');
  if (img && picture) writeFileSync(`${OUT}/${picture}`, Buffer.from(img.data, 'base64'));
  console.log(`${name.padEnd(13)} ${String(Date.now() - t).padStart(6)} ms  ${res.isError ? 'ERROR ' : ''}${txt.slice(0, 160).replace(/\s+/g, ' ')}`);
  if (res.isError) process.exit(1);
  return txt;
}

// 1. model: 19 shapes (7 mirrored) -> one closed, vertex-coloured mesh (and a preview in the same call)
await tool('model', { out: 'pip.glb', model: json('model.json'), preview: { views: [0, 35, 90, 180] } }, 'model.png');
// 2. check the skeleton against the mesh before binding
const skeleton = json('skeleton.json');
await tool('preview', { file: 'pip.glb', skeleton, views: [0, 90] }, 'skeleton.png');
// 3. bind: bone-heat automatic weights
await tool('bind', { file: 'pip.glb', out: 'pip_rig.glb', skeleton });
await tool('preview', { file: 'pip_rig.glb', mode: 'weights', views: [0, 35, 180] }, 'weights.png');
// 4. a small weight fix (keep the backpack pocket on the spine)
for (const p of json('paint.json')) await tool('paint_weights', { file: 'pip_rig.glb', ...p });
// 5. a looping walk, then check it
await tool('animate', { file: 'pip_rig.glb', ...json('walk.json') });
await tool('qa', { file: 'pip_rig.glb', animation: 'walk', frames: 24 });
await tool('preview', { file: 'pip_rig.glb', frames: 8, views: [90] }, 'walk_side.png');
// 6. a download link for the rigged, animated GLB
const ex = JSON.parse(await tool('export', { file: 'pip_rig.glb' }));
writeFileSync(`${OUT}/pip_rig.glb`, Buffer.from(await (await fetch(ex.url)).arrayBuffer()));
console.log(`saved ${OUT}/pip_rig.glb and the pictures`);
