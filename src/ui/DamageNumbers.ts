import * as THREE from 'three';
import { CONFIG } from '../config';

/**
 * `boss`: a campaign boss naming its signature attack, in the boss palette. `mana`/`manaFoe`: golden-ticket
 * pickups. `heal`: a life pack or the vape cloud. `spell`: a boss reward spell's name as it is cast.
 */
export type PopupStyle = 'dmg' | 'dmgBig' | 'dmgSelf' | 'perfect' | 'info' | 'stun' | 'block' | 'burn' | 'boss' | 'mana' | 'manaFoe' | 'heal' | 'spell';

interface Popup {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  scale: number;
  active: boolean;
  /** A word callout (PERFECT!, STUNNED, a spell name...), not a damage number. */
  callout: boolean;
  /** Screen offset (px, negative is up) that keeps this callout clear of the ones under it. */
  stackY: number;
}

/** Damage numbers scatter; every other style is a word callout and stacks instead of overlapping. */
const isCallout = (style: PopupStyle) => style !== 'dmg' && style !== 'dmgBig' && style !== 'dmgSelf' && style !== 'burn';
/** Callouts closer than this (m) share a stack, and each takes this much height (px at scale 1). */
const STACK_RADIUS = 2.5;
const STACK_LINE = 38;

const tmp = new THREE.Vector3();

/** Pooled DOM popups projected from world space. Only `transform`/`opacity` change per frame. */
export class DamageNumbers {
  private readonly items: Popup[] = [];
  private readonly root: HTMLDivElement;

  /**
   * `rect`: the view this layer projects into, as fractions of the window (Local Versus has one
   * layer per half, clipped to it). Full screen by default.
   */
  constructor(parent: HTMLElement, private readonly camera: THREE.Camera, size = 32, private readonly rect = { x: 0, w: 1 }) {
    this.root = document.createElement('div');
    this.root.className = 'popups';
    if (rect.x !== 0 || rect.w !== 1) {
      Object.assign(this.root.style, { left: `${rect.x * 100}%`, width: `${rect.w * 100}%`, right: 'auto', overflow: 'hidden' });
    }
    parent.appendChild(this.root);
    for (let i = 0; i < size; i++) {
      const el = document.createElement('div');
      el.className = 'popup';
      el.style.opacity = '0';
      this.root.appendChild(el);
      this.items.push({ el, pos: new THREE.Vector3(), vx: 0, vy: 0, life: 0, maxLife: 1, scale: 1, active: false, callout: false, stackY: 0 });
    }
  }

  spawn(pos: THREE.Vector3, text: string, style: PopupStyle): void {
    let p = this.items.find((i) => !i.active);
    if (!p) p = this.items.reduce((a, b) => (a.life < b.life ? a : b));
    p.active = true;
    p.pos.copy(pos);
    p.pos.x += (Math.random() - 0.5) * 0.5;
    p.pos.y += 0.3 + Math.random() * 0.3;
    p.vx = (Math.random() - 0.5) * 40;
    p.vy = -70 - Math.random() * 20;
    p.maxLife = p.life = style === 'perfect' || style === 'stun' || style === 'boss' || style === 'mana' || style === 'heal' || style === 'spell' ? CONFIG.ui.damageNumberLife * 1.6 : CONFIG.ui.damageNumberLife;
    p.scale = style === 'dmgBig' || style === 'perfect' || style === 'boss' || style === 'mana' || style === 'heal' || style === 'spell' ? 1.5 : style === 'info' || style === 'burn' || style === 'manaFoe' ? 0.85 : 1;
    p.callout = isCallout(style);
    p.stackY = 0;
    if (p.callout) {
      // A second callout at the same spot (two PERFECT!s from a volley) sits above the first by its
      // height instead of being drawn on top of it; they then rise together.
      p.vx = 0;
      let top = 0;
      for (const o of this.items) {
        if (o === p || !o.active || !o.callout || o.pos.distanceTo(pos) > STACK_RADIUS) continue;
        const age = 1 - o.life / o.maxLife;
        // Where that callout's top edge is now, relative to a fresh one's baseline.
        top = Math.min(top, o.stackY + o.vy * age + 60 * age * age - STACK_LINE * o.scale);
      }
      p.stackY = Math.max(top, -STACK_LINE * 6);
    }
    p.el.textContent = text;
    p.el.className = `popup popup-${style}`;
  }

  /** Active popups (tests, QA): text, style class and stack offset. */
  get active(): { text: string; className: string; stackY: number }[] {
    return this.items.filter((p) => p.active).map((p) => ({ text: p.el.textContent ?? '', className: p.el.className, stackY: p.stackY }));
  }

  /** Show or hide the whole layer (a split view's layer is hidden outside Local Versus). */
  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
    if (!on) this.clear();
  }

  update(dt: number): void {
    const w = window.innerWidth * this.rect.w;
    const h = window.innerHeight;
    for (const p of this.items) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.el.style.opacity = '0';
        continue;
      }
      const age = 1 - p.life / p.maxLife;
      tmp.copy(p.pos).project(this.camera);
      if (tmp.z > 1) {
        p.el.style.opacity = '0';
        continue;
      }
      const offY = p.vy * age + 60 * age * age + p.stackY;
      const x = (tmp.x * 0.5 + 0.5) * w + p.vx * age;
      const y = (-tmp.y * 0.5 + 0.5) * h + offY;
      // Pop in big, settle, fade out.
      const pop = age < 0.12 ? 1.6 - (age / 0.12) * 0.6 : 1;
      p.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${(p.scale * pop).toFixed(3)})`;
      p.el.style.opacity = age > 0.7 ? ((1 - age) / 0.3).toFixed(3) : '1';
    }
  }

  clear(): void {
    for (const p of this.items) {
      p.active = false;
      p.el.style.opacity = '0';
    }
  }
}
