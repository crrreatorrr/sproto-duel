import { describe, expect, it } from 'vitest';
import { decodeEvent, encodeEvent, EventPlayer, EventRecorder, NET_EVENT_NAMES, type EventWorld } from './events';

interface W { seat: number }
interface V { x: number; y: number; z: number }
const wizards: W[] = [{ seat: 0 }, { seat: 1 }];
const world: EventWorld<W, V> = {
  seatOf: (w) => w.seat,
  wizardAt: (s) => wizards[s] ?? null,
  vec: (x, y, z) => ({ x, y, z }),
};

describe('net events', () => {
  it('round-trips a damage event with seats and vectors', () => {
    const enc = encodeEvent('damage', { target: wizards[1], source: wizards[0], amount: 12.345, point: { x: 1.234, y: 1.2, z: -3.3 }, kind: 'bolt' }, world)!;
    const back = decodeEvent(JSON.parse(JSON.stringify(enc)), world)!;
    expect(back.name).toBe('damage');
    expect(back.payload.target).toBe(wizards[1]);
    expect(back.payload.source).toBe(wizards[0]);
    expect(back.payload.amount).toBe(12.35);
    expect(back.payload.point).toEqual({ x: 1.23, y: 1.2, z: -3.3 });
    expect(back.payload.kind).toBe('bolt');
  });

  it('keeps nulls (no source, no winner) and booleans', () => {
    const ko = decodeEvent(encodeEvent('roundEnd', { winner: null, reason: 'time' }, world), world)!;
    expect(ko.payload).toEqual({ winner: null, reason: 'time' });
    const blk = decodeEvent(encodeEvent('block', { wizard: wizards[0], pos: { x: 0, y: 1, z: 0 }, perfect: true, spell: 'stun' }, world), world)!;
    expect(blk.payload.perfect).toBe(true);
    expect(decodeEvent(encodeEvent('suddenDeath', {}, world), world)?.payload).toEqual({});
  });

  it('uses the existing gunshot event for missile launches on the wire', () => {
    const event = encodeEvent('skinLaunch', {
      wizard: wizards[0], kind: 'bolt', skin: 'missile', pos: { x: 0, y: 1, z: 0 },
    }, world);
    expect(decodeEvent(event, world)?.payload.skin).toBe('bullet');
  });

  it('skips events that are not replicated, and malformed ones', () => {
    expect(encodeEvent('bossEvolve', {}, world)).toBeNull();
    expect(decodeEvent([999], world)).toBeNull();
    expect(decodeEvent([NET_EVENT_NAMES.indexOf('jump'), 5, [0, 0, 0]], world)).toBeNull(); // no seat 5
    expect(decodeEvent([NET_EVENT_NAMES.indexOf('jump'), 0], world)).toBeNull();
  });

  it('plays each event once across repeated, overlapping and lost batches', () => {
    const rec = new EventRecorder(world);
    const seen: string[] = [];
    const player = new EventPlayer(world, (name, p) => seen.push(`${name}:${(p.round ?? p.value) as number}`));
    rec.record('roundIntro', { round: 1 });
    rec.record('countdown', { value: 3 });
    const b1 = rec.take()!;
    rec.record('countdown', { value: 2 });
    const b2 = rec.take()!;
    rec.record('countdown', { value: 1 });
    rec.record('roundStart', { round: 1 });
    const b3 = rec.take()!;
    expect(rec.take()).toBeNull();
    player.play(b1);
    player.play(b1); // resent
    player.play(b3); // b2 lost: skipped
    player.play(b2); // late: already past it
    expect(seen).toEqual(['roundIntro:1', 'countdown:3', 'countdown:1', 'roundStart:1']);
  });
});
