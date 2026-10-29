/**
 * Every tuning number in the game lives here. Change values and the dev server hot-reloads.
 * Units: meters, seconds, degrees only where noted. Damage is in HP.
 */

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface AIProfile {
  label: string;
  /** Seconds before the AI notices a new threat (incoming projectile, windup). */
  reactionTime: number;
  /** Radians of random aim error. */
  aimError: number;
  /** 0 = aims where you are, 1 = perfectly leads your movement. */
  leadFactor: number;
  /** Chance to react to a threat at all (per threat). */
  dodgeChance: number;
  /** When reacting, chance to shield instead of rolling. */
  shieldPreference: number;
  /** Chance a shield is timed inside the perfect-reflect window. */
  perfectShieldChance: number;
  /** Bolts per attack burst [min, max]. */
  burst: [number, number];
  /** Pause between bursts [min, max] seconds. */
  burstPause: [number, number];
  /** Chance per attack decision to throw a Blast when it is ready. */
  blastChance: number;
  /** Chance per attack decision to use Stun when it is ready. */
  stunChance: number;
  /** Chance to punish a missed Blast/Ultimate or a stunned player. */
  punishChance: number;
  /** Multiplier on wizard move speed while strafing. */
  strafeSpeed: number;
  /** Preferred distance band to the player. */
  preferredRange: [number, number];
  /**
   * Hops per second while strafing. Unset: derived from dodgeChance (CONFIG.wizard.jump.aiHopRate,
   * none at or below aiHopMinSkill). Set it for a jumpy fighter regardless of skill.
   */
  hopRate?: number;
}

/** One solid piece of an obstacle's collider, in the obstacle's own (unturned) frame. */
export interface ColliderPartDef {
  shape: 'box' | 'cylinder';
  /** Centre offset (m). */
  x?: number;
  z?: number;
  /** Box half extents, or cylinder radius. */
  halfX?: number;
  halfZ?: number;
  radius?: number;
  /** Extra yaw of a box part (radians). */
  yaw?: number;
  /** Bottom (default 0, the floor) and top of the part (m). A part with y0 > 0 is a roof you can walk under. */
  y0?: number;
  height: number;
}

/**
 * An obstacle type: its collider, toughness and behaviour. Low cover (height under ~1.3 m) can be
 * jumped onto (apex 1.40 m); chest-height bolts fly over anything below ~1.05 m.
 */
export interface ObstacleDef {
  parts: ColliderPartDef[];
  /** Health; 0 = indestructible (spells chip it, it never breaks). */
  hp: number;
  /** Collider left after a crumble (0 = nothing, e.g. shattered glass). */
  stumpHeight: number;
  /** Tall and wide enough to hide behind: the AI picks cover among these. */
  cover: boolean;
  /** Transparent: blocks spells but not sight (glass). */
  seeThrough?: boolean;
  /** Casts shadows (off for small, low pieces to save draw calls). */
  shadow?: boolean;
}

/** Where a layout puts one obstacle. */
export interface LayoutEntry {
  kind: string;
  x: number;
  z: number;
  /** Yaw in quarter turns (or `yaw` in radians). */
  turn?: number;
  yaw?: number;
  /** Override the type's height (candlestick bars). */
  height?: number;
  /**
   * 'quad' (default): mirrored into all four quadrants; 'point': also at (-x, -z); 'none': once.
   * Both spawns sit on the z axis, so mirrored layouts are fair.
   */
  mirror?: 'quad' | 'point' | 'none';
  /** Moving cover: slides back and forth along `axis` over `span` metres (centred on x/z) at `speed` m/s. */
  move?: { axis: 'x' | 'z'; span: number; speed: number; /** Start position along the rail, -1..1. */ start: number };
}

/** Soft cover: a drifting volume that hides wizards from the AI but stops nothing. */
export interface SoftZoneDef {
  x: number;
  z: number;
  radius: number;
  height: number;
  /** Drift: a slow circle of this radius, one lap per `period` seconds. */
  drift: number;
  period: number;
  mirror?: 'point' | 'none';
}

/** A floor hazard (lava pool) that burns anyone standing in it. */
export interface HazardDef {
  x: number;
  z: number;
  radius: number;
  mirror?: 'quad' | 'point' | 'x' | 'z' | 'none';
}

export interface LayoutDef {
  entries: LayoutEntry[];
  soft?: SoftZoneDef[];
  hazards?: HazardDef[];
}

export const CONFIG = {
  render: {
    maxPixelRatio: 1.5,
    bloom: true,
    bloomStrength: 0.85,
    bloomRadius: 0.5,
    bloomThreshold: 0.78,
    shadows: true,
    shadowMapSize: 2048,
    exposure: 1.0,
    /** Fog distances in meters; themes scale them (ArenaTheme.fog). */
    fogNear: 47,
    fogFar: 132,
    /** Menu orbit camera: radius and height around the arena centre. */
    orbitRadius: 17,
    orbitHeight: 8,
  },

  sim: {
    fixedDt: 1 / 60,
    maxStepsPerFrame: 4,
  },

  match: {
    roundsToWin: 2, // best of 3
    roundTime: 80,
    introTime: 2.4,
    roundEndTime: 3.2,
    /** Ultimate charge carries between rounds (like a fighting-game super meter). */
    ultCarriesOver: true,
  },

  arena: {
    floorRadius: 36,
    /** Hard collision wall behind the fire. */
    wallRadius: 30,
    /** Inner edge of the fire ring. Touching it burns. */
    fireRadius: 27.8,
    fireWidth: 1.8,
    fireDps: 26,
    fireTickInterval: 0.25,
    /** Inward knockback speed applied while burning. */
    firePush: 11,
    /** Seconds left on the clock when the fire ring starts closing in. */
    suddenDeathAt: 30,
    suddenDeathMinRadius: 9,
    spawnDistance: 16,
    /** Fire-bowl braziers standing on the wall. */
    braziers: 10,
    pillars: {
      /**
       * Cover layout: rings of pillars around the centre. `offset` rotates a ring by a fraction of
       * one step; the inner ring's half step keeps the spawn line (z axis) clear.
       */
      rings: [
        { count: 6, radius: 10.5, offset: 0.5 },
        { count: 8, radius: 20, offset: 0 },
      ],
      radius: 0.85,
      height: 5.5,
      hp: 70,
      /** Damage multiplier for spells hitting pillars. */
      spellDamageMultiplier: 1.0,
    },
    /**
     * Office cover (themes with `layout: 'cubicles'`): a grid of cubicles with aisles replaces the
     * pillar rings. Cubicles are square boxes. Their 1.3 m partitions stop chest-height bolts
     * (chest 1.2 m, wand 1.36 m) and line of sight, yet sit below the 1.40 m jump apex, so a wizard
     * can hop onto one. Entries are for the +x/+z quadrant and are mirrored into the other three, so
     * both spawns (on the z axis) see the same cover; `turn` is a yaw in quarter turns.
     */
    cubicles: {
      size: 2.2,
      height: 1.3,
      /** What's left after a crumble: the desk and partition stubs (blocks walking; bolts fly over). */
      stumpHeight: 0.78,
      /** Tougher than a pillar (70): a cubicle is a much bigger target for stray bolts. */
      hp: 90,
      quadrant: [
        // Inner pods flanking the centre aisle (each mirrors into a 2.2 x 4.4 m back-to-back pair).
        { x: 5.6, z: 1.1, turn: 0 },
        // Diagonal cover beside each spawn.
        { x: 9.2, z: 9.0, turn: 1 },
        // Behind each spawn, off the spawn line.
        { x: 3.6, z: 15.2, turn: 2 },
        // Flanks.
        { x: 15.6, z: 3.4, turn: 3 },
      ],
      /** Smaller obstructions (same quadrant mirroring). Only `cover` ones are tall enough to hide behind. */
      obstructions: [
        { kind: 'cabinet', x: 18.4, z: 10.0, turn: 1 },
        { kind: 'copier', x: 11.6, z: 17.8, turn: 0 },
        { kind: 'cooler', x: 0, z: 12.5, turn: 0 },
        // Glass office partitions: see-through, stop spells, shatter after a few hits.
        { kind: 'glass', x: 10.6, z: 4.6, turn: 0 },
      ] as { kind: 'cabinet' | 'copier' | 'cooler' | 'glass'; x: number; z: number; turn: number }[],
      /** A glass partition: 2.4 m wide, 2.1 m tall. Breaks after `hp` damage (3 bolts). */
      glass: { halfX: 1.2, halfZ: 0.06, height: 2.1, stumpHeight: 0, hp: 12, cover: false },
      /** A bank of three lateral filing cabinets. */
      cabinet: { halfX: 1.05, halfZ: 0.32, height: 1.25, stumpHeight: 0.45, hp: 55, cover: true },
      copier: { halfX: 0.55, halfZ: 0.4, height: 1.1, stumpHeight: 0.5, hp: 40, cover: false },
      /** Water cooler (a short cylinder). */
      cooler: { radius: 0.3, height: 1.35, stumpHeight: 0.4, hp: 25, cover: false },
      /** Height of the office ceiling (well above the menu orbit and any jump camera). */
      ceilingHeight: 12,
    },
    /** Lava pools (volcano): burn per second while standing in one (feet on the floor). */
    lavaDps: 22,
    /** The AI keeps this far from the edge of a lava pool. */
    lavaMargin: 1.2,
    /** Golden tickets keep this far from hazards, vape clouds and mover rails. */
    pickupZoneMargin: 1.0,

    /**
     * Obstacle types for the boss arenas (layouts below). Every type: collider parts, hp
     * (0 = indestructible), stump left behind, cover (the AI hides behind it), see-through, shadow.
     */
    obstacles: {
      // ---- The Grand Bazaar (Sahil)
      /** Market stall: wooden frame, striped awning, counter. Full cover. */
      stall: { parts: [{ shape: 'box', halfX: 1.3, halfZ: 0.9, height: 2.4 }], hp: 90, stumpHeight: 0.9, cover: true, shadow: true },
      /** A pile of rugs: low cover you can hop onto; soft, so it never breaks. */
      rugs: { parts: [{ shape: 'box', halfX: 0.95, halfZ: 0.8, height: 1.0 }], hp: 0, stumpHeight: 0, cover: false },
      /** Wooden hand cart with goods. */
      cart: { parts: [{ shape: 'box', halfX: 0.85, halfZ: 0.55, height: 1.1 }], hp: 40, stumpHeight: 0.45, cover: false, shadow: true },
      /** Cluster of clay pots (shatters easily). */
      pots: { parts: [{ shape: 'cylinder', radius: 0.62, height: 0.85 }], hp: 15, stumpHeight: 0.25, cover: false },
      // ---- The Blockchain Void (Bitcoin Obama)
      /** Candlestick-chart bar (height set per placement, 1-4.5 m; low ones are jumpable). */
      candle: { parts: [{ shape: 'box', halfX: 0.45, halfZ: 0.45, height: 3 }], hp: 60, stumpHeight: 0.6, cover: true, shadow: true },
      /** A "block": an obsidian cube. Some are chained together, some slide on rails. */
      block: { parts: [{ shape: 'box', halfX: 0.9, halfZ: 0.9, height: 1.8 }], hp: 0, stumpHeight: 0, cover: true, shadow: true },
      // ---- Los Angeles (Broccoli Head)
      /** Parked car: hood/trunk 0.95 m, cabin 1.4 m (hop onto the hood, then the roof). */
      car: {
        parts: [{ shape: 'box', halfX: 2.1, halfZ: 0.9, height: 0.95 }, { shape: 'box', x: -0.2, halfX: 1.1, halfZ: 0.85, height: 1.4 }],
        hp: 110, stumpHeight: 0.6, cover: true, shadow: true,
      },
      /** Food truck: big cover. */
      truck: { parts: [{ shape: 'box', halfX: 2.8, halfZ: 1.3, height: 3.0 }], hp: 160, stumpHeight: 1.0, cover: true, shadow: true },
      dumpster: { parts: [{ shape: 'box', halfX: 0.95, halfZ: 0.6, height: 1.3 }], hp: 70, stumpHeight: 0.55, cover: true, shadow: true },
      /** Bus-stop shelter: ad panel and side panel, a roof you can stand under, a bench. */
      shelter: {
        parts: [
          { shape: 'box', z: -0.62, halfX: 1.6, halfZ: 0.08, height: 2.3 },
          { shape: 'box', x: 1.52, z: -0.1, halfX: 0.08, halfZ: 0.6, height: 2.3 },
          { shape: 'box', halfX: 1.7, halfZ: 0.75, y0: 2.3, height: 2.45 },
        ],
        hp: 60, stumpHeight: 0.45, cover: true, shadow: true,
      },
      /** Round concrete planter with a palm (the trunk is solid too). */
      planter: {
        parts: [{ shape: 'cylinder', radius: 1.0, height: 0.8 }, { shape: 'cylinder', radius: 0.22, height: 7 }],
        hp: 0, stumpHeight: 0, cover: false, shadow: true,
      },
      // ---- Hellfire Caldera (Tinubu)
      /** Basalt outcrops: irregular compound rock, big permanent cover. */
      rockA: {
        parts: [{ shape: 'cylinder', radius: 1.7, height: 3.0 }, { shape: 'cylinder', x: 1.6, z: 0.7, radius: 1.1, height: 2.0 }],
        hp: 0, stumpHeight: 0, cover: true, shadow: true,
      },
      rockB: {
        parts: [{ shape: 'box', halfX: 1.5, halfZ: 1.0, yaw: 0.4, height: 2.6 }, { shape: 'cylinder', x: -1.2, z: 0.4, radius: 1.0, height: 3.6 }],
        hp: 0, stumpHeight: 0, cover: true, shadow: true,
      },
      /** A broken basalt column. */
      ruin: { parts: [{ shape: 'cylinder', radius: 0.85, height: 3.0 }], hp: 70, stumpHeight: 0.9, cover: true, shadow: true },
    } satisfies Record<string, ObstacleDef>,

    /**
     * Boss-arena layouts (themes pick one with `layout`). Spawns are at (0, +-spawnDistance/2):
     * every layout keeps that line clear and the ring between 24.8 m and the fire free.
     * The first entry of each layout is tall, destructible cover (QA relies on it).
     */
    layouts: {
      /** Sahil's Grand Bazaar: two rows of stalls each side of a central street, rug piles in the alleys. */
      bazaar: {
        entries: [
          { kind: 'stall', x: 6.2, z: 2.4, turn: 3 },
          { kind: 'stall', x: 6.2, z: 8.2, turn: 3 },
          { kind: 'stall', x: 12.6, z: 4.8, turn: 3 },
          { kind: 'stall', x: 12.6, z: 11.0, turn: 3 },
          { kind: 'rugs', x: 9.4, z: 0, turn: 1 },
          { kind: 'rugs', x: 3.2, z: 13.0, turn: 0 },
          { kind: 'rugs', x: 18.5, z: 5.5, turn: 1 },
          { kind: 'cart', x: 9.4, z: 14.8, turn: 0 },
          { kind: 'pots', x: 2.8, z: 4.6 },
        ],
      },
      /** Bitcoin Obama's Blockchain Void: candlestick bars, chained blocks, blocks sliding on rails. */
      exchange: {
        entries: [
          { kind: 'candle', x: 5.2, z: 1.3, height: 4.5 },
          { kind: 'candle', x: 9.6, z: 6.6, height: 1.05 },
          { kind: 'candle', x: 7.4, z: 12.8, height: 3.4 },
          { kind: 'candle', x: 14.6, z: 2.4, height: 2.2 },
          { kind: 'block', x: 11.5, z: 13.5, turn: 0 },
          { kind: 'block', x: 16.0, z: 9.0, turn: 0 },
          { kind: 'block', x: 0, z: 4.2, mirror: 'point', move: { axis: 'x', span: 15, speed: 1.2, start: -1 } },
          { kind: 'block', x: 17.5, z: 0, mirror: 'point', move: { axis: 'z', span: 12, speed: 1.0, start: -1 } },
        ],
      },
      /** Broccoli Head's Los Angeles: parked cars, a food truck, dumpsters, a bus stop, palm planters, two freeway columns, vape clouds. */
      streets: {
        entries: [
          { kind: 'pillar', x: 9.5, z: 9.5, mirror: 'point' },
          { kind: 'car', x: 4.8, z: 13.5, turn: 1 },
          { kind: 'car', x: 13.5, z: 4.6, turn: 0 },
          { kind: 'truck', x: 15.0, z: -11.0, turn: 0, mirror: 'point' },
          { kind: 'dumpster', x: 10.5, z: 17.5, turn: 0 },
          { kind: 'shelter', x: 8.5, z: -4.0, turn: 1, mirror: 'point' },
          { kind: 'planter', x: 4.8, z: 4.8 },
        ],
        soft: [
          { x: 0, z: 0, radius: 2.4, height: 3.2, drift: 3.5, period: 46, mirror: 'none' },
          { x: 12.5, z: -3.5, radius: 2.2, height: 3.0, drift: 2.5, period: 38, mirror: 'point' },
        ],
      },
      /** Tinubu's Hellfire Caldera: basalt outcrops, broken columns and lava pools. */
      caldera: {
        entries: [
          { kind: 'ruin', x: 3.6, z: 0, mirror: 'quad' },
          { kind: 'ruin', x: 14.5, z: 12.0 },
          { kind: 'rockA', x: 9.0, z: 5.5, turn: 0 },
          { kind: 'rockB', x: 5.5, z: 14.5, turn: 0 },
        ],
        hazards: [
          { x: 13.5, z: 0, radius: 2.6, mirror: 'x' },
          { x: 0, z: 15.5, radius: 2.4, mirror: 'z' },
        ],
      },
    } satisfies Record<string, LayoutDef>,
  },

  wizard: {
    radius: 0.42,
    height: 1.85,
    maxHealth: 220,
    maxMana: 100,
    manaRegen: 13,
    /** Seconds after spending mana before regen resumes. */
    manaRegenDelay: 0.3,
    moveSpeed: 6.6,
    sprintSpeed: 9.6,
    sprintManaPerSecond: 10,
    /** After running dry, sprint needs this much mana before it re-engages. */
    sprintRecoverMana: 18,
    acceleration: 75,
    deceleration: 60,
    /** Speed multiplier during a spell windup. */
    castMoveMultiplier: 0.55,
    knockbackDamping: 7.5,
    hitFlashTime: 0.09,
    /**
     * The hit flash on a wizard's look (WizardVisual): an emissive pulse in the wizard's own spell
     * colour (`white` of white mixed in), peaking at `peak` (low enough that bloom never turns the
     * model into a white blob) and fading at `decay` per second. Rapid hits don't re-peak: each hit
     * adds `heatPerHit` heat (0..1, fading with time constant `heatTime` s), and a hot hit peaks
     * lower, down to `sustain` x `peak`, and between hits it fades toward that level while heat is
     * high (Hellfire Breath ticks plus bolts settle to a steady glow instead of strobing).
     */
    hitGlow: { peak: 0.6, white: 0.3, decay: 24, sustain: 0.45, heatPerHit: 0.55, heatTime: 0.45 },
    dodge: {
      speed: 16.5,
      duration: 0.34,
      iframes: 0.28,
      cooldown: 0.55,
    },
    jump: {
      /** Takeoff speed (m/s). Apex = velocity^2 / (2 * gravity), airtime = 2 * velocity / gravity. */
      velocity: 8.2,
      /** m/s^2. With velocity 8.2: a 1.4 m apex and 0.68 s in the air. */
      gravity: 24,
      maxFallSpeed: 22,
      /** Fraction of ground acceleration available for steering in the air. */
      airControl: 0.3,
      /** Fraction of ground deceleration applied in the air with no input, so momentum carries. */
      airBrake: 0.12,
      /** Seconds after walking off a ledge during which a jump still works. */
      coyoteTime: 0.1,
      /** Downward probe while standing on a raised surface (stump), to notice walking off it. */
      groundProbe: 0.05,
      /**
       * Feet at least this high above the ground as the Ultimate's wavefront passes: it goes underneath.
       * 1.05 gives a ~0.34 s window around the apex (a roll's i-frames last 0.28 s).
       */
      waveClearance: 1.05,
      /** Sideways speed that slides a wizard off the other wizard's head. */
      headSlide: 5,
      /** Visual stretch on takeoff and squash per m/s of landing speed (fractions of height). */
      takeoffStretch: 0.2,
      landSquash: 0.025,
      maxLandSquash: 0.32,
      /** Camera height follow: rises lazily (a jump doesn't yank the crosshair), falls with the player. */
      cameraRiseSharpness: 2.5,
      /** Most the camera may trail below the player's head height. */
      cameraMaxLag: 0.9,
      /** AI: share of Ultimate reactions that jump instead of roll, times profile.dodgeChance. */
      aiWaveJump: 0.7,
      /** AI: takeoff timing error (+/- s) on wave jumps at zero skill, shrinking with profile.dodgeChance. */
      aiWaveJumpError: 0.3,
      /** AI: hops per second while strafing at top skill; none at or below aiHopMinSkill (profile.dodgeChance). */
      aiHopRate: 0.3,
      aiHopMinSkill: 0.45,
    },
  },

  spells: {
    bolt: {
      damage: 4,
      speed: 52,
      radius: 0.16,
      manaCost: 5,
      cooldown: 0,
      /** Minimum time between bolts while holding fire. */
      fireInterval: 0.17,
      lifetime: 1.4,
      /** Clash strength: the bigger spell wins a mid-air collision. */
      power: 1,
      knockback: 2.4,
      hitStopMs: 40,
      shake: 0.25,
    },
    blast: {
      damage: 20,
      splashRadius: 3.6,
      /** Fraction of damage dealt at the edge of the splash. */
      splashFalloff: 0.35,
      speed: 20,
      radius: 0.5,
      manaCost: 24,
      cooldown: 3,
      castTime: 0.16,
      lifetime: 2.4,
      power: 4,
      knockback: 13,
      hitStopMs: 60,
      shake: 0.5,
    },
    shield: {
      duration: 0.8,
      cooldown: 5,
      manaCost: 12,
      /** Blocking within this many seconds of raising the shield is a perfect reflect. */
      perfectWindow: 0.2,
      radius: 1.25,
      reflectSpeedMultiplier: 1.35,
      reflectDamageMultiplier: 1.5,
      /** A non-perfect block deflects the spell away at reduced damage. */
      deflectDamageMultiplier: 0.5,
      perfectUltCharge: 10,
      hitStopMs: 55,
    },
    stun: {
      duration: 1.0,
      cooldown: 8,
      manaCost: 22,
      castTime: 0.2,
      range: 34,
      damage: 6,
      beamVisualTime: 0.3,
      hitStopMs: 60,
    },
    ultimate: {
      chargeMax: 100,
      chargePerDamageDealt: 0.5,
      chargePerDamageTaken: 0.2,
      castTime: 0.3,
      damage: 38,
      waveSpeed: 30,
      maxRadius: 40,
      /** Damage multiplier if the target is shielding when the wave hits. */
      shieldMultiplier: 0.35,
      pillarDamage: 45,
      knockback: 20,
      hitStopMs: 90,
    },
  },

  /**
   * Boss special powers (src/spells/BossPowers.ts, each boss's `powers` in levels.ts): telegraphed on
   * the floor, then they fire, then they recharge. Rolling (i-frames) evades any of them.
   */
  powers: {
    /** Recharge per stage a power is used in (stage 1, 2, 3): later stages recharge faster. */
    stageRecharge: [1, 0.85, 0.72] as [number, number, number],
    /** A stage's first use of each power comes after this share of its recharge. */
    firstDelay: 0.4,
    /** Every power's damage is scaled by this (balance against the boss's spells: README ladder). */
    damageScale: 0.4,
    /** Seconds between any two powers of the fight's bosses (a double fight takes turns). */
    gap: 4,
    /** A boss only starts a power with the target in sight (or a strike, barrage, cloud from the air). */
    needSight: true,
    /** A zone hits a wizard whose centre is within its radius plus this share of the wizard's radius. */
    zoneGrace: 0.5,
    /** Zones from above: what falls drops from this high (m) over the last `fallTime` s of the warning. */
    fallHeight: 14,
    fallTime: 0.45,
    /** Shockwave rings and the sweep are this tall (m): feet above `CONFIG.wizard.jump.waveClearance` clear them. */
    ringHeight: 0.8,
    sweepHeight: 0.55,
    /** Knockback from a zone, a ring, the sweep (m/s). The cone has its own. */
    knockback: { zone: 6, ring: 7, sweep: 6 },
    /** Damage ticks inside a toxic cloud (s) and the cloud's height (m). */
    cloudTick: 0.5,
    cloudHeight: 2.6,
    /** Seekers: hit radius (m), how long one that was rolled through can't hit (s), and pillar damage. */
    seekerRadius: 0.45,
    seekerPass: 0.45,
    seekerPillarDamage: 10,
    /** Infection (drain seekers): mana drained per hit. */
    drainMana: 45,
    /** Hit-stop on a power hit (ms) and the shake. */
    hitStopMs: 50,
    shake: 0.45,
    /** How an AI reads telegraphs (the soak's reference player; bosses never face powers): */
    ai: {
      /**
       * A telegraph shows for a second or so, so it is noticed more often than a fast projectile:
       * the profile's dodge chance plus this share of what's left (Adept: 0.5 -> 0.8).
       */
      notice: 0.6,
      /** It steers round a standing toxic cloud like lava, by this margin (m). */
      cloudMargin: 1,
      /** Extra metres it wants between itself and a zone's edge before it stops running. */
      zoneMargin: 0.8,
      /** It runs from a zone firing within this many seconds... */
      zoneHorizon: 1.6,
      /** ...and rolls out if it is still inside this close to the hit (s). */
      rollLead: 0.22,
      /** Rolls through a seeker this close (s away). */
      seekerLead: 0.25,
    },
  },

  /**
   * Arena shifts (src/arena/ArenaShifts.ts): each boss stage reshapes a Boss Gauntlet arena, in the
   * boss's own theme (levels.ts `shift`). Stage 2 opens hazard pools and one healing spring; stage 3
   * adds erupting vents. The fire ring pulls in a little each stage and the light turns toward the
   * boss's colour. They stay until the round ends; Quick Duel never shifts.
   */
  arenaShifts: {
    /** Fire ring radius per stage (stage 1 is CONFIG.arena.fireRadius); it eases in at `ringSpeed` m/s. */
    ringRadius: [27.8, 26.8, 25.5],
    ringSpeed: 0.9,
    /** Mood: how far the light and fog turn toward the boss's colour per stage, eased over `moodTime` s. */
    mood: [0, 0.16, 0.32],
    moodTime: 2.5,
    /** A new feature fades in (harmless, its outline blinking) for this long. */
    growTime: 1.8,
    /** Placement: clear of every wizard, cover, each other and the fire ring by these (m). */
    wizardClearance: 4,
    coverClearance: 1,
    spacing: 1.5,
    ringMargin: 3,
    /** Tries per feature before it is left out. */
    attempts: 200,
    pool: {
      count: 4,
      radius: [1.7, 2.3],
    },
    spring: {
      radius: 1.5,
      /**
       * Health per second to whoever stands in it, `charge` in all; then it is dry until the next
       * stage's shift fills it again (so it gives at most two fills a fight).
       */
      heal: 9,
      charge: 40,
    },
    vent: {
      count: 3,
      radius: 1.7,
      /** Seconds between eruptions (each vent starts at a random point of its cycle), and the warning before one. */
      period: [7, 9.5],
      warn: 1.3,
      /** Strong enough to throw someone standing in the middle clear of it. */
      knockback: 19,
    },
    /** Reference AI (the soak's player): heads for a spring below this health fraction, within this range. */
    aiSeekHealth: 0.6,
    aiSeekRange: 16,
  },

  /**
   * Boss reward spells (src/spells/RewardSpells.ts): beating a Boss Gauntlet boss teaches the player
   * its themed spell for good (Campaign `unlockedSpells`). Only the player ever learns them; bosses
   * never cast them. Cooldowns start on cast. Keys: CONFIG.controls / CONFIG.gamepad.bindings.
   */
  rewardSpells: {
    /** Sahil: ride a flying carpet. Fast, hovering (no lava or fire-ring burn), no casting. Press again to land early. */
    carpet: {
      duration: 3.5,
      cooldown: 12,
      manaCost: 20,
      /** Multiplies CONFIG.wizard.moveSpeed while riding (sprint does nothing more). */
      speedMultiplier: 2.2,
      /** Takeoff burst: this much more speed at summon, fading over `boostTime` s. */
      boost: 0.8,
      boostTime: 0.6,
      /**
       * Ram: flying into an enemy at more than `ramSpeed` m/s hits it once per ride for `ramDamage`
       * and knocks it back along the carpet's path (m/s), with this much hit-stop (ms).
       */
      ramSpeed: 8,
      ramDamage: 14,
      ramKnockback: 15,
      ramHitStopMs: 60,
      /** Jump while riding: leap off the carpet, `leap` x a normal jump's takeoff speed, keeping its speed. */
      leap: 1.35,
      acceleration: 70,
      deceleration: 40,
      /** Feet height above whatever is underneath (m). */
      hover: 0.45,
      /** Highest low cover (above what is underneath) the carpet rises over (m): rug piles, car hoods, carts. */
      climb: 1.15,
      /** Vertical speeds (m/s) toward the hover height: up over cover, down off it. */
      rise: 14,
      sink: 4,
      /** How far ahead to look for cover: radius + speed x this (s). */
      lookAhead: 0.24,
    },
    /** Bitcoin Obama & The Midget: a power surge. More spell damage and Ultimate charge. */
    pump: {
      duration: 6,
      cooldown: 20,
      manaCost: 25,
      damageMultiplier: 1.5,
      ultChargeMultiplier: 1.5,
    },
    /** Broccoli Head: a smoke screen at your feet. Hides you from enemy AIs (Arena.obscured); heals you inside. */
    vape: {
      duration: 6,
      cooldown: 22,
      manaCost: 0,
      /** 5 m across. */
      radius: 2.5,
      height: 3.2,
      /** HP per second while the caster stands inside its own cloud... */
      healPerSecond: 2,
      /** ...except for this long after it attacks from inside (Wizard.sinceAttack): no hiding and healing while shooting. */
      castHealPause: 1,
      /** Seconds the cloud takes to billow out, and to thin away at the end. */
      grow: 0.45,
      fade: 0.9,
    },
    /** Glowie: your bolts home in on the nearest enemy in front of you. */
    lockon: {
      duration: 6,
      cooldown: 20,
      manaCost: 0,
      /** Targets within this cone around your aim (full angle, degrees) and range (m). */
      coneDegrees: 70,
      range: 45,
      /** Homing turn rate (rad/s): gentle, so a strafe still has to be tracked and a roll still slips it. */
      turnRate: 2.4,
      /** A bolt stops homing once its target is this far behind its heading (degrees). */
      dropDegrees: 100,
    },
    /** Tinubu: channel a cone of fire from your staff. Burns while in the cone, and for a while after. */
    breath: {
      duration: 2,
      cooldown: 18,
      manaCost: 30,
      range: 6,
      /** Full cone angle (degrees); the target's body width counts too. */
      coneDegrees: 35,
      /** Damage per second while in the cone, applied every `tick` s. */
      dps: 16,
      tick: 0.25,
      /** The burning debuff a hit leaves: seconds (refreshed by each hit) and damage per second. */
      burnTime: 4,
      burnDps: 5,
      burnTick: 0.5,
      /** Move speed multiplier while channelling. */
      moveMultiplier: 0.35,
    },
    /** A callout over the caster on every cast (short name). */
    popups: true,
  },

  clash: {
    hitStopMs: 35,
    shake: 0.25,
    /** A surviving spell keeps this fraction of its speed after winning a clash. */
    winnerSpeedKeep: 0.85,
  },

  /**
   * Boss projectile looks (src/spells/ProjectileSkins.ts): code-built objects instead of the orb.
   * Purely visual, hitboxes stay each spell's `radius`. Object sizes are meters at full power;
   * clash-weakened spells shrink with their radius.
   */
  projectileSkins: {
    /** Instances per skin and team: the bolt plus blast pool, so a skin never runs out. */
    batchCapacity: 76,
    /** Size of the palette-coloured glow sprite kept behind objects, relative to the orb's glow. */
    glowScale: { bolt: 0.5, blast: 0.55 },
    /** Size of the palette-coloured trail motes behind objects, relative to the orb's trail. */
    trailScale: 0.6,
    /** Tumble/spin rates, radians per second. */
    spin: { rugRoll: 24, phone: 21, floret: 15, broccoli: 7, grenade: 11, pig: 4.5 },
    /** Pig: leg flail speed (rad/s) and swing (rad); the tail wags with them. */
    pig: { flailSpeed: 22, flailAngle: 0.75 },
    /** Bullet tracer streak: meters of streak per m/s of speed, clamped. */
    tracerPerSpeed: 0.045,
    tracerMax: 3,
    /**
     * Flying carpet: ripple amplitude (m), wavelength (m) and speed (rad/s); bank swing and the
     * raised front edge (rad), which keep its face readable to the player instead of edge-on.
     */
    carpet: { rippleAmp: 0.075, rippleLength: 0.85, rippleSpeed: 13, bank: 0.38, noseUp: 0.36 },
    /** Gunshot muzzle flash at the caster: sprite size (m), light intensity and duration (s). */
    muzzleFlash: { size: 1.5, light: 16, duration: 0.06 },
  },

  /**
   * Golden tickets (src/arena/GoldenTickets.ts): floating pickups that appear during the fight phase
   * of every round. Any wizard touching one gets a mana boost: a bigger mana pool, refilled at once,
   * and faster regen with no regen delay, for `boostDuration` seconds.
   */
  /**
   * How hard pickups (golden tickets, life packs) call for attention: their beam, halo and floor
   * glow are scaled by these, the beam widened, and a ring pulses out along the floor from each
   * every `pulseEvery` s (reaching `pulseRadius` m).
   */
  pickupHighlight: {
    beamOpacity: 1.6,
    beamWidth: 1.5,
    glowScale: 1.45,
    glowOpacity: 1.6,
    floorOpacity: 1.5,
    emissive: 1.8,
    pulseEvery: 1.3,
    pulseRadius: 2.6,
    pulseTime: 0.9,
  },

  tickets: {
    /** Most tickets on the floor at once. */
    maxActive: 3,
    /** Seconds into the fight before the first ticket of a round [min, max]. */
    firstSpawnDelay: [8, 12] as [number, number],
    /** Seconds until the next ticket appears while fewer than `maxActive` exist [min, max]. */
    spawnInterval: [6, 12] as [number, number],
    /**
     * The same in a Boss Gauntlet fight. Those last 15 minutes and more (one life, five-minute
     * stages), so tickets come less often there and the floor isn't always full of them.
     */
    bossSpawnInterval: [16, 30] as [number, number],
    /** Retry delay when no valid spot was found. */
    retryDelay: 0.5,
    /** Seconds an uncollected ticket stays; it blinks for the last `blinkTime` of them. */
    lifetime: 20,
    blinkTime: 3,
    /** Spawn spots: this far inside the fire ring, with this much free floor around them (physics query). */
    fireMargin: 3,
    obstacleClearance: 1.4,
    /** Spawn spots keep at least this far from every wizard and from other tickets. */
    minWizardDistance: 4,
    minTicketDistance: 4,
    /** Random spots tried per spawn. */
    spawnAttempts: 24,
    /** A ticket the fire ring reaches (sudden death) burns up once this close to its inner edge. */
    fireBurnMargin: 0.6,
    /** Pickup reach: horizontal distance (m), and the highest feet height that still collects (a jump off a stump). */
    pickupRadius: 1.2,
    pickupMaxHeight: 2.4,
    /** Look: card size (m), hover height of its centre, bob and spin. */
    width: 0.9,
    height: 0.45,
    hoverHeight: 1.3,
    bobAmplitude: 0.12,
    bobSpeed: 2.2,
    /** Radians per second. */
    spinSpeed: 1.7,
    /** Light beam above each ticket, so it reads from across the arena. */
    beamHeight: 11,
    /** Beam opacity multiplier per arena theme: warm skies swallow a pale-gold beam. */
    beamThemeBoost: { desert: 1.55, volcano: 1.45, city: 1.35 } as Partial<Record<string, number>>,
    /** Sparkles per second around a ticket and around a boosted wizard. */
    sparkleRate: 26,
    auraSparkleRate: 22,
    /** The mana boost. */
    boostDuration: 15,
    /** Max mana multiplier while boosted (100 -> 150). */
    maxManaMultiplier: 1.5,
    /** Regen multiplier while boosted. 1 keeps rounds in the 60-90 s target (2 shortened them to ~59 s). */
    regenMultiplier: 1,
    /** Seconds after spending mana before regen resumes while boosted (normally `wizard.manaRegenDelay`). */
    regenDelay: 0.3,
    /** AI: goes for a ticket within this range when safe and it is closer than the opponent is (or its mana is low). */
    aiSeekRange: 13,
    /** AI: mana fraction (of the normal max) below which any ticket in range is worth it. */
    aiLowMana: 0.45,
    /** AI: chance per check (every `aiCheckInterval` s) to commit to an eligible ticket. */
    aiSeekChance: 0.5,
    aiCheckInterval: 0.5,
    /** AI: seconds without reaching it before giving up; seconds after being hit that count as under fire. */
    aiGiveUpTime: 6,
    aiHurtMemory: 1.2,
  },

  /**
   * Life packs (src/arena/LifePacks.ts): health pickups in Boss Gauntlet fights, where you have one
   * life. At most `maxPerFight` appear over the whole fight (expired ones count), one at a time. A
   * pack is due `firstDelay` s into each boss stage, or sooner once your health is below `lowHealth`;
   * by stage N at most N packs have appeared, so they spread over the fight. Only the player can
   * collect one: it heals `heal` of max health (never above it).
   */
  lifePacks: {
    /** Quick Duel has none (best of three, full health every round). */
    quickDuel: false,
    maxPerFight: 3,
    /** Seconds into a stage (fight phase only) before its pack appears [min, max]. */
    firstDelay: [60, 200] as [number, number],
    /** Below this health fraction a due pack appears early, once `lowHealthDelay` s of the stage have passed. */
    lowHealth: 0.4,
    lowHealthDelay: 15,
    /** At least this long between one pack ending (collected or expired) and the next appearing. */
    minGap: 25,
    /** Seconds an uncollected pack stays; it blinks for the last `blinkTime`. */
    lifetime: 40,
    blinkTime: 5,
    /** Fraction of max health restored. */
    heal: 0.5,
    /** Spawn spots: distance from the player [min, max] (reachable but a dash away) and from each boss (min). */
    playerDistance: [7, 17] as [number, number],
    bossDistance: 7,
    spawnAttempts: 40,
    retryDelay: 0.5,
    /** Pickup reach (m) and highest feet height that collects. */
    pickupRadius: 1.25,
    pickupMaxHeight: 2.4,
    /** Look: hover height of the centre (m), size of the box, bob, spin (rad/s), beam height, sparkles/s. */
    hoverHeight: 1.15,
    size: 0.62,
    bobAmplitude: 0.14,
    bobSpeed: 2.6,
    spinSpeed: 1.3,
    beamHeight: 13,
    sparkleRate: 22,
    /** AI (the soak's reference player): goes for a pack within this range when hurt below `aiSeekHealth`. */
    aiSeekRange: 30,
    aiSeekHealth: 0.75,
    aiGiveUpTime: 9,
  },

  camera: {
    fov: 64,
    sprintFovBoost: 7,
    dodgeFovBoost: 5,
    distance: 4.9,
    height: 1.7,
    shoulder: 1.3,
    followSharpness: 18,
    sensitivity: 0.0022,
    minPitch: -0.6,
    maxPitch: 0.7,
    /** Camera collision sphere radius (keep above the near plane's half-width). */
    collisionRadius: 0.25,
    /** Trauma lost per second (trauma^2 drives the shake). */
    shakeDecay: 1.7,
    maxShakeOffset: 0.32,
    maxShakeRoll: 0.035,
    /** Aim assist cone, in degrees, around the crosshair. */
    aimAssistDegrees: 6,
    /**
     * Enemy looks near or in front of the camera are dithered see-through (Game.updateOcclusionFade):
     * fully gone within `clear` m of their bounds (nothing renders inside the near plane), easing
     * from `minVisible` back to solid at `near` m, and at most `occluded` while between the camera
     * and the player. `radius` scales the look's bounds for that test (wings and capes stick out).
     */
    bossFade: { clear: 0.4, near: 2, minVisible: 0.25, occluded: 0.3, radius: 1.05 },
    /**
     * Backed against cover the camera has to pull in toward the player: it rises over the shoulder
     * by up to `closeRise` m (more the closer it is, if the space above is clear), and the player's
     * own look dithers see-through, gone within `clear` m of its bounds and solid again at `near`.
     */
    closeRise: 0.6,
    playerFade: { clear: 0.15, near: 1.1, minVisible: 0.2 },
  },

  feel: {
    flashDecay: 5,
    koSlowMoScale: 0.22,
    koSlowMoTime: 1.3,
    perfectSlowMoScale: 0.35,
    perfectSlowMoTime: 0.3,
    /** Seconds an action press is remembered if it can't fire yet. Presses made mid-roll wait for the roll to end. */
    inputBuffer: 0.15,
    /**
     * Small hits (bolts) only freeze the game if the last small freeze was at least this long ago,
     * so sustained fire keeps its punch without stuttering. Big hits always freeze.
     */
    minorHitStopCooldown: 0.5,
  },

  ai: {
    /** Below this health fraction the AI prefers to retreat behind cover. */
    retreatHealth: 0.3,
    /** Below this mana fraction the AI backs off to regenerate. */
    lowMana: 0.22,
    /** Distance from the fire ring the AI tries to keep. */
    fireMargin: 3,
    /** Seconds the AI keeps firing at a target's last known position after it vanishes into a vape cloud. */
    lostTrackTime: 6,
    /**
     * Attacking from inside a vape cloud gives you away: for this long after a bolt, blast, stun,
     * Ultimate or breath (Wizard.sinceAttack) the AI sees you through the haze (and fires at you).
     */
    castRevealTime: 0.5,
    /** How long the AI stays aggressive after spotting a punish window. */
    punishTime: 1.6,
    /** Minimum seconds between retreats. */
    retreatCooldown: 5,
    /**
     * Boss reward spells for an AI that learned some (the campaign soak's reference player; bosses
     * never do). Simple rules, checked every `checkInterval` s: the carpet to escape when below
     * `carpetHealth` and under fire, or when `carpetIncoming` spells are about to hit (2 right after
     * an enemy volley); the vape cloud below `vapeHealth` (then staying in it while below
     * `vapeStayHealth`); Pump It before a bolt burst with `pumpManaSpare` mana left over; Lock-On once
     * the target has crossed the line of fire faster than `strafeSpeed` m/s for `strafeTime` s;
     * Hellfire Breath within `breathRange` x its range, facing the target within `breathFacing` degrees.
     */
    rewards: {
      checkInterval: 0.1,
      incomingHorizon: 0.6,
      volleyMemory: 0.5,
      carpetHealth: 0.35,
      carpetIncoming: 3,
      vapeHealth: 0.4,
      vapeStayHealth: 0.8,
      pumpManaSpare: 30,
      strafeSpeed: 3.2,
      strafeTime: 0.5,
      breathRange: 0.85,
      breathFacing: 25,
    },
    /**
     * AI profiles. The game has one difficulty: Quick Duel always uses `normal` (the Rival), and the
     * Boss Gauntlet's bosses (src/campaign/levels.ts) are the difficulty ladder. `easy` and `hard`
     * are not selectable; they are reference opponents for QA soaks and balance probes.
     */
    difficulty: {
      easy: {
        label: 'Apprentice',
        reactionTime: 0.45,
        aimError: 0.16,
        leadFactor: 0.1,
        dodgeChance: 0.25,
        shieldPreference: 0.3,
        perfectShieldChance: 0.05,
        burst: [2, 3],
        burstPause: [1.0, 1.8],
        blastChance: 0.25,
        stunChance: 0.15,
        punishChance: 0.25,
        strafeSpeed: 0.65,
        preferredRange: [10, 15],
      },
      normal: {
        label: 'Adept',
        reactionTime: 0.27,
        aimError: 0.09,
        leadFactor: 0.45,
        dodgeChance: 0.5,
        shieldPreference: 0.4,
        perfectShieldChance: 0.25,
        burst: [3, 5],
        burstPause: [0.6, 1.2],
        blastChance: 0.45,
        stunChance: 0.35,
        punishChance: 0.6,
        strafeSpeed: 0.85,
        preferredRange: [9, 15],
      },
      hard: {
        label: 'Archmage',
        reactionTime: 0.15,
        aimError: 0.05,
        leadFactor: 0.85,
        dodgeChance: 0.78,
        shieldPreference: 0.5,
        perfectShieldChance: 0.6,
        burst: [4, 6],
        burstPause: [0.35, 0.8],
        blastChance: 0.65,
        stunChance: 0.55,
        punishChance: 0.95,
        strafeSpeed: 1.0,
        preferredRange: [8, 14],
      },
    } satisfies Record<Difficulty, AIProfile>,
  },

  audio: {
    master: 0.8,
    sfx: 1.0,
    music: 0.4,
    /** Sounds beyond this distance from the camera are silent. */
    maxDistance: 65,
    /** Random pitch variation (+/-) applied to repeated sounds. */
    pitchVariance: 0.07,
    /**
     * A boss object's launch sound (gunshot, phone blip...) is skipped if the same sound started
     * less than this many seconds ago, so a fan volley sounds like one big throw, not a pile-up.
     */
    skinLaunchGap: 0.035,
  },

  ui: {
    damageNumberLife: 0.85,
    /** Minimum seconds between "IMMUNE" popups on the same wizard. */
    immunePopupInterval: 0.3,
  },

  /** Boss Gauntlet: one life per fight; every boss has 3 stages, each with its own health bar. */
  campaign: {
    /**
     * A Boss Gauntlet fight is one round and you have one life (Match). Every boss stage has its own
     * health bar (levels.ts `stageHealth`); there is no round timer (the HUD clock counts up). Two
     * safety caps keep a stalemate from lasting forever (GauntletClock):
     * - `stageCap`: a stage still going after this many seconds (no boss transformed or fell)
     *   pulls the fire ring in to `stageCapRadius` over `capCloseTime` (close quarters); it opens
     *   again (`reopenSpeed` m/s) once a boss transforms or falls.
     * - `safetyCap`: past this many seconds of fighting the ring closes all the way
     *   (`capMinRadius`) over `capCloseTime`, so the fight always ends.
     */
    fight: { stageCap: 9 * 60, stageCapRadius: 14, safetyCap: 35 * 60, capMinRadius: 0, capCloseTime: 60, reopenSpeed: 6 },
    /**
     * Headless transformations (QA, soaks; the real game plays `cinematic` instead, with the
     * simulation frozen): seconds the boss is invulnerable and frozen while it transforms.
     */
    evolveTime: 1.4,
    /** The health bar refill runs over this share of the transformation (start, end). */
    refill: [0.3, 0.92] as [number, number],
    /** Outward push on the player when the boss evolves, and its reach in meters. */
    evolveKnockback: 22,
    evolveRadius: 9,
    /** Share of evolveTime after which the next stage's look (model, size, aura) appears. */
    evolveSwapAt: 0.45,
    /** Transformation juice: freeze on the burst, screen flash strength, camera trauma. */
    evolveHitStopMs: 140,
    evolveFlash: 0.25,
    evolveShake: 0.75,
    /**
     * Each stage's hurtbox follows its model: height = `modelHeight` x the stage model's fitHeight
     * (never below the standard capsule), radius per stage. A short partner scales both to its own
     * size; a placeholder look uses placeholderScale.
     */
    hurtbox: { modelHeight: 0.9, radius: [0.42, 0.48, 0.55] as [number, number, number] },
    /**
     * Transformation cinematics (src/campaign/BossCinematic.ts), real seconds (pausable). The world
     * freezes (no wizard, spell, fire or lava moves or hurts), the camera swoops around the boss
     * between letterbox bars, he rises, glows, cracks and bursts into his next form, then slams
     * down; the camera returns to the player, a short count resumes the fight, and the boss stays
     * frozen and immune for `grace` s more. Stage 3 is bigger and longer. Indexed by the stage being entered (0 unused). Headless runs (QA, soaks) skip it.
     */
    cinematic: {
      enabled: true,
      duration: [0, 3.2, 4.4] as [number, number, number],
      /** Seconds at the start the old form reels from the blow that broke its bar (the rig's hit clip), at most this share of the shot. */
      stagger: 0.45,
      staggerShare: 0.14,
      /** Slow-mo into the freeze and out of it (s). */
      easeIn: 0.22,
      easeOut: 0.35,
      /** The "3 2 1" after the camera is back (s, the world still frozen). */
      resume: 0.9,
      grace: 0.35,
      /** Beats as fractions of the duration: the old form bursts, he lands, the camera heads back. */
      burstAt: 0.46,
      slamAt: 0.74,
      returnAt: 0.8,
      /** Overall intensity (shake, light, particles) and how high he rises (m), per stage. */
      intensity: [0, 1, 1.6] as [number, number, number],
      rise: [0, 1.1, 2.0] as [number, number, number],
      /** Full turns he spins while rising, and how far the camera orbits him (degrees). */
      spins: [0, 1, 2] as [number, number, number],
      orbit: [0, 100, 200] as [number, number, number],
      /** Camera distance from the boss's centre as a multiple of his height, and its FOV. */
      cameraDistance: 2.1,
      fov: 52,
      /** Sky and fog tint toward the boss palette at the peak (0..1), bloom added at the burst. */
      tint: [0, 0.45, 0.65] as [number, number, number],
      bloom: [0, 0.2, 0.3] as [number, number, number],
      /**
       * Light at the burst and the slam per arena theme (1 when not listed): bright arenas (sunlit
       * sand, glowing lava) get less bloom, smaller flashes and lights and fewer sparks there, so the
       * new form reads against them.
       */
      themeLight: { desert: 0.5, volcano: 0.5 } as Record<string, number>,
      /**
       * Brightness of the floor effects: the shockwave rings and the glowing cracks (times
       * themeLight). They sit right under the camera's gaze and bloom spreads them over the boss.
       */
      waveGlow: 0.8,
      crackGlow: 0.9,
      /** How much of the arena's base bloom a bright arena (themeLight < 1) loses for the shot, times (1 - themeLight). */
      bloomDuck: 1,
      /**
       * Camera clearance: before the shot the orbit's start angle, direction and (if it must) a lift
       * in metres are picked so that a sphere of `clearRadius` m swept from the boss to the camera
       * misses walls and cover at every beat (cluttered arenas: stalls, cubicles, cars, rocks).
       */
      clearAngles: 12,
      clearLifts: [0, 0.9, 1.8] as number[],
      clearRadius: 0.3,
      /** Debris chunks thrown up by the landing. */
      debris: [0, 18, 34] as [number, number, number],
      /** Hold Space / Enter / click (or the pad's A) after `skipAfter` s to play the rest at `skipSpeed`x. */
      skipAfter: 0.5,
      skipSpeed: 3.5,
      skipKeys: ['Space', 'Enter', 'Escape'],
      /**
       * Each boss's own transformation (src/campaign/transformStyles.ts, BossFighter.transform):
       * `rise` and `spins` scale the shot's rise and turns; per-stage counts are [-, stage 2, stage 3].
       */
      styles: {
        /** Sahil: a whirlwind of flying carpets and rolled rugs, a sand devil, gold coins at the burst. */
        bazaar: { rise: 1, spins: 1.25, carpets: [0, 6, 9], rolls: [0, 4, 6], coins: [0, 70, 120], sand: 45 },
        /** Bitcoin Obama: phones and flying pigs round him, a ring of green candles pumping up that crash red at the burst. */
        shill: { rise: 0.9, spins: 1, phones: [0, 6, 9], pigs: [0, 3, 5], candles: 16, candleRadius: 7.5, candleHeight: [1.2, 4.2] as [number, number] },
        /** The Midget: a hopping tantrum in a dust devil, then a leap, a spin and a ground-pound. */
        tantrum: { rise: 1.35, spins: 1.6, hops: [0, 4, 6], hopHeight: 0.42, phones: [0, 3, 4], dust: 40 },
        /** Broccoli Head: a huge drag on the vape (he puffs up), then the exhale: a cloud and a smoke ring. */
        vape: { rise: 0.6, spins: 0.5, inflate: 0.14, florets: [0, 6, 10], ringRadius: [0, 6, 9], puffs: [0, 28, 44] },
        /** Glowie: glitches in place (snaps, scanner, laser sights), then full auto into the air and a rain of casings. */
        glitch: { rise: 0.45, spins: 0, snapEvery: 0.15, snapDistance: 0.32, lasers: 4, shots: [0, 10, 16], casings: [0, 26, 44] },
        /** Tinubu: a summoning circle and a column of hellfire, burning skulls round him, fire from his mouth; it erupts. */
        hellfire: { rise: 1.25, spins: 0.5, skulls: [0, 5, 8], circleRadius: 3.2, columnHeight: 10, breathEvery: 0.55 },
      },
    },
    /** The pillar of light engulfing the boss: height and beam width (m), and seconds until it has faded (the new form shows through). */
    pillarHeight: 26,
    pillarWidth: 0.3,
    pillarTime: 0.85,
    /** Without a stage GLB the placeholder grows instead (stage 1, 2, 3); with partial GLBs, relative to the shown one. */
    placeholderScale: [1, 1.12, 1.25] as [number, number, number],
    /** Stage aura around the boss (glow, ground ring, rising motes): 0 = none, 1 = full. */
    aura: [0, 0.55, 1] as [number, number, number],
    /**
     * AI scaling per stage (stage 1, 2, 3), applied on top of the boss's base profile: quicker,
     * sharper, faster tempo, better leads, more dodging, perfect shields, spells and punishing.
     * Mild on purpose: each stage's attack unlocks and stageDamage already make it much harder, and
     * a stage lasts five minutes. Chances are capped at maxChance.
     */
    stageAI: {
      reactionTime: [1, 0.92, 0.85],
      aimError: [1, 0.95, 0.92],
      leadBonus: [0, 0.03, 0.06],
      burstBonus: [0, 0, 0],
      burstPause: [1, 0.95, 0.92],
      strafeSpeed: [1, 1.1, 1.2],
      dodgeChance: [1, 1.06, 1.15],
      perfectShieldChance: [1, 1.15, 1.35],
      blastChance: [1, 1, 1.05],
      stunChance: [1, 1, 1.05],
      punishChance: [1, 1.05, 1.1],
      maxChance: 0.95,
    },
    /** Multiplies the boss's damage per stage, on top of BossDef.damageMultiplier: the last stage hurts most. */
    stageDamage: [1, 1.25, 1.5] as [number, number, number],
    /**
     * Every boss presses harder with his ordinary spells than his base profile (BossStages
     * stageProfile): shorter pauses between bursts, longer bursts, more blasts, stuns and punishes,
     * closer in and quicker on his feet. Each of those spells hits for `spellDamage` of what it did,
     * so the fight is busier to dodge without being much deadlier. Special powers are unchanged.
     */
    aggression: {
      burstPause: 0.5,
      burstExtra: 1,
      blastChance: 2.5,
      stunChance: 2,
      punishChance: 2,
      range: 0.85,
      strafeSpeed: 1.1,
      spellDamage: 0.7,
    },
    /**
     * Ultimate charge rate for bosses. Their stage bars hold several times a wizard's health, and
     * charge comes from damage taken and dealt, so at full rate they would cast it every minute.
     */
    ultCharge: 0.25,
    /**
     * Signature volleys (levels.ts VolleyDef): mana per volley, the AI's max range, first use after
     * a stage begins (x cooldown), and a multiplier on every VolleyDef cooldown (fights are long
     * now: a volley every few seconds for fifteen minutes would bury the player).
     */
    volley: { manaCost: 8, range: 22, firstDelay: 0.35, cooldownScale: 2.2 },
    /**
     * Double fights (a boss with a `partner`, levels.ts): the pair spawn `spawnSpacing` m apart on
     * the enemy spawn line. Their AIs keep `spacing` m between them (push strength `spacingWeight`)
     * and drift apart around the player until `flankDegrees` separate them (`flankWeight`).
     */
    duo: { spawnSpacing: 5, spacing: 4.5, spacingWeight: 0.9, flankDegrees: 50, flankWeight: 0.45 },
    /**
     * A flying boss stage (BossStage.fly: The Midget's last): vertical speeds toward its hover height
     * (m/s), the highest cover it rises over (m), how far ahead it looks for cover (s of travel),
     * the bob (m, rad/s), and the jet under its feet (particles per second, size, life).
     */
    flight: { rise: 3, sink: 3.5, climb: 2.2, lookAhead: 0.25, bob: 0.14, bobRate: 2.4, jetRate: 70, jetSize: 0.16, jetLife: 0.35 },
  },

  /**
   * Testing aids. God mode: the player takes no damage, has unlimited mana, no spell cooldowns
   * (Blast, Shield and Stun are ready again at once, the Ultimate is always charged), deals
   * `godPowerMultiplier`x damage and casts spells with `godClashMultiplier`x clash power.
   * Toggle by typing 9 twice quickly, F9, the Settings toggle, or start with `?god` in the URL.
   * It is never saved: a reload turns it off again.
   */
  debug: {
    godMode: false,
    godPowerMultiplier: 5,
    godClashMultiplier: 5,
    godHotkey: 'F9',
    /** Press one of these twice within `godCheatWindowMs` to toggle god mode ("99"). */
    godCheatKeys: ['Digit9', 'Numpad9'],
    godCheatWindowMs: 600,
  },

  /**
   * Hub Tickets (the currency) and the Tickets-to-Verse exchange.
   * The server is authoritative for the rate, the balance and the daily Verse cap.
   */
  hub: {
    /** Flat Tickets for each duel win. No difficulty scaling. */
    ticketsPerWin: 20,
    /** Tickets spent for one Verse. */
    ticketsPerVerse: 10,
    /** Most Verse this game may grant in a day. Shown in the menu; the server enforces it. */
    verseDailyCap: 50,
  },

  controls: {
    forward: ['KeyW'],
    back: ['KeyS'],
    left: ['KeyA'],
    right: ['KeyD'],
    sprint: ['ShiftLeft', 'ShiftRight'],
    dodge: ['Space'],
    jump: ['KeyF', 'KeyC'],
    bolt: ['Digit1'],
    blast: ['Digit2'],
    shield: ['KeyQ', 'Digit3'],
    stun: ['KeyE', 'Digit4'],
    ultimate: ['KeyR', 'Digit5'],
    /** Boss reward spells (once learned). */
    carpet: ['KeyZ'],
    pump: ['KeyX'],
    vape: ['KeyV'],
    lockon: ['KeyG'],
    breath: ['KeyT'],
    pause: ['Escape', 'KeyP'],
    /** Mouse buttons: 0 = left, 2 = right. */
    mouseBolt: 0,
    mouseBlast: 2,
  },

  /** Controllers in the browser's "standard" mapping (Xbox, PlayStation, Switch Pro). */
  gamepad: {
    /** Radial deadzones (stick magnitude 0..1); `trigger` is the analog value that counts as pressed. */
    deadzone: { move: 0.16, look: 0.12, trigger: 0.3 },
    /** Stick magnitude treated as full deflection (worn sticks rarely reach 1). */
    outerDeadzone: 0.94,
    /** Response exponent after the deadzone: 1 = linear, 2 = fine control near center. */
    curve: { move: 1, look: 2 },
    /** Camera turn speed at full right-stick deflection, radians per second (x the Settings slider). */
    sensitivity: { yaw: 3.3, pitch: 2.1 },
    /** Holding the right stick at the edge ramps in extra yaw speed, for fast 180s. */
    acceleration: { threshold: 0.9, delay: 0.12, rampTime: 0.3, extraYaw: 2.2 },
    /** Stick or trigger travel needed before the pad takes over as the active device (ignores drift). */
    activateThreshold: 0.4,
    /** false = hold L3 to sprint; true = click L3 to sprint until the stick returns to center. */
    sprintToggle: false,
    /** Button names: a b x y lb rb lt rt back start l3 r3 up down left right home (positional). */
    bindings: {
      bolt: ['rt'],
      blast: ['lt'],
      shield: ['lb'],
      stun: ['rb'],
      ultimate: ['y'],
      jump: ['a'],
      dodge: ['b'],
      sprint: ['l3'],
      pause: ['start'],
      // Boss reward spells (once learned): the D-pad and the free face button.
      carpet: ['left'],
      pump: ['up'],
      vape: ['right'],
      lockon: ['down'],
      breath: ['x'],
    },
    aimAssist: {
      /** Settings default: 0 = off, 1 = default, 1.5 = strong. Scales everything below. */
      strength: 1,
      /** Aim-assist cone with a gamepad at strength 1 (the mouse keeps camera.aimAssistDegrees). */
      coneDegrees: 10,
      /** Camera magnetism only acts inside this cone, and only while the player moves or looks. */
      magnetismDegrees: 7,
      /** Share of the remaining aim error removed per second at the middle of the cone. */
      magnetismRate: 1.4,
      /** Vertical pull relative to horizontal. */
      pitchScale: 0.5,
      /** Look slow-down while the crosshair is on the opponent (0..1). */
      friction: 0.3,
    },
    rumble: {
      enabled: true,
      /** Global scale on every effect below. */
      intensity: 1,
      /** Taking damage: base effect plus `perDamage` magnitude per HP. */
      hurt: { strong: 0.2, weak: 0.4, ms: 110, perDamage: 0.018 },
      /** Fire ring ticks. */
      burn: { strong: 0.05, weak: 0.25, ms: 70 },
      /** Landing a hit of at least `minDamage`. */
      bigHit: { strong: 0.12, weak: 0.35, ms: 80, minDamage: 15 },
      perfect: { strong: 0.45, weak: 0.8, ms: 140 },
      ko: { strong: 1, weak: 1, ms: 550 },
    },
    menu: {
      /** Seconds a direction is held before it starts repeating, then the repeat interval. */
      repeatDelay: 0.38,
      repeatInterval: 0.09,
      /** Left-stick travel that counts as a menu direction. */
      stickThreshold: 0.5,
    },
  },

  teams: [
    {
      name: 'You',
      robe: 0x26407e,
      trim: 0xc9d6ff,
      spell: 0x46c8ff,
      blast: 0x7f6bff,
      stun: 0xb8f4ff,
      ultimate: 0x5fe0ff,
    },
    {
      name: 'Rival',
      robe: 0x7a1d2c,
      trim: 0xffd2a8,
      spell: 0xff5a36,
      blast: 0xffa62b,
      stun: 0xffe7b8,
      ultimate: 0xff7a3d,
    },
  ],
};

export type TeamPalette = (typeof CONFIG.teams)[number];
