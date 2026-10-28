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
    /** How long the AI stays aggressive after spotting a punish window. */
    punishTime: 1.6,
    /** Minimum seconds between retreats. */
    retreatCooldown: 5,
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
  },

  /** Boss Gauntlet: every boss evolves through 3 stages within each round as its health drops. */
  campaign: {
    /** Health fractions at which a boss evolves into stage 2 and stage 3. */
    stageThresholds: [2 / 3, 1 / 3] as [number, number],
    /** Seconds the boss is invulnerable and frozen while it transforms. */
    evolveTime: 1.4,
    /** Outward push on the player when the boss evolves, and its reach in meters. */
    evolveKnockback: 14,
    evolveRadius: 9,
    /** Share of evolveTime after which the next stage's look (model, size, aura) appears. */
    evolveSwapAt: 0.45,
    /** Transformation juice: freeze on the burst, screen flash strength, camera trauma. */
    evolveHitStopMs: 140,
    evolveFlash: 0.4,
    evolveShake: 0.75,
    /** The pillar of light engulfing the boss: height and beam width (m), and seconds until it has faded (the new form shows through). */
    pillarHeight: 26,
    pillarWidth: 0.3,
    pillarTime: 0.85,
    /** Without a stage GLB the placeholder grows instead (stage 1, 2, 3); with partial GLBs, relative to the shown one. */
    placeholderScale: [1, 1.12, 1.25] as [number, number, number],
    /** Stage aura around the boss (glow, ground ring, rising motes): 0 = none, 1 = full. */
    aura: [0, 0.55, 1] as [number, number, number],
    /** AI scaling per stage (stage 1, 2, 3), applied on top of the boss's base profile. Chances are capped at maxChance. */
    stageAI: {
      reactionTime: [1, 0.88, 0.76],
      aimError: [1, 0.88, 0.75],
      burstBonus: [0, 1, 2],
      burstPause: [1, 0.85, 0.7],
      strafeSpeed: [1, 1.08, 1.16],
      dodgeChance: [1, 1.15, 1.55],
      perfectShieldChance: [1, 1.3, 2.0],
      maxChance: 0.95,
    },
    /** Multiplies the boss's damage per stage, on top of BossDef.damageMultiplier. */
    stageDamage: [1, 1.1, 1.25] as [number, number, number],
    /** Signature volleys (levels.ts VolleyDef): mana per volley, the AI's max range, first use after a stage begins (x cooldown). */
    volley: { manaCost: 8, range: 22, firstDelay: 0.35 },
    /**
     * Sidekick bolts (stages with `sidekickFires`), off for now: Obama's partner is to become a full
     * wizard of his own. Seconds between throws, damage vs a bolt, aim (lead 0..1, error in radians).
     */
    sidekick: { enabled: false, interval: [1.6, 2.4] as [number, number], damageScale: 0.75, lead: 0.3, aimError: 0.06 },
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
