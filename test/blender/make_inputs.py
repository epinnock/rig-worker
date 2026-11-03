# Blender side, step 1: make the inputs a Blender user would hand to rig-worker, and export them as GLB.
#   blender -b --factory-startup -P test/blender/make_inputs.py -- <outdir>
#   blender_mesh.glb   a UV-mapped, image-textured mesh with no rig (rig-worker must add a skin and keep the material)
#   blender_rig.glb    the same mesh skinned to a 3-bone Blender armature (bones with rolls and a tilt) and an action
#                      "bend" (rig-worker must re-weight it, add clips, and keep the original clip and bone orientations)
import bpy, bmesh, sys, os, math

out = sys.argv[sys.argv.index('--') + 1]
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24

# a capsule-ish column 1.6 m tall: cylinder with UVs, 16 rings, rounded top
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.18, depth=1.6, location=(0, 0, 0.8), calc_uvs=True)
col = bpy.context.object
col.name = 'Column'
bm = bmesh.new(); bm.from_mesh(col.data)
vertical = [e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) > 1.0]
bmesh.ops.subdivide_edges(bm, edges=vertical, cuts=15, use_grid_fill=False)
bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
bm.to_mesh(col.data); bm.free()
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.shade_smooth()

# an image texture (generated colour grid, packed so the exporter embeds it)
img = bpy.data.images.new('grid', 128, 128)
img.generated_type = 'COLOR_GRID'
img.pack()
mat = bpy.data.materials.new('GridMat'); mat.use_nodes = True
nt = mat.node_tree; bsdf = nt.nodes['Principled BSDF']
tex = nt.nodes.new('ShaderNodeTexImage'); tex.image = img
nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Roughness'].default_value = 0.6
col.data.materials.append(mat)

def export(path, objs, anims):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_animations=anims,
                              export_yup=True, export_apply=False)

export(os.path.join(out, 'blender_mesh.glb'), [col], False)

# armature: Root -> Mid -> Top, with a tilt and rolls so joint axes are NOT world-aligned
bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
arm = bpy.context.object; arm.name = 'Rig'; arm.data.name = 'Rig'
eb = arm.data.edit_bones
root = eb[0]; root.name = 'Root'; root.head = (0, 0, 0.05); root.tail = (0, 0.0, 0.55); root.roll = 0
mid = eb.new('Mid'); mid.head = root.tail; mid.tail = (0.03, 0, 1.05); mid.roll = math.radians(30); mid.parent = root; mid.use_connect = True
top = eb.new('Top'); top.head = mid.tail; top.tail = (0.0, 0.02, 1.58); top.roll = math.radians(-45); top.parent = mid; top.use_connect = True
bpy.ops.object.mode_set(mode='OBJECT')

col.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
assert len(col.vertex_groups) == 3, 'automatic weights failed'

# action "bend": Mid and Top bend forward and back over 1 s
arm.animation_data_create()
act = bpy.data.actions.new('bend'); arm.animation_data.action = act
for f, a in ((1, 0), (13, 35), (25, 0)):
    scene.frame_set(f)
    for b, k in (('Mid', 1.0), ('Top', 0.6)):
        pb = arm.pose.bones[b]; pb.rotation_mode = 'XYZ'; pb.rotation_euler = (math.radians(a * k), 0, 0)
        pb.keyframe_insert('rotation_euler', frame=f)
scene.frame_start, scene.frame_end = 1, 25
export(os.path.join(out, 'blender_rig.glb'), [arm, col], True)
print('MAKE_INPUTS_OK')
