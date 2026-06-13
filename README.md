# VAULT OF THE MACHINE

> **🤖 Vibe-coded.** Every line of code in this project was completely written by
> Claude Fable 5, with me serving as director — setting the vision, playtesting each build, and steering the design
> through feedback. It exists as a test of what Claude can build rather than a product.

A browser-based, Destiny-style **1–6 player raid encounter**. One boss, real mechanics,
supers, three weapons, and a raid-sized fireteam of up to six — but every mechanic is tuned
to be **fully soloable**.

[![Gameplay footage](https://img.youtube.com/vi/FIVakykEN9Y/maxresdefault.jpg)](https://www.youtube.com/watch?v=FIVakykEN9Y)

*▶ Click the image above to watch gameplay footage on YouTube.*

## Just want to play? (Windows, zero install)

Download **`vault-of-the-machine-win64.zip`** from the
[latest release](https://github.com/Jazhyc/vault-of-the-machine/releases/latest), extract it
anywhere, and double-click **`start.bat`**. Everything is included — Node, the tunnel client,
the game — nothing gets installed. A public **fireteam link** appears in the window; send it
to up to 5 friends (they just open it in a browser) and play on `http://localhost:3000`
yourself. Keep the window open while you play. You might need to wait a few seconds for the
tunnel to work.

> Windows SmartScreen may warn about an unrecognized app the first time — choose
> **More info → Run anyway**.

Everything below is for running from source / development.

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
  VAULT OF THE MACHINE — PUBLIC FIRETEAM LINK
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

| Class | Super | Grenade |
|---|---|---|
| **Voidcaller** | Nova Burst — hurl a void singularity, 2600 AoE damage | Leaves a gnawing void orb behind |
| **Gunslinger** | Golden Volley — 9 s of 3.5× weapon damage | Bursts into four hunting embers |
| **Sentinel** | Ward Aegis — healing dome: 50% damage resist, heals allies, blocks Obliteration | Splits into mend-orbs that chase the wounded |

Super charges passively, from damage dealt, kills, and solving the vault's mechanics
(press **F** at 100%).

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

The shape of the raid, spoiler-free:

1. **Rally** — in the lobby, plant the banner on the white circle near spawn; every guardian
   can rally at it once for a full restock. Then the whole fireteam stands on the glowing
   center plate for 3 s.
2. **Mechanics phase** — Vaulthur is **IMMUNE** and adds pour from three gates. The arena
   holds everything you need to bring the shield down — read the pillars, watch the sky,
   and trust that the fiction is hinting at the mechanic.
3. **Damage phase** — the shield shatters for **25 s** and the fight gets hectic by design.
   Hurt him — but keep one eye on what's falling from the sky, because…
4. **Obliteration** — when the phase ends, Vaulthur charges an arena-wide blast. Shelter
   exists, but only for fireteams that earned it during the damage phase. Then it all
   repeats, **harder** — each round unlocks new boss attacks.
5. **Final Stand** — at **25% HP** (the notch on the boss bar) Vaulthur stops cycling and
   starts killing. Kill him first.
6. **Victory** — a vault cache spawns. Press **E** for your exotic — **each guardian must
   claim it personally**; skipping the cache means leaving empty-handed. The encounter
   resets 30 s later and everyone returns to the selection screen to re-pick class and
   loadout.

The raid is meant to be solved blind — the details below are for stuck fireteams.

<details>
<summary>⚠️ <strong>Full mechanics guide (heavy spoilers)</strong></summary>

### Mechanics phase — the sky sigil

- Two **Vault Keepers** rise warded — immune until their ward breaks. Each round deals the
  three Lock colors (ROSE / AZURE / AMBER) out: one to each twin Keeper, one held back.
- A **3×3 star lattice** hangs in the northern sky; each of the six pillars projects one
  glowing segment of a code in its Keeper's color. Shoot the lattice stars to light the
  combined three-segment code of one twin — an exact match calls down a **lattice strike**
  that breaks that Keeper's ward (and one-shots any unwarded add near the blast). Matching
  a code also feeds the whole fireteam's super gauges.
- While the twin codes are live, Vaulthur periodically **grabs the lattice panel** and hurls
  it around the sky-ring — it stays wherever it lands, so re-find it before you fire.
- Both twins dead → the **Herald** rises over the boss in the held-back color, behind a
  weak but **destructible** ward that only blessed fire can wound: stand at the Lock of the
  Herald's color to take the short-lived **wardbreaker** blessing, then shoot the ward down.
  It detonates Herald and all.
- The Herald's death tears a **wormhole**; a lance falls through it and **breaks the
  shield** — damage phase begins.

### Damage phase — the viral mechanic

- Vaulthur **marks one Guardian** (announced to everyone) and turns to face them — volleys
  and seeker salvos converge on the mark, and the glowing crit core points their way, so
  the team stacks up front and crits. He also chains his round-unlocked specials **faster
  than usual**.
- Three sealed **Viral Blisters** ride his back, immune to ordinary fire. Pairs of green
  **Antiviral Patch** capsules drop every **5 s**; catch **3** and your fire can burst a
  Blister (one burst spends the patches; splash can pop several at once; burst Blisters
  never regrow).
- A burst Blister flings an **AURIC KEY** to the floor. Whoever grabs it carries it to an
  intact Lock to **wake its Refuge Well** before the blast.

### Obliteration

Refuge Wells are **dormant by default**: only a key-woken well shelters you — anyone caught
outside (and outside a Sentinel's Ward) is **erased outright**. **Every woken well collapses
forever after the blast**, so the three Locks double as the raid's clock.

### Escalation

- **Round 1** — Vaulthur already launches **Riven Seekers** off his back: perfectly-homing
  missiles you can shoot down (they chain-pop each other), feed a pillar, or out-sprint —
  walking is not enough. Salvos grow by one missile every phase.
- **Round 2+** — Keepers arrive orbited by shot-soaking **Wisps**, and Vaulthur opens up
  with a **rhythmic barrage**: spiral arms of caged embers that snake chest-high and bob to
  the beat — too high to duck, too low to jump; weave the gaps sideways.
- **Round 3+** — Vaulthur periodically **partitions the arena**: two converging laser beams
  sweep at shin height (jump them!). Enemies stop spawning while the beams spin.

### Final Stand

At 25% HP an emergency **generator surge** reignites the shield for 30 s: one sweep beam
spins for the entire surge while seeker bursts launch every couple of seconds, dealt
round-robin so **every** guardian is hunted. When the generator dies the shield drops for
good and the 32 s **Annihilation** cast begins — Vaulthur throws hasted, **overlapping**
specials (sweeps over barrages over volleys) until he or the fireteam is finished.

</details>

Downed teammates can be revived (**E** once, 3 s channel with a progress bar — downed allies
beam a green pillar of light). If everyone is down, the encounter wipes and
resets to the lobby. Boss HP scales with fireteam size at encounter start (26 000 solo,
+22 000 per extra Guardian — bigger fireteams must out-coordinate, not just outnumber), and
Keeper HP, wave sizes, and the live-add ceiling all scale per player too, so a 6-stack faces
a proportionally bigger horde. Solo clears take ~3 damage phases.

## Architecture

- **Server** (`server/`) — Node + `ws`. Authoritative for the encounter state machine, enemy
  AI, boss attacks, projectiles, player HP/revives, the sigil mechanic, and super validation. Caps
  client-reported damage and gates Nova Burst behind an actual cast (`server/game.js` is
  fully deterministic — time only advances through `tick(dt)`, which is how the headless
  tests simulate whole raids in milliseconds).
- **Client** (`public/`) — Three.js FPS with client-side hit detection (PvE-trust model),
  snapshot interpolation at 10 Hz, synthesized WebAudio SFX, and DOM HUD.
- **Shared** (`shared/constants.js`) — single source of truth for all tuning numbers.

Notes: joining mid-encounter is allowed (boss HP stays as rolled at start). The 7th
connection is rejected with a "fireteam full" message.

## Building the release bundle

The zero-install Windows zip on the Releases page is produced by:

```bash
bash bundle/make-bundle.sh    # → dist/vault-of-the-machine-win64.zip
```

(Run it from WSL, Git Bash, Linux, or macOS; it needs `curl`, `zip`, `unzip`, and a local
`node`.) The script stages a `vault-of-the-machine/` folder containing:

- `node/node.exe` — the latest portable Node LTS, fetched from nodejs.org (only the exe;
  npm isn't needed since `node_modules/` ships pre-installed)
- `cloudflared.exe` — Cloudflare's tunnel client, fetched from its GitHub releases.
  `server/web.js` looks for this bundled copy next to `package.json` before falling back
  to PATH, so hosts get the clean `trycloudflare.com` link with nothing installed
- the game (`server/`, `shared/`, `public/`, `node_modules/`) plus `start.bat`, which runs
  `server/web.js` with the bundled Node

Downloads are cached in `dist/.cache`, so rebuilds don't re-fetch. To publish: build, then
attach the zip to a GitHub release.

## License

[MIT](LICENSE) © Jeremias Lino Ferrao
