import * as THREE from 'three';
import type { App } from '../App';
import { CONFIG } from '../config';
import { events, type GameEvents } from '../core/events';
import type { Game } from '../core/Game';
import { ONLINE, QUICK } from '../core/rules';
import { EventPlayer, EventRecorder, NET_EVENT_NAMES } from '../net/events';
import { FakeArenaServer } from '../net/FakeArenaServer';
import type { IntentFrame } from '../net/intent';
import { OnlineController } from '../net/OnlineController';
import { OnlineSession } from '../net/OnlineSession';
import { ManualScheduler } from '../net/transport';
import { ReplaySource } from '../input/ReplaySource';
import { captureSnapshot } from '../net/snapshot';
import { encodeSnapshot, type EncodedSnapshot } from '../net/state';
import type { Wizard } from '../wizard/Wizard';
import type { QAHarness } from './QAHarness';

const DT = CONFIG.sim.fixedDt;
const N = CONFIG.net;

function session(server: FakeArenaServer, clock: ManualScheduler, id: string): OnlineSession {
  return new OnlineSession(server.lobby({ userId: id, username: id }), {
    scheduler: clock, staff: 'duel_staff_sproto', inputDelayTicks: N.inputDelayTicks, maxInputLagTicks: N.maxInputLagTicks,
    interpDelayMs: N.interpDelayMs, extrapolateMaxMs: N.extrapolateMaxMs, tickMs: DT * 1000, inputEveryTicks: N.snapEveryTicks,
  });
}

export function registerNetScenarios(qa: QAHarness, game: Game, app: App): void {
  qa.add('net.loopback-host', async (c) => {
    // This page hosts; a scripted guest plays seat 1 over an 80 ms (+2 ms jitter) loopback link
    // through the fake referee. Two rounds are played to a RESULT and a verified OUTCOME.
    const clock = new ManualScheduler();
    const server = new FakeArenaServer(clock, { latencyMs: 80, jitterMs: 2 });
    server.nextHostSeat = 0;
    const host = session(server, clock, 'host');
    const guest = session(server, clock, 'guest');
    void host.quickMatch();
    void guest.quickMatch();
    for (let i = 0; i < 60 && (host.state !== 'playing' || guest.state !== 'playing'); i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (host.state === 'accepting') host.accept();
      if (guest.state === 'accepting') guest.accept();
      clock.advance(50);
    }
    c.expect(host.state === 'playing' && guest.state === 'playing' && host.isHost, `sessions ${host.state}/${guest.state}`);
    const ctl = new OnlineController(game, app.match, host, clock);
    const savedState = app.state;
    const results: string[] = [];
    const offResult = events.on('matchEnd', () => results.push('matchEnd'));
    let guestTick = 0, rounds = 0, lastPhase = '';
    const start = game.enemy.pos.clone();
    try {
      ctl.begin(host.start!);
      app.state = 'playing'; // keeps the menu's attract AI off the player
      game.qaMode = false; // Match flow runs (its tick hook)
      app.match.startMatch(null, ONLINE);
      const m = app.match;
      const tick = () => {
        // The guest: scripted input from what its snapshots show; RESULT from the replicated phase.
        const snap = guest.snapshots.newest;
        const me = snap?.wizards[1], foe = snap?.wizards[0];
        guestTick++;
        const f: IntentFrame = {
          tick: guestTick, mx: guestTick % 240 < 120 ? 90 : -90, mz: 40, facing: 0,
          aim: foe ? [Math.round(foe.pos[0] * 100), Math.round((foe.pos[1] + 1.2) * 100), Math.round(foe.pos[2] * 100)] : [0, 120, 0],
          held: 0, press: guestTick % 30 === 0 ? 1 : 0,
        };
        if (me && foe) f.facing = Math.round(((Math.atan2(foe.pos[0] - me.pos[0], foe.pos[2] - me.pos[2]) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * 65535);
        guest.queueInput(f);
        const phase = snap?.match.phase ?? '';
        if (phase !== lastPhase) {
          if (phase === 'roundEnd') rounds++;
          if (phase === 'matchEnd' && snap) guest.sendResult({ winnerSeat: snap.match.wins[0] > snap.match.wins[1] ? 0 : 1, wins: snap.match.wins, rounds });
          lastPhase = phase;
        }
        game.tick(DT);
        clock.advance(DT * 1000);
        host.update();
        guest.update();
      };
      // Round 1: 6 s of fighting, then the guest's wizard is knocked out; same again for round 2.
      for (let round = 1; round <= 2; round++) {
        let guard = 0;
        while (m.phase !== 'fight' && guard++ < 600) tick();
        for (let i = 0; i < 6 / DT; i++) tick();
        game.spells.dealDamage(game.enemy, game.player, 1e4, game.enemy.pos, 'bolt');
        guard = 0;
        while (m.phase === 'roundEnd' && guard++ < 600) tick();
      }
      for (let i = 0; i < 90 && !host.outcome; i++) tick();
      c.expect(results.length === 1, `matchEnd ${results.length}x`);
      c.expect(ctl.snapshots > 300 && guest.snapshots.size > 0, `snapshots sent ${ctl.snapshots}`);
      c.expect(host.remoteInput.lastApplied > 200, `guest frames applied ${host.remoteInput.lastApplied}`);
      c.expect(game.enemy.stats.casts > 3, `the guest's wizard cast ${game.enemy.stats.casts} times`);
      c.expect(game.enemy.pos.distanceTo(start) > 0.5 || rounds > 0, 'the guest wizard never moved');
      c.expect(host.outcome?.status === 'verified' && guest.outcome?.status === 'verified', `outcome ${host.outcome?.status}/${guest.outcome?.reason}`);
      c.expect(host.outcome?.paid.host === 20, `paid ${JSON.stringify(host.outcome?.paid)}`);
      c.note(`${ctl.snapshots} snapshots, ${server.matches[0]?.relayed.input ?? '-'} inputs relayed, delay ${host.remoteInput.delay} ticks, underruns ${host.remoteInput.underruns}`);
    } finally {
      offResult();
      ctl.stop();
      host.leave();
      guest.leave();
      game.qaMode = true;
      app.state = savedState;
      app.match.rules = QUICK;
      app.match.phase = 'menu';
    }
  });

  qa.add('net.replica-plays', async (c) => {
    // A recorded host fight (snapshots + events, seat 0 = player, seat 1 = enemy) is streamed by a
    // host session to this game playing seat 1 as a replica: state, projectiles and events arrive,
    // and this game's input goes back to the host.
    c.setup({ player: [0, -7], enemy: [0, 7] });
    const seats: Wizard[] = [game.player, game.enemy];
    const world = { seatOf: (w: Wizard) => seats.indexOf(w), wizardAt: (s: number) => seats[s] ?? null, vec: (x: number, y: number, z: number) => new THREE.Vector3(x, y, z) };
    const rec = new EventRecorder(world);
    const offs = NET_EVENT_NAMES.map((name) => events.on(name as keyof GameEvents, (p) => rec.record(name, p as unknown as Record<string, unknown>)));
    const seat0 = game.controllers[0];
    const recorded: EncodedSnapshot[] = [];
    let finalSeat1Health = 0;
    try {
      game.controllers[0] = new ReplaySource(game.player, (w, t) => {
        game.enemy.chest(w.aimPoint);
        if (t % 20 === 0) w.intent.press('bolt');
      });
      game.controllers[1] = new ReplaySource(game.enemy, (w, t) => {
        game.player.chest(w.aimPoint);
        w.intent.move.set(t > 180 ? 0.5 : 0, 0, 0);
        if (t % 45 === 0) w.intent.press('bolt');
      });
      for (let i = 0; i < 240; i++) {
        game.tick(DT);
        if (i % 2 === 1) {
          const snap = captureSnapshot(game, app.match, i + 1, -1, seats);
          const ev = rec.take();
          if (ev) snap.ev = ev;
          recorded.push(encodeSnapshot(snap));
        }
      }
      finalSeat1Health = game.enemy.health;
    } finally {
      for (const off of offs) off();
      game.controllers[0] = seat0;
      game.controllers[1] = null;
    }
    c.expect(finalSeat1Health < CONFIG.wizard.maxHealth, 'the recorded fight dealt no damage to seat 1');

    const clock = new ManualScheduler();
    const server = new FakeArenaServer(clock, { latencyMs: 40 });
    server.nextHostSeat = 0;
    const hostS = session(server, clock, 'host');
    const guestS = session(server, clock, 'guest');
    void hostS.quickMatch();
    void guestS.quickMatch();
    for (let i = 0; i < 60 && guestS.state !== 'playing'; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (hostS.state === 'accepting') hostS.accept();
      if (guestS.state === 'accepting') guestS.accept();
      clock.advance(50);
    }
    c.expect(guestS.state === 'playing' && !guestS.isHost && guestS.seat === 1, `guest ${guestS.state} seat ${guestS.seat}`);
    const ctl = new OnlineController(game, app.match, guestS, clock);
    let popups = 0, maxProjectiles = 0;
    const spawn = game.popups.spawn.bind(game.popups);
    game.popups.spawn = (...a: Parameters<typeof spawn>) => {
      popups++;
      spawn(...a);
    };
    try {
      ctl.begin(guestS.start!);
      c.expect(game.role === 'replica' && ctl.seats[1] === game.player, 'not a seat-1 replica');
      app.match.prepareReplica(ONLINE);
      for (const enc of recorded) {
        hostS.sendSnapshot(enc);
        for (let k = 0; k < 2; k++) {
          game.player.intent.move.set(0, 0, 1);
          game.tick(DT);
          clock.advance(DT * 1000);
          ctl.frame();
          maxProjectiles = Math.max(maxProjectiles, game.spells.pool.active.length);
        }
      }
      for (let k = 0; k < 30; k++) {
        clock.advance(DT * 1000);
        ctl.frame();
      }
      c.expect(ctl.snapshots >= recorded.length - 2, `applied ${ctl.snapshots} of ${recorded.length} snapshots`);
      c.expect(Math.abs(game.player.health - finalSeat1Health) < 0.2, `replica health ${game.player.health} vs host ${finalSeat1Health}`);
      c.expect(maxProjectiles > 0, 'no projectile ever showed on the replica');
      c.expect(popups > 0, 'no damage popups from the re-emitted events');
      c.expect(hostS.remoteInput.depth > 0 || hostS.remoteInput.lastApplied >= 0, "the host got none of the replica's input");
      c.note(`${ctl.snapshots} snapshots, ${popups} popups, up to ${maxProjectiles} projectiles`);
    } finally {
      game.popups.spawn = spawn;
      ctl.stop();
      hostS.leave();
      guestS.leave();
      app.match.rules = QUICK;
      app.match.phase = 'menu';
    }
  });

  qa.add('net.events-reemit', (c) => {
    // Events recorded on a host, replayed through the wire format, reach the same listeners:
    // the same number of damage popups and the same event names in order.
    c.setup({ player: [0, -7], enemy: [0, 7] });
    const seats: Wizard[] = [game.player, game.enemy];
    const world = { seatOf: (w: Wizard) => seats.indexOf(w), wizardAt: (s: number) => seats[s] ?? null, vec: (x: number, y: number, z: number) => new THREE.Vector3(x, y, z) };
    const rec = new EventRecorder(world);
    const seen: string[] = [];
    const offs = NET_EVENT_NAMES.map((name) => events.on(name as keyof GameEvents, (p) => {
      seen.push(name);
      rec.record(name, p as unknown as Record<string, unknown>);
    }));
    let popups = 0;
    const spawn = game.popups.spawn.bind(game.popups);
    game.popups.spawn = (...a: Parameters<typeof spawn>) => {
      popups++;
      spawn(...a);
    };
    try {
      c.aimAt(game.player, game.enemy);
      c.aimAt(game.enemy, game.player);
      game.player.intent.press('bolt');
      c.step(0.4);
      game.enemy.intent.press('blast');
      game.player.intent.press('jump');
      c.step(1.2);
      for (const off of offs) off();
      const live = { popups, names: [...seen] };
      c.expect(live.names.includes('damage') && live.names.includes('cast'), `no fight happened: ${live.names.join(',')}`);
      const batch = JSON.parse(JSON.stringify(rec.take()));
      popups = 0;
      const replayed: string[] = [];
      const offs2 = NET_EVENT_NAMES.map((name) => events.on(name as keyof GameEvents, () => replayed.push(name)));
      new EventPlayer(world, (name, payload) => events.emit(name as keyof GameEvents, payload as never)).play(batch);
      for (const off of offs2) off();
      c.expect(JSON.stringify(replayed) === JSON.stringify(live.names), `replayed ${replayed.length} events, recorded ${live.names.length}`);
      c.expect(popups === live.popups, `popups: live ${live.popups}, replayed ${popups}`);
      c.note(`${live.names.length} events, ${live.popups} popups, ${JSON.stringify(batch).length} bytes`);
    } finally {
      for (const off of offs) off();
      game.popups.spawn = spawn;
    }
  });
}
