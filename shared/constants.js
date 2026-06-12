// Shared between the Node server and the browser client (both ESM).
const pol = (deg, r) => [Math.cos(deg * Math.PI / 180) * r, 0, Math.sin(deg * Math.PI / 180) * r];

// spawn sits on the empty radial between two pillars (pedestals hold 90/210/330,
// gates 30/150/270), so nothing crowds the fireteam's drop point
const spawn = pol(60, 31);

export const ARENA = {
  radius: 38,
  wallHeight: 16,
  pillars: [0, 60, 120, 180, 240, 300].map(a => ({ p: pol(a + 30, 17), r: 1.7, h: 9 })),
  pedestals: [
    { p: pol(90, 28),  name: 'ROSE',  color: '#ff5d8f' },
    { p: pol(210, 28), name: 'AZURE', color: '#4cc9f0' },
    { p: pol(330, 28), name: 'AMBER', color: '#ffb703' },
  ],
  gates: [30, 150, 270].map(a => ({ p: pol(a, 35.5), ang: (a + 180) * Math.PI / 180 })),
  spawn,
  spawnYaw: Math.atan2(spawn[0], spawn[2]), // faces the arena center from spawn
};

export const PLAYER = {
  maxHp: 200, walk: 8, sprint: 12.5, airControl: 0.35,
  jumpVel: 9.5, gravity: 25, radius: 0.8, eye: 1.7,
  // ceiling on summed knockback per client frame: TCP clumping at high ping
  // can deliver several shoves in one frame; 18 lets the strongest single
  // shove (slam, |[14,9]| ≈ 16.6) through untouched and trims only pile-ups
  kbFrameCap: 18,
  regenDelay: 5, regenRate: 60,
  reviveTime: 3.0, reviveRange: 4.5,
  interactRange: 2.6,
};

export const CLASSES = {
  voidcaller: { name: 'Voidcaller', color: '#9d4edd', superName: 'Nova Burst',
    desc: 'Hurl a void singularity that detonates in a vast wave and looses eight hunting shards. Grenades leave a gnawing void orb behind.' },
  gunslinger: { name: 'Gunslinger', color: '#ffb703', superName: 'Golden Volley',
    desc: 'For 9 seconds your weapons deal 3.5x damage. Melt the boss. Grenades burst into four hunting embers.' },
  sentinel:   { name: 'Sentinel', color: '#4cc9f0', superName: 'Ward Aegis',
    desc: 'Raise a healing dome. Allies inside take half damage and survive Obliteration. Grenades split into mend-orbs that chase the wounded.' },
};

// recoil: per-shot pattern of [up, right] steps in multiples of `kick`.
// Sustained fire walks the camera along the pattern (the spray climbs/drifts);
// past the end it holds the last step with a horizontal wander. Client-feel
// only — the server never sees recoil (hits are client raycasts as usual).
export const WEAPONS = {
  // primaries
  auto:   { name: 'PULSAR-7', desc: '660 rpm auto rifle', slot: 1, kind: 'hitscan', auto: true, rpm: 660, dmg: 14, critMul: 1.6,
            mag: 36, reload: 1.6, reserves: Infinity, spread: 0.022, adsSpread: 0.011, kick: 0.004, range: 160, zoomFov: 55,
            // climb, drift right, swing back left — the classic S
            recoil: [[1, 0], [1.15, 0.05], [1.3, 0.12], [1.45, 0.22], [1.55, 0.38], [1.5, 0.58], [1.35, 0.78], [1.15, 0.92],
                     [1, 0.7], [0.95, 0.3], [0.9, -0.15], [0.9, -0.55], [0.95, -0.85], [1, -1], [1, -0.6], [0.95, -0.25]] },
  hand:   { name: 'DUSKFALL HC', desc: 'hand cannon — heavy crits', slot: 1, kind: 'hitscan', auto: false, rpm: 120, dmg: 48, critMul: 2.5,
            // precision identity: the 120 crit one-taps a husk (120 hp) and crit+anything fells
            // an acolyte (160 hp) without ever one-shotting it — that floor forces crit DPS to
            // 120×rpm/60, so rpm is the only safe DPS knob. At 120 rpm: 96 body DPS (spray is
            // the auto's game at 154) vs 240 all-crits — well over realistic body-shot auto
            // fire and still under the sniper (~249) and point-blank shotgun (~277)
            mag: 11, reload: 1.9, reserves: Infinity, spread: 0.007, adsSpread: 0.002, kick: 0.012, range: 200, zoomFov: 52,
            recoil: [[1, 0.12], [1.1, -0.1], [1.2, 0.15], [1.25, -0.12], [1.3, 0.18]] },
  // specials (green ammo)
  sniper: { name: 'LONGSHOT DR-9', desc: 'precision sniper, 2.1x crit', slot: 2, kind: 'hitscan', auto: false, rpm: 75, dmg: 95, critMul: 2.1,
            mag: 4, reload: 2.2, reserves: 24, maxReserves: 36, spread: 0.015, adsSpread: 0.0005, kick: 0.022, range: 320, zoomFov: 26, ammoPickup: 8,
            recoil: [[1, 0.06]] },
  shotgun:{ name: 'CLOSE TALON', desc: '8-pellet burst, close range', slot: 2, kind: 'hitscan', auto: false, rpm: 80, dmg: 20, pellets: 8, critMul: 1.3,
            // falloff: full damage inside `start` m (out-crits the sniper there: ~277 vs ~249 crit
            // DPS), fading linearly to `min`× at `range` — the identity is burst supremacy up close
            falloff: { start: 12, min: 0.3 },
            mag: 5, reload: 2.4, reserves: 15, maxReserves: 25, spread: 0.05, adsSpread: 0.04, kick: 0.02, range: 32, zoomFov: 60, ammoPickup: 5,
            recoil: [[1, 0.18], [1.05, -0.22]] },
  // heavies (purple ammo)
  rocket: { name: 'CATACLYSM RL', desc: 'big dumb splash damage', slot: 3, kind: 'rocket', auto: false, rpm: 50, projSpeed: 55,
            mag: 1, reload: 2.6, reserves: 5, maxReserves: 7, splashR: 7, splashDmg: 650, zoomFov: 55, ammoPickup: 2,
            kick: 0.03, recoil: [[1, 0]] },
  lmg:    { name: 'HARBINGER MG', desc: '450 rpm heavy machine gun', slot: 3, kind: 'hitscan', auto: true, rpm: 450, dmg: 32, critMul: 1.5,
            mag: 60, reload: 3.2, reserves: 120, maxReserves: 200, spread: 0.028, adsSpread: 0.014, kick: 0.004, range: 150, zoomFov: 55, ammoPickup: 30,
            // rattling zigzag — heavy gun shakes side to side as it climbs
            recoil: [[1.2, 0], [1.3, -0.22], [1.35, 0.28], [1.4, -0.38], [1.4, 0.45], [1.35, -0.52], [1.3, 0.58], [1.25, -0.62], [1.2, 0.62], [1.2, -0.62]] },
  gjally: { name: 'GJALLARHORN', desc: 'wolfpack rounds ✦', slot: 3, kind: 'gjally', auto: false, rpm: 45, projSpeed: 18,
            mag: 1, reload: 3.0, reserves: 4, maxReserves: 6, splashR: 6, splashDmg: 480,
            wolfDmg: 120, wolfMax: 18, wolfInterval: 0.13, wolfSpeed: 26, secret: true, zoomFov: 55, ammoPickup: 1,
            kick: 0.035, recoil: [[1, 0.1]] },
};

// lobby loadout rows; secret weapons appear only once unlocked
export const LOADOUT = {
  primary: ['auto', 'hand'],
  special: ['sniper', 'shotgun'],
  heavy: ['rocket', 'lmg'],
  secretHeavy: ['gjally'],
};

// Per-class grenades (one shared cooldown/throw arc, class-colored client-side).
// Damage budget: the gunslinger front-loads (biggest blast + four homing embers
// at ~520 total), the voidcaller trades upfront punch for ~2x the total through
// the lingering void orb (~1050), the sentinel deals nothing and mends instead.
export const GRENADE = {
  cd: 18, speed: 22, fuse: 1.6,
  // swarm: client-side homing bolts (wolfpack machinery) hitting as `gswarm`
  gunslinger: { dmg: 300, r: 5.5, swarm: { n: 4, dmg: 55, speed: 18 } },
  // orb: server-side DoT zone parked at the blast, flat damage inside r
  voidcaller: { dmg: 180, r: 5.5, orb: { dps: 145, dur: 6, r: 4.5 } },
  // heal: server-simulated orbs chasing the two most-wounded guardians (picked
  // at the split); they start at walking pace and accelerate — perfect tracking
  sentinel:   { dmg: 0, r: 0, heal: { n: 2, amount: 90, speed: 8, accel: 6, life: 8 } },
};
export const MELEE = { dmg: 70, range: 2.8, cd: 1.2 };

export const SUPER = {
  passiveRate: 0.8, perDamage: 1 / 220, perKill: 4, perSigil: 20,
  // cast: the Destiny-style flourish. The client pulls to third person for dur
  // s (movement + fire rooted) and the payoff lands apex s in; the server
  // mirrors the window as castUntil and grants dr damage resistance — a rooted
  // caster mid-flourish must not be a free kill for volleys/snipers.
  cast: { dur: 1.6, apex: 0.9, dr: 0.6 },
  // nova budget: the core blast traded raw punch (was 2600 / 9 m) for a vast
  // wave plus 20 homing shards (client-side wolfpack machinery landing as
  // capped `nswarm` hits) — most of the super's damage now rides the swarm.
  // Each shard one-shots an acolyte (160 hp); the wave's rim (falloff bottoms
  // at 0.45× → 270) still erases every ordinary add, so only keepers and
  // warded things survive the burst.
  nova:   { kind: 'nova',   dmg: 600, r: 16, speed: 26, swarm: { n: 20, dmg: 170, speed: 20 } },
  golden: { kind: 'golden', dur: 9, mul: 3.5 },
  ward:   { kind: 'ward',   dur: 12, r: 5.5, heal: 45, dr: 0.5 },
};
export const CLASS_SUPER = { voidcaller: 'nova', gunslinger: 'golden', sentinel: 'ward' };

// Server-side caps on a single client-reported hit, per weapon (pre-golden).
// shotgun is per-trigger-pull (pellets aggregated client-side).
export const DMG_CAPS = { auto: 25, sniper: 230, melee: 90, hand: 125, shotgun: 225, lmg: 52, gjally: 135, gswarm: 60, nswarm: 180 };

export const ENEMIES = {
  // kb: knockback shove as [horizontal, vertical] m/s. The client computes
  // slam/seeker shoves itself off the FX broadcast (its own live position —
  // the server's view is an RTT stale); husk rides the hurt's imp.
  // lunge: the anti-kite pounce. Inside the min–max band the husk roots for
  // windup s (the sudden stop IS the telegraph), then springs at lunge speed
  // along a heading locked at launch — no mid-flight tracking, so a strafe
  // slips it. Budget vs player speeds (walk 8, sprint 12.5): a backpedaler
  // opens max + 8·windup ≈ 8.8 m by launch and the dash closes
  // (20−8)·0.55 = 6.6 m → caught inside atkRange; a sprinter holds ~6.3 m →
  // sprinting (or a sidestep) escapes. hop is the cosmetic pounce arc.
  husk:    { name: 'Riven Husk',   hp: 120, speed: 5.5, dmg: 22, atkRange: 2.4, atkCd: 1.5, kb: [5, 3],
             lunge: { min: 3, max: 6, windup: 0.35, speed: 20, dur: 0.55, cd: 5, hop: 0.9 } },
  // helix: the bolt corkscrews around its straight lead-aim line. The radius
  // tapers sin(π·t/T) — zero at the muzzle and at the predicted arrival — so
  // it lands exactly where a straight bolt would (accuracy untouched); only
  // the mid-flight convergence point is hard to read. om 6 rad/s ≈ 1–1.5
  // turns per in-band flight. strafe: in-band slide (m/s — was speed·0.7 =
  // 3.2, raised to punish lazy tracking) and the flip interval [min, max] s.
  // chargeT: every ranged shot channels for this long before it leaves —
  // rooted, snapshot `ch` drives the swelling muzzle orb + rising whine
  // client-side (bolts were materializing unannounced). The channel also
  // stretches the effective fire interval to fireCd + chargeT.
  acolyte: { name: 'Void Acolyte', hp: 160, speed: 4.6, dmg: 14, fireCd: 3.4, projSpeed: 15, rangeMin: 13, rangeMax: 24,
             chargeT: 0.7, helix: { r: 0.8, om: 6 }, strafe: { spd: 4.2, flip: [0.9, 2.2] } },
  // keeper = SNIPER. snipe: TRACK (laser glued to its prey for track s) →
  // LOCK (the beam freezes for lock s on the point the prey's CURRENT
  // momentum reaches at the shot — chest height, no vertical lead) → an
  // instantaneous, perfectly accurate hit for dmgFrac of max HP on whoever
  // stands within hitR of that point. The counterplay is a momentum change
  // inside the lock window (brake, reverse, jump) or hard cover — pillars
  // block the shot (losBlocked). lock must comfortably exceed the ~0.1–0.15 s
  // snapshot lag so the frozen beam is readable before the crack. dmgFrac
  // stays under 0.5 so eating BOTH keepers' snipes back-to-back leaves a
  // sliver of HP instead of a no-counterplay down.
  // fireCd/projSpeed/chargeT drive only the sky herald's heavy lobs (it keeps
  // the old ranged behavior — its fight is about standing in the pedestal
  // circle, where momentum-dodging would fight the objective).
  keeper:  { name: 'Vault Keeper', hp: 950, speed: 2.8, dmg: 28, fireCd: 3.6, projSpeed: 13, chargeT: 0.9,
             snipe: { range: 34, track: 1.6, lock: 0.6, cd: 4.2, hitR: 1.4, dmgFrac: 0.4, kb: [4, 2] } },
  wisp:    { name: 'Warding Wisp', hp: 80, dmg: 10, fireCd: 4.5, projSpeed: 14, orbitR: 2.9, orbitSpeed: 1.6 },
  // static damage-phase objective; immune unless the shooter carries 3 antiviral patches
  blister: { name: 'Viral Blister', hp: 220 },
  // back-launched homing missile: perfectly tracking, shootable ordnance
  // (no hp bar client-side — it reads as a projectile, not a creature).
  // speed sits between walk (8) and sprint (12.5): walking can't escape one.
  // Shooting one down cooks off every seeker within chainR (chainDmg one-shots
  // a healthy missile, so the salvo ripples, one pop per chainFuse) — but the
  // chain pops are duds to players, and detonations on players/terrain never
  // chain, or converging missiles would defuse each other on first impact.
  seeker:  { name: 'Riven Seeker', hp: 90, speed: 8.5, dmg: 38, blastR: 3, kb: [7, 4],
             chainR: 4, chainDmg: 110, chainFuse: 0.15 },
};

export const ENC = {
  bossName: 'VAULTHUR, SHATTERED WATCHER OF THE DEEP',
  bossPos: [0, 10, 0], bossBodyR: 4.2,
  bossBase: 26000, bossPerPlayer: 22000, // > solo base/2: groups must out-coordinate, not just outnumber
  keeperPerPlayer: 320,
  damageDur: 25, oblitWarn: 4.5, oblitDmg: 9999, // unsheltered = erased
  finalFrac: 0.25, annihilation: 32,
  // final-stand surge: at the threshold the emergency generator reignites the
  // shield — the boss is immune for surgeDur while seeker bursts launch every
  // surgeWaveCd (round-robin, so every guardian is hunted) under one sweep that
  // holds the whole surge: jump the beams between bursts of rocket fire. Each
  // burst is floor(alive/2) waves (min 1) rippling surgeWaveGap apart — the gap
  // keeps every fan a distinct, shootable salvo instead of one wrapped-around
  // wall, and the scaling means a duo feels one wave while a full fireteam
  // weathers three. The annihilation clock starts only once the generator
  // gives out.
  surgeDur: 30, surgeWaveCd: 2, surgeFirst: 1.5, surgeWaveGap: 0.45,
  // wave cadence is adaptive: each tick the MECH wave timer tightens toward
  // waveCdEmpty + (waveCd − waveCdEmpty) · live-add fill (game.addFill), so a
  // nova-wiped arena refills in seconds while a near-cap arena keeps the slow
  // breath — pressure recovers from wipes without ever stacking past the cap
  waveCd: 18, waveCdEmpty: 5, addCapBase: 8, addCapPer: 4, firstKeeperDelay: 6,
  readyTime: 3, readyRadius: 4,
  // rally banner: planted on the white circle directly ahead of spawn (same
  // radial, 6 m toward the center) during LOBBY only; each guardian can rally
  // at it once for a full ammo/cooldown restock
  banner: { pos: pol(60, 25), placeR: 2.6, restockR: 3.2 },
  // sky-sigil mechanic (MECH): twin warded keepers + the 3x3 star lattice.
  // Codes/segments live in shared/sigil.js; these are the spatial knobs.
  sigil: {
    // the lattice hangs as a near-vertical constellation in the northern sky,
    // tilted toward the arena — a flat overhead grid would have no canonical
    // "top row", making the pillar panels unreadable
    gridPos: [0, 50, -55], gridGap: 7,
    // panel grab: while the twin ciphers are live, the boss tethers a side
    // handle every grabCd and wrenches the whole panel around the arena's
    // 55 m sky-ring (it keeps facing the center, so the codes stay readable).
    // The swing is |N(grabRotMean, grabRotSd)| with a random direction — most
    // grabs are a quarter-turn, the tails hurl it across the whole arena —
    // and the panel STAYS where it lands until the next grab (round reset
    // re-homes it north). The server broadcasts {at, dur, seed, a0, a1};
    // every client replays the same seeded jerk path from server time.
    grabCd: 10, grabCdStep: 3, grabCdMin: 4, // interval, tightening each round
    grabDur: 3,                   // how long the tether holds before letting go
    grabStep: 0.5,                // seconds per jerk waypoint along the arc
    grabRotMean: Math.PI / 2, grabRotSd: 0.7,
    grabRotMin: 0.25, grabRotMax: Math.PI, // clamp: always felt, at most a half-orbit
    grabJitter: 0.3,              // erratic per-waypoint wobble along the arc (rad)
    // lattice strike: a matched code gathers its lit stars into a focal dot
    // that lasers the keeper — the blast breaks the ward and one-shots any
    // UNwarded enemy near it (the other twin survives only behind its ward)
    strikeDelay: 1.6,             // match → blast (client FX runs on the same clock)
    strikeR: 9, strikeDmg: 4000,  // one-shots any keeper at full coop scaling
    finalPos: [0, 19, 0],         // the last keeper hovers clear above the boss shield (y10 + r7.5)
    finalHpMul: 1.5,
    pedestalR: 5,                 // stand this close to its color's lock to kindle the buff
    // the herald's ward is a destructible shield: only wardbreaker-buffed fire
    // wounds it, and it is deliberately weak — when it ruptures, the blast
    // takes the herald with it
    shieldHp: 420, shieldPerPlayer: 140,
    wardBuffDur: 6,               // wardbreaker lasts this long after leaving the circle
    wormholePos: [0, 38, 0],      // the tear hangs high over everything, parallel to the floor
    missileFall: 2.4,             // wormhole-open → missile impact (shield break)
  },
  wipeDelay: 5, victoryDelay: 30,
  // volley: fast enough that you slot into the gaps between the three orbs
  // instead of outrunning them; the spread keeps those gaps standable at range.
  // DAMAGE/FINAL only — standing on the crit core has to cost constant
  // attention, but the puzzle phase stays readable without it.
  volleyCdDmg: 3, volleyCdFinal: 2, volleyDmg: 30, volleySpeed: 22, volleySpread: 0.2,
  slamRange: 9.5, slamCd: 6, slamDmg: 45, slamKb: [14, 9], // kb: see ENEMIES
  // boss-wake shockwave (harmless, cinematic): hurls the fireteam off the
  // center plate toward the arena edge. A one-shot impulse can't carry that
  // far (the client's air blend bleeds velocity at ~4.5/s), so this is a lift
  // plus a sustained outward wind — acc m/s² for dur s lands a plate-stander
  // around the spawn ring.
  wakeShove: { acc: 130, lift: 12, dur: 1.2 },
  // dormant hover: the hull hangs `drop` m above bossPos all lobby, then falls
  // for `dur` s on bossWake (ease-in, client-cosmetic — the server's boss never
  // moves) and lands exactly as the wakeShove wind fires, selling the slam.
  wakeDrop: { drop: 30, dur: 1.1 },
  // seekers: homing missiles off the boss's back, active from round 1.
  // Perfect tracking is the threat; the counters are shooting them down (a
  // couple of body shots), feeding them a pillar/wall, or sprinting away —
  // speed beats walk but not sprint. The salvo starts at seekerBase and grows
  // +1 on every phase entry (MECH → DAMAGE → next MECH → … → FINAL);
  // seekerPop is the climb-clear arc before the homing head wakes,
  // seekerLife expires the ones a sprinter strings along.
  seekerCd: 16, seekerFirst: 8, seekerBase: 2, seekerPop: 0.9, seekerLife: 25,
  leadFactor: 0.85, // enemy shots aim this far ahead along the target's velocity
  leadMax: 0.9,     // …but never more than this many seconds of travel — slow
                    // projectiles (volley speed 11) otherwise aim absurdly wide
  // boss specials (escalate per round; hasted & chained during damage / final stand)
  specialFirstDelay: 12, specialCd: 18, dmgSpecialFirst: 5, dmgSpecialCd: 8, finalSpecialCd: 6.5,
  // barrage: spiral arms of ember rings riding chest-high — the band
  // (barrageY ± bob) always overlaps a grounded or single-jumping hull
  // (jump apex ~1.8 m), so you weave the gaps sideways instead of hopping
  // the rings. The curl decays so the arms straighten and die on the wall
  // instead of orbiting forever; the bob is beat-locked (one full sine every
  // two beats, alternate rings half a cycle apart) so the swarm pulses in
  // time with the spawn drum.
  barrageDur: 6, barrageBeat: 0.55, barrageCount: 7, barrageSpeed: 8, barrageDmg: 18,
  barrageY: 1.9, barrageBobAmp: 0.5, barrageCurl: 0.9, barrageCurlDecay: 0.22,
  sweepDur: 9, sweepWarn: 1.4, sweepDmg: 35, sweepW1: 0.85, sweepW2: -1.25,
  sweepWidth: 0.8, sweepMaxY: 1.3,
  // viral mechanic: back-mounted blisters → antiviral capsules → auric key → refuge well
  // mounts hug the back hemisphere but peek past the silhouette from the front:
  // left flank, right flank, underbelly (a = radians off the back center)
  blisterMounts: [
    { a: -1.3, y: 0.4, r: 3.6 },
    { a: 1.3, y: 0.4, r: 3.6 },
    { a: 0, y: -3.3, r: 2.0 },
  ],
  keyDropR: 7,
  capsuleInterval: 5, capsulesPerDrop: 2, capsuleFall: 1.4,
  capsuleDropMin: 10, capsuleDropMax: 30, capsulesNeeded: 3,
  pickupR: 1.9, wellWakeR: 4.5,
};

export const MAX_PLAYERS = 6;
