# Blender side, step 2: open every rig-worker GLB with Blender's own glTF importer (default settings, as a user would)
# and check it reproduces rig-worker's numbers: rest shape, vertex colours, material wiring, bones, weights, and the
# deformed mesh at sample times of every clip. Then re-export each one from Blender for the reverse check.
#   blender -b --factory-startup -P test/blender/check.py -- <dir>
# Writes <dir>/blender_report.json and <dir>/from_blender/<case>.glb. Exit 1 on failure.
import bpy, sys, os, json, math
import numpy as np
from mathutils import Vector, kdtree

args = sys.argv[sys.argv.index('--') + 1:]
d = args[0]
ref = json.load(open(os.path.join(d, 'ref.json')))
os.makedirs(os.path.join(d, 'from_blender'), exist_ok=True)

TOL = {'rest': 1e-4, 'color': 0.02, 'weight': 2e-3, 'anim': 1e-3, 'bone_dir_deg': 20}

def f32(name, cols=3):
    a = np.fromfile(os.path.join(d, name + '.f32'), dtype=np.float32)
    return a.reshape(-1, cols) if cols else a

def to_gltf(co):  # Blender Z-up world -> glTF Y-up
    return np.stack([co[:, 0], co[:, 2], -co[:, 1]], axis=1)

def world_coords(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg); me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3, dtype=np.float64); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    M = np.array(ev.matrix_world)
    co = co @ M[:3, :3].T + M[:3, 3]
    ev.to_mesh_clear()
    return to_gltf(co)

def material_report(ob):
    out = []
    for slot in ob.material_slots:
        m = slot.material
        if not m or not m.use_nodes: out.append({'name': m and m.name, 'nodes': False}); continue
        nt = m.node_tree; bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        def feeds(node, depth=0):  # node types feeding a socket chain into Base Color
            kinds = set()
            for inp in node.inputs:
                for l in inp.links:
                    kinds.add(l.from_node.type)
                    if depth < 4: kinds |= feeds(l.from_node, depth + 1)
            return kinds
        base = set()
        if bsdf:
            for l in bsdf.inputs['Base Color'].links:
                base.add(l.from_node.type); base |= feeds(l.from_node)
        img = next((n.image for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image), None)
        out.append({'name': m.name, 'baseColorFrom': sorted(base),
                    'vertexColorWired': 'VERTEX_COLOR' in base or 'ATTRIBUTE' in base,
                    'imageWired': 'TEX_IMAGE' in base,
                    'image': img and {'size': list(img.size), 'hasData': bool(img.has_data or img.packed_file)}})
    return out

def frame_of(t, fps):
    f = t * fps
    return int(math.floor(f)), f - math.floor(f)

report = {'blender': bpy.app.version_string, 'tolerances': TOL, 'cases': {}}
failed = []

for name, R in ref['cases'].items():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    res = bpy.ops.import_scene.gltf(filepath=os.path.join(d, name + '.glb'))
    C = {'import': sorted(res)}
    meshes = [o for o in scene.objects if o.type == 'MESH']
    arms = [o for o in scene.objects if o.type == 'ARMATURE']
    C['objects'] = {'meshes': len(meshes), 'armatures': len(arms)}
    # the importer adds a hidden bone-shape mesh to rigs; the model is the biggest mesh
    ob = max(meshes, key=lambda o: len(o.data.vertices)); arm = arms[0] if arms else None
    nV = len(ob.data.vertices)
    C['vertices'] = {'blender': nV, 'rig_worker': R['nV']}

    # rest shape (armature in rest position), and the vertex order mapping
    if arm: arm.data.pose_position = 'REST'
    rest = world_coords(ob); ref_rest = f32(name + '.rest')
    if nV == R['nV'] and np.abs(rest - ref_rest).max() < 1e-3:
        perm = np.arange(nV); C['vertexOrder'] = 'same'
    else:
        kd = kdtree.KDTree(len(ref_rest))
        for i, p in enumerate(ref_rest): kd.insert(Vector(p), i)
        kd.balance(); perm = np.array([kd.find(Vector(p))[1] for p in rest]); C['vertexOrder'] = 'remapped'
    C['restMaxError'] = float(np.abs(rest - ref_rest[perm]).max())
    ok = C['restMaxError'] < TOL['rest']

    # vertex colours (glTF COLOR_0 is linear; Blender's .color is linear too)
    if R['hasColor']:
        ca = ob.data.color_attributes
        C['colorAttributes'] = [(a.name, a.data_type, a.domain) for a in ca]
        if not len(ca): ok = False; C['colorMaxError'] = None
        else:
            a = ca[0]; vals = np.empty(len(a.data) * 4); a.data.foreach_get('color', vals); vals = vals.reshape(-1, 4)[:, :3]
            if a.domain == 'CORNER':
                vi = np.empty(len(ob.data.loops), dtype=np.int64); ob.data.loops.foreach_get('vertex_index', vi)
                per = np.zeros((nV, 3)); per[vi] = vals; vals = per
            C['colorMaxError'] = float(np.abs(vals - f32(name + '.col')[perm]).max())
            ok &= C['colorMaxError'] < TOL['color']
    C['materials'] = material_report(ob)
    if R['hasColor']: ok &= all(m.get('vertexColorWired') for m in C['materials']) and bool(C['materials'])
    if any(m['texture'] for m in R['materials']):
        C['uvMaps'] = [u.name for u in ob.data.uv_layers]
        ok &= bool(C['uvMaps']) and any(m.get('imageWired') and m['image']['hasData'] for m in C['materials'])

    if arm:
        bones = arm.data.bones
        C['bones'] = {'blender': len(bones), 'rig_worker': len(R['bones'])}
        names_ok = sorted(b.name for b in bones) == sorted(R['bones'])
        par = {b.name: (b.parent.name if b.parent else None) for b in bones}
        parents_ok = all(par.get(n) == p for n, p in zip(R['bones'], R['parents']))
        C['boneNamesMatch'], C['parentsMatch'] = names_ok, parents_ok
        ok &= names_ok and parents_ok
        # do the bones point along the limbs? (rig-worker's head -> tail vs Blender's bone head -> tail)
        if 'boneTails' in R:
            worst, offs = 0, {}
            for n, (h, t) in R['boneTails'].items():
                b = bones.get(n)
                if not b: continue
                hb = to_gltf(np.array([arm.matrix_world @ b.head_local]))[0]; tb = to_gltf(np.array([arm.matrix_world @ b.tail_local]))[0]
                u = np.array(t) - np.array(h); v = tb - hb
                if np.linalg.norm(u) < 1e-6: continue
                ang = math.degrees(math.acos(max(-1, min(1, float(u @ v / (np.linalg.norm(u) * np.linalg.norm(v)))))))
                offs[n] = round(ang, 1); worst = max(worst, ang)
            C['boneDirectionErrorDeg'] = {'worst': round(worst, 1), 'perBone': offs}
            ok &= worst < TOL['bone_dir_deg']
        # weights
        groups = {g.index: g.name for g in ob.vertex_groups}
        Wb = np.zeros((nV, len(R['bones']))); col = {n: i for i, n in enumerate(R['bones'])}
        for v in ob.data.vertices:
            for g in v.groups:
                n = groups[g.group]
                if n in col: Wb[v.index, col[n]] = g.weight
        Wr = f32(name + '.w', len(R['bones']))[perm]
        C['weightMaxError'] = float(np.abs(Wb - Wr).max())
        ok &= C['weightMaxError'] < TOL['weight']

        # clips
        arm.data.pose_position = 'POSE'
        ad = arm.animation_data
        C['actions'] = [a.name for a in bpy.data.actions]
        C['nlaTracks'] = [t.name for t in ad.nla_tracks] if ad else []
        fps = scene.render.fps / scene.render.fps_base
        C['clips'] = {}
        for clip, A in R['anims'].items():
            act = bpy.data.actions.get(clip) or next((a for a in bpy.data.actions if a.name.startswith(clip)), None)
            if not act: C['clips'][clip] = 'missing'; ok = False; continue
            if ad is None: ad = arm.animation_data_create()
            for t in ad.nla_tracks: t.mute = True
            ad.action = act
            # no pose reset between clips on purpose: a user switching actions doesn't do one either, and Blender leaves
            # bones a clip doesn't key in the last clip's pose (animate keys every bone, so this must still match)
            if hasattr(ad, 'action_slot') and ad.action_slot is None and len(act.slots): ad.action_slot = act.slots[0]
            posed = f32(f'{name}.anim.{clip}').reshape(len(A['times']), -1, 3)
            errs = []
            for k, t in enumerate(A['times']):
                fi, sub = frame_of(t, fps)
                scene.frame_set(fi, subframe=sub)
                errs.append(float(np.abs(world_coords(ob) - posed[k][perm]).max()))
            interp = sorted({kp.interpolation for fc in (act.fcurves if hasattr(act, 'fcurves') else []) for kp in fc.keyframe_points})
            C['clips'][clip] = {'frameRange': list(act.frame_range), 'durationFrames': A['duration'] * fps, 'maxError': max(errs),
                                'errorPerSample': [round(e, 5) for e in errs], 'interpolation': interp}
            ok &= max(errs) < TOL['anim']

    C['ok'] = bool(ok)
    if not ok: failed.append(name)
    report['cases'][name] = C
    # reverse direction: Blender re-exports what it imported
    if ad := (arm.animation_data if arm else None):
        for t in ad.nla_tracks: t.mute = False
    bpy.ops.export_scene.gltf(filepath=os.path.join(d, 'from_blender', name + '.glb'), export_format='GLB', export_animations=True,
                              export_animation_mode='ACTIONS')
    print(f'CASE {name}: {"ok" if ok else "FAIL"}')

json.dump(report, open(os.path.join(d, 'blender_report.json'), 'w'), indent=1)
print('BLENDER_CHECK', 'OK' if not failed else 'FAILED ' + ', '.join(failed))
sys.exit(1 if failed else 0)
