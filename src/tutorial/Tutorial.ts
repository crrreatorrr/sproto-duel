/**
 * Practice: a playable tutorial against a training dummy. It is a real match on the sim under
 * Local Versus rules (even stats, nothing reported), with the dummy's seat driven from here and
 * the fight kept open: the round clock never runs down and nobody can be knocked out. The lessons
 * (lessons.ts) cover Bolts, mana, Blast, the roll, the Shield and its perfect reflect, and Golden
 * Tickets; each completes by doing it. No sim code knows about any of this.
 */
import { CONFIG } from '../config';
import type { Game } from '../core/Game';
import { padGlyph } from '../core/Gamepad';
import type { IntentSource } from '../input/IntentSource';
import { ONE, type SimWorld } from '../sim-core';
import { LessonRun, type LessonKeys } from './lessons';

const DT = CONFIG.sim.fixedDt;
/** Seconds between the dummy's single bolts in the lessons where it fires. */
const DUMMY_FIRE_EVERY = 2.2;
/** The ticket lesson's pickup lands this far (m) from the player, toward the middle of the arena. */
const TICKET_DISTANCE = 6;
const q = (v: number) => v / ONE;

const keyLabel = (code: string) => code.replace(/^Key|^Digit/, '').replace(/(Left|Right)$/, '');

/** The lesson texts' key names on the device in use. */
export function lessonKeys(device: 'kbm' | 'gamepad', style: Parameters<typeof padGlyph>[1]): LessonKeys {
  if (device === 'gamepad') {
    const b = CONFIG.gamepad.bindings;
    return { bolt: padGlyph(b.bolt[0], style), blast: padGlyph(b.blast[0], style), dodge: padGlyph(b.dodge[0], style), shield: padGlyph(b.shield[0], style), move: 'Left stick' };
  }
  const K = CONFIG.controls;
  return { bolt: 'left click', blast: 'Right click', dodge: keyLabel(K.dodge[0]), shield: keyLabel(K.shield[0]), move: 'W A S D' };
}

export class Tutorial {
  active = false;
  run: LessonRun | null = null;
  /**
   * Set when the last lesson ends (lessons done by doing them, and how many there are): the App
   * picks it up on its next frame, since this runs inside the game's tick.
   */
  result: { earned: number; count: number } | null = null;
  /** The dummy's seat: Game ticks it before the sim samples the seat's intent. */
  readonly source: IntentSource = { kind: 'replay', tick: () => this.tick() };
  private world: SimWorld | null = null;
  private fireTimer = DUMMY_FIRE_EVERY;
  private readonly root: HTMLDivElement;
  private readonly els: Record<'step' | 'title' | 'text' | 'bar' | 'status' | 'hint', HTMLElement>;
  private readonly shown: Record<string, string> = {};
  private flash = 0;

  constructor(private readonly game: Game, parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'lesson hidden';
    this.root.setAttribute('role', 'status');
    this.root.innerHTML = `
      <div class="lesson-step"></div>
      <h3 class="lesson-title"></h3>
      <p class="lesson-text"></p>
      <div class="lesson-bar"><i></i></div>
      <div class="lesson-status"></div>
      <div class="lesson-hint"></div>`;
    parent.appendChild(this.root);
    const el = (c: string) => this.root.querySelector(c) as HTMLElement;
    this.els = { step: el('.lesson-step'), title: el('.lesson-title'), text: el('.lesson-text'), bar: el('.lesson-bar i'), status: el('.lesson-status'), hint: el('.lesson-hint') };
  }

  /** Start the lessons on the match the game just began (Game.sim). */
  begin(): void {
    const d = this.game.sim;
    if (!d) return;
    const w = d.world;
    this.world = w;
    this.active = true;
    this.result = null;
    this.fireTimer = DUMMY_FIRE_EVERY;
    this.run = new LessonRun(q(w.wizards[0].mana));
    // What the player did, straight from the sim's events (read only: nothing here feeds back).
    const facts = () => (this.active && this.world === w && this.run ? this.run.facts : null);
    w.events.on('damage', (e) => {
      const f = facts();
      if (!f || e.w !== 1 || e.o !== 0) return;
      if (e.s === 'bolt') f.boltHits++;
      else if (e.s === 'blast') f.blastHits++;
    });
    w.events.on('dodge', (e) => {
      const f = facts();
      if (f && e.w === 0) f.rolls++;
    });
    w.events.on('block', (e) => {
      const f = facts();
      if (!f || e.w !== 0) return;
      if (e.f) f.perfects++;
      else f.blocks++;
    });
    w.events.on('ticketPickup', (e) => {
      const f = facts();
      if (f && e.w === 0) f.tickets++;
    });
    this.root.classList.remove('hidden');
    this.paint(true);
  }

  /** Stop and hide (the match is over or was left). */
  end(): void {
    this.active = false;
    this.result = null;
    this.world = null;
    this.run = null;
    this.root.classList.add('hidden');
  }

  /** Skip the current lesson (Enter). */
  skip(): void {
    const w = this.world;
    if (!this.active || !w || !this.run || this.game.actionsLocked) return;
    this.run.skip(q(w.wizards[0].mana));
    this.changed();
  }

  /** Once per fixed tick, before the sim steps. */
  private tick(): void {
    const g = this.game;
    const w = this.world;
    const run = this.run;
    if (!this.active || !w || !run || g.sim?.world !== w) return;
    const p = w.wizards[0], e = w.wizards[1];
    // The lesson is never cut short: no round clock, and nobody falls.
    w.match.timer = w.rules.roundTime;
    if (p.health * 20 < p.maxHealth * 7) p.health = p.maxHealth;
    if (e.health * 2 < e.maxHealth) e.health = e.maxHealth;
    const lesson = run.lesson;
    const fighting = w.match.phase === 'fight';
    // Golden Tickets only in their lesson, and then one within reach.
    if (!lesson?.ticket) {
      w.tickets.list.length = 0;
      w.tickets.spawnTimer = 6000;
    } else if (fighting && w.tickets.list.length === 0) this.placeTicket(w);
    // The dummy: stands, faces the player, and in some lessons fires one bolt at a time.
    const gp = g.player, ge = g.enemy;
    const it = ge.intent;
    it.move.set(0, 0, 0);
    it.sprint = it.holdBolt = false;
    it.facing = Math.atan2(gp.pos.x - ge.pos.x, gp.pos.z - ge.pos.z);
    ge.aimPoint.set(gp.pos.x, gp.pos.y + 1.2, gp.pos.z);
    if (lesson?.dummyFires && fighting) {
      this.fireTimer -= DT;
      if (this.fireTimer <= 0) {
        this.fireTimer = DUMMY_FIRE_EVERY;
        it.press('bolt');
      }
    }
    if (fighting && run.update(DT, q(p.mana))) this.changed();
    if (this.flash > 0) this.flash -= DT;
    this.paint(false);
  }

  private changed(): void {
    const run = this.run;
    if (!run) return;
    this.fireTimer = DUMMY_FIRE_EVERY;
    this.flash = 0.6;
    if (run.done) {
      const result = { earned: run.earned, count: run.count };
      this.end();
      this.result = result;
      return;
    }
    this.paint(true);
  }

  /** A ticket a few steps from the player, toward the middle (or wherever nearby the floor is open). */
  private placeTicket(w: SimWorld): void {
    const p = w.wizards[0];
    const px = q(p.pos.x), pz = q(p.pos.z);
    const toMid = Math.atan2(-px, -pz);
    for (let i = 0; i < 16; i++) {
      // Fan out from "toward the middle", then closer in.
      const a = toMid + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.4;
      const d = TICKET_DISTANCE - Math.floor(i / 8) * 2;
      const x = Math.round((px + Math.sin(a) * d) * ONE), z = Math.round((pz + Math.cos(a) * d) * ONE);
      if (!w.tickets.validSpot(x, z)) continue;
      const id = w.tickets.nextId++;
      w.tickets.list.push({ id, x, z, age: 0 });
      w.events.push('ticketSpawn', -1, '', id, -1, x, Math.round(CONFIG.tickets.hoverHeight * ONE), z);
      return;
    }
  }

  private set(key: keyof Tutorial['els'], value: string): void {
    if (this.shown[key] === value) return;
    this.shown[key] = value;
    if (key === 'bar') this.els.bar.style.transform = `scaleX(${value})`;
    else this.els[key].textContent = value;
  }

  private paint(full: boolean): void {
    const run = this.run;
    const lesson = run?.lesson;
    if (!run || !lesson) return;
    if (full) {
      const pad = this.game.input.pad;
      const keys = lessonKeys(pad.device === 'gamepad' ? 'gamepad' : 'kbm', pad.style);
      const text = lesson.text(keys);
      this.set('step', `Practice · ${run.index + 1} / ${run.count}`);
      this.set('title', lesson.title);
      this.set('text', text.charAt(0).toUpperCase() + text.slice(1));
      this.set('hint', pad.device === 'gamepad' ? 'Pause to leave Practice' : 'Enter: skip this step · Esc: pause');
    }
    this.set('bar', lesson.progress(run.facts).toFixed(3));
    this.set('status', lesson.status ? lesson.status(run.facts) : '');
    this.root.classList.toggle('flash', this.flash > 0);
  }
}
