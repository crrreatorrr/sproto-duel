/**
 * The Practice lessons: what each one asks for and when it is done. Pure (no DOM, no three), so the
 * rules are unit-tested; src/tutorial/Tutorial.ts feeds it what happened in the sim and draws it.
 */
import { CONFIG } from '../config';

const S = CONFIG.spells;
const W = CONFIG.wizard;
const TK = CONFIG.tickets;

export type LessonId = 'bolt' | 'mana' | 'recover' | 'blast' | 'roll' | 'shield' | 'perfect' | 'ticket';

/** What a lesson is told about each tick (all about the player unless named otherwise). */
export interface LessonFacts {
  /** Seconds since the lesson began. */
  time: number;
  mana: number;
  /** Counted since the lesson began. */
  boltHits: number;
  blastHits: number;
  rolls: number;
  blocks: number;
  perfects: number;
  tickets: number;
  /** Lowest mana seen since the lesson began. */
  lowMana: number;
}

/** Key names for the texts: the active device's own. */
export interface LessonKeys {
  bolt: string;
  blast: string;
  dodge: string;
  shield: string;
  move: string;
}

export interface Lesson {
  id: LessonId;
  title: string;
  text(k: LessonKeys): string;
  /** Progress toward the goal, 0..1 (1 completes the lesson). */
  progress(f: LessonFacts): number;
  /** Shown under the text while it is in progress ("3 / 8 hits"). */
  status?(f: LessonFacts): string;
  /** The dummy fires single bolts at the player during this lesson. */
  dummyFires?: boolean;
  /** A Golden Tickets pickup is placed in front of the player. */
  ticket?: boolean;
  /** Seconds after which the lesson moves on by itself (hard ones should not hold anyone up). */
  giveUpAfter?: number;
}

const BOLT_HITS = 8;
const ROLLS = 2;
const LOW_MANA = Math.round(W.maxMana * 0.5);
/** Mana that must come back in the recover lesson: one Blast's worth and a bit. */
const RECOVER = S.blast.manaCost + 6;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const boost = Math.round((TK.maxManaMultiplier - 1) * 100);

export const LESSONS: readonly Lesson[] = [
  {
    id: 'bolt',
    title: 'Bolt',
    text: (k) => `Aim at the dummy and hold ${k.bolt} to fire Bolts. ${k.move} to move.`,
    progress: (f) => clamp01(f.boltHits / BOLT_HITS),
    status: (f) => `${Math.min(BOLT_HITS, f.boltHits)} / ${BOLT_HITS} hits`,
  },
  {
    id: 'mana',
    title: 'Mana',
    text: (k) => `Every spell spends mana, the blue bar. Keep holding ${k.bolt}: held fire spends it faster than it comes back. Run it down to half.`,
    progress: (f) => clamp01((W.maxMana - f.lowMana) / (W.maxMana - LOW_MANA)),
    status: (f) => `Mana ${Math.round(f.mana)} / ${W.maxMana}`,
  },
  {
    id: 'recover',
    title: 'Let it refill',
    text: () => `Now let go. Mana returns at ${W.manaRegen} a second, so two seconds off the trigger pays for a Blast. Out of mana, Bolts only trickle out and nothing else casts.`,
    // Done once a Blast's worth has come back, or the bar is as good as full (a player who skipped
    // the lesson before arrives with nothing to refill).
    progress: (f) => (f.mana >= W.maxMana - 1 ? 1 : clamp01((f.mana - f.lowMana) / RECOVER)),
    status: (f) => `Mana ${Math.round(f.mana)} / ${W.maxMana}`,
  },
  {
    id: 'blast',
    title: 'Blast',
    text: (k) => `${k.blast} throws a Blast: slow, but it hits hard and splashes. It costs ${S.blast.manaCost} mana and takes ${S.blast.cooldown} s to recharge. Hit the dummy with one.`,
    progress: (f) => clamp01(f.blastHits),
  },
  {
    id: 'roll',
    title: 'Roll',
    text: (k) => `The dummy shoots back now. ${k.dodge} rolls the way you are moving and nothing can hit you for a moment. It needs ${W.dodge.cooldown} s between rolls (the ROLL bar), so pick your moment. Roll twice.`,
    progress: (f) => clamp01(f.rolls / ROLLS),
    status: (f) => `${Math.min(ROLLS, f.rolls)} / ${ROLLS} rolls`,
    dummyFires: true,
  },
  {
    id: 'shield',
    title: 'Shield',
    text: (k) => `${k.shield} raises a Shield for ${S.shield.duration} s (${S.shield.manaCost} mana). Block one of the dummy's Bolts.`,
    progress: (f) => clamp01(f.blocks + f.perfects),
    dummyFires: true,
  },
  {
    id: 'perfect',
    title: 'Perfect Shield',
    text: (k) => `Raise the Shield in the last ${S.shield.perfectWindow} s before a spell lands and it is a PERFECT: the spell flies back at its caster, faster and stronger. Wait for the Bolt, then press ${k.shield} just before it arrives.`,
    progress: (f) => clamp01(f.perfects),
    status: (f) => (f.blocks > 0 ? `Blocked ${f.blocks}: a touch later for the reflect` : ''),
    dummyFires: true,
    giveUpAfter: 60,
  },
  {
    id: 'ticket',
    title: 'Golden Tickets',
    text: () => `Golden Tickets appear during a fight, under a gold beam. Walk into them: your mana grows by ${boost}% and refills at once for ${TK.boostDuration} s. The rival wants them too.`,
    progress: (f) => clamp01(f.tickets),
    ticket: true,
  },
];

export function emptyFacts(mana: number): LessonFacts {
  return { time: 0, mana, boltHits: 0, blastHits: 0, rolls: 0, blocks: 0, perfects: 0, tickets: 0, lowMana: mana };
}

/** Where the lessons stand: which one is up, what has happened in it, and whether all are done. */
export class LessonRun {
  index = 0;
  facts: LessonFacts;
  /** Lessons finished by doing them (not skipped or timed out). */
  earned = 0;

  constructor(mana: number, private readonly lessons: readonly Lesson[] = LESSONS) {
    this.facts = emptyFacts(mana);
  }

  get lesson(): Lesson | null {
    return this.lessons[this.index] ?? null;
  }

  get done(): boolean {
    return this.index >= this.lessons.length;
  }

  get count(): number {
    return this.lessons.length;
  }

  /** One tick: `mana` now and `dt` seconds. Returns true when the lesson changed. */
  update(dt: number, mana: number): boolean {
    const l = this.lesson;
    if (!l) return false;
    const f = this.facts;
    f.time += dt;
    f.mana = mana;
    if (mana < f.lowMana) f.lowMana = mana;
    if (l.progress(f) >= 1) {
      this.earned++;
      this.next(mana);
      return true;
    }
    if (l.giveUpAfter !== undefined && f.time >= l.giveUpAfter) {
      this.next(mana);
      return true;
    }
    return false;
  }

  /** Move on without finishing (the skip key). */
  skip(mana: number): void {
    if (!this.done) this.next(mana);
  }

  private next(mana: number): void {
    this.index++;
    this.facts = emptyFacts(mana);
  }
}
