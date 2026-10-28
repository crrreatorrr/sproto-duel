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
| `clips` | Wizard animation names inside the GLB (case-insensitive, substrings OK). |

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

### Wizard animations (optional but recommended)

Higgsfield 3D outputs are usually static meshes. Without animation clips the game animates wizards
procedurally (lean, bob, roll, cast thrust, topple), so a static model already works. For full
animation:

1. Upload the GLB to [Mixamo](https://www.mixamo.com) and auto-rig it.
2. Download these animations (FBX, "with skin" for the first one, "without skin" for the rest):
   Idle, Running, Standing 1H Magic Attack (cast), Standing 2H Magic Area Attack (big cast),
   Sprinting Forward Roll, Hit Reaction, Dizzy (stunned), Victory, Dying.
3. Combine them in Blender into one GLB. Name the actions to match the manifest `clips`: `idle`,
   `run`, `cast`, `cast_big`, `roll`, `hit`, `stun`, `victory`, `defeat` (or edit `clips` to match
   your names).

### Shrinking files

Generated GLBs are often heavy. Before dropping them in:

```bash
npx @gltf-transform/cli optimize input.glb public/assets/models/wizard_player.glb --compress meshopt --texture-compress webp --texture-size 2048 --simplify-ratio 0.5
```

Meshopt-compressed GLBs load natively. If a model is still over budget, lower `--simplify-ratio`.

## Campaign bosses

The Boss Gauntlet has five bosses, easiest first (roster and tuning in `src/campaign/levels.ts`).
Each has a model and a portrait; the first batch was generated with Higgsfield (concept image with
`gpt_image_2_5`, then `tripo_h3_1_image_to_3d`). Regenerate any of them by replacing the file.

| Boss | Model | Portrait | Arena theme |
|---|---|---|---|
| 1. Bramble, the Hedge Witch | `models/bosses/bramble.glb` (2.0 m) | `ui/bosses/bramble.png` | `grove` |
| 2. Cinder, the Ember Adept | `models/bosses/cinder.glb` (2.0 m) | `ui/bosses/cinder.png` | `volcano` |
| 3. Ysolde, the Frost Warden | `models/bosses/ysolde.glb` (2.1 m) | `ui/bosses/ysolde.png` | `glacier` |
| 4. Khepri, the Sand Magus | `models/bosses/khepri.glb` (2.2 m) | `ui/bosses/khepri.png` | `desert` |
| 5. Morvane, the Archlich | `models/bosses/morvane.glb` (2.5 m) | `ui/bosses/morvane.png` | `void` |

Boss models are static meshes (the game animates them procedurally), ≤ 9k triangles. Generate the
concept in a natural spell-casting stance rather than a T-pose, since there is no rig: whole body,
front view, plain background.

## Arena environments

Every theme has the same five slots under `textures/themes/<theme>/` and `models/themes/<theme>/`
(declared in `THEME_ASSETS` in `src/assets/manifest.ts`). The default `moonlit` theme uses the
assets in the next sections.

| File | Spec |
|---|---|
| `textures/themes/<theme>/floor.jpg` | Square, top-down circular arena floor filling the image edge to edge (mapped onto a disc). |
| `textures/themes/<theme>/sky.jpg` | 2:1 equirectangular sky panorama. |
| `textures/themes/<theme>/stone.jpg` | Square, seamless tileable surface for the wall and placeholder pillars. |
| `models/themes/<theme>/pillar.glb` | Cover column ≤ 5k triangles, fitted to 5.5 m; collision is a ~1.7 m wide cylinder, so keep it column-shaped. |
| `models/themes/<theme>/prop.glb` | Decorative set piece placed 8 times, 8 m outside the wall, ≤ 8k triangles. |

| Theme | Mood |
|---|---|
| `grove` | Twilight enchanted forest glade: mossy flagstones, roots, fireflies, green-gold spirit fire. |
| `volcano` | Basalt arena over lava: glowing magma cracks, ash-red sky, erupting volcano. |
| `glacier` | Frozen arena: ice-glazed stone, aurora night sky, lilac frost runes. |
| `desert` | Sandstone ruins at golden dusk: turquoise and gold inlays, dunes, obelisks. |
| `void` | Arena floating in a cosmic void: violet-black stone, green rune circuitry, nebula sky. |

## Textures

| Key | File | Size | Description |
|---|---|---|---|
| `floor` | `textures/arena_floor.jpg` | 2048² | Top-down view of the whole circular arena floor. It is mapped onto a disc, so the design must be **circular and centred**, filling the square edge to edge. |
| `floorNormal` | `textures/arena_floor_normal.jpg` | 2048² | Optional normal map matching the floor. |
| `pillar` | `textures/pillar_stone.jpg` | 1024² | Tileable stone for placeholder pillars (only used if there is no pillar GLB). |
| `sky` | `textures/sky_night.jpg` | 4096×2048 | Equirectangular (2:1) 360° night sky panorama. Replaces the procedural sky. |

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
| `musicMenu` | `audio/music_menu.mp3` | 30-90 s, loop | Mysterious fantasy menu music, slow ethereal pads, distant choir, harp, A minor, seamless loop |
| `musicBattle` | `audio/music_battle.mp3` | 60-120 s, loop | Intense fantasy duel battle music, driving percussion, staccato strings, 120 BPM, D minor, seamless loop |

Volumes are set per sound in `src/assets/manifest.ts` (`volume`), and globally in the in-game
Settings. To regenerate the placeholders after changing the synth script: `npm run gen:audio`.

## Spell effects

Spell visuals (bolts, orbs, shield bubble, stun beam, ultimate wave, fire ring, sparks, smoke,
debris) are particle systems and shaders written in code, as requested. They are not assets and
need nothing from Higgsfield. Their colours come from `CONFIG.teams` in `src/config.ts`.
