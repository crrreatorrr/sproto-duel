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
    shadowMapSize: 1024,
    exposure: 1.0,
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
    floorRadius: 26,
    /** Hard collision wall behind the fire. */
    wallRadius: 21.6,
    /** Inner edge of the fire ring. Touching it burns. */
    fireRadius: 19.5,
    fireWidth: 1.8,
    fireDps: 26,
    fireTickInterval: 0.25,
    /** Inward knockback speed applied while burning. */
    firePush: 11,
    /** Seconds left on the clock when the fire ring starts closing in. */
    suddenDeathAt: 30,
    suddenDeathMinRadius: 8.5,
    spawnDistance: 12,
    pillars: {
      count: 6,
      ringRadius: 9.5,
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
      maxRadius: 30,
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
        preferredRange: [9, 14],
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
        preferredRange: [8, 13],
      },
    } satisfies Record<Difficulty, AIProfile>,
  },

  audio: {
    master: 0.8,
    sfx: 1.0,
    music: 0.4,
    /** Sounds beyond this distance from the camera are silent. */
    maxDistance: 45,
    /** Random pitch variation (+/-) applied to repeated sounds. */
    pitchVariance: 0.07,
  },

  ui: {
    damageNumberLife: 0.85,
  },

  /**
   * Testing aids. God mode: the player takes no damage, has unlimited mana, deals
   * `godPowerMultiplier`x damage and casts spells with `godClashMultiplier`x clash power.
   * Toggle by typing 9 twice quickly, F9, the Settings toggle, or start with `?god` in the URL.
   * It is never saved: a reload turns it off again.
   */
  debug: {
    godMode: false,
    godPowerMultiplier: 2,
    godClashMultiplier: 2,
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
