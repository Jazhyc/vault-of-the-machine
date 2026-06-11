# SHATTERED VAULT

A browser-based, Destiny-style **1–6 player raid encounter**. One boss, real mechanics,
supers, three weapons, and a raid-sized fireteam of up to six — but every mechanic is tuned
to be **fully soloable**.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

Open the URL in a browser (Chrome/Edge/Firefox). For co-op, teammates on your LAN open
`http://<your-ip>:3000` — up to 6 players in one fireteam. Solo works the same way: just
deploy alone.

### Play over the internet

```bash
npm run web
```

This boots the same server and opens a **public HTTPS link** you can send to friends
anywhere — no port forwarding, no accounts. It prints something like:

```
  SHATTERED VAULT — PUBLIC FIRETEAM LINK
  https://cuddly-turkeys-refuse.loca.lt
```

Two tunnel providers are supported, tried in order:

- **cloudflared** (if installed) — cleanest: friends just open the link.
  Install: `winget install Cloudflare.cloudflared` / `brew install cloudflared` /
  [other platforms](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
- **localtunnel** (bundled npm fallback, used automatically otherwise) — friends see a
  one-time "tunnel reminder" page; the password is printed in your terminal (it's your
  public IP). After entering it once, they're in.

The host plays on `http://localhost:3000` as usual; if the tunnel drops, it reopens
automatically. The game itself is unchanged — the same authoritative server, just reachable
through a secure tunnel (the client auto-switches to `wss://` on HTTPS pages).

### Tests

`npm test` runs a headless simulation of the entire encounter (no browser needed).
`npm run smoke` boots the real server and drives a bot client through join + encounter start.
`SMOKE_URL=https://your-link.loca.lt npm run smoke` runs the same bot through a live
public tunnel — handy to confirm your internet link works before inviting friends.

## Classes & Supers (pick at deploy)

| Class | Super | Effect |
|---|---|---|
| **Voidcaller** | Nova Burst | Hurl a void singularity — 2600 AoE damage |
| **Gunslinger** | Golden Volley | 9 s of 3.5× weapon damage |
| **Sentinel** | Ward Aegis | Healing dome: 50% damage resist, heals allies, blocks Obliteration |

Super charges passively, from damage dealt, kills, and dunking charges (press **F** at 100%).

## Weapons (pick one per slot at deploy; swap with 1 / 2 / 3 or mouse wheel)

| Slot | Options |
|---|---|
| Primary (infinite) | PULSAR-7 auto rifle · DUSKFALL HC hand cannon |
| Special (green bricks) | LONGSHOT DR-9 sniper · CLOSE TALON shotgun |
| Heavy (purple bricks) | CATACLYSM RL rocket · HARBINGER MG machine gun |

Rumor has it the vault hides one more weapon — but only for guardians who personally claim
the cache after a clear. Unlocks are remembered by guardian name.

Plus a grenade (**G**), melee (**V**), aim-down-sights (**RMB** — the sniper has a real scope),
sprint, and a double jump.

## The encounter — VAULTHUR, Shattered Watcher of the Deep

1. **Start** — the whole fireteam stands on the glowing center plate for 3 s.
2. **Mechanics phase** — Vaulthur is **IMMUNE**. Adds pour from three gates. Periodically a
   **Vault Keeper** (yellow-bar) spawns and one of three **Resonance Locks** (ROSE / AZURE /
   AMBER) ignites. Kill the Keeper, grab its **Void Charge**, and dunk it at the lit Lock
   before the charge destabilizes (28 s). You move slower while carrying.
3. **Damage phase** — after **3 dunks** the shield shatters for **25 s**, and the phase is
   hectic by design: Vaulthur **marks one Guardian** (announced to the whole lobby) and turns
   to face them — volleys pour at the mark and the glowing crit core points their way, so the
   team stacks up front and hits it for crits. It also keeps chaining whatever specials its
   round has unlocked, **faster than usual**. Meanwhile, on its back:
   - Three sealed **Viral Blisters** have ridden the boss since it woke — bulging from its
     back side, immune to ordinary fire.
   - Pairs of green **Antiviral Patch** capsules drop from the sky every **5 s**. Catch **3**
     and your fire can burst a Blister. One burst spends the patches — and splash damage can
     accidentally pop more than one Blister at once. Burst Blisters never regrow.
   - A burst Blister flings an **AURIC KEY** to the floor. Whoever grabs it carries it to an
     intact Lock to **wake its Refuge Well** before the blast.
4. **Obliteration** — when the phase ends, Vaulthur charges an arena-wide blast (the arena
   blanches white as it winds up). Refuge Wells are **dormant by default**: only a key-woken
   well shelters you — anyone caught outside (and outside a Sentinel's Ward) is **erased
   outright**. **Every woken well collapses forever after the blast** — its crystal tumbles
   dead onto the floor — so the three Locks double as the raid's clock. Then it all repeats,
   harder:
   - **Round 2+** — Vault Keepers arrive warded by orbiting **Wisps** that soak your shots,
     and Vaulthur opens up with a **rhythmic barrage**: rotating rings of slow bullets to
     weave through.
   - **Round 3+** — Vaulthur periodically **partitions the arena**: two converging laser
     beams sweep at shin height (jump them!). Enemies stop spawning while the beams spin.
5. **Final Stand** — at **25% HP** (marked by the notch on the boss bar) the shield stays
   down but Vaulthur begins a 32 s **Annihilation** cast while throwing hasted,
   **overlapping** specials — sweeps over barrages over volleys. Kill him before the cast
   completes or the fireteam wipes.
6. **Victory** — a vault cache spawns. Press **E** for your exotic — **each guardian must
   claim it personally**; skipping the cache means leaving empty-handed. The encounter
   resets 30 s later and everyone returns to the selection screen to re-pick class and
   loadout.

Downed teammates can be revived (**E** once, 3 s channel with a progress bar — downed allies
beam a green pillar of light). If everyone is down, the encounter wipes and
resets to the lobby. Boss HP scales with fireteam size at encounter start (26 000 solo,
+22 000 per extra Guardian — bigger fireteams must out-coordinate, not just outnumber), and
Keeper HP, wave sizes, and the live-add ceiling all scale per player too, so a 6-stack faces
a proportionally bigger horde. Solo clears take ~3 damage phases.

## Architecture

- **Server** (`server/`) — Node + `ws`. Authoritative for the encounter state machine, enemy
  AI, boss attacks, projectiles, player HP/revives, orbs/dunks, and super validation. Caps
  client-reported damage and gates Nova Burst behind an actual cast (`server/game.js` is
  fully deterministic — time only advances through `tick(dt)`, which is how the headless
  tests simulate whole raids in milliseconds).
- **Client** (`public/`) — Three.js FPS with client-side hit detection (PvE-trust model),
  snapshot interpolation at 10 Hz, synthesized WebAudio SFX, and DOM HUD.
- **Shared** (`shared/constants.js`) — single source of truth for all tuning numbers.

Notes: joining mid-encounter is allowed (boss HP stays as rolled at start). The 7th
connection is rejected with a "fireteam full" message.
