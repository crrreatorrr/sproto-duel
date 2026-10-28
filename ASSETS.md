# Asset list for Higgsfield

Everything the game can use, with a suggested prompt for each. The game is fully playable without
any of these: missing models fall back to primitives, missing textures to procedural ones, and
missing sounds to synthesized placeholders. Generate them in any order.

## How swapping works

1. Save the file under `public/assets/` at the path in the tables below (also listed in
   `src/assets/manifest.ts`).
2. The dev server notices the new file and reloads. Nothing else to change.
3. Check the browser console: each loaded model logs its triangle and animation-clip count, and
   warns if it is over budget.

Tuning per asset, all in `src/assets/manifest.ts`:

| Option | Use it when |
|---|---|
| `fitHeight` | Always set for models. Higgsfield models come at arbitrary scale; the loader rescales to this height and stands the model on the floor. |
| `rotationY` | The model doesn't face forward (+Z). Try `180` or `90`. |
| `yOffset` | Feet float or sink after fitting. |
| `clips` | Wizard animation names inside the GLB (case-insensitive; exact names first, then substrings). |
| `rigged` | A skinned, animated version of the model (`models/rigged/`), used instead when on disk. See *Rigged characters*. |
| `motion` | Procedural motion style: `weight` (heavier, slower) and `menace` (a looming sway), 0..1. Boss stages get heavier each stage. |

Audio and textures may use any common extension: list `audio/bolt_cast.mp3`, save
`audio/bolt_cast.wav`, it is still found.

## Style guide (use in every prompt)

- **Look:** stylized fantasy, hand-painted textures, chunky readable silhouettes, slightly
  exaggerated proportions. Think "arcade spell duel", not realism.
- **Setting:** an ancient circular duelling arena at night, moonlit violet sky, a ring of magic fire
  at the edge, rune-carved stone.
- **Teams:** the player is **cobalt blue + silver** with cyan magic; the rival is **crimson +
  gold** with orange magic. Keep wizards clearly different in silhouette too (hat shape, robe cut).
- **Budget:** every model under **10,000 triangles** (debris under 400), one material if possible,
  textures 1024² (2048² for wizards and floor).

## Models (GLB)

| Key | File | Tris | Description |
|---|---|---|---|
| `wizardPlayer` | `models/wizard_player.glb` | ≤ 10k | The player's duellist. Fitted to 1.85 m. |
| `wizardRival` | `models/wizard_rival.glb` | ≤ 10k | The AI opponent. Fitted to 1.85 m. |
| `pillar` | `models/pillar.glb` | ≤ 4k | Cover column, fitted to 5.5 m tall, about 1.7 m wide. Collision is a cylinder, so keep it roughly round. |
| `pillarBroken` | `models/pillar_broken.glb` | ≤ 2k | Stump left after a pillar crumbles, fitted to 1.0 m. Same footprint as the pillar. |
| `pillarDebris` | `models/pillar_debris.glb` | ≤ 400 | One stone chunk, instanced up to 160 times when pillars break. |
| `arenaRuins` | `models/arena_ruins.glb` | ≤ 8k | Backdrop piece placed 8 times, 8 m outside the wall (replaces the placeholder standing stones). Fitted to 6 m. |
| `brazier` | `models/brazier.glb` | ≤ 2k | Fire bowl placed 8 times on top of the arena wall. Fitted to 1.6 m. A flame glow is added in code. |

### Prompts

**wizard_player**
> Stylized fantasy duelling wizard, full body, T-pose, young battle-mage in a fitted cobalt-blue
> robe with silver trim and a short cape, tall pointed hat with a silver band, leather bracers,
> holding a slim dark-wood wand in the right hand, glowing cyan rune on the chest, hand-painted
> texture, clean readable silhouette, game-ready low-poly, plain background

**wizard_rival**
> Stylized fantasy rival wizard, full body, T-pose, sharp-featured duellist in a crimson robe with
> gold embroidery and angular shoulder pieces, wide-brimmed crooked hat, long coat tails, holding a
> bone-white wand in the right hand, glowing orange rune on the chest, hand-painted texture, menacing
> but stylized, game-ready low-poly, plain background

**pillar**
> Ancient round stone column for a magic duelling arena, weathered grey-violet stone, carved rune
> band glowing faint blue around the middle, square base and capital, small cracks and moss,
> hand-painted stylized texture, game-ready low-poly

**pillar_broken**
> Broken stump of an ancient round stone column, jagged shattered top, rubble at the base,
> weathered grey-violet stone with a cracked rune band, hand-painted stylized texture, game-ready
> low-poly

**pillar_debris**
> Single chunk of broken grey-violet stone, irregular faceted rock fragment with one carved edge,
> hand-painted stylized texture, very low-poly

**arena_ruins**
> Ruined stone archway and broken colonnade segment from an ancient magic arena, crumbling arches,
> fallen blocks, faint glowing runes, moonlit, hand-painted stylized texture, game-ready low-poly

**brazier**
> Iron fire brazier on a short stand, wide bowl with claw feet and rune engravings, empty bowl
> (flames are added in game), stylized hand-painted texture, game-ready low-poly

### Rigged characters (`models/rigged/`)

The player and every boss stage have a static Higgsfield/Tripo mesh (animated procedurally: breathing,
sway, leans, footstep bob, squash and stretch, flinch, cast lunge, topple) **and** an optional
skinned, animated version in `models/rigged/`. When the rigged file is on disk the loader uses it
instead and the clips drive the body; when it is missing (or fails to load) the static mesh is used,
so files can land one at a time.

| Manifest key | Rigged file |
|---|---|
| `wizardPlayer` | `models/rigged/wizard_player.glb` |
| `boss<Id>1..3` (Sahil, Obama, Midget, Broccoli, Agent, Tinubu) | `models/rigged/<id>_stage1..3.glb`, e.g. `sahil_stage2.glb`, `midget_stage3.glb` |

**Pipeline** (the rigging agents' tooling): the stage's Tripo mesh is auto-rigged with
Higgsfield/Meshy (24-joint humanoid: `Hips`, `Spine02`, `Spine01`, `Spine`, `neck`, `Head`, and
`Left`/`Right` `Shoulder`, `Arm`, `ForeArm`, `Hand`, `UpLeg`, `Leg`, `Foot`, `ToeBase`), the mage
motion set is retargeted onto it (calibrated to the character's own idle), props such as staffs
are split onto the hand bone and kept upright, and the result is optimized to one GLB per stage.
Conventions the game relies on:

- **Facing +Z** (manifest `rigged.rotationY` 0; the static Tripo meshes need -90).
- **Already fitted**: height equals the entry's `fitHeight` with the feet at y = 0. The loader still
  applies `fitHeight` and `anchor: 'feet'` (a no-op when fitted). The `Armature` root is scaled 0.01
  (centimetre bones); leave it.
- **Clips are baked per character**, named: `idle`, `run`, `cast`, `cast_big`, `hit`, `defeat`,
  `roll`, `stun`, `victory`, `jump`, `strafe_l`, `strafe_r`, `run_back` (manifest `WIZARD_CLIPS`;
  exact names first, then substrings). Missing clips are fine: no strafe clips means the run plays
  with the hips turned toward the travel, no `run_back` plays the run backwards, no `roll`/`defeat`
  keeps the procedural flip and topple, no `jump` holds a slowed run in the air. `rigged.skipClips`
  turns clips off per model (Tinubu: no `roll` or `jump`, his rigid wings and robe go through the
  floor). Rates: roll is stretched to the 0.34 s dodge (~2.9x), jump to the 0.68 s airtime (~0.83x,
  the game's arc drives the height), run, strafes and run_back share one phase paced by speed.
- **Root motion is removed at load** (`src/assets/rig.ts`): every clip's `Hips` horizontal track is
  replaced by the constant that centres the clip's feet on the collider (height kept), so the body
  never drifts off its hitbox; `defeat` keeps its travel (the body falls away backwards).
- **Cast timing**: the release is ~0.45 s into `cast` and ~0.62 s into `cast_big` (override per
  model with `rigged.castPeak` / `castBigPeak`). Windups are scrubbed so that moment lands exactly on
  the spell's release; bolts snap in just before it.
- **Facing**: the library's mocap stands turned (idle about -25° at the hips, a hit about -60°). At
  load the game measures each clip's average chest yaw against the run (straight ahead) and turns
  the hips of idle, hit, cast_big, stun and victory back by it; a look-at then turns the chest,
  neck and head back toward the target in every clip but roll and defeat. The plain `cast` keeps
  its side-on body (its staff thrust aims at the target) with the eyes on the target.
- **Wings** split onto their own bones without clip channels (Tinubu's `LeftWing`/`RightWing`
  under `Spine`, bind axes = model axes) flap procedurally about their forward axis, faster during
  casts and transformations.
- Skinned meshes are never frustum culled, and each copy's skeleton is freed when a stage swaps.

**Muzzle sockets** (visual only): `rigged.sockets` puts a muzzle point (`staff`, `phoneR`, `phoneL`,
`vape`, `gun`, `hand`, `mouth`, matching the muzzle names below) on a bone,
`{ bone, offset, glowOffset? }` in that bone's local centimetres: `offset` is the game's muzzle
point, `glowOffset` the gem's or flame's centre where the glow sits (defaults to `offset`). The
rigging tooling measures them into a `sockets.json`; paste its entries into `RIG_SOCKETS` in
`src/assets/manifest.ts` (keyed by manifest key, then muzzle name). The muzzle's glows, charge glow,
light and cast effects then ride the animated prop. Spells still spawn from the measured muzzle
point (`Wizard.castPoint`), the deterministic gameplay origin. Measured so far: the player, Sahil
1-3 (staff on `RightHand`) and Tinubu 1-3 (hand on `RightHand`, mouth on `Head`).

Check a new file with `await __duel.qa.runAll('anim.')` (rigged preferred, clips found, root
pinned, sockets on their bones, swaps leak nothing) and `runAll('muzzles.')`.

### Shrinking files

Generated GLBs are often heavy. Before dropping them in:

```bash
npx @gltf-transform/cli optimize input.glb public/assets/models/wizard_player.glb --compress meshopt --texture-compress webp --texture-size 2048 --simplify-ratio 0.5
```

Meshopt-compressed GLBs load natively. If a model is still over budget, lower `--simplify-ratio`.

## Campaign bosses

The Boss Gauntlet has five bosses, easiest first (roster, stages and tuning in
`src/campaign/levels.ts`). Every boss evolves twice per round (at 2/3 and 1/3 health), so each has
**three stage models** that grow taller and more monstrous, plus a portrait per stage. All were
generated with Higgsfield (concept image with `gpt_image_2_5`, stages 2 and 3 made with the stage 1
image as a reference so they read as the same character, then `tripo_h3_1_image_to_3d`). Regenerate
any of them by replacing the file.

| Boss | Models (`models/bosses/<id>/`) | Portraits (`ui/bosses/`) | Arena theme | Projectiles |
|---|---|---|---|---|
| 1. Sahil, the RugMaster | `sahil/stage1..3.glb` (2.0 / 2.25 / 2.55 m) | `sahil.png`, `sahil_stage2.png`, `sahil_stage3.png` | `desert` | rolled rugs, flying carpets |
| 2. Bitcoin Obama & The Midget (a double fight) | Obama: `obama/stage1..3.glb` (2.1 / 2.3 / 2.55 m) | `obama.png` (the pair, used on cards), `obama_stage2.png`, `obama_stage3.png` | `void` | phones, pigs |
| 2b. The Midget (Obama's partner, fought at the same time) | `midget/stage1..3.glb` (1.25 / 1.4 / 1.6 m): stage 2 laser eyes, Bitcoin chain, phones in hand; stage 3 gold top hat, candlestick-chart robe | `midget.png`, `midget_stage2.png`, `midget_stage3.png` (his stage banners) | | phones, pigs |
| 3. Broccoli Head, the Floret Lord | `broccoli/stage1..3.glb` (2.0 / 2.35 / 2.8 m) | `broccoli.png`, `broccoli_stage2.png`, `broccoli_stage3.png` | `city` | florets, whole broccoli |
| 4. Glowie | `agent/stage1..3.glb` (2.0 / 2.2 / 2.5 m) | `agent.png`, `agent_stage2.png`, `agent_stage3.png` | `office` | bullets, grenades |
| 5. Tinubu, the Unshackled Demon | `tinubu/stage1..3.glb` (2.1 / 2.45 / 2.9 m) | `tinubu.png`, `tinubu_stage2.png`, `tinubu_stage3.png` | `volcano` | hellfire, burning skulls |

The Midget is a second boss wizard in fight 2 with his own short hitbox (1.25 m), so his models
are fitted to 1.25-1.6 m rather than ~2 m (manifest keys `bossMidget1..3`). Without his GLBs he is a
scaled-down placeholder wizard in royal blue and bronze with a small gold top hat.

### Muzzle points (where spells leave each model)

Every boss stage and the player's model has **muzzle points**: where its spells come out (staff
orb or gem, phone, vape mouthpiece or cannon outlet, gun barrel, Tinubu's raised hand and mouth).
They are measured on each GLB, so **re-measure them whenever you regenerate a model**: boss stages
in `levels.ts` (`muzzle` on each stage, partners included), the player in `manifest.ts`
(`wizardPlayer.muzzle`).

A point is `[forward, up, right]` as **fractions of the model's height**, measured from the centre
of its feet (the centroid of the lowest 12 % of vertices, the loader's `anchor: 'feet'`), as the
character faces in game. The game multiplies by `fitHeight`, so a changed fit height needs no
re-measuring. Example: Sahil stage 1 (2.0 m) `[0.15, 0.895, 0.265]` is 0.30 m forward, 1.79 m up,
0.53 m to his right.

To measure: run the game, instantiate the model (`__duel.game.assets.instantiate('bossSahil1')`),
read vertex positions in its root's frame (+Z forward, +X the model's left, feet at 0), find the prop
(texture colours and extremes help: the glowing orb, the dark phone, the most forward barrel
vertices), convert with `[z, y, -x] / fitHeight`, and check with a marker sphere from the front and
the side. `__duel.qa.runAll('muzzles.')` then checks every stage fires from its data. Measured
values (meters at the fit height):

| Model | Points (m: forward, up, right) | Casts |
|---|---|---|
| Player (1.9 m) | staff orb 0.14, 1.74, 0.39 | everything |
| Sahil 1 / 2 / 3 | staff gem 0.30, 1.79, 0.53 / 0.47, 2.01, 0.70 / 0.42, 2.28, 0.84 | everything |
| Bitcoin Obama 1 | phone (right hand) 0.34, 1.42, 0.41 | everything |
| Bitcoin Obama 2 | phones: right 0.11, 1.43, 0.66; left 0.21, 1.39, -0.60 | alternate |
| Bitcoin Obama 3 | fists (phones drawn in code): right 0.08, 1.19, 0.60; left 0.23, 1.16, -0.50 | alternate |
| The Midget 1 | phone (left hand) 0.23, 0.75, -0.31 | everything |
| The Midget 2 | phones: right 0.27, 0.87, 0.31; left 0.28, 0.87, -0.30 | alternate |
| The Midget 3 | fists (phones drawn in code): right 0.13, 0.79, 0.37; left 0.04, 0.77, -0.52 | alternate |
| Broccoli Head 1 / 2 / 3 | pen mouthpiece 0.28, 1.51, 0.30 / box mod 0.46, 1.74, 0.43 / cannon outlet 1.16, 1.26, 0.29 | everything (puff size 1 / 1.6 / 2.6) |
| Glowie 1 / 2 / 3 | pistol 0.17, 0.69, 0.49 / SMG 0.44, 1.50, -0.25 / minigun 1.14, 1.00, -0.52 | everything |
| Tinubu 1 | hand (raised palm) 0.50, 1.64, 0.48; mouth 0.15, 1.67, -0.05 | bolt/stun hand, blast/volley mouth, Ultimate both |
| Tinubu 2 | right claw 0.41, 1.18, 0.86; mouth 0.40, 1.92, -0.03 | as stage 1 |
| Tinubu 3 | right claw 0.52, 1.33, 1.03; mouth 0.33, 2.29, 0.07 | as stage 1 |

A muzzle set lists named points and, optionally, which point each cast uses (`use`); several
points for one cast alternate shot by shot. Without a GLB, the primitive placeholder carries a
matching code-built prop (`PLACEHOLDER_MUZZLES`). A model with no muzzle data casts from a generic
wand point in front of the right hand.

Boss models are static meshes (the game animates them procedurally; their rigged versions in
`models/rigged/` take over when present, see *Rigged characters*), ≤ 9k triangles each. Generate
concepts in a wide standing stance rather than a T-pose: whole body, front
view, plain background, one character, few detached floating objects. Projectiles are built in code
(`skins` in `levels.ts`).

## Arena obstacles (optional)

Each boss arena's obstacles are built in code; a generated model replaces a kind's look when its
file exists (`OBSTACLE_MODELS` in `src/assets/manifest.ts`). Models face +X (rotated -90 degrees
on load), are fitted per axis to the obstacle's collider bounds (turned 90 degrees first if their
long side runs the other way) and stand on the floor by their bounds. Cubicles, rug piles and cars
match the collider height exactly (you stand on them); the others keep within 15 % of their own
proportions. Stumps stay procedural. ≤ 6k triangles each.

| File | Kind | Collider (L x W x H) |
|---|---|---|
| `models/obstacles/market_stall.glb` | `stall` | 2.6 x 1.8 x 2.4 m |
| `models/obstacles/rug_pile.glb` | `rugs` | 1.9 x 1.6 x 1.0 m |
| `models/obstacles/parked_car.glb` | `car` | 4.2 x 1.8 m; hood 0.95 m, cabin 1.4 m |
| `models/obstacles/food_truck.glb` | `truck` | 5.6 x 2.6 x 3.0 m |
| `models/obstacles/dumpster.glb` | `dumpster` | 1.9 x 1.2 x 1.3 m (a raised lid may rise above) |
| `models/obstacles/rock_outcrop.glb` | `rockA`, `rockB` | the bounds of two cylinders/boxes, ~4.4 x 3.5 x 3.0-3.6 m |

## Arena environments

Every theme has the same five slots under `textures/themes/<theme>/` and `models/themes/<theme>/`
(declared in `THEME_ASSETS` in `src/assets/manifest.ts`). The default `moonlit` theme uses the
assets in the next sections.

| File | Spec |
|---|---|
| `textures/themes/<theme>/floor.jpg` | Square, top-down circular arena floor filling the image edge to edge (mapped onto a disc). |
| `textures/themes/<theme>/sky.jpg` | 2:1 equirectangular sky panorama. |
| `textures/themes/<theme>/stone.jpg` | Square, seamless tileable surface for the wall and placeholder pillars. |
| `models/themes/<theme>/pillar.glb` | Cover column ≤ 5k triangles, fitted to 5.5 m; collision is a ~1.7 m wide cylinder, so keep it column-shaped. **Office (cubicle layout):** one cubicle, ≤ 5k triangles, square footprint, centred, front facing +X like other Tripo exports; it is scaled per axis to the box collider: 2.2 x 2.2 m footprint, 1.3 m tall (partitions plus whatever is inside). Collision is the solid box, so keep the walls on the footprint's edges. The cabinets, copiers and water coolers in the office layout and every crumbled desk stump stay procedural. |
| `models/themes/<theme>/prop.glb` | Decorative set piece placed 8 times, 8 m outside the wall, ≤ 8k triangles, fitted to the theme's prop height (5 m; void 6 m, city palm 9 m, office 1.35 m). |

| Theme | Mood |
|---|---|
| `grove` | Twilight enchanted forest glade: mossy flagstones, roots, fireflies, green-gold spirit fire. |
| `volcano` | Basalt arena over lava: glowing magma cracks, ash-red sky, erupting volcano. |
| `glacier` | Frozen arena: ice-glazed stone, aurora night sky, lilac frost runes. |
| `desert` | Sandstone ruins at golden dusk: turquoise and gold inlays, dunes, obelisks. |
| `void` | Arena floating in a cosmic void: violet-black stone, green rune circuitry, nebula sky. |
| `city` | Los Angeles at sunset (Broccoli Head). Floor: a top-down asphalt intersection with crosswalk paint, curbs and a manhole. Sky: orange-pink-purple sunset over a skyline and palms, sun low in the +X direction of the panorama. Stone: concrete with pastel graffiti (tinted darker in game). Pillar: a graffiti concrete freeway column with a flared cap. Prop: a palm tree (fronds may be single-sided). Without files: a procedural intersection, a shader sunset with smog, skyline and palm silhouettes, graffiti columns, and code-built palms, storefronts, neon and city blocks outside the wall. |
| `office` | Government office (Glowie). Floor: grey-blue carpet tiles with a fictional eye-in-a-triangle emblem in the centre. Sky: an office-interior panorama (cubicle rows, fluorescent panels, blinds), horizon at mid-height; a procedural ceiling with light panels stays overhead and the procedural room walls are hidden while it is present. Stone: beige drywall over a fabric band and a baseboard (the 1.4 m ring wall shows it once vertically). Pillar: a cubicle (see the pillar row). Prop: filing cabinets with a water cooler. Without files: procedural carpet and emblem, room walls with blinds, ceiling troffers, columns, a cubicle farm, cabinets, coolers and plants. |

## Textures

| Key | File | Size | Description |
|---|---|---|---|
| `floor` | `textures/arena_floor.jpg` | 2048² | Top-down view of the whole circular arena floor. It is mapped onto a disc, so the design must be **circular and centred**, filling the square edge to edge. |
| `floorNormal` | `textures/arena_floor_normal.jpg` | 2048² | Optional normal map matching the floor. |
| `pillar` | `textures/pillar_stone.jpg` | 1024² | Tileable stone for placeholder pillars (only used if there is no pillar GLB). |
| `sky` | `textures/sky_night.jpg` | 4096×2048 | Equirectangular (2:1) 360° night sky panorama. Replaces the procedural sky. |
| `goldenTicket` | `textures/golden_ticket.png` | 1024×512 | Golden ticket pickup face, 2:1, transparent background around the ticket. Replaces the canvas-drawn face. |

**arena_floor**
> Top-down orthographic view of a circular ancient duelling arena floor, concentric rings of
> grey-violet flagstones, a glowing blue rune circle around the centre and a second ring of runes
> near the edge, worn cracks, scorch marks, hand-painted stylized game texture, perfectly centred
> circle filling the square, no perspective

**arena_floor_normal**: generate from the floor texture with any normal-map tool (Materialize,
NormalMap-Online) rather than a prompt.

**pillar_stone**
> Seamless tileable texture of weathered grey-violet stone blocks with thin mortar lines, subtle
> moss, hand-painted stylized game texture, flat lighting

**golden_ticket** (generated 16:9 on a dark background, then cut out and cropped to 2:1)
> An ornate shiny golden ticket filling almost the whole frame, wide horizontal ticket with notched
> corners, art-deco gold filigree border, the words GOLDEN TICKET in bold elegant engraved lettering
> centered, small stars, polished embossed gold foil, plain dark background, flat front view

**sky_night**
> 360 degree equirectangular panorama of a fantasy night sky, deep violet and indigo gradient, dense
> stars, a large pale moon, faint aurora, distant silhouetted mountains on the horizon, no ground
> objects in the centre, seamless left and right edges

## UI icons (optional)

Square PNG or WebP, transparent background, 256². Without these, built-in vector glyphs are used.

| Key | File | Prompt |
|---|---|---|
| `bolt` | `ui/icon_bolt.png` | Spell icon, crackling cyan lightning bolt, glowing, fantasy game UI, centred on transparent background |
| `blast` | `ui/icon_blast.png` | Spell icon, swirling violet energy orb with radiating sparks, fantasy game UI, transparent background |
| `shield` | `ui/icon_shield.png` | Spell icon, translucent teal hexagon-pattern magic barrier, fantasy game UI, transparent background |
| `stun` | `ui/icon_stun.png` | Spell icon, icy white-blue snowflake rune with frost, fantasy game UI, transparent background |
| `ultimate` | `ui/icon_ultimate.png` | Spell icon, golden starburst shockwave ring, radiant, fantasy game UI, transparent background |

Boss reward spells (`src/spells/rewardCatalog.ts`): round 256² icons with alpha, shown in the HUD's
second spell row, on the boss cards, in How to Play and on the "new spell learned" screen. Without
them, built-in vector glyphs are used.

| Spell | File | Prompt |
|---|---|---|
| Magic Carpet | `ui/spells/spell_carpet.png` | Round spell icon, a flying Persian carpet with gold tassels swooping on a trail of sparkles, warm orange glow |
| Pump It | `ui/spells/spell_pump.png` | Round spell icon, a green candlestick chart arrow shooting upward with gold coins, neon green glow |
| Vape Cloud | `ui/spells/spell_vape.png` | Round spell icon, a billowing lavender vapour cloud swirling out of a vape pen |
| Lock-On | `ui/spells/spell_lockon.png` | Round spell icon, a green targeting reticle with crosshair brackets locked on a glowing bolt |
| Hellfire Breath | `ui/spells/spell_breath.png` | Round spell icon, a cone of roaring hellfire bursting from a demon's mouth, deep orange and red |

## Sounds

MP3 or OGG preferred (WAV works). Keep effects short and dry: the game adds pitch variation,
distance falloff and stereo panning. Loops must start and end seamlessly.

| Key | File | Length | Prompt |
|---|---|---|---|
| `boltCast` | `audio/bolt_cast.mp3` | 0.15 s | Quick magical zap, bright electric snap with a short airy whoosh |
| `boltHit` | `audio/bolt_hit.mp3` | 0.25 s | Small magic impact, crisp crackle with a soft punchy thud |
| `fizzle` | `audio/fizzle.mp3` | 0.2 s | Spell fizzling out against stone, soft hissing sparkle |
| `blastCharge` | `audio/blast_charge.mp3` | 0.3 s | Rising magical charge-up hum, energy building fast |
| `blastCast` | `audio/blast_cast.mp3` | 0.4 s | Heavy magic orb launched, deep whoosh with a resonant hum |
| `blastExplode` | `audio/blast_explode.mp3` | 1 s | Powerful magical explosion, deep boom with crackling arcane debris |
| `shieldUp` | `audio/shield_up.mp3` | 0.5 s | Magic barrier snapping into place, shimmering glassy chime |
| `shieldBlock` | `audio/shield_block.mp3` | 0.4 s | Spell deflected off a magic shield, metallic ringing clang |
| `shieldPerfect` | `audio/shield_perfect.mp3` | 0.8 s | Perfectly timed magic parry, bright triumphant bell strike with a sparkling ring-out |
| `stunCharge` | `audio/stun_charge.mp3` | 0.25 s | Freezing spell charging, crackling frost with a rising tone |
| `stunBeam` | `audio/stun_beam.mp3` | 0.4 s | Ice beam fired, sharp crystalline zap with a cold hiss |
| `stunHit` | `audio/stun_hit.mp3` | 0.6 s | Target freezing solid, ice crackling and crystallizing quickly |
| `ultReady` | `audio/ult_ready.mp3` | 0.7 s | Ultimate power ready notification, rising magical arpeggio chime |
| `ultCharge` | `audio/ult_charge.mp3` | 0.45 s | Massive magic power gathering, deep rumbling swell rising sharply |
| `ultWave` | `audio/ult_wave.mp3` | 1.8 s | Enormous arcane shockwave released, earth-shaking boom with a sweeping wind blast |
| `clash` | `audio/clash.mp3` | 0.6 s | Two spells colliding mid-air, explosive crack with clashing metallic resonance |
| `dodge` | `audio/dodge.mp3` | 0.3 s | Quick dodge roll, cloth whoosh and a light thump |
| `hurt` | `audio/hurt.mp3` | 0.3 s | Wizard hit by magic, short pained grunt with a soft impact |
| `noMana` | `audio/no_mana.mp3` | 0.2 s | Spell failing from lack of mana, dull muted puff |
| `pillarHit` | `audio/pillar_hit.mp3` | 0.25 s | Magic striking a stone pillar, rocky knock with small chips |
| `pillarCrumble` | `audio/pillar_crumble.mp3` | 1.5 s | Stone column collapsing, heavy crumbling rocks and rumbling |
| `fireBurn` | `audio/fire_burn.mp3` | 0.35 s | Magic fire burn, sharp sizzle and crackle |
| `fireLoop` | `audio/fire_loop.mp3` | 4 s, loop | Ring of magical fire, steady crackling flames ambience, seamless loop |
| `countdown` | `audio/countdown.mp3` | 0.2 s | Round countdown tick, clean mystical beep |
| `roundStart` | `audio/round_start.mp3` | 1.8 s | Duel begins, deep resonant gong strike |
| `roundWin` | `audio/round_win.mp3` | 0.9 s | Round won, short bright rising fanfare |
| `roundLose` | `audio/round_lose.mp3` | 1 s | Round lost, short descending minor phrase |
| `victory` | `audio/victory.mp3` | 2.2 s | Match victory, heroic orchestral fantasy fanfare |
| `defeat` | `audio/defeat.mp3` | 2.2 s | Match defeat, somber low strings and fading choir |
| `uiHover` | `audio/ui_hover.mp3` | 0.05 s | Subtle magical UI hover tick |
| `uiClick` | `audio/ui_click.mp3` | 0.1 s | Magical UI button click, soft chime |
| `gunshot` | `audio/gunshot.mp3` | 0.4 s | Single pistol gunshot, sharp crack with a short punchy tail (Glowie's bullets) |
| `grenadeThump` | `audio/grenade_thump.mp3` | 0.45 s | Grenade launcher firing, hollow low thoomp with a metallic click |
| `rugWhoosh` | `audio/rug_whoosh.mp3` | 0.4 s | Heavy rug thrown through the air, cloth whoosh with a quick flap (rugs, flying carpets) |
| `phoneBlip` | `audio/phone_blip.mp3` | 0.3 s | Smartphone notification blip, two quick bright tones over a buzz |
| `pigOink` | `audio/pig_oink.mp3` | 0.4 s | Cartoon pig oink rising into a short squeal |
| `veggieCrunch` | `audio/veggie_crunch.mp3` | 0.35 s | Squelchy crunch of fresh broccoli being torn, wet and crisp |
| `fireRoar` | `audio/fire_roar.mp3` | 0.7 s | Fireball whoomp, roaring flame burst with crackles (hellfire, burning skulls) |
| `ticketSpawn` | `audio/ticket_spawn.mp3` | 0.8 s | A golden ticket appearing, soft single bell ding with a short sparkle |
| `ticketPickup` | `audio/ticket_pickup.mp3` | 1.3 s | Golden ticket collected, bright rising magical chime arpeggio with a shimmering tail |
| `ticketExpire` | `audio/ticket_expire.mp3` | 0.7 s | Magic fading away, soft falling tone (a ticket vanishing, or your mana boost running out) |
| `carpetWhoosh` | `audio/carpet_whoosh.mp3` | 0.9 s | A magic carpet swooping into the air, big cloth whoosh and flap with a rising shimmer |
| `pumpCoin` | `audio/pump_coin.mp3` | 1 s | Cash register ka-ching followed by a rising synth sweep, "number go up" |
| `vapePuff` | `audio/vape_puff.mp3` | 1.1 s | A long breathy exhale, a thick cloud of vapour blooming and hanging in the air |
| `lockBeep` | `audio/lock_beep.mp3` | 0.75 s | Targeting system acquiring a lock, beeps speeding up into a solid lock tone |
| `breathRoar` | `audio/breath_roar.mp3` | 2.3 s | A demon breathing fire for two seconds, whoomp then roaring flames with crackles, fading tail |
| `spellLearned` | `audio/spell_learned.mp3` | 2.2 s | A new spell learned, triumphant magical arpeggio into a held shimmering chord |
| `musicMenu` | `audio/music_menu.mp3` | 30-90 s, loop | Mysterious fantasy menu music, slow ethereal pads, distant choir, harp, A minor, seamless loop |
| `musicBattle` | `audio/music_battle.mp3` | 60-120 s, loop | Intense fantasy duel battle music, driving percussion, staccato strings, 120 BPM, D minor, seamless loop |

Volumes are set per sound in `src/assets/manifest.ts` (`volume`), and globally in the in-game
Settings. To regenerate the placeholders after changing the synth script: `npm run gen:audio`.

## Spell effects

Spell visuals (bolts, orbs, shield bubble, stun beam, ultimate wave, fire ring, sparks, smoke,
debris, and the muzzle effects at each caster's staff, phones, vape, gun, hand and mouth) are
particle systems and shaders written in code, as requested. They are not assets and
need nothing from Higgsfield. Their colours come from `CONFIG.teams` in `src/config.ts`.
The bosses' thrown objects (rugs, carpets, phones, pigs, broccoli, bullets, grenades, hellfire,
burning skulls) are low-poly meshes built in code too (`src/spells/ProjectileSkins.ts`), with
canvas-painted textures in each boss's palette.
