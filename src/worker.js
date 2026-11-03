// rig-worker: headless 3D modelling and rigging for agents, as one Cloudflare Worker.
//   POST /mcp                 MCP tools (model, inspect, preview, bind, paint_weights, animate, qa, export, files)
//   PUT  /files/<name>        upload a GLB (body = bytes)      GET /files/<name>  download      GET /files  list
//   GET  /dl/<name>?exp&sig   signed download (from the export and view tools, no header)
//   GET  /view/<name>?exp&sig the same file in the 3D viewer (src/viewer.html; also the MCP Apps resource of the view tool)
//   POST /bind                multipart glb + skeleton (+ opts) -> rigged GLB, stats in x-rig-stats
// Private deployment: everything except /dl needs authorization: Bearer <RIG_TOKEN>.
// Public demo (env.DEMO = "1"): no token; each client IP gets its own file space, calls are rate limited and capped
// (see DEMO_LIMITS in mcp.js), import_url and POST /bind are off, and the bucket deletes files after a day.
import { rebind, readGLB } from './glb.js';
import { handleMcp, sign, listFiles, roomFor } from './mcp.js';
import VIEWER from './viewer.html';

const NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;
const DL_RE = /^(?:([0-9a-f]{16})\/)?([A-Za-z0-9._-]{1,120})$/;
const MAX_UPLOAD = 64 * 1024 * 1024, DEMO_MAX_UPLOAD = 8 * 1024 * 1024;
const HEAVY = new Set(['model', 'bind']); // the calls that can take seconds of CPU

function same(a, b) { // constant-time compare
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'mcp-session-id',
  'access-control-max-age': '86400',
};
// the viewer page: scripts only from itself and jsDelivr (three.js), data only from this Worker
const VIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob: data:; base-uri 'none'; form-action 'none'; frame-ancestors *";
const signedOk = async (env, p, url) => { const exp = +url.searchParams.get('exp'); return DL_RE.test(p) && exp > Date.now() / 1000 && same(url.searchParams.get('sig') ?? '', await sign(env, p, exp)); };
const withCors = (r) => { const h = new Headers(r.headers); for (const [k, v] of Object.entries(CORS)) h.set(k, v); return new Response(r.body, { status: r.status, headers: h }); };

// demo: a client's file space is an HMAC of its IP (not reversible without the Worker's secret)
async function clientNs(env, ip) {
  return (await sign(env, `ns:${ip}`, 0)).slice(0, 16) + '/';
}

// demo rate limits (Workers rate-limiting bindings; skipped when not bound, e.g. in wrangler dev)
async function limited(env, ip, req) {
  if (env.RL && !(await env.RL.limit({ key: ip })).success) return 'too many requests: the public demo allows 30 a minute';
  if (req.method !== 'POST') return null;
  let names = [];
  try {
    const m = await req.clone().json();
    names = (Array.isArray(m) ? m : [m]).filter((x) => x?.method === 'tools/call').map((x) => x.params?.name);
  } catch { return null; }
  for (const n of names) {
    if (!HEAVY.has(n)) continue;
    if (env.RL_HEAVY && !(await env.RL_HEAVY.limit({ key: ip })).success) return 'too many model/bind calls: the public demo allows 6 a minute per client';
    if (env.RL_GLOBAL && !(await env.RL_GLOBAL.limit({ key: 'all' })).success) return 'the public demo is busy (global model/bind limit); try again in a minute, or self-host';
  }
  return null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname, demo = env.DEMO === '1';
    if (!env.RIG_TOKEN) return new Response('not configured: set the RIG_TOKEN secret\n', { status: 503 });

    // signed links work without the token; CORS so the viewer can fetch them from inside an MCP host's sandbox
    if (req.method === 'GET' && path.startsWith('/dl/')) {
      const p = path.slice(4);
      if (!(await signedOk(env, p, url))) return new Response('bad or expired link\n', { status: 403, headers: CORS });
      const o = await env.FILES.get(`files/${p}`);
      const h = { 'content-type': 'model/gltf-binary', 'content-disposition': `attachment; filename="${DL_RE.exec(p)[2]}"`, 'cache-control': 'private, max-age=300', ...CORS };
      return o ? new Response(o.body, { headers: h }) : new Response('not found\n', { status: 404, headers: CORS });
    }
    if (req.method === 'GET' && path.startsWith('/view/')) {
      if (!(await signedOk(env, path.slice(6), url))) return new Response('bad or expired link: ask the agent for a new one (view tool)\n', { status: 403 });
      return new Response(VIEWER, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': VIEW_CSP, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
    }
    if (req.method === 'OPTIONS' && path.startsWith('/dl/')) return new Response(null, { status: 204, headers: CORS });

    let cx = { ns: '', demo: false, viewer: VIEWER };
    if (demo) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      const ip = req.headers.get('cf-connecting-ip') ?? 'local';
      const why = await limited(env, ip, req);
      if (why) return withCors(Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: why } }, { status: 429, headers: { 'retry-after': '60' } }));
      cx = { ns: await clientNs(env, ip), demo: true, viewer: VIEWER };
      const r = await route(req, env, url, path, cx);
      return withCors(r);
    }
    // every other call can burn minutes of billed CPU or touch storage: require the shared token
    if (!same(req.headers.get('authorization') ?? '', `Bearer ${env.RIG_TOKEN}`)) return new Response('unauthorized\n', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
    return route(req, env, url, path, cx);
  },
};

async function route(req, env, url, path, cx) {
  if (path === '/mcp') return handleMcp(req, env, cx);
  if (req.method === 'GET' && path === '/') {
    return new Response(`rig-worker${cx.demo ? ' public demo' : ''}: POST /mcp (MCP tools), PUT/GET /files/<name>${cx.demo ? '' : ', POST /bind'}\ndocs: https://epinnock.github.io/rig-worker/\n`);
  }
  if (path === '/files' && req.method === 'GET') return Response.json(await listFiles(env, cx));
  if (path.startsWith('/files/')) {
    const name = path.slice(7), k = `files/${cx.ns}${name}`;
    if (!NAME_RE.test(name)) return new Response('bad name\n', { status: 400 });
    if (req.method === 'PUT') {
      const max = cx.demo ? DEMO_MAX_UPLOAD : MAX_UPLOAD;
      if (+(req.headers.get('content-length') ?? 0) > max) return new Response(`too big (max ${max >> 20} MB)\n`, { status: 413 });
      const buf = new Uint8Array(await req.arrayBuffer());
      if (buf.length > max) return new Response(`too big (max ${max >> 20} MB)\n`, { status: 413 });
      try { await readGLB(buf); } catch (e) { return new Response(`not a GLB: ${e.message}\n`, { status: 400 }); }
      try { await roomFor(env, cx, name); } catch (e) { return new Response(`${e.message}\n`, { status: 409 }); }
      await env.FILES.put(k, buf, { httpMetadata: { contentType: 'model/gltf-binary' } });
      return Response.json({ saved: name, bytes: buf.length });
    }
    if (req.method === 'GET') {
      const o = await env.FILES.get(k);
      return o ? new Response(o.body, { headers: { 'content-type': 'model/gltf-binary' } }) : new Response('not found\n', { status: 404 });
    }
    if (req.method === 'DELETE') { await env.FILES.delete(k); return new Response(null, { status: 204 }); }
  }

  if (req.method === 'POST' && path === '/bind' && !cx.demo) {
    try {
      const form = await req.formData();
      const glb = new Uint8Array(await form.get('glb').arrayBuffer());
      const skeleton = JSON.parse(form.get('skeleton'));
      const opts = form.get('opts') ? JSON.parse(form.get('opts')) : {};
      const out = await rebind(glb, skeleton, opts);
      return new Response(out.glb, { headers: { 'content-type': 'model/gltf-binary', 'x-rig-stats': JSON.stringify(out.stats) } });
    } catch (e) {
      return new Response(`error: ${e.message}\n`, { status: 500 });
    }
  }
  return new Response('not found\n', { status: 404 });
}
