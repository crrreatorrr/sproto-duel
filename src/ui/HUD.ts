import * as THREE from 'three';
import { CONFIG } from '../config';
import { resolveImage } from '../assets/AssetLoader';
import { bossStagePortrait } from '../assets/manifest';
import { STAGE_COUNT } from '../campaign/BossStages';
import { BOSSES } from '../campaign/levels';
import { events } from '../core/events';
import { feel } from '../core/feel';
import type { Game } from '../core/Game';
import type { Match } from '../core/Match';
import type { SpellId } from '../spells/types';
import type { Wizard } from '../wizard/Wizard';
import { spellIcon } from './icons';

const W = CONFIG.wizard;
const S = CONFIG.spells;
const TK = CONFIG.tickets;

interface Plate {
  root: HTMLElement;
  hp: HTMLElement;
  chip: HTMLElement;
  hpText: HTMLElement;
  mana: HTMLElement;
  /** Golden-ticket boost countdown chip next to the mana bar. */
  buff: HTMLElement;
  buffTime: HTMLElement;
  ult: HTMLElement;
  chipValue: number;
  chipDelay: number;
}

interface Slot {
  spell: SpellId;
  root: HTMLElement;
  sweep: HTMLElement;
  time: HTMLElement;
}

const SLOTS: { spell: SpellId; label: string }[] = [
  { spell: 'bolt', label: 'Bolt' },
  { spell: 'blast', label: 'Blast' },
  { spell: 'shield', label: 'Shield' },
  { spell: 'stun', label: 'Stun' },
  { spell: 'ultimate', label: 'Ultimate' },
];

/** Key label per slot (mouse + keyboard). */
const KEY_LABELS = ['LMB', 'RMB', 'Q', 'E', 'R'];

const tmp = new THREE.Vector3();

/** In-match HUD. Built once; per-frame updates only touch transforms, classes and changed text. */
export class HUD {
  readonly root: HTMLElement;
  private readonly plates: Plate[];
  private readonly slots: Slot[] = [];
  private readonly slotKeys: HTMLElement[] = [];
  private readonly timer: HTMLElement;
  private readonly roundLabel: HTMLElement;
  private readonly pips: HTMLElement[][] = [[], []];
  private readonly banner: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly bannerArt: HTMLImageElement;
  /** Boss stage pips and stage name on the rival plate. */
  private readonly stagePips: HTMLElement[] = [];
  private readonly stageName: HTMLElement;
  private readonly flash: HTMLElement;
  private readonly ultDim: HTMLElement;
  private dim = 0;
  private readonly vignette: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly enemyTag: HTMLElement;
  private readonly enemyTagFill: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly godBadge: HTMLElement;
  private readonly dodge: HTMLElement;
  private readonly cache = new Map<string, string>();
  private hitMarker = 0;
  private hurt = 0;

  constructor(parent: HTMLElement, private readonly game: Game, private readonly match: Match) {
    this.root = document.createElement('div');
    this.root.className = 'hud hidden';
    this.root.innerHTML = `
      <div class="ult-dim"></div>
      <div class="screen-flash"></div>
      <div class="vignette"></div>
      <div class="hud-top">
        ${this.plateHtml('left')}
        <div class="hud-center">
          <div class="pips"><span class="pip-row" data-side="0"></span><div class="timer">80</div><span class="pip-row" data-side="1"></span></div>
          <div class="round-label">Round 1</div>
        </div>
        ${this.plateHtml('right')}
      </div>
      <div class="crosshair"><i></i><i></i><i></i><i></i></div>
      <div class="enemy-tag"><div class="enemy-tag-fill"></div></div>
      <div class="offscreen-arrow"></div>
      <div class="god-badge" title="God mode: no damage, unlimited mana, no cooldowns, ${CONFIG.debug.godPowerMultiplier}× damage (99 or ${CONFIG.debug.godHotkey} toggles)">God Mode</div>
      <div class="banner"><img class="banner-art" alt="" draggable="false"><div class="banner-main"></div><div class="banner-sub"></div></div>
      <div class="hud-bottom">
        <div class="slots"></div>
        <div class="dodge-bar"><div class="dodge-fill"></div><span>ROLL</span></div>
      </div>`;
    parent.appendChild(this.root);
    const q = <T extends HTMLElement>(sel: string, el: ParentNode = this.root) => el.querySelector(sel) as T;

    this.plates = (['left', 'right'] as const).map((side) => {
      const root = q(`.plate-${side}`);
      return {
        root,
        hp: q('.hp-fill', root),
        chip: q('.hp-chip', root),
        hpText: q('.hp-text', root),
        mana: q('.mana-fill', root),
        buff: q('.mana-buff', root),
        buffTime: q('.mana-buff b', root),
        ult: q('.ult-fill', root),
        chipValue: 1,
        chipDelay: 0,
      };
    });
    this.plates[0].root.querySelector('.plate-name')!.textContent = 'You';
    this.timer = q('.timer');
    this.roundLabel = q('.round-label');
    for (const side of [0, 1]) {
      const row = q(`.pip-row[data-side="${side}"]`);
      for (let i = 0; i < CONFIG.match.roundsToWin; i++) {
        const pip = document.createElement('i');
        row.appendChild(pip);
        this.pips[side].push(pip);
      }
    }
    this.banner = q('.banner-main');
    this.bannerSub = q('.banner-sub');
    this.bannerArt = q('.banner-art');
    const stageRow = q('.plate-right .stage-pips');
    for (let i = 0; i < STAGE_COUNT; i++) this.stagePips.push(stageRow.appendChild(document.createElement('i')));
    this.stageName = q('.plate-right .stage-name');
    this.flash = q('.screen-flash');
    this.ultDim = q('.ult-dim');
    this.vignette = q('.vignette');
    this.crosshair = q('.crosshair');
    this.enemyTag = q('.enemy-tag');
    this.enemyTagFill = q('.enemy-tag-fill');
    this.arrow = q('.offscreen-arrow');
    this.godBadge = q('.god-badge');
    this.dodge = q('.dodge-fill');

    const slotRoot = q('.slots');
    SLOTS.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = `slot slot-${s.spell}`;
      el.innerHTML = `<div class="slot-icon">${spellIcon(s.spell)}</div><div class="slot-sweep"></div><div class="slot-time"></div><kbd>${KEY_LABELS[i]}</kbd><span class="slot-label">${s.label}</span>`;
      slotRoot.appendChild(el);
      this.slots.push({ spell: s.spell, root: el, sweep: q('.slot-sweep', el), time: q('.slot-time', el) });
      this.slotKeys.push(q('kbd', el));
    });
    this.bindEvents();
  }

  private plateHtml(side: 'left' | 'right'): string {
    return `
      <div class="plate plate-${side}">
        <div class="plate-head"><span class="plate-id"><span class="plate-name">Rival</span><small class="plate-title"></small></span><span class="hp-text">150</span></div>
        <div class="bar hp"><div class="hp-chip"></div><div class="hp-fill"></div></div>
        <div class="mana-row"><div class="bar mana"><div class="mana-fill"></div><i class="mana-mark"></i></div><span class="mana-buff" title="Golden ticket: bigger mana pool, double regen"><i>✦</i><b></b></span></div>
        <div class="bar ult"><div class="ult-fill"></div><span>ULT</span></div>
        ${side === 'right' ? '<div class="plate-stage"><span class="stage-pips"></span><span class="stage-name"></span></div>' : ''}
      </div>`;
  }

  /** Names (and optional epithets, e.g. a boss title) on the two health plates. */
  setNames(names: [string, string], titles: [string, string] = ['', '']): void {
    this.plates.forEach((p, i) => {
      p.root.querySelector('.plate-name')!.textContent = names[i];
      p.root.querySelector('.plate-title')!.textContent = titles[i];
    });
  }

  /** Relabel the spell slots, e.g. with controller buttons when a gamepad is in use. */
  setKeyLabels(labels: readonly string[]): void {
    this.slotKeys.forEach((kbd, i) => (kbd.textContent = labels[i] ?? ''));
  }

  show(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  /** Big centered text with a pop-in animation, optionally over an image (`art`: a resolved URL). */
  showBanner(text: string, sub = '', style = '', duration = 1.2, art: string | null = null): void {
    this.banner.textContent = text;
    this.bannerSub.textContent = sub;
    if (art) this.bannerArt.src = art;
    const box = this.banner.parentElement!;
    box.className = `banner show ${style}${art ? ' has-art' : ''}`;
    // Restart the CSS animation.
    void box.offsetWidth;
    box.style.setProperty('--dur', `${duration}s`);
    box.classList.add('animate');
  }

  private bindEvents(): void {
    const g = this.game;
    events.on('damage', (e) => {
      if (e.source === g.player && e.target !== g.player) this.hitMarker = 0.14;
      if (e.target === g.player) {
        this.hurt = Math.min(1, this.hurt + e.amount / 25);
        feel.screenFlash(0xff2a2a, Math.min(0.35, 0.08 + e.amount / 60));
      } else if (e.source === g.player && (e.amount >= 12 || e.kind === 'stun')) {
        // Landing a big hit flashes too, briefly and white.
        feel.screenFlash(0xffffff, Math.min(0.2, 0.06 + e.amount / 150));
      }
    });
    // Campaign fights name the boss on the round banners.
    const bossLine = () => (this.match.boss ? `${this.match.boss.name}, ${this.match.boss.title}` : '');
    events.on('roundIntro', (e) => {
      const last = this.match.wins.some((w) => w === CONFIG.match.roundsToWin - 1) && this.match.wins[0] === this.match.wins[1];
      this.showBanner(last ? 'Final Round' : `Round ${e.round}`, bossLine(), 'round', CONFIG.match.introTime);
    });
    events.on('countdown', (e) => this.showBanner(String(e.value), bossLine(), 'count', 0.7));
    events.on('roundStart', () => this.showBanner('Duel!', this.match.boss ? `vs ${this.match.boss.name}` : '', 'fight', 0.9));
    events.on('suddenDeath', () => this.showBanner('Sudden Death', 'The fire closes in', 'danger', 1.6));
    events.on('roundEnd', (e) => {
      const won = e.winner === g.player;
      const main = e.reason === 'time' ? 'Time!' : 'K.O.';
      const sub = !e.winner ? 'Draw' : won ? 'You take the round' : `${e.winner.name} takes the round`;
      this.showBanner(main, sub, won ? 'win' : e.winner ? 'lose' : 'round', CONFIG.match.roundEndTime);
    });
    events.on('castStart', (e) => {
      if (e.spell !== 'ultimate') return;
      this.dim = 1;
      if (e.wizard === g.player) g.rig.kickBack(1.8);
    });
    events.on('ultReady', (e) => {
      if (e.wizard === g.player) this.showBanner('Ultimate Ready', `Press ${this.slotKeys[4].textContent}`, 'ult', 1.1);
    });
    // Boss evolution: "STAGE 2" and the stage's name in the boss palette, over its concept art if any.
    events.on('bossEvolve', (e) => {
      const art = resolveImage(bossStagePortrait(e.boss.id, e.stage));
      this.showBanner(`Stage ${e.stage + 1}`, e.boss.stages[e.stage].name, 'stage', CONFIG.campaign.evolveTime + 0.6, art);
    });
    // A boss names its signature volley over its head.
    events.on('volley', (e) => {
      if (e.wizard === g.enemy) g.popups.spawn(tmp.copy(e.pos).setY(e.pos.y + 0.6), `${e.name}!`, 'boss');
    });
    events.on('ticketPickup', (e) => {
      if (e.wizard !== g.player) return;
      const regen = TK.regenMultiplier > 1 ? ` · ${TK.regenMultiplier}× regen` : '';
      const sub = e.refreshed ? 'Mana boost refreshed' : `+${Math.round((TK.maxManaMultiplier - 1) * 100)}% mana for ${TK.boostDuration} s${regen}`;
      this.showBanner('Golden Ticket!', sub, 'ticket', 1.3);
    });
    events.on('noMana', (e) => {
      if (e.wizard !== g.player) return;
      const bar = this.plates[0].mana.parentElement!;
      bar.classList.remove('flash');
      void bar.offsetWidth;
      bar.classList.add('flash');
    });
  }

  private set(key: string, el: HTMLElement, prop: 'text' | 'transform' | 'class' | 'style', value: string, styleProp = ''): void {
    const k = key + prop + styleProp;
    if (this.cache.get(k) === value) return;
    this.cache.set(k, value);
    if (prop === 'text') el.textContent = value;
    else if (prop === 'transform') el.style.transform = value;
    else if (prop === 'class') el.className = value;
    else el.style.setProperty(styleProp, value);
  }

  update(dt: number): void {
    const g = this.game;
    this.updatePlate(0, g.player, dt);
    this.updatePlate(1, g.enemy, dt);

    // Timer + rounds.
    const t = Math.ceil(this.match.timer);
    this.set('timer', this.timer, 'text', String(t));
    const danger = this.match.phase === 'fight' && this.match.timer < CONFIG.arena.suddenDeathAt;
    this.set('timerc', this.timer, 'class', danger ? 'timer danger' : 'timer');
    const fight = this.match.bossIndex >= 0 ? `Fight ${this.match.bossIndex + 1}/${BOSSES.length} · ` : '';
    this.set('round', this.roundLabel, 'text', `${fight}Round ${this.match.round}`);
    this.set('god', this.godBadge, 'class', CONFIG.debug.godMode ? 'god-badge on' : 'god-badge');
    for (const side of [0, 1]) {
      this.pips[side].forEach((pip, i) => this.set(`pip${side}${i}`, pip, 'class', i < this.match.wins[side] ? 'won' : ''));
    }

    const p = g.player;
    this.updateSlots(p);
    const dodgeReady = 1 - p.cd.dodge / (W.dodge.duration + W.dodge.cooldown);
    this.set('dodge', this.dodge, 'transform', `scaleX(${dodgeReady.toFixed(3)})`);

    // Crosshair hit marker.
    this.hitMarker = Math.max(0, this.hitMarker - dt);
    this.set('xh', this.crosshair, 'class', this.hitMarker > 0 ? 'crosshair hit' : 'crosshair');

    // Ultimate windup darkens the world, then the release flash takes over.
    this.dim = Math.max(0, this.dim - dt * 1.6);
    this.ultDim.style.opacity = (Math.min(1, this.dim * 1.5) * 0.55).toFixed(3);

    // Screen flash and vignette.
    this.flash.style.opacity = (feel.flash * 0.55).toFixed(3);
    this.set('flashc', this.flash, 'style', `#${feel.flashColor.getHexString()}`, 'background-color');
    this.hurt = Math.max(0, this.hurt - dt * 1.6);
    const low = p.alive && p.health / p.maxHealth < 0.3 ? 0.35 + 0.2 * Math.sin(performance.now() / 180) : 0;
    const v = Math.max(this.hurt * 0.8, low);
    this.vignette.style.opacity = v.toFixed(3);
    this.set('vig', this.vignette, 'class', p.stunned ? 'vignette stun' : 'vignette');
    if (p.stunned) this.vignette.style.opacity = '0.8';

    this.updateEnemyTag();
  }

  private updatePlate(i: number, w: Wizard, dt: number): void {
    const plate = this.plates[i];
    const hp = w.health / w.maxHealth;
    // The white chip trails behind the real health so big hits read clearly.
    if (hp < plate.chipValue) {
      plate.chipDelay -= dt;
      if (plate.chipDelay <= 0) plate.chipValue = Math.max(hp, plate.chipValue - dt * 0.9);
    } else {
      plate.chipValue = hp;
      plate.chipDelay = 0.45;
    }
    if (w.hitFlash > 0) plate.chipDelay = 0.45;
    this.set(`hp${i}`, plate.hp, 'transform', `scaleX(${hp.toFixed(4)})`);
    this.set(`chip${i}`, plate.chip, 'transform', `scaleX(${plate.chipValue.toFixed(4)})`);
    this.set(`hpt${i}`, plate.hpText, 'text', String(Math.ceil(w.health)));
    // A golden-ticket boost turns the bar gold and stretches it to the bigger max (styles.css).
    const boost = w.manaBoost;
    this.set(`mana${i}`, plate.mana, 'transform', `scaleX(${(w.mana / w.maxMana).toFixed(4)})`);
    this.set(`buft${i}`, plate.buffTime, 'text', boost > 0 ? String(Math.ceil(boost)) : '');
    this.set(`buf${i}`, plate.buff, 'class', `mana-buff${boost > 0 ? ' on' : ''}${boost > 0 && boost < 3 ? ' ending' : ''}`);
    const ult = w.ult / S.ultimate.chargeMax;
    this.set(`ult${i}`, plate.ult, 'transform', `scaleX(${ult.toFixed(4)})`);
    const staged = i === 1 && this.updateStages();
    const cls = `plate plate-${i === 0 ? 'left' : 'right'}${hp < 0.3 ? ' low' : ''}${ult >= 1 ? ' ult-ready' : ''}${w.hitFlash > 0 ? ' hit' : ''}${staged ? ' staged' : ''}${boost > 0 ? ' boosted' : ''}`;
    this.set(`plate${i}`, plate.root, 'class', cls);
  }

  /** Stage pips (passed, current, still to come) and the stage name under the boss's bars. False without a boss. */
  private updateStages(): boolean {
    const st = this.game.stages;
    const stage = st.current;
    if (!this.match.boss || !stage) return false;
    const evolving = st.evolving ? ' evolving' : '';
    this.stagePips.forEach((pip, i) => this.set(`spip${i}`, pip, 'class', i < st.stage ? 'done' : i === st.stage ? `on${evolving}` : ''));
    this.set('stagename', this.stageName, 'text', stage.name);
    return true;
  }

  private updateSlots(p: Wizard): void {
    for (const s of this.slots) {
      let frac = 0;
      let seconds = 0;
      let cost = 0;
      let ready = true;
      if (s.spell === 'ultimate') {
        frac = 1 - p.ult / S.ultimate.chargeMax;
        ready = frac <= 0;
      } else {
        const total = s.spell === 'bolt' ? S.bolt.fireInterval : S[s.spell].cooldown;
        seconds = p.cd[s.spell];
        frac = total > 0 ? seconds / total : 0;
        cost = S[s.spell].manaCost;
      }
      const noMana = p.mana < cost;
      const active = (s.spell === 'shield' && p.shielded) || p.cast?.spell === s.spell;
      const id = s.spell;
      this.set(`sw${id}`, s.sweep, 'style', `${(frac * 360).toFixed(1)}deg`, '--cd');
      this.set(`st${id}`, s.time, 'text', seconds > 0.25 && s.spell !== 'bolt' ? seconds.toFixed(seconds < 1 ? 1 : 0) : '');
      const cls = `slot slot-${s.spell}${frac > 0 && s.spell !== 'bolt' ? ' cooling' : ''}${noMana ? ' nomana' : ''}${active ? ' active' : ''}${s.spell === 'ultimate' && ready ? ' ready' : ''}`;
      this.set(`sc${id}`, s.root, 'class', cls);
    }
  }

  /** Small health bar over the rival, plus an edge arrow when they're off-screen. */
  private updateEnemyTag(): void {
    const g = this.game;
    const e = g.enemy;
    const cam = g.renderer.camera;
    tmp.copy(e.visual.root.position);
    // The tag rides above the current look, including a boss stage's growth (visual root scale).
    tmp.y += Math.max(2.45, e.visual.topHeight * e.visual.root.scale.y + 0.25);
    tmp.project(cam);
    const w = window.innerWidth, h = window.innerHeight;
    const behind = tmp.z > 1;
    const onScreen = !behind && Math.abs(tmp.x) < 1 && Math.abs(tmp.y) < 1;
    const showTag = onScreen && e.alive;
    this.set('tagv', this.enemyTag, 'class', showTag ? 'enemy-tag on' : 'enemy-tag');
    if (showTag) {
      const x = (tmp.x * 0.5 + 0.5) * w;
      const y = (-tmp.y * 0.5 + 0.5) * h;
      this.enemyTag.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      this.set('tagf', this.enemyTagFill, 'transform', `scaleX(${(e.health / e.maxHealth).toFixed(4)})`);
    }
    const showArrow = !onScreen && e.alive && this.match.phase === 'fight';
    this.set('arrv', this.arrow, 'class', showArrow ? 'offscreen-arrow on' : 'offscreen-arrow');
    if (showArrow) {
      let x = tmp.x, y = tmp.y;
      if (behind) {
        x = -x;
        y = -y;
      }
      const a = Math.atan2(y, x);
      const r = Math.min(w, h) * 0.42;
      const ax = w / 2 + Math.cos(a) * r;
      const ay = h / 2 - Math.sin(a) * r;
      this.arrow.style.transform = `translate3d(${ax.toFixed(1)}px, ${ay.toFixed(1)}px, 0) translate(-50%, -50%) rotate(${(-a).toFixed(3)}rad)`;
    }
  }
}
