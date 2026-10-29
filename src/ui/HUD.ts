import * as THREE from 'three';
import { CONFIG, type TeamPalette } from '../config';
import { resolveImage } from '../assets/AssetLoader';
import { bossStagePortrait } from '../assets/manifest';
import { STAGE_COUNT } from '../campaign/BossStages';
import { BOSSES, bossDisplayName, type BossFighter } from '../campaign/levels';
import { events } from '../core/events';
import { feel } from '../core/feel';
import type { Game } from '../core/Game';
import type { Match } from '../core/Match';
import type { SpellId } from '../spells/types';
import { REWARD_SPELLS, REWARD_SPELL_INFO, type RewardSpellId } from '../spells/rewardCatalog';
import type { Wizard } from '../wizard/Wizard';
import { rewardIcon, spellIcon } from './icons';

const W = CONFIG.wizard;
const S = CONFIG.spells;
const TK = CONFIG.tickets;
const LP = CONFIG.lifePacks;
const RS = CONFIG.rewardSpells;

/** "m:ss" for the gauntlet's fight clock. */
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

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
  label: HTMLElement;
}

/** A learned reward spell's slot in the HUD's second row. */
interface RewardSlot {
  spell: RewardSpellId;
  root: HTMLElement;
  sweep: HTMLElement;
  time: HTMLElement;
  /** The active-duration ring (an SVG rounded square, drawn by its dash length). */
  ring: SVGRectElement;
  key: HTMLElement;
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

/** Over-the-head health tag and its off-screen arrow, one per enemy (the rival, and a double fight's partner). */
interface EnemyTag {
  tag: HTMLElement;
  fill: HTMLElement;
  arrow: HTMLElement;
}

const tmp = new THREE.Vector3();
const tmpColor = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

/** The HUD accent variables (--rival, --rival-hi, --rival-lo) for a palette, as [name, value] pairs. */
export function rivalAccent(team: TeamPalette): [string, string][] {
  const c = tmpColor.setHex(team.spell);
  const hi = c.clone().lerp(WHITE, 0.5);
  const lo = c.clone().multiplyScalar(0.75);
  return [['--rival', `#${c.getHexString()}`], ['--rival-hi', `#${hi.getHexString()}`], ['--rival-lo', `#${lo.getHexString()}`]];
}

function setAccent(el: HTMLElement, team: TeamPalette | null): void {
  if (!team) for (const k of ['--rival', '--rival-hi', '--rival-lo']) el.style.removeProperty(k);
  else for (const [k, v] of rivalAccent(team)) el.style.setProperty(k, v);
}

/**
 * In-match HUD. Built once; per-frame updates only touch transforms, classes and changed text.
 * Plates: 0 the player (left), 1 the rival (right), 2 a double fight's partner (right, under the
 * rival, a little smaller, shown only while the partner fights), each enemy in its own palette.
 */
export class HUD {
  readonly root: HTMLElement;
  private readonly plates: Plate[];
  private readonly slots: Slot[] = [];
  private readonly slotKeys: HTMLElement[] = [];
  /** The second row: one slot per reward spell, shown once learned. */
  private readonly rewardSlots: RewardSlot[] = [];
  private readonly rewardRow: HTMLElement;
  /** Lock-On's reticle over the locked target. */
  private readonly reticle: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly roundLabel: HTMLElement;
  private readonly pips: HTMLElement[][] = [[], []];
  private readonly banner: HTMLElement;
  private readonly bannerSub: HTMLElement;
  private readonly bannerArt: HTMLImageElement;
  /** Boss stage pips and stage name on the enemy plates (indexed by plate; 0 is unused). */
  private readonly stagePips: HTMLElement[][] = [[], [], []];
  /** A boss plate's special-power chips (name, recharge fill), rebuilt when the boss changes. */
  private readonly powerChips: { boss: unknown; root: HTMLElement; chips: { el: HTMLElement; fill: HTMLElement }[] }[] = [];
  private readonly stageNames: HTMLElement[] = [];
  private readonly flash: HTMLElement;
  private readonly ultDim: HTMLElement;
  private dim = 0;
  private readonly vignette: HTMLElement;
  private readonly crosshair: HTMLElement;
  /** [rival, partner]. */
  private readonly tags: EnemyTag[] = [];
  private readonly godBadge: HTMLElement;
  /** Life packs left this fight (Boss Gauntlet), one icon each, under the player's bars. */
  private readonly packIcons: HTMLElement[] = [];
  private readonly packRow: HTMLElement;
  private readonly dodge: HTMLElement;
  private readonly dodgeLabel: HTMLElement;
  private readonly cache = new Map<string, string>();
  private hitMarker = 0;
  private healFlash = 0;
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
        <div class="plates-right">
          ${this.plateHtml('right')}
          ${this.plateHtml('right', true)}
        </div>
      </div>
      <div class="crosshair"><i></i><i></i><i></i><i></i></div>
      <div class="enemy-tag" data-i="0"><div class="enemy-tag-fill"></div></div>
      <div class="enemy-tag partner" data-i="1"><div class="enemy-tag-fill"></div></div>
      <div class="offscreen-arrow" data-i="0"></div>
      <div class="offscreen-arrow partner" data-i="1"></div>
      <div class="god-badge" title="God mode: no damage, unlimited mana, no cooldowns, ${CONFIG.debug.godPowerMultiplier}× damage (99 or ${CONFIG.debug.godHotkey} toggles)">God Mode</div>
      <div class="banner"><img class="banner-art" alt="" draggable="false"><div class="banner-main"></div><div class="banner-sub"></div></div>
      <div class="lock-reticle"><i></i><i></i><i></i><i></i><b>LOCK</b></div>
      <div class="hud-bottom">
        <div class="reward-slots"></div>
        <div class="slots"></div>
        <div class="dodge-bar"><div class="dodge-fill"></div><span>ROLL</span></div>
      </div>`;
    parent.appendChild(this.root);
    const q = <T extends HTMLElement>(sel: string, el: ParentNode = this.root) => el.querySelector(sel) as T;

    this.plates = ['.plate-left', '.plate-right:not(.plate-partner)', '.plate-partner'].map((sel) => {
      const root = q(sel);
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
    for (const i of [1, 2]) {
      const plate = this.plates[i].root;
      const row = q('.stage-pips', plate);
      for (let k = 0; k < STAGE_COUNT; k++) this.stagePips[i].push(row.appendChild(document.createElement('i')));
      this.stageNames[i] = q('.stage-name', plate);
      this.powerChips[i] = { boss: null, root: q('.plate-powers', plate), chips: [] };
    }
    this.flash = q('.screen-flash');
    this.ultDim = q('.ult-dim');
    this.vignette = q('.vignette');
    this.crosshair = q('.crosshair');
    for (const i of [0, 1]) {
      const tag = q(`.enemy-tag[data-i="${i}"]`);
      this.tags.push({ tag, fill: q('.enemy-tag-fill', tag), arrow: q(`.offscreen-arrow[data-i="${i}"]`) });
    }
    this.godBadge = q('.god-badge');
    this.packRow = q('.life-packs', this.plates[0].root);
    const icon = resolveImage('ui/life_pack.png');
    for (let i = 0; i < LP.maxPerFight; i++) {
      const el = document.createElement('i');
      if (icon) el.style.backgroundImage = `url("${icon}")`;
      else el.textContent = '♥';
      this.packRow.appendChild(el);
      this.packIcons.push(el);
    }
    this.dodge = q('.dodge-fill');
    this.dodgeLabel = q('.dodge-bar span');

    const slotRoot = q('.slots');
    SLOTS.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = `slot slot-${s.spell}`;
      el.innerHTML = `<div class="slot-icon">${spellIcon(s.spell)}</div><div class="slot-sweep"></div><div class="slot-time"></div><kbd>${KEY_LABELS[i]}</kbd><span class="slot-label">${s.label}</span>`;
      slotRoot.appendChild(el);
      this.slots.push({ spell: s.spell, root: el, sweep: q('.slot-sweep', el), time: q('.slot-time', el), label: q('.slot-label', el) });
      this.slotKeys.push(q('kbd', el));
    });
    this.rewardRow = q('.reward-slots');
    for (const id of REWARD_SPELLS) {
      const info = REWARD_SPELL_INFO[id];
      const el = document.createElement('div');
      el.className = `slot rslot rslot-${id}`;
      el.style.setProperty('--accent', info.color);
      el.title = `${info.name}: ${info.short}`;
      el.innerHTML = `<div class="slot-icon">${rewardIcon(id)}</div><div class="slot-sweep"></div>
        <svg class="slot-ring" viewBox="0 0 40 40" aria-hidden="true"><rect x="1.5" y="1.5" width="37" height="37" rx="8" pathLength="100"/></svg>
        <div class="slot-time"></div><kbd>${CONFIG.controls[id][0].replace(/^Key/, '')}</kbd>`;
      this.rewardRow.appendChild(el);
      this.rewardSlots.push({ spell: id, root: el, sweep: q('.slot-sweep', el), time: q('.slot-time', el), ring: el.querySelector('rect')!, key: q('kbd', el) });
    }
    this.reticle = q('.lock-reticle');
    this.bindEvents();
  }

  private plateHtml(side: 'left' | 'right', partner = false): string {
    return `
      <div class="plate plate-${side}${partner ? ' plate-partner' : ''}">
        <div class="plate-head"><span class="plate-id"><span class="plate-name">Rival</span><small class="plate-title"></small></span><span class="hp-text">150</span></div>
        <div class="bar hp"><div class="hp-chip"></div><div class="hp-fill"></div></div>
        <div class="mana-row"><div class="bar mana"><div class="mana-fill"></div><i class="mana-mark"></i></div><span class="mana-buff" title="Golden Tickets: +50% mana pool, refilled, for 15 s"><i>✦</i><b></b></span></div>
        <div class="bar ult"><div class="ult-fill"></div><span>ULT</span></div>
        ${side === 'right' ? '<div class="plate-stage"><span class="stage-pips"></span><span class="stage-name"></span></div><div class="plate-powers"></div>' : '<div class="life-packs" title="Life packs this fight"></div>'}
      </div>`;
  }

  /**
   * Names (and optional epithets, e.g. a boss title) on the health plates: player, rival, and a
   * double fight's partner. Missing entries are blank.
   */
  setNames(names: readonly string[], titles: readonly string[] = []): void {
    this.plates.forEach((p, i) => {
      p.root.querySelector('.plate-name')!.textContent = names[i] ?? '';
      p.root.querySelector('.plate-title')!.textContent = titles[i] ?? '';
    });
  }

  /** The partner's plate, tag and arrow in its own palette (null: back to the rival's). */
  setPartnerColors(team: TeamPalette | null): void {
    setAccent(this.plates[2].root, team);
    setAccent(this.tags[1].tag, team);
    setAccent(this.tags[1].arrow, team);
  }

  /** Relabel the spell slots, e.g. with controller buttons when a gamepad is in use. */
  setKeyLabels(labels: readonly string[]): void {
    this.slotKeys.forEach((kbd, i) => (kbd.textContent = labels[i] ?? ''));
  }

  /** Relabel the reward-spell slots (carpet, pump, vape, lock-on, breath), e.g. with D-pad arrows. */
  setRewardKeyLabels(labels: readonly string[]): void {
    this.rewardSlots.forEach((s, i) => (s.key.textContent = labels[i] ?? ''));
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
    // Campaign fights name the boss (both, in a double fight) on the round banners.
    const bossLine = () => (this.match.boss ? `${bossDisplayName(this.match.boss)}, ${this.match.boss.title}` : '');
    events.on('roundIntro', (e) => {
      // The gauntlet is one round, one life: name the fight instead.
      if (this.match.single) {
        this.showBanner(`Fight ${this.match.bossIndex + 1}`, bossLine(), 'round', CONFIG.match.introTime);
        return;
      }
      const last = this.match.wins.some((w) => w === CONFIG.match.roundsToWin - 1) && this.match.wins[0] === this.match.wins[1];
      this.showBanner(last ? 'Final Round' : `Round ${e.round}`, bossLine(), 'round', CONFIG.match.introTime);
    });
    events.on('countdown', (e) => this.showBanner(String(e.value), bossLine(), 'count', 0.7));
    events.on('roundStart', () => this.showBanner('Duel!', this.match.boss ? `vs ${bossDisplayName(this.match.boss)}` : '', 'fight', 0.9));
    events.on('suddenDeath', () => this.showBanner('Sudden Death', 'The fire closes in', 'danger', 1.6));
    events.on('fightCap', () => this.showBanner('The Fire Closes In', 'Finish it', 'danger', 1.8));
    events.on('roundEnd', (e) => {
      const won = e.winner === g.player;
      const boss = this.match.boss;
      if (this.match.single && boss) {
        const name = bossDisplayName(boss);
        this.showBanner('K.O.', won ? `${name} ${boss.partner ? 'fall' : 'falls'}` : 'You fall', won ? 'win' : 'lose', CONFIG.match.roundEndTime);
        return;
      }
      const main = e.reason === 'time' ? 'Time!' : 'K.O.';
      const pair = this.match.boss?.partner ? bossDisplayName(this.match.boss) : '';
      const sub = !e.winner ? 'Draw' : won ? 'You take the round' : pair ? `${pair} take the round` : `${e.winner.name} takes the round`;
      this.showBanner(main, sub, won ? 'win' : e.winner ? 'lose' : 'round', CONFIG.match.roundEndTime);
    });
    events.on('castStart', (e) => {
      if (e.spell !== 'ultimate') return;
      this.dim = 1;
      if (e.wizard === g.player) g.rig.kickBack(1.8);
    });
    events.on('ultReady', (e) => {
      // God mode keeps the Ultimate charged: no banner after every cast.
      if (e.wizard === g.player && !e.wizard.noCooldowns) this.showBanner('Ultimate Ready', `Press ${this.slotKeys[4].textContent}`, 'ult', 1.1);
    });
    // Boss evolution: "STAGE 2" and the stage's name in the boss palette, over its concept art if any.
    // In a double fight each boss changes stage on its own, so the banner says whose it is.
    events.on('bossEvolve', (e) => {
      // In a live fight the transformation cinematic has its own title card (BossCinematic).
      if (g.transformCinematics) return;
      const art = resolveImage(bossStagePortrait(e.boss.id, e.stage));
      const box = this.banner.parentElement!;
      setAccent(box, e.wizard === g.partner ? e.boss.palette : null);
      const stage = e.boss.stages[e.stage].name;
      const who = g.partnerActive ? `${e.wizard.name} · ` : '';
      this.showBanner(`${who}Stage ${e.stage + 1}`, stage, 'stage', CONFIG.campaign.evolveTime + 0.6, art);
    });
    // Every other banner is in the rival's colours.
    for (const ev of ['roundIntro', 'roundStart', 'roundEnd', 'suddenDeath', 'fightCap', 'ultReady', 'lifePackSpawn'] as const) {
      events.on(ev, () => setAccent(this.banner.parentElement!, null));
    }
    // A boss names its signature volley over its head.
    events.on('volley', (e) => {
      if (e.wizard.side === 1) g.popups.spawn(tmp.copy(e.pos).setY(e.pos.y + 0.6), `${e.name}!`, 'boss');
    });
    // ...and each special power as it starts.
    events.on('bossPower', (e) => {
      if (e.phase === 'cast' && e.wizard.side === 1) g.popups.spawn(tmp.copy(e.pos).setY(e.pos.y + 0.9), `${e.power.name}!`, 'boss');
    });
    events.on('ticketPickup', (e) => {
      if (e.wizard !== g.player) return;
      const regen = TK.regenMultiplier > 1 ? ` · ${TK.regenMultiplier}× regen` : '';
      const sub = e.refreshed ? 'Mana boost refreshed' : `+${Math.round((TK.maxManaMultiplier - 1) * 100)}% mana for ${TK.boostDuration} s${regen}`;
      this.showBanner('Golden Tickets!', sub, 'ticket', 1.3);
    });
    // Life packs: a banner the first time, a green "+HP" on pickup.
    events.on('lifePackSpawn', (e) => {
      if (!e.first) return;
      const more = e.left > 0 ? ` · ${e.left} more this fight` : '';
      this.showBanner('Life Pack!', `Grab it: +${Math.round(LP.heal * 100)}% health${more}`, 'lifepack', 1.6);
    });
    events.on('lifePackPickup', (e) => {
      g.popups.spawn(e.wizard.chest(tmp).setY(e.wizard.pos.y + 2), `+${Math.round(e.healed)} HP`, 'heal');
      this.healFlash = 0.6;
    });
    // Arena shifts: what the floor just grew, named where it is; a spring's healing as it lands.
    events.on('arenaShift', (e) => {
      const sh = e.shift;
      setAccent(this.banner.parentElement!, null);
      const sub = e.stage === 1 ? `${sh.pools.name} burn${sh.pools.slow !== undefined ? ' and slow' : ''} · the ${sh.spring.name} heals` : `${sh.vents.name} · the ${sh.spring.name} refills · the fire closes in`;
      this.showBanner('The Arena Shifts', sub, 'danger', 2.2);
      const label = (kind: 'pool' | 'spring' | 'vent', text: string, style: 'boss' | 'heal') => {
        for (const f of g.shifts.of(kind)) if (f.age === 0) g.popups.spawn(tmp.set(f.x, 1.4, f.z), text, style);
      };
      if (e.stage === 1) {
        label('pool', sh.pools.name, 'boss');
        label('spring', sh.spring.name, 'heal');
      } else label('vent', sh.vents.name, 'boss');
    });
    events.on('springHeal', (e) => {
      g.popups.spawn(e.wizard.chest(tmp).setY(e.wizard.pos.y + 1.9), `+${Math.round(e.amount)}`, 'heal');
      if (e.wizard === g.player) this.healFlash = Math.max(this.healFlash, 0.35);
    });
    // Reward spells: the vape cloud's healing, and the player plate glowing while it lasts.
    events.on('rewardHeal', (e) => {
      g.popups.spawn(e.wizard.chest(tmp).setY(e.wizard.pos.y + 1.9), `+${Math.round(e.amount)}`, 'heal');
      if (e.wizard === g.player) this.healFlash = Math.max(this.healFlash, 0.35);
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
    const duo = g.partnerActive;
    if (this.cache.get('duo') !== String(duo)) {
      this.cache.set('duo', String(duo));
      this.root.classList.toggle('duo', duo);
    }
    this.updatePlate(0, g.player, dt);
    this.updatePlate(1, g.enemy, dt);
    if (duo) this.updatePlate(2, g.partner, dt);
    else this.set('plate2', this.plates[2].root, 'class', 'plate plate-right plate-partner');

    // Timer + rounds. The gauntlet has no round clock: its fight clock counts up, there are no
    // round pips, and the label says what's at stake.
    const m = this.match;
    const single = m.single && m.boss !== null;
    if (this.cache.get('single') !== String(single)) {
      this.cache.set('single', String(single));
      this.root.classList.toggle('single', single);
    }
    if (single) {
      this.set('timer', this.timer, 'text', clock(m.elapsed));
      this.set('timerc', this.timer, 'class', m.capped ? 'timer clock danger' : 'timer clock');
      this.set('round', this.roundLabel, 'text', `Fight ${m.bossIndex + 1}/${BOSSES.length} · ${m.capped ? 'The fire closes in' : 'One life'}`);
    } else {
      this.set('timer', this.timer, 'text', String(Math.ceil(m.timer)));
      const danger = m.phase === 'fight' && m.timer < CONFIG.arena.suddenDeathAt;
      this.set('timerc', this.timer, 'class', danger ? 'timer danger' : 'timer');
      const fight = m.bossIndex >= 0 ? `Fight ${m.bossIndex + 1}/${BOSSES.length} · ` : '';
      this.set('round', this.roundLabel, 'text', `${fight}Round ${m.round}`);
    }
    // Life packs left this fight: still to come, on the floor now, gone.
    const lp = g.lifePacks;
    this.set('packrow', this.packRow, 'class', `life-packs${single ? ' on' : ''}`);
    if (single) {
      const gone = lp.spawned - (lp.pack.active ? 1 : 0);
      this.packIcons.forEach((el, i) => this.set(`pack${i}`, el, 'class', i < gone ? 'used' : i < lp.spawned ? 'live' : ''));
    }
    this.healFlash = Math.max(0, this.healFlash - dt);
    this.set('god', this.godBadge, 'class', CONFIG.debug.godMode ? 'god-badge on' : 'god-badge');
    for (const side of [0, 1]) {
      this.pips[side].forEach((pip, i) => this.set(`pip${side}${i}`, pip, 'class', i < this.match.wins[side] ? 'won' : ''));
    }

    const p = g.player;
    this.updateSlots(p);
    this.updateRewardSlots(p);
    this.updateReticle(p);
    const blink = p.staff?.blink;
    if (blink) {
      const ready = 1 - p.cd.blink / Math.max(0.001, blink.cooldown);
      this.set('dodge', this.dodge, 'transform', `scaleX(${Math.max(0, Math.min(1, ready)).toFixed(3)})`);
      this.set('dodgelabel', this.dodgeLabel, 'text', 'BLINK');
    } else {
      const dodgeReady = 1 - p.cd.dodge / (W.dodge.duration + W.dodge.cooldown);
      this.set('dodge', this.dodge, 'transform', `scaleX(${dodgeReady.toFixed(3)})`);
      this.set('dodgelabel', this.dodgeLabel, 'text', 'ROLL');
    }

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

    this.updateEnemyTag(0, g.enemy);
    this.updateEnemyTag(1, duo ? g.partner : null);
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
    const staged = i > 0 && this.updateStages(i, w);
    const side = i === 0 ? 'left' : i === 1 ? 'right' : 'right plate-partner';
    // A transforming boss's new bar sweeps up (BossStages refills it): the plate glows meanwhile.
    const refill = i > 0 && !!this.game.stagesOf(w)?.transforming;
    const healed = i === 0 && this.healFlash > 0;
    const cls = `plate plate-${side}${hp < 0.3 && !refill ? ' low' : ''}${ult >= 1 ? ' ult-ready' : ''}${w.hitFlash > 0 ? ' hit' : ''}${staged ? ' staged' : ''}${boost > 0 ? ' boosted' : ''}${refill ? ' refill' : ''}${healed ? ' healed' : ''}${w.pumped ? ' pumped' : ''}${w.alive ? '' : ' down'}`;
    this.set(`plate${i}`, plate.root, 'class', cls);
  }

  /** Stage pips (passed, current, still to come) and the stage name under a boss's bars. False without a boss. */
  private updateStages(i: number, w: Wizard): boolean {
    const st = this.game.stagesOf(w);
    const stage = st?.current;
    if (!this.match.boss || !st || !stage) return false;
    const evolving = st.evolving ? ' evolving' : '';
    this.stagePips[i].forEach((pip, k) => this.set(`spip${i}${k}`, pip, 'class', k < st.stage ? 'done' : k === st.stage ? `on${evolving}` : ''));
    this.set(`stagename${i}`, this.stageNames[i], 'text', stage.name);
    this.updatePowers(i, w, st.boss!, st.stage);
    return true;
  }

  /**
   * A boss's special powers under its stage row: one chip each, locked until its stage, filling up
   * while it recharges, lit when ready, flashing while it plays out.
   */
  private updatePowers(i: number, w: Wizard, boss: BossFighter, stage: number): void {
    const row = this.powerChips[i];
    if (row.boss !== boss) {
      row.boss = boss;
      row.root.textContent = '';
      row.chips = boss.powers.map((d) => {
        const el = document.createElement('span');
        el.title = d.name;
        el.innerHTML = `<i></i><b>${d.name}</b>`;
        row.root.appendChild(el);
        return { el, fill: el.querySelector('i') as HTMLElement };
      });
      for (let k = 0; k < 4; k++) {
        this.cache.delete(`pw${i}${k}class`);
        this.cache.delete(`pwf${i}${k}transform`);
      }
    }
    const pw = this.game.spells.powers;
    boss.powers.forEach((d, k) => {
      const chip = row.chips[k];
      const locked = d.from > stage;
      const cd = pw.cooldown(w, d);
      const firing = pw.firing(w, d);
      const state = locked ? 'locked' : firing ? 'firing' : cd > 0 ? 'charging' : 'ready';
      this.set(`pw${i}${k}`, chip.el, 'class', `pw ${state}`);
      const fill = locked ? 0 : firing ? 1 : 1 - cd / Math.max(1e-3, pw.recharge(d, stage));
      this.set(`pwf${i}${k}`, chip.fill, 'transform', `scaleX(${Math.max(0, Math.min(1, fill)).toFixed(3)})`);
    });
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
      if (s.spell === 'bolt') this.set('boltlabel', s.label, 'text', p.staff?.boltLabel ?? 'Bolt');
      this.set(`sw${id}`, s.sweep, 'style', `${(frac * 360).toFixed(1)}deg`, '--cd');
      this.set(`st${id}`, s.time, 'text', seconds > 0.25 && s.spell !== 'bolt' ? seconds.toFixed(seconds < 1 ? 1 : 0) : '');
      const cls = `slot slot-${s.spell}${frac > 0 && s.spell !== 'bolt' ? ' cooling' : ''}${noMana ? ' nomana' : ''}${active ? ' active' : ''}${s.spell === 'ultimate' && ready ? ' ready' : ''}`;
      this.set(`sc${id}`, s.root, 'class', cls);
    }
  }

  /**
   * The second row: a slot per learned reward spell (hidden until learned), with its key, cooldown
   * sweep, mana-locked state and a ring that runs down while its effect lasts.
   */
  private updateRewardSlots(p: Wizard): void {
    let shown = 0;
    for (const s of this.rewardSlots) {
      const id = s.spell;
      const learned = p.learned.has(id);
      if (learned) shown++;
      if (!learned) {
        this.set(`rc${id}`, s.root, 'class', `slot rslot rslot-${id} unlearned`);
        continue;
      }
      const S = RS[id];
      const cd = p.rcd[id];
      const frac = S.cooldown > 0 ? cd / S.cooldown : 0;
      const act = this.rewardActive(p, id);
      const noMana = !p.infiniteMana && p.mana < S.manaCost;
      const busy = !p.canAct && !(id === 'carpet' && p.riding);
      this.set(`rsw${id}`, s.sweep, 'style', `${(frac * 360).toFixed(1)}deg`, '--cd');
      this.set(`rring${id}`, s.ring as unknown as HTMLElement, 'style', `${(act * 100).toFixed(1)} 100`, 'stroke-dasharray');
      const secs = act > 0 ? act * S.duration : cd;
      this.set(`rst${id}`, s.time, 'text', act > 0 || cd > 0.25 ? secs.toFixed(secs < 1 ? 1 : 0) : '');
      const cls = `slot rslot rslot-${id}${cd > 0 ? ' cooling' : ''}${noMana ? ' nomana' : ''}${act > 0 ? ' active' : ''}${busy && act <= 0 ? ' busy' : ''}`;
      this.set(`rc${id}`, s.root, 'class', cls);
    }
    this.set('rrow', this.rewardRow, 'class', `reward-slots${shown ? ' on' : ''}`);
  }

  /** How much of reward spell `id`'s effect is left for `p` (1 just cast .. 0 over). */
  private rewardActive(p: Wizard, id: RewardSpellId): number {
    switch (id) {
      case 'carpet':
        return p.carpetTime / RS.carpet.duration;
      case 'pump':
        return p.pumpTime / RS.pump.duration;
      case 'lockon':
        return p.lockTime / RS.lockon.duration;
      case 'breath':
        return p.breathTime / RS.breath.duration;
      case 'vape': {
        let left = 0;
        for (const sm of this.game.arena.smokes) if (sm.owner === p) left = Math.max(left, 1 - sm.age / sm.life);
        return left;
      }
    }
  }

  /** Lock-On: a green reticle on the enemy your bolts will home in on. */
  private updateReticle(p: Wizard): void {
    const target = p.lockedOn && p.alive ? this.game.spells.rewards.lockTarget(p) : null;
    this.set('ret', this.reticle, 'class', `lock-reticle${target ? ' on' : ''}`);
    if (!target) return;
    target.chest(tmp).project(this.game.renderer.camera);
    if (tmp.z > 1) {
      this.set('ret', this.reticle, 'class', 'lock-reticle');
      return;
    }
    const x = (tmp.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-tmp.y * 0.5 + 0.5) * window.innerHeight;
    this.reticle.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
  }

  /** Small health bar over enemy `k` (0 the rival, 1 the partner), plus an edge arrow when off-screen. */
  private updateEnemyTag(k: number, e: Wizard | null): void {
    const g = this.game;
    const { tag, fill, arrow } = this.tags[k];
    const base = k === 0 ? '' : ' partner';
    if (!e) {
      this.set(`tagv${k}`, tag, 'class', `enemy-tag${base}`);
      this.set(`arrv${k}`, arrow, 'class', `offscreen-arrow${base}`);
      return;
    }
    const cam = g.renderer.camera;
    tmp.copy(e.visual.root.position);
    // The tag rides above the current look, including a boss stage's growth (visual root scale).
    tmp.y += Math.max(e.tagHeight, e.visual.topHeight * e.visual.root.scale.y + 0.25);
    tmp.project(cam);
    const w = window.innerWidth, h = window.innerHeight;
    const behind = tmp.z > 1;
    const onScreen = !behind && Math.abs(tmp.x) < 1 && Math.abs(tmp.y) < 1;
    const showTag = onScreen && e.alive;
    this.set(`tagv${k}`, tag, 'class', `enemy-tag${base}${showTag ? ' on' : ''}`);
    if (showTag) {
      const x = (tmp.x * 0.5 + 0.5) * w;
      const y = (-tmp.y * 0.5 + 0.5) * h;
      tag.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      this.set(`tagf${k}`, fill, 'transform', `scaleX(${(e.health / e.maxHealth).toFixed(4)})`);
    }
    const showArrow = !onScreen && e.alive && this.match.phase === 'fight';
    this.set(`arrv${k}`, arrow, 'class', `offscreen-arrow${base}${showArrow ? ' on' : ''}`);
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
      arrow.style.transform = `translate3d(${ax.toFixed(1)}px, ${ay.toFixed(1)}px, 0) translate(-50%, -50%) rotate(${(-a).toFixed(3)}rad)`;
    }
  }
}
