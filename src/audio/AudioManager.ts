import { Howl, Howler } from 'howler';
import * as THREE from 'three';
import { CONFIG } from '../config';
import { resolveAudio, resolveAsset } from '../assets/AssetLoader';
import { SOUNDS, type SoundAsset, type SoundKey } from '../assets/manifest';
import type { PowerKind, ProjectileSkin } from '../campaign/levels';
import type { CineCue } from '../campaign/transformStyles';
import { events } from '../core/events';
import type { Game } from '../core/Game';

interface PlayOptions {
  /** World position for distance attenuation and stereo pan. */
  pos?: THREE.Vector3;
  volume?: number;
  rate?: number;
  /** Skip random pitch variation. */
  exactPitch?: boolean;
}

const tmp = new THREE.Vector3();

/**
 * Launch sound per object skin, with playback rate and volume for bolts and for blasts (skins that
 * share a sound pitch down and swell for the bigger blast object).
 */
const SKIN_SOUNDS: Record<Exclude<ProjectileSkin, 'orb'>, { key: SoundKey; rate: number; volume: number }> = {
  rugRoll: { key: 'rugWhoosh', rate: 1.15, volume: 0.85 },
  carpet: { key: 'rugWhoosh', rate: 0.8, volume: 1 },
  phone: { key: 'phoneBlip', rate: 1, volume: 1 },
  pig: { key: 'pigOink', rate: 1, volume: 1 },
  floret: { key: 'veggieCrunch', rate: 1.15, volume: 0.85 },
  broccoli: { key: 'veggieCrunch', rate: 0.8, volume: 1 },
  bullet: { key: 'gunshot', rate: 1, volume: 1 },
  grenade: { key: 'grenadeThump', rate: 1, volume: 1 },
  hellfire: { key: 'fireRoar', rate: 1.2, volume: 0.8 },
  skull: { key: 'fireRoar', rate: 0.85, volume: 1 },
};

/** What each boss transformation's cues sound like (rate and volume; the cue's own rate multiplies in). */
const CINE_CUES: Record<CineCue, { key: SoundKey; rate: number; volume: number }> = {
  whoosh: { key: 'carpetWhoosh', rate: 0.9, volume: 0.9 },
  coins: { key: 'pumpCoin', rate: 0.85, volume: 1 },
  phone: { key: 'phoneBlip', rate: 0.9, volume: 0.8 },
  candle: { key: 'pumpCoin', rate: 1, volume: 0.55 },
  crash: { key: 'pillarCrumble', rate: 0.7, volume: 0.9 },
  oink: { key: 'pigOink', rate: 0.9, volume: 0.9 },
  hop: { key: 'pillarHit', rate: 1.1, volume: 0.5 },
  thud: { key: 'pillarHit', rate: 0.6, volume: 0.7 },
  inhale: { key: 'vapePuff', rate: 0.45, volume: 0.9 },
  exhale: { key: 'vapePuff', rate: 0.32, volume: 1 },
  crunch: { key: 'veggieCrunch', rate: 0.9, volume: 0.8 },
  beep: { key: 'lockBeep', rate: 1, volume: 0.5 },
  glitch: { key: 'stunBeam', rate: 1.9, volume: 0.45 },
  gunfire: { key: 'gunshot', rate: 1, volume: 0.6 },
  casing: { key: 'pillarHit', rate: 2.6, volume: 0.4 },
  fire: { key: 'fireRoar', rate: 0.8, volume: 0.8 },
  roar: { key: 'breathRoar', rate: 0.72, volume: 1 },
};

/** Boss powers: the warning as one starts, and what each piece sounds like as it fires. */
const POWER_CAST: Record<PowerKind, { key: SoundKey; rate: number; volume: number }> = {
  strike: { key: 'lockBeep', rate: 0.8, volume: 0.8 },
  barrage: { key: 'blastCharge', rate: 1.1, volume: 0.9 },
  march: { key: 'stunCharge', rate: 0.7, volume: 0.9 },
  rings: { key: 'ultCharge', rate: 1.4, volume: 0.8 },
  sweep: { key: 'stunCharge', rate: 1.2, volume: 0.9 },
  cone: { key: 'blastCharge', rate: 0.75, volume: 1 },
  seekers: { key: 'phoneBlip', rate: 0.7, volume: 0.9 },
  flash: { key: 'grenadeThump', rate: 1, volume: 1 },
  cloud: { key: 'vapePuff', rate: 0.6, volume: 0.9 },
};
const POWER_FIRE: Partial<Record<PowerKind, { key: SoundKey; rate: number; volume: number }>> = {
  strike: { key: 'blastExplode', rate: 0.9, volume: 1 },
  barrage: { key: 'blastExplode', rate: 1.25, volume: 0.6 },
  march: { key: 'blastExplode', rate: 1.45, volume: 0.55 },
  rings: { key: 'ultWave', rate: 1.35, volume: 0.8 },
  sweep: { key: 'stunBeam', rate: 0.7, volume: 1 },
  cone: { key: 'blastCast', rate: 0.7, volume: 1 },
  seekers: { key: 'fireRoar', rate: 1.3, volume: 0.6 },
  flash: { key: 'stunHit', rate: 1.6, volume: 1 },
  cloud: { key: 'vapePuff', rate: 0.45, volume: 1 },
};

/** The sound a skin's launch plays (QA and docs). */
export const skinSound = (skin: Exclude<ProjectileSkin, 'orb'>): SoundKey => SKIN_SOUNDS[skin].key;

/**
 * Howler-based audio. Every manifest key resolves to the generated file if it exists, otherwise to
 * the synthesized placeholder in public/assets/audio/placeholder/. Gameplay never calls this
 * directly: `bind()` maps game events to sounds.
 */
export class AudioManager {
  private readonly howls = new Map<SoundKey, Howl>();
  private readonly voices = new Map<SoundKey, number[]>();
  private musicKey: SoundKey | null = null;
  private musicId: number | null = null;
  private ambientId: number | null = null;
  private sfxVolume: number = CONFIG.audio.sfx;
  private musicVolume: number = CONFIG.audio.music;
  /** When true, sounds triggered by gameplay events are skipped (menu attract mode). */
  gameplayMuted = false;
  private readonly listener = new THREE.Vector3();
  private readonly listenerRight = new THREE.Vector3(1, 0, 0);
  /** When each object launch sound last started (ms), for CONFIG.audio.skinLaunchGap. */
  private readonly lastLaunch = new Map<SoundKey, number>();

  constructor() {
    for (const key of Object.keys(SOUNDS) as SoundKey[]) {
      const spec = SOUNDS[key] as SoundAsset;
      const url = resolveAudio(spec.path) ?? resolveAsset(`audio/placeholder/${key}.wav`);
      if (!url) continue;
      this.howls.set(key, new Howl({ src: [url], loop: !!spec.loop, volume: spec.volume, preload: true }));
    }
    Howler.volume(CONFIG.audio.master);
  }

  setVolumes(master: number, sfx: number, music: number): void {
    Howler.volume(master);
    this.sfxVolume = sfx;
    this.musicVolume = music;
    if (this.musicKey && this.musicId !== null) {
      this.howls.get(this.musicKey)?.volume((SOUNDS[this.musicKey] as SoundAsset).volume * music, this.musicId);
    }
    if (this.ambientId !== null) this.howls.get('fireLoop')?.volume(SOUNDS.fireLoop.volume * sfx, this.ambientId);
  }

  /** Camera position and right vector, for attenuation and panning. */
  setListener(pos: THREE.Vector3, right: THREE.Vector3): void {
    this.listener.copy(pos);
    this.listenerRight.copy(right);
  }

  play(key: SoundKey, opts: PlayOptions = {}): number | null {
    const howl = this.howls.get(key);
    if (!howl) return null;
    const spec = SOUNDS[key] as SoundAsset;
    let volume = spec.volume * this.sfxVolume * (opts.volume ?? 1);
    let pan = 0;
    if (opts.pos) {
      tmp.subVectors(opts.pos, this.listener);
      const d = tmp.length();
      const max = CONFIG.audio.maxDistance;
      if (d > max) return null;
      // Gentle rolloff: close sounds full, far sounds quieter but present.
      volume *= 1 / (1 + (d / 9) * (d / 9) * 0.5);
      if (d > 0.5) pan = THREE.MathUtils.clamp(tmp.dot(this.listenerRight) / d, -1, 1) * 0.7;
    }
    if (volume < 0.005) return null;

    // Voice limiting: steal the oldest instance.
    const limit = spec.maxVoices ?? 4;
    let list = this.voices.get(key);
    if (!list) this.voices.set(key, (list = []));
    for (let i = list.length - 1; i >= 0; i--) if (!howl.playing(list[i])) list.splice(i, 1);
    if (list.length >= limit) howl.stop(list.shift());

    const id = howl.play();
    howl.volume(volume, id);
    if (pan !== 0) howl.stereo(pan, id);
    const variance = opts.exactPitch ? 0 : CONFIG.audio.pitchVariance;
    howl.rate((opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * variance), id);
    list.push(id);
    return id;
  }

  playMusic(key: SoundKey | null, fadeMs = 900): void {
    if (key === this.musicKey) return;
    if (this.musicKey && this.musicId !== null) {
      const old = this.howls.get(this.musicKey)!;
      const oldId = this.musicId;
      old.fade(old.volume(oldId) as number, 0, fadeMs, oldId);
      old.once('fade', () => old.stop(oldId), oldId);
    }
    this.musicKey = key;
    this.musicId = null;
    if (!key) return;
    const howl = this.howls.get(key);
    if (!howl) return;
    const target = (SOUNDS[key] as SoundAsset).volume * this.musicVolume;
    this.musicId = howl.play();
    howl.volume(0, this.musicId);
    howl.fade(0, target, fadeMs, this.musicId);
  }

  setAmbient(on: boolean): void {
    const howl = this.howls.get('fireLoop');
    if (!howl) return;
    if (on && this.ambientId === null) {
      this.ambientId = howl.play();
      howl.volume(SOUNDS.fireLoop.volume * this.sfxVolume, this.ambientId);
    } else if (!on && this.ambientId !== null) {
      howl.stop(this.ambientId);
      this.ambientId = null;
    }
  }

  /** Muffle gameplay while paused. */
  setPaused(paused: boolean): void {
    for (const [key, howl] of this.howls) {
      if (key === this.musicKey || key === 'uiHover' || key === 'uiClick') continue;
      if (paused) howl.pause();
      else if (key === 'fireLoop' && this.ambientId !== null) howl.play(this.ambientId);
    }
    if (this.musicKey && this.musicId !== null) {
      const v = (SOUNDS[this.musicKey] as SoundAsset).volume * this.musicVolume * (paused ? 0.4 : 1);
      this.howls.get(this.musicKey)!.volume(v, this.musicId);
    }
  }

  /** Map game events to sounds. */
  bind(game: Game): void {
    const isPlayer = (w: unknown) => w === game.player;
    const on: typeof events.on = (type, fn) => events.on(type, (e) => {
      if (!this.gameplayMuted) fn(e);
    });
    on('castStart', (e) => {
      const key = e.spell === 'blast' ? 'blastCharge' : e.spell === 'stun' ? 'stunCharge' : 'ultCharge';
      this.play(key, { pos: e.wizard.pos });
    });
    on('cast', (e) => {
      // Bolts and blasts thrown as objects sound on 'skinLaunch' instead (one per projectile).
      if ((e.spell === 'bolt' || e.spell === 'blast') && (e.wizard.skins?.[e.spell] ?? 'orb') !== 'orb') return;
      const key: Record<string, SoundKey> = { bolt: 'boltCast', blast: 'blastCast', shield: 'shieldUp', stun: 'stunBeam', ultimate: 'ultWave' };
      this.play(key[e.spell], { pos: e.spell === 'ultimate' ? undefined : e.pos, volume: isPlayer(e.wizard) ? 1 : 0.85 });
    });
    on('skinLaunch', (e) => {
      if (e.skin === 'orb') return;
      const s = SKIN_SOUNDS[e.skin];
      const now = performance.now();
      if (now - (this.lastLaunch.get(s.key) ?? -1e9) < CONFIG.audio.skinLaunchGap * 1000) return;
      this.lastLaunch.set(s.key, now);
      this.play(s.key, { pos: e.pos, rate: s.rate, volume: s.volume * (isPlayer(e.wizard) ? 1 : 0.85) });
    });
    on('impact', (e) => {
      if (e.spell !== 'bolt') return;
      this.play(e.surface === 'wizard' ? 'boltHit' : e.surface === 'pillar' ? 'pillarHit' : 'fizzle', { pos: e.pos });
    });
    on('damage', (e) => {
      if (e.kind === 'scorch') this.play('fireBurn', { pos: e.point, volume: 0.5 });
      else if (e.kind !== 'fire') this.play('hurt', { pos: e.point, volume: (isPlayer(e.target) ? 1 : 0.7) * (e.kind === 'breath' ? 0.6 : 1) });
    });
    on('explosion', (e) => this.play('blastExplode', { pos: e.pos }));
    on('block', (e) => this.play(e.perfect ? 'shieldPerfect' : 'shieldBlock', { pos: e.pos, exactPitch: e.perfect }));
    on('clash', (e) => this.play('clash', { pos: e.pos }));
    on('dodge', (e) => this.play('dodge', { pos: e.wizard.pos }));
    // No dedicated jump sounds: a quick high whoosh for takeoff, a soft low thud for touchdown.
    on('jump', (e) => this.play('dodge', { pos: e.pos, rate: 1.45, volume: 0.45 }));
    on('land', (e) => this.play('pillarHit', { pos: e.pos, rate: 0.75, volume: THREE.MathUtils.clamp(e.speed / 14, 0.12, 0.45) }));
    on('stunned', (e) => this.play('stunHit', { pos: e.wizard.pos }));
    on('burn', (e) => this.play('fireBurn', { pos: e.wizard.pos }));
    on('pillarBreak', (e) => {
      if (!e.glass) {
        this.play('pillarCrumble', { pos: e.pos });
        return;
      }
      // Shattering glass: a bright, high crash plus the shield's glassy ring.
      this.play('pillarCrumble', { pos: e.pos, rate: 2.2, volume: 0.8 });
      this.play('shieldBlock', { pos: e.pos, rate: 1.7, volume: 0.7 });
    });
    // Boss evolution. Headless-style (no cinematic): a deep charge over the shockwave's boom. In a
    // live fight the cinematic's beats sound instead: a rising drone, the roar as the old form
    // bursts, the slam as he lands, the resume count.
    on('bossEvolve', (e) => {
      if (game.transformCinematics) return;
      this.play('bossRise', { rate: 1.4, exactPitch: true, volume: 0.6 });
      this.play('blastExplode', { pos: e.pos, rate: 0.7 });
    });
    on('bossCinematic', (e) => {
      const big = e.stage >= 2;
      if (e.beat === 'start') this.play('bossRise', { exactPitch: true, rate: big ? 0.85 : 1 });
      else if (e.beat === 'burst') {
        this.play('bossRoar', { exactPitch: true, rate: big ? 0.9 : 1.05 });
        this.play('blastExplode', { rate: 0.6, volume: 0.9 });
      } else if (e.beat === 'slam') this.play('bossSlam', { exactPitch: true, rate: big ? 0.88 : 1 });
      else if (e.beat === 'count') this.play('countdown', { exactPitch: true });
      else if (e.beat === 'resume') this.play('roundStart', { exactPitch: true, rate: 1.15, volume: 0.6 });
    });
    // Boss special powers: a warning as each starts, a beep as a strike locks, its hits as they land.
    on('bossPower', (e) => {
      const k = e.power.kind;
      if (e.phase === 'cast') {
        const c = POWER_CAST[k];
        this.play(c.key, { pos: e.pos, rate: c.rate, volume: c.volume, exactPitch: true });
      } else if (e.phase === 'lock') {
        this.play('lockBeep', { pos: e.pos, rate: 1.5, exactPitch: true });
      } else if (e.phase === 'fire') {
        const c = POWER_FIRE[k];
        if (c) this.play(c.key, { pos: e.pos, rate: c.rate * (0.92 + Math.random() * 0.16), volume: c.volume });
      } else if (k === 'seekers') {
        this.play('boltHit', { pos: e.pos, rate: 0.8 });
      }
    });
    // A boss's own transformation: his props and moves (carpets, candles, hops, the vape, gunfire, hellfire).
    on('bossCinematicCue', (e) => {
      const c = CINE_CUES[e.cue];
      this.play(c.key, { exactPitch: true, rate: c.rate * e.rate, volume: c.volume });
    });
    // Boss reward spells: a whoosh, a coin pump, a puff, a lock beep, a fire roar.
    const REWARD_SOUNDS: Record<string, SoundKey> = { carpet: 'carpetWhoosh', pump: 'pumpCoin', vape: 'vapePuff', lockon: 'lockBeep', breath: 'breathRoar' };
    on('rewardCast', (e) => this.play(REWARD_SOUNDS[e.spell], { pos: isPlayer(e.wizard) ? undefined : e.pos, exactPitch: e.spell === 'lockon' }));
    // The carpet flown into someone: a thump and a whoosh.
    on('carpetRam', (e) => {
      this.play('pillarHit', { pos: e.pos, rate: 0.7, volume: 0.9 });
      this.play('carpetWhoosh', { pos: e.pos, rate: 1.3, volume: 0.7 });
    });
    on('rewardEnd', (e) => {
      if (e.spell === 'carpet' && e.wizard.active) this.play('pillarHit', { pos: e.wizard.pos, rate: 0.8, volume: 0.35 });
    });
    // Arena shifts: a deep rumble as the floor changes, a hiss before a vent and its roar, the spring's chime.
    on('arenaShift', () => {
      this.play('ultWave', { rate: 0.55, volume: 0.9 });
      this.play('pillarHit', { rate: 0.5, volume: 0.7 });
    });
    on('ventWarn', (e) => this.play('stunCharge', { pos: e.pos, rate: 0.6, volume: 0.7 }));
    on('ventErupt', (e) => this.play('fireRoar', { pos: e.pos, rate: 0.9, volume: 1 }));
    on('springHeal', (e) => {
      if (isPlayer(e.wizard)) this.play('lifePackPickup', { rate: 1.5, volume: 0.35 });
    });
    on('lifePackSpawn', (e) => this.play('lifePackSpawn', { pos: e.pos, exactPitch: true }));
    on('lifePackPickup', () => this.play('lifePackPickup', { exactPitch: true }));
    on('lifePackExpire', (e) => this.play('ticketExpire', { pos: e.pos, rate: 0.8, volume: 0.6 }));
    on('ultReady', (e) => {
      if (isPlayer(e.wizard)) this.play('ultReady', { exactPitch: true });
    });
    on('noMana', (e) => {
      if (isPlayer(e.wizard)) this.play('noMana');
    });
    on('ticketSpawn', (e) => this.play('ticketSpawn', { pos: e.pos }));
    on('ticketPickup', (e) => this.play('ticketPickup', isPlayer(e.wizard) ? { exactPitch: true } : { pos: e.pos, volume: 0.8 }));
    on('ticketExpire', (e) => this.play('ticketExpire', { pos: e.pos, volume: 0.6 }));
    on('manaBoostEnd', (e) => {
      if (isPlayer(e.wizard)) this.play('ticketExpire', { exactPitch: true, volume: 0.9 });
    });
    on('countdown', () => this.play('countdown', { exactPitch: true }));
    on('roundStart', () => this.play('roundStart', { exactPitch: true }));
    on('roundEnd', (e) => {
      if (e.winner) this.play(isPlayer(e.winner) ? 'roundWin' : 'roundLose', { exactPitch: true });
    });
    on('matchEnd', (e) => this.play(isPlayer(e.winner) ? 'victory' : 'defeat', { exactPitch: true }));
  }
}
