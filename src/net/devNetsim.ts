/**
 * Dev only (`npm run dev`, `?netsim=<one-way latency ms>`): Online Duel against an in-page
 * FakeArenaServer and a scripted opponent, so host mode can be played and tuned in one tab. You
 * are always the host; the bot is a guest that sees only snapshots (it circles, aims at you and
 * fires) and reports a RESULT from the replicated match phase, like a real guest.
 */
import { CONFIG } from '../config';
import { FakeArenaServer } from './FakeArenaServer';
import type { IntentFrame } from './intent';
import { OnlineSession, type OnlineLobby } from './OnlineSession';
import { realScheduler } from './transport';

export function netsimLobby(latencyMs: number): OnlineLobby {
  const server = new FakeArenaServer(realScheduler, { latencyMs, jitterMs: latencyMs * 0.25 });
  server.nextHostSeat = 0;
  const me = server.lobby({ userId: 'netsim-you', username: 'You' });
  const startBot = (room: string | null) => {
    const N = CONFIG.net;
    const bot = new OnlineSession(server.lobby({ userId: 'netsim-bot', username: `Bot (${latencyMs} ms)` }), {
      scheduler: realScheduler, staff: 'duel_staff_sproto', inputDelayTicks: N.inputDelayTicks, maxInputLagTicks: N.maxInputLagTicks,
      interpDelayMs: N.interpDelayMs, extrapolateMaxMs: N.extrapolateMaxMs, tickMs: CONFIG.sim.fixedDt * 1000,
    });
    let tick = 0;
    let rounds = 0;
    let lastPhase = '';
    const timer = setInterval(() => {
      bot.update();
      if (bot.state === 'ended') return clearInterval(timer);
      if (bot.state !== 'playing') return;
      tick++;
      const snap = bot.snapshots.newest;
      const target = snap?.wizards[0];
      const self = snap?.wizards[1];
      const phase = snap?.match.phase ?? '';
      if (phase !== lastPhase) {
        if (phase === 'roundEnd') rounds++;
        if (phase === 'matchEnd' && snap) {
          const [a, b] = snap.match.wins;
          bot.sendResult({ winnerSeat: a === b ? null : a > b ? 0 : 1, wins: [a, b], rounds });
        }
        lastPhase = phase;
      }
      const a = tick / 90;
      let facing = 0;
      if (target && self) facing = Math.atan2(target.pos[0] - self.pos[0], target.pos[2] - self.pos[2]);
      const frame: IntentFrame = {
        tick,
        mx: Math.round(Math.cos(a) * 100),
        mz: Math.round(Math.sin(a) * 100),
        facing: Math.round(((((facing % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 65535),
        aim: target ? [Math.round(target.pos[0] * 100), Math.round((target.pos[1] + 1.2) * 100), Math.round(target.pos[2] * 100)] : [0, 120, 0],
        held: 0,
        press: (tick % 24 === 0 ? 1 : 0) | (tick % 200 === 100 ? 2 : 0) | (tick % 300 === 150 ? 4 : 0) | (tick % 170 === 85 ? 32 : 0),
      };
      bot.queueInput(frame);
    }, 1000 / 60);
    if (room) void bot.joinRoom(room);
    else void bot.quickMatch();
  };
  return {
    selfId: me.selfId,
    connect: () => me.connect(),
    quickMatch() {
      setTimeout(() => startBot(null), 600);
      return me.quickMatch();
    },
    async createRoom() {
      const r = await me.createRoom();
      setTimeout(() => startBot(r.code), 1500);
      return r;
    },
    joinRoom: (code) => me.joinRoom(code),
    cancel: () => me.cancel(),
  };
}
