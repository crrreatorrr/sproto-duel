import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { LESSONS, LessonRun, type LessonKeys } from './lessons';

const W = CONFIG.wizard;
const KEYS: LessonKeys = { bolt: 'left click', blast: 'Right click', dodge: 'C', shield: 'Q', move: 'W A S D' };
const DT = 1 / 60;

describe('Practice lessons', () => {
  it('cover mana, Blast, the roll, the Shield and its perfect reflect, and Golden Tickets', () => {
    expect(LESSONS.map((l) => l.id)).toEqual(['bolt', 'mana', 'recover', 'blast', 'roll', 'shield', 'perfect', 'ticket']);
    for (const l of LESSONS) {
      const text = l.text(KEYS);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/undefined|NaN/);
    }
    // The texts quote the live tuning, not copies of it.
    expect(LESSONS[2].text(KEYS)).toContain(`${W.manaRegen} a second`);
    expect(LESSONS[4].text(KEYS)).toContain(`${W.dodge.cooldown} s`);
    expect(LESSONS[3].text(KEYS)).toContain(`${CONFIG.spells.blast.manaCost} mana`);
  });

  it('each lesson completes by doing what it asks, in order', () => {
    const run = new LessonRun(W.maxMana);
    const step = (mana: number) => run.update(DT, mana);
    // Bolt: eight hits.
    run.facts.boltHits = 7;
    expect(step(W.maxMana)).toBe(false);
    run.facts.boltHits = 8;
    expect(step(W.maxMana - 40)).toBe(true);
    expect(run.lesson?.id).toBe('mana');
    // Mana: run it down to half.
    expect(step(W.maxMana * 0.6)).toBe(false);
    expect(run.lesson!.progress(run.facts)).toBeGreaterThan(0.5);
    expect(step(W.maxMana * 0.5)).toBe(true);
    // Recover: a Blast's worth must come back from the lowest point (firing on only lowers it).
    expect(step(W.maxMana * 0.4)).toBe(false);
    expect(step(W.maxMana * 0.4 + 20)).toBe(false);
    expect(step(W.maxMana * 0.4 + 31)).toBe(true);
    expect(run.lesson?.id).toBe('blast');
    run.facts.blastHits = 1;
    expect(step(100)).toBe(true);
    expect(run.lesson?.dummyFires).toBe(true);
    run.facts.rolls = 2;
    expect(step(100)).toBe(true);
    // Shield: any block counts, a perfect one too.
    run.facts.perfects = 1;
    expect(step(100)).toBe(true);
    expect(run.lesson?.id).toBe('perfect');
    // Perfect: plain blocks do not finish it, but say so.
    run.facts.blocks = 3;
    expect(step(100)).toBe(false);
    expect(run.lesson!.status!(run.facts)).toContain('Blocked 3');
    run.facts.perfects = 1;
    expect(step(100)).toBe(true);
    expect(run.lesson?.ticket).toBe(true);
    run.facts.tickets = 1;
    expect(step(100)).toBe(true);
    expect(run.done).toBe(true);
    expect(run.earned).toBe(LESSONS.length);
    expect(step(100)).toBe(false);
  });

  it('every lesson can be finished from wherever the one before was skipped', () => {
    // Skip "Mana" with a full bar: "Let it refill" has nothing to refill and must not hang.
    const run = new LessonRun(W.maxMana);
    run.skip(W.maxMana);
    run.skip(W.maxMana);
    expect(run.lesson?.id).toBe('recover');
    expect(run.update(DT, W.maxMana)).toBe(true);
    expect(run.lesson?.id).toBe('blast');
    // Entered a little short of full: it completes as the bar tops up.
    const b = new LessonRun(W.maxMana);
    b.skip(W.maxMana);
    b.skip(W.maxMana - 10);
    expect(b.update(DT, W.maxMana - 10)).toBe(false);
    expect(b.update(DT, W.maxMana)).toBe(true);
    // Entered already below half: "Mana" is done at once.
    const c = new LessonRun(W.maxMana);
    c.skip(W.maxMana * 0.3);
    expect(c.lesson?.id).toBe('mana');
    expect(c.update(DT, W.maxMana * 0.3)).toBe(true);
  });

  it('skipping and the perfect lesson\'s time limit move on without counting as done', () => {
    const run = new LessonRun(W.maxMana);
    for (let i = 0; i < 6; i++) run.skip(W.maxMana);
    expect(run.lesson?.id).toBe('perfect');
    expect(run.earned).toBe(0);
    const limit = run.lesson!.giveUpAfter!;
    let changed = false;
    for (let t = 0; t < limit + 1 && !changed; t += 0.5) changed = run.update(0.5, 100);
    expect(changed).toBe(true);
    expect(run.lesson?.id).toBe('ticket');
    expect(run.earned).toBe(0);
    run.skip(100);
    expect(run.done).toBe(true);
    run.skip(100);
    expect(run.index).toBe(LESSONS.length);
  });
});
