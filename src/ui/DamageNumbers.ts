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
}

const tmp = new THREE.Vector3();

/** Pooled DOM popups projected from world space. Only `transform`/`opacity` change per frame. */
export class DamageNumbers {
  private readonly items: Popup[] = [];
  private readonly root: HTMLDivElement;

  constructor(parent: HTMLElement, private readonly camera: THREE.Camera, size = 32) {
    this.root = document.createElement('div');
    this.root.className = 'popups';
    parent.appendChild(this.root);
    for (let i = 0; i < size; i++) {
      const el = document.createElement('div');
      el.className = 'popup';
      el.style.opacity = '0';
      this.root.appendChild(el);
      this.items.push({ el, pos: new THREE.Vector3(), vx: 0, vy: 0, life: 0, maxLife: 1, scale: 1, active: false });
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
    p.el.textContent = text;
    p.el.className = `popup popup-${style}`;
  }

  update(dt: number): void {
    const w = window.innerWidth;
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
      const offY = p.vy * age + 60 * age * age;
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
