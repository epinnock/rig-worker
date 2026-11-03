// MCP (Streamable HTTP, stateless JSON responses) over the modelling and rigging tools.
// Files live in R2 under files/<ns><name>; ns is '' on a private deployment and '<16 hex>/' per client on the demo.
import { readGLB, writeGLB } from './glb.js';
import * as T from './tools.js';

const PROTOCOL = '2025-06-18';
const NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;
const MAX_IMPORT = 64 * 1024 * 1024;

// the public demo (env.DEMO = "1"): no token, so every call is capped to keep it cheap
export const DEMO_LIMITS = {
  maxPoints: 4e6, maxShapes: 100, // model
  maxVertices: 150000, // any tool that loads a mesh
  minVoxel: 0.008, // bind
  maxFiles: 25, // per client
  maxExpiresMinutes: 1440, // export
};

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const file = { type: 'string', description: 'file name in storage (see list_files)' };
const out = { type: 'string', description: 'name to save the result as (default: overwrite file)' };
const skeletonSchema = {
  type: 'object', required: ['bones'],
  description: 'glTF space (+Y up, +Z front, +X the character\'s left), metres, same as inspect bounds',
  properties: {
    bones: {
      type: 'array', items: {
        type: 'object', required: ['name', 'head', 'tail'],
        properties: {
          name: { type: 'string' }, head: vec3, tail: vec3, parent: { type: ['string', 'null'] },
          falloff: { type: 'object', description: 'optional: distance falloff instead of heat, for tiny bones (nose, ear tip). {radius, power, at: "tail"|"head", above?: {axis:"x"|"y"|"z", value}}' },
        },
      },
    },
  },
};
const ROT_DOC = 'Euler degrees [x, y, z], applied X first, then Y, then Z, about world axes through the joint for bones made by bind (+X character\'s left, +Y up, +Z front), or about the joint\'s own rest axes for rigs made in other tools; right-hand rule. Examples: +X swings a leg back (-X forward); +Y turns toward the character\'s left; +Z raises the left arm (lowers the right one).';
const poseSchema = { type: 'object', description: `{boneName: [x, y, z]} on top of rest/animation. ${ROT_DOC}`, additionalProperties: vec3 };

export const TOOLS = [
  { name: 'list_files', description: 'List stored GLB files with sizes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'import_url', description: 'Download a GLB from a URL into storage.', inputSchema: { type: 'object', required: ['url', 'name'], properties: { url: { type: 'string' }, name: { type: 'string' } } } },
  { name: 'delete_file', description: 'Delete a stored file.', inputSchema: { type: 'object', required: ['file'], properties: { file } } },
  {
    name: 'inspect', description: 'Mesh facts for placing bones: bounds, vertex/triangle counts, horizontal slices with separate blobs (legs, arms, tail show up as clusters in x/z), the current skin skeleton and animations.',
    inputSchema: { type: 'object', required: ['file'], properties: { file, slices: { type: 'integer', minimum: 4, maximum: 48 } } },
  },
  {
    name: 'preview', description: 'Render PNG views (shaded in the mesh colours, or weight colours) with a skeleton overlay. Use it to check a proposed skeleton before bind (pass skeleton), to check weights after bind (mode weights / bone), to see a pose, or animation frames.',
    inputSchema: {
      type: 'object', required: ['file'], properties: {
        file,
        mode: { enum: ['shaded', 'weights', 'bone'], description: 'weights: each vertex coloured by its dominant bone (legend in the text); bone: one bone\'s weight blue 0 -> red 1' },
        bone: { type: 'string' },
        views: { type: 'array', items: { type: 'number' }, description: 'azimuths in degrees, 0 = front (looking at -Z), 90 = the character\'s left side. Default [0,90,180,270]' },
        elev: { type: 'number', description: 'camera elevation degrees, default 10' },
        skeleton: { description: 'true = overlay the file\'s skin; false = none; or a skeleton object (same shape as bind) to overlay a proposal', oneOf: [{ type: 'boolean' }, skeletonSchema] },
        pose: poseSchema,
        animation: { type: 'string', description: 'animation name (default the first) for frames/time' },
        frames: { type: 'integer', minimum: 1, maximum: 16, description: 'n evenly spaced animation frames at views[0]' },
        time: { type: 'number', description: 'one animation time in seconds, for all views' },
        res: { type: 'integer', minimum: 128, maximum: 512, description: 'tile size in px' },
        focus: { type: 'object', description: 'zoom: {centre: [x,y,z], radius} in metres (e.g. a knee or elbow). Default camera = rest-pose bounds, identical between calls; info.camera gives centre and pxPerMetre', properties: { centre: vec3, radius: { type: 'number' } } },
      },
    },
  },
  {
    name: 'bind', description: 'Skin the mesh to a skeleton with automatic (bone heat) weights, like Blender\'s Automatic Weights. Builds the skeleton and skin if the mesh has none; otherwise re-weights the existing skin (bone names must match its joints). Takes 10-40 s.',
    inputSchema: { type: 'object', required: ['file', 'skeleton'], properties: { file, out, skeleton: skeletonSchema, options: { type: 'object', description: 'advanced: {voxel: 0.01 (proxy resolution, smaller = finer and slower), lapScale: 0.2}' } } },
  },
  { name: 'get_skeleton', description: 'The skin\'s skeleton as bind JSON (edit it and bind again to move bones).', inputSchema: { type: 'object', required: ['file'], properties: { file } } },
  {
    name: 'paint_weights', description: 'Fix weights in a region for one bone: set, add or scale its weight; other bones keep their proportions of the rest; top 4 kept, normalised.',
    inputSchema: {
      type: 'object', required: ['file', 'bone', 'region', 'value'], properties: {
        file, out, bone: { type: 'string' },
        region: { type: 'object', description: '{sphere: {centre: [x,y,z], radius}} or {box: {min: [x,y,z], max: [x,y,z]}}, rest-pose world space' },
        op: { enum: ['set', 'add', 'scale'] }, value: { type: 'number' }, falloff: { enum: ['none', 'smooth'], description: 'smooth fades a sphere edge' },
        // result: verticesInRegion (skin vertices inside) and verticesChanged (weights that actually moved)
      },
    },
  },
  {
    name: 'animate', description: `Write (or replace) a keyframed animation. rot: ${ROT_DOC} move: offset from rest in metres (for the root/hips).`,
    inputSchema: {
      type: 'object', required: ['file', 'name', 'tracks'], properties: {
        file, out, name: { type: 'string' }, duration: { type: 'number', description: 'seconds; with loop the first key is repeated at duration' },
        loop: { type: 'boolean', description: 'default true' }, interpolation: { enum: ['LINEAR', 'STEP'] },
        holdRest: { type: 'boolean', description: 'default true: bones the clip does not key are keyed at rest, so switching clips in Blender or a game engine never leaves them in the last clip\'s pose' },
        tracks: { type: 'array', items: { type: 'object', required: ['bone', 'keys'], properties: { bone: { type: 'string' }, keys: { type: 'array', items: { type: 'object', required: ['t'], properties: { t: { type: 'number' }, rot: vec3, move: vec3 } } } } } },
      },
    },
  },
  {
    name: 'qa', description: 'Check an animation (or a pose): frames sinking below the rest-pose ground, edges stretched or squashed past a ratio, and hotspots (where and which bone) to fix with paint_weights (each hotspot has restBox, usable as region.box, surfacePoint, a sphere centre on the skin, and points, the flagged vertices; if they are scattered, small spheres on points beat the box).',
    inputSchema: { type: 'object', required: ['file'], properties: { file, animation: { type: 'string' }, pose: poseSchema, frames: { type: 'integer', minimum: 1, maximum: 48 }, stretch: { type: 'number', description: 'edge length ratio to flag, default 2' }, sinkTolerance: { type: 'number', description: 'metres below the rest-pose lowest point before a frame counts as sinking, default 0.005' } } },
  },
  {
    name: 'model', description: "Build a mesh from simple shapes (signed distance fields), like sculpting with clay primitives: each shape is combined, in list order, with everything before it. The Worker meshes the result into ONE closed, watertight mesh with vertex colours (ready for bind) and stores the model JSON inside the file, so later calls can send only a patch. Returns per-shape vertex counts and warnings (shapes with no visible effect, separate pieces); pass preview to also get pictures in the same call.\nCoordinates: glTF metres, +Y up, +Z front, +X the character's left; stand a character on y = 0 facing +Z. Params are in the shape's local frame; at moves it, rot turns it (degrees, X then Y then Z).\nShape fields: name (unique, used by patch), type, op (union default | subtract | intersect | paint = recolour only, geometry unchanged), blend (metres of smooth fillet with what came before; 0.01-0.05 for body joins, also softens paint and cuts), mirror: 'x' (adds the copy at -x; model the character's left side at +x), at [x,y,z], rot [x,y,z], color '#rrggbb' (a shape without color takes the colour under it).\nTypes: sphere {radius}; ellipsoid {radii:[x,y,z]}; box {size:[x,y,z], round}; cylinder {radius, height, round} (axis local Y, centred); cone {radius (bottom), radiusTop, height} (axis local Y, centred); torus {radius, thickness} (ring in local XZ); capsule {from:[x,y,z], to:[x,y,z], radius, radiusTo} (tapered; absolute coordinates, at still offsets); tube {points: [[x,y,z,radius], ...]} (a chain of tapered capsules: limbs, tails, hair strands); lathe {profile: [[r,y], ...]} (closed outline revolved round local Y: bottles, hats, vases); group {shapes: [...]} (a sub-model combined as ONE shape with the group's op/blend/at/rot/mirror/color, so a cut inside a group cuts only that group: e.g. a cap = sphere minus a box, a face part with its own hole).\nTips: overlap or blend every part into the body (floating parts bind badly); limbs slightly thicker than they look (they thin when bent); eyes/pupils/mouth as small paint or shallow subtract shapes; res defaults to size/160 (a 1.7 m figure gets ~1 cm and ~25k vertices), smaller res = finer detail and slower (cap 8M grid points). A model with ~40 shapes builds in a few seconds.",
    inputSchema: {
      type: 'object', required: ['out'], properties: {
        out: { type: 'string', description: 'file name to save the mesh as' },
        model: { type: 'object', description: 'the full model: {shapes: [...], res?}', required: ['shapes'], properties: { shapes: { type: 'array', items: { type: 'object', description: 'a shape, see the tool description', required: ['type'], properties: { name: { type: 'string' }, type: { enum: ['sphere', 'ellipsoid', 'box', 'cylinder', 'cone', 'torus', 'capsule', 'tube', 'lathe', 'group'] }, op: { enum: ['union', 'subtract', 'intersect', 'paint'] } } } }, res: { type: 'number' } } },
        from: { type: 'string', description: 'instead of model: a file made by this tool, rebuilt with patch applied (the rebuilt mesh is not rigged; bind it again)' },
        patch: { type: 'array', description: 'with from: [{name, ...fields}] merges fields into that shape (also inside groups; null removes a field); {name, remove: true} deletes it; a new name adds a shape at the end, or into: groupName, or before: shapeName', items: { type: 'object', required: ['name'] } },
        res: { type: 'number', description: 'grid step in metres (overrides the model\'s res)' },
        preview: { type: 'object', description: 'also return preview pictures of the result: {views, elev, res, focus} as in preview', properties: { views: { type: 'array', items: { type: 'number' } }, elev: { type: 'number' }, res: { type: 'integer' }, focus: { type: 'object' } } },
      },
    },
  },
  { name: 'get_model', description: 'The model JSON stored in a file made by the model tool (to read before patching).', inputSchema: { type: 'object', required: ['file'], properties: { file } } },
  { name: 'export', description: 'A download link for a stored file (signed, no header needed).', inputSchema: { type: 'object', required: ['file'], properties: { file, expires_minutes: { type: 'integer', minimum: 1, maximum: 10080 } } } },
];

const text = (o) => ({ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) });

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function sign(env, name, exp) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RIG_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${name}\n${exp}`)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const checkName = (n) => { if (!NAME_RE.test(n ?? '')) throw new Error(`bad file name ${JSON.stringify(n)} (letters, digits, . _ -)`); return n; };

const key = (cx, name) => `files/${cx.ns}${checkName(name)}`;

function vertexCount(doc) {
  let n = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) n += p.getAttribute('POSITION')?.getCount() ?? 0;
  return n;
}
async function load(env, cx, name) {
  const o = await env.FILES.get(key(cx, name));
  if (!o) throw new Error(`no file ${name}; use list_files${cx.demo ? '' : ' or import_url'}`);
  const doc = await readGLB(new Uint8Array(await o.arrayBuffer()));
  if (cx.demo && vertexCount(doc) > DEMO_LIMITS.maxVertices) throw new Error(`the public demo takes meshes up to ${DEMO_LIMITS.maxVertices} vertices; self-host for bigger ones`);
  return doc;
}
export async function listFiles(env, cx) {
  const p = `files/${cx.ns}`, l = await env.FILES.list({ prefix: p });
  return l.objects.map((o) => ({ name: o.key.slice(p.length), bytes: o.size, uploaded: o.uploaded }));
}
export async function roomFor(env, cx, name) { // demo: cap the number of files per client
  if (!cx.demo || (await env.FILES.head(key(cx, name)))) return;
  if ((await listFiles(env, cx)).length >= DEMO_LIMITS.maxFiles) throw new Error(`the public demo keeps at most ${DEMO_LIMITS.maxFiles} files per client; delete_file some first`);
}
async function save(env, cx, name, doc) {
  const bytes = await writeGLB(doc);
  await roomFor(env, cx, name);
  await env.FILES.put(key(cx, name), bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
  return { saved: name, bytes: bytes.length };
}

async function call(env, cx, name, a, origin) {
  switch (name) {
    case 'list_files': return [text(await listFiles(env, cx))];
    case 'import_url': {
      if (cx.demo) throw new Error('import_url is off on the public demo; upload with PUT /files/<name> instead');
      checkName(a.name);
      const u = new URL(a.url);
      if (!/^https?:$/.test(u.protocol)) throw new Error('http(s) only');
      const r = await fetch(u, { redirect: 'follow' });
      if (!r.ok) throw new Error(`fetch ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > MAX_IMPORT) throw new Error('file too big');
      await readGLB(buf); // must parse
      await env.FILES.put(key(cx, a.name), buf, { httpMetadata: { contentType: 'model/gltf-binary' } });
      return [text({ saved: a.name, bytes: buf.length })];
    }
    case 'delete_file': await env.FILES.delete(key(cx, a.file)); return [text({ deleted: a.file })];
    case 'inspect': return [text(T.inspect(await load(env, cx, a.file), a))];
    case 'get_skeleton': {
      const s = T.readSkeleton(await load(env, cx, a.file));
      return [text(s ?? 'not skinned yet')];
    }
    case 'preview': {
      const r = await T.preview(await load(env, cx, a.file), a);
      return [{ type: 'image', data: b64(r.png), mimeType: 'image/png' }, text(r.info)];
    }
    case 'bind': case 'paint_weights': case 'animate': {
      const doc = await load(env, cx, a.file);
      if (cx.demo && name === 'bind' && a.options?.voxel < DEMO_LIMITS.minVoxel) throw new Error(`the public demo needs options.voxel >= ${DEMO_LIMITS.minVoxel}`);
      const res = name === 'bind' ? T.bind(doc, a) : name === 'paint_weights' ? T.paintWeights(doc, a) : T.animate(doc, a);
      return [text({ ...res, ...(await save(env, cx, a.out ?? a.file, doc)) })];
    }
    case 'qa': return [text(T.qa(await load(env, cx, a.file), a))];
    case 'model': {
      checkName(a.out);
      const r = T.model(a, a.model ? null : await load(env, cx, a.from ?? a.out), cx.demo ? DEMO_LIMITS : {});
      const saved = await save(env, cx, a.out, r.doc);
      const res = [text({ ...r.info, ...saved })];
      if (a.preview) {
        const p = await T.preview(await readGLB(await writeGLB(r.doc)), { ...a.preview, mode: 'shaded' });
        res.unshift({ type: 'image', data: b64(p.png), mimeType: 'image/png' }); res.push(text(p.info));
      }
      return res;
    }
    case 'get_model': return [text(T.getModel(await load(env, cx, a.file)))];
    case 'export': {
      if (!(await env.FILES.head(key(cx, a.file)))) throw new Error(`no file ${a.file}`);
      const mins = Math.min(a.expires_minutes ?? 60, cx.demo ? DEMO_LIMITS.maxExpiresMinutes : 10080);
      const exp = Math.floor(Date.now() / 1000) + 60 * mins, path = `${cx.ns}${a.file}`;
      return [text({ url: `${origin}/dl/${path}?exp=${exp}&sig=${await sign(env, path, exp)}`, expires: new Date(exp * 1000).toISOString() })];
    }
    default: throw Object.assign(new Error(`unknown tool ${name}`), { rpc: -32602 });
  }
}

export async function handleMcp(req, env, cx = { ns: '', demo: false }) {
  if (req.method === 'GET') return new Response('use POST', { status: 405, headers: { allow: 'POST' } });
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  let msg;
  try { msg = await req.json(); } catch { return rpcErr(null, -32700, 'parse error'); }
  const origin = new URL(req.url).origin;
  const one = async (m) => {
    if (m.id === undefined) return null; // notification
    try {
      switch (m.method) {
        case 'initialize':
          return ok(m.id, {
            protocolVersion: m.params?.protocolVersion === '2025-03-26' ? '2025-03-26' : PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'rig-worker', version: '0.4.0' },
            instructions: (cx.demo ? 'Public demo: no token, small limits, files are private to your IP and deleted after a day. ' : '') + 'Headless modelling and rigging. To make a character: model (shapes -> closed mesh, patch to refine). Rigging loop: inspect -> preview with a proposed skeleton -> bind -> preview mode weights -> animate -> preview frames + qa -> paint_weights fixes -> export. Coordinates are glTF (+Y up, +Z front, +X the character\'s left), metres.',
          });
        case 'ping': return ok(m.id, {});
        case 'tools/list': return ok(m.id, { tools: cx.demo ? TOOLS.filter((t) => t.name !== 'import_url') : TOOLS });
        case 'tools/call':
          try { return ok(m.id, { content: await call(env, cx, m.params?.name, m.params?.arguments ?? {}, origin) }); }
          catch (e) { if (e.rpc) throw e; return ok(m.id, { content: [text(`error: ${e.message}`)], isError: true }); }
        default: return err(m.id, -32601, `method not found: ${m.method}`);
      }
    } catch (e) { return err(m.id, e.rpc ?? -32603, e.message); }
  };
  const res = Array.isArray(msg) ? (await Promise.all(msg.map(one))).filter(Boolean) : await one(msg);
  if (!res || (Array.isArray(res) && !res.length)) return new Response(null, { status: 202 });
  return Response.json(res);
}
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcErr = (id, code, message) => Response.json(err(id, code, message), { status: 400 });
