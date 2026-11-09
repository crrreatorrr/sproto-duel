"""
Build the Alien Ray Staff for Sproto Duel from the Tripo source GLB (headless Blender 5.x):

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
    -P tools/blender/alien_ray_staff.py -- "<source.glb>" <out_dir>
  node tools/blender/finish-staff.mjs <out_dir>/staff_alien_ray-src.glb \
    public/assets/models/staffs/staff_alien_ray-lod1.glb staff_alien_ray_idle \
    shaft=2000,beam=1500,saucer=3700,alien=350 1024
  node tools/blender/finish-staff.mjs <out_dir>/staff_alien_ray-src.glb \
    public/assets/models/staffs/staff_alien_ray.glb staff_alien_ray_idle \
    shaft=2100,beam=1600,saucer=3900,alien=380 2048

The source is the 1.9M-triangle "alien ray staff 3d model.glb" (Tripo). Blender picks the parts by
height, radius and the base colour's green (the rim aliens), splits and fits them, builds the glow
material and bakes the animation, then exports at full detail (staff_alien_ray-src.glb, ~70 MB).
finish-staff.mjs simplifies each part with meshoptimizer (seam-aware, unlike Blender's collapse
decimate on this mesh) and resizes the textures. Both results carry:
- nodes staff_alien_ray (grip at the origin, shaft along +Y, 1.894 m like the other staffs)
  > _shaft, _beam (spins, carries the cow), _saucer (spins the other way)
  > _saucer > _alien_0.._alien_5 (stadium-wave hop, rock, squash) and _fx_anchor (dome top);
- staff_alien_ray_mat, and staff_alien_ray_glow_mat (green emissive mask; the game pulses it);
- one 8 s looping clip, staff_alien_ray_idle.
"""
import bpy, sys, math, numpy as np
from mathutils import Vector, Quaternion, Matrix

argv = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = argv[0], argv[1]
SLUG = 'staff_alien_ray'
LENGTH = 1.894          # matches the delivered staffs (y -1.093 .. 0.801)
BOTTOM = -1.093
HEAD_SCALE = 0.62       # the saucer is 0.83 m wide at the source proportions; this keeps it clear of the hat
FPS, LOOP = 24, 8       # seconds
ALIEN_ANGLES = [30, 90, 150, 210, 270, 330]
TEXTURE = 2048          # finish-staff.mjs resizes per output

# ---------------------------------------------------------------- classification
def face_data(o, img):
    me = o.data
    n = len(me.polygons)
    cen = np.empty(n * 3, np.float32); me.polygons.foreach_get('center', cen); cen = cen.reshape(n, 3)
    ls = np.empty(n, np.int32); me.polygons.foreach_get('loop_start', ls)
    uvl = me.uv_layers.active.data
    uv = np.empty(len(uvl) * 2, np.float32); uvl.foreach_get('uv', uv); uv = uv.reshape(-1, 2)
    fuv = (uv[ls] + uv[ls + 1] + uv[ls + 2]) / 3.0
    W, H = img.size
    px = np.empty(W * H * 4, np.float32); img.pixels.foreach_get(px); px = px.reshape(H, W, 4)
    xi = np.clip((fuv[:, 0] % 1.0) * W, 0, W - 1).astype(np.int32)
    yi = np.clip((fuv[:, 1] % 1.0) * H, 0, H - 1).astype(np.int32)
    return cen, px[yi, xi, :3], px

def classify(cen, col):
    """0 shaft, 1 beam, 2 saucer (with dome and claws), 10+i alien i."""
    x, y, z = cen[:, 0], cen[:, 1], cen[:, 2]
    r = np.hypot(x, y)
    ang = (np.degrees(np.arctan2(y, x)) + 360) % 360
    R, G, B = col[:, 0], col[:, 1], col[:, 2]
    green = (G > R * 1.12) & (G > B * 1.35) & (G > 0.12)
    lab = np.zeros(len(cen), np.int32)
    lab[z >= 0.595] = 1
    lab[(z >= 0.735) | ((z >= 0.62) & (r > 0.075))] = 2
    alien = (z > 0.80) & (r > 0.122) & (r < 0.215) & green
    for i, a in enumerate(ALIEN_ANGLES):
        d = np.abs(((ang - a) + 180) % 360 - 180)
        lab[alien & (d < 30)] = 10 + i
    # Drop specks: alien faces far from their alien's median.
    for i in range(6):
        m = lab == 10 + i
        if not m.any(): continue
        med = np.median(cen[m], axis=0)
        far = m & (np.linalg.norm(cen - med, axis=1) > 0.07)
        lab[far] = 2
    return lab

# ---------------------------------------------------------------- helpers
def select_only(objs, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]

def split_off(o, mask, name):
    sel = np.zeros(len(o.data.polygons), bool); sel[:] = mask
    o.data.polygons.foreach_set('select', sel)
    select_only([o])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bpy.ops.object.mode_set(mode='OBJECT')
    o.data.polygons.foreach_set('select', sel)
    o.data.update()
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    new = [p for p in bpy.context.selected_objects if p is not o][0]
    new.name = name; new.data.name = name
    return new

def set_origin(o, p):
    p = Vector(p)
    o.data.transform(Matrix.Translation(-p))
    o.matrix_world = Matrix.Translation(p) @ o.matrix_world

# ---------------------------------------------------------------- build
def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.name = SLUG + '_idle'
    sc.render.fps = FPS
    bpy.ops.import_scene.gltf(filepath=SRC)
    src = [o for o in sc.objects if o.type == 'MESH'][0]
    src.name = SLUG + '_shaft'; src.data.name = SLUG + '_shaft'
    # Tripo splits the surface along every UV seam (331 loose pieces). Weld them so the parts are
    # whole surfaces for the simplifier; UVs stay per corner.
    select_only([src])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.0002)
    bpy.ops.object.mode_set(mode='OBJECT')
    base_img = next(i for i in bpy.data.images if 'basecolor' in i.name)
    cen, col, px = face_data(src, base_img)
    lab = classify(cen, col)

    # Fit: source z 0..0.98 -> staff y BOTTOM..BOTTOM+LENGTH, grip at the origin.
    zmin, zmax = cen[:, 2].min(), cen[:, 2].max()
    zmin = min(zmin, min((src.matrix_world @ Vector(c)).z for c in src.bound_box))
    zmax = max(zmax, max((src.matrix_world @ Vector(c)).z for c in src.bound_box))
    s = LENGTH / (zmax - zmin)
    fit = Matrix.Translation((0, 0, BOTTOM)) @ Matrix.Scale(s, 4) @ Matrix.Translation((0, 0, -zmin))

    parts = {'shaft': src}
    parts['beam'] = split_off(src, lab == 1, SLUG + '_beam')
    lab_left = lab[lab != 1]
    parts['saucer'] = split_off(src, lab_left == 2, SLUG + '_saucer')
    lab_left = lab_left[lab_left != 2]
    aliens = []
    for i in range(6):
        a = split_off(src, lab_left == 10 + i, f'{SLUG}_alien_{i}')
        lab_left = lab_left[lab_left != 10 + i]
        aliens.append(a)
    assert len(src.data.polygons) == len(lab_left) and (lab_left == 0).all(), 'split bookkeeping'

    allp = list(parts.values()) + aliens
    # The head (beam, saucer, aliens) shrinks about the beam's foot, where it meets the shaft.
    foot = (fit @ Vector((0, 0, float(cen[lab == 1][:, 2].min())))).z
    head = Matrix.Translation((0, 0, foot)) @ Matrix.Scale(HEAD_SCALE, 4) @ Matrix.Translation((0, 0, -foot))
    for o in allp:
        o.data.transform(fit)
        if o is not parts['shaft']:
            o.data.transform(head)
        o.matrix_world = Matrix.Identity(4)

    # Pivots.
    def bbox(o):   # world = local here (identity matrices, origins not moved yet)
        v = np.empty(len(o.data.vertices) * 3, np.float32); o.data.vertices.foreach_get('co', v); v = v.reshape(-1, 3)
        return v.min(0), v.max(0), v
    smn, smx, _ = bbox(parts['saucer'])
    bmn, bmx, _ = bbox(parts['beam'])
    set_origin(parts['saucer'], (0, 0, smn[2]))
    set_origin(parts['beam'], (0, 0, bmn[2]))
    for a in aliens:
        mn, mx, v = bbox(a)
        set_origin(a, (v[:, 0].mean(), v[:, 1].mean(), mn[2]))

    root = bpy.data.objects.new(SLUG, None); sc.collection.objects.link(root)
    anchor = bpy.data.objects.new(SLUG + '_fx_anchor', None); sc.collection.objects.link(anchor)
    anchor.location = (0, 0, smx[2])
    for o in [parts['shaft'], parts['beam'], parts['saucer']]:
        o.parent = root
    for o in aliens + [anchor]:
        mw = o.matrix_world.copy(); o.parent = parts['saucer']; o.matrix_parent_inverse = parts['saucer'].matrix_world.inverted(); o.matrix_world = mw

    # ------------------------------------------------------------ materials
    mat = src.data.materials[0]
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type == 'NORMAL_MAP':     # tangent normals don't survive the simplification
            nt.nodes.remove(n)
    for n in nt.nodes:
        if n.type == 'TEX_IMAGE' and n.image and 'normal' in n.image.name.lower():
            nt.nodes.remove(n); break
    for img in list(bpy.data.images):
        if img.size[0] > TEXTURE: img.scale(TEXTURE, TEXTURE)
    mat.name = SLUG + '_mat'

    # Emissive mask from the base colour: the green glass, beam and light strips.
    W, H = base_img.size
    bp = np.empty(W * H * 4, np.float32); base_img.pixels.foreach_get(bp); bp = bp.reshape(H, W, 4)
    R, G, B = bp[..., 0], bp[..., 1], bp[..., 2]
    m = np.clip((G - np.maximum(R, B) * 1.02) / 0.12, 0, 1) * np.clip((G - 0.15) / 0.25, 0, 1)
    em = np.empty_like(bp)
    tint = np.array([0.45, 1.0, 0.25], np.float32)
    em[..., :3] = (bp[..., :3] * 0.6 + tint * 0.4) * m[..., None]
    em[..., 3] = 1
    em_img = bpy.data.images.new(SLUG + '_emissive', W, H)
    em_img.pixels.foreach_set(em.ravel())
    em_img.file_format = 'JPEG'
    em_img.filepath_raw = f'{OUT}/{SLUG}_emissive.jpg'
    em_img.save()

    glow = mat.copy(); glow.name = SLUG + '_glow_mat'
    gnt = glow.node_tree
    bsdf = next(n for n in gnt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = gnt.nodes.new('ShaderNodeTexImage'); tex.image = em_img
    gnt.links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = 1.0

    for o in [parts['shaft'], parts['beam'], parts['saucer']]:
        o.data.materials.clear(); o.data.materials.append(glow)
    for a in aliens:
        a.data.materials.clear(); a.data.materials.append(mat)

    # ------------------------------------------------------------ animation
    frames = FPS * LOOP
    sc.frame_start, sc.frame_end = 0, frames
    sau, beam = parts['saucer'], parts['beam']
    for o in [sau, beam] + aliens:
        o.rotation_mode = 'QUATERNION'
    rest = {a.name: (a.location.copy(), a.rotation_quaternion.copy(), a.scale.copy()) for a in aliens}
    sau_rest = sau.location.copy(); beam_rest = beam.location.copy()
    TAU = math.tau
    for f in range(frames + 1):
        u = f / frames                    # 0..1 over the loop
        tsec = u * LOOP
        # Saucer: one turn per loop, a gentle hover bob and wobble.
        sau.rotation_quaternion = Quaternion((0, 0, 1), TAU * u) @ Quaternion((1, 0, 0), math.radians(2.5) * math.sin(TAU * 2 * u))
        sau.location = sau_rest + Vector((0, 0, 0.012 * HEAD_SCALE * math.sin(TAU * 2 * u)))
        # Beam (with the cow): turns the other way, twice as fast.
        beam.rotation_quaternion = Quaternion((0, 0, 1), -TAU * 2 * u)
        beam.location = beam_rest
        for i, a in enumerate(aliens):
            loc, q0, sc0 = rest[a.name]
            ph = TAU * (2 * u) - i * TAU / 6          # stadium wave around the rim, 0.25 Hz
            hop = max(0.0, math.sin(ph)) ** 2           # one hop per cycle
            ang = math.radians(ALIEN_ANGLES[i])
            tangent = Vector((-math.sin(ang), math.cos(ang), 0))
            rock = Quaternion(tangent, math.radians(14) * math.sin(TAU * 4 * u + i))
            yaw = Quaternion((0, 0, 1), math.radians(18) * math.sin(TAU * 2 * u + i * 1.7))
            a.rotation_quaternion = yaw @ rock @ q0
            a.location = loc + Vector((0, 0, 0.018 * HEAD_SCALE * hop))
            st = 1 + 0.16 * hop - 0.08 * max(0.0, -math.sin(ph))   # stretch up, squash on landing
            a.scale = Vector((sc0.x / math.sqrt(st), sc0.y / math.sqrt(st), sc0.z * st))
        for o in [sau, beam] + aliens:
            o.keyframe_insert('location', frame=f)
            o.keyframe_insert('rotation_quaternion', frame=f)
            o.keyframe_insert('scale', frame=f)

    for o in sc.objects:
        o.select_set(o in [root] + allp + [anchor])
    out = f'{OUT}/{SLUG}-src.glb'
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=True, export_yup=True,
        export_animations=True, export_animation_mode='SCENE', export_force_sampling=True,
        export_frame_range=True, export_anim_single_armature=False,
        export_image_format='JPEG', export_jpeg_quality=88, export_apply=True,
    )
    tris = sum(len(o.data.polygons) for o in allp)
    print(f'[alien_ray] {tris} tris -> {out}')
    for o in allp: print('   ', o.name, len(o.data.polygons))

build()
