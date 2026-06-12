// Server-authoritative encounter logic. No Date.now() inside — time advances via tick(dt),
// so the whole encounter is unit-testable with a fake clock.
import {
  ARENA, PLAYER, ENEMIES, ENC, SUPER, CLASS_SUPER, DMG_CAPS, GRENADE, WEAPONS, CLASSES,
} from '../shared/constants.js';
import { rollSigil } from '../shared/sigil.js';

let nextId = 1;
const nid = () => String(nextId++);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const dxz = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export class Game {
  // send(playerId|null, msgObject) — null broadcasts to everyone.
  constructor(send) {
    this.send = send;
    this.t = 0;
    this.players = new Map();
    this.snapAcc = 0;
    this.gjallyOwners = new Set(); // guardian names that looted the cache; survives resetWorld
    this.onUnlock = null;          // hook(name) for the host process to persist unlocks
    this.resetWorld();
  }

  resetWorld() {
    this.enemies = new Map();
    this.projs = new Map();
    this.dots = new Map();        // voidcaller grenade orbs: lingering DoT zones
    this.bricks = new Map();
    this.wells = new Map();
    this.caps = new Map();        // antiviral capsules raining during damage phase
    this.keys = new Map();        // auric keys dropped by burst blisters
    this.chest = null;
    this.banner = null;           // rally banner { p, by } — planted in LOBBY, gone on reset
    this.enc = {
      st: 'LOBBY', round: 1, ends: 0, ready: 0,
      bossHp: 0, bossMax: 0, shield: true, bossDead: false,
      nextWaveAt: 0, nextKeeperAt: 0,
      // MECH sub-stage: null (keepers stirring) → KEEPERS (twin wards + lattice)
      // → HUNT (wards down, slay them) → FINAL (herald in the sky)
      // → MISSILE (wormhole open, impact pending)
      stage: null, sigil: null, keeperIds: [], finalKeeperId: null,
      strikes: [],                // pending lattice strikes: { keeperId, at }
      nextGrabAt: 0, grabSeen: false, // boss panel-grabs (KEEPERS stage only)
      grabAngle: 0,               // panel's resting offset around the sky-ring (rad, 0 = north)
      wormhole: false, missileAt: 0,
      nextVolleyAt: 0, nextSlamAt: 0, final: false,
      surgeUntil: 0,              // final-stand generator surge: shield holds until then
      surgeWavesLeft: 0, surgeWaveAt: 0, // remainder of a surge seeker burst (waves ripple surgeWaveGap apart)
      // back-launched homing missiles: salvo = seekerBase + seekerBonus,
      // and the bonus grows by one on every phase entry after the first
      nextSeekerAt: 0, seekerBonus: 0, seekerSeen: false,
      burned: [],                 // pedestal indices whose refuge wells collapsed
      focus: null,                // player the boss hard-focuses during damage phase
      bossYaw: 0,                 // server-owned facing; blisters ride the back side
      nextCapsuleAt: 0,
      sweep: null,                // { a1, a2, w1, w2, armAt, until }
      barrageUntil: 0, barrageNextAt: 0, barrageAngle: 0, barrageHaste: 1,
      barrageDir: 1, barrageBeatN: 0,
      nextSpecialAt: 0, specialFlip: false,
    };
  }

  resetToLobby(reason = 'wipe') {
    this.resetWorld();
    for (const p of this.players.values()) {
      p.hp = PLAYER.maxHp; p.downed = false; p.dead = false;
      p.goldenUntil = 0;
      p.pendingNova = false; p.castUntil = 0; p.revive = null; p.looted = false;
      p.antiviral = 0; p.hasKey = false; p.wardUntil = 0;
      p.restocked = false; // the next lobby's banner blesses everyone afresh
      p.pos = [...ARENA.spawn];
    }
    this.send(null, { t: 'reset', reason });
  }

  // ---------- players ----------

  addPlayer(id, name, cls) {
    const p = {
      id, name: String(name).slice(0, 16) || 'Guardian', cls,
      pos: [...ARENA.spawn], yaw: ARENA.spawnYaw, pitch: 0,
      hp: PLAYER.maxHp, lastDmg: -99, downed: false, dead: false,
      sup: 0, goldenUntil: 0, pendingNova: false, castUntil: 0,
      antiviral: 0, hasKey: false, wardUntil: 0,
      vel: [0, 0, 0], lastStateAt: -1,
      revive: null, looted: false, restocked: false, lastExp: {},
      stats: { kills: 0, bossDmg: 0, keepers: 0 },
    };
    this.players.set(id, p);
    this.toast(`${p.name} joined`, 'info');
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.hasKey) this.keys.set(nid(), { p: [p.pos[0], 0, p.pos[2]] });
    this.players.delete(id);
    this.toast(`${p.name} left`, 'info');
    if (this.players.size === 0) { this.resetWorld(); return; }
    if (this.enc.st !== 'LOBBY') this.checkWipe();
  }

  alive(p) { return !p.downed && !p.dead; }
  alivePlayers() { return [...this.players.values()].filter(p => this.alive(p)); }

  // ---------- messaging ----------

  toast(text, kind = 'info') { this.send(null, { t: 'toast', text, kind }); }

  onMessage(id, m) {
    const p = this.players.get(id);
    if (!p || !m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'state': {
        if (!Array.isArray(m.pos) || m.pos.length !== 3) return;
        const [x, y, z] = m.pos.map(Number);
        if (![x, y, z].every(Number.isFinite)) return;
        const r = Math.hypot(x, z), max = ARENA.radius - 0.5;
        const s = r > max ? max / r : 1;
        const next = [x * s, Math.min(40, Math.max(-1, y)), z * s];
        // estimate horizontal velocity so enemy fire can lead the target
        const dtm = this.t - p.lastStateAt;
        if (p.lastStateAt >= 0 && dtm > 0.005 && dtm < 0.5) {
          const vx = (next[0] - p.pos[0]) / dtm, vz = (next[2] - p.pos[2]) / dtm;
          if (Math.hypot(vx, vz) > 16) p.vel = [0, 0, 0]; // teleport, not movement
          else p.vel = [p.vel[0] * 0.4 + vx * 0.6, 0, p.vel[2] * 0.4 + vz * 0.6];
        }
        p.lastStateAt = this.t;
        p.pos = next;
        p.yaw = Number(m.yaw) || 0; p.pitch = Number(m.pitch) || 0;
        break;
      }
      case 'fire': // cosmetic relay so others see tracers / hear shots
        this.send(null, { t: 'pf', id, w: m.w, from: m.from, dir: m.dir, exclude: id });
        break;
      case 'hit': this.onHit(p, m); break;
      case 'explode': this.onExplode(p, m); break;
      case 'superCast': this.onSuperCast(p, m); break;
      case 'interact': this.onInteract(p); break;
      case 'sigil': this.onSigil(p, m); break;
      case 'loadout': // class re-pick from the selection screen, lobby only
        if (this.enc.st === 'LOBBY' && CLASSES[m.cls]) p.cls = m.cls;
        break;
    }
  }

  onHit(p, m) {
    // downed (not dead) still lands: the client gates NEW fire input on alive,
    // so a hit arriving while downed is ordnance launched before the fall
    // (swarm shards, wolfpack) — going down must not void it mid-flight
    if (p.dead) return;
    let dmg = Math.max(0, Number(m.dmg) || 0);
    const cap = (DMG_CAPS[m.weapon] || 90) * (p.goldenUntil > this.t ? SUPER.golden.mul * 1.05 : 1);
    dmg = Math.min(dmg, cap);
    if (m.target === 'boss') {
      this.applyBossDamage(dmg, p);
    } else {
      const e = this.enemies.get(String(m.target));
      if (!e) return;
      // blisters are sealed against ordinary fire — only a fully patched player bursts them
      if (e.type === 'blister' && p.antiviral < ENC.capsulesNeeded) return;
      if (e.shielded) {
        // the herald's ward is itself a (weak) target — but only for a guardian
        // carrying the lock's wardbreaker blessing; twin wards have no health
        // at all and fall only to the sky codes
        if (e.shieldHp == null || p.wardUntil <= this.t) return;
        e.shieldHp -= dmg;
        if (p.goldenUntil <= this.t) this.gainSuper(p, dmg * SUPER.perDamage);
        if (e.shieldHp <= 0) this.blastWard(e, p);
        return;
      }
      e.hp -= dmg;
      if (p.goldenUntil <= this.t) this.gainSuper(p, dmg * SUPER.perDamage);
      if (e.hp <= 0) this.killEnemy(e, p);
    }
  }

  onExplode(p, m) {
    if (p.dead || !Array.isArray(m.p)) return; // downed ok — see onHit
    const pos = m.p.map(Number);
    if (!pos.every(Number.isFinite)) return;
    let dmg, r, minInterval;
    if (m.kind === 'nova') {
      if (!p.pendingNova) return;
      p.pendingNova = false;
      ({ dmg, r } = SUPER.nova); minInterval = 0;
    } else if (m.kind === 'rocket') {
      dmg = WEAPONS.rocket.splashDmg; r = WEAPONS.rocket.splashR; minInterval = 1.0;
    } else if (m.kind === 'gjally') {
      dmg = WEAPONS.gjally.splashDmg; r = WEAPONS.gjally.splashR; minInterval = 1.0;
    } else if (m.kind === 'grenade') {
      // grenades are per-class: blast numbers differ, and the payload below
      // (void orb / mend-orbs) hangs off the same validated explode
      const G = GRENADE[p.cls] || GRENADE.gunslinger;
      dmg = G.dmg; r = G.r; minInterval = 8;
    } else return;
    if (minInterval && this.t - (p.lastExp[m.kind] || -99) < minInterval) return;
    p.lastExp[m.kind] = this.t;
    if (m.kind === 'grenade') {
      if (p.cls === 'voidcaller') {
        const O = GRENADE.voidcaller.orb;
        this.dots.set(nid(), { p: pos, by: p.id, until: this.t + O.dur, nextAt: this.t + 0.5 });
        this.send(null, { t: 'voidOrb', p: pos, r: O.r, dur: O.dur });
      } else if (p.cls === 'sentinel') {
        this.spawnHealOrbs(p, pos);
      }
    }

    let total = 0;
    // snapshot the patch state up front: one splash can legitimately burst several
    // blisters even though the first kill spends the stacks
    const patched = p.antiviral >= ENC.capsulesNeeded;
    for (const e of [...this.enemies.values()]) {
      if (e.type === 'blister' && !patched) continue;
      if (e.shielded) continue;
      // blisters hang on the boss body and seekers fly — use their real height
      const d = d3(pos, [e.pos[0], e.type === 'blister' || e.type === 'seeker' ? e.pos[1] : 1, e.pos[2]]);
      if (d > r) continue;
      const dealt = dmg * (1 - 0.55 * d / r);
      e.hp -= dealt; total += dealt;
      if (e.hp <= 0) this.killEnemy(e, p);
    }
    // The boss is a big floating body — direct hits land on its surface.
    const bossReach = r + (m.kind === 'nova' ? 2.5 : 2);
    if (d3(pos, ENC.bossPos) < bossReach && this.applyBossDamage(dmg, p)) total += dmg;
    if (m.kind !== 'nova') this.gainSuper(p, total * SUPER.perDamage);
    this.send(null, { t: 'explosion', p: pos, kind: m.kind, by: p.id, exclude: p.id });
  }

  onSuperCast(p, m) {
    // Gate at 99: snapshots round sup to 0.1, so the client can legitimately
    // show READY a hair before the server's float crosses 99.5.
    if (!this.alive(p) || p.sup < 99) return;
    p.sup = 0;
    p.castUntil = this.t + SUPER.cast.dur; // the flourish window — DR in dmgPlayer
    const kind = CLASS_SUPER[p.cls] || 'nova';
    if (kind === 'nova') p.pendingNova = true;
    // golden counts from the END of the flourish: the client roots fire through
    // the cinematic, so starting at cast would silently eat ~18% of the buff
    else if (kind === 'golden') p.goldenUntil = this.t + SUPER.cast.dur + SUPER.golden.dur;
    else if (kind === 'ward') {
      this.wells.set(nid(), { p: [...p.pos], r: SUPER.ward.r, until: this.t + SUPER.ward.dur, kind: 'ward' });
    }
    this.send(null, { t: 'super', id: p.id, kind, name: p.name, dir: m.dir });
  }

  onInteract(p) {
    if (!this.alive(p)) return;
    // Revive a downed teammate. Repeated presses must NOT restart the channel,
    // or holding E would reset the timer forever.
    for (const q of this.players.values()) {
      if (q.downed && q.id !== p.id && dxz(p.pos, q.pos) < PLAYER.reviveRange) {
        if (!(p.revive && p.revive.target === q.id)) {
          p.revive = { target: q.id, end: this.t + PLAYER.reviveTime };
        }
        return;
      }
    }
    // Rally banner — LOBBY only. First interact on the marked circle plants it;
    // after that, each guardian can rally at it once (ammo and cooldowns are
    // client-side in WeaponSystem; the super gauge is server-owned, so it
    // fills here).
    if (this.enc.st === 'LOBBY') {
      const B = ENC.banner;
      if (!this.banner && dxz(p.pos, B.pos) < B.placeR) {
        this.banner = { p: [...B.pos], by: p.name };
        this.send(null, { t: 'banner', p: this.banner.p, by: p.name });
        this.toast(`${p.name} plants the standard`, 'good');
        return;
      }
      if (this.banner && !p.restocked && dxz(p.pos, this.banner.p) < B.restockR) {
        p.restocked = true;
        this.gainSuper(p, 100);
        this.send(p.id, { t: 'restock' });
        return;
      }
    }
    // Loot the chest — the raid exotic is always Gjallarhorn, and it belongs
    // only to the guardians who actually claim it from the cache.
    if (this.chest && !p.looted && dxz(p.pos, this.chest.p) < PLAYER.interactRange + 0.5) {
      p.looted = true;
      if (!this.gjallyOwners.has(p.name)) {
        this.gjallyOwners.add(p.name);
        if (this.onUnlock) this.onUnlock(p.name);
        this.send(p.id, { t: 'unlock', what: 'gjally' });
      }
      this.send(p.id, { t: 'loot', item: 'Gjallarhorn' });
      this.toast(`${p.name} claims GJALLARHORN!`, 'good');
    }
  }

  // ---------- damage to players ----------

  inWell(p, kind = null) {
    for (const w of this.wells.values()) {
      if (kind && w.kind !== kind) continue;
      if (dxz(p.pos, w.p) < w.r && p.pos[1] < 4) return true;
    }
    return false;
  }

  dmgPlayer(p, amount, src, imp = null) {
    if (!this.alive(p) || this.enc.st === 'LOBBY' || this.enc.st === 'VICTORY') return;
    if (this.inWell(p, 'ward')) amount *= 1 - SUPER.ward.dr;
    if (p.castUntil > this.t) amount *= 1 - SUPER.cast.dr; // mid-flourish: the Light shields the rooted caster
    p.hp -= amount;
    p.lastDmg = this.t;
    this.send(p.id, { t: 'hurt', dmg: Math.round(amount), src, imp });
    if (p.hp <= 0) this.downPlayer(p);
  }

  downPlayer(p) {
    p.hp = 0; p.downed = true;
    p.revive = null;
    this.send(null, { t: 'down', id: p.id });
    this.toast(`${p.name} is down!`, 'warn');
    this.checkWipe();
  }

  checkWipe() {
    if (this.enc.st === 'LOBBY' || this.enc.st === 'WIPE' || this.enc.st === 'VICTORY') return;
    if (this.players.size > 0 && this.alivePlayers().length === 0) this.startWipe();
  }

  // End-of-encounter scoreboard, best boss damage first.
  encStats() {
    return [...this.players.values()]
      .map(p => ({ name: p.name, cls: p.cls, kills: p.stats.kills, dmg: Math.round(p.stats.bossDmg), keepers: p.stats.keepers }))
      .sort((a, b) => b.dmg - a.dmg || b.kills - a.kills);
  }

  startWipe() {
    for (const p of this.players.values()) { p.downed = false; p.dead = true; }
    this.enc.st = 'WIPE'; this.enc.ends = this.t + ENC.wipeDelay;
    this.clearPhaseFx();
    this.endViralPhase();
    this.send(null, { t: 'wipe', stats: this.encStats() });
    this.toast('Darkness consumes all...', 'boss');
  }

  // ---------- boss & encounter ----------

  startEncounter() {
    const n = this.players.size;
    this.enc.bossMax = ENC.bossBase + ENC.bossPerPlayer * (n - 1);
    this.enc.bossHp = this.enc.bossMax;
    this.enc.shield = true; this.enc.final = false; this.enc.bossDead = false;
    this.enc.round = 1;
    for (const p of this.players.values()) p.stats = { kills: 0, bossDmg: 0, keepers: 0 };
    this.spawnBlisters(); // they fester on its back for the whole encounter
    this.send(null, { t: 'bossWake' });
    this.enterMech(1);
  }

  // Every phase entry routes through this: a sweep, barrage, or MECH stage
  // that survives a transition leaks boss specials across phases (this bug
  // shipped before). enterDamage alone keeps the wormhole — it hangs open
  // overhead for the whole phase, sealing only at the next entry.
  clearPhaseFx(keepWormhole = false) {
    const e = this.enc;
    e.sweep = null; e.barrageUntil = 0;
    e.stage = null; e.strikes = []; e.surgeUntil = 0; e.surgeWavesLeft = 0;
    if (!keepWormhole) { e.wormhole = false; e.missileAt = 0; }
  }

  enterMech(round) {
    const e = this.enc;
    e.st = 'MECH'; e.round = round; e.ends = 0;
    this.clearPhaseFx();
    this.endViralPhase(); // unspent keys are forfeit once the round turns over
    e.keeperIds = []; e.finalKeeperId = null;
    e.sigil = { ...rollSigil(), grid: 0, matched: [false, false] };
    e.nextWaveAt = this.t + 3;
    e.nextKeeperAt = this.t + ENC.firstKeeperDelay;
    e.nextSlamAt = this.t + 3; // volleys are DAMAGE/FINAL-only; enterDamage/enterFinal arm them
    e.nextSpecialAt = this.t + ENC.specialFirstDelay;
    e.nextSeekerAt = this.t + ENC.seekerFirst;
    if (round > 1) e.seekerBonus++;
    if (round > 1) this.toast('A fresh cipher whispers.', 'warn');
    else this.toast('The Keepers stir.', 'info');
  }

  colorName(c) { return ARENA.pedestals[c].name; }

  // Twin warded Keepers arrive together; the sky lattice wakes with them.
  spawnKeepers() {
    const e = this.enc, sig = e.sigil;
    const gates = [...ARENA.gates].sort(() => Math.random() - 0.5).slice(0, 2);
    const hp = ENEMIES.keeper.hp + ENC.keeperPerPlayer * (this.players.size - 1);
    [0, 1].forEach((slot) => {
      const gate = gates[slot];
      const k = this.spawnEnemy('keeper', [gate.p[0] + rand(-2, 2), 0, gate.p[2] + rand(-2, 2)], hp);
      k.color = sig.colors[slot]; k.shielded = true;
      e.keeperIds.push(k.id);
      // round 2+: flying Wisps orbit each Keeper, soaking shots meant for it
      if (e.round >= 2) {
        const n = Math.min(e.round, 3);
        for (let i = 0; i < n; i++) {
          const w = this.spawnEnemy('wisp', [k.pos[0], 2.6, k.pos[2]]);
          w.guard = k.id;
          w.phase = i * Math.PI * 2 / n;
        }
      }
    });
    e.stage = 'KEEPERS';
    e.nextGrabAt = this.t + this.grabCdNow(); // the boss starts contesting the panel
    e.grabAngle = 0; // a fresh round's lattice always wakes in the northern sky
    this.send(null, { t: 'keeperSpawn', ids: [...e.keeperIds] });
    this.toast(`Twin Keepers — ${this.colorName(sig.colors[0])} & ${this.colorName(sig.colors[1])} wards`, 'warn');
  }

  // The panel-grab interval tightens after every damage phase (round-driven).
  grabCdNow() {
    const s = ENC.sigil;
    return Math.max(s.grabCdMin, s.grabCd - s.grabCdStep * (this.enc.round - 1));
  }

  // While the twin ciphers are live, the boss periodically tethers the sky
  // panel and wrenches it around the arena's sky-ring; it rests where it lands.
  // Pure broadcast — the lattice's position is cosmetic to the server (clients
  // still report node indices), so the clients replay the same seeded arc from
  // server time and stay in lockstep (snapshot `ga` re-syncs the resting spot).
  fireGrab() {
    const e = this.enc, s = ENC.sigil;
    e.nextGrabAt = this.t + this.grabCdNow();
    // swing = |N(mean, sd)|, clamped, random direction: usually a quarter-turn,
    // the tails throw the panel clear across the arena
    const u1 = Math.random() || 1e-9, u2 = Math.random();
    const norm = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const swing = Math.min(s.grabRotMax, Math.max(s.grabRotMin, Math.abs(s.grabRotMean + norm * s.grabRotSd)));
    const a0 = e.grabAngle;
    const a1 = Math.round((a0 + (Math.random() < 0.5 ? -1 : 1) * swing) * 1000) / 1000;
    e.grabAngle = a1;
    this.send(null, {
      t: 'latticeGrab', at: this.t, dur: s.grabDur,
      seed: (Math.random() * 0x7fffffff) | 0, a0, a1,
    });
    if (!e.grabSeen) {
      e.grabSeen = true;
      this.toast('The lattice is seized!', 'warn');
    }
  }

  // A star-node in the sky lattice was shot: toggle it, and if the lit set now
  // matches a twin's overlaid pillar code exactly, its ward shatters.
  onSigil(p, m) {
    const e = this.enc, sig = e.sigil;
    if (!this.alive(p) || e.st !== 'MECH' || e.stage !== 'KEEPERS' || !sig) return;
    if (sig.matched[0] && sig.matched[1]) return; // spent — dark while the last strike converges
    const i = Number(m.i);
    if (!Number.isInteger(i) || i < 0 || i > 8) return;
    sig.grid ^= 1 << i;
    this.send(null, { t: 'sigilNode', i, on: !!(sig.grid & (1 << i)) });
    for (const slot of [0, 1]) {
      if (sig.matched[slot] || sig.grid !== sig.codes[slot]) continue;
      sig.matched[slot] = true;
      sig.grid = 0; // the lattice exhales, dark again for the second cipher
      this.gainSuper(p, SUPER.perSigil);
      // the ward holds a moment longer: the lit stars gather into a focal dot
      // and laser it down — the blast lands strikeDelay later (fireStrikes)
      e.strikes.push({ keeperId: e.keeperIds[slot], at: this.t + ENC.sigil.strikeDelay });
      this.send(null, {
        t: 'sigilMatch', slot, color: sig.colors[slot],
        code: sig.codes[slot], kid: e.keeperIds[slot],
      });
      // both ciphers answered → HUNT, but only once the last strike lands
      // (fireStrikes) — flipping the stage hides the panel on every client,
      // and it must stay in the sky while it channels the laser
      break;
    }
  }

  // A scheduled lattice strike lands: the laser bursts the ward, and the
  // backlash one-shots any UNwarded enemy beside it. The struck keeper's own
  // ward soaks the blast (that is what breaking it costs); the other twin
  // survives only if its ward still stands.
  fireStrikes() {
    const e = this.enc;
    for (const s of [...e.strikes]) {
      if (this.t < s.at) continue;
      e.strikes = e.strikes.filter(x => x !== s);
      const k = this.enemies.get(s.keeperId);
      if (!k) continue;
      k.shielded = false;
      this.send(null, { t: 'sigilBlast', p: [...k.pos], color: k.color });
      this.toast(`The ${this.colorName(k.color)} ward bursts!`, 'good');
      for (const en of [...this.enemies.values()]) {
        if (en.id === k.id || en.shielded || en.type === 'blister') continue;
        if (dxz(en.pos, k.pos) >= ENC.sigil.strikeR) continue;
        en.hp -= ENC.sigil.strikeDmg;
        if (en.hp <= 0) this.killEnemy(en, null);
      }
    }
    // the second cipher's strike has landed: NOW the lattice retires (the
    // stage flip is what hides the panel client-side, so it waits for the
    // laser; stage check keeps a splash-kill's FINAL from being clobbered)
    const sig = e.sigil;
    if (e.stage === 'KEEPERS' && sig && sig.matched[0] && sig.matched[1] && !e.strikes.length) {
      e.stage = 'HUNT';
      this.toast('The lattice falls dark.', 'info');
    }
  }

  // Both twins down: the last Keeper rises into the sky above the Watcher,
  // warded in the third color — only its lock's pedestal can ground that ward.
  spawnFinalKeeper() {
    const e = this.enc, sig = e.sigil;
    const hp = Math.round((ENEMIES.keeper.hp + ENC.keeperPerPlayer * (this.players.size - 1)) * ENC.sigil.finalHpMul);
    const k = this.spawnEnemy('keeper', [...ENC.sigil.finalPos], hp);
    k.color = sig.colors[2]; k.shielded = true; k.sky = true;
    k.shieldMax = ENC.sigil.shieldHp + ENC.sigil.shieldPerPlayer * (this.players.size - 1);
    k.shieldHp = k.shieldMax;
    e.finalKeeperId = k.id;
    e.stage = 'FINAL';
    this.send(null, { t: 'heraldRise', id: k.id, color: k.color });
  }

  // The herald's ward gives out: the rupture takes its bearer with it.
  blastWard(e, killer) {
    e.shielded = false;
    this.send(null, { t: 'wardBlast', p: [...e.pos], color: e.color });
    this.toast('The herald is unmade!', 'good');
    this.killEnemy(e, killer);
  }

  openWormhole() {
    const e = this.enc;
    e.stage = 'MISSILE';
    e.wormhole = true;
    e.missileAt = this.t + ENC.sigil.missileFall;
    this.send(null, { t: 'wormhole' });
  }

  applyBossDamage(dmg, p) {
    const e = this.enc;
    if (e.shield || e.bossDead || e.st === 'LOBBY') return false;
    if (p) p.stats.bossDmg += Math.min(dmg, e.bossHp); // overkill past 0 earns nothing
    e.bossHp = Math.max(0, e.bossHp - dmg);
    if (p && p.goldenUntil <= this.t) this.gainSuper(p, dmg * SUPER.perDamage);
    if (e.bossHp <= 0) this.victory(p);
    else if (!e.final && e.bossHp <= e.bossMax * ENC.finalFrac) this.enterFinal();
    return true;
  }

  enterDamage() {
    const e = this.enc;
    e.st = 'DAMAGE'; e.ends = this.t + ENC.damageDur; e.shield = false;
    this.clearPhaseFx(true); // the wormhole stays open overhead for the whole phase
    this.clearAdds();
    this.send(null, { t: 'shieldBreak' });
    e.nextVolleyAt = this.t + 2.5;
    e.nextSpecialAt = this.t + ENC.dmgSpecialFirst; // unlocked specials chain into the phase
    e.nextSeekerAt = this.t + ENC.seekerFirst; e.seekerBonus++;
    // viral mechanic: mark one player (the boss turns to face them) and start
    // the antiviral capsule rain for the blisters on its back
    e.nextCapsuleAt = this.t + ENC.capsuleInterval;
    this.pickFocus();
    this.toast('Capsules fall — blisters quiver.', 'info');
  }

  // ---------- damage-phase viral mechanic ----------

  pickFocus() {
    const targets = this.alivePlayers();
    if (!targets.length) { this.enc.focus = null; return null; }
    const f = pick(targets);
    this.enc.focus = f.id;
    this.send(null, { t: 'bossFocus', id: f.id, name: f.name });
    return f;
  }

  spawnBlisters() {
    // mounted on the Watcher's back; tickBoss keeps them glued as it turns
    for (const m of ENC.blisterMounts) {
      const b = this.spawnEnemy('blister', [0, ENC.bossPos[1] + m.y, 0]);
      b.mountA = m.a; b.mountY = m.y; b.mountR = m.r;
    }
  }

  // Tear down the damage-phase mechanic (blisters stay — they live on the boss).
  // Keys survive into OBLIT (the holder may still wake a well during the warning)
  // unless clearKeys is set.
  endViralPhase(clearKeys = true) {
    this.enc.focus = null;
    this.caps.clear();
    for (const p of this.players.values()) p.antiviral = 0;
    if (clearKeys) {
      this.keys.clear();
      for (const p of this.players.values()) p.hasKey = false;
    }
  }

  enterOblit() {
    const e = this.enc;
    e.st = 'OBLIT'; e.ends = this.t + ENC.oblitWarn; e.shield = true;
    this.clearPhaseFx(); // the tear seals as the Watcher draws everything inward
    this.endViralPhase(false); // blisters & capsules wither; keys stay usable
    // Refuge no longer comes for free: only a key-woken well shelters the team.
    const woken = [...this.wells.values()].some(w => w.kind === 'refuge');
    const keyOut = this.keys.size > 0 || [...this.players.values()].some(p => p.hasKey);
    if (woken) this.toast('The woken well burns!', 'boss');
    else if (keyOut) this.toast('The Auric Key trembles.', 'boss');
    else this.toast('No light stands ready.', 'boss');
  }

  fireOblit() {
    const e = this.enc;
    this.send(null, { t: 'oblit' });
    for (const p of this.alivePlayers()) {
      if (!this.inWell(p)) this.dmgPlayer(p, ENC.oblitDmg, 'oblit');
    }
    // Every key-woken well is spent by the blast, whether it sheltered anyone or not.
    for (const [id, w] of this.wells) {
      if (w.kind !== 'refuge') continue;
      e.burned.push(w.ped);
      this.wells.delete(id);
      this.toast(`Lock ${ARENA.pedestals[w.ped].name}'s well collapses.`, 'warn');
    }
    if (e.st === 'WIPE') return; // the blast erased everyone — there is no next round
    this.enterMech(e.round + 1);
  }

  enterFinal() {
    const e = this.enc;
    e.st = 'FINAL'; e.final = true;
    this.clearPhaseFx();
    this.endViralPhase();
    this.clearAdds();
    // generator surge: the shield reignites and seeker waves pour out under a
    // sweep that holds the whole surge; volleys/specials wait for the true
    // final stand (their timers sit past surgeUntil), and the annihilation
    // clock only starts once the generator gives out (tickBoss drops the shield)
    e.shield = true;
    e.surgeUntil = this.t + ENC.surgeDur;
    e.ends = e.surgeUntil + ENC.annihilation;
    const haste = this.specialHaste();
    const a = Math.random() * Math.PI * 2;
    e.sweep = {
      a1: a, a2: a + Math.PI / 2, w1: ENC.sweepW1 * haste, w2: ENC.sweepW2 * haste,
      armAt: this.t + ENC.sweepWarn / haste, until: e.surgeUntil,
    };
    this.send(null, { t: 'sweep' });
    e.nextSeekerAt = this.t + ENC.surgeFirst; e.seekerBonus++;
    e.nextVolleyAt = e.surgeUntil + 2;
    e.nextSpecialAt = e.surgeUntil + 6; // chained, overlapping specials during the final stand
  }

  victory(p) {
    const e = this.enc;
    e.bossDead = true; e.st = 'VICTORY'; e.ends = this.t + ENC.victoryDelay;
    this.clearPhaseFx();
    this.endViralPhase();
    this.enemies.clear(); this.projs.clear();
    this.chest = { p: [0, 0, 10] };
    for (const q of this.players.values()) {
      if (q.downed || q.dead) { q.downed = false; q.dead = false; q.hp = PLAYER.maxHp / 2; }
    }
    this.send(null, { t: 'bossDied', stats: this.encStats() });
  }

  clearAdds() {
    // blisters are part of the boss, not adds — they survive phase turnover
    for (const e of [...this.enemies.values()]) {
      if (e.type !== 'blister') this.enemies.delete(e.id);
    }
  }

  // ---------- enemies ----------

  spawnEnemy(type, pos, hp = null) {
    const def = ENEMIES[type];
    const e = {
      id: nid(), type, pos: [...pos], yaw: 0,
      hp: hp ?? def.hp, maxHp: hp ?? def.hp,
      nextAtkAt: this.t + rand(0.5, 1.5), strafeDir: Math.random() < 0.5 ? 1 : -1,
      strafeAt: this.t + rand(1, 3),
      // staggered so a fresh wave can't pounce in unison (husk only)
      nextLungeAt: this.t + rand(1, 2.5), windupUntil: 0, lungeUntil: 0,
      chargeUntil: 0, // ranged channel telegraph (acolyte / sky herald)
      snPhase: null, snUntil: 0, snTarget: null, // keeper sniper cycle
    };
    this.enemies.set(e.id, e);
    return e;
  }

  killEnemy(e, killer) {
    this.enemies.delete(e.id);
    if (killer) {
      this.gainSuper(killer, SUPER.perKill);
      killer.stats.kills++;
      if (e.type === 'keeper') killer.stats.keepers++;
    }
    // Wisps die with the Keeper they guard.
    if (e.type === 'keeper') {
      for (const w of [...this.enemies.values()]) {
        if (w.type === 'wisp' && w.guard === e.id) this.killEnemy(w, null);
      }
    }
    // Burst blisters fling the auric key off the boss's back; the purge is spent.
    if (e.type === 'blister') {
      const ang = Math.atan2(e.pos[0], e.pos[2]);
      this.keys.set(nid(), { p: [Math.sin(ang) * ENC.keyDropR, 0, Math.cos(ang) * ENC.keyDropR] });
      if (killer) killer.antiviral = 0;
      this.toast('A blister drops its KEY!', 'good');
    }
    // A destroyed seeker cooks off the salvo around it: chainDmg to every
    // seeker within chainR, each popping a chainFuse later (the stagger makes
    // the ripple readable and keeps the client die-sfx burst-throttle happy).
    // Cooked pops route back through killEnemy, so the chain propagates and
    // credits the instigator's super. detonateSeeker (player/terrain/expiry
    // booms) deliberately does NOT chain — converging missiles would defuse
    // each other on the first impact and gut the salvo's pressure.
    if (e.type === 'seeker') {
      const def = ENEMIES.seeker;
      for (const s of this.enemies.values()) {
        if (s.type !== 'seeker' || s.cookAt) continue;
        if (d3(s.pos, e.pos) > def.chainR) continue;
        s.hp -= def.chainDmg;
        if (s.hp <= 0) {
          s.cookAt = this.t + def.chainFuse;
          s.cookBy = (killer && killer.id) || e.cookBy || null;
        }
      }
    }
    // Ammo drops.
    const drops = [];
    if (e.type === 'keeper') drops.push('heavy', 'energy');
    else if (e.type === 'wisp') {
      if (Math.random() < 0.15) drops.push('energy');
    } else if (e.type !== 'blister' && e.type !== 'seeker') {
      if (Math.random() < 0.28) drops.push('energy');
      if (Math.random() < 0.09) drops.push('heavy');
    }
    for (const kind of drops) {
      this.bricks.set(nid(), { kind, p: [e.pos[0] + rand(-1, 1), 0, e.pos[2] + rand(-1, 1)], until: this.t + 45 });
    }
    this.send(null, { t: 'enemyDied', id: e.id, ty: e.type, p: e.pos });
    // sigil progression: both twins down → the herald rises; herald down → wormhole
    if (e.type === 'keeper' && this.enc.st === 'MECH') {
      const enc = this.enc;
      if (e.sky && e.id === enc.finalKeeperId) {
        enc.finalKeeperId = null;
        this.openWormhole();
      } else if (enc.keeperIds.includes(e.id)) {
        // keeperIds is slot-aligned with the sigil codes — null, don't compact
        enc.keeperIds[enc.keeperIds.indexOf(e.id)] = null;
        if (enc.keeperIds.every(id => id === null)) this.spawnFinalKeeper();
        else this.toast('Its twin still walks.', 'good');
      }
    }
  }

  gainSuper(p, amt) { p.sup = Math.min(100, p.sup + amt); }

  // Live small-add pressure as a 0..1 fill of the per-player ceiling — drives
  // the adaptive wave cadence and the spawn cap. Seekers are boss ordnance and
  // keepers/blisters are objectives: none of them count against the waves.
  addFill() {
    const small = [...this.enemies.values()].filter(e => !['keeper', 'blister', 'seeker'].includes(e.type)).length;
    return Math.min(1, small / (ENC.addCapBase + ENC.addCapPer * this.players.size));
  }

  spawnWave() {
    const n = this.players.size, round = this.enc.round;
    // waves and the live-add ceiling scale per player: 2n husks + n acolytes
    const husks = Math.min(2 + 2 * n + (round - 1), 4 + 2 * n);
    const acolytes = Math.min(1 + n + Math.floor((round - 1) / 2), 2 + n);
    if (this.addFill() >= 1) return;
    for (let i = 0; i < husks; i++) {
      const g = pick(ARENA.gates);
      this.spawnEnemy('husk', [g.p[0] + rand(-3, 3), 0, g.p[2] + rand(-3, 3)]);
    }
    for (let i = 0; i < acolytes; i++) {
      const g = pick(ARENA.gates);
      this.spawnEnemy('acolyte', [g.p[0] + rand(-3, 3), 0, g.p[2] + rand(-3, 3)]);
    }
  }

  nearestAlive(pos) {
    let best = null, bd = Infinity;
    for (const p of this.alivePlayers()) {
      const d = dxz(pos, p.pos);
      if (d < bd) { bd = d; best = p; }
    }
    return [best, bd];
  }

  // Aim ahead along the target's estimated velocity so dodging means changing
  // course, not just holding a strafe. Vertical motion is ignored — jumping
  // dodges. Lead time is capped: slow projectiles over long range would
  // otherwise aim several seconds ahead, which reads as firing at nothing.
  leadAim(from, target, projSpeed) {
    const aim = [target.pos[0], target.pos[1] + 1.2, target.pos[2]];
    const tFly = Math.min(d3(from, aim) / projSpeed, ENC.leadMax);
    const v = target.vel || [0, 0, 0];
    aim[0] += v[0] * tFly * ENC.leadFactor;
    aim[2] += v[2] * tFly * ENC.leadFactor;
    return aim;
  }

  // Lead the target (leadAim) and loose an enemy projectile from `from`.
  fireProjAt(from, target, def, k, r) {
    const aim = this.leadAim(from, target, def.projSpeed);
    const d = d3(from, aim) || 1;
    const v = [(aim[0] - from[0]) / d * def.projSpeed, (aim[1] - from[1]) / d * def.projSpeed, (aim[2] - from[2]) / d * def.projSpeed];
    const pr = { k, p: [...from], v, dmg: def.dmg, r, until: this.t + 6 };
    if (def.helix) {
      // corkscrew (tuning + rationale on ENEMIES.*.helix): the base point
      // flies the straight lead-aim line; tickProjectiles pins the bolt onto
      // a tapered helix around it. Basis ⊥ the (near-horizontal) flight line.
      const dir = [v[0] / def.projSpeed, v[1] / def.projSpeed, v[2] / def.projSpeed];
      const ul = Math.hypot(dir[2], dir[0]) || 1;
      const u = [-dir[2] / ul, 0, dir[0] / ul];
      const w = [dir[1] * u[2], dir[2] * u[0] - dir[0] * u[2], -dir[1] * u[0]];
      pr.hx = {
        bp: [...from], bv: [...v], t0: this.t, T: d / def.projSpeed,
        om: def.helix.om, r: def.helix.r, ph: Math.random() * Math.PI * 2, u, w,
      };
    }
    this.projs.set(nid(), pr);
  }

  moveEnemy(e, dir, speed, dt) {
    e.pos[0] += dir[0] * speed * dt;
    e.pos[2] += dir[2] * speed * dt;
    // stay in arena
    const r = Math.hypot(e.pos[0], e.pos[2]), max = ARENA.radius - 1.2;
    if (r > max) { e.pos[0] *= max / r; e.pos[2] *= max / r; }
    // out of the boss column
    const br = Math.hypot(e.pos[0], e.pos[2]);
    if (br < 5.5 && br > 0.01) { e.pos[0] *= 5.5 / br; e.pos[2] *= 5.5 / br; }
    // out of pillars
    for (const pil of ARENA.pillars) {
      const d = dxz(e.pos, pil.p);
      if (d < pil.r + 0.8 && d > 0.01) {
        const f = (pil.r + 0.8) / d;
        e.pos[0] = pil.p[0] + (e.pos[0] - pil.p[0]) * f;
        e.pos[2] = pil.p[2] + (e.pos[2] - pil.p[2]) * f;
      }
    }
  }

  tickEnemies(dt) {
    for (const e of [...this.enemies.values()]) {
      if (e.type === 'blister') continue; // static objective, no AI
      if (e.type === 'seeker') { this.tickSeeker(e, dt); continue; }
      const def = ENEMIES[e.type];
      const [target, dist] = this.nearestAlive(e.pos);
      if (!target) continue;

      if (e.type === 'wisp') {
        // orbit the guarded Keeper; vanish if it's gone
        const keeper = this.enemies.get(e.guard);
        if (!keeper) { this.enemies.delete(e.id); continue; }
        const ang = this.t * def.orbitSpeed + e.phase;
        e.pos[0] = keeper.pos[0] + Math.cos(ang) * def.orbitR;
        e.pos[2] = keeper.pos[2] + Math.sin(ang) * def.orbitR;
        e.pos[1] = 2.4 + Math.sin(this.t * 3 + e.phase) * 0.5;
        e.yaw = ang + Math.PI / 2;
        if (this.t >= e.nextAtkAt && dist < 38) {
          e.nextAtkAt = this.t + def.fireCd + rand(-0.4, 0.4);
          this.fireProjAt(e.pos, target, def, 'bolt', 0.4);
        }
        continue;
      }

      const to = [(target.pos[0] - e.pos[0]) / (dist || 1), 0, (target.pos[2] - e.pos[2]) / (dist || 1)];
      e.yaw = Math.atan2(to[0], to[2]);

      if (e.type === 'husk') {
        const L = def.lunge;
        if (e.windupUntil && this.t >= e.windupUntil) {
          // crouch elapsed → spring toward where the target stands NOW
          e.windupUntil = 0;
          e.lungeDir = to;
          e.lungeUntil = this.t + L.dur;
        }
        if (this.t < e.lungeUntil) {
          this.moveEnemy(e, e.lungeDir, L.speed, dt);
          // pounce arc — pure flourish, the client renders snapshot y as-is
          e.pos[1] = Math.sin((1 - (e.lungeUntil - this.t) / L.dur) * Math.PI) * L.hop;
          if (dist < def.atkRange) { e.lungeUntil = 0; e.pos[1] = 0; } // landed
        } else if (this.t < e.windupUntil) {
          // rooted crouch — the sudden stop is the telegraph (yaw still tracks)
        } else {
          e.pos[1] = 0;
          if (dist > L.min && dist < L.max && this.t >= e.nextLungeAt) {
            e.nextLungeAt = this.t + L.cd + rand(-0.8, 0.8);
            e.windupUntil = this.t + L.windup;
          } else if (dist > def.atkRange * 0.8) this.moveEnemy(e, to, def.speed, dt);
        }
        if (dist < def.atkRange && this.t >= e.nextAtkAt) {
          e.nextAtkAt = this.t + def.atkCd;
          this.dmgPlayer(target, def.dmg, 'husk', [to[0] * def.kb[0], def.kb[1], to[2] * def.kb[0]]);
        }
      } else if (e.type === 'keeper' && !e.sky) {
        this.tickSniper(e, target, dist, to, dt);
      } else {
        // ranged: acolyte / sky herald (which hovers in place above the boss)
        if (e.sky) {
          e.pos[1] = ENC.sigil.finalPos[1] + Math.sin(this.t * 1.4) * 0.6;
        } else if (e.chargeUntil) {
          // channeling the shot: rooted — stillness + the muzzle orb is the tell
        } else if (dist > (def.rangeMax || 26)) this.moveEnemy(e, to, def.speed, dt);
        else if (dist < (def.rangeMin || 10)) this.moveEnemy(e, [-to[0], 0, -to[2]], def.speed, dt);
        else if (e.type === 'acolyte') {
          if (this.t >= e.strafeAt) { e.strafeDir *= -1; e.strafeAt = this.t + rand(...def.strafe.flip); }
          this.moveEnemy(e, [to[2] * e.strafeDir, 0, -to[0] * e.strafeDir], def.strafe.spd, dt);
        }
        if (e.chargeUntil) {
          if (this.t >= e.chargeUntil) {
            e.chargeUntil = 0;
            e.nextAtkAt = this.t + def.fireCd + rand(-0.3, 0.3);
            const from = [e.pos[0], e.sky ? e.pos[1] : 1.6, e.pos[2]];
            this.fireProjAt(from, target, def,
              e.type === 'keeper' ? 'heavy' : 'bolt', e.type === 'keeper' ? 0.7 : 0.45);
          }
        } else if (this.t >= e.nextAtkAt && dist < 40) {
          // shots telegraph: the channel is snapshot `ch` (end time); the
          // muzzle orb + rising whine are client-side off that field
          e.chargeUntil = this.t + def.chargeT;
        }
      }
    }
    // gentle separation so adds don't stack
    const list = [...this.enemies.values()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j], d = dxz(a.pos, b.pos);
        if (a.type === 'wisp' || b.type === 'wisp') continue;       // orbit-driven
        if (a.type === 'blister' || b.type === 'blister') continue; // rooted
        if (a.type === 'seeker' || b.type === 'seeker') continue;   // 3D fliers
        if (a.sky || b.sky) continue;                               // the herald floats alone
        if (d < 1.4 && d > 0.01) {
          const push = (1.4 - d) / 2 / d;
          const dx = (b.pos[0] - a.pos[0]) * push, dz = (b.pos[2] - a.pos[2]) * push;
          a.pos[0] -= dx; a.pos[2] -= dz; b.pos[0] += dx; b.pos[2] += dz;
        }
      }
    }
  }

  // Keeper sniper cycle (design + numbers on ENEMIES.keeper.snipe): TRACK
  // glues the laser to one prey, LOCK freezes it on the momentum-predicted
  // point, then the shot lands instantly and perfectly on that point. Rooted
  // through both phases — the stillness + beam is the telegraph.
  tickSniper(e, target, dist, to, dt) {
    const S = ENEMIES.keeper.snipe;
    if (e.snPhase === 'track') {
      const tp = this.players.get(e.snTarget);
      if (!tp || tp.dead || tp.downed) { e.snPhase = null; e.snUntil = 0; return; }
      e.yaw = Math.atan2(tp.pos[0] - e.pos[0], tp.pos[2] - e.pos[2]);
      if (this.t >= e.snUntil) {
        e.snPhase = 'lock';
        e.snUntil = this.t + S.lock;
        // freeze the kill-point where CURRENT momentum puts the prey at the
        // shot (chest height, no vertical lead — a well-timed jump dodges)
        e.lockP = [tp.pos[0] + tp.vel[0] * S.lock, tp.pos[1] + 1.0, tp.pos[2] + tp.vel[2] * S.lock];
      }
    } else if (e.snPhase === 'lock') {
      if (this.t >= e.snUntil) {
        e.snPhase = null; e.snUntil = 0;
        e.nextAtkAt = this.t + S.cd + rand(-0.4, 0.4);
        this.fireSnipe(e);
      }
    } else if (dist > S.range) this.moveEnemy(e, to, ENEMIES.keeper.speed, dt);
    else if (this.t >= e.nextAtkAt) {
      e.snPhase = 'track'; e.snUntil = this.t + S.track; e.snTarget = target.id;
    }
  }

  fireSnipe(e) {
    const S = ENEMIES.keeper.snipe;
    const lp = e.lockP;
    // perfectly accurate at the LOCKED point: hits whoever stands in hitR of
    // it at the shot — usually the prey, unless they broke momentum in time
    let victim = null, bd = S.hitR;
    if (!this.losBlocked([e.pos[0], 2.45, e.pos[2]], lp)) {
      for (const p of this.alivePlayers()) {
        const d = d3([p.pos[0], p.pos[1] + 1.0, p.pos[2]], lp);
        if (d < bd) { bd = d; victim = p; }
      }
    }
    if (victim) {
      const dx = victim.pos[0] - e.pos[0], dz = victim.pos[2] - e.pos[2];
      const dl = Math.hypot(dx, dz) || 1;
      this.dmgPlayer(victim, Math.round(PLAYER.maxHp * S.dmgFrac), 'snipe',
        [dx / dl * S.kb[0], S.kb[1], dz / dl * S.kb[0]]);
    }
    this.send(null, {
      t: 'snipe', id: e.id, p: lp.map(v => Math.round(v * 100) / 100),
      hit: victim ? victim.id : null,
    });
  }

  // 2D segment vs pillar discs, height-checked at the crossing — hard cover
  // breaks a sniper shot. The arena center is deliberately NOT a blocker:
  // the boss hovers, the plate below is open ground.
  losBlocked(a, b) {
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const l2 = dx * dx + dz * dz || 1;
    for (const pil of ARENA.pillars) {
      const t = Math.max(0, Math.min(1, ((pil.p[0] - a[0]) * dx + (pil.p[2] - a[2]) * dz) / l2));
      const cx = a[0] + dx * t - pil.p[0], cz = a[2] + dz * t - pil.p[2];
      if (Math.hypot(cx, cz) < pil.r && a[1] + (b[1] - a[1]) * t < pil.h) return true;
    }
    return false;
  }

  // Specials run faster while the boss is exposed, faster still in the final stand.
  specialHaste() {
    return this.enc.st === 'FINAL' ? 1.5 : this.enc.st === 'DAMAGE' ? 1.3 : 1;
  }

  startSweep() {
    const e = this.enc;
    const haste = this.specialHaste();
    const a = Math.random() * Math.PI * 2;
    e.sweep = {
      a1: a, a2: a + Math.PI / 2, w1: ENC.sweepW1 * haste, w2: ENC.sweepW2 * haste,
      armAt: this.t + ENC.sweepWarn / haste, until: this.t + ENC.sweepDur,
    };
    this.send(null, { t: 'sweep' });
  }

  startBarrage() {
    const e = this.enc;
    e.barrageHaste = this.specialHaste();
    e.barrageUntil = this.t + ENC.barrageDur;
    e.barrageNextAt = this.t;
    e.barrageAngle = Math.random() * Math.PI;
    e.barrageDir = Math.random() < 0.5 ? -1 : 1; // each barrage picks its spin
    e.barrageBeatN = 0;
    this.send(null, { t: 'barrage' });
  }

  // ---------- back-launched homing seekers ----------

  // Slow ordnance crawls out of the Watcher's back and hunts: each missile
  // tracks its player with perfect accuracy, and the only outs are shooting
  // it down or feeding it terrain. The salvo grows with every phase entry.
  launchSeekers() {
    const e = this.enc;
    const targets = this.alivePlayers();
    if (!targets.length) return;
    // during the generator surge every guardian is hunted: targets deal out
    // round-robin and the wave never runs short of the fireteam
    const surging = e.surgeUntil > this.t;
    const n = Math.max(ENC.seekerBase + e.seekerBonus, surging ? targets.length : 0);
    // during damage the whole salvo hunts the marked player, like the volleys
    const focus = e.st === 'DAMAGE' ? targets.find(p => p.id === e.focus) : null;
    for (let i = 0; i < n; i++) {
      const a = e.bossYaw + Math.PI + (i - (n - 1) / 2) * 0.5; // fan across the back
      const out = [Math.sin(a), 0, Math.cos(a)];
      const s = this.spawnEnemy('seeker', [
        ENC.bossPos[0] + out[0] * (ENC.bossBodyR - 0.8),
        ENC.bossPos[1] + 2.5,
        ENC.bossPos[2] + out[2] * (ENC.bossBodyR - 0.8),
      ]);
      s.target = (focus || (surging ? targets[i % targets.length] : pick(targets))).id;
      s.popUntil = this.t + ENC.seekerPop;      // climb clear of the hull first
      s.launchV = [out[0] * 5, 7, out[2] * 5];
      s.dieAt = this.t + ENC.seekerLife;        // endless kiting still ends
      s.yaw = a;
    }
    this.send(null, { t: 'seekers', n });
    if (!e.seekerSeen) {
      e.seekerSeen = true;
      this.toast('Brittle-shelled fire crawls out.', 'boss');
    }
  }

  tickSeeker(e, dt) {
    const def = ENEMIES.seeker;
    // sympathetic detonation lands: pops like a shot-down seeker (a dud to
    // players — no blast), which chains onward through killEnemy
    if (e.cookAt && this.t >= e.cookAt) {
      this.killEnemy(e, e.cookBy ? this.players.get(e.cookBy) : null);
      return;
    }
    if (this.t < e.popUntil) {
      // launch arc: up and away from the hull before the homing head wakes
      e.pos[0] += e.launchV[0] * dt; e.pos[1] += e.launchV[1] * dt; e.pos[2] += e.launchV[2] * dt;
    } else {
      let tgt = this.players.get(e.target);
      if (!tgt || !this.alive(tgt)) {
        tgt = this.nearestAlive(e.pos)[0];
        if (!tgt) { this.detonateSeeker(e); return; }
        e.target = tgt.id;
      }
      // perfect accuracy: velocity points straight at the hunted player, always
      const aim = [tgt.pos[0], tgt.pos[1] + 1.0, tgt.pos[2]];
      const d = d3(e.pos, aim) || 1;
      for (const i of [0, 1, 2]) e.pos[i] += (aim[i] - e.pos[i]) / d * def.speed * dt;
      e.yaw = Math.atan2(aim[0] - e.pos[0], aim[2] - e.pos[2]);
    }
    // anyone in the flight path stops it — the hunted or a body-blocker…
    for (const p of this.alivePlayers()) {
      if (d3(e.pos, [p.pos[0], p.pos[1] + 1.0, p.pos[2]]) < 1.0) { this.detonateSeeker(e); return; }
    }
    // …as does terrain (and old age)
    if (this.t > e.dieAt || e.pos[1] < 0.25 || Math.hypot(e.pos[0], e.pos[2]) > ARENA.radius - 0.4) {
      this.detonateSeeker(e); return;
    }
    for (const pil of ARENA.pillars) {
      if (dxz(e.pos, pil.p) < pil.r && e.pos[1] < pil.h) { this.detonateSeeker(e); return; }
    }
  }

  // Detonation (reached someone / hit terrain / expired). Shot-down seekers
  // go through killEnemy instead and explode harmlessly.
  detonateSeeker(e) {
    if (!this.enemies.delete(e.id)) return;
    this.send(null, { t: 'seekerBoom', p: e.pos.map(v => Math.round(v * 100) / 100) });
    const def = ENEMIES.seeker;
    for (const p of this.alivePlayers()) {
      const c = [p.pos[0], p.pos[1] + 1.0, p.pos[2]];
      const d = d3(e.pos, c);
      if (d > def.blastR) continue;
      const dir = d > 0.1 ? [(c[0] - e.pos[0]) / d, 0, (c[2] - e.pos[2]) / d] : [0, 0, 1];
      this.dmgPlayer(p, def.dmg * (1 - 0.4 * d / def.blastR), 'seeker', [dir[0] * def.kb[0], def.kb[1], dir[2] * def.kb[0]]);
    }
  }

  // Two full-diameter beams rotating in opposite directions at shin height.
  // Returns true while active; players dodge by jumping (y >= sweepMaxY).
  tickSweep(dt) {
    const sw = this.enc.sweep;
    if (!sw) return false;
    sw.a1 += sw.w1 * dt;
    sw.a2 += sw.w2 * dt;
    if (this.t >= sw.armAt) {
      for (const p of this.alivePlayers()) {
        if (p.pos[1] >= ENC.sweepMaxY || this.t < (p.sweepCdAt || 0)) continue;
        const r = Math.hypot(p.pos[0], p.pos[2]);
        const th = Math.atan2(p.pos[2], p.pos[0]);
        for (const a of [sw.a1, sw.a2]) {
          let d = ((th - a) % Math.PI + Math.PI) % Math.PI; // fold to [0, π)
          if (d > Math.PI / 2) d = Math.PI - d;             // beam is a full line
          if (r * Math.sin(d) < ENC.sweepWidth) {
            p.sweepCdAt = this.t + 0.7;
            this.dmgPlayer(p, ENC.sweepDmg, 'laser');
            break;
          }
        }
      }
    }
    if (this.t >= sw.until) this.enc.sweep = null;
    return true;
  }

  tickBoss(dt) {
    const e = this.enc;
    if (!['MECH', 'DAMAGE', 'FINAL'].includes(e.st)) return;

    // hard focus: if the marked player falls during the damage phase, mark anew
    if (e.st === 'DAMAGE') {
      const f = this.players.get(e.focus);
      if (!f || !this.alive(f)) this.pickFocus();
    }

    // the boss turns toward its quarry — the marked player while exposed,
    // otherwise whoever is nearest; the snapshot carries this yaw to clients
    let quarry = e.st === 'DAMAGE' ? this.players.get(e.focus) : null;
    if (!quarry || !this.alive(quarry)) quarry = this.nearestAlive(ENC.bossPos)[0];
    if (quarry) {
      const want = Math.atan2(quarry.pos[0] - ENC.bossPos[0], quarry.pos[2] - ENC.bossPos[2]);
      let dy = want - e.bossYaw;
      while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
      e.bossYaw += dy * Math.min(1, dt * (e.st === 'DAMAGE' ? 2.5 : 1.2));
    }
    // keep the back-mounted blisters glued to the body as it turns
    for (const en of this.enemies.values()) {
      if (en.type !== 'blister') continue;
      const a = e.bossYaw + Math.PI + en.mountA;
      en.pos = [Math.sin(a) * en.mountR, ENC.bossPos[1] + en.mountY, Math.cos(a) * en.mountR];
      en.yaw = a;
    }

    // the emergency generator gives out: the surge shield drops and the true
    // final stand begins (clients get the same roar/shake as a shield break)
    if (e.surgeUntil && this.t >= e.surgeUntil) {
      e.surgeUntil = 0; e.shield = false; e.surgeWavesLeft = 0; // a half-fired burst dies with the generator
      this.send(null, { t: 'shieldBreak' });
    }

    // back-launched homing seekers: a basic attack on its own clock,
    // independent of the special chain (active from round 1); the generator
    // surge launches burst after burst instead, each floor(alive/2) waves
    if (this.t >= e.nextSeekerAt) {
      const surging = e.surgeUntil > this.t;
      e.nextSeekerAt = this.t + (surging ? ENC.surgeWaveCd : ENC.seekerCd);
      if (surging) {
        e.surgeWavesLeft = Math.max(1, Math.floor(this.alivePlayers().length / 2)) - 1;
        e.surgeWaveAt = this.t + ENC.surgeWaveGap;
      }
      this.launchSeekers();
    }
    if (e.surgeWavesLeft > 0 && this.t >= e.surgeWaveAt) {
      e.surgeWavesLeft--; e.surgeWaveAt = this.t + ENC.surgeWaveGap;
      this.launchSeekers();
    }

    const sweeping = this.tickSweep(dt);
    const overlap = e.st === 'FINAL'; // final stand: specials stack freely
    if (!sweeping || overlap) {
      // bullet-hell barrage: rotating rings on a beat
      if (e.barrageUntil > this.t) {
        if (this.t >= e.barrageNextAt) {
          const haste = e.barrageHaste || 1;
          const beat = ENC.barrageBeat / haste;
          e.barrageNextAt = this.t + beat;
          e.barrageAngle += 0.5;
          e.barrageBeatN++;
          // beat-locked bob: full sine every two beats, consecutive rings
          // half a cycle apart so the swarm weaves in time with the drum
          const bobF = Math.PI / beat;
          const bobPh = (e.barrageBeatN % 2) * Math.PI;
          for (let i = 0; i < ENC.barrageCount; i++) {
            const a = e.barrageAngle + i * Math.PI * 2 / ENC.barrageCount;
            this.projs.set(nid(), {
              k: 'hell', p: [Math.cos(a) * 2, ENC.barrageY, Math.sin(a) * 2],
              v: [Math.cos(a) * ENC.barrageSpeed * haste, 0, Math.sin(a) * ENC.barrageSpeed * haste],
              w: ENC.barrageCurl * haste * e.barrageDir, bobF, bobPh, bobT0: this.t,
              dmg: ENC.barrageDmg, r: 0.55, until: this.t + 9,
            });
          }
        }
      } else if ((['MECH', 'DAMAGE'].includes(e.st) && e.round >= 2) || e.st === 'FINAL') {
        // schedule the next unlocked special: round 2+ barrages, round 3+
        // alternates in sweeps; the final stand throws everything
        if (this.t >= e.nextSpecialAt) {
          const canSweep = e.st === 'FINAL' || e.round >= 3;
          if (canSweep && e.specialFlip && !e.sweep) this.startSweep();
          else this.startBarrage();
          e.specialFlip = !e.specialFlip;
          e.nextSpecialAt = this.t + (e.st === 'FINAL' ? ENC.finalSpecialCd
            : e.st === 'DAMAGE' ? ENC.dmgSpecialCd : ENC.specialCd);
        }
      }
    }

    // the triple-orb volley belongs to the exposed phases only — the puzzle
    // rounds already have adds/keepers/specials contesting attention
    const volleyCd = e.st === 'FINAL' ? ENC.volleyCdFinal : ENC.volleyCdDmg;
    if (['DAMAGE', 'FINAL'].includes(e.st)
      && (overlap || (!sweeping && e.barrageUntil <= this.t)) && this.t >= e.nextVolleyAt) {
      e.nextVolleyAt = this.t + volleyCd;
      const targets = this.alivePlayers();
      if (targets.length) {
        // during damage the boss pours everything at the marked player
        const target = (e.st === 'DAMAGE' && targets.find(p => p.id === e.focus)) || pick(targets);
        const from = [...ENC.bossPos];
        const aim = this.leadAim(from, target, ENC.volleySpeed);
        for (const spread of [-ENC.volleySpread, 0, ENC.volleySpread]) {
          const dir = [aim[0] - from[0], aim[1] - from[1], aim[2] - from[2]];
          const len = d3(from, aim) || 1;
          const cos = Math.cos(spread), sin = Math.sin(spread);
          const dx = (dir[0] * cos - dir[2] * sin) / len, dz = (dir[0] * sin + dir[2] * cos) / len;
          this.projs.set(nid(), {
            k: 'bossOrb', p: [...from], v: [dx * ENC.volleySpeed, dir[1] / len * ENC.volleySpeed, dz * ENC.volleySpeed],
            dmg: ENC.volleyDmg, r: 0.9, until: this.t + 8,
          });
        }
        this.send(null, { t: 'bossVolley' });
      }
    }
    if (this.t >= e.nextSlamAt) {
      const close = this.alivePlayers().filter(p => dxz(p.pos, ENC.bossPos) < ENC.slamRange);
      if (close.length) {
        e.nextSlamAt = this.t + ENC.slamCd;
        this.send(null, { t: 'bossSlam' });
        for (const p of this.alivePlayers()) {
          const d = dxz(p.pos, ENC.bossPos);
          if (d < ENC.slamRange + 2) {
            const dir = d > 0.1 ? [p.pos[0] / d, 0, p.pos[2] / d] : [1, 0, 0];
            this.dmgPlayer(p, ENC.slamDmg, 'slam', [dir[0] * ENC.slamKb[0], ENC.slamKb[1], dir[2] * ENC.slamKb[0]]);
          }
        }
      } else e.nextSlamAt = this.t + 1;
    }
  }

  // ---------- class grenades ----------

  // Sentinel: the burst splits into mend-orbs that hunt the most-wounded
  // guardians (chosen now, at the split). They ride the snapshot `projs` list
  // (k 'heal') so clients render them like any other server projectile.
  spawnHealOrbs(p, pos) {
    const H = GRENADE.sentinel.heal;
    const hurt = this.alivePlayers().sort((a, b) => a.hp - b.hp);
    if (!hurt.length) return;
    for (let i = 0; i < H.n; i++) {
      const tgt = hurt[Math.min(i, hurt.length - 1)];
      this.projs.set(nid(), {
        k: 'heal', p: [pos[0], Math.max(0.6, pos[1]), pos[2]], v: [0, 0, 0],
        spd: H.speed, tgt: tgt.id, until: this.t + H.life,
      });
    }
  }

  // Perfect tracking at a pace that builds: walking can't shake your own
  // medicine, sprinting only delays it. Terrain never stops light.
  // Returns true once the orb is spent (delivered or expired).
  tickHealOrb(pr, dt) {
    const H = GRENADE.sentinel.heal;
    if (this.t > pr.until) return true;
    let tgt = this.players.get(pr.tgt);
    if (!tgt || !this.alive(tgt)) {
      tgt = this.alivePlayers().sort((a, b) => a.hp - b.hp)[0];
      if (!tgt) return true;
      pr.tgt = tgt.id;
    }
    pr.spd += H.accel * dt;
    const aim = [tgt.pos[0], tgt.pos[1] + 1.0, tgt.pos[2]];
    const d = d3(pr.p, aim) || 1;
    pr.v = [(aim[0] - pr.p[0]) / d * pr.spd, (aim[1] - pr.p[1]) / d * pr.spd, (aim[2] - pr.p[2]) / d * pr.spd];
    for (const i of [0, 1, 2]) pr.p[i] += pr.v[i] * dt;
    if (d < 0.9) {
      tgt.hp = Math.min(PLAYER.maxHp, tgt.hp + H.amount);
      this.send(null, {
        t: 'healBurst', id: tgt.id, amt: H.amount,
        p: pr.p.map(v => Math.round(v * 100) / 100),
      });
      return true;
    }
    return false;
  }

  // Voidcaller orbs gnaw at everything in their area twice a second — flat
  // damage inside r (a zone, not a blast). Wards and blisters stay sealed.
  tickDots() {
    const O = GRENADE.voidcaller.orb;
    for (const [id, z] of this.dots) {
      if (this.t > z.until) { this.dots.delete(id); continue; }
      if (this.t < z.nextAt) continue;
      z.nextAt = this.t + 0.5;
      const owner = this.players.get(z.by) || null;
      const tickDmg = O.dps * 0.5;
      let total = 0;
      for (const e of [...this.enemies.values()]) {
        if (e.type === 'blister' || e.shielded) continue;
        const d = d3(z.p, [e.pos[0], e.type === 'seeker' ? e.pos[1] : 1, e.pos[2]]);
        if (d > O.r) continue;
        e.hp -= tickDmg; total += tickDmg;
        if (e.hp <= 0) this.killEnemy(e, owner);
      }
      // boss super credit comes from applyBossDamage itself
      if (d3(z.p, ENC.bossPos) < O.r + 2) this.applyBossDamage(tickDmg, owner);
      if (owner && total && owner.goldenUntil <= this.t) this.gainSuper(owner, total * SUPER.perDamage);
    }
  }

  tickProjectiles(dt) {
    for (const [id, pr] of this.projs) {
      if (pr.k === 'heal') {
        if (this.tickHealOrb(pr, dt)) this.projs.delete(id);
        continue;
      }
      if (pr.w) {
        // barrage spiral: rotate the heading; the curl decays so the arm
        // straightens outward and dies on the wall instead of orbiting
        const turn = pr.w * dt;
        const c = Math.cos(turn), s = Math.sin(turn);
        const vx = pr.v[0] * c - pr.v[2] * s;
        pr.v[2] = pr.v[0] * s + pr.v[2] * c;
        pr.v[0] = vx;
        pr.w *= Math.max(0, 1 - ENC.barrageCurlDecay * dt);
      }
      if (pr.bobF) {
        // pin the exact sine each tick; v[1] carries the derivative so the
        // client's linear extrapolation (p + v·age) tracks it between snapshots
        const ph = pr.bobF * (this.t - pr.bobT0) + pr.bobPh;
        pr.p[1] = ENC.barrageY + ENC.barrageBobAmp * Math.sin(ph);
        pr.v[1] = ENC.barrageBobAmp * pr.bobF * Math.cos(ph);
      }
      if (pr.hx) {
        // acolyte corkscrew: the base point flies the straight lead-aim line,
        // the bolt rides a sin-tapered helix around it (zero radius at muzzle
        // and predicted arrival — accuracy untouched). Same client trick as
        // the barrage bob: pin the exact pos each tick, pr.v carries the
        // finite-difference derivative for the p + v·age extrapolation.
        const h = pr.hx, age = this.t - h.t0;
        h.bp[0] += h.bv[0] * dt; h.bp[1] += h.bv[1] * dt; h.bp[2] += h.bv[2] * dt;
        const rad = Math.sin(Math.PI * Math.min(1, age / h.T)) * h.r;
        const ph = h.om * age + h.ph;
        const c = Math.cos(ph) * rad, s = Math.sin(ph) * rad;
        for (let i = 0; i < 3; i++) {
          const np = h.bp[i] + h.u[i] * c + h.w[i] * s;
          pr.v[i] = (np - pr.p[i]) / dt;
          pr.p[i] = np;
        }
      } else {
        pr.p[0] += pr.v[0] * dt; pr.p[1] += pr.v[1] * dt; pr.p[2] += pr.v[2] * dt;
      }
      let dead = this.t > pr.until || pr.p[1] < 0 ||
        Math.hypot(pr.p[0], pr.p[2]) > ARENA.radius - 0.3;
      if (!dead) {
        for (const pil of ARENA.pillars) {
          if (dxz(pr.p, pil.p) < pil.r && pr.p[1] < pil.h) { dead = true; break; }
        }
      }
      if (!dead) {
        for (const p of this.alivePlayers()) {
          const center = [p.pos[0], p.pos[1] + 1.0, p.pos[2]];
          if (d3(pr.p, center) < pr.r + 0.9) {
            this.dmgPlayer(p, pr.dmg, pr.k);
            dead = true; break;
          }
        }
      }
      if (dead) this.projs.delete(id);
    }
  }

  // ---------- per-player world interactions ----------

  tickPlayers(dt) {
    const e = this.enc;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      // downed guardians never bleed out — a revive stays possible until the wipe
      if (p.downed) continue;
      // regen
      if (this.t - p.lastDmg > PLAYER.regenDelay && p.hp < PLAYER.maxHp) {
        p.hp = Math.min(PLAYER.maxHp, p.hp + PLAYER.regenRate * dt);
      }
      // ward heal
      if (this.inWell(p, 'ward') && p.hp < PLAYER.maxHp) {
        p.hp = Math.min(PLAYER.maxHp, p.hp + SUPER.ward.heal * dt);
      }
      // passive super
      this.gainSuper(p, SUPER.passiveRate * dt);
      // golden expiry is implicit (goldenUntil < t)

      // revive channel
      if (p.revive) {
        const q = this.players.get(p.revive.target);
        if (!q || !q.downed || dxz(p.pos, q.pos) > PLAYER.reviveRange + 1) p.revive = null;
        else if (this.t >= p.revive.end) {
          q.downed = false; q.hp = PLAYER.maxHp; q.lastDmg = this.t;
          this.send(null, { t: 'revived', id: q.id, by: p.name });
          this.toast(`${p.name} revived ${q.name}`, 'good');
          p.revive = null;
        }
      }

      // ammo bricks
      for (const [bid, b] of this.bricks) {
        if (dxz(p.pos, b.p) < 1.9) {
          this.bricks.delete(bid);
          this.send(p.id, { t: 'ammo', kind: b.kind });
        }
      }
      // antiviral capsules (grounded ones only — they fall for capsuleFall seconds)
      if (p.antiviral < ENC.capsulesNeeded) {
        for (const [cid, c] of this.caps) {
          if (this.t < c.landAt || dxz(p.pos, c.p) > ENC.pickupR) continue;
          this.caps.delete(cid);
          p.antiviral++;
          this.send(p.id, { t: 'capsule', n: p.antiviral });
          if (p.antiviral >= ENC.capsulesNeeded) {
            this.toast(`Blister-flesh recoils from ${p.name}.`, 'good');
          }
          break;
        }
      }
      // auric key pickup
      if (!p.hasKey) {
        for (const [kid, k] of this.keys) {
          if (dxz(p.pos, k.p) > ENC.pickupR) continue;
          this.keys.delete(kid);
          p.hasKey = true;
          // broadcast (with the key id) so every client clears the floor key
          // immediately — the picker alone gets the chime/tip client-side
          this.send(null, { t: 'keyGet', id: p.id, kid });
          this.toast(`${p.name} claims the AURIC KEY`, 'good');
          break;
        }
      }
      // the key wakes a dormant refuge well at an intact pedestal (one use, then
      // the blast collapses that well forever — see fireOblit)
      if (p.hasKey && (e.st === 'DAMAGE' || e.st === 'OBLIT')) {
        ARENA.pedestals.forEach((ped, i) => {
          if (!p.hasKey || e.burned.includes(i)) return;
          if (dxz(p.pos, ped.p) >= ENC.wellWakeR) return;
          if ([...this.wells.values()].some(w => w.kind === 'refuge' && w.ped === i)) return;
          p.hasKey = false;
          this.wells.set(nid(), { p: [...ped.p], r: 6, until: this.t + 9999, kind: 'refuge', ped: i });
          this.send(null, { t: 'wellWake', ped: i, by: p.id });
          this.toast(`Lock ${ped.name}'s well blazes awake.`, 'good');
        });
      }
    }
  }

  // ---------- main tick ----------

  tick(dt) {
    this.t += dt;
    const e = this.enc;

    // expire wells & bricks
    for (const [id, w] of this.wells) if (this.t > w.until) this.wells.delete(id);
    for (const [id, b] of this.bricks) if (this.t > b.until) this.bricks.delete(id);

    switch (e.st) {
      case 'LOBBY': {
        const n = this.players.size;
        const onPlate = [...this.players.values()].filter(p => dxz(p.pos, [0, 0, 0]) < ENC.readyRadius).length;
        if (n > 0 && onPlate === n) {
          e.ready += dt;
          if (e.ready >= ENC.readyTime) { e.ready = 0; this.startEncounter(); }
        } else e.ready = Math.max(0, e.ready - dt * 2);
        break;
      }
      case 'MECH': {
        // spawning pauses while the boss partitions the arena
        if (!e.sweep) {
          // Adaptive cadence: the due time tightens each tick toward
          // waveCdEmpty + (waveCd − waveCdEmpty)·addFill, so a wave-wipe
          // (nova) refills the arena in seconds while a crowded one keeps the
          // slow breath. Tighten-only (Math.min), and only when the timer is
          // normally scheduled — parked timers (the tests' t+999 hush) stay parked.
          if (e.nextWaveAt <= this.t + ENC.waveCd) {
            e.nextWaveAt = Math.min(e.nextWaveAt,
              this.t + ENC.waveCdEmpty + (ENC.waveCd - ENC.waveCdEmpty) * this.addFill());
          }
          if (this.t >= e.nextWaveAt) { e.nextWaveAt = this.t + ENC.waveCd; this.spawnWave(); }
          if (!e.stage && this.t >= e.nextKeeperAt) this.spawnKeepers();
        }
        if (e.strikes.length) this.fireStrikes();
        // the boss harasses the live lattice — hidden and spent panels are
        // left alone (a fully-matched lattice is only discharging its strike)
        if (e.stage === 'KEEPERS' && !(e.sigil.matched[0] && e.sigil.matched[1])
          && this.t >= e.nextGrabAt) this.fireGrab();
        // standing in the herald's lock circle kindles the wardbreaker blessing
        // (a timed buff — only blessed fire can wound the herald's ward)
        if (e.stage === 'FINAL') {
          const k = this.enemies.get(e.finalKeeperId);
          if (k && k.shielded) {
            const ped = ARENA.pedestals[k.color];
            for (const p of this.alivePlayers()) {
              if (dxz(p.pos, ped.p) >= ENC.sigil.pedestalR) continue;
              if (p.wardUntil <= this.t) {
                this.send(p.id, { t: 'wardBuff' });
                this.toast(`${p.name} kindles the ${this.colorName(k.color)} lock.`, 'good');
              }
              p.wardUntil = this.t + ENC.sigil.wardBuffDur;
            }
          }
        }
        if (e.stage === 'MISSILE' && this.t >= e.missileAt) {
          this.send(null, { t: 'missile' });
          this.toast('The shield is ASH.', 'good');
          this.enterDamage();
        }
        break;
      }
      case 'DAMAGE':
        if (this.t >= e.nextCapsuleAt) {
          e.nextCapsuleAt = this.t + ENC.capsuleInterval;
          for (let i = 0; i < ENC.capsulesPerDrop; i++) {
            const a = Math.random() * Math.PI * 2, r = rand(ENC.capsuleDropMin, ENC.capsuleDropMax);
            this.caps.set(nid(), { p: [Math.sin(a) * r, 0, Math.cos(a) * r], landAt: this.t + ENC.capsuleFall });
          }
        }
        if (this.t >= e.ends && !e.final && !e.bossDead) this.enterOblit();
        break;
      case 'OBLIT':
        if (this.t >= e.ends) this.fireOblit();
        break;
      case 'FINAL':
        if (this.t >= e.ends && !e.bossDead) {
          this.toast('Reality folds.', 'boss');
          this.startWipe();
        }
        break;
      case 'WIPE':
        if (this.t >= e.ends) this.resetToLobby('wipe');
        break;
      case 'VICTORY':
        if (this.t >= e.ends) this.resetToLobby('victory');
        break;
    }

    if (e.st !== 'LOBBY' && e.st !== 'WIPE' && e.st !== 'VICTORY') {
      this.tickEnemies(dt);
      this.tickBoss(dt);
    }
    // projectiles tick everywhere: mend-orbs must fly even in the lobby (enemy
    // shots only exist mid-fight anyway, and dmgPlayer gates LOBBY/VICTORY)
    this.tickProjectiles(dt);
    this.tickDots();
    this.tickPlayers(dt);

    this.snapAcc += dt;
    if (this.snapAcc >= 0.1) { this.snapAcc = 0; this.broadcastSnapshot(); }
  }

  broadcastSnapshot() {
    const e = this.enc;
    const sig = e.sigil;
    const snap = {
      t: 'snap', now: this.t,
      enc: {
        st: e.st, round: e.round, stage: e.stage,
        ends: e.ends, ready: e.ready, readyNeed: ENC.readyTime,
        bossHp: Math.round(e.bossHp), bossMax: e.bossMax, shield: e.shield, bossDead: e.bossDead,
        sg: e.surgeUntil, // generator-surge end: the HUD shield panel drains toward it
        burned: e.burned, focus: e.focus, bossYaw: Math.round(e.bossYaw * 100) / 100,
        wh: e.wormhole, mAt: e.missileAt,
        // sigil layout: twin/final colors, per-pillar owner + segment, lattice
        // state, and which codes have been answered
        // ga: the panel's resting sky-ring angle — late/lossy clients re-home
        sig: sig ? { c: sig.colors, o: sig.owners, s: sig.segs, g: sig.grid, m: sig.matched, ga: e.grabAngle } : null,
        sweep: e.sweep ? {
          // w1/w2 let clients extrapolate the beams between 10 Hz snapshots
          a1: Math.round(e.sweep.a1 * 1000) / 1000, a2: Math.round(e.sweep.a2 * 1000) / 1000,
          w1: e.sweep.w1, w2: e.sweep.w2,
          on: this.t >= e.sweep.armAt,
        } : null,
      },
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, cls: p.cls,
        p: p.pos.map(v => Math.round(v * 100) / 100), yaw: Math.round(p.yaw * 100) / 100, pitch: Math.round(p.pitch * 100) / 100,
        hp: Math.round(p.hp), sup: Math.round(p.sup * 10) / 10,
        dn: p.downed, dd: p.dead, gu: p.goldenUntil,
        av: p.antiviral, ky: p.hasKey, wb: p.wardUntil,
        rv: p.revive ? p.revive.end : 0, rt: p.revive ? p.revive.target : null,
      })),
      enemies: [...this.enemies.values()].map(en => ({
        id: en.id, ty: en.type, p: en.pos.map(v => Math.round(v * 100) / 100),
        yaw: Math.round(en.yaw * 100) / 100, hp: Math.round(en.hp), mh: en.maxHp,
        ...(en.chargeUntil ? { ch: Math.round(en.chargeUntil * 100) / 100 } : null),
        ...(en.type === 'keeper' ? {
          cl: en.color, sh: !!en.shielded,
          ...(en.shieldHp != null ? { shp: Math.max(0, Math.round(en.shieldHp)), smh: en.shieldMax } : null),
          // sniper laser: `aim` = tracked prey (client glues the beam to its
          // LIVE position); `lk` = the frozen kill-point, `ft` = fire time
          ...(en.snPhase ? {
            aim: en.snTarget,
            ...(en.snPhase === 'lock' ? { lk: en.lockP.map(v => Math.round(v * 100) / 100), ft: Math.round(en.snUntil * 100) / 100 } : null),
          } : null),
        } : null),
      })),
      projs: [...this.projs.entries()].map(([id, pr]) => ({
        id, k: pr.k, p: pr.p.map(v => Math.round(v * 100) / 100), v: pr.v.map(v => Math.round(v * 100) / 100),
        // helix bolts also carry their curve params: the client replays the
        // exact parametric corkscrew per frame (the p + v·age extrapolation
        // visibly chords a 6 rad/s spiral at 10 Hz) and draws the trail
        // analytically off the same curve. a = seconds already flown.
        ...(pr.hx ? { hx: {
          bp: pr.hx.bp.map(v => Math.round(v * 100) / 100),
          bv: pr.hx.bv.map(v => Math.round(v * 100) / 100),
          a: Math.round((this.t - pr.hx.t0) * 1000) / 1000,
          T: Math.round(pr.hx.T * 1000) / 1000,
          ph: Math.round(pr.hx.ph * 100) / 100, om: pr.hx.om, r: pr.hx.r,
        } } : null),
      })),
      bricks: [...this.bricks.entries()].map(([id, b]) => ({ id, k: b.kind, p: b.p })),
      caps: [...this.caps.entries()].map(([id, c]) => ({ id, p: c.p, land: Math.round(c.landAt * 100) / 100 })),
      keys: [...this.keys.entries()].map(([id, k]) => ({ id, p: k.p })),
      wells: [...this.wells.entries()].map(([id, w]) => ({ id, p: w.p, r: w.r, k: w.kind })),
      chest: this.chest,
      banner: this.banner,
    };
    this.send(null, snap);
  }
}
