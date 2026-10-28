import { Howl, Howler } from 'howler';
import * as THREE from 'three';
import { CONFIG } from '../config';
import { resolveAudio, resolveAsset } from '../assets/AssetLoader';
import { SOUNDS, type SoundAsset, type SoundKey } from '../assets/manifest';
import type { ProjectileSkin } from '../campaign/levels';
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
      if (e.kind !== 'fire') this.play('hurt', { pos: e.point, volume: isPlayer(e.target) ? 1 : 0.7 });
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
    on('pillarBreak', (e) => this.play('pillarCrumble', { pos: e.pos }));
    // Boss evolution (no dedicated sound yet): a deep ultimate charge over the shockwave's boom.
    on('bossEvolve', (e) => {
      this.play('ultCharge', { rate: 0.8, exactPitch: true });
      this.play('blastExplode', { pos: e.pos, rate: 0.7 });
    });
    on('ultReady', (e) => {
      if (isPlayer(e.wizard)) this.play('ultReady', { exactPitch: true });
    });
    on('noMana', (e) => {
      if (isPlayer(e.wizard)) this.play('noMana');
    });
    on('countdown', () => this.play('countdown', { exactPitch: true }));
    on('roundStart', () => this.play('roundStart', { exactPitch: true }));
    on('roundEnd', (e) => {
      if (e.winner) this.play(isPlayer(e.winner) ? 'roundWin' : 'roundLose', { exactPitch: true });
    });
    on('matchEnd', (e) => this.play(isPlayer(e.winner) ? 'victory' : 'defeat', { exactPitch: true }));
  }
}
