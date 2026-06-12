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
bash bundle/make-bundle.sh         # zero-install Windows zip (portable Node + cloudflared) → dist/
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
behind `pendingNova` set by a validated `superCast`, and rate-limits `explode` kinds. `hit`/`explode`
are accepted from DOWNED (not dead) players on purpose: the client gates new fire input on alive,
so anything arriving while downed is ordnance launched before the fall (grenade arcs, the thrown
nova, swarm shards) — going down must not void it mid-flight (regression-tested). Any new
damage path needs a cap or validation server-side, and ideally a test like the existing
"anti-cheat caps & nova gating" block. The Nova detonation also looses 20 thrower-client homing
shards (`SUPER.nova.swarm`, the wolfpack/swarm machinery in weapons.js) landing as ordinary
capped `nswarm` hits — the budget rationale is commented on `SUPER.nova`. Damage falloff is client-side: a weapon with
`WEAPONS[k].falloff {start, min}` (currently shotgun only) scales hitscan damage in `fireHitscan`
from full inside `start` m linearly down to `min`× at `range`; its `DMG_CAPS` entry covers the
point-blank maximum.

Knockback is client-computed where an FX broadcast allows it: the `bossSlam`/`seekerBoom`
handlers in main.js shove the local player from their own live position (the server's view is an
RTT stale) using the shared `kb` tuning (`ENC.slamKb`, `ENEMIES.*.kb`); the `hurt` message's
`imp` is applied as an impulse only for sources without such an event (husk melee) and otherwise
only aims the hurt-pan. The boss hovers visibly dormant all LOBBY (`ENC.wakeDrop.drop` m above
`bossPos` — client-cosmetic, the server's boss never moves; boss bar hidden, `applyBossDamage`
LOBBY-gated, lobby shots read IMMUNE off `enc.shield`); `bossWake` starts a `wakeDrop.dur` s
ease-in descent (`EnemyManager.wake`), and touchdown (`enemies.onBossSlam` in main.js) fires the
harmless cinematic shockwave (`player.blast`, tuned by `ENC.wakeShove`): a lift plus a sustained
outward wind, because the air blend bleeds velocity too fast for any one-shot impulse to carry a
player from the plate to the arena edge (it bypasses the impulse budget — it's scripted, not a
clumped hurt). Two client-side burst clamps tame TCP clumping at high ping (several
messages landing in one frame): `player.impulse` budgets the per-frame summed shove
(`PLAYER.kbFrameCap`) and `effects.shake` budgets per-frame growth.

**Super cast flourish** (`SUPER.cast` in shared/constants.js): a validated `superCast` sets
`p.castUntil = t + cast.dur` and `dmgPlayer` applies `cast.dr` damage resistance inside the
window — the client roots the caster for the whole flourish, so it must not be a free kill.
Golden's `goldenUntil` counts from the END of the window (the client can't fire during it).
Client side: `player.startSuperCine` pulls the camera out third-person Destiny-style (movement,
look, jump and all weapon input gate on `player.cineActive`; viewmodel hidden; both camera-path
endpoints blend to the exact first-person pose so there is never a cut; velocity zeroes and
gravity/wind/shoves pause, so an airborne caster hangs where the cast caught them), `selfBody`
in main.js
(a name-tag-less `buildGuardian`, rebuilt per deploy since class can change) stands in for the
local player, `effects.superFlare` (pooled class-colored pillar + burst ring, no lights) plays
for caster and remotes alike, and the payoff — nova thrown from the BODY position, sfx, shake —
lands at `cast.apex` via `weapons.pendingSuper`. Remote clients delay their cosmetic nova/sfx by
the same apex so the throw timing matches everywhere (safe: casters are rooted, so the cast-time
position stays true).

Grenades are per-class (`GRENADE` in shared/constants.js, which also documents the per-class
damage budget); the server resolves `explode {kind:'grenade'}` dmg/r from `p.cls`, and everything
is class-colored client-side (the remote `pf`/`explosion` renders look the thrower's class up in
the snapshot). Payloads: **gunslinger** — four client-side homing embers (`spawnSwarm` in
weapons.js, wolfpack machinery) landing as ordinary `hit`s with weapon `gswarm`; **voidcaller** —
a server-side DoT zone (`game.dots`; broadcast `voidOrb {p, r, dur}` drives the client FX, and
the thrower's client mirrors the ticks as predicted damage numbers); **sentinel** — two
server-simulated mend-orbs (snapshot `projs` kind `heal`) that chase the lowest-HP guardians and
broadcast `healBurst {id, p, amt}` on contact.
`tickProjectiles`/`tickDots` run in every state — mend-orbs must fly even in LOBBY.

Protocol: JSON over one ws connection. Snapshots broadcast at 10 Hz (`broadcastSnapshot`); clients
interpolate remote entities through `Interp` (`enemies.js`): a small sample buffer stamped with
SERVER time (`snap.now` — never arrival time: TCP clumps at high ping warp an arrival-based
timebase into visible backward snaps), rendered behind the de-jittered `netClock` in `main.js`
(fastest-arrival offset anchor + clump-spread-adaptive delay, 130–500 ms, played out through an
elastic ≤±15%-slew clock so a TCP loss-stall resolves as a brief glide, not a teleport) and never
extrapolated past the newest sample. Snapshot projectiles dead-reckon their deterministic paths on
the same server clock at zero delay (`sNow`, also the grab-arc replay clock — anything compared
against `renderTime`/`sNow` must be server-stamped, never arrival-stamped; mixing the epochs
shipped a sweep-beam bug once). One-shot events
(`pf` fire relay, `explosion`, `super`, `sweep`, `bossFocus`, `capsule`, `keyGet` (broadcast
`{id, kid}` — every client clears the floor key instantly; chime/tip only when `id` is you), `wellWake`,
`sigilNode`, `sigilMatch`, `sigilBlast`, `latticeGrab` (`{at, dur, seed, a0, a1}` — clients replay
the same seeded panel-drag arc from server time), `heraldRise`, `wardBuff` (private), `wardBlast`,
`wormhole`, `missile`, `seekers`, `seekerBoom`, `voidOrb`, `healBurst`, `banner`, `restock` (private), …) are separate
messages; a broadcast with `exclude: playerId` skips the sender (stripped in `server/main.js`).
Client→server: `state`, `fire`, `hit`, `explode`, `superCast`, `interact`, `loadout`, and
`sigil {i}` (toggle sky-lattice node i; validated st/stage/index server-side). Snapshot player
fields are abbreviated: `p` pos, `dn` downed, `dd` dead, `gu` goldenUntil, `av` antiviral stacks,
`ky` holds auric key, `wb` wardbreaker-buff end, `rv/rt` revive end/target, `sup` super %. `enc.focus` is the hard-focused
player id (DAMAGE only) and `enc.bossYaw` is the server-owned boss facing (clients lerp to it —
every client must see the same back side); `enc.stage` is the MECH sub-stage, `enc.wh/mAt` the
wormhole flag and missile-impact time, `enc.sg` the generator-surge end time (the HUD's
translucent boss-bar ward panel shows full while ordinarily shielded and drains right-to-left
toward `sg` during the surge), and `enc.sig` the round's sigil layout (`c` colors, `o`
pillar owners, `s` pillar segments, `g` 9-bit lattice mask, `m` matched flags, `ga` the panel's
resting sky-ring angle). `enc.sweep`
carries `a1/a2/w1/w2/on` — the constant angular velocities let the client extrapolate the beam
angles per frame from the server-time base (`encAt = snap.now`), so the beams glide instead of
stepping at 10 Hz. Standing pillars are hard sweep cover: `tickSweep` skips players shadowed by
`losBlocked` from the arena center, and the client renders each beam line as two center-anchored
rays whose `scale.x` clips at the first standing pillar (`rayClip` in enemies.js) so the shelter
reads. `enc.pd` (pillarsDown, set by `enterFinal`, cleared by `resetWorld`) crumbles them:
`losBlocked` goes inert (sweep cover AND sniper LOS), `world.update` sinks the pillar meshes
(staggered, raycast noop'd while down — raycasts ignore visibility — and `collidePlayer`'s
pillar pass gated off), all restored declaratively when `pd` drops at reset. Keeper enemies
carry `cl` (pedestal-color index) and `sh` (warded); the herald adds `shp/smh` (ward HP/max —
the client keeper bar shows the ward in ward-color while it holds); ground keepers (SNIPERS —
see `ENEMIES.keeper.snipe`) add `aim` (tracked prey id — the client beam follows that player's
live position) and, while locked, `lk`/`ft` (frozen kill-point + fire time); the instant shot is
the one-shot `snipe {id, p, hit}` broadcast (railgun tracer + crack; the victim's `hurt` has
src `snipe`). `caps` (with `land`
server-time) and `keys`
are id-keyed pickup lists like `bricks`; `banner` is a one-off object like `chest`. Timers in
snapshots are absolute server seconds; the client keeps `serverOffset` from `snap.now`.

The `bossDied` and `wipe` events carry a per-player `stats` scoreboard — `{name, cls, kills, dmg,
keepers}`, sorted by boss damage server-side — rendered by `hud.endScreen(kind, stats)`.
`applyBossDamage` credits only damage that actually lands (nothing while shielded, no overkill
past 0); `startEncounter` resets the board.

Player-facing text (toasts/announcements) is flavor-first AND terse, by explicit user
preference: hint through fiction ("the blisters quiver"), never bare instructions ("shoot the
blisters"), and keep each message to ~2–4 words (names/colors/numbers don't count). Never fire
a server toast and a client announce for the same event — events with a client-side announce
(bossWake, bossFocus, sweep, barrage, sigilMatch, heraldRise, wormhole, bossDied, state
changes) get no server toast. Status readouts (lock names, code counts, timers) stay.

### Encounter state machine (server)

`LOBBY → MECH (sigil mechanic, below) → DAMAGE (25s) → OBLIT → MECH round+1 … → FINAL (≤25% HP,
notched on the boss bar) → VICTORY | WIPE`.

**Phase-entry hygiene**: every phase entry (`enterMech/Damage/Oblit/Final`, `victory`,
`startWipe`) routes through `clearPhaseFx()`, which kills `sweep`/`barrageUntil`, the MECH
`stage`, pending strikes, and the wormhole (`enterDamage` alone keeps the wormhole — it hangs
open through the phase and seals at the next entry). Put any new cross-phase boss state in that
helper, not in the individual entries; the "phase entries clear running specials" test asserts
no leaks. The viral counterpart is `endViralPhase()`: clears focus/capsules/stacks (and keys,
unless called from `enterOblit`, where keys stay usable through the warning).

LOBBY has the **rally banner** (`ENC.banner`): one `interact` on the white circle plants it,
then each guardian's `interact` within `restockR` earns ONE private `restock` (`p.restocked`) —
the server fills the super gauge (`sup` is server-owned); mags/reserves/cooldowns refill
client-side (`WeaponSystem.restock()`, prompt gated by `bannerRallied` in `main.js`). All
LOBBY-gated server-side; the banner dies with `resetWorld`.

MECH runs the **sky-sigil mechanic** through `enc.stage`: `null` (keepers stirring) → `KEEPERS`
→ `HUNT` → `FINAL` → `MISSILE`. `rollSigil()` (shared/sigil.js) deals the pedestal colors out as
[twin A, twin B, herald] and gives each of the six pillars one lattice segment; the twin codes
are guaranteed distinct and match order-free. Two warded Keepers spawn (`e.shielded` — immune in
`onHit`/`onExplode`); shooting lattice stars sends `sigil {i}`, and an exact code match schedules
a **lattice strike** (`enc.strikes` → `fireStrikes`): the ward breaks at the blast, which also
one-shots UNwarded enemies within `strikeR` (the struck keeper itself is excluded — its ward
soaked it). `sigilMatch` carries `code`+`kid` so the client FX and the server blast share the
same `strikeDelay` clock. The `KEEPERS → HUNT` flip waits for the SECOND strike to land
(`fireStrikes`, not the match itself) — the stage change is what hides the panel client-side,
and it must stay in the sky while it channels the laser; during that window the spent lattice
ignores `sigil` toggles and panel-grabs. While stage is `KEEPERS` the boss periodically **grabs the panel** and
hurls it around the 55 m sky-ring (`fireGrab`; tuning + design rationale commented in
`ENC.sigil`): position is cosmetic to the server, so the `latticeGrab {at, dur, seed, a0, a1}`
broadcast lets every client replay the identical seeded arc off server time (`world.update`;
snapshot `sig.ga` re-homes late/lossy clients). Both twins dead → the warded herald (`e.sky`)
rises: its ward is a deliberately weak destructible shield (`e.shieldHp`) that only
wardbreaker-blessed fire wounds (stand within `pedestalR` of *its* color's pedestal for
`p.wardUntil`); at zero, `blastWard` detonates ward and herald together — the herald is never
damaged directly. Herald dead → wormhole (`enc.wh`) → `missileFall` s later the lance impact
calls `enterDamage`. `enc.keeperIds` is slot-aligned with `sig.codes` — null dead slots, never
compact.

DAMAGE runs the **viral mechanic**: the boss hard-focuses one player (`enc.focus`, re-picked if
they fall; volleys and seeker salvos converge on them) and chains its round-unlocked specials
hasted. Capsules rain (`caps`, pickable once landed); 3 stacks (`p.antiviral`) let that player
burst the back-mounted blisters (checked in `onHit`/`onExplode` — one splash can burst several);
a burst blister flings an auric key (`keys`); the key-holder wakes a refuge well at an intact
pedestal (DAMAGE/OBLIT only). Wells do NOT auto-spawn at OBLIT: only key-woken wells shelter the
otherwise-lethal blast (`oblitDmg`), and `fireOblit` burns every woken well into `enc.burned`
permanently. FINAL opens with the **generator surge** (`enc.surgeUntil`): the shield reignites
(boss immune via `applyBossDamage`'s existing `e.shield` gate), the pillars crumble
(`e.pillarsDown` — the sweep cover players learned through the rounds is gone, leaving the jump
as the only dodge; the `sweep` event's client announce hints cover only while `pd` is unset),
one sweep spins for the whole
surge (`sweep.until = surgeUntil`) and a seeker burst launches every `surgeWaveCd` — each burst
is `max(1, floor(alive/2))` waves rippling `surgeWaveGap` apart (`surgeWavesLeft/surgeWaveAt`,
cleared by `clearPhaseFx` and surge expiry), targets dealt round-robin so every guardian is
hunted (wave size never below the fireteam). Volley/special
timers are parked past `surgeUntil`, `ends` (annihilation) counts from surge end, and `tickBoss`
drops the shield on expiry and re-broadcasts `shieldBreak` (the client announces the generator
dying when its last-known phase is FINAL). After the surge, FINAL chains specials faster and
lets them overlap (sweep + barrage + volleys at once). Escalation is round-driven: round ≥2 keepers gain orbiting Wisps and the boss gains the
rhythmic barrage; round ≥3 adds the sweep-laser partition (spawning pauses while `enc.sweep` is
set during MECH). Attack design rationale (volley gap dodging, the barrage bob band, the seeker
speed window, lead-aim caps) lives as comments on the numbers in `ENC`/`ENEMIES` in
shared/constants.js — read those before retuning anything.

**Seekers** (back-launched homing missiles, active from round 1) are shootable ENEMIES
(`type: 'seeker'`) so the whole shoot-down path is free — client raycasts, `DMG_CAPS`, damage
numbers, crit nose — but deliberately NO hp bar (bars are keeper-only; it reads as ordnance).
Salvo size grows +1 per phase entry (`enc.seekerBonus`, reset only by `resetWorld`). Shot-down
seekers chain-cook nearby ones through `killEnemy`; detonations on players/terrain
(`detonateSeeker`) deliberately do NOT chain (see the comment in `killEnemy`). Seekers are
excluded from the wave add-cap count and the separation pass, and splash height checks use
their real y (like blisters — mirrored in weapons.js).

3 immune `blister` enemies ride the boss's back for the whole encounter, re-glued every
`tickBoss` from `enc.bossYaw`. The client parents blister views to the boss group — anything
reading enemy positions client-side must use `getWorldPosition` (see weapons.js wolves), and the
server splash check uses the blister's real height. `clearAdds` deliberately preserves blisters;
burst ones never regrow.

Fireteam is 1–6 (`MAX_PLAYERS`); boss HP (rolled at encounter start), keeper HP, wave sizes, and
the live-add ceiling all scale per player (knobs in `ENC`). MECH wave cadence is adaptive: each
tick the due time tightens (`Math.min`, never delays) toward `waveCdEmpty→waveCd` lerped by the
live-add fill (`addFill` in game.js), so an AoE wipe refills the arena in seconds while a near-cap
arena keeps the slow breath; the tighten clause skips timers parked past `t + waveCd` (the tests'
t+999 hush). Enemy bolts and boss volleys lead
the target: `fireProjAt`/`leadAim` aim ahead along `p.vel` (estimated from `state` messages,
teleports discarded), capped at `ENC.leadMax` seconds. Acolyte bolts corkscrew
(`ENEMIES.acolyte.helix`): a sin-tapered helix around the straight lead-aim line — zero radius at
muzzle and predicted arrival, so accuracy is untouched. The snapshot ships the curve params
(`hx {bp, bv, a, T, ph, om, r}`) and the client replays the exact parametric curve per frame
(`helixAt` in entities.js — `p + v·age` extrapolation would chord a 6 rad/s spiral at 10 Hz)
plus an analytic pooled-line trail (`trailPool`, no history buffer — the trail is the curve's
recent past); the strafe tuning lives in `ENEMIES.acolyte.strafe`. Acolyte and sky-herald shots
channel for `chargeT` s before firing (rooted; snapshot `ch` = charge end-time drives the
swelling muzzle orb in enemies.js and the throttled `onCharge` → `audio.chargeUp` whine in
main.js — effective fire interval is `fireCd + chargeT`). Ground keepers are SNIPERS
(`tickSniper`; design + numbers on `ENEMIES.keeper.snipe`): a rooted TRACK phase glues a laser
to one prey, LOCK freezes the beam on the momentum-predicted kill-point (no vertical lead — a
jump dodges), then an instant, perfectly accurate shot takes `dmgFrac` of max HP from whoever
stands within `hitR`; pillars block it (`losBlocked`), and the counterplay is breaking momentum
inside the lock window. Client: pooled beams/reticle in enemies.js (`drawLaser`, track follows
the live local position via the `playerPosOf` hook), `lockWarn` blip when the lock names you,
`snipeFlash` tracer on the broadcast. Husks counter kiting with a lunge
(`ENEMIES.husk.lunge` — speed-budget rationale commented there): inside the trigger band they
root for a windup crouch (the stop is the telegraph), then spring along a heading locked at
launch — strafe or sprint escapes, backpedal doesn't. The pounce arc is server-written `pos[1]`,
rendered straight off the snapshot — no protocol change.

Gjallarhorn is unlocked **per guardian name**, not per server: only looting the victory cache adds
the name to `game.gjallyOwners` (persisted as `{gjallyNames}` in `.unlocks.json` via
`game.onUnlock(name)`); victory alone unlocks nothing. After 30 s the encounter resets with
`{t:'reset', reason:'victory'}`, sending clients back to the selection screen (same ws connection;
class re-pick goes through the `loadout` message, weapons are purely client-side via
`WeaponSystem.setLoadout`). The same selection screen is reachable mid-LOBBY: the rebindable
`inventory` key (default TAB) calls `showLoadoutScreen(false)` — both in-game and from the pause
overlay, since unlike ESC the browser doesn't eat it under pointer lock — and the joined
`deployBtn` branch redeploys on the same connection. The snap handler's
phase-transition block yanks a lingering selection screen back to the pause overlay if the
fireteam plate-starts the raid (the open screen freezes `state` reports, so a player who escaped
while standing on the plate still counts as ready). The Gjallarhorn must stay invisible in the UI unless that name owns it
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
  idle: explosion lights (effects pool), the boss light (enemies.js), and the status-glow pool
  (`glowPool` in main.js, sized MAX_PLAYERS, created before the warm frame; EntityManager
  reserves one for the local player's own glow, the rest serve remotes — priority red boss-mark
  > golden > yellow auric key > green full antiviral, plus a scene-level `focusRing` mesh pinned
  under the marked player). Never attach a light to a transient or toggled object.
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

- **Controls are configurable** (`settings.js`): mouse sensitivity (multiplier over the 0.0023
  base) and keybinds, persisted per-origin in localStorage `sv_settings` and edited from the
  pause overlay's SETTINGS panel (markup in index.html, wiring in main.js). Never hardcode an
  `e.code` for a player action — look it up via `code(action)` per event (player.js movement/jump,
  weapons.js slots/abilities, main.js interact + inventory, hud.js help). Only ESC is `RESERVED`
  (capture cancel) and can't be bound. Mutations fire a `'sv-settings'` window event;
  `renderBindHints()` in main.js re-renders every bind-dependent hint string (lobby controlsHint,
  HUD abilityHints/helpHint, the H overlay) — new hint text that names a key must go through it.

- **Coplanar/overlay geometry**: the floor grid is vertex-colored strips (bright centerline
  fading to black edges — the gradient IS the glow) rendered with **additive blending +
  `depthWrite: false`** so crossing lines sum instead of z-fighting, plus `polygonOffset` vs the
  floor (a few cm of height has no depth precision at 30 m with a 0.05 near plane). Never stack
  coplanar glow/core quads. Also: don't texture large floors — at 76 m even 2048px is ~27
  texels/m and reads blurry up close; use geometry.
- Glowing set dressing must stay **dimmer than gameplay objects** (projectiles, pickups) — the
  floor grid has a single `BRIGHT` knob in `buildFloorGrid`.
- **Boot loading veil**: `#loadScreen` (static HTML in index.html, z-index 100) covers the window
  where the lobby is visible but inert (module fetch/parse + the warmup frame). Its spinner is
  transform/opacity-only CSS so the compositor animates it while module evaluation blocks the main
  thread. The release block at the bottom of `main.js` lifts it after the first live frame and a
  1.4 s minimum hold; an inline fallback script swaps the status text if it's still up at 15 s
  (module graph died).
- **Snapshot-driven UI values step at 10 Hz** — bridge them with a CSS `transition` on the bar
  fill (ready bar `.12s linear`, boss bar `.25s`) instead of per-frame JS smoothing. Client-side
  timers (super ring, revive channel) don't need it.
- **Weapon recoil is pattern-driven**: `WEAPONS[key].recoil` (shared/constants.js) is a per-shot
  list of `[up, right]` steps in multiples of `kick`; `WeaponSystem.applyRecoil` walks it (index
  resets on a fire pause or weapon switch; past the end it holds the last step + horizontal
  wander) and feeds `player.kick(p, y)` — a two-stage camera offset in player.js (kick raises a
  target the camera chases; the target eases back to zero), so sustained fire visibly climbs the
  pattern. Recoil tilts the camera (and thus `aimDir`) but is client-feel only — the server never
  sees it.
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
- **Enemy spawn-in is purely client-side**, driven by the view's `bornAt` in `EnemyManager.update`:
  adds squeeze out of the gate portal (height-leads-girth scale-in), ground keepers slam down from
  the sky (`KEEPER_DROP`, exported) under a pedestal-colored `superFlare` whose ring bursts at the
  touchdown (`onSpawn`/`onKeeperLand` hooks in main.js). Seekers, blisters (own swell), and the
  sky herald (heraldRise) skip it. The flare pool is sized 6 because keeper drops share it with
  super casts.
- The camera roll must stay zeroed (`player.js` sets rotation with explicit `z = 0`); the lobby
  showcase/orbit cameras leave roll behind otherwise (the warmup block restores it explicitly).
- Adaptive resolution (`perfTick` in `main.js`) owns `renderer.setPixelRatio` — don't set it elsewhere.
- All SFX and the adaptive music are synthesized in `audio.js` (no asset files). Music modes:
  `tense` (per-round industrial brood), `heroic`/`final` (damage phases: electronic metal —
  detuned saws → tanh waveshaper power chords, kick-driven sidechain `duck` gain on the melodic
  bus, gated sub; percussion bypasses the duck). AudioContext starts on the deploy click. Event foley lives in `main.js`: net handlers (per-type `enemyDie` with `volAt`
  distance attenuation, capsule drop/land tracking via `capsTracked`, `seekerLaunch` salvo whoosh
  capped at 4 staggered shots, distance-attenuated `seekerBoom`) plus a render-loop block
  (footsteps/jump/land off `player.onGround`/`vel`, low-HP heartbeat, OBLIT/FINAL countdown
  ticks, and `audio.seekerWhine` — ONE persistent loop node, gain 0 when idle, fed the nearest
  live seeker's closeness + stereo pan every frame and explicitly zeroed when the lobby shows);
  `EnemyManager.onSpawn` is the throttled spawn-blip hook. `audio.hurt(dmg, src, pan)`
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
