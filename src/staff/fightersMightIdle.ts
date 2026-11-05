/**
 * Fighter's Might idle — node / motion contract for Duel wiring.
 * The clip `staff_fighters_might_idle` is already embedded in the GLB (4 s, 33 LINEAR keys).
 * Play it with an AnimationMixer on the loaded staff root (same path as the other staffs).
 * This file documents the moving nodes so catalog.ts / CONFIG can grow a fifth staff without
 * guessing names. Duel's src/staff/fightersMightIdle.ts was missing from local trees when this
 * asset was imported (2026-11-05); Tech can copy or re-home this.
 *
 * Item id: duel_staff_fighters_might
 * Relic:   tidebreaker_belt
 * Bolt:    Fist Bolt (yellow #ffd21f), 2× damage, 1.85× bolt interval
 */
export const FIGHTERS_MIGHT_IDLE = {
  clip: 'staff_fighters_might_idle',
  loop_s: 4,
  keys: 33,
  interp: 'LINEAR' as const,
  glowMaterial: 'staff_fighters_might_gauntlet_glow_mat',
  fxAnchor: 'staff_fighters_might_fx_anchor',
  nodes: {
    root: 'staff_fighters_might',
    shaft: 'staff_fighters_might_shaft',
    head: 'staff_fighters_might_head',
    gauntlet: 'staff_fighters_might_gauntlet',
    claw_l: 'staff_fighters_might_claw_l',
    claw_r: 'staff_fighters_might_claw_r',
    fx_anchor: 'staff_fighters_might_fx_anchor',
  },
  motion: [
    {
      node: 'staff_fighters_might_gauntlet',
      pivot: 'centre of the clenched fist',
      motion: 'bob +-1.3 cm (0.5 Hz) and rock about +Y +-10 deg (0.5 Hz)',
    },
    {
      node: 'staff_fighters_might_claw_l',
      pivot: 'claw root',
      motion: 'swing about +Z +-12 deg, 0.5 Hz',
    },
    {
      node: 'staff_fighters_might_claw_r',
      pivot: 'claw root',
      motion: 'swing about +Z -+12 deg (opposite the left claw), 0.5 Hz',
    },
  ],
  emissivePulse: {
    node: 'staff_fighters_might_gauntlet',
    material: 'staff_fighters_might_gauntlet_glow_mat',
    min: 1.0,
    max: 2.8,
    hz: 1.2,
    onCast: 4.0,
  },
  vfx: {
    bolt: '#ffd21f',
    core: '#fff3a0',
    trail: '#ff8a1a',
    accent: '#ff3a3a',
  },
} as const;
