// Echo Guardians: server-driven AI companions, summoned from soul-signs
// around the rally banner. Each bot is an ordinary entry in game.players —
// same HP, same regen, same revives, same scoreboard — puppeted here instead
// of by a websocket. Every action routes through the SAME validated handlers
// a human client drives (onHit / onExplode / onSuperCast / onInteract), so
// the anti-cheat caps and phase gates apply to bots automatically, and every
// client renders them through the ordinary remote-player path (plus the
// snapshot `bt` flag for the phantom tint). Deterministic by design: time
// only comes from game.t — never Date.now() — so the test suite can simulate
// raids with companions on the fake clock.
//
// The one thing bots NEVER do is the mechanics: capsule/key/brick pickups and
// chest loot are gated on !p.bot in game.js, and target selection here skips
// warded enemies and blisters. Their job is damage, revives, and class utility.
import {
  ARENA, PLAYER, ENC, SUPER, CLASS_SUPER, WEAPONS, GRENADE, BOTS, MAX_PLAYERS,
} from '../shared/constants.js';

const dxz = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rand = (a, b) => a + Math.random() * (b - a);
const rnd2 = (v) => Math.round(v * 100) / 100;
const norm2 = (x, z) => { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; };
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

let nextBotN = 1, nextSignN = 1;

export class BotManager {
  constructor(game) {
    this.game = game;
    this.brains = new Map(); // botId -> brain
    this.signs = new Map();  // signId -> { name, cls, p } — LOBBY + banner only
    this.blasts = [];        // scheduled server-resolved explosions { at, by, kind, p }
    this.swarms = [];        // homing-payload damage schedules (nova shards / embers)
    this.prevSt = 'LOBBY';
    this.prevShield = true;
    // squad blackboard: revive claims (downedId -> botId) and the warlock
    // nova stagger (two novas back to back waste the second one's add clear)
    this.board = { revive: new Map(), novaAt: 0 };
  }

  // ---------- summoning ----------

  // One soul-sign per unsummoned roster echo, ringed around the planted
  // banner. Re-derived whenever the roster's presence changes.
  refreshSigns() {
    this.signs.clear();
    const g = this.game;
    if (!g.banner || g.enc.st !== 'LOBBY') return;
    const present = new Set([...g.players.values()].map(p => p.name));
    const free = BOTS.roster.filter(r => !present.has(r.name));
    free.forEach((r, i) => {
      const a = (i / Math.max(1, free.length)) * Math.PI * 2 + 0.7;
      let x = g.banner.p[0] + Math.sin(a) * BOTS.signR;
      let z = g.banner.p[2] + Math.cos(a) * BOTS.signR;
      const rr = Math.hypot(x, z), max = ARENA.radius - 1.5;
      if (rr > max) { x *= max / rr; z *= max / rr; }
      this.signs.set('sg' + (nextSignN++), { name: r.name, cls: r.cls, p: [x, 0, z] });
    });
  }

  signsSnapshot() {
    if (this.game.enc.st !== 'LOBBY') return [];
    return [...this.signs.entries()].map(([id, s]) => ({ id, name: s.name, cls: s.cls, p: s.p.map(rnd2) }));
  }

  // An interact near a sign consumes it (returns true even when the circle is
  // full, so the press doesn't fall through to other interactions).
  trySummon(p) {
    const g = this.game;
    if (g.enc.st !== 'LOBBY' || p.bot) return false; // echoes don't call echoes
    for (const [id, s] of this.signs) {
      if (dxz(p.pos, s.p) > BOTS.summonR) continue;
      if (g.players.size >= MAX_PLAYERS) { g.toast('The circle is full.', 'warn'); return true; }
      this.signs.delete(id);
      const entry = BOTS.roster.find(r => r.name === s.name);
      const bot = g.addPlayer('bot' + (nextBotN++), s.name, s.cls, true, entry.weapons);
      bot.pos = [s.p[0], 0, s.p[2]];
      bot.yaw = Math.atan2(-s.p[0], -s.p[2]); // rises facing the arena heart
      this.brains.set(bot.id, this.mkBrain(bot, entry));
      // clients play the materialization flare off this; the toast names them
      g.send(null, { t: 'summon', id: bot.id, name: s.name, cls: s.cls, p: [...bot.pos] });
      g.toast(`${s.name} answers.`, 'good');
      return true;
    }
    return false;
  }

  // A human claims the slot: the newest echo yields (server/main.js join gate).
  dismissNewest() {
    let nb = null;
    // >= so same-tick summon ties resolve to the latest insertion (map order)
    for (const b of this.brains.values()) if (!nb || b.summonedAt >= nb.summonedAt) nb = b;
    if (!nb) return false;
    this.game.removePlayer(nb.p.id); // routes back through onRemoved below
    return true;
  }

  onRemoved(id) {
    this.brains.delete(id);
    for (const [tid, bid] of this.board.revive) {
      if (tid === id || bid === id) this.board.revive.delete(tid);
    }
    this.refreshSigns(); // a dismissed echo's sign returns while the banner stands
  }

  onWorldReset() {
    this.blasts.length = 0;
    this.swarms.length = 0;
    this.board.revive.clear();
    this.board.novaAt = 0;
    this.signs.clear();
    this.prevSt = 'LOBBY';
    this.prevShield = true;
    for (const b of this.brains.values()) { b.y = 0; b.vy = 0; b.target = null; b.wanderP = null; }
  }

  mkBrain(p, entry) {
    const t = this.game.t;
    return {
      p, entry, summonedAt: t,
      wkey: entry.weapons[0],
      shots: WEAPONS[entry.weapons[0]].mag, reloadUntil: 0, nextShotAt: t + rand(0.3, 1),
      target: null, retargetAt: 0, burstLeft: 0,
      grenadeAt: t + rand(6, 14), rocketAt: 0,
      goldenAskAt: 0, novaPlanAt: 0, wardPlanAt: 0,
      strafeDir: Math.random() < 0.5 ? 1 : -1, strafeFlipAt: 0,
      y: 0, vy: 0,        // server-written hop arc (sweep/lock dodges)
      wanderAt: 0, wanderP: null,
    };
  }

  // ---------- main tick ----------

  tick(dt) {
    const g = this.game, e = g.enc;
    if (e.st !== this.prevSt) { this.onPhase(e.st); this.prevSt = e.st; }
    // FINAL surge collapse exposes the boss without a state change — the
    // hoarded supers answer the shieldBreak like a player would
    if (this.prevShield && !e.shield && e.st === 'FINAL') this.onBossExposed();
    this.prevShield = e.shield;
    if (this.brains.size) {
      this.assignRevives();
      for (const b of this.brains.values()) {
        const p = b.p;
        if (p.dead || p.downed) { b.y = 0; b.vy = 0; p.pos[1] = 0; p.revive = null; continue; }
        this.think(b, dt);
      }
    }
    this.resolveBlasts();
    this.resolveSwarms();
  }

  onPhase(st) {
    if (st === 'LOBBY' || st === 'WIPE' || st === 'VICTORY') {
      this.blasts.length = 0;
      this.swarms.length = 0;
      this.board.revive.clear();
    }
    if (st === 'DAMAGE') this.onBossExposed();
  }

  // The burn window opens: the gunslinger spends golden at once, the warlocks
  // nova the hull (staggered), the sentinels plan a dome once the team gathers.
  onBossExposed() {
    const t = this.game.t;
    this.board.novaAt = t;
    for (const b of this.brains.values()) {
      if (b.p.cls === 'gunslinger') b.goldenAskAt = t + rand(0.3, 1.2);
      else if (b.p.cls === 'voidcaller') b.novaPlanAt = t + rand(0.5, 1.5);
      else if (b.p.cls === 'sentinel') b.wardPlanAt = t + rand(2.5, 4.5);
    }
  }

  // ---------- squad blackboard: revives ----------

  assignRevives() {
    const g = this.game, board = this.board;
    for (const [tid, bid] of board.revive) {
      const q = g.players.get(tid), b = this.brains.get(bid);
      if (!q || !q.downed || !b || !g.alive(b.p)) board.revive.delete(tid);
    }
    for (const q of g.players.values()) {
      if (!q.downed || board.revive.has(q.id)) continue;
      // a human already channeling this revive needs no echo on top
      let humanOnIt = false;
      for (const r of g.players.values()) {
        if (r.revive && r.revive.target === q.id && !this.brains.has(r.id)) { humanOnIt = true; break; }
      }
      if (humanOnIt) continue;
      const busy = new Set(board.revive.values());
      let best = null, bd = Infinity;
      for (const b of this.brains.values()) {
        if (busy.has(b.p.id) || !g.alive(b.p)) continue;
        // medics lean in: a sentinel a few meters further still wins the claim
        const d = dxz(b.p.pos, q.pos) - (b.p.cls === 'sentinel' ? 5 : 0);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) board.revive.set(q.id, best.p.id);
    }
  }

  myClaim(b) {
    for (const [tid, bid] of this.board.revive) {
      if (bid !== b.p.id) continue;
      const q = this.game.players.get(tid);
      if (q && q.downed) return q;
    }
    return null;
  }

  // ---------- per-bot think ----------

  think(b, dt) {
    const g = this.game, p = b.p;
    // the cast flourish roots the caster (the client roots humans the same way)
    if (p.castUntil > g.t) { p.vel = [0, 0, 0]; return; }
    const mv = this.movement(b, dt);
    this.integrate(b, mv, dt);
    this.act(b);
  }

  // Movement intent, by priority. Returns { d: [x, z], sprint, jump }.
  movement(b, dt) {
    const g = this.game, p = b.p, e = g.enc;
    // mid-revive channel: hold your ground
    if (p.revive) return { d: [0, 0] };
    // OBLIT shelter beats everything — the downed survive the blast anyway.
    // Only shelter that will SURVIVE the blast counts (a dome expiring
    // mid-warning sheltered nobody once).
    if (e.st === 'OBLIT') {
      let w = null, wd = Infinity;
      for (const well of g.wells.values()) {
        if (well.until < e.ends + 0.2) continue;
        const d = dxz(p.pos, well.p);
        if (d < wd) { wd = d; w = well; }
      }
      if (w) {
        if (dxz(p.pos, w.p) > w.r - 1.2) return this.seek(b, w.p, true);
        return { d: [0, 0] };
      }
      // no lasting well: a sentinel's dome shelters obliteration (wardLogic).
      // The save-titan plants itself ON the fireteam; everyone else gathers.
      const titan = this.wardTitan();
      if (titan === p) {
        const h = this.nearestHuman(p);
        if (h && dxz(p.pos, h.pos) > 3) return this.seek(b, h.pos, true);
        return { d: [0, 0] };
      }
      if (titan && dxz(p.pos, titan.pos) > 2.5) return this.seek(b, titan.pos, true);
      return { d: [0, 0] };
    }
    // claimed revive: close in, then start the channel
    const claim = this.myClaim(b);
    if (claim) {
      if (dxz(p.pos, claim.pos) < PLAYER.reviveRange - 1.2) {
        if (!p.revive) g.onInteract(p);
        return { d: [0, 0] };
      }
      return this.seek(b, claim.pos, true);
    }
    if (e.st === 'LOBBY') return this.lobbyMove(b);
    if (e.st === 'VICTORY') return this.loiter(b, [0, 0, 6], 4);
    // the save-titan pre-positions: a damage phase running out with no refuge
    // woken means the dome is about to be the only shelter — be standing ON
    // the fireteam before the warning even hits
    if (e.st === 'DAMAGE' && e.ends - g.t < 3.5 && p === this.wardTitan()
      && ![...g.wells.values()].some(w => w.kind === 'refuge')) {
      const h = this.nearestHuman(p);
      if (h && dxz(p.pos, h.pos) > 3) return this.seek(b, h.pos, true);
      return { d: [0, 0] };
    }
    // sweep: stone shadows while pillars stand, timed hops once they're dust
    if (e.sweep) {
      if (!e.pillarsDown) {
        if (!g.losBlocked([0, 0.9, 0], [p.pos[0], 0.9, p.pos[2]])) {
          const spot = this.shadowSpot(p);
          if (spot) return this.seek(b, spot, true);
        }
        return { d: [0, 0] }; // sheltered — keep firing from cover
      }
      return { ...this.combatMove(b), jump: this.sweepJump(b) };
    }
    return this.combatMove(b);
  }

  lobbyMove(b) {
    const g = this.game, p = b.p;
    // the fireteam gathers on the plate — every body must stand on it to start
    let humanOnPlate = false;
    for (const q of g.players.values()) {
      if (!q.bot && g.alive(q) && dxz(q.pos, [0, 0, 0]) < ENC.readyRadius) { humanOnPlate = true; break; }
    }
    if (humanOnPlate) {
      const slot = this.plateSlot(b);
      if (dxz(p.pos, slot) > 0.5) return this.seek(b, slot, true);
      return { d: [0, 0] };
    }
    // rally at the standard once — the banner blesses echoes too
    if (g.banner && !p.restocked) {
      if (dxz(p.pos, g.banner.p) < ENC.banner.restockR - 0.6) { g.onInteract(p); return { d: [0, 0] }; }
      return this.seek(b, g.banner.p, false);
    }
    return this.loiter(b, g.banner ? g.banner.p : ENC.banner.pos, 4.5);
  }

  // a stable per-bot spot inside the ready circle so six bodies don't shove
  plateSlot(b) {
    const i = Math.max(0, [...this.brains.keys()].indexOf(b.p.id));
    const a = i * 2.2, r = ENC.readyRadius * 0.55;
    return [Math.sin(a) * r, 0, Math.cos(a) * r];
  }

  loiter(b, home, radius) {
    const t = this.game.t;
    if (!b.wanderP || t >= b.wanderAt) {
      b.wanderAt = t + rand(2.5, 6);
      const a = Math.random() * Math.PI * 2, r = rand(1, radius);
      b.wanderP = [home[0] + Math.sin(a) * r, 0, home[2] + Math.cos(a) * r];
    }
    if (dxz(b.p.pos, b.wanderP) < 0.6) return { d: [0, 0] };
    return this.seek(b, b.wanderP, false);
  }

  seek(b, point, sprint) {
    return { d: [point[0] - b.p.pos[0], point[2] - b.p.pos[2]], sprint };
  }

  // an alive sentinel echo holding a ready super (the emergency dome)
  wardTitan() {
    for (const b of this.brains.values()) {
      if (b.p.cls === 'sentinel' && this.game.alive(b.p) && b.p.sup >= 99) return b.p;
    }
    return null;
  }

  // the spot just outboard of the nearest pillar, in its shadow from the center
  shadowSpot(p) {
    let best = null, bd = Infinity;
    for (const pil of ARENA.pillars) {
      const d = dxz(p.pos, pil.p);
      if (d < bd) { bd = d; best = pil; }
    }
    if (!best) return null;
    const [ux, uz] = norm2(best.p[0], best.p[2]);
    return [best.p[0] + ux * (best.r + 1.4), 0, best.p[2] + uz * (best.r + 1.4)];
  }

  // Jump the surge sweep: signal when a beam line will cross our PREDICTED
  // position (we strafe while fighting — the current angle lies) inside the
  // hop's protected window. integrate() turns the signal into a ground jump
  // or the mid-air re-boost (the double jump every guardian owns) — without
  // the second jump, a beam crossing during the descent of a hop for the
  // OTHER beam always connected.
  sweepJump(b) {
    const g = this.game, sw = g.enc.sweep, p = b.p;
    if (!sw || g.t < sw.armAt - 0.4) return false;
    for (const dtu of [0.22, 0.34, 0.46]) {
      const x = p.pos[0] + p.vel[0] * dtu, z = p.pos[2] + p.vel[2] * dtu;
      const r = Math.hypot(x, z);
      if (r < 0.5) continue;
      const th = Math.atan2(z, x);
      for (const [a, w] of [[sw.a1, sw.w1], [sw.a2, sw.w2]]) {
        let d = ((th - (a + w * dtu)) % Math.PI + Math.PI) % Math.PI;
        if (d > Math.PI / 2) d = Math.PI - d;
        if (r * Math.sin(d) < ENC.sweepWidth + 0.9) return true;
      }
    }
    return false;
  }

  combatMove(b) {
    const g = this.game, p = b.p, t = g.t;
    const d = [0, 0];
    let sprint = false, jump = false;

    // a sniper lock naming me froze a kill-point predicted from my CURRENT
    // momentum — braking (or dashing from a standstill) walks me off it
    for (const en of g.enemies.values()) {
      if (en.type !== 'keeper' || en.snPhase !== 'lock' || en.snTarget !== p.id) continue;
      if (Math.hypot(p.vel[0], p.vel[2]) > 2) return { d: [0, 0], jump: b.y <= 0 };
      const [ux, uz] = norm2(p.pos[0] - en.pos[0], p.pos[2] - en.pos[2]);
      return { d: [uz * b.strafeDir, -ux * b.strafeDir], sprint: true, jump: b.y <= 0 };
    }

    // a seeker hunting me: its 8.5 m/s loses to a 12.5 m/s sprint
    let hunter = null, hd2 = 16;
    for (const en of g.enemies.values()) {
      if (en.type !== 'seeker' || en.target !== p.id) continue;
      const dd = dxz(p.pos, en.pos);
      if (dd < hd2) { hd2 = dd; hunter = en; }
    }
    if (hunter) {
      const [ux, uz] = norm2(p.pos[0] - hunter.pos[0], p.pos[2] - hunter.pos[2]);
      d[0] += ux * 2; d[1] += uz * 2; sprint = true;
    }

    // hold the weapon's range band on the current target, strafing in the pocket
    const tp = this.targetPos(b.target);
    if (tp) {
      const band = this.rangeBand(b);
      const dist = dxz(p.pos, tp);
      const [ux, uz] = norm2(tp[0] - p.pos[0], tp[2] - p.pos[2]);
      if (dist > band[1]) { d[0] += ux; d[1] += uz; }
      else if (dist < band[0]) { d[0] -= ux; d[1] -= uz; }
      else {
        if (t >= b.strafeFlipAt) { b.strafeFlipAt = t + rand(0.9, 2.2); b.strafeDir *= -1; }
        d[0] += uz * b.strafeDir * 0.8; d[1] += -ux * b.strafeDir * 0.8;
      }
    } else {
      // nobody to shoot (wave down, or only warded objectives left): stay
      // with the fireteam — drift to the nearest living guardian of flesh
      // and mill around them instead of statue-ing mid-arena
      const f = this.followVec(b);
      d[0] += f.d[0]; d[1] += f.d[1];
      sprint = sprint || !!f.sprint;
    }

    // kite melee laterally — the husk lunge punishes a pure backpedal by design
    let husk = null, hd = BOTS.meleeBand;
    for (const en of g.enemies.values()) {
      if (en.type !== 'husk') continue;
      const dd = dxz(p.pos, en.pos);
      if (dd < hd) { hd = dd; husk = en; }
    }
    if (husk) {
      const [ux, uz] = norm2(p.pos[0] - husk.pos[0], p.pos[2] - husk.pos[2]);
      d[0] += (ux + uz * b.strafeDir) * 1.6;
      d[1] += (uz - ux * b.strafeDir) * 1.6;
    }

    // don't graze the slam plate mid-fight
    const rc = Math.hypot(p.pos[0], p.pos[2]);
    if (rc < ENC.slamRange + 1.5 && rc > 0.01) {
      d[0] += p.pos[0] / rc * 1.5; d[1] += p.pos[2] / rc * 1.5;
    }

    const dodge = this.dodgeVec(b);
    d[0] += dodge[0]; d[1] += dodge[1];
    return { d, sprint, jump };
  }

  // Idle escort: close on the nearest living human (sprint if left far
  // behind), then wander loosely around them — the slam-radius shove and the
  // body-separation pass keep the huddle honest.
  followVec(b) {
    const anchor = this.nearestHuman(b.p);
    if (!anchor) return { d: [0, 0] };
    const ad = dxz(b.p.pos, anchor.pos);
    if (ad > 24) return this.seek(b, anchor.pos, true);
    if (ad > 8) return this.seek(b, anchor.pos, false);
    return this.loiter(b, anchor.pos, 5);
  }

  // Closest-approach test against live enemy projectiles: anything passing
  // within ~1.3 m of the chest inside dodgeAhead seconds adds a perpendicular
  // sidestep away from the flight line (covers volleys, bolts, barrage rings).
  dodgeVec(b) {
    const p = b.p;
    const c = [p.pos[0], p.pos[1] + 1.0, p.pos[2]];
    const out = [0, 0];
    for (const pr of this.game.projs.values()) {
      if (pr.k === 'heal') continue;
      const rel = [pr.p[0] - c[0], pr.p[1] - c[1], pr.p[2] - c[2]];
      const v = pr.v;
      const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      if (!v2) continue;
      const tc = -(rel[0] * v[0] + rel[1] * v[1] + rel[2] * v[2]) / v2;
      if (tc < 0 || tc > BOTS.dodgeAhead) continue;
      const cx = rel[0] + v[0] * tc, cy = rel[1] + v[1] * tc, cz = rel[2] + v[2] * tc;
      if (Math.hypot(cx, cy, cz) > (pr.r || 0.5) + 1.3) continue;
      const [ux, uz] = norm2(v[0], v[2]);
      const px = -uz, pz = ux;
      const s = (px * cx + pz * cz) > 0 ? -1 : 1;
      out[0] += px * s * 2.2; out[1] += pz * s * 2.2;
    }
    return out;
  }

  integrate(b, mv, dt) {
    const g = this.game, p = b.p;
    const [dx, dz] = mv.d;
    const dl = Math.hypot(dx, dz);
    const sp = mv.sprint ? PLAYER.sprint : PLAYER.walk;
    const want = dl > 0.01 ? [dx / dl * sp, dz / dl * sp] : [0, 0];
    // smoothed accel: snappy but never instant — reads as feet, not a glide
    const k = Math.min(1, dt * 7);
    p.vel[0] += (want[0] - p.vel[0]) * k;
    p.vel[2] += (want[1] - p.vel[2]) * k;
    p.pos[0] += p.vel[0] * dt;
    p.pos[2] += p.vel[2] * dt;
    // hop arc — server-written y, rendered straight off the snapshot like the
    // husk pounce (no protocol change). Players get a double jump; so do
    // echoes: one mid-air re-boost while descending into the beam band, then
    // it re-arms on landing.
    if (mv.jump) {
      if (b.y <= 0) { b.vy = PLAYER.jumpVel; b.y = 0.001; b.dblJumped = false; }
      else if (!b.dblJumped && b.vy < 0 && b.y < ENC.sweepMaxY + 0.6) {
        b.vy = PLAYER.jumpVel;
        b.dblJumped = true;
      }
    }
    if (b.y > 0) {
      b.vy -= PLAYER.gravity * dt;
      b.y = Math.max(0, b.y + b.vy * dt);
      if (b.y === 0) { b.vy = 0; b.dblJumped = false; }
    }
    p.pos[1] = b.y;
    // arena wall
    const r = Math.hypot(p.pos[0], p.pos[2]), max = ARENA.radius - 0.8;
    if (r > max) { p.pos[0] *= max / r; p.pos[2] *= max / r; }
    // standing pillars (FINAL sinks them, and their collision with them)
    if (!g.enc.pillarsDown) {
      for (const pil of ARENA.pillars) {
        const d = dxz(p.pos, pil.p);
        if (d < pil.r + 0.8 && d > 0.01) {
          const f = (pil.r + 0.8) / d;
          p.pos[0] = pil.p[0] + (p.pos[0] - pil.p[0]) * f;
          p.pos[2] = pil.p[2] + (p.pos[2] - pil.p[2]) * f;
        }
      }
    }
    // light body separation so echoes don't merge on shared goals
    for (const q of g.players.values()) {
      if (q === p || q.dead) continue;
      const d = dxz(p.pos, q.pos);
      if (d < 1.0 && d > 0.01) {
        const f = (1.0 - d) / d * 0.5;
        p.pos[0] += (p.pos[0] - q.pos[0]) * f;
        p.pos[2] += (p.pos[2] - q.pos[2]) * f;
      }
    }
    // face the fire target if there is one, else the way we're moving
    const tp = this.aimPos(b);
    if (tp) p.yaw = Math.atan2(tp[0] - p.pos[0], tp[2] - p.pos[2]);
    else if (dl > 0.01) p.yaw = Math.atan2(dx, dz);
  }

  // ---------- combat ----------

  act(b) {
    const g = this.game, e = g.enc, t = g.t;
    this.superLogic(b);
    if (b.p.castUntil > t) return; // a fresh cast roots the rest of the turn
    if (e.st === 'LOBBY' || e.st === 'VICTORY' || e.st === 'WIPE') return;
    if (t >= b.retargetAt) {
      b.retargetAt = t + BOTS.retarget;
      const prev = b.target;
      b.target = this.pickTarget(b);
      this.pickWeapon(b);
      if (b.target && b.target !== prev) {
        // reaction beat: a fresh target costs a re-aim, like it does a human —
        // this is what keeps a kill chain from reading as instant deletion
        b.nextShotAt = Math.max(b.nextShotAt, t + rand(BOTS.react[0], BOTS.react[1]));
        b.burstLeft = BOTS.burst[b.wkey] || 4;
      }
    }
    this.grenadeLogic(b);
    this.rocketLogic(b);
    this.fire(b);
  }

  // Utility scores, not omniscience: ordnance and immediate threats first,
  // leaning into the class fantasy — voidcallers sweep adds, the gunslinger
  // melts the boss, seekers are defended but never trivialized (see the
  // seeker branch below — the converging-salvo chain makes any reliable
  // interception a wave-deleter). Warded enemies and blisters
  // belong to the fireteam's mechanics and are never targeted.
  pickTarget(b) {
    const g = this.game, p = b.p, e = g.enc;
    // spread the squad's fire: every other echo already on an add makes it
    // less attractive — five guns deleting one body at a time reads robotic
    const claimed = new Map();
    for (const ob of this.brains.values()) {
      if (ob === b || !ob.target || ob.target === 'boss') continue;
      claimed.set(ob.target, (claimed.get(ob.target) || 0) + 1);
    }
    let best = null, bs = -Infinity;
    if (!e.shield && !e.bossDead && (e.st === 'DAMAGE' || e.st === 'FINAL')) {
      bs = 70 + (p.cls === 'gunslinger' ? 25 : 0) + (p.goldenUntil > g.t ? 50 : 0);
      best = 'boss';
    }
    for (const en of g.enemies.values()) {
      if (en.type === 'blister' || en.shielded) continue;
      const d = dxz(p.pos, en.pos);
      if (d > 60) continue;
      let s = 0;
      if (en.type === 'seeker') {
        // defense, not trivialization: notice the missile late (it pops off
        // the back unseen), engage only your own hunter or one genuinely
        // close, and favor peeling the ones hunting guardians of flesh
        const mine = en.target === p.id;
        const age = g.t - ((en.dieAt ?? g.t) - ENC.seekerLife);
        if (age < BOTS.seekerNotice) continue;
        if (!mine) {
          // peeling is a CLUTCH SAVE, never an automated screen: one kill
          // chain-cooks a converging salvo, so reliable interception at any
          // range deletes whole waves. The squad shoots a missile off a
          // human's back only when that human is wounded enough to be in
          // real danger, it's bearing down on them, and only ONE interceptor
          // squad-wide. Echoes being hunted handle their own missile (the
          // designed sprint + fire counterplay).
          const prey = g.players.get(en.target);
          if (!prey || prey.bot || prey.hp >= PLAYER.maxHp * BOTS.seekerSaveHp
            || dxz(en.pos, prey.pos) > BOTS.seekerAssistR) continue;
          let peelerBusy = false;
          for (const ob of this.brains.values()) {
            if (ob === b || !ob.target || ob.target === 'boss') continue;
            const ot = g.enemies.get(ob.target);
            if (ot && ot.type === 'seeker' && ot.target !== ob.p.id) { peelerBusy = true; break; }
          }
          if (peelerBusy) continue;
        }
        s = 100 - d + (mine ? 30 : 22);
      }
      else if (en.type === 'husk') s = 58 - d + (d < 9 ? 25 : 0) + (p.cls === 'voidcaller' ? 8 : 0);
      else if (en.type === 'acolyte') s = 55 - d * 0.8 + (p.cls === 'voidcaller' ? 8 : 0);
      else if (en.type === 'wisp') s = 52 - d * 0.8;
      else if (en.type === 'keeper') s = 62 - d * 0.4; // an unwarded keeper is the kill objective
      // seekers exempt: stacking fire on one chain-cooks the salvo (a feature)
      if (en.type !== 'seeker') s -= BOTS.spreadFire * (claimed.get(en.id) || 0);
      if (s > bs) { bs = s; best = en.id; }
    }
    return best;
  }

  pickWeapon(b) {
    const [prim, spec, heavy] = b.entry.weapons;
    let want = prim;
    if (b.target === 'boss') {
      want = heavy === 'lmg' ? 'lmg' : spec === 'sniper' ? 'sniper' : prim;
    } else if (b.target) {
      const tp = this.targetPos(b.target);
      const d = tp ? dxz(b.p.pos, tp) : 99;
      if (spec === 'shotgun' && d < 10) want = 'shotgun';
      else if (spec === 'sniper' && d > 26) want = 'sniper';
    }
    if (want !== b.wkey) {
      b.wkey = want;
      b.p.curW = Math.max(0, b.entry.weapons.indexOf(want)); // snapshot `cw` — clients show the swap
      b.shots = WEAPONS[want].mag;
      b.nextShotAt = Math.max(b.nextShotAt, this.game.t + 0.45); // swap time
    }
  }

  targetPos(target) {
    if (!target) return null;
    if (target === 'boss') return [ENC.bossPos[0], 0, ENC.bossPos[2]];
    const en = this.game.enemies.get(target);
    return en ? en.pos : null;
  }

  aimPos(b) {
    if (!b.target) return null;
    if (b.target === 'boss') return [...ENC.bossPos];
    const en = this.game.enemies.get(b.target);
    if (!en) return null;
    const grounded = !en.sky && en.type !== 'seeker' && en.type !== 'wisp' && en.type !== 'blister';
    return [en.pos[0], grounded ? en.pos[1] + 1.3 : en.pos[1], en.pos[2]];
  }

  rangeBand(b) {
    if (b.target === 'boss') return [14, 26];
    switch (b.wkey) {
      case 'shotgun': return [3, 8];
      case 'sniper': return [16, 28];
      case 'hand': return [10, 20];
      default: return [10, 18];
    }
  }

  // One simulated trigger pull: cadence + mag/reload pauses for the feel,
  // accuracy/crit rolls for the output (the tuning knob — see BOTS.acc),
  // the same `pf` relay broadcast a human's fire causes, and the damage
  // routed through onHit so DMG_CAPS and ward/blister gates all apply.
  fire(b) {
    const g = this.game, p = b.p, t = g.t;
    const tp = this.aimPos(b);
    if (!tp) return;
    const W = WEAPONS[b.wkey];
    const eye = [p.pos[0], p.pos[1] + PLAYER.eye, p.pos[2]];
    const dist = d3(eye, tp);
    if (dist > W.range) return;
    if (t < b.reloadUntil || t < b.nextShotAt) return;
    if (g.losBlocked(eye, tp)) return;
    b.nextShotAt = t + (60 / W.rpm) * (W.auto ? 1 : rand(1.05, 1.45)); // nobody macro-clicks semis
    // burst-then-settle vs small adds: humans don't beam a strafing husk —
    // the boss, keepers, and seekers stay full-cadence (see BOTS.burst)
    const en = b.target === 'boss' ? null : g.enemies.get(b.target);
    const small = !!en && (en.type === 'husk' || en.type === 'acolyte' || en.type === 'wisp');
    if (small && --b.burstLeft <= 0) {
      b.burstLeft = BOTS.burst[b.wkey] || 4;
      b.nextShotAt = Math.max(b.nextShotAt, t + rand(BOTS.burstRest[0], BOTS.burstRest[1]));
    }
    if (--b.shots <= 0) { b.shots = W.mag; b.reloadUntil = t + W.reload; }
    const dir = norm3([
      tp[0] - eye[0] + rand(-0.6, 0.6),
      tp[1] - eye[1] + rand(-0.4, 0.4),
      tp[2] - eye[2] + rand(-0.6, 0.6),
    ]);
    g.send(null, { t: 'pf', id: p.id, w: b.wkey, from: eye.map(rnd2), dir: dir.map(rnd2) });
    const A = BOTS.acc[b.wkey] || { hit: 0.7, crit: 0.2 };
    // the boss is a barn door; small strafing bodies are hard to track, and a
    // darting warhead is harder still
    const pHit = b.target === 'boss' ? Math.min(0.97, A.hit + 0.15)
      : A.hit * (small ? BOTS.addAcc : en && en.type === 'seeker' ? BOTS.seekerAcc : 1);
    if (Math.random() > pHit) return;
    let dmg;
    if (W.pellets) {
      const f = !W.falloff || dist <= W.falloff.start ? 1
        : Math.max(W.falloff.min, 1 - (dist - W.falloff.start) / (W.range - W.falloff.start) * (1 - W.falloff.min));
      dmg = W.dmg * W.pellets * BOTS.pelletFrac * f * (Math.random() < A.crit ? W.critMul : 1);
    } else {
      dmg = W.dmg * (Math.random() < A.crit ? W.critMul : 1);
    }
    if (p.goldenUntil > t) dmg *= SUPER.golden.mul;
    g.onHit(p, { target: b.target, dmg: Math.round(dmg), weapon: b.wkey });
  }

  rocketLogic(b) {
    const g = this.game, p = b.p, e = g.enc, t = g.t;
    if (b.entry.weapons[2] !== 'rocket' || t < b.rocketAt) return;
    if (b.target !== 'boss' || e.shield || e.bossDead) return;
    b.rocketAt = t + BOTS.rocketCd + rand(0, 1.5);
    const eye = [p.pos[0], p.pos[1] + PLAYER.eye, p.pos[2]];
    const hit = this.hullPoint(p, 0.8);
    const dir = norm3([hit[0] - eye[0], hit[1] - eye[1], hit[2] - eye[2]]);
    g.send(null, { t: 'pf', id: p.id, w: 'rocket', from: eye.map(rnd2), dir: dir.map(rnd2) });
    this.blasts.push({ at: t + d3(eye, hit) / WEAPONS.rocket.projSpeed, by: p.id, kind: 'rocket', p: hit });
    b.nextShotAt = Math.max(b.nextShotAt, t + 1.2); // the launcher occupied both hands
  }

  // the boss-hull surface point facing this bot — where rockets/novas burst
  hullPoint(p, frac) {
    const [ux, uz] = norm2(p.pos[0] - ENC.bossPos[0], p.pos[2] - ENC.bossPos[2]);
    return [
      ENC.bossPos[0] + ux * ENC.bossBodyR * frac,
      ENC.bossPos[1],
      ENC.bossPos[2] + uz * ENC.bossBodyR * frac,
    ];
  }

  grenadeLogic(b) {
    const g = this.game, p = b.p, e = g.enc, t = g.t;
    if (t < b.grenadeAt) return;
    let at = null;
    if (p.cls === 'sentinel') {
      // mend-orbs: spend only when the team is actually hurt
      let hurt = 0;
      for (const q of g.players.values()) if (g.alive(q) && q.hp < PLAYER.maxHp * 0.55) hurt++;
      if (!hurt) return;
      at = [p.pos[0], 0.6, p.pos[2]]; // the orbs pick their own patients at the split
    } else if (p.cls === 'gunslinger' && b.target === 'boss' && !e.shield) {
      at = this.hullPoint(p, 0.8);
    } else {
      const cl = this.addCluster(2, GRENADE[p.cls]?.r || 5);
      if (!cl) return;
      at = [cl[0], 0.4, cl[2]];
    }
    if (dxz(p.pos, at) > 26) return; // beyond a believable throw
    b.grenadeAt = t + GRENADE.cd + rand(0, 2);
    const eye = [p.pos[0], p.pos[1] + 1.5, p.pos[2]];
    const dir = norm3([at[0] - eye[0], at[1] - eye[1] + 0.25, at[2] - eye[2]]);
    g.send(null, { t: 'pf', id: p.id, w: 'grenade', from: eye.map(rnd2), dir: dir.map(rnd2) });
    this.blasts.push({
      at: t + Math.min(GRENADE.fuse, d3(eye, at) / GRENADE.speed + 0.35),
      by: p.id, kind: 'grenade', p: at,
    });
  }

  // densest small-add neighborhood: centroid + count, or null below minN
  addCluster(minN, r) {
    const small = [];
    for (const en of this.game.enemies.values()) {
      if (en.type === 'husk' || en.type === 'acolyte') small.push(en);
    }
    let best = null;
    for (const a of small) {
      const near = small.filter(o => dxz(a.pos, o.pos) < r);
      if (near.length >= minN && (!best || near.length > best.length)) best = near;
    }
    if (!best) return null;
    let cx = 0, cz = 0;
    for (const en of best) { cx += en.pos[0]; cz += en.pos[2]; }
    return [cx / best.length, 0, cz / best.length, best.length];
  }

  // ---------- supers ----------

  superLogic(b) {
    const g = this.game, p = b.p, e = g.enc, t = g.t;
    if (p.sup < 99 || p.castUntil > t || !g.alive(p)) return;
    if (e.st === 'LOBBY' || e.st === 'VICTORY' || e.st === 'WIPE') return;
    const kind = CLASS_SUPER[p.cls];
    const bossBare = !e.shield && !e.bossDead && (e.st === 'DAMAGE' || e.st === 'FINAL');
    if (kind === 'golden') {
      // hoarded for the burn — spent the moment the boss lies bare
      if (bossBare && t >= b.goldenAskAt) this.cast(b, [...ENC.bossPos]);
    } else if (kind === 'nova') {
      if (t < this.board.novaAt) return; // warlocks take turns
      if (bossBare && t >= b.novaPlanAt) {
        this.castNova(b, this.hullPoint(p, 0.7));
      } else {
        // only a genuinely swamped arena earns the singularity — otherwise
        // it's banked for the boss (addFill is the same pressure gauge the
        // adaptive wave cadence breathes on)
        if (g.addFill() < BOTS.novaFill) return;
        const cl = this.addCluster(BOTS.novaAdds, BOTS.novaR);
        if (cl && dxz(p.pos, cl) < 40) this.castNova(b, [cl[0], 0.5, cl[2]]);
      }
    } else if (kind === 'ward') {
      this.wardLogic(b);
    }
  }

  wardLogic(b) {
    const g = this.game, p = b.p, e = g.enc, t = g.t;
    // (b) the OBLITERATION save — highest-value dome in the game, judged
    // against shelter that will actually SURVIVE the blast: a dome expiring
    // mid-warning is no cover (this exact wipe shipped once).
    if (e.st === 'OBLIT') {
      for (const w of g.wells.values()) if (w.until > e.ends + 0.2) return;
      // a key still in play may wake a real refuge — hold to the last window;
      // otherwise cast as soon as we're standing among the living (movement
      // walks the save-titan to the nearest human first)
      const keyLive = g.keys.size > 0 || [...g.players.values()].some(q => q.hasKey);
      const h = this.nearestHuman(p);
      const settled = !h || dxz(p.pos, h.pos) < 4.5;
      // the dome exists the instant the cast validates, so the true deadline
      // is nearly the blast itself — keep running toward the fireteam and
      // only emergency-cast in place when time actually runs out
      if ((settled && !keyLive) || e.ends - t < 0.9) return this.cast(b, null);
      return;
    }
    // ONE dome at a time, fireteam-wide — the second titan holds its super
    for (const w of g.wells.values()) if (w.kind === 'ward') return;
    // RESERVE RULE: while an obliteration can still come (any phase before
    // FINAL) and no refuge stands woken, the squad's LAST ready titan super
    // belongs to the save — anchors and revive domes spend only the surplus.
    // (Both titans dumping anchors into one damage phase left the wipe
    // unanswered once.)
    const spendable = e.st === 'FINAL'
      || [...g.wells.values()].some(w => w.kind === 'refuge')
      || this.othersHoldWard(b);
    if (!spendable) return;
    // (a) shield the revive I'm channeling
    const claim = this.myClaim(b);
    if (claim && dxz(p.pos, claim.pos) < PLAYER.reviveRange) return this.cast(b, claim.pos);
    // (c) burn-phase anchor: shelter the gathered fireteam (DAMAGE, and the
    // true final stand once the generator is down — there is no oblit after)
    if ((e.st === 'DAMAGE' || (e.st === 'FINAL' && !e.shield)) && t >= b.wardPlanAt) {
      let near = 0;
      for (const q of g.players.values()) if (q !== p && g.alive(q) && dxz(p.pos, q.pos) < 8) near++;
      if (near >= 1) return this.cast(b, null);
    }
  }

  // another living sentinel echo still holding a ready super
  othersHoldWard(b) {
    for (const ob of this.brains.values()) {
      if (ob !== b && ob.p.cls === 'sentinel' && this.game.alive(ob.p) && ob.p.sup >= 99) return true;
    }
    return false;
  }

  nearestHuman(p) {
    let best = null, bd = Infinity;
    for (const q of this.game.players.values()) {
      if (q.bot || !this.game.alive(q)) continue;
      const d = dxz(p.pos, q.pos);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  // golden/ward: the server effect is instant in onSuperCast; dir only flavors FX
  cast(b, lookAt) {
    const p = b.p;
    const dir = lookAt
      ? norm3([lookAt[0] - p.pos[0], lookAt[1] - (p.pos[1] + 1.5), lookAt[2] - p.pos[2]])
      : [Math.sin(p.yaw), 0.1, Math.cos(p.yaw)];
    this.game.onSuperCast(p, { dir });
  }

  castNova(b, at) {
    const g = this.game, p = b.p, t = g.t;
    const from = [p.pos[0], p.pos[1] + 1.5, p.pos[2]];
    this.cast(b, at);
    if (!p.pendingNova) return; // the cast was refused (gauge raced) — keep the schedule clean
    this.board.novaAt = t + BOTS.novaStagger;
    // the singularity leaves the body at the flourish apex and flies straight;
    // schedule the burst where it lands (clients fly the cosmetic orb off the
    // `super` broadcast, and the boom rides the `explosion` broadcast)
    this.blasts.push({ at: t + SUPER.cast.apex + d3(from, at) / SUPER.nova.speed, by: p.id, kind: 'nova', p: at });
  }

  // ---------- scheduled ordnance (the work a thrower's client would do) ----------

  resolveBlasts() {
    const g = this.game, t = g.t;
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const bl = this.blasts[i];
      if (t < bl.at) continue;
      this.blasts.splice(i, 1);
      const p = g.players.get(bl.by);
      if (!p) continue;
      g.onExplode(p, { kind: bl.kind, p: bl.p });
      // homing payloads: the server applies the damage a thrower's client
      // would have flown; every human client replays the shards cosmetically
      // off the `explosion` broadcast (same machinery as spectating a human)
      if (bl.kind === 'nova') this.swarms.push(this.mkSwarm(bl, SUPER.nova.swarm, 'nswarm'));
      else if (bl.kind === 'grenade' && p.cls === 'gunslinger') {
        this.swarms.push(this.mkSwarm(bl, GRENADE.gunslinger.swarm, 'gswarm'));
      }
    }
  }

  mkSwarm(bl, S, wkey) {
    return { by: bl.by, from: [...bl.p], n: S.n, dmg: S.dmg, wkey, nextAt: this.game.t + 0.55, idx: 0 };
  }

  resolveSwarms() {
    const g = this.game, t = g.t;
    for (let i = this.swarms.length - 1; i >= 0; i--) {
      const s = this.swarms[i];
      let guard = 0;
      while (s.n > 0 && t >= s.nextAt && guard++ < 40) {
        s.n--; s.nextAt += 0.07; // one shard landing per beat, like the real flight
        const p = g.players.get(s.by);
        if (!p || p.dead) continue;
        const tgt = this.swarmTarget(s);
        if (tgt) g.onHit(p, { target: tgt, dmg: s.dmg, weapon: s.wkey });
      }
      if (s.n <= 0) this.swarms.splice(i, 1);
    }
  }

  // nearest damageable enemies first, the exposed boss as backstop — mirrors
  // the client's acquireSwarmTargets so a bot's nova clears what a human's would
  swarmTarget(s) {
    const g = this.game, e = g.enc;
    const cands = [];
    for (const en of g.enemies.values()) {
      if (en.shielded || en.type === 'blister') continue;
      cands.push(en);
    }
    if (cands.length) {
      cands.sort((a, o) => dxz(s.from, a.pos) - dxz(s.from, o.pos));
      return cands[s.idx++ % Math.min(cands.length, 6)].id;
    }
    if (!e.shield && !e.bossDead) return 'boss';
    return null;
  }
}
