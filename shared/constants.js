// Shared between the Node server and the browser client (both ESM).
const pol = (deg, r) => [Math.cos(deg * Math.PI / 180) * r, 0, Math.sin(deg * Math.PI / 180) * r];

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
  spawn: [0, 0, 31],
};

export const PLAYER = {
  maxHp: 200, walk: 8, sprint: 12.5, airControl: 0.35,
  jumpVel: 9.5, gravity: 25, radius: 0.8, eye: 1.7,
  regenDelay: 5, regenRate: 60,
  reviveTime: 3.0, reviveRange: 4.5, bleedout: 45,
  interactRange: 2.6,
};

export const CLASSES = {
  voidcaller: { name: 'Voidcaller', color: '#9d4edd', superName: 'Nova Burst',
    desc: 'Hurl a void singularity that devastates everything near its impact.' },
  gunslinger: { name: 'Gunslinger', color: '#ffb703', superName: 'Golden Volley',
    desc: 'For 9 seconds your weapons deal 3.5x damage. Melt the boss.' },
  sentinel:   { name: 'Sentinel', color: '#4cc9f0', superName: 'Ward Aegis',
    desc: 'Raise a healing dome. Allies inside take half damage and survive Obliteration.' },
};

export const WEAPONS = {
  // primaries
  auto:   { name: 'PULSAR-7', desc: '660 rpm auto rifle', slot: 1, kind: 'hitscan', auto: true, rpm: 660, dmg: 14, critMul: 1.6,
            mag: 36, reload: 1.6, reserves: Infinity, spread: 0.022, adsSpread: 0.011, kick: 0.004, range: 160, zoomFov: 55 },
  hand:   { name: 'DUSKFALL HC', desc: 'hand cannon — heavy crits', slot: 1, kind: 'hitscan', auto: false, rpm: 140, dmg: 42, critMul: 1.8,
            mag: 11, reload: 1.9, reserves: Infinity, spread: 0.007, adsSpread: 0.002, kick: 0.012, range: 200, zoomFov: 52 },
  // specials (green ammo)
  sniper: { name: 'LONGSHOT DR-9', desc: 'precision sniper, 2.1x crit', slot: 2, kind: 'hitscan', auto: false, rpm: 75, dmg: 95, critMul: 2.1,
            mag: 4, reload: 2.2, reserves: 24, maxReserves: 36, spread: 0.015, adsSpread: 0.0005, kick: 0.022, range: 320, zoomFov: 26, ammoPickup: 8 },
  shotgun:{ name: 'CLOSE TALON', desc: '8-pellet burst, close range', slot: 2, kind: 'hitscan', auto: false, rpm: 80, dmg: 15, pellets: 8, critMul: 1.3,
            mag: 5, reload: 2.4, reserves: 15, maxReserves: 25, spread: 0.05, adsSpread: 0.04, kick: 0.02, range: 32, zoomFov: 60, ammoPickup: 5 },
  // heavies (purple ammo)
  rocket: { name: 'CATACLYSM RL', desc: 'big dumb splash damage', slot: 3, kind: 'rocket', auto: false, rpm: 50, projSpeed: 55,
            mag: 1, reload: 2.6, reserves: 5, maxReserves: 7, splashR: 7, splashDmg: 650, zoomFov: 55, ammoPickup: 2 },
  lmg:    { name: 'HARBINGER MG', desc: '450 rpm heavy machine gun', slot: 3, kind: 'hitscan', auto: true, rpm: 450, dmg: 32, critMul: 1.5,
            mag: 60, reload: 3.2, reserves: 120, maxReserves: 200, spread: 0.028, adsSpread: 0.014, kick: 0.004, range: 150, zoomFov: 55, ammoPickup: 30 },
  gjally: { name: 'GJALLARHORN', desc: 'wolfpack rounds ✦', slot: 3, kind: 'gjally', auto: false, rpm: 45, projSpeed: 18,
            mag: 1, reload: 3.0, reserves: 4, maxReserves: 6, splashR: 6, splashDmg: 480,
            wolfDmg: 120, wolfMax: 18, wolfInterval: 0.13, wolfSpeed: 26, secret: true, zoomFov: 55, ammoPickup: 1 },
};

// lobby loadout rows; secret weapons appear only once unlocked
export const LOADOUT = {
  primary: ['auto', 'hand'],
  special: ['sniper', 'shotgun'],
  heavy: ['rocket', 'lmg'],
  secretHeavy: ['gjally'],
};

export const GRENADE = { cd: 18, dmg: 240, r: 5.5, speed: 22, fuse: 1.6 };
export const MELEE = { dmg: 70, range: 2.8, cd: 1.2 };

export const SUPER = {
  passiveRate: 0.8, perDamage: 1 / 220, perKill: 4, perSigil: 20,
  nova:   { kind: 'nova',   dmg: 2600, r: 9, speed: 26 },
  golden: { kind: 'golden', dur: 9, mul: 3.5 },
  ward:   { kind: 'ward',   dur: 12, r: 5.5, heal: 45, dr: 0.5 },
};
export const CLASS_SUPER = { voidcaller: 'nova', gunslinger: 'golden', sentinel: 'ward' };

// Server-side caps on a single client-reported hit, per weapon (pre-golden).
// shotgun is per-trigger-pull (pellets aggregated client-side).
export const DMG_CAPS = { auto: 25, sniper: 230, melee: 90, hand: 80, shotgun: 170, lmg: 52, gjally: 135 };

export const ENEMIES = {
  husk:    { name: 'Riven Husk',   hp: 120, speed: 5.5, dmg: 22, atkRange: 2.4, atkCd: 1.5 },
  acolyte: { name: 'Void Acolyte', hp: 160, speed: 4.6, dmg: 14, fireCd: 3.4, projSpeed: 15, rangeMin: 13, rangeMax: 24 },
  keeper:  { name: 'Vault Keeper', hp: 950, speed: 2.8, dmg: 28, fireCd: 3.6, projSpeed: 13 },
  wisp:    { name: 'Warding Wisp', hp: 80, dmg: 10, fireCd: 4.5, projSpeed: 14, orbitR: 2.9, orbitSpeed: 1.6 },
  // static damage-phase objective; immune unless the shooter carries 3 antiviral patches
  blister: { name: 'Viral Blister', hp: 220 },
  // back-launched homing missile: slow, perfectly tracking, shootable ordnance
  // (no hp bar client-side — it reads as a projectile, not a creature)
  seeker:  { name: 'Riven Seeker', hp: 90, speed: 6.5, dmg: 38, blastR: 3 },
};

export const ENC = {
  bossName: 'VAULTHUR, SHATTERED WATCHER OF THE DEEP',
  bossPos: [0, 10, 0], bossBodyR: 4.2,
  bossBase: 26000, bossPerPlayer: 22000, // > solo base/2: groups must out-coordinate, not just outnumber
  keeperPerPlayer: 320,
  damageDur: 25, oblitWarn: 4.5, oblitDmg: 9999, // unsheltered = erased
  finalFrac: 0.25, annihilation: 32,
  waveCd: 18, addCapBase: 8, addCapPer: 4, firstKeeperDelay: 6,
  readyTime: 3, readyRadius: 4,
  // sky-sigil mechanic (MECH): twin warded keepers + the 3x3 star lattice.
  // Codes/segments live in shared/sigil.js; these are the spatial knobs.
  sigil: {
    // the lattice hangs as a near-vertical constellation in the northern sky,
    // tilted toward the arena — a flat overhead grid would have no canonical
    // "top row", making the pillar panels unreadable
    gridPos: [0, 50, -55], gridGap: 7,
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
  // Cadence tightens when the boss is exposed — standing on the crit core has
  // to cost constant attention, especially in round 1 when no specials exist.
  volleyCdMech: 5, volleyCdDmg: 3, volleyCdFinal: 2, volleyDmg: 30, volleySpeed: 22, volleySpread: 0.2,
  slamRange: 9.5, slamCd: 6, slamDmg: 45,
  // seekers: slow homing missiles off the boss's back, active from round 1.
  // Perfect tracking is the threat; the counters are shooting them down (a
  // couple of body shots) or feeding them a pillar/wall. The salvo starts at
  // seekerBase and grows +1 on every phase entry (MECH → DAMAGE → next MECH
  // → … → FINAL); seekerPop is the climb-clear arc before the homing head
  // wakes, seekerLife caps endless kiting (speed < walk, so they ARE kitable).
  seekerCd: 16, seekerFirst: 8, seekerBase: 2, seekerPop: 0.9, seekerLife: 25,
  leadFactor: 0.85, // enemy shots aim this far ahead along the target's velocity
  leadMax: 0.9,     // …but never more than this many seconds of travel — slow
                    // projectiles (volley speed 11) otherwise aim absurdly wide
  // boss specials (escalate per round; hasted & chained during damage / final stand)
  specialFirstDelay: 12, specialCd: 18, dmgSpecialFirst: 5, dmgSpecialCd: 8, finalSpecialCd: 6.5,
  barrageDur: 6, barrageBeat: 0.55, barrageCount: 7, barrageSpeed: 8.5, barrageDmg: 18,
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
