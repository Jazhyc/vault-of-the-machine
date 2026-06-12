// Headless simulation of the full encounter with a fake clock — no browser, no sockets.
import assert from 'node:assert';
import { Game } from '../server/game.js';
import { ARENA, ENC, ENEMIES, PLAYER, SUPER, MAX_PLAYERS, GRENADE, DMG_CAPS, BOTS } from '../shared/constants.js';
import { rollSigil, SIGIL_SEGMENTS, maskOf } from '../shared/sigil.js';

let msgs = [];
const mkGame = () => { msgs = []; return new Game((to, m) => msgs.push({ to, m })); };
const advance = (g, seconds, step = 0.05) => { for (let t = 0; t < seconds; t += step) g.tick(step); };
const moveTo = (g, id, pos) => g.onMessage(id, { t: 'state', pos, yaw: 0, pitch: 0 });
// Flow tests pin HP sky-high so add/boss chip damage can't derail the state machine.
// Regen/heal are gated on hp < maxHp, so this sticks.
const god = (g) => { for (const p of g.players.values()) if (!p.dead && !p.downed) p.hp = 1e9; };
const ok = (name) => console.log(`  ✓ ${name}`);
const keepersOf = (g) => [...g.enemies.values()].filter(e => e.type === 'keeper');
const slay = (g, id) => { while (g.enemies.has(id)) g.onMessage('p1', { t: 'hit', target: id, dmg: 200, weapon: 'sniper' }); };

// ---------- sigil patterns: segments, rolls, code overlays ----------
{
  // every enumerated segment is a straight, step-adjacent run of 2-3 nodes
  assert.equal(SIGIL_SEGMENTS.length, 24, '8 lines × (1 triple + 2 pairs)');
  for (const seg of SIGIL_SEGMENTS) {
    assert.ok(seg.length === 2 || seg.length === 3, 'segments are 2-3 nodes long');
    const dr = Math.floor(seg[1] / 3) - Math.floor(seg[0] / 3);
    const dc = (seg[1] % 3) - (seg[0] % 3);
    assert.ok(Math.abs(dr) <= 1 && Math.abs(dc) <= 1 && (dr !== 0 || dc !== 0),
      'consecutive nodes are lattice neighbors (h/v/diag)');
    for (let k = 1; k < seg.length; k++) {
      assert.equal(Math.floor(seg[k] / 3) - Math.floor(seg[k - 1] / 3), dr, 'constant row step');
      assert.equal((seg[k] % 3) - (seg[k - 1] % 3), dc, 'constant col step');
    }
    seg.forEach(i => assert.ok(i >= 0 && i <= 8, 'nodes on the 3x3 lattice'));
  }
  ok('all 24 sigil segments are straight 2-3 node runs');

  for (let n = 0; n < 500; n++) {
    const s = rollSigil();
    assert.deepEqual([...s.colors].sort(), [0, 1, 2], 'colors are a pedestal permutation');
    assert.equal(s.owners.length, 6, 'one owner per arena pillar');
    assert.equal(s.owners.filter(o => o === 0).length, 3, 'pillars split 3/3 between the twins');
    assert.equal(s.segs.length, 6);
    s.segs.forEach(seg => assert.ok(SIGIL_SEGMENTS.includes(seg), 'pillar patterns come from the segment set'));
    for (const side of [0, 1]) {
      const overlay = s.segs.reduce((m, seg, i) => s.owners[i] === side ? m | maskOf(seg) : m, 0);
      assert.equal(s.codes[side], overlay, 'a code is exactly its three pillar segments overlaid');
      assert.ok(overlay > 0 && overlay < 1 << 9, 'codes are non-trivial');
    }
    assert.notEqual(s.codes[0], s.codes[1], 'the twin codes are never identical');
  }
  ok('500 sigil rolls hold every pattern invariant');
}

// ---------- rally banner (LOBBY only) ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Planter', 'gunslinger');
  g.addPlayer('p2', 'Rallier', 'sentinel');

  // interacting away from the marked circle plants nothing
  moveTo(g, 'p1', [0, 0, 10]);
  g.onMessage('p1', { t: 'interact' });
  assert.equal(g.banner, null, 'no banner away from the circle');

  // planting on the circle: banner set, broadcast event fired
  moveTo(g, 'p1', ENC.banner.pos);
  g.onMessage('p1', { t: 'interact' });
  assert.ok(g.banner && g.banner.by === 'Planter', 'banner planted on the circle');
  assert.ok(msgs.some(x => x.to === null && x.m.t === 'banner'), 'banner event broadcast');
  g.broadcastSnapshot();
  const snap = msgs.findLast(x => x.m.t === 'snap').m;
  assert.deepEqual(snap.banner.p, ENC.banner.pos, 'snapshot carries the banner');

  // each guardian rallies once — including the planter — and only once
  msgs = [];
  moveTo(g, 'p2', ENC.banner.pos);
  g.players.get('p2').sup = 30;
  g.onMessage('p2', { t: 'interact' });
  assert.ok(msgs.some(x => x.to === 'p2' && x.m.t === 'restock'), 'rallying restocks');
  assert.equal(g.players.get('p2').sup, 100, 'rallying fills the super gauge');
  msgs = [];
  g.onMessage('p2', { t: 'interact' });
  assert.ok(!msgs.some(x => x.m.t === 'restock'), 'rally is once per guardian');
  g.onMessage('p1', { t: 'interact' });
  assert.ok(msgs.some(x => x.to === 'p1' && x.m.t === 'restock'), 'the planter can rally too');

  // once the encounter starts the banner goes inert
  moveTo(g, 'p1', [0, 0, 1]); moveTo(g, 'p2', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  assert.equal(g.enc.st, 'MECH');
  god(g);
  msgs = [];
  const p2 = g.players.get('p2');
  p2.restocked = false; // even un-restocked guardians get nothing mid-fight
  moveTo(g, 'p2', ENC.banner.pos);
  g.onMessage('p2', { t: 'interact' });
  assert.ok(!msgs.some(x => x.m.t === 'restock'), 'no restock outside LOBBY');

  // a wipe-style reset clears the banner and re-arms every guardian's rally
  p2.restocked = true;
  g.resetToLobby('wipe');
  assert.equal(g.banner, null, 'reset clears the banner');
  assert.ok([...g.players.values()].every(p => !p.restocked), 'rallies re-armed for the next lobby');
  ok('rally banner: plant on the circle, one restock each, lobby-only');
}

// ---------- solo full clear ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'SoloGuardian', 'gunslinger');
  assert.equal(g.enc.st, 'LOBBY');

  // stand on the center plate to start
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  assert.equal(g.enc.st, 'MECH', 'encounter starts from the plate');
  assert.equal(g.enc.bossMax, ENC.bossBase, 'solo boss HP uses base only');
  ok('lobby plate starts the encounter');

  // boss is immune before dunks
  const hpBefore = g.enc.bossHp;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  assert.equal(g.enc.bossHp, hpBefore, 'shielded boss takes no damage');
  ok('boss immune while shielded');

  // twin warded keepers + the sky lattice replace the old orb cycle
  god(g);
  assert.ok(g.enc.sigil, 'a sigil layout is rolled with the round');
  g.onMessage('p1', { t: 'sigil', i: 0 });
  assert.equal(g.enc.sigil.grid, 0, 'the lattice sleeps until the keepers arrive');
  advance(g, ENC.firstKeeperDelay + 1);
  const twins = keepersOf(g);
  assert.equal(twins.length, 2, 'two keepers emerge together');
  assert.equal(g.enc.stage, 'KEEPERS');
  const sig = g.enc.sigil;
  assert.deepEqual(twins.map(k => k.color), [sig.colors[0], sig.colors[1]], 'keepers wear the twin colors');
  assert.ok(twins.every(k => k.shielded), 'both arrive warded');

  // warded = immune to hits and splash alike
  g.onMessage('p1', { t: 'hit', target: twins[0].id, dmg: 200, weapon: 'sniper' });
  assert.equal(twins[0].hp, twins[0].maxHp, 'warded keeper shrugs off hits');
  g.onMessage('p1', { t: 'explode', kind: 'rocket', p: [twins[0].pos[0], 1, twins[0].pos[2]] });
  assert.equal(twins[0].hp, twins[0].maxHp, 'warded keeper shrugs off splash');

  // pin the codes (rolls are random) so the entry sequence is deterministic
  sig.codes = [maskOf([0, 1, 2]), maskOf([6, 7, 8])];
  g.onMessage('p1', { t: 'sigil', i: 4 });
  assert.equal(sig.grid, 1 << 4, 'shooting a star lights it');
  assert.ok(twins.every(k => k.shielded), 'a wrong pattern drops nothing');
  g.onMessage('p1', { t: 'sigil', i: 4 });
  assert.equal(sig.grid, 0, 'shooting it again puts it out');

  for (const i of [0, 1, 2]) g.onMessage('p1', { t: 'sigil', i });
  assert.ok(twins[0].shielded, 'ward A holds while the lattice gathers its strike');
  assert.equal(sig.grid, 0, 'the lattice resets after a match');
  assert.deepEqual(sig.matched, [true, false]);
  assert.ok(g.players.get('p1').sup >= SUPER.perSigil, 'the codebreaker earns super energy');
  assert.ok(msgs.some(x => x.m.t === 'sigilMatch' && x.m.kid === twins[0].id && x.m.code === sig.codes[0]),
    'the match broadcast carries the code and target for the strike FX');

  // the strike lands strikeDelay later: ward A bursts, the blast erases the
  // unwarded bystander, and the still-warded twin shrugs it off point-blank
  advance(g, ENC.sigil.strikeDelay - 0.3);
  assert.ok(twins[0].shielded, 'still warded mid-converge');
  const bystander = g.spawnEnemy('husk', [twins[0].pos[0] + 1, 0, twins[0].pos[2] + 1]);
  twins[1].pos = [twins[0].pos[0] + 2, 0, twins[0].pos[2]]; // drag the twin into the blast
  advance(g, 0.6);
  assert.equal(twins[0].shielded, false, 'the lattice strike breaks ward A');
  assert.ok(g.enemies.has(twins[0].id), 'the struck keeper survives — its ward soaked the blast');
  assert.ok(!g.enemies.has(bystander.id), 'the backlash erases nearby adds');
  assert.ok(g.enemies.has(twins[1].id) && twins[1].shielded, 'the warded twin shrugs off the blast');
  assert.ok(msgs.some(x => x.m.t === 'sigilBlast'), 'blast announced for the explosion FX');

  slay(g, twins[0].id);
  assert.equal(keepersOf(g).length, 1, 'no herald while the twin still walks');
  for (const i of [6, 7, 8]) g.onMessage('p1', { t: 'sigil', i });
  assert.equal(g.enc.stage, 'KEEPERS', 'the panel stays in the sky while its last strike converges');
  g.onMessage('p1', { t: 'sigil', i: 0 });
  assert.equal(sig.grid, 0, 'the spent lattice ignores fire');
  advance(g, ENC.sigil.strikeDelay + 0.2);
  assert.equal(twins[1].shielded, false, 'the second strike breaks ward B');
  assert.equal(g.enc.stage, 'HUNT', 'the lattice retires only once the laser lands');
  slay(g, twins[1].id);

  // the last keeper rises warded into the sky; only its color's lock grounds it
  const herald = keepersOf(g)[0];
  assert.ok(herald, 'the final keeper rises when both twins fall');
  assert.equal(g.enc.stage, 'FINAL');
  assert.ok(herald.sky && herald.pos[1] > 10, 'it hangs in the sky above the Watcher');
  assert.equal(herald.color, sig.colors[2], 'it wears the third color');
  assert.ok(herald.shielded, 'and arrives warded');
  g.onMessage('p1', { t: 'hit', target: herald.id, dmg: 200, weapon: 'sniper' });
  assert.equal(herald.hp, herald.maxHp, 'the herald ward is absolute');

  assert.equal(herald.shieldHp, herald.shieldMax, 'the ward arrives whole');
  assert.equal(herald.shieldMax, ENC.sigil.shieldHp, 'solo ward strength is the base');

  // standing in the lock circle kindles the wardbreaker blessing (timed buff)
  const heraldPed = ARENA.pedestals[herald.color];
  const p1w = g.players.get('p1');
  moveTo(g, 'p1', [heraldPed.p[0], 0, heraldPed.p[2]]);
  advance(g, 0.2);
  assert.ok(p1w.wardUntil > g.t, 'the lock circle grants the wardbreaker buff');
  assert.ok(msgs.some(x => x.m.t === 'wardBuff' && x.to === 'p1'), 'buff announced privately');

  // the buff travels with you — and wounds the ward, never the keeper
  moveTo(g, 'p1', [0, 0, 20]);
  g.onMessage('p1', { t: 'hit', target: herald.id, dmg: 200, weapon: 'sniper' });
  assert.equal(herald.shieldHp, herald.shieldMax - 200, 'blessed fire wounds the ward');
  assert.equal(herald.hp, herald.maxHp, 'the keeper behind it is untouched');

  // the blessing fades; faded fire scratches nothing until rekindled
  god(g);
  advance(g, ENC.sigil.wardBuffDur + 0.5);
  assert.ok(p1w.wardUntil <= g.t, 'the blessing fades away from the lock');
  const shpBefore = herald.shieldHp;
  g.onMessage('p1', { t: 'hit', target: herald.id, dmg: 200, weapon: 'sniper' });
  assert.equal(herald.shieldHp, shpBefore, 'faded blessing scratches nothing');
  moveTo(g, 'p1', [heraldPed.p[0], 0, heraldPed.p[2]]);
  advance(g, 0.2);
  assert.ok(p1w.wardUntil > g.t, 'standing back in the circle rekindles it');

  // breaking the ward detonates it — the blast takes the herald with it
  while (g.enemies.has(herald.id)) g.onMessage('p1', { t: 'hit', target: herald.id, dmg: 200, weapon: 'sniper' });
  assert.ok(msgs.some(x => x.m.t === 'wardBlast'), 'the ward detonates');

  // herald down → wormhole → missile impact breaks the shield into DAMAGE
  assert.equal(g.enc.stage, 'MISSILE');
  assert.ok(g.enc.wormhole, 'a wormhole tears open above the boss');
  assert.ok(g.enc.missileAt > g.t, 'the lance is still falling');
  assert.equal(g.enc.st, 'MECH', 'shield holds until impact');
  g.spawnEnemy('husk', [10, 0, 10]); // a straggler for the blast to erase
  advance(g, ENC.sigil.missileFall + 0.2);
  assert.equal(g.enc.st, 'DAMAGE', 'missile impact opens the damage phase');
  assert.equal(g.enc.shield, false);
  assert.ok(g.enc.wormhole, 'the wormhole stays open through the phase');
  assert.ok(msgs.some(x => x.m.t === 'missile'), 'impact announced for the blue flash');
  assert.equal([...g.enemies.values()].filter(e => e.type !== 'blister').length, 0,
    'the blast erases every remaining add');
  ok('twin wards → star codes → herald → wormhole missile opens damage phase');

  // partial damage; the viral mechanic kicks off with the phase
  moveTo(g, 'p1', [0, 0, 20]);
  for (let i = 0; i < 30; i++) g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 199, weapon: 'sniper' });
  assert.ok(g.enc.bossHp < g.enc.bossMax, 'boss took damage');
  god(g);

  // hard focus announced; the blisters riding the boss's back are sealed by default
  assert.equal(g.enc.focus, 'p1', 'solo player is hard-focused');
  assert.ok(msgs.some(x => x.m.t === 'bossFocus' && x.m.id === 'p1'), 'mark announced to the lobby');
  const blisters = [...g.enemies.values()].filter(e => e.type === 'blister');
  assert.equal(blisters.length, ENC.blisterMounts.length, 'blisters mounted since the encounter start');
  assert.ok(blisters.every(b => b.pos[1] > 5), 'blisters sit on the boss body, not the floor');
  assert.ok(blisters.some(b => b.mountY < -2), 'one blister hangs from the underbelly');
  g.onMessage('p1', { t: 'hit', target: blisters[0].id, dmg: 200, weapon: 'sniper' });
  assert.equal(blisters[0].hp, ENEMIES.blister.hp, 'blister immune without patches');

  // two capsules rain every 5 s — catch three of them
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.capsuleInterval + 0.2);
  assert.equal(g.caps.size, ENC.capsulesPerDrop, 'two capsules drop after 5 s');
  const p1 = g.players.get('p1');
  for (let guard = 0; p1.antiviral < ENC.capsulesNeeded; guard++) {
    assert.ok(guard < 60 && g.enc.st === 'DAMAGE', 'capsules collected within the phase');
    advance(g, 0.5);
    const c = [...g.caps.values()].find(c => g.t >= c.landAt);
    if (c) { moveTo(g, 'p1', [c.p[0], 0, c.p[2]]); advance(g, 0.1); }
  }
  assert.equal(p1.antiviral, ENC.capsulesNeeded, 'three antiviral patches applied');

  // the purge bursts a blister → auric key; the stacks are spent on the burst
  while (g.enemies.has(blisters[1].id)) g.onMessage('p1', { t: 'hit', target: blisters[1].id, dmg: 200, weapon: 'sniper' });
  assert.equal(g.keys.size, 1, 'burst blister shed an auric key');
  assert.equal(p1.antiviral, 0, 'patches consumed by the burst');
  g.onMessage('p1', { t: 'hit', target: blisters[2].id, dmg: 200, weapon: 'sniper' });
  assert.equal(g.enemies.get(blisters[2].id).hp, ENEMIES.blister.hp, 'remaining blisters sealed again');

  // carry the key to an intact lock → its refuge well wakes
  const [keyId, key] = [...g.keys.entries()][0];
  moveTo(g, 'p1', [key.p[0], 0, key.p[2]]);
  advance(g, 0.2);
  assert.ok(p1.hasKey, 'key picked up');
  assert.ok(msgs.some(x => x.to === null && x.m.t === 'keyGet' && x.m.id === 'p1' && x.m.kid === keyId),
    'key claim broadcast to the whole fireteam (clients clear the floor key on it)');
  moveTo(g, 'p1', [ARENA.pedestals[0].p[0], 0, ARENA.pedestals[0].p[2]]);
  advance(g, 0.2);
  assert.ok(!p1.hasKey, 'key spent on the wake');
  const woken = [...g.wells.values()].find(w => w.kind === 'refuge');
  assert.ok(woken && woken.ped === 0, 'refuge well woken at lock ROSE');
  ok('viral mechanic: capsules → purge → blister → key → woken well');

  // ride out the phase inside the woken well — survive unharmed
  while (g.enc.st === 'DAMAGE') advance(g, 0.25);
  assert.equal(g.enc.st, 'OBLIT', 'damage phase ends into obliteration');
  assert.equal([...g.enemies.values()].filter(e => e.type === 'blister').length,
    ENC.blisterMounts.length - 1, 'unburst blisters stay mounted on the boss');
  assert.equal(g.caps.size, 0, 'capsules wither at phase end');
  god(g);
  g.projs.clear(); // remove in-flight volley orbs for a deterministic HP check
  const hpAtOblit = p1.hp;
  advance(g, ENC.oblitWarn + 0.2);
  assert.equal(g.enc.st, 'MECH', 'back to mechanics, round 2');
  assert.equal(g.enc.round, 2);
  assert.equal(p1.hp, hpAtOblit, 'woken refuge well blocked obliteration');
  assert.deepEqual(g.enc.burned, [0], 'the woken well is spent forever');
  assert.equal(g.keys.size, 0, 'no keys carry into the new round');
  assert.ok(!g.enc.wormhole, 'the wormhole seals at obliteration');
  assert.deepEqual(g.enc.sigil.matched, [false, false], 'round 2 rolls a fresh sigil');
  assert.equal(g.enc.stage, null, 'new keepers are still stirring');
  ok('obliteration survived in the woken well, round 2 begins');

  // cheat the boss to just above final-stand, re-open damage phase via direct calls
  g.enc.bossHp = g.enc.bossMax * ENC.finalFrac + 500;
  g.enterDamage();
  for (let i = 0; i < 4; i++) g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  assert.equal(g.enc.st, 'FINAL', 'crossing the final-stand threshold triggers it');
  assert.equal(ENC.finalFrac, 0.25, 'final stand opens at 25%');
  ok('final stand triggers at 25%');

  // generator surge: the shield reignites, a sweep holds for the whole surge,
  // and seeker waves pour out every surgeWaveCd
  assert.ok(g.enc.shield, 'the emergency generator reignites the shield');
  assert.ok(g.enc.sweep && g.enc.sweep.until === g.enc.surgeUntil, 'one sweep spins for the whole surge');
  const hpAtSurge = g.enc.bossHp;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  assert.equal(g.enc.bossHp, hpAtSurge, 'the surged boss is immune');
  const wavesBefore = msgs.filter(x => x.m.t === 'seekers').length;
  advance(g, ENC.surgeDur + 0.5);
  const waves = msgs.filter(x => x.m.t === 'seekers').length - wavesBefore;
  assert.ok(waves >= Math.floor((ENC.surgeDur - ENC.surgeFirst) / ENC.surgeWaveCd),
    `the surge launches wave after wave (got ${waves})`);
  assert.ok(msgs.some(x => x.m.t === 'snap' && x.m.enc.sg > 0), 'snapshots carry the surge deadline for the HUD drain');
  assert.ok(!g.enc.shield, 'the generator dies — the boss is exposed again');
  assert.equal(g.enc.surgeUntil, 0);
  assert.equal(g.enc.sweep, null, 'the surge sweep dies with it');
  assert.ok(g.enc.ends > g.t + ENC.annihilation - 1, 'annihilation only counts from the surge breaking');
  ok('generator surge: immune boss, permanent sweep, rolling seeker waves');

  // kill it before annihilation
  while (g.enc.bossHp > 0) g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  assert.equal(g.enc.st, 'VICTORY');
  assert.ok(g.chest, 'chest spawned');
  moveTo(g, 'p1', [g.chest.p[0], 0, g.chest.p[2] - 1]);
  g.onMessage('p1', { t: 'interact' });
  assert.ok(msgs.some(x => x.m.t === 'loot'), 'loot granted');
  ok('boss killed in final stand → victory + loot');

  advance(g, ENC.victoryDelay + 0.5);
  assert.equal(g.enc.st, 'LOBBY', 'returns to lobby after victory');
  ok('resets to lobby');
}

// ---------- sigil codes are order-free; junk input never matches ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Decoder', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  advance(g, ENC.firstKeeperDelay + 1);
  const sig = g.enc.sigil;
  const twins = keepersOf(g);
  sig.codes = [maskOf([0, 3, 6]), maskOf([2, 5, 8])];
  // light everything but a code — nothing should give
  for (const i of [1, 4, 7]) g.onMessage('p1', { t: 'sigil', i });
  assert.ok(twins.every(k => k.shielded), 'a junk pattern drops nothing');
  for (const i of [1, 4, 7]) g.onMessage('p1', { t: 'sigil', i }); // clean up
  // the second twin's code can be answered first
  for (const i of [2, 5, 8]) g.onMessage('p1', { t: 'sigil', i });
  assert.deepEqual(sig.matched, [false, true], 'code B accepted first');
  assert.ok(twins.every(k => k.shielded), 'wards hold until their strikes land');
  for (const i of [0, 3, 6]) g.onMessage('p1', { t: 'sigil', i });
  assert.deepEqual(sig.matched, [true, true], 'code A accepted second');
  assert.equal(g.enc.stage, 'KEEPERS', 'lattice stands until its strikes discharge');
  // both strikes resolve; the twins stand at far-apart gates, so neither
  // blast reaches the other, freshly unwarded keeper
  advance(g, ENC.sigil.strikeDelay + 0.3);
  assert.equal(g.enc.stage, 'HUNT', 'lattice retires once both strikes land');
  assert.ok(twins.every(k => !k.shielded), 'both lattice strikes land');
  assert.ok(twins.every(k => g.enemies.has(k.id)), 'both keepers survive their own ward-breaks');
  ok('sigil codes accepted in either order, junk rejected');
}

// ---------- boss panel-grabs: KEEPERS-only cadence, tightening per round ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Wrenched', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);

  // before the keepers arrive the panel is hidden — nothing tethers it
  msgs = [];
  advance(g, ENC.firstKeeperDelay - 2);
  assert.ok(!msgs.some(x => x.m.t === 'latticeGrab'), 'no grabs while the lattice sleeps');

  // round 1: first grab one full grabCd after the lattice wakes, then steady
  advance(g, 2 + 0.2);
  assert.equal(g.enc.stage, 'KEEPERS');
  msgs = [];
  advance(g, ENC.sigil.grabCd + 0.5);
  const grabs = msgs.filter(x => x.to === null && x.m.t === 'latticeGrab');
  assert.equal(grabs.length, 1, 'one grab per grabCd at round 1');
  assert.equal(grabs[0].m.dur, ENC.sigil.grabDur, 'grab carries its duration');
  assert.ok(Number.isInteger(grabs[0].m.seed), 'grab carries a path seed');
  assert.equal(grabs[0].m.a0, 0, "the round's first grab starts from the northern sky");
  assert.equal(grabs[0].m.a1, g.enc.grabAngle, 'the panel parks at the broadcast end angle');
  assert.ok(Math.abs(grabs[0].m.at + ENC.sigil.grabCd - g.enc.nextGrabAt) < 0.01,
    'the next grab is scheduled a full interval out');

  // the cadence tightens after every damage phase, but never past the floor
  g.enc.round = 2;
  assert.equal(g.grabCdNow(), ENC.sigil.grabCd - ENC.sigil.grabCdStep, 'round 2 grabs come quicker');
  g.enc.round = 99;
  assert.equal(g.grabCdNow(), ENC.sigil.grabCdMin, 'the interval bottoms out at grabCdMin');
  g.enc.round = 1;

  // answer both ciphers — once the stage leaves KEEPERS the grabs stop
  const sig = g.enc.sigil;
  sig.codes = [maskOf([0, 1]), maskOf([7, 8])];
  for (const i of [0, 1]) g.onMessage('p1', { t: 'sigil', i });
  for (const i of [7, 8]) g.onMessage('p1', { t: 'sigil', i });
  assert.equal(g.enc.stage, 'KEEPERS', 'the panel lingers through its final discharge');
  msgs = [];
  advance(g, ENC.sigil.grabCd * 2 + 1);
  assert.ok(!msgs.some(x => x.m.t === 'latticeGrab'), 'a spent lattice is left alone');
  assert.equal(g.enc.stage, 'HUNT');

  // sampled swings: continuous (each grab starts where the last parked),
  // clamped, and centered near the quarter-turn mean
  msgs = [];
  let prev = g.enc.grabAngle, sum = 0;
  for (let i = 0; i < 500; i++) {
    g.fireGrab();
    const m = msgs[msgs.length - 1].m;
    assert.equal(m.t, 'latticeGrab');
    assert.equal(m.a0, prev, 'each grab starts where the last one parked');
    const swing = Math.abs(m.a1 - m.a0);
    assert.ok(swing >= ENC.sigil.grabRotMin - 1e-3 && swing <= ENC.sigil.grabRotMax + 1e-3,
      'swings stay inside the clamp');
    sum += swing; prev = m.a1;
  }
  const meanSwing = sum / 500;
  assert.ok(meanSwing > 1.25 && meanSwing < 1.9,
    `swing distribution centers near π/2 (got ${meanSwing.toFixed(2)})`);

  // a fresh round's keepers re-home the panel to the northern sky
  g.enterMech(2);
  advance(g, ENC.firstKeeperDelay + 1);
  assert.equal(g.enc.stage, 'KEEPERS');
  assert.equal(g.enc.grabAngle, 0, 'round reset re-homes the panel');
  ok('panel grabs: KEEPERS-only cadence, per-round tightening, N(π/2) arena swings');
}

// ---------- annihilation wipe ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Doomed', 'voidcaller');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  g.enc.bossHp = g.enc.bossMax * 0.1; // force final stand on next damage
  g.enterDamage();
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 10, weapon: 'auto' });
  assert.equal(g.enc.st, 'FINAL');
  moveTo(g, 'p1', [0, 0, 30]);
  god(g); // survive the volleys so the annihilation timer itself wipes us
  advance(g, ENC.surgeDur + ENC.annihilation + 0.5);
  assert.equal(g.enc.st, 'WIPE', 'annihilation cast completing wipes the team');
  advance(g, ENC.wipeDelay + 0.5);
  assert.equal(g.enc.st, 'LOBBY');
  assert.equal(g.players.get('p1').dead, false, 'player restored after wipe');
  assert.equal(g.players.get('p1').hp, PLAYER.maxHp);
  ok('annihilation → wipe → lobby reset');
}

// ---------- solo down = wipe; ward super ----------
{
  const g = mkGame();
  const p = g.addPlayer('p1', 'Glass', 'sentinel');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);

  p.sup = 100;
  g.onMessage('p1', { t: 'superCast', dir: [0, 0, 1] });
  assert.equal(p.sup, 0, 'super consumed');
  assert.ok([...g.wells.values()].some(w => w.kind === 'ward'), 'ward well placed');
  ok('ward super casts');

  g.dmgPlayer(p, 5000, 'test'); // big: cast-flourish DR + ward DR both apply right after a cast
  assert.equal(g.enc.st, 'WIPE', 'solo player going down wipes immediately');
  ok('solo down → instant wipe');
}

// ---------- super-cast flourish damage resistance ----------
{
  const g = mkGame();
  const p = g.addPlayer('p1', 'Poser', 'voidcaller');
  g.addPlayer('p2', 'Witness', 'sentinel'); // a second guardian so a down can't wipe the run
  moveTo(g, 'p1', [0, 0, 1]);
  moveTo(g, 'p2', [2, 0, 1]);
  advance(g, ENC.readyTime + 0.5);

  p.sup = 100;
  g.onMessage('p1', { t: 'superCast', dir: [0, 0, 1] });
  p.hp = PLAYER.maxHp;
  g.dmgPlayer(p, 60, 'test');
  assert.ok(Math.abs((PLAYER.maxHp - p.hp) - 60 * (1 - SUPER.cast.dr)) < 0.01,
    'damage reduced during the cast flourish');
  advance(g, SUPER.cast.dur + 0.1); // window over (regenDelay is 5s — hp untouched)
  const hpBefore = p.hp;
  g.dmgPlayer(p, 60, 'test');
  assert.ok(Math.abs((hpBefore - p.hp) - 60) < 0.01, 'full damage once the flourish ends');
  ok('super-cast flourish DR window');
}

// ---------- 4-player scaling & revive ----------
{
  const g = mkGame();
  for (let i = 1; i <= 4; i++) g.addPlayer('p' + i, 'G' + i, 'gunslinger');
  for (let i = 1; i <= 4; i++) moveTo(g, 'p' + i, [i * 0.5, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  assert.equal(g.enc.st, 'MECH');
  assert.equal(g.enc.bossMax, ENC.bossBase + 3 * ENC.bossPerPlayer, '4-player boss HP scaled');

  god(g);
  const p2 = g.players.get('p2');
  p2.hp = 100;
  g.dmgPlayer(p2, 500, 'test');
  assert.ok(p2.downed, 'p2 downed');
  assert.equal(g.enc.st, 'MECH', 'one down of four does not wipe');

  // no bleed-out: a downed guardian stays revivable indefinitely
  advance(g, 60);
  assert.ok(p2.downed && !p2.dead, 'downed guardian never bleeds out');

  moveTo(g, 'p1', [p2.pos[0] + 1, 0, p2.pos[2]]);
  god(g);
  // spam E the entire time — repeated interacts must NOT restart the channel
  for (let t = 0; t < PLAYER.reviveTime + 0.5; t += 0.1) {
    g.onMessage('p1', { t: 'interact' });
    advance(g, 0.1);
  }
  assert.ok(!p2.downed && p2.hp > 0, 'teammate revived despite E spam');
  ok('4-player scaling + revive survives E spam');

  // keeper HP scales too — and the twins spawn from different gates
  god(g);
  advance(g, ENC.firstKeeperDelay + 2);
  const twins = keepersOf(g);
  assert.equal(twins.length, 2, 'twin keepers spawned');
  for (const k of twins) assert.equal(k.maxHp, ENEMIES.keeper.hp + 3 * ENC.keeperPerPlayer, 'keeper HP scaled');
  assert.ok(Math.hypot(twins[0].pos[0] - twins[1].pos[0], twins[0].pos[2] - twins[1].pos[2]) > 10,
    'the twins emerge from different gates');
  ok('keeper scaling + twin gates');
}

// ---------- golden volley: gate race, buff, caps ----------
{
  const g = mkGame();
  const p = g.addPlayer('p1', 'Goldie', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  g.enterDamage();
  // Snapshots round sup to 0.1, so the client can show READY while the server
  // float is still 99.4x — the server must accept casts from 99 up.
  p.sup = 99.2;
  g.onMessage('p1', { t: 'superCast', dir: [0, 0, 1] });
  assert.equal(p.sup, 0, 'cast accepted at 99.2');
  assert.ok(p.goldenUntil > g.t, 'golden buff active');
  assert.ok(msgs.some(x => x.m.t === 'super' && x.m.kind === 'golden'), 'golden broadcast sent');
  const before = g.enc.bossHp;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 700, weapon: 'sniper' });
  assert.equal(before - g.enc.bossHp, 700, 'golden-buffed hit passes the raised cap');
  god(g);
  advance(g, SUPER.cast.dur + SUPER.golden.dur + 0.5); // golden counts from the end of the flourish
  const before2 = g.enc.bossHp;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 700, weapon: 'sniper' });
  assert.ok(before2 - g.enc.bossHp <= 231, 'cap restored after golden expires');
  ok('golden volley: gate, buff, caps');
}

// ---------- damage caps & nova validation ----------
{
  const g = mkGame();
  const p = g.addPlayer('p1', 'Cheater', 'voidcaller');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  g.enterDamage();
  const before = g.enc.bossHp;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 999999, weapon: 'sniper' });
  assert.ok(before - g.enc.bossHp <= 231, 'hit damage capped');
  const before2 = g.enc.bossHp;
  g.onMessage('p1', { t: 'explode', kind: 'nova', p: [0, 8, 0] }); // no pendingNova
  assert.equal(g.enc.bossHp, before2, 'nova without cast rejected');
  p.sup = 100;
  g.onMessage('p1', { t: 'superCast', dir: [0, 0, -1] });
  const far = g.spawnEnemy('acolyte', [12, 0, 0]); // ~13.9 m from the blast — beyond the old 9 m wave
  g.onMessage('p1', { t: 'explode', kind: 'nova', p: [0, 8, 0] });
  assert.ok(g.enc.bossHp < before2, 'real nova lands');
  assert.ok(!g.enemies.has(far.id), 'the widened wave erases distant adds');
  // nova shards land as ordinary client hits — capped like any weapon
  const before3 = g.enc.bossHp;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 999999, weapon: 'nswarm' });
  assert.ok(before3 - g.enc.bossHp <= DMG_CAPS.nswarm, 'nova shard damage capped');
  ok('anti-cheat caps & nova gating');
}

// ---------- nova economy: a wave-wipe never refunds the super ----------
{
  const g = mkGame();
  const p = g.addPlayer('p1', 'Economist', 'voidcaller');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  assert.equal(g.enc.st, 'MECH');
  god(g);

  // a dense pack, erased by the nova: zero gauge comes back (perKill on 20+
  // adds used to be a near-full instant refund — perpetual novas)
  const pack = [];
  for (let i = 0; i < 10; i++) {
    pack.push(g.spawnEnemy('husk', [10 + (i % 5), 0, 10 + Math.floor(i / 5) * 1.5]));
  }
  p.sup = 100;
  g.onMessage('p1', { t: 'superCast', dir: [0, 0, -1] });
  assert.equal(p.sup, 0, 'cast spends the gauge');
  g.onMessage('p1', { t: 'explode', kind: 'nova', p: [12, 1, 10] });
  assert.ok(pack.every(h => !g.enemies.has(h.id)), 'the nova erased the pack');
  assert.equal(p.sup, 0, 'a 10-kill nova refunds nothing');

  // the shards are nova-sourced too: nswarm hits and kills feed nothing
  const aco = g.spawnEnemy('acolyte', [10, 0, 10]);
  g.onMessage('p1', { t: 'hit', target: aco.id, dmg: 170, weapon: 'nswarm' });
  assert.ok(!g.enemies.has(aco.id), 'a shard one-shots an acolyte');
  assert.equal(p.sup, 0, 'nswarm damage and kills feed nothing');
  g.enterDamage();
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 170, weapon: 'nswarm' });
  assert.equal(p.sup, 0, 'shards on the boss feed nothing either');

  // honest kills still pay out — the next nova is rebuilt the normal way
  const honest = g.spawnEnemy('husk', [10, 0, 10]);
  while (g.enemies.has(honest.id)) g.onMessage('p1', { t: 'hit', target: honest.id, dmg: 200, weapon: 'sniper' });
  assert.ok(p.sup >= SUPER.perKill, 'ordinary kills still feed the gauge');
  ok('nova economy: blast + shard kills refund nothing, honest kills still pay');
}

// ---------- in-flight ordnance survives the thrower going down ----------
// The client gates NEW fire input on alive, but already-launched payloads
// (grenade arc, thrown nova, swarm shards) keep flying and report on landing —
// the server must accept them from a downed (not dead) guardian.
{
  const g = mkGame();
  const p = g.addPlayer('p1', 'Thrower', 'voidcaller');
  g.addPlayer('p2', 'Anchor', 'sentinel'); // keeps one down from becoming a wipe
  moveTo(g, 'p1', [0, 0, 1]); moveTo(g, 'p2', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  g.enterDamage();
  p.sup = 100;
  g.onMessage('p1', { t: 'superCast', dir: [0, 0, -1] }); // nova now in flight
  g.dmgPlayer(p, 5000, 'test');
  assert.ok(p.downed && !p.dead, 'thrower is downed mid-flight');
  const before = g.enc.bossHp;
  g.onMessage('p1', { t: 'explode', kind: 'nova', p: [0, 8, 0] });
  assert.ok(g.enc.bossHp < before, 'in-flight nova still detonates while downed');
  const before2 = g.enc.bossHp;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 999999, weapon: 'nswarm' });
  const shard = before2 - g.enc.bossHp;
  assert.ok(shard > 0 && shard <= DMG_CAPS.nswarm, 'downed swarm shards land, still capped');
  g.onMessage('p1', { t: 'explode', kind: 'grenade', p: [0, 0, 12] });
  assert.equal(g.dots.size, 1, 'downed grenade still births the void zone');
  p.dead = true;
  const before3 = g.enc.bossHp;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 50, weapon: 'nswarm' });
  g.onMessage('p1', { t: 'explode', kind: 'rocket', p: [0, 8, 0] });
  assert.equal(g.enc.bossHp, before3, 'a dead guardian deals nothing');
  ok('downed (not dead) ordnance still lands');
}

// ---------- adaptive wave cadence: a wiped arena refills fast, a crowded one breathes ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Reaper', 'voidcaller');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5); // MECH; first wave due ~3 s in
  advance(g, 4);
  const smalls = () => [...g.enemies.values()].filter(e => !['keeper', 'blister', 'seeker'].includes(e.type));
  assert.ok(smalls().length > 0, 'a wave is up');
  // a populated arena keeps a long breath between waves
  assert.ok(g.enc.nextWaveAt - g.t > ENC.waveCdEmpty + 1, 'populated arena waits the long cycle');
  // nova-style wipe: the due time tightens to the empty cadence...
  for (const e of smalls()) g.killEnemy(e, null);
  advance(g, 0.1);
  assert.ok(g.enc.nextWaveAt - g.t < ENC.waveCdEmpty + 0.1, 'emptied arena tightens the wave timer');
  // ...and the replacement wave actually arrives on the short clock
  advance(g, ENC.waveCdEmpty + 0.2);
  assert.ok(smalls().length > 0, 'replacement wave arrives fast');
  // parked timers stay parked: the tighten clause must not wake a hushed arena
  for (const e of smalls()) g.killEnemy(e, null);
  g.enc.nextWaveAt = g.t + 999;
  advance(g, ENC.waveCd + 2);
  assert.equal(smalls().length, 0, 'a parked wave timer is never tightened');
  ok('adaptive wave cadence: wipe → fast refill, crowd → slow breath, parked stays parked');
}

// ---------- refuge wells stay dormant without a key; the blast erases the unsheltered ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Burny', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterDamage();
  advance(g, ENC.damageDur + 0.2);
  assert.equal(g.enc.st, 'OBLIT');
  assert.equal([...g.wells.values()].filter(w => w.kind === 'refuge').length, 0,
    'no free refuge wells anymore');

  // standing at a lock without a woken well does not shelter you — and the
  // blast leaves nothing of you behind
  moveTo(g, 'p1', [ARENA.pedestals[1].p[0], 0, ARENA.pedestals[1].p[2]]);
  g.projs.clear(); // drop god-mode & in-flight shots for a clean lethality check
  g.players.get('p1').hp = PLAYER.maxHp;
  advance(g, ENC.oblitWarn + 0.2);
  assert.equal(g.players.get('p1').dead, true, 'unsheltered guardian erased outright');
  assert.equal(g.enc.st, 'WIPE', 'solo fireteam wiped by the blast');
  assert.deepEqual(g.enc.burned, [], 'nothing burned — nothing was woken');
  ok('no key → no refuge → the blast erases you');
}

// ---------- a key-woken well shelters once, then never returns ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Wakey', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  const p = g.players.get('p1');
  god(g);
  g.enterDamage();
  p.hasKey = true;
  moveTo(g, 'p1', [ARENA.pedestals[1].p[0], 0, ARENA.pedestals[1].p[2]]);
  advance(g, 0.2);
  assert.ok(!p.hasKey, 'key spent');
  assert.ok([...g.wells.values()].some(w => w.kind === 'refuge' && w.ped === 1), 'well woken');
  advance(g, ENC.damageDur + ENC.oblitWarn + 0.5);
  assert.equal(g.enc.st, 'MECH', 'sheltered through the blast');
  assert.deepEqual(g.enc.burned, [1], 'the woken well collapsed permanently');

  god(g);
  g.enterDamage();
  p.hasKey = true;
  moveTo(g, 'p1', [ARENA.pedestals[1].p[0], 0, ARENA.pedestals[1].p[2]]);
  advance(g, 0.2);
  assert.ok(p.hasKey, 'a burned lock refuses the key');
  assert.equal([...g.wells.values()].filter(w => w.kind === 'refuge').length, 0, 'no well returns there');
  ok('key-woken refuge wells collapse permanently after the blast');
}

// ---------- splash can accidentally burst several blisters at once ----------
{
  const g = mkGame();
  const p = g.addPlayer('p1', 'Splash', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterDamage();
  advance(g, 0.1); // let tickBoss glue the blisters to the turning body
  const blisters = [...g.enemies.values()].filter(e => e.type === 'blister');
  assert.equal(blisters.length, ENC.blisterMounts.length);
  const mid = [
    (blisters[0].pos[0] + blisters[1].pos[0]) / 2,
    (blisters[0].pos[1] + blisters[1].pos[1]) / 2,
    (blisters[0].pos[2] + blisters[1].pos[2]) / 2,
  ];
  // without the purge, splash leaves them sealed
  g.onMessage('p1', { t: 'explode', kind: 'rocket', p: mid });
  assert.ok(blisters.every(b => b.hp === ENEMIES.blister.hp), 'unpatched splash leaves blisters sealed');
  // with the purge, one rocket can burst several at once
  p.antiviral = ENC.capsulesNeeded;
  p.lastExp = {};
  g.onMessage('p1', { t: 'explode', kind: 'rocket', p: mid });
  const burst = ENC.blisterMounts.length -
    [...g.enemies.values()].filter(e => e.type === 'blister').length;
  assert.ok(burst >= 2, 'one rocket burst more than one blister');
  assert.equal(g.keys.size, burst, 'each burst blister shed a key');
  ok('splash can (accidentally) burst more than one blister per phase');
}

// ---------- damage phase chains unlocked specials; final stand overlaps them ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Hectic', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterMech(2);
  g.enterDamage();
  g.enc.nextSpecialAt = g.t; // force the special now
  advance(g, 1.0);
  assert.ok(g.enc.barrageUntil > g.t, 'barrage fires during the damage phase from round 2');
  assert.ok(g.enc.barrageHaste > 1, 'damage-phase specials are hasted');

  // final stand: a sweep and a barrage run at the same time
  g.enc.bossHp = g.enc.bossMax * 0.1;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 10, weapon: 'auto' });
  assert.equal(g.enc.st, 'FINAL');
  g.startSweep();
  g.enc.nextSpecialAt = g.t;
  advance(g, 1.0);
  assert.ok(g.enc.sweep, 'sweep still spinning');
  assert.ok(g.enc.barrageUntil > g.t, 'barrage overlaps the sweep in the final stand');
  ok('hectic damage phase + overlapping final-stand specials');
}

// ---------- hard focus re-marks when the focused player falls ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'A', 'gunslinger');
  g.addPlayer('p2', 'B', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]); moveTo(g, 'p2', [1, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterDamage();
  const first = g.enc.focus;
  assert.ok(first, 'a player is marked when damage opens');
  const fp = g.players.get(first);
  fp.hp = 10;
  g.dmgPlayer(fp, 500, 'test');
  advance(g, 0.1);
  assert.notEqual(g.enc.focus, first, 'boss re-marks after the marked player falls');
  assert.ok(g.alive(g.players.get(g.enc.focus)), 'and the new mark is standing');
  ok('hard focus follows to a living player');
}

// ---------- enemy fire leads a moving target ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Strafer', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.clearAdds();
  // spawn outside the boss column (it shoves intruders out in a random
  // direction) and perpendicular to the strafe, where the lead margin is stable
  const aco = g.spawnEnemy('acolyte', [9, 0, -4]);
  aco.nextAtkAt = g.t + 99; // hold fire while the server learns the velocity
  let px = 5;
  for (let i = 0; i < 12; i++) {
    moveTo(g, 'p1', [px, 0, 18]);
    px += 8 * 0.05; // strafing +x at 8 m/s
    g.tick(0.05);
  }
  const p = g.players.get('p1');
  assert.ok(p.vel[0] > 6 && Math.abs(p.vel[2]) < 1, 'server estimated the strafe velocity');

  const acoPos = [...aco.pos], pPos = [...p.pos];
  const unledLen = Math.hypot(pPos[0] - acoPos[0], pPos[1] + 1.2 - 1.6, pPos[2] - acoPos[2]) || 1;
  const unledVx = (pPos[0] - acoPos[0]) / unledLen * ENEMIES.acolyte.projSpeed;
  g.projs.clear();
  aco.nextAtkAt = g.t;
  g.tick(0.05); // the channel telegraph starts…
  advance(g, ENEMIES.acolyte.chargeT + 0.1); // …and releases
  const bolt = [...g.projs.values()].find(pr => pr.k === 'bolt');
  assert.ok(bolt, 'acolyte fired');
  // judge the launch aim from the helix base velocity — the live v carries
  // the corkscrew's tangential derivative on top of it
  assert.ok(bolt.hx.bv[0] > unledVx + 2, 'bolt aims ahead of the strafing target, not at it');
  ok('enemy projectiles lead the target\'s trajectory');
}

// ---------- 6-player raid scaling ----------
{
  assert.equal(MAX_PLAYERS, 6, 'fireteam cap mirrors a raid');
  const g = mkGame();
  for (let i = 1; i <= 6; i++) g.addPlayer('p' + i, 'G' + i, 'gunslinger');
  for (let i = 1; i <= 6; i++) moveTo(g, 'p' + i, [i * 0.5, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  assert.equal(g.enc.st, 'MECH', 'six guardians start from the plate');
  assert.equal(g.enc.bossMax, ENC.bossBase + 5 * ENC.bossPerPlayer, '6-player boss HP scaled');
  god(g);
  advance(g, ENC.firstKeeperDelay + 2);
  const keeper = [...g.enemies.values()].find(e => e.type === 'keeper');
  assert.ok(keeper, 'keeper spawned');
  assert.equal(keeper.maxHp, ENEMIES.keeper.hp + 5 * ENC.keeperPerPlayer, '6-player keeper HP scaled');
  ok('6-player fireteam scaling');
}

// ---------- wisps orbit the keeper from round 2 ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'WispBait', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterMech(2);
  advance(g, ENC.firstKeeperDelay + 1);
  const keeper = keepersOf(g)[0];
  assert.ok(keeper, 'keeper spawned');
  const wisps = [...g.enemies.values()].filter(e => e.type === 'wisp' && e.guard === keeper.id);
  assert.equal(wisps.length, 2, 'round 2: each keeper is warded by 2 wisps');
  for (const w of wisps) {
    assert.ok(Math.hypot(w.pos[0] - keeper.pos[0], w.pos[2] - keeper.pos[2]) < 5, 'wisp orbits close');
    assert.ok(w.pos[1] > 1, 'wisp flies');
  }
  keeper.shielded = false; // skip the lattice — this test is about the wisps
  slay(g, keeper.id);
  assert.equal([...g.enemies.values()].filter(e => e.type === 'wisp' && e.guard === keeper.id).length, 0,
    'wisps die with their keeper');
  ok('warding wisps orbit and fall with the keeper');
}

// ---------- sweep lasers: ground hit, jump dodge, spawn pause ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Jumper', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  g.enterMech(3);
  g.startSweep();
  // pin the beams for a deterministic check
  g.enc.sweep.a1 = 0; g.enc.sweep.w1 = 0;
  g.enc.sweep.a2 = Math.PI / 2; g.enc.sweep.w2 = 0;
  g.enc.sweep.armAt = g.t;
  const p = g.players.get('p1');
  p.hp = 200;
  moveTo(g, 'p1', [15, 0, 0]); // standing on beam 1
  advance(g, 0.3);
  assert.ok(p.hp < 200, 'grounded player clipped by the laser');
  const hpAfter = p.hp;
  p.sweepCdAt = 0;
  moveTo(g, 'p1', [15, 2.5, 0]); // airborne over it
  advance(g, 0.3);
  assert.equal(p.hp, hpAfter, 'jumping clears the beam');
  g.enc.nextWaveAt = g.t; // a wave is due, but the sweep pauses spawning
  const before = g.enemies.size;
  advance(g, 0.3);
  assert.equal(g.enemies.size, before, 'no spawns during the partition');
  ok('sweep lasers: ground hit, jump dodge, spawn pause');
}

// ---------- rhythmic barrage from round 2 ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Weaver', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterMech(2);
  g.enc.nextSpecialAt = g.t; // force the special now
  advance(g, 1.2);
  assert.ok(g.enc.barrageUntil > g.t, 'barrage running');
  assert.ok(g.projs.size >= ENC.barrageCount, 'bullet-hell rings in flight');
  const hell = [...g.projs.entries()].filter(([, pr]) => pr.k === 'hell');
  assert.ok(hell.length >= ENC.barrageCount, 'hell rings in flight');
  for (const [, pr] of hell) {
    // chest-high bob band: always overlaps a grounded hull, a jump can't clear it
    assert.ok(pr.p[1] > ENC.barrageY - ENC.barrageBobAmp - 0.2 &&
      pr.p[1] < ENC.barrageY + ENC.barrageBobAmp + 0.2, 'ring rides the chest-high bob band');
  }
  // spiral: the heading curls over time instead of flying straight (any one
  // ring can randomly eat a pillar or the player's hull mid-flight, so sample
  // them all and compare whichever survives)
  const h0s = new Map(hell.map(([id, pr]) => [id, Math.atan2(pr.v[2], pr.v[0])]));
  advance(g, 1.0);
  const survivor = [...h0s.keys()].find((id) => g.projs.get(id));
  assert.ok(survivor, 'a sampled ring still alive');
  const later = g.projs.get(survivor);
  let dh = Math.atan2(later.v[2], later.v[0]) - h0s.get(survivor);
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  assert.ok(Math.abs(dh) > 0.4, 'ring heading curls into a spiral');
  assert.equal(Math.sign(dh), g.enc.barrageDir, 'curl follows the barrage spin direction');
  ok('rhythmic barrage fires spiraling, bobbing, unjumpable rings');
}

// ---------- triple-orb volley fires only while the boss is exposed ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Dodger', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  assert.equal(g.enc.st, 'MECH');
  msgs = [];
  advance(g, 20); // far past any volley cadence
  assert.ok(!msgs.some(x => x.m.t === 'bossVolley'), 'no volleys during the puzzle phase');
  assert.ok(![...g.projs.values()].some(p => p.k === 'bossOrb'), 'no boss orbs in flight during MECH');

  g.enterDamage();
  msgs = [];
  advance(g, ENC.volleyCdDmg + 3);
  // (no in-flight orb check: at point-blank the orbs land and despawn within a tick)
  assert.ok(msgs.some(x => x.m.t === 'bossVolley'), 'volleys open up in the damage phase');
  ok('triple-orb volley is DAMAGE/FINAL-only');
}

// ---------- phase entries clear running specials (no cross-phase leaks) ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Hygiene', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  // victory/startWipe are terminal — keep them last so earlier entries see a live raid
  for (const enter of ['enterDamage', 'enterOblit', 'enterFinal', 'victory', 'startWipe']) {
    g.enc.st = 'MECH';
    g.startSweep();
    g.startBarrage();
    g.enc.wormhole = true;
    g[enter]();
    // enterFinal swaps the running sweep for its own surge-long one
    if (enter === 'enterFinal') assert.equal(g.enc.sweep.until, g.enc.surgeUntil, 'enterFinal restarts the sweep for the surge');
    else assert.equal(g.enc.sweep, null, `${enter} kills a running sweep`);
    assert.ok(g.enc.barrageUntil <= g.t, `${enter} kills a running barrage`);
    if (enter === 'enterDamage') assert.ok(g.enc.wormhole, 'the wormhole stays open into the damage phase');
    else assert.ok(!g.enc.wormhole, `${enter} seals the wormhole`);
  }
  ok('every phase entry clears running specials (no cross-phase leaks)');
}

// ---------- gjallarhorn: per-player unlock, loot, 30s victory reset, caps ----------
{
  assert.equal(ENC.victoryDelay, 30, 'victory resets after 30 seconds');
  const g = mkGame();
  const p = g.addPlayer('p1', 'Slayer', 'gunslinger');
  g.addPlayer('p2', 'Idler', 'sentinel');
  moveTo(g, 'p1', [0, 0, 1]); moveTo(g, 'p2', [1, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  assert.equal(g.gjallyOwners.size, 0, 'no owners before any clear');

  g.enterDamage();
  g.enc.bossHp = 100;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  assert.equal(g.enc.st, 'VICTORY');
  assert.equal(g.gjallyOwners.size, 0, 'victory alone unlocks nothing — claim the cache');
  assert.ok(!msgs.some(x => x.m.t === 'unlock'), 'no unlock before looting');

  moveTo(g, 'p1', [g.chest.p[0], 0, g.chest.p[2] - 1]);
  g.onMessage('p1', { t: 'interact' });
  const loot = msgs.find(x => x.m.t === 'loot');
  assert.equal(loot.m.item, 'Gjallarhorn', 'the raid exotic is Gjallarhorn');
  assert.ok(g.gjallyOwners.has('Slayer'), 'looting the cache unlocks it for that guardian');
  assert.ok(!g.gjallyOwners.has('Idler'), 'teammates who skip the cache get nothing');
  const unlock = msgs.find(x => x.m.t === 'unlock' && x.m.what === 'gjally');
  assert.ok(unlock && unlock.to === 'p1', 'unlock sent privately to the looter');

  advance(g, ENC.victoryDelay + 0.5);
  assert.equal(g.enc.st, 'LOBBY');
  const reset = msgs.filter(x => x.m.t === 'reset').pop();
  assert.equal(reset.m.reason, 'victory', 'clients sent back to the selection screen');

  // class re-pick from the selection screen works in the lobby
  g.onMessage('p1', { t: 'loadout', cls: 'voidcaller' });
  assert.equal(p.cls, 'voidcaller', 'loadout message updates class');

  // wolfpack hit caps + gjally splash
  moveTo(g, 'p1', [0, 0, 1]); moveTo(g, 'p2', [1, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterDamage();
  const husk = g.spawnEnemy('husk', [8, 0, 8]);
  g.onMessage('p1', { t: 'explode', kind: 'gjally', p: [8, 1, 8] });
  assert.ok(!g.enemies.has(husk.id), 'gjally splash kills adds');
  const before = g.enc.bossHp;
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 99999, weapon: 'gjally' });
  assert.ok(before - g.enc.bossHp <= 136, 'wolfpack damage capped');
  ok('gjallarhorn unlock, loot, victory reset, caps');
}

// ---------- back-launched homing seekers ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'SeekerBait', 'voidcaller');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  assert.equal(g.enc.st, 'MECH');
  god(g);
  // park at 60° — the 30°/90° pillars sit 8.5m off that flight line, so the
  // missiles' path from the boss's back is clear (a pillar WOULD eat them)
  moveTo(g, 'p1', [12.5, 0, 21.6]);
  const d3t = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const seekers = () => [...g.enemies.values()].filter(e => e.type === 'seeker');

  // first salvo arrives seekerFirst into round 1, sized seekerBase
  advance(g, ENC.seekerFirst + 0.2);
  assert.equal(seekers().length, ENC.seekerBase, 'round 1 opens with the base salvo');
  assert.ok(msgs.some(x => x.m.t === 'seekers' && x.m.n === ENC.seekerBase), 'launch announced with the salvo size');
  assert.ok(seekers().every(s => s.target === 'p1'), 'solo: every missile hunts the only guardian');

  // perfect homing: once past the pop-up arc, every missile closes on its player
  advance(g, ENC.seekerPop + 0.2);
  const aim = [12.5, 1, 21.6]; // p1's chest (the seekers' aim point)
  const before = seekers().map(s => d3t(s.pos, aim));
  advance(g, 1.0);
  seekers().forEach((s, i) => assert.ok(d3t(s.pos, aim) < before[i] - 4, 'each missile closes at full speed'));

  // shootable: ordinary hits pop one mid-flight, harmlessly (no seekerBoom) —
  // and the pop cooks off the wingman flying inside chainR (sympathetic chain)
  msgs.length = 0;
  const [downed, wingman] = seekers();
  wingman.pos = [downed.pos[0] + 2, downed.pos[1], downed.pos[2]]; // pin it inside chainR
  slay(g, downed.id);
  assert.ok(!g.enemies.has(downed.id), 'a seeker can be shot down');
  assert.ok(msgs.some(x => x.m.t === 'enemyDied' && x.m.ty === 'seeker'), 'shot-down seeker dies like an enemy');
  assert.ok(g.enemies.has(wingman.id), 'the cooked wingman holds through its fuse');
  advance(g, ENEMIES.seeker.chainFuse + 0.1);
  assert.ok(!g.enemies.has(wingman.id), 'the chain reaction claims the wingman');
  assert.ok(!msgs.some(x => x.m.t === 'seekerBoom'), 'shot-down and chained pops are duds — no detonation');
  assert.ok(!msgs.some(x => x.m.t === 'hurt' && x.m.src === 'seeker'), 'the chain wounds nobody');

  // …but the chain reaches only chainR: a missile beyond it flies on to its
  // quarry and detonates on them (positions seeded along the proven-clear
  // corridor the salvo was already flying)
  msgs.length = 0;
  const base = [...downed.pos];
  const bd = d3t(base, aim) || 1;
  const dir = [(aim[0] - base[0]) / bd, (aim[1] - base[1]) / bd, (aim[2] - base[2]) / bd];
  const off = ENEMIES.seeker.chainR + 2;
  const near = g.spawnEnemy('seeker', [...base]);
  const far = g.spawnEnemy('seeker', [base[0] + dir[0] * off, base[1] + dir[1] * off, base[2] + dir[2] * off]);
  for (const s of [near, far]) { s.target = 'p1'; s.popUntil = 0; s.launchV = [0, 0, 0]; s.dieAt = g.t + 25; }
  slay(g, near.id);
  advance(g, ENEMIES.seeker.chainFuse + 0.1);
  assert.ok(g.enemies.has(far.id), 'a missile beyond chainR is untouched');
  advance(g, 11.5);
  assert.equal(seekers().length, 0, 'the survivor spent itself');
  assert.ok(msgs.some(x => x.m.t === 'seekerBoom'), 'detonation broadcast for the boom FX');
  const blastHurt = msgs.find(x => x.m.t === 'hurt' && x.to === 'p1' && x.m.src === 'seeker');
  assert.ok(blastHurt, 'the blast wounds the hunted');
  // the client recomputes this shove locally off seekerBoom (kb in shared
  // constants); the hurt's imp must keep matching it — it still drives the pan
  // (horizontal part ≤ kb[0]: the direction is normalized by the 3D distance)
  const impH = Math.hypot(blastHurt.m.imp[0], blastHurt.m.imp[2]);
  assert.ok(impH > 0 && impH <= ENEMIES.seeker.kb[0] + 1e-9
    && blastHurt.m.imp[1] === ENEMIES.seeker.kb[1], 'the blast shove comes from the shared kb tuning');

  // terrain blocks them: one conjured inside a pillar detonates immediately
  msgs.length = 0;
  const pil = ARENA.pillars[0];
  const blocked = g.spawnEnemy('seeker', [pil.p[0], 1.0, pil.p[2]]);
  blocked.target = 'p1'; blocked.popUntil = 0; blocked.launchV = [0, 0, 0]; blocked.dieAt = g.t + 25;
  advance(g, 0.1);
  assert.ok(!g.enemies.has(blocked.id), 'a pillar eats the missile');
  assert.ok(msgs.some(x => x.m.t === 'seekerBoom'), 'terrain impacts still boom');

  // the salvo grows by one with every phase the encounter enters
  msgs.length = 0;
  g.enterDamage(); // clearAdds also sweeps leftover seekers
  advance(g, ENC.seekerFirst + 0.2);
  let launch = msgs.filter(x => x.m.t === 'seekers').pop();
  assert.equal(launch.m.n, ENC.seekerBase + 1, 'damage phase adds a missile');
  g.enterMech(2);
  advance(g, ENC.seekerFirst + 0.2);
  launch = msgs.filter(x => x.m.t === 'seekers').pop();
  assert.equal(launch.m.n, ENC.seekerBase + 2, 'round 2 mech adds another');
  g.enterFinal();
  advance(g, ENC.seekerFirst + 0.2);
  launch = msgs.filter(x => x.m.t === 'seekers').pop();
  assert.equal(launch.m.n, ENC.seekerBase + 3, 'final stand adds another');
  ok('homing seekers: launch, hunt, shoot-down, chain reaction, terrain block, phase escalation');
}

// ---------- damage-phase seekers converge on the marked player ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'A', 'gunslinger');
  g.addPlayer('p2', 'B', 'voidcaller');
  g.addPlayer('p3', 'C', 'sentinel');
  for (let i = 1; i <= 3; i++) moveTo(g, 'p' + i, [i * 0.5, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  const seekers = () => [...g.enemies.values()].filter(e => e.type === 'seeker');

  // while the boss is enraged the whole salvo hunts its mark, like the volleys
  g.enterDamage();
  const mark = g.enc.focus;
  assert.ok(mark, 'damage opens with a marked player');
  advance(g, ENC.seekerFirst + 0.2);
  assert.ok(seekers().length > 0, 'damage salvo launched');
  assert.ok(seekers().every(s => s.target === mark), 'damage: every missile hunts the mark');

  // a stale mark id falls back to the random spread, never a dead reference
  g.clearAdds();
  g.enc.focus = 'ghost';
  g.launchSeekers();
  assert.ok(seekers().length > 0 && seekers().every(s => g.players.has(s.target)), 'a vanished mark falls back to live prey');

  // outside DAMAGE the salvo spreads across the fireteam even if a mark lingers
  g.enterMech(2);
  g.enc.focus = mark;
  const picked = new Set();
  for (let i = 0; i < 6; i++) { g.clearAdds(); g.launchSeekers(); for (const s of seekers()) picked.add(s.target); }
  assert.ok(picked.size > 1, 'mech: the salvo spreads across the fireteam again');
  ok('seekers: damage-phase salvo converges on the mark, spreads otherwise');
}

// ---------- generator-surge seeker bursts scale with the fireteam ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'A', 'gunslinger');
  g.addPlayer('p2', 'B', 'voidcaller');
  g.addPlayer('p3', 'C', 'sentinel');
  g.addPlayer('p4', 'D', 'gunslinger');
  for (let i = 1; i <= 4; i++) moveTo(g, 'p' + i, [i * 0.5, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);

  // four alive → each burst is two waves, the second rippling surgeWaveGap later
  g.enterFinal();
  msgs = [];
  const seekers = () => [...g.enemies.values()].filter(e => e.type === 'seeker');
  advance(g, ENC.surgeFirst + 0.1); // first wave up, second still rippling
  const w1 = new Set(seekers().map(s => s.target));
  assert.equal(w1.size, 1, 'a surge wave is one chain: every missile hunts the same guardian');
  advance(g, ENC.surgeWaveGap); // first burst fully rippled, well before the next at surgeWaveCd
  const burst = msgs.filter(x => x.m.t === 'seekers');
  assert.equal(burst.length, 2, 'four guardians: two waves per burst');
  const hunted = new Set(seekers().map(s => s.target));
  assert.equal(hunted.size, 2, 'the second wave rotates to a fresh guardian');

  // two left standing → the burst shrinks back to a single wave
  g.players.get('p3').dead = true;
  g.players.get('p4').dead = true;
  msgs = [];
  advance(g, ENC.surgeWaveCd); // spans exactly one burst window
  assert.equal(msgs.filter(x => x.m.t === 'seekers').length, 1, 'two guardians: one wave per burst');

  // a half-fired burst must not leak across phase entries
  g.enc.surgeWavesLeft = 3;
  g.enterDamage();
  assert.equal(g.enc.surgeWavesLeft, 0, 'phase entry kills the rest of a surge burst');
  ok('generator-surge seeker bursts: floor(alive/2) single-chain waves, round-robin hunt, no cross-phase leak');
}

// ---------- husk lunge: the anti-kite pounce ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Kiter', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterDamage(); // no MECH waves here — the conjured husk owns the floor
  const L = ENEMIES.husk.lunge;
  const d2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
  const aim = [12.5, 0, 21.6]; // the seeker test's proven pillar-clear 60° spot
  const dir = [0.5, 0, 0.866]; // outward along that same ray
  moveTo(g, 'p1', aim);

  // beyond the band it just walks — no crouch
  const husk = g.spawnEnemy('husk',
    [aim[0] + dir[0] * (L.max + 3), 0, aim[2] + dir[2] * (L.max + 3)]);
  husk.nextLungeAt = 0; husk.nextAtkAt = 0; // spawn jitter off the table
  advance(g, 0.05);
  assert.ok(!husk.windupUntil, 'no pounce from beyond the band');

  // inside the band it roots into the crouch — the sudden stop is the telegraph
  husk.pos = [aim[0] + dir[0] * (L.max - 0.5), 0, aim[2] + dir[2] * (L.max - 0.5)];
  advance(g, 0.05);
  assert.ok(husk.windupUntil > g.t, 'in band: the crouch telegraph starts');
  assert.ok(husk.nextLungeAt > g.t + 1, 'the pounce goes on cooldown as it triggers');
  const crouched = [...husk.pos];
  advance(g, L.windup - 0.1);
  assert.ok(d2(husk.pos, crouched) < 1e-9, 'rooted while it winds up');

  // the spring covers the 5.5 m gap far faster than walk speed ever could,
  // lands inside melee range, grounds the pounce arc, and converts to a swing
  msgs = [];
  advance(g, 0.4); // windup tail + flight (5.5 m at lunge speed ≈ 0.28 s)
  assert.ok(d2(husk.pos, aim) < ENEMIES.husk.atkRange, 'the pounce lands in melee range');
  assert.equal(husk.pos[1], 0, 'the pounce arc returns to the floor');
  assert.ok(msgs.some(x => x.to === 'p1' && x.m.t === 'hurt' && x.m.src === 'husk'),
    'the landed pounce converts to a swing');
  assert.ok(husk.nextLungeAt > g.t, 'still on cooldown — no chain-pouncing');
  ok('husk lunge: band trigger, rooted telegraph, locked spring, cooldown');
}

// ---------- acolyte corkscrew bolts + harder strafe ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Weaver', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterDamage();
  const aim = [12.5, 1, 21.6]; // chest height on the proven pillar-clear 60° ray
  const dir = [0.5, 0, 0.866];
  moveTo(g, 'p1', [12.5, 0, 21.6]);

  // a bolt fired up the clear corridor weaves off the straight chord…
  const from = [2.5, 1.6, 4.33]; // ~20 m down-range on the same ray
  g.fireProjAt(from, g.players.get('p1'), ENEMIES.acolyte, 'bolt', 0.45);
  const [bid, bolt] = [...g.projs.entries()].find(([, pr]) => pr.k === 'bolt');
  assert.ok(bolt.hx, 'acolyte bolts carry the helix');
  // the snapshot ships the curve params — the client replays the exact
  // parametric corkscrew (and its trail) instead of chording 10 Hz samples
  g.broadcastSnapshot();
  const snapPr = msgs.findLast(x => x.m.t === 'snap').m.projs.find(p => p.id === bid);
  for (const f of ['bp', 'bv', 'a', 'T', 'ph', 'om', 'r']) {
    assert.ok(snapPr.hx[f] !== undefined, `snapshot helix carries ${f}`);
  }
  const n = [aim[0] - from[0], aim[1] - from[1], aim[2] - from[2]];
  const nl = Math.hypot(...n); n.forEach((c, i) => n[i] = c / nl);
  let maxDev = 0;
  msgs = [];
  for (let i = 0; i < 40 && g.projs.has(bid); i++) {
    advance(g, 0.05);
    const rel = [bolt.p[0] - from[0], bolt.p[1] - from[1], bolt.p[2] - from[2]];
    const along = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2];
    const dev = Math.hypot(rel[0] - n[0] * along, rel[1] - n[1] * along, rel[2] - n[2] * along);
    maxDev = Math.max(maxDev, dev);
    if (msgs.some(x => x.to === 'p1' && x.m.t === 'hurt' && x.m.src === 'bolt')) break;
  }
  assert.ok(maxDev > 0.5, `mid-flight the bolt leaves the straight line (peak ${maxDev.toFixed(2)} m)`);
  // …yet the sin taper still delivers it dead on target
  assert.ok(msgs.some(x => x.to === 'p1' && x.m.t === 'hurt' && x.m.src === 'bolt'),
    'the tapered helix still lands the hit');

  // strafe reads its shared tuning: one tick in-band slides at strafe.spd, ⊥ to the prey
  const S = ENEMIES.acolyte.strafe;
  const aco = g.spawnEnemy('acolyte', [12.5 - dir[0] * 18, 0, 21.6 - dir[2] * 18]);
  const before = [...aco.pos];
  advance(g, 0.05);
  const d = [aco.pos[0] - before[0], aco.pos[2] - before[2]];
  assert.ok(Math.abs(Math.hypot(...d) - S.spd * 0.05) < 0.02, 'in-band slide moves at strafe.spd');
  assert.ok(Math.abs(d[0] * dir[0] + d[1] * dir[2]) < 0.05, 'the slide is perpendicular to the prey line');

  // ranged shots channel first: rooted, snapshot-flagged, THEN the bolt
  const bolts = () => [...g.projs.values()].filter(pr => pr.k === 'bolt').length;
  aco.nextAtkAt = 0;
  msgs = [];
  advance(g, 0.05);
  assert.ok(aco.chargeUntil > g.t, 'the shot channels before it leaves');
  assert.equal(bolts(), 0, 'no bolt mid-channel');
  g.broadcastSnapshot();
  const se = msgs.findLast(x => x.m.t === 'snap').m.enemies.find(en => en.id === aco.id);
  assert.ok(se.ch > 0, 'snapshot carries the charge end-time for the muzzle orb');
  const rooted = [...aco.pos];
  advance(g, ENEMIES.acolyte.chargeT - 0.15);
  assert.ok(Math.hypot(aco.pos[0] - rooted[0], aco.pos[2] - rooted[2]) < 1e-9, 'rooted while channeling');
  advance(g, 0.3);
  assert.equal(aco.chargeUntil, 0, 'the channel releases');
  assert.equal(bolts(), 1, 'the bolt leaves at channel end');
  assert.ok(aco.nextAtkAt > g.t + 1, 'fire cooldown counts from the release');
  ok('acolyte: corkscrew bolts weave yet land, strafe + charge telegraph on shared tuning');
}

// ---------- keeper snipers: track → lock-lead → instant shot ----------
{
  const S = ENEMIES.keeper.snipe;
  const g = mkGame();
  g.addPlayer('p1', 'Mark', 'gunslinger');
  moveTo(g, 'p1', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  g.enterDamage(); // quiet room: no MECH waves, adds cleared at entry
  moveTo(g, 'p1', [12.5, 0, 21.6]);
  const kpr = g.spawnEnemy('keeper', [2.5, 0, 4.33]); // ~20 m down the clear 60° ray
  kpr.nextAtkAt = 0;
  const snipesAt = () => msgs.filter(x => x.m.t === 'snipe');

  // cycle opens: rooted track glued to the prey, snapshot carries the aim
  msgs = [];
  advance(g, 0.05);
  assert.equal(kpr.snPhase, 'track', 'the laser starts tracking');
  assert.equal(kpr.snTarget, 'p1');
  const stood = [...kpr.pos];
  g.broadcastSnapshot();
  let se = msgs.findLast(x => x.m.t === 'snap').m.enemies.find(en => en.id === kpr.id);
  assert.equal(se.aim, 'p1', 'snapshot names the tracked prey');
  assert.ok(!se.lk, 'no kill-point while tracking');

  // a stationary prey gets locked exactly where it stands…
  advance(g, S.track + 0.1);
  assert.equal(kpr.snPhase, 'lock', 'track hands over to lock');
  assert.ok(Math.hypot(kpr.lockP[0] - 12.5, kpr.lockP[2] - 21.6) < 0.01, 'no velocity → no lead');
  assert.ok(Math.hypot(kpr.pos[0] - stood[0], kpr.pos[2] - stood[2]) < 1e-9, 'rooted through the cycle');
  g.broadcastSnapshot();
  se = msgs.findLast(x => x.m.t === 'snap').m.enemies.find(en => en.id === kpr.id);
  assert.ok(se.lk && se.ft > g.t, 'snapshot carries the frozen kill-point and fire time');

  // …and the instant shot lands for dmgFrac of max HP
  msgs = [];
  advance(g, S.lock + 0.1);
  assert.equal(snipesAt().length, 1, 'one snipe crack broadcast');
  assert.equal(snipesAt()[0].m.hit, 'p1');
  const hurt = msgs.find(x => x.to === 'p1' && x.m.t === 'hurt' && x.m.src === 'snipe');
  assert.equal(hurt.m.dmg, Math.round(PLAYER.maxHp * S.dmgFrac), 'the hit takes dmgFrac of max HP');
  assert.ok(kpr.nextAtkAt > g.t + 1, 'sniper cooldown counts from the shot');

  // a prey that KEEPS its momentum is led perfectly: walk +x at 8 m/s through
  // the whole cycle — the lock leads ahead, the walker arrives on schedule
  kpr.nextAtkAt = 0;
  let px = 12.5;
  const stride = () => { px += 8 * 0.05; moveTo(g, 'p1', [px, 0, 21.6]); };
  for (let i = 0; i < 8; i++) { stride(); g.tick(0.05); } // server learns the velocity
  assert.equal(kpr.snPhase, 'track');
  while (kpr.snPhase === 'track') { stride(); g.tick(0.05); }
  assert.ok(kpr.lockP[0] > px + 8 * S.lock * 0.5, 'the kill-point leads the walker');
  msgs = [];
  while (kpr.snPhase === 'lock') { stride(); g.tick(0.05); }
  assert.equal(snipesAt()[0].m.hit, 'p1', 'unchanged momentum walks into the shot');

  // a prey that slams the brakes at lock walks OUT of the led kill-point
  kpr.nextAtkAt = 0;
  for (let i = 0; i < 8; i++) { stride(); g.tick(0.05); }
  while (kpr.snPhase === 'track') { stride(); g.tick(0.05); }
  msgs = [];
  while (kpr.snPhase === 'lock') { moveTo(g, 'p1', [px, 0, 21.6]); g.tick(0.05); } // freeze
  assert.equal(snipesAt()[0].m.hit, null, 'braking inside the lock window dodges');
  assert.ok(!msgs.some(x => x.m.t === 'hurt' && x.m.src === 'snipe'), 'no snipe damage on the miss');

  // hard cover: a pillar between muzzle and kill-point eats the shot
  const pil = ARENA.pillars[0];
  const pd = Math.hypot(pil.p[0], pil.p[2]);
  const pu = [pil.p[0] / pd, pil.p[2] / pd];
  moveTo(g, 'p1', [pil.p[0] + pu[0] * 5, 0, pil.p[2] + pu[1] * 5]); // behind the pillar
  kpr.pos = [pil.p[0] - pu[0] * 8, 0, pil.p[2] - pu[1] * 8];        // muzzle on the far side
  kpr.nextAtkAt = 0; kpr.snPhase = null; kpr.snUntil = 0;
  msgs = [];
  advance(g, S.track + S.lock + 0.3);
  assert.equal(snipesAt()[0].m.hit, null, 'the pillar eats the shot');
  ok('keeper snipers: rooted track, momentum-led lock, brake dodge, pillar cover');
}

// ---------- end-of-encounter scoreboard ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Carry', 'gunslinger');
  g.addPlayer('p2', 'Anchor', 'sentinel');
  moveTo(g, 'p1', [0, 0, 1]); moveTo(g, 'p2', [1, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  god(g);
  const p1 = g.players.get('p1'), p2 = g.players.get('p2');
  assert.deepEqual(p1.stats, { kills: 0, bossDmg: 0, keepers: 0 }, 'the board starts clean');

  // kills credit the killer; a keeper ticks the keeper column too
  const husk = g.spawnEnemy('husk', [10, 0, 10]);
  slay(g, husk.id);
  const keeper = g.spawnEnemy('keeper', [12, 0, 12]);
  slay(g, keeper.id);
  assert.equal(p1.stats.kills, 2, 'both kills credited');
  assert.equal(p1.stats.keepers, 1, 'the keeper counted separately');
  assert.equal(p2.stats.kills, 0, 'the bystander earns nothing');

  // boss damage scores only what lands: nothing while shielded, no overkill
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  assert.equal(p1.stats.bossDmg, 0, 'shielded hits score nothing');
  g.enterDamage();
  g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  assert.equal(p1.stats.bossDmg, 200, 'landed boss damage scored');
  g.enc.bossHp = 50;
  g.onMessage('p2', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  assert.equal(p2.stats.bossDmg, 50, 'overkill past zero is not scored');
  assert.equal(g.enc.st, 'VICTORY');
  const died = msgs.findLast(x => x.m.t === 'bossDied').m;
  assert.equal(died.stats.length, 2, 'one scoreboard row per guardian');
  assert.equal(died.stats[0].name, 'Carry', 'sorted by boss damage');
  assert.deepEqual(
    [died.stats[0].kills, died.stats[0].dmg, died.stats[0].keepers, died.stats[1].dmg],
    [2, 200, 1, 50], 'rows carry kills/dmg/keepers');

  // the next encounter starts a fresh board; a wipe carries the board too
  advance(g, ENC.victoryDelay + 0.5);
  moveTo(g, 'p1', [0, 0, 1]); moveTo(g, 'p2', [1, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  assert.equal(g.enc.st, 'MECH');
  assert.deepEqual(g.players.get('p1').stats, { kills: 0, bossDmg: 0, keepers: 0 },
    'a new encounter wipes the board');
  g.startWipe();
  const wiped = msgs.findLast(x => x.m.t === 'wipe').m;
  assert.equal(wiped.stats.length, 2, 'the wipe message carries the scoreboard');
  ok('end-of-encounter scoreboard: credit, caps, sort, reset');
}

// ---------- per-class grenades ----------
{
  // balance contract: the gunslinger front-loads, the voidcaller doubles the total
  const gsTotal = GRENADE.gunslinger.dmg + GRENADE.gunslinger.swarm.n * GRENADE.gunslinger.swarm.dmg;
  const vcTotal = GRENADE.voidcaller.dmg + GRENADE.voidcaller.orb.dps * GRENADE.voidcaller.orb.dur;
  assert.ok(GRENADE.gunslinger.dmg > GRENADE.voidcaller.dmg, 'gunslinger hits harder upfront');
  assert.ok(vcTotal > gsTotal * 1.8 && vcTotal < gsTotal * 2.2,
    `voidcaller total ≈ 2x gunslinger total (${vcTotal} vs ${gsTotal})`);
  assert.equal(GRENADE.sentinel.dmg, 0, 'the sentinel grenade harms nobody');
  assert.ok(GRENADE.sentinel.heal.speed >= PLAYER.walk - 0.5 && GRENADE.sentinel.heal.speed <= PLAYER.walk + 0.5,
    'mend-orbs start at roughly walking pace');

  const g = mkGame();
  g.addPlayer('p1', 'Slinger', 'gunslinger');
  g.addPlayer('p2', 'Voider', 'voidcaller');
  g.addPlayer('p3', 'Medic', 'sentinel');
  for (let i = 1; i <= 3; i++) moveTo(g, 'p' + i, [i * 0.5, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  assert.equal(g.enc.st, 'MECH');
  // quiet the arena so nothing else touches the damage/heal math
  const hush = () => Object.assign(g.enc, {
    nextWaveAt: g.t + 999, nextKeeperAt: g.t + 999, nextVolleyAt: g.t + 999,
    nextSeekerAt: g.t + 999, nextSlamAt: g.t + 999, nextSpecialAt: g.t + 999,
  });
  hush(); g.clearAdds();

  // gunslinger: the blast carries the per-class numbers (point-blank = full dmg)
  const k1 = g.spawnEnemy('keeper', [20, 0, 5]);
  g.onMessage('p1', { t: 'explode', kind: 'grenade', p: [k1.pos[0], 1, k1.pos[2]] });
  assert.equal(k1.maxHp - k1.hp, GRENADE.gunslinger.dmg, 'gunslinger blast lands its full damage point-blank');
  assert.equal(g.dots.size, 0, 'no void orb from a gunslinger');

  // swarm embers are ordinary client hits — capped server-side
  const hpb = k1.hp;
  g.onMessage('p1', { t: 'hit', target: k1.id, dmg: 99999, weapon: 'gswarm' });
  assert.ok(hpb - k1.hp <= DMG_CAPS.gswarm, 'swarm ember damage capped');

  // voidcaller: smaller blast + a parked orb that gnaws for the full duration
  const k2 = g.spawnEnemy('keeper', [-20, 0, 5]); // 10 < dist-to-players < 26: it stands its ground
  g.onMessage('p2', { t: 'explode', kind: 'grenade', p: [k2.pos[0], 1, k2.pos[2]] });
  assert.equal(k2.maxHp - k2.hp, GRENADE.voidcaller.dmg, 'voidcaller blast lands its (smaller) damage');
  assert.equal(g.dots.size, 1, 'the blast parks a void orb');
  assert.ok(msgs.some(x => x.to === null && x.m.t === 'voidOrb'), 'orb announced for the client FX');
  hush();
  advance(g, GRENADE.voidcaller.orb.dur + 0.6);
  const gnawed = k2.maxHp - k2.hp - GRENADE.voidcaller.dmg;
  const expected = GRENADE.voidcaller.orb.dps * GRENADE.voidcaller.orb.dur;
  assert.ok(gnawed >= expected - GRENADE.voidcaller.orb.dps * 0.6 && gnawed <= expected + 1,
    `the orb gnaws ≈ dps×dur in total (got ${gnawed})`);
  assert.equal(g.dots.size, 0, 'the orb burns out');

  // sentinel: the burst splits into mend-orbs hunting the two most wounded
  hush(); g.clearAdds(); g.projs.clear(); // no stray bolts during the heal window
  const p1 = g.players.get('p1'), p2 = g.players.get('p2'), p3 = g.players.get('p3');
  p1.hp = 40; p2.hp = 120; p3.hp = 200;
  p1.lastDmg = p2.lastDmg = p3.lastDmg = g.t; // hold regen out of the heal math
  msgs = [];
  g.onMessage('p3', { t: 'explode', kind: 'grenade', p: [0, 1, 20] });
  assert.equal(p1.hp, 40, 'the burst itself heals and harms nobody');
  const orbs = [...g.projs.values()].filter(pr => pr.k === 'heal');
  assert.equal(orbs.length, GRENADE.sentinel.heal.n, 'the burst splits into two mend-orbs');
  assert.deepEqual(orbs.map(o => o.tgt).sort(), ['p1', 'p2'], 'they hunt the two most wounded, picked at the split');
  advance(g, 4); // ~19 m at walking pace + acceleration — they catch up well inside this
  const bursts = msgs.filter(x => x.m.t === 'healBurst');
  assert.equal(bursts.length, 2, 'both deliveries announced');
  assert.deepEqual(bursts.map(x => x.m.id).sort(), ['p1', 'p2']);
  assert.equal(p1.hp, 40 + GRENADE.sentinel.heal.amount, 'the most wounded guardian was mended');
  assert.equal(p2.hp, PLAYER.maxHp, 'healing clamps at full health');
  assert.equal([...g.projs.values()].filter(pr => pr.k === 'heal').length, 0, 'orbs spent on delivery');

  // the explode rate-limit covers the payloads too
  g.onMessage('p3', { t: 'explode', kind: 'grenade', p: [0, 1, 20] });
  assert.equal([...g.projs.values()].filter(pr => pr.k === 'heal').length, 0,
    'a second grenade inside the rate window spawns nothing');
  ok('per-class grenades: gunslinger burst + capped swarm, voidcaller ≈2x via orb, sentinel mend-orbs');
}

// ---------- sweep pillar cover & the FINAL crumble ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Shadowed', 'gunslinger');
  g.addPlayer('p2', 'Exposed', 'sentinel');
  moveTo(g, 'p1', [0, 0, 1]); moveTo(g, 'p2', [0, 0, 1]);
  advance(g, ENC.readyTime + 0.5);
  assert.equal(g.enc.st, 'MECH');
  god(g);
  Object.assign(g.enc, {
    nextWaveAt: g.t + 999, nextKeeperAt: g.t + 999, nextVolleyAt: g.t + 999,
    nextSeekerAt: g.t + 999, nextSlamAt: g.t + 999, nextSpecialAt: g.t + 999,
  });
  g.clearAdds();

  // p1 hides in the shadow of the 30° pillar (r 17); p2 stands on the empty
  // 60° radial (the spawn radial — no stone between center and player there)
  const a1 = Math.PI / 6, a2 = Math.PI / 3;
  moveTo(g, 'p1', [Math.cos(a1) * 25, 0, Math.sin(a1) * 25]);
  moveTo(g, 'p2', [Math.cos(a2) * 25, 0, Math.sin(a2) * 25]);
  const p1 = g.players.get('p1'), p2 = g.players.get('p2');

  // a live beam parked on p1's radial: the pillar soaks it
  g.enc.sweep = { a1, a2: a1 + Math.PI / 2, w1: 0, w2: 0, armAt: g.t, until: g.t + 999 };
  advance(g, 0.3);
  assert.equal(p1.hp, 1e9, 'a standing pillar shadows the sweep');

  // swing the beam onto p2's open radial: it bites
  g.enc.sweep.a1 = a2;
  advance(g, 0.3);
  assert.equal(1e9 - p2.hp, ENC.sweepDmg, 'no pillar between center and player — the sweep lands');

  // crumbled pillars shelter nobody: the same shadow position now burns
  g.enc.pillarsDown = true;
  g.enc.sweep.a1 = a1;
  p1.sweepCdAt = 0;
  advance(g, 0.3);
  assert.equal(1e9 - p1.hp, ENC.sweepDmg, 'pillarsDown voids the shadow');

  // wiring: enterFinal drops the pillars, the snapshot ships the flag for the
  // client sink, and resetWorld raises them again for the next raid
  g.enc.pillarsDown = false;
  g.enterFinal();
  assert.equal(g.enc.pillarsDown, true, 'enterFinal crumbles the pillars');
  g.broadcastSnapshot();
  assert.equal(msgs.findLast(x => x.m.t === 'snap').m.enc.pd, true, 'snapshot carries pd');
  g.resetWorld();
  assert.equal(g.enc.pillarsDown, false, 'resetWorld restores the pillars');
  ok('sweep pillar cover: shadows shelter until the FINAL crumble');
}

// ---------- echo guardians: soul-signs, summoning, rally, exclusions ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Summoner', 'gunslinger');
  g.broadcastSnapshot();
  let snap = msgs.findLast(x => x.m.t === 'snap').m;
  assert.deepEqual(snap.signs, [], 'no soul-signs before the banner');

  // planting the standard rings it with one sign per roster echo
  moveTo(g, 'p1', ENC.banner.pos);
  g.onMessage('p1', { t: 'interact' });
  g.broadcastSnapshot();
  snap = msgs.findLast(x => x.m.t === 'snap').m;
  assert.equal(snap.signs.length, BOTS.roster.length, 'one sign per unsummoned echo');
  assert.ok(snap.signs.every(s => BOTS.roster.some(r => r.name === s.name && r.cls === s.cls)),
    'signs carry the roster names and classes');

  // an interact on a sign summons that echo as an ordinary player
  msgs = [];
  moveTo(g, 'p1', snap.signs[0].p);
  g.onMessage('p1', { t: 'interact' });
  assert.equal(g.players.size, 2, 'the echo joined the fireteam');
  const bot = [...g.players.values()].find(p => p.bot);
  assert.equal(bot.name, snap.signs[0].name, 'the named echo answered');
  assert.ok(msgs.some(x => x.to === null && x.m.t === 'summon' && x.m.id === bot.id),
    'summon broadcast for the materialization FX');
  g.broadcastSnapshot();
  snap = msgs.findLast(x => x.m.t === 'snap').m;
  assert.equal(snap.signs.length, BOTS.roster.length - 1, 'its sign is spent');
  assert.equal(snap.players.find(p => p.id === bot.id).bt, 1, 'snapshot flags the echo (phantom tint)');

  // echoes rally at the standard on their own — full super at the pull
  advance(g, 6);
  assert.ok(bot.restocked, 'the echo rallied at the banner');
  assert.ok(bot.sup >= 99, 'the rally filled its super gauge');

  // summon the rest of the roster
  for (let guard = 0; g.bots.signs.size > 0; guard++) {
    assert.ok(guard < 10, 'roster summons terminate');
    const s = [...g.bots.signs.values()][0];
    moveTo(g, 'p1', s.p);
    g.onMessage('p1', { t: 'interact' });
  }
  assert.equal(g.players.size, 1 + BOTS.roster.length, 'the full circle stands (cap 6)');

  // dismissal: the newest echo yields (the join gate calls this for a human)
  // and its sign returns while the banner stands
  const lastBot = [...g.players.values()].filter(p => p.bot).pop();
  assert.ok(g.bots.dismissNewest(), 'an echo yielded');
  assert.ok(!g.players.has(lastBot.id), 'the NEWEST echo was the one dismissed');
  assert.equal(g.bots.signs.size, 1, 'its sign returns');
  moveTo(g, 'p1', [...g.bots.signs.values()][0].p);
  g.onMessage('p1', { t: 'interact' });
  assert.equal(g.players.size, MAX_PLAYERS, 'resummoned to a full circle');

  // the human steps on the plate; the echoes converge and the raid starts,
  // scaled for every body in the circle
  moveTo(g, 'p1', [0, 0, 1]);
  for (let i = 0; i < 400 && g.enc.st === 'LOBBY'; i++) g.tick(0.05);
  assert.equal(g.enc.st, 'MECH', 'echoes joined the plate — the raid started');
  assert.equal(g.enc.bossMax, ENC.bossBase + ENC.bossPerPlayer * (MAX_PLAYERS - 1),
    'boss HP scales for the full circle');
  god(g);

  // echoes never touch the fireteam's pickups: key, capsule, ammo brick
  const echo = [...g.players.values()].find(p => p.bot);
  moveTo(g, 'p1', [0, 0, -20]); // keep the only human away from the bait
  g.keys.set('kx', { p: [echo.pos[0], 0, echo.pos[2]] });
  g.caps.set('cx', { p: [echo.pos[0], 0, echo.pos[2]], landAt: g.t - 1 });
  g.bricks.set('bx', { kind: 'heavy', p: [echo.pos[0], 0, echo.pos[2]], until: g.t + 99 });
  g.tickPlayers(0.05);
  assert.ok(g.keys.has('kx') && !echo.hasKey, 'echoes never claim the auric key');
  assert.ok(g.caps.has('cx') && echo.antiviral === 0, 'echoes never eat capsules');
  assert.ok(g.bricks.has('bx'), 'echoes never eat ammo bricks');
  g.keys.delete('kx'); g.caps.delete('cx'); g.bricks.delete('bx');
  ok('echo guardians: signs → summon → rally → dismissal → plate start → pickup exclusions');
}

// ---------- echo guardians: revive claims + single-dome discipline ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Anchor', 'gunslinger');
  moveTo(g, 'p1', ENC.banner.pos);
  g.onMessage('p1', { t: 'interact' });
  for (const s of [...g.bots.signs.values()]) {
    if (s.cls !== 'sentinel') continue;
    moveTo(g, 'p1', s.p);
    g.onMessage('p1', { t: 'interact' });
  }
  const titans = [...g.players.values()].filter(p => p.bot);
  assert.equal(titans.length, 2, 'both sentinels answered');

  moveTo(g, 'p1', [0, 0, 1]);
  for (let i = 0; i < 400 && g.enc.st === 'LOBBY'; i++) g.tick(0.05);
  assert.equal(g.enc.st, 'MECH');
  god(g);
  Object.assign(g.enc, {
    nextWaveAt: g.t + 999, nextKeeperAt: g.t + 999, nextSeekerAt: g.t + 999, nextSpecialAt: g.t + 999,
  });
  g.clearAdds();
  titans.forEach(p => { p.sup = 100; });

  // down the human: a titan claims the revive, domes the body, channels — and
  // the second titan holds its super (one dome at a time, fireteam-wide)
  const p1 = g.players.get('p1');
  moveTo(g, 'p1', [18, 0, 6]);
  msgs = [];
  g.downPlayer(p1);
  assert.notEqual(g.enc.st, 'WIPE', 'living echoes keep the attempt alive');
  advance(g, 14);
  assert.ok(!p1.downed, 'an echo picked the guardian back up');
  assert.ok(msgs.some(x => x.m.t === 'revived' && x.m.id === 'p1'), 'revive announced');
  const wardCasts = msgs.filter(x => x.m.t === 'super' && x.m.kind === 'ward');
  assert.equal(wardCasts.length, 1, `exactly one dome sheltered the revive (got ${wardCasts.length})`);
  ok('echo sentinels: revive claim, dome on the body, second titan holds');
}

// ---------- echo guardians: class brains (pack nova, hoarded golden) ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Speaker', 'sentinel');
  moveTo(g, 'p1', ENC.banner.pos);
  g.onMessage('p1', { t: 'interact' });
  let warlockTaken = false;
  for (const s of [...g.bots.signs.values()]) {
    if (s.cls === 'sentinel') continue;
    if (s.cls === 'voidcaller') {
      if (warlockTaken) continue;
      warlockTaken = true;
    }
    moveTo(g, 'p1', s.p);
    g.onMessage('p1', { t: 'interact' });
  }
  const hunter = [...g.players.values()].find(p => p.bot && p.cls === 'gunslinger');
  const warlock = [...g.players.values()].find(p => p.bot && p.cls === 'voidcaller');
  assert.ok(hunter && warlock, 'one gunslinger + one voidcaller echo');

  moveTo(g, 'p1', [0, 0, 1]);
  for (let i = 0; i < 400 && g.enc.st === 'LOBBY'; i++) g.tick(0.05);
  assert.equal(g.enc.st, 'MECH');
  god(g);
  Object.assign(g.enc, {
    nextWaveAt: g.t + 999, nextKeeperAt: g.t + 999, nextSeekerAt: g.t + 999, nextSpecialAt: g.t + 999,
  });
  g.clearAdds();

  // a swamping husk pack (over the addFill pressure gate) clumps in the open:
  // the warlock answers with a nova; the gunslinger's golden never fires at
  // adds (hoarded for the boss). 16 husks ≥ novaFill of the 3-player cap (20).
  warlock.sup = 100;
  hunter.sup = 100;
  const [wx, wz] = (() => { const l = Math.hypot(warlock.pos[0], warlock.pos[2]) || 1;
    return [warlock.pos[0] / l, warlock.pos[2] / l]; })();
  const pc = [wx * 15, 0, wz * 15];
  const pack = [];
  for (let i = 0; i < 16; i++) {
    pack.push(g.spawnEnemy('husk', [pc[0] + (i % 4) - 1.5, 0, pc[2] + Math.floor(i / 4) * 1.5 - 1.5]));
  }
  msgs = [];
  advance(g, 1.5);
  assert.ok(msgs.some(x => x.m.t === 'super' && x.m.kind === 'nova' && x.m.id === warlock.id),
    'the warlock answers the pack with a nova');
  assert.ok(!msgs.some(x => x.m.t === 'super' && x.m.kind === 'golden'),
    'golden is hoarded while the boss is shielded');
  advance(g, 4.5);
  assert.ok(pack.every(h => !g.enemies.has(h.id)), 'the cluster is erased');

  // the moment the boss lies bare, the hoarded golden answers and the burn begins
  msgs = [];
  g.enterDamage();
  advance(g, 3);
  assert.ok(msgs.some(x => x.m.t === 'super' && x.m.kind === 'golden' && x.m.id === hunter.id),
    'golden answers the bare boss');
  assert.ok(hunter.goldenUntil > g.t, 'the buff is live');
  const before = hunter.stats.bossDmg;
  advance(g, 8);
  assert.ok(hunter.stats.bossDmg > before, 'the gunslinger pours damage into the boss');
  assert.ok(g.enc.bossHp < g.enc.bossMax, 'the boss bar moved');
  ok('echo class brains: pack nova, hoarded golden, boss burn');
}

// ---------- echo guardians: idle escort (no statues between waves) ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Wanderer', 'gunslinger');
  moveTo(g, 'p1', ENC.banner.pos);
  g.onMessage('p1', { t: 'interact' });
  for (let guard = 0; g.bots.signs.size > 0; guard++) {
    assert.ok(guard < 10);
    const s = [...g.bots.signs.values()][0];
    moveTo(g, 'p1', s.p);
    g.onMessage('p1', { t: 'interact' });
  }
  moveTo(g, 'p1', [0, 0, 1]);
  for (let i = 0; i < 400 && g.enc.st === 'LOBBY'; i++) g.tick(0.05);
  assert.equal(g.enc.st, 'MECH');
  god(g);
  Object.assign(g.enc, {
    nextWaveAt: g.t + 999, nextKeeperAt: g.t + 999, nextSeekerAt: g.t + 999, nextSpecialAt: g.t + 999,
  });
  g.clearAdds();

  // empty arena: the echoes regroup on the human wherever they walk
  moveTo(g, 'p1', [20, 0, 10]);
  advance(g, 8);
  const bots = [...g.players.values()].filter(p => p.bot);
  const p1 = g.players.get('p1');
  assert.ok(bots.every(b => Math.hypot(b.pos[0] - p1.pos[0], b.pos[2] - p1.pos[2]) < 14),
    'echoes gather around the idle guardian');
  moveTo(g, 'p1', [-22, 0, -8]);
  advance(g, 8);
  assert.ok(bots.every(b => Math.hypot(b.pos[0] - p1.pos[0], b.pos[2] - p1.pos[2]) < 14),
    'echoes follow when the guardian relocates');
  ok('echo escort: the squad follows the fireteam between waves');
}

// ---------- echo guardians: full clear with the whole circle ----------
{
  const g = mkGame();
  g.addPlayer('p1', 'Raidlead', 'gunslinger');
  moveTo(g, 'p1', ENC.banner.pos);
  g.onMessage('p1', { t: 'interact' });
  for (let guard = 0; g.bots.signs.size > 0; guard++) {
    assert.ok(guard < 10);
    const s = [...g.bots.signs.values()][0];
    moveTo(g, 'p1', s.p);
    g.onMessage('p1', { t: 'interact' });
  }
  advance(g, 5); // echoes rally (full supers for the pull)
  moveTo(g, 'p1', [0, 0, 1]);
  for (let i = 0; i < 400 && g.enc.st === 'LOBBY'; i++) g.tick(0.05);
  assert.equal(g.enc.st, 'MECH');
  god(g);

  // round-1 sigil dance, echoes fighting alongside
  advance(g, ENC.firstKeeperDelay + 1.2);
  assert.equal(g.enc.stage, 'KEEPERS');
  const sig = g.enc.sigil;
  sig.codes = [maskOf([0, 1, 2]), maskOf([6, 7, 8])];
  for (const i of [0, 1, 2, 6, 7, 8]) g.onMessage('p1', { t: 'sigil', i });
  advance(g, ENC.sigil.strikeDelay + 0.3);
  assert.equal(g.enc.stage, 'HUNT', 'both wards broken with echoes in the field');
  for (const id of [...g.enc.keeperIds]) if (id) slay(g, id);
  const herald = keepersOf(g)[0];
  assert.ok(herald && herald.sky, 'the herald rises');
  const ped = ARENA.pedestals[herald.color];
  moveTo(g, 'p1', [ped.p[0], 0, ped.p[2]]);
  advance(g, 0.3); // kindle the wardbreaker
  for (let guard = 0; g.enemies.has(herald.id); guard++) {
    assert.ok(guard < 300, 'herald ward falls');
    g.onMessage('p1', { t: 'hit', target: herald.id, dmg: 200, weapon: 'sniper' });
    advance(g, 0.05);
  }
  advance(g, ENC.sigil.missileFall + 0.3);
  assert.equal(g.enc.st, 'DAMAGE', 'lance impact with the circle intact');

  // the echoes burn the boss on their own (supers were rallied full)
  const botDmg = () => [...g.players.values()].filter(p => p.bot)
    .reduce((s, p) => s + p.stats.bossDmg, 0);
  advance(g, 10);
  assert.ok(botDmg() > 2000, `echoes burn the boss unaided (got ${Math.round(botDmg())})`);

  // ride the phase out through obliteration into round 2
  while (g.enc.st === 'DAMAGE') advance(g, 0.25);
  assert.equal(g.enc.st, 'OBLIT');
  advance(g, ENC.oblitWarn + 0.3);
  assert.equal(g.enc.st, 'MECH');
  assert.equal(g.enc.round, 2);

  // cheat to the final stand, survive the surge, kill it
  g.enc.bossHp = g.enc.bossMax * ENC.finalFrac + 400;
  g.enterDamage();
  for (let i = 0; i < 3; i++) g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  assert.equal(g.enc.st, 'FINAL');
  advance(g, ENC.surgeDur + 1);
  assert.ok(!g.enc.shield, 'the generator died with the echoes still standing');
  for (let guard = 0; g.enc.bossHp > 0; guard++) {
    assert.ok(guard < 2000);
    g.onMessage('p1', { t: 'hit', target: 'boss', dmg: 200, weapon: 'sniper' });
  }
  assert.equal(g.enc.st, 'VICTORY');
  const stats = msgs.findLast(x => x.m.t === 'bossDied').m.stats;
  assert.equal(stats.length, MAX_PLAYERS, 'the scoreboard seats all six');
  const contributors = [...g.players.values()].filter(p => p.bot && p.stats.bossDmg > 0).length;
  assert.ok(contributors >= 4, `nearly every echo wounded the boss (got ${contributors})`);
  advance(g, 2); // victory loiter ticks clean
  ok('full clear with five echoes: mechanics, burn, obliteration, surge, victory');
}

console.log('\nAll encounter tests passed.');
