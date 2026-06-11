# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Keep this file up to date**: when you add/remove modules, change the netcode protocol, alter the
encounter state machine, or add weapons/mechanics, update the relevant section here in the same task.

## Commands

```bash
npm start            # run the raid server → http://localhost:3000
npm run web          # same, plus a public tunnel link (cloudflared if installed, else localtunnel)
npm test             # headless simulation of the full encounter (fast, no browser, no sockets)
npm run smoke        # boots the real server + a WebSocket bot through join/encounter-start
SMOKE_URL=https://some-tunnel.example npm run smoke   # run the smoke bot against a live/tunneled server
node --check public/js/<file>.js   # syntax-check client files (there is no bundler or linter)
```

There is no build step: the browser loads ES modules directly. Three.js is vendored from
`node_modules` via the `/vendor/three.module.js` route; `shared/` is served to the browser and
imported by the Node server — it is the single source of truth for all tuning numbers.

The client cannot be exercised by the test suite. After client changes, syntax-check the files and
ask the user to playtest; after server/shared changes, extend `test/encounter.test.js`.

## Architecture

Three layers:

- `server/game.js` — the authoritative game: encounter state machine, enemy AI, boss attacks,
  projectiles, player HP/revives/supers, the sigil mechanic, anti-cheat caps. **Deterministic by
  design**: (`shared/sigil.js` holds the pure 3x3-lattice logic: segment enumeration, `rollSigil`,
  code masks — imported by the server and asserted exhaustively in tests.)
  time only advances through `tick(dt)`; there is no `Date.now()` inside game logic. This is what
  lets `test/encounter.test.js` simulate entire raids in milliseconds with a fake clock — preserve
  this property.
- `server/main.js` — http static serving + ws wiring + 20 Hz tick loop + `/api/unlocks` +
  `.unlocks.json` persistence. `server/web.js` layers a public tunnel on top.
- `public/js/` — Three.js FPS client. `main.js` is the glue (lobby/loadout UI, net event routing,
  render loop, the selection-screen 3D showcase). The local player's movement physics is entirely
  client-side (`player.js`); the server just receives position reports.

### Trust & networking model (PvE-trust)

Hit detection is client-side: the client raycasts and sends `hit {target, dmg, weapon}`. The server
applies it but clamps via `DMG_CAPS` (per trigger-pull; golden multiplies the cap), gates Nova
behind `pendingNova` set by a validated `superCast`, and rate-limits `explode` kinds. Any new
damage path needs a cap or validation server-side, and ideally a test like the existing
"anti-cheat caps & nova gating" block.

Protocol: JSON over one ws connection. Snapshots broadcast at 10 Hz (`broadcastSnapshot`); clients
interpolate remote entities ~130 ms behind arrival time (`Interp` in `enemies.js`). One-shot events
(`pf` fire relay, `explosion`, `super`, `sweep`, `bossFocus`, `capsule`, `keyGet`, `wellWake`,
`sigilNode`, `sigilMatch`, `sigilBlast`, `heraldRise`, `wardBuff` (private), `wardBlast`,
`wormhole`, `missile`, `seekers`, `seekerBoom`, …) are separate
messages; a broadcast with `exclude: playerId` skips the sender (stripped in `server/main.js`).
Client→server: `state`, `fire`, `hit`, `explode`, `superCast`, `interact`, `loadout`, and
`sigil {i}` (toggle sky-lattice node i; validated st/stage/index server-side). Snapshot player
fields are abbreviated: `p` pos, `dn` downed, `dd` dead, `gu` goldenUntil, `av` antiviral stacks,
`ky` holds auric key, `wb` wardbreaker-buff end, `rv/rt` revive end/target, `sup` super %. `enc.focus` is the hard-focused
player id (DAMAGE only) and `enc.bossYaw` is the server-owned boss facing (clients lerp to it —
every client must see the same back side); `enc.stage` is the MECH sub-stage, `enc.wh/mAt` the
wormhole flag and missile-impact time, and `enc.sig` the round's sigil layout (`c` colors, `o`
pillar owners, `s` pillar segments, `g` 9-bit lattice mask, `m` matched flags). Keeper enemies
carry `cl` (pedestal-color index) and `sh` (warded); the herald adds `shp/smh` (ward HP/max —
the client keeper bar shows the ward in ward-color while it holds). `caps` (with `land`
server-time) and `keys`
are id-keyed pickup lists like `bricks`. Timers in snapshots are absolute server seconds; the
client keeps `serverOffset` from `snap.now`.

Player-facing text (toasts/announcements) is flavor-first by explicit user preference: hint
through fiction ("the blisters quiver"), never bare instructions ("shoot the blisters"). Status
readouts (lock names, code counts, timers) stay.

### Encounter state machine (server)

`LOBBY → MECH (sigil mechanic, below) → DAMAGE (25s) → OBLIT → MECH round+1 … → FINAL (≤25% HP,
notched on the boss bar) → VICTORY | WIPE`. MECH runs the **sky-sigil mechanic** through
`enc.stage`: `null` (keepers stirring, `firstKeeperDelay`) → `KEEPERS` → `HUNT` → `FINAL` →
`MISSILE`. Each round `rollSigil()` deals the three pedestal colors out as [twin A, twin B,
herald] and splits the six pillars 3/3 between the twins, each pillar showing one straight 2-3
node segment of the 3x3 sky lattice on its outward panel. Two warded (immune — `e.shielded`
checked in `onHit`/`onExplode`) color-coded Keepers spawn together from different gates; shooting
lattice stars toggles them (`sigil {i}`), and when the lit set exactly equals a twin's overlaid
code the lattice resets, the matcher earns `SUPER.perSigil`, and a **lattice strike** is
scheduled (`enc.strikes`, fires `strikeDelay` later in `fireStrikes`): the ward breaks at the
blast, which also deals `strikeDmg` to every UNwarded enemy within `strikeR` of the keeper
(one-shots the other twin only if its ward is already down; the struck keeper itself is excluded
— its ward soaked the blast). `sigilMatch` carries `code`+`kid` so the client can run the
matching FX (stars beam into a focal dot in front of the lattice, the dot lasers the keeper,
`sigilBlast` lands as the boom — same `strikeDelay` clock on both ends). The codes are
guaranteed distinct and match order-free. Both twins dead → the warded herald (`e.sky`, hovers at
`ENC.sigil.finalPos`) rises above the boss. Its ward is a destructible shield (`e.shieldHp`,
deliberately weak: `sigil.shieldHp + shieldPerPlayer×(n−1)`) that only wardbreaker-blessed fire
can wound: standing within `ENC.sigil.pedestalR` of *its* color's pedestal grants `p.wardUntil`
(`wardBuffDur`, refreshed while standing, travels with you). The herald itself is never damaged
directly — when the ward's HP hits zero, `blastWard` detonates it and kills the herald
(`wardBlast` broadcast → nova boom client-side). Herald dead → wormhole
opens (`enc.wh`), and `missileFall` seconds later the lance impact broadcasts `missile` (blue
flash + nova boom client-side) and calls `enterDamage` (which `clearAdds()`s). The wormhole stays
open through DAMAGE — antiviral capsules visually fall from it — and seals at `enterOblit` (and
in every other phase-entry/wipe path, same hygiene as `sweep`/`barrageUntil`). `enc.keeperIds` is
slot-aligned with `sig.codes` — null dead slots, never compact. Fireteam is 1–6 (`MAX_PLAYERS`).
Per-player
scaling: boss HP (`bossBase + bossPerPlayer×(n−1)`, rolled at encounter start), keeper HP,
wave sizes (2n husks + n acolytes per wave, round-padded, per-player caps), and the live-add
ceiling (`addCapBase + addCapPer×n`). Enemy bolts and boss volleys lead the target: the server
estimates each player's horizontal velocity from `state` messages (`p.vel`, teleports
discarded) and `leadAim` aims `ENC.leadFactor` of the flight time ahead, capped at
`ENC.leadMax` seconds — uncapped, slow projectiles aimed seconds ahead, which looked like
firing perpendicular to the player. Volley dodge design: `volleySpeed` 22 is deliberately too
fast to outrun — you dodge by standing in the gaps between the three orbs, and `volleySpread`
0.2 keeps those gaps standable at range (~1.4 m corridor at 25 m, closing to zero up close,
given the 1.8 m combined hit radius). Volley cadence tightens per phase
(`volleyCdMech/Dmg/Final` 5/3/2 s) so round-1 DPS still pressures the marked player.

**Seekers** (back-launched homing missiles) are the boss's other basic attack, active from round
1: every `seekerCd` during MECH/DAMAGE/FINAL, `launchSeekers` fans a salvo off the boss's back
(`seekerBase` 2, +1 per phase entry via `enc.seekerBonus` — bumped in `enterMech` round>1,
`enterDamage`, `enterFinal`; reset only by `resetWorld`). They are ENEMIES (`type: 'seeker'`, hp
90) so the whole shoot-down path is free: client raycast hits, `DMG_CAPS`, damage numbers, crit
warhead nose — but deliberately NO hp bar (bars are keeper-only; it reads as ordnance). Each
missile climbs a `seekerPop` launch arc, then `tickSeeker` homes on its assigned player's chest
with perfect accuracy at `speed` 6.5 (< walk — kitable, so `seekerLife` expires stragglers).
Detonation (`detonateSeeker` → `seekerBoom` broadcast: reached ANY player within 1 m, pillar,
arena wall, floor, or expiry) splashes `dmg` in `blastR`; shot-down seekers go through `killEnemy`
(normal `enemyDied`, no blast, no ammo drops). Seekers are excluded from the wave add-cap count
and the separation pass, and splash height checks use their real y (like blisters — mirrored in
weapons.js). Client: `buildSeeker` view orients along the interp flight delta (yaw alone can't
pitch); the toast fires once per encounter (`enc.seekerSeen`).

3 immune `blister` enemies ride the boss's back for the whole encounter: spawned at
`startEncounter` on `ENC.blisterMounts`, re-glued every `tickBoss` from `enc.bossYaw` (the boss
turns toward the focus during DAMAGE, else the nearest player). The client parents blister views
to the boss group — anything reading enemy positions client-side must use `getWorldPosition`
(see weapons.js wolves), and the server splash check uses the blister's real height. `clearAdds`
deliberately preserves blisters; burst ones never regrow.

DAMAGE runs the viral mechanic: the boss hard-focuses a random player (`enc.focus`, re-picked if
they fall, volleys aim at them) and chains its round-unlocked specials hasted ×1.3
(`dmgSpecialCd`). 2 capsules rain every 5 s (`caps`, pickable once landed); 3 capsule stacks
(`p.antiviral`) let that player damage blisters (checked in `onHit`/`onExplode` — one splash can
burst several). A burst blister flings an auric key (`keys`) outward; the key-holder (`p.hasKey`)
wakes a refuge well by walking to an intact pedestal (DAMAGE/OBLIT only). Wells NO LONGER
auto-spawn at OBLIT — only key-woken wells shelter, the blast is lethal to anyone unsheltered
(`oblitDmg` 9999; `fireOblit` early-returns if that wiped everyone), and `fireOblit` burns every
woken well into `enc.burned` permanently (the client drops that pedestal's crystal to the floor).
FINAL chains specials ×1.5 on `finalSpecialCd` and lets them overlap (sweep + barrage + volleys
at once). Escalation is round-driven: round ≥2 keepers spawn orbiting Wisps and the boss gains
the rhythmic barrage; round ≥3 adds the sweep-laser arena partition (spawning pauses while
`enc.sweep` is set during MECH).
Phase-entry methods (`enterDamage`, `enterOblit`, `enterFinal`, `victory`, `startWipe`) must clear
`sweep`/`barrageUntil` — bugs here leak boss specials across phases. The same applies to the viral
mechanic: `endViralPhase()` clears focus/capsules/stacks (and keys, unless called from
`enterOblit` where keys stay usable through the warning).

Gjallarhorn is unlocked **per guardian name**, not per server: only looting the victory cache adds
the name to `game.gjallyOwners` (persisted as `{gjallyNames}` in `.unlocks.json` via
`game.onUnlock(name)`); victory alone unlocks nothing. After 30 s the encounter resets with
`{t:'reset', reason:'victory'}`, sending clients back to the selection screen (same ws connection;
class re-pick goes through the `loadout` message, weapons are purely client-side via
`WeaponSystem.setLoadout`). The Gjallarhorn must stay invisible in the UI unless that name owns it
(lobby learns it from `/api/unlocks?name=`, the private `unlock` event, or the `welcome` message's
`gj` flag — there is no global snapshot flag).

### Performance playbook (hard-won — read before adding any client effect)

Two diagnostic heuristics that found every lag spike so far:

- **"Laggy exactly once, then permanently smooth (any batch size)" = a lazily-populated cache
  the warmup missed.** Caches found this way, all now pre-paid by the boot warmup block in
  `main.js` + `effects.warmup()`: geometry buffer uploads, shader programs, sprite texture
  uploads, and **font glyph rasters** (per glyph+size — warming "888" still left nine digits
  cold; the warmup must cycle the full glyph set through both font sizes). The warmup must
  actually DRAW everything: `frustumCulled = false` on the warm group (a culled warmup uploads
  nothing — this bug shipped once), boss + beams made visible for that one frame, then
  `renderer.compile()` for the invisible pools.
- **"Smooth for one, hitch for a group" = a same-frame burst that serializes.** Found: N canvas
  texture uploads in one frame (GPU pipeline stalls — hence damage numbers are queued, ≤3
  painted/uploaded per frame via `numQueue`), N `shadowBlur` text rasters (~ms each on CPU —
  banned; use `strokeText` outlines), N pooled explosion PointLights at once (per-fragment
  lighting cost spikes even at constant light count — hence `kind === 'death'` booms are
  flash-only, `b.lit = false`), and N stacked one-shot sounds (death sfx throttled to 1/60 ms,
  blisters exempt; a soft-knee compressor on the audio master stops clipping crackle).

Standing rules derived from the above:

- **The light count must never change after boot — and "count" means lights three.js actually
  collects.** A light under an *invisible ancestor* is dropped from the light state, so
  parenting a light to anything visibility-toggled (pooled boom meshes, the boss group,
  guardian groups) changes the count when that object shows/hides → every lit shader
  recompiles (~200 ms per new light-count, then masked by the driver's shader cache — which is
  why it presents as a "first time only" hitch; profiler signature: all `render`, zero JS).
  All dynamic lights therefore live DIRECTLY in the scene, always visible, intensity 0 when
  idle: explosion lights (effects pool), the boss light (enemies.js), and the golden-glow pool
  (`glowPool` in main.js, sized MAX_PLAYERS, created before the warm frame). Never attach a
  light to a transient or toggled object.
- **Never allocate geometries/materials per spawned instance.** Everything that churns draws
  from module-level shared singletons (`GEO`/`MAT` in `enemies.js`, the constants atop
  `entities.js`, `PROJ_GEO`/`WOLF_GEO` in `weapons.js`, `G_GEO` for guardians). Clone a shared
  material only when a property animates per instance (capsule beams, revive beacons).
- If a hitch survives all of the above, stop deducing and measure: the loop has a built-in
  spike profiler — any frame gap >50 ms logs a `[spike]` console line attributing the previous
  frame (per-stage ms: world/enemies/effects/proj/sim/render, ws-handler ms between frames, JS
  heap delta where a big negative Δ = a GC pass). Ask the player for that line, or capture a
  DevTools performance trace.

### Client invariants

- **Coplanar/overlay geometry**: the floor grid is vertex-colored strips (bright centerline
  fading to black edges — the gradient IS the glow) rendered with **additive blending +
  `depthWrite: false`** so crossing lines sum instead of z-fighting, plus `polygonOffset` vs the
  floor (a few cm of height has no depth precision at 30 m with a 0.05 near plane). Never stack
  coplanar glow/core quads. Also: don't texture large floors — at 76 m even 2048px is ~27
  texels/m and reads blurry up close; use geometry.
- Glowing set dressing must stay **dimmer than gameplay objects** (projectiles, pickups) — the
  floor grid has a single `BRIGHT` knob in `buildFloorGrid`.
- **Snapshot-driven UI values step at 10 Hz** — bridge them with a CSS `transition` on the bar
  fill (ready bar `.12s linear`, boss bar `.25s`) instead of per-frame JS smoothing. Client-side
  timers (super ring, revive channel) don't need it.
- Raycast targets live in the shared `targets` array (world colliders + enemy roots + boss
  body/core). Decorative meshes either stay out of `targets` or get `raycast = () => {}` (`noRay`).
  Hit entities resolve by walking up to `userData.ent`; crit zones are meshes with
  `userData.crit = true`.
- The sky sigil lattice (`buildSigilLattice` in world.js) is **vertical** in the northern sky on
  purpose: a flat overhead grid has no canonical "top row" (it rotates with viewer heading), so
  the pillar panels could never name nodes unambiguously. Its star nodes carry
  `userData.ent = {kind:'node', i}` and sit in `targets`, but `setActive()` swaps their `raycast`
  to a noop whenever the lattice is hidden — three.js raycasts ignore visibility, and an
  invisible lattice must not eat upward shots. Weapons toggle a node once per trigger pull, never
  per pellet. The pillar code panels are holo-sockets: an additive hologram floating in a hollow
  housing, bezel tinted via the per-pillar band material. The pillar is a tapered 8-sided prism
  whose surface reaches ~1.83 at panel height and is never carved — the ENTIRE cavity (back
  plate, hologram, mouth) must sit outboard of that or the stone occludes it (this bug shipped
  once: a hologram at 1.55 was invisible behind the bulge). Real codes
  render only while `stage === 'KEEPERS'` and that color is unmatched; otherwise the holograms
  drift through random ghost segments (one canvas repaint per 0.14 s, round-robin — never a
  same-frame burst).
- The camera roll must stay zeroed (`player.js` sets rotation with explicit `z = 0`); the lobby
  showcase/orbit cameras leave roll behind otherwise (the warmup block restores it explicitly).
- Adaptive resolution (`perfTick` in `main.js`) owns `renderer.setPixelRatio` — don't set it elsewhere.
- All SFX and the adaptive music are synthesized in `audio.js` (no asset files). Music modes:
  `tense` (per-round industrial brood), `heroic`/`final` (damage phases: electronic metal —
  detuned saws → tanh waveshaper power chords, kick-driven sidechain `duck` gain on the melodic
  bus, gated sub; percussion bypasses the duck). AudioContext starts on the deploy click. Event foley lives in `main.js`: net handlers (per-type `enemyDie` with `volAt`
  distance attenuation, capsule drop/land tracking via `capsTracked`) plus a render-loop block
  (footsteps/jump/land off `player.onGround`/`vel`, low-HP heartbeat, OBLIT/FINAL countdown
  ticks); `EnemyManager.onSpawn` is the throttled spawn-blip hook. `audio.hurt(dmg, src, pan)`
  is source-flavored (laser sizzle / melee thud / void scorch / energy zap), severity-scaled
  with a sub-thump at ≥45 dmg, and stereo-panned toward the attacker when the hurt message
  carries an `imp` knockback vector; `lowHp()` fires once on crossing under 70 HP (4 s cooldown,
  tracked via `prevHp` in main.js).
- Viewmodels (`buildViewmodel`) carry `userData.muzzle` (tracer/flash origin) and `userData.flash`;
  the lobby showcase reuses these builders plus `buildGuardian` from `entities.js`.

### Testing conventions

Tests drive `Game` directly: `advance(g, seconds)` fake clock, `moveTo` position messages, and the
`god(g)` helper pins HP to 1e9 so add chip-damage can't derail state-machine assertions (regen is
gated on `hp < maxHp`, so god-mode sticks). When testing channels/timers, beware E-spam-style
resets — `onInteract` deliberately does not restart an active revive channel (regression-tested).
