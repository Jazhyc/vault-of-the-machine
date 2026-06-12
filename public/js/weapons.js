import * as THREE from 'three';
import { WEAPONS, GRENADE, MELEE, SUPER, ENC, CLASS_SUPER, CLASSES } from '/shared/constants.js';
import { code } from './settings.js';

const noRay = (o) => { o.traverse(c => { c.raycast = () => {}; }); return o; };

const ACCENTS = { auto: 0xcfd6ff, hand: 0xffb277, sniper: 0x4cc9f0, shotgun: 0xff7a5c, rocket: 0xc77dff, lmg: 0x9dffb0, gjally: 0xffd24d };

// Shared projectile/wolf assets — per-shot GPU allocations caused frame hitches.
const PROJ_GEO = new THREE.SphereGeometry(1, 10, 8);
const PROJ_MATS = new Map(); // color -> material
const WOLF_GEO = new THREE.SphereGeometry(0.13, 8, 6);
const WOLF_MAT = new THREE.MeshBasicMaterial({ color: 0x9dffc8 });
const SWARM_MAT = new THREE.MeshBasicMaterial({ color: 0xffc94d }); // gunslinger grenade embers
const NOVA_SWARM_MAT = new THREE.MeshBasicMaterial({ color: 0xc77dff }); // voidcaller nova shards

// Drawn once at boot so the shared projectile/wolf buffers are pre-uploaded.
export function buildWeaponFxWarmup() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(PROJ_GEO, WOLF_MAT));
  g.add(new THREE.Mesh(WOLF_GEO, WOLF_MAT));
  g.add(new THREE.Mesh(WOLF_GEO, SWARM_MAT));
  g.add(new THREE.Mesh(WOLF_GEO, NOVA_SWARM_MAT));
  return g;
}

// --- small builder helpers ---
const box = (g, mat, w, h, d, x, y, z) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); g.add(m); return m;
};
const tube = (g, mat, r1, r2, len, x, y, z) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 12).rotateX(Math.PI / 2), mat);
  m.position.set(x, y, z); g.add(m); return m;
};
const torus = (g, mat, r, t, x, y, z) => {
  const m = new THREE.Mesh(new THREE.TorusGeometry(r, t, 6, 18), mat);
  m.position.set(x, y, z); g.add(m); return m;
};

function mats(key) {
  return {
    body: new THREE.MeshStandardMaterial({ color: 0x23232e, roughness: 0.45, metalness: 0.7 }),
    grip: new THREE.MeshStandardMaterial({ color: 0x141419, roughness: 0.85, metalness: 0.25 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x3c3c4a, roughness: 0.28, metalness: 0.92 }),
    accent: new THREE.MeshBasicMaterial({ color: ACCENTS[key] || 0xc77dff }),
  };
}

// red-dot style sight: ring + emissive dot + mount
function addReflex(g, M, y, z) {
  const ring = torus(g, M.steel, 0.034, 0.008, 0, y, z);
  ring.rotation.y = 0;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.009, 6, 6), M.accent);
  dot.position.set(0, y, z); g.add(dot);
  box(g, M.body, 0.022, 0.035, 0.035, 0, y - 0.045, z);
}

// magnified optic: tube + glinting front lens + mount
function addScope(g, M, y, z, len = 0.2, r = 0.042) {
  tube(g, M.body, r, r, len, 0, y, z);
  tube(g, M.steel, r + 0.008, r + 0.008, 0.02, 0, y, z - len / 2);
  tube(g, M.steel, r + 0.005, r + 0.005, 0.015, 0, y, z + len / 2);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(r * 0.78, 14), M.accent);
  lens.position.set(0, y, z - len / 2 - 0.012);
  lens.rotation.y = Math.PI;
  g.add(lens);
  box(g, M.body, 0.022, 0.04, 0.05, 0, y - 0.055, z);
}

// muzzle anchor + hidden flash (cone + core) shown for ~50ms per shot
function addMuzzle(g, z, y, scale = 1) {
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, y, z);
  const fmat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.9, depthWrite: false });
  const flash = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.045 * scale, 0.22 * scale, 6).rotateX(-Math.PI / 2), fmat);
  cone.position.z = -0.1 * scale;
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.035 * scale, 6, 6), fmat);
  flash.add(cone, core);
  flash.visible = false;
  muzzle.add(flash);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  g.userData.flash = flash;
}

export function buildViewmodel(key) {
  const g = new THREE.Group();
  const M = mats(key);
  if (key === 'auto') {
    box(g, M.body, 0.09, 0.15, 0.5, 0, 0, 0.02);                 // receiver
    box(g, M.grip, 0.07, 0.07, 0.26, 0, 0.01, -0.32);            // handguard
    tube(g, M.steel, 0.024, 0.024, 0.3, 0, 0.035, -0.52);        // barrel
    tube(g, M.steel, 0.032, 0.032, 0.05, 0, 0.035, -0.65);       // brake
    box(g, M.grip, 0.055, 0.19, 0.1, 0, -0.15, 0.05);            // mag
    box(g, M.grip, 0.045, 0.11, 0.05, 0, -0.12, 0.16);           // pistol grip
    box(g, M.grip, 0.07, 0.11, 0.16, 0, -0.02, 0.32);            // stock
    box(g, M.accent, 0.094, 0.014, 0.34, 0, 0.06, -0.08);        // accent stripe
    addReflex(g, M, 0.14, -0.04);
    addMuzzle(g, -0.69, 0.035);
  } else if (key === 'hand') {
    box(g, M.body, 0.075, 0.13, 0.3, 0, 0.01, -0.06);            // frame
    tube(g, M.steel, 0.034, 0.034, 0.3, 0, 0.05, -0.24);         // shroud
    tube(g, M.steel, 0.02, 0.02, 0.07, 0, 0.05, -0.42);          // barrel tip
    box(g, M.steel, 0.09, 0.09, 0.06, 0, -0.005, -0.03);         // cylinder block
    box(g, M.steel, 0.02, 0.05, 0.035, 0, 0.095, 0.09);          // hammer
    box(g, M.grip, 0.05, 0.14, 0.06, 0, -0.12, 0.08);            // grip
    torus(g, M.accent, 0.04, 0.011, 0, 0.05, -0.36);             // accent band
    addReflex(g, M, 0.135, -0.04);
    addMuzzle(g, -0.47, 0.05);
  } else if (key === 'shotgun') {
    tube(g, M.steel, 0.032, 0.032, 0.55, -0.034, 0.04, -0.3);    // twin barrels
    tube(g, M.steel, 0.032, 0.032, 0.55, 0.034, 0.04, -0.3);
    tube(g, M.body, 0.028, 0.028, 0.44, 0, -0.025, -0.26);       // mag tube
    box(g, M.body, 0.1, 0.13, 0.22, 0, 0, 0.02);                 // receiver
    box(g, M.grip, 0.08, 0.12, 0.26, 0, -0.03, 0.26);            // stock
    box(g, M.grip, 0.1, 0.06, 0.14, 0, -0.03, -0.33);            // pump
    box(g, M.accent, 0.104, 0.012, 0.14, 0, 0.005, -0.33);       // pump stripe
    addReflex(g, M, 0.125, 0.0);
    addMuzzle(g, -0.62, 0.04, 1.3);
  } else if (key === 'lmg') {
    box(g, M.body, 0.12, 0.19, 0.58, 0, 0, 0.06);                // receiver
    tube(g, M.grip, 0.04, 0.04, 0.3, 0, 0.05, -0.42);            // barrel shroud
    tube(g, M.steel, 0.027, 0.027, 0.5, 0, 0.05, -0.62);         // barrel
    box(g, M.grip, 0.11, 0.15, 0.16, 0, -0.17, 0.04);            // belt box
    box(g, M.accent, 0.114, 0.02, 0.16, 0, -0.1, 0.04);          // box stripe
    box(g, M.grip, 0.08, 0.13, 0.18, 0, -0.01, 0.4);             // stock
    box(g, M.grip, 0.05, 0.12, 0.05, 0, -0.15, 0.22);            // grip
    tube(g, M.steel, 0.008, 0.008, 0.16, -0.045, -0.05, -0.55);  // bipod legs (folded)
    tube(g, M.steel, 0.008, 0.008, 0.16, 0.045, -0.05, -0.55);
    addScope(g, M, 0.16, 0.0, 0.13, 0.048);
    addMuzzle(g, -0.9, 0.05, 1.2);
  } else if (key === 'gjally') {
    const gold = new THREE.MeshStandardMaterial({ color: 0x8a6d1a, roughness: 0.3, metalness: 0.8, emissive: 0xffb703, emissiveIntensity: 0.25 });
    const green = new THREE.MeshBasicMaterial({ color: 0x7dffb0 });
    tube(g, gold, 0.085, 0.095, 0.85, 0, 0, 0);                  // main tube
    const maw = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.22, 8).rotateX(-Math.PI / 2), gold);
    maw.position.z = -0.52; g.add(maw);                           // wolf maw
    tube(g, M.grip, 0.06, 0.06, 0.03, 0, 0, -0.55);              // dark throat
    box(g, gold, 0.02, 0.17, 0.22, 0, 0.16, 0.28);               // dorsal fin
    box(g, gold, 0.14, 0.02, 0.18, 0.1, 0.05, 0.3);              // side fins
    box(g, gold, 0.14, 0.02, 0.18, -0.1, 0.05, 0.3);
    torus(g, green, 0.1, 0.016, 0, 0, -0.3);                     // sigil rings
    torus(g, green, 0.1, 0.016, 0, 0, 0.18);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.035), green);
    gem.position.set(0, 0.1, -0.05); g.add(gem);                 // wolf's eye
    box(g, M.grip, 0.05, 0.12, 0.06, 0, -0.14, 0.06);            // grips
    box(g, M.grip, 0.05, 0.1, 0.06, 0, -0.13, -0.16);
    addMuzzle(g, -0.66, 0, 1.6);
  } else if (key === 'sniper') {
    box(g, M.body, 0.08, 0.13, 0.6, 0, 0, -0.02);                // receiver
    tube(g, M.steel, 0.021, 0.021, 0.55, 0, 0.04, -0.6);         // barrel
    tube(g, M.steel, 0.034, 0.034, 0.09, 0, 0.04, -0.86);        // brake
    box(g, M.steel, 0.03, 0.018, 0.3, 0, 0.08, -0.05);           // rail
    box(g, M.grip, 0.07, 0.15, 0.2, 0, -0.04, 0.36);             // stock
    box(g, M.grip, 0.074, 0.05, 0.13, 0, 0.06, 0.34);            // cheek rest
    box(g, M.grip, 0.045, 0.12, 0.05, 0, -0.14, 0.14);           // grip
    box(g, M.steel, 0.05, 0.09, 0.08, 0, -0.11, -0.04);          // mag
    box(g, M.accent, 0.084, 0.012, 0.36, 0, -0.062, -0.12);      // accent line
    addScope(g, M, 0.15, -0.03, 0.26, 0.05);
    addMuzzle(g, -0.92, 0.04);
  } else { // rocket — launchers keep iron rails, no glass
    tube(g, M.body, 0.085, 0.095, 0.8, 0, 0, 0);                 // tube
    tube(g, M.steel, 0.12, 0.105, 0.13, 0, 0, -0.45);            // mouth
    tube(g, M.steel, 0.1, 0.115, 0.1, 0, 0, 0.43);               // exhaust
    box(g, M.steel, 0.03, 0.022, 0.3, 0, 0.105, -0.05);          // top rail
    box(g, M.grip, 0.05, 0.12, 0.06, 0, -0.13, 0.05);            // grips
    box(g, M.grip, 0.05, 0.1, 0.06, 0, -0.12, -0.18);
    torus(g, M.accent, 0.103, 0.014, 0, 0, -0.3);                // accent rings
    torus(g, M.accent, 0.097, 0.012, 0, 0, 0.25);
    addMuzzle(g, -0.58, 0, 1.6);
  }
  return noRay(g);
}

export class WeaponSystem {
  constructor(ctx, loadout = ['auto', 'sniper', 'rocket']) {
    this.ctx = ctx; // { camera, scene, targets, net, effects, audio, player, hud, getEnc, enemies }
    this.lastShot = 0;
    this.triggerHeld = false;
    this.semiReady = true;
    this.ads = false;
    this.grenadeReadyAt = 0;
    this.meleeReadyAt = 0;
    this.meleeAnim = 0;
    this.fireKick = 0;
    this.projectiles = [];
    this.wolves = []; // homing missiles: Gjallarhorn wolfpack + gunslinger grenade embers
    this.voidZones = []; // local voidcaller orbs (predicted DoT numbers only)
    this.pendingSuper = null; // confirmed cast waiting for the flourish apex
    this.now = 0;

    // viewmodel rig
    this.rig = new THREE.Group();
    this.rig.position.set(0.34, -0.32, -0.62);
    ctx.camera.add(this.rig);
    this.models = [];
    this.setLoadout(loadout);

    addEventListener('mousedown', (e) => {
      if (!document.pointerLockElement) return;
      if (e.button === 0) { this.triggerHeld = true; this.semiReady = true; }
      if (e.button === 2) this.ads = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.triggerHeld = false;
      if (e.button === 2) this.ads = false;
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => {
      if (!document.pointerLockElement) return;
      this.switchTo((this.cur + (e.deltaY > 0 ? 1 : 2)) % 3);
    });
    addEventListener('keydown', (e) => {
      if (!document.pointerLockElement || e.repeat) return;
      if (this.ctx.player.cineActive) return; // hands are busy mid-flourish
      if (e.code === code('weapon1')) this.switchTo(0);
      if (e.code === code('weapon2')) this.switchTo(1);
      if (e.code === code('weapon3')) this.switchTo(2);
      if (e.code === code('reload')) this.startReload();
      if (e.code === code('grenade')) this.throwGrenade();
      if (e.code === code('melee')) this.melee();
      if (e.code === code('super')) this.castSuper();
    });
  }

  // (Re)equip three weapon keys — also used when returning to the selection screen.
  setLoadout(keys) {
    for (const m of this.models) this.rig.remove(m);
    this.defs = keys.map(k => ({ key: k, ...WEAPONS[k] }));
    this.state = this.defs.map(d => ({ mag: d.mag, reserves: d.reserves }));
    this.models = this.defs.map((d, i) => {
      const m = buildViewmodel(d.key);
      m.visible = i === 0;
      this.rig.add(m);
      return m;
    });
    this.cur = 0;
    this.reloadEnd = 0;
    this.switchEnd = 0;
    this.pendingSuper = null; // a re-kit mid-flourish must not throw a stale nova
  }

  get def() { return this.defs[this.cur]; }
  get st() { return this.state[this.cur]; }
  get reloading() { return this.now < this.reloadEnd; }
  get switching() { return this.now < this.switchEnd; }

  switchTo(i) {
    if (i === this.cur || !this.ctx.player.alive) return;
    this.cur = i;
    this.reloadEnd = 0;
    this._patIdx = 0;
    this.switchEnd = this.now + 0.25;
    this.models.forEach((m, j) => m.visible = j === i);
    this.ctx.audio.ui();
  }

  startReload() {
    const d = this.def, s = this.st;
    if (this.reloading || s.mag >= d.mag || s.reserves <= 0) return;
    this.reloadStart = this.now;
    this.reloadEnd = this.now + d.reload;
    this.ctx.audio.reload();
  }

  finishReload() {
    const d = this.def, s = this.st;
    const want = d.mag - s.mag;
    const got = Math.min(want, s.reserves);
    s.mag += got;
    if (Number.isFinite(s.reserves)) s.reserves -= got;
  }

  addAmmo(kind) {
    const i = kind === 'energy' ? 1 : 2;
    const d = this.defs[i], s = this.state[i];
    if (Number.isFinite(s.reserves)) {
      s.reserves = Math.min(d.maxReserves ?? 999, s.reserves + (d.ammoPickup || 1));
    }
    this.ctx.audio.ammo();
  }

  // Rally banner blessing: full mags, reserves to their hard cap (above the
  // fresh-spawn count — that's the point of planting), abilities off cooldown.
  restock() {
    for (let i = 0; i < this.defs.length; i++) {
      const d = this.defs[i], s = this.state[i];
      s.mag = d.mag;
      if (Number.isFinite(s.reserves)) s.reserves = d.maxReserves ?? d.reserves;
    }
    this.reloadEnd = 0;
    this.grenadeReadyAt = 0;
    this.meleeReadyAt = 0;
    this.ctx.audio.pickup();
  }

  aimDir(spread) {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ctx.camera.quaternion);
    if (spread > 0) {
      dir.x += (Math.random() - 0.5) * spread * 2;
      dir.y += (Math.random() - 0.5) * spread * 2;
      dir.z += (Math.random() - 0.5) * spread * 2;
      dir.normalize();
    }
    return dir;
  }

  muzzleWorld() {
    const mz = this.models[this.cur].userData.muzzle;
    if (mz) return mz.getWorldPosition(new THREE.Vector3());
    return this.models[this.cur].localToWorld(new THREE.Vector3(0, 0.03, -0.5));
  }

  triggerFlash() {
    this.flashUntil = this.now + 0.05;
    this._flashDirty = true;
  }

  // Walk the weapon's recoil pattern (d.recoil: [up, right] steps in multiples
  // of d.kick). The index resets once fire pauses past a shot interval or on
  // weapon switch; past the end the spray holds the last step with a
  // horizontal wander. The viewmodel roll/yaw kick follows the same direction.
  applyRecoil(d) {
    const pat = d.recoil || [[1, 0]];
    if (this.now - (this._patAt || 0) > 60 / d.rpm + 0.3) this._patIdx = 0;
    this._patAt = this.now;
    const i = this._patIdx++;
    const step = pat[Math.min(i, pat.length - 1)];
    let right = step[1];
    if (i >= pat.length) right += (Math.random() - 0.5) * 0.7;
    const k = d.kick * (this.ads ? 0.55 : 1);
    this.ctx.player.kick(step[0] * k, -right * k); // negative yaw turns the view right
    this._kickRoll = right * 0.7 + (Math.random() - 0.5) * 0.25;
    this._kickYaw = -right * 0.05;
  }

  raycast(dir, range) {
    const ray = new THREE.Raycaster(this.ctx.camera.position.clone(), dir, 0.1, range);
    const hits = ray.intersectObjects(this.ctx.targets, true);
    return hits.length ? hits[0] : null;
  }

  entityOf(obj) {
    let o = obj;
    while (o) {
      if (o.userData.ent) return o.userData.ent;
      o = o.parent;
    }
    return null;
  }

  golden() { return this.ctx.player.golden; }

  // Blisters are sealed against ordinary fire — mirrors the server's antiviral
  // gate (onHit/onExplode) so the player sees IMMUNE instead of fake numbers.
  blisterSealed(v) { return v?.ty === 'blister' && !this.ctx.enemies.localEmpowered; }

  fireHitscan() {
    const d = this.def, s = this.st;
    s.mag--;
    this.lastShot = this.now;
    this.fireKick = 1;
    this.triggerFlash();
    this.applyRecoil(d);
    this.ctx.audio.shot(d.key);
    this.ctx.net.fire(d.key, this.muzzleWorld().toArray(), this.aimDir(0).toArray());

    const from = this.muzzleWorld();
    const spread = this.ads ? d.adsSpread : d.spread;
    const pellets = d.pellets || 1;
    const perTarget = new Map(); // entity key -> accumulated pellet damage
    let immuneShown = false;
    let nodeHit = false;

    for (let i = 0; i < pellets; i++) {
      const dir = this.aimDir(spread);
      const hit = this.raycast(dir, d.range);
      const to = hit ? hit.point : from.clone().addScaledVector(dir, Math.min(d.range, 60));
      if (pellets === 1 || i % 3 === 0) this.ctx.effects.tracer(from, to);
      if (!hit) continue;
      const ent = this.entityOf(hit.object);
      if (!ent) { if (i === 0) this.ctx.effects.spark(hit.point); continue; }
      const enc = this.ctx.getEnc();
      // sky-lattice star: one toggle per trigger pull, not per pellet
      if (ent.kind === 'node') {
        if (!nodeHit) {
          nodeHit = true;
          this.ctx.net.sigil(ent.i);
          this.ctx.effects.spark(hit.point);
          this.ctx.audio.hitTick(false);
        }
        continue;
      }
      if (ent.kind === 'boss' && enc && enc.shield) {
        if (!immuneShown) {
          immuneShown = true;
          this.ctx.effects.damageNumber(hit.point, 'IMMUNE', 'immune');
          this.ctx.audio.immune();
        }
        continue;
      }
      // warded keepers shrug everything off — mirror the server's rejection.
      // Exception: the herald's ward has health (shp) and yields to a guardian
      // carrying the wardbreaker blessing — their shots go through as normal.
      if (ent.kind === 'enemy') {
        const v = this.ctx.enemies.views.get(ent.id);
        if (this.blisterSealed(v) || (v?.sh && !(v.shp != null && this.ctx.player.wardbreak))) {
          if (!immuneShown) {
            immuneShown = true;
            this.ctx.effects.damageNumber(hit.point, 'IMMUNE', 'immune');
            this.ctx.audio.immune();
          }
          continue;
        }
      }
      const crit = !!hit.object.userData.crit;
      let dmg = d.dmg * (crit ? d.critMul : 1);
      if (d.falloff) {
        const t = Math.min(1, Math.max(0, (hit.distance - d.falloff.start) / (d.range - d.falloff.start)));
        dmg *= 1 - t * (1 - d.falloff.min);
      }
      if (this.golden()) dmg *= SUPER.golden.mul;
      const key = ent.kind === 'boss' ? 'boss' : ent.id;
      const acc = perTarget.get(key) || { dmg: 0, crit: false, point: hit.point };
      acc.dmg += dmg;
      acc.crit = acc.crit || crit;
      acc.point = hit.point;
      perTarget.set(key, acc);
    }

    for (const [key, acc] of perTarget) {
      const dmg = Math.round(acc.dmg);
      this.ctx.net.hit(key, dmg, d.key);
      this.ctx.effects.damageNumber(acc.point, dmg, this.golden() ? 'super' : acc.crit ? 'crit' : 'normal');
    }
    if (perTarget.size) {
      const anyCrit = [...perTarget.values()].some(a => a.crit);
      this.ctx.hud.hitmarker(anyCrit);
      this.ctx.audio.hitTick(anyCrit);
    }
  }

  fireRocket() {
    const s = this.st;
    s.mag--;
    this.lastShot = this.now;
    this.fireKick = 1;
    this.triggerFlash();
    this.applyRecoil(this.def);
    this.ctx.audio.shot('rocket');
    const dir = this.aimDir(0.004);
    const from = this.muzzleWorld();
    this.ctx.net.fire('rocket', from.toArray(), dir.toArray());
    this.spawnProjectile('rocket', from, dir.multiplyScalar(WEAPONS.rocket.projSpeed), 0xffaa33, 0.18);
  }

  fireGjally() {
    const d = this.def, s = this.st;
    s.mag--;
    this.lastShot = this.now;
    this.fireKick = 1;
    this.triggerFlash();
    this.applyRecoil(d);
    this.ctx.audio.shot('gjally');
    const dir = this.aimDir(0.003);
    const from = this.muzzleWorld();
    this.ctx.net.fire('gjally', from.toArray(), dir.toArray());
    const p = this.spawnProjectile('gjallyOrb', from, dir.multiplyScalar(d.projSpeed), 0x7dffb0, 0.22);
    p.wolfLeft = d.wolfMax;
    p.nextWolfAt = this.now + 0.25;
  }

  // A homing Wolfpack missile seeks the nearest damageable target.
  // World positions matter: blister views are parented to the boss body.
  acquireWolfTarget(fromPos) {
    let best = null, bd = 35;
    const wp = new THREE.Vector3();
    for (const [id, v] of this.ctx.enemies.views) {
      if (v.sh || this.blisterSealed(v)) continue; // wolves don't waste themselves on warded keepers or sealed blisters
      v.group.getWorldPosition(wp);
      const d = fromPos.distanceTo(new THREE.Vector3(wp.x, wp.y + 1, wp.z));
      if (d < bd) { bd = d; best = { kind: 'enemy', id }; }
    }
    const enc = this.ctx.getEnc();
    if (enc && !enc.shield && !enc.bossDead) {
      const d = fromPos.distanceTo(new THREE.Vector3(...ENC.bossPos));
      if (d < bd + 12) best = { kind: 'boss' }; // prefer the boss when vulnerable
    }
    return best;
  }

  wolfTargetPos(target) {
    if (target.kind === 'boss') return new THREE.Vector3(...ENC.bossPos);
    const v = this.ctx.enemies.views.get(target.id);
    if (!v) return null;
    const p = v.group.getWorldPosition(new THREE.Vector3());
    return new THREE.Vector3(p.x, p.y + 1.2, p.z);
  }

  spawnWolf(fromPos, cosmetic = false) {
    const target = this.acquireWolfTarget(fromPos);
    const mesh = new THREE.Mesh(WOLF_GEO, WOLF_MAT); // shared: 18 wolves per shot must not allocate
    mesh.raycast = () => {};
    mesh.position.copy(fromPos);
    this.ctx.scene.add(mesh);
    const d = WEAPONS.gjally;
    const dir = new THREE.Vector3((Math.random() - 0.5), 0.7 + Math.random() * 0.5, (Math.random() - 0.5)).normalize();
    this.wolves.push({ pos: fromPos.clone(), vel: dir.multiplyScalar(d.wolfSpeed * 0.6), target, mesh,
      life: 4, spd: d.wolfSpeed, dmg: d.wolfDmg, wkey: 'gjally', numKind: 'super', cosmetic });
  }

  // Swarm payloads (gunslinger grenade embers, voidcaller nova shards): the
  // blast hurls homing bolts that hunt the nearest damageable targets —
  // distinct enemies first, the exposed boss as backstop.
  acquireSwarmTargets(fromPos, n) {
    const cands = [];
    const wp = new THREE.Vector3();
    for (const [id, v] of this.ctx.enemies.views) {
      if (v.sh || this.blisterSealed(v)) continue;
      v.group.getWorldPosition(wp);
      cands.push({ t: { kind: 'enemy', id }, d: fromPos.distanceTo(new THREE.Vector3(wp.x, wp.y + 1, wp.z)) });
    }
    cands.sort((a, b) => a.d - b.d);
    const out = cands.slice(0, n).map(c => c.t);
    const enc = this.ctx.getEnc();
    const bossOk = enc && !enc.shield && !enc.bossDead;
    while (out.length < n) out.push(bossOk ? { kind: 'boss' } : out[0] || null);
    return out;
  }

  spawnSwarm(fromPos, S, style, cosmetic = false) {
    const targets = this.acquireSwarmTargets(fromPos, S.n);
    for (let i = 0; i < S.n; i++) {
      const mesh = new THREE.Mesh(WOLF_GEO, style.mat);
      mesh.scale.setScalar(1.5);
      mesh.raycast = () => {};
      mesh.position.copy(fromPos);
      this.ctx.scene.add(mesh);
      const a = (i / S.n) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a) * 0.7, 1, Math.sin(a) * 0.7).normalize();
      this.wolves.push({ pos: fromPos.clone(), vel: dir.multiplyScalar(S.speed * 0.8), target: targets[i], mesh,
        life: 4, spd: S.speed, dmg: S.dmg, wkey: style.wkey, numKind: style.numKind, boomCol: style.boomCol, cosmetic });
    }
  }

  // Named swarm payloads. main.js also calls these with cosmetic=true to replay
  // ANOTHER guardian's swarm off the explosion broadcast: same flight and homing
  // against this client's enemy views, but the thrower's client owns the damage.
  spawnNovaSwarm(pos, cosmetic = false) {
    this.spawnSwarm(pos, SUPER.nova.swarm,
      { mat: NOVA_SWARM_MAT, wkey: 'nswarm', numKind: 'super', boomCol: 0x9d4edd }, cosmetic);
  }

  spawnEmberSwarm(pos, cosmetic = false) {
    this.spawnSwarm(pos, GRENADE.gunslinger.swarm,
      { mat: SWARM_MAT, wkey: 'gswarm', numKind: 'normal', boomCol: 0xffb703 }, cosmetic);
  }

  updateWolves(dt) {
    for (let i = this.wolves.length - 1; i >= 0; i--) {
      const w = this.wolves[i];
      w.life -= dt;
      let tp = w.target ? this.wolfTargetPos(w.target) : null;
      if (!tp) { w.target = this.acquireWolfTarget(w.pos); tp = w.target ? this.wolfTargetPos(w.target) : null; }
      if (tp) {
        const desired = tp.clone().sub(w.pos).normalize().multiplyScalar(w.spd);
        w.vel.lerp(desired, Math.min(1, 7 * dt));
      }
      w.pos.addScaledVector(w.vel, dt);
      w.mesh.position.copy(w.pos);
      const reached = tp && w.pos.distanceTo(tp) < (w.target.kind === 'boss' ? ENC.bossBodyR : 1.5);
      if (reached) {
        if (!w.cosmetic) { // cosmetic replays land boom-only — the thrower's
          // client owns the hit, the damage number and the hit-confirm tick
          let dmg = w.dmg * (this.golden() ? SUPER.golden.mul : 1);
          dmg = Math.round(dmg);
          this.ctx.net.hit(w.target.kind === 'boss' ? 'boss' : w.target.id, dmg, w.wkey);
          this.ctx.effects.damageNumber(w.pos, dmg, this.golden() ? 'super' : w.numKind);
          this.ctx.audio.hitTick(true);
        }
        this.ctx.effects.explosion(w.pos, 'death', w.boomCol);
      } else if (w.life > 0 && w.pos.y > 0) {
        continue;
      } else {
        this.ctx.effects.spark(w.pos); // fizzle
      }
      this.ctx.scene.remove(w.mesh);
      this.wolves.splice(i, 1);
    }
  }

  spawnProjectile(kind, from, vel, color, size) {
    // No PointLight here: transient lights force shader recompiles (lag spikes).
    // Shared geometry + cached materials for the same reason.
    if (!PROJ_MATS.has(color)) PROJ_MATS.set(color, new THREE.MeshBasicMaterial({ color }));
    const mesh = new THREE.Mesh(PROJ_GEO, PROJ_MATS.get(color));
    mesh.scale.setScalar(size);
    mesh.raycast = () => {};
    mesh.position.copy(from);
    this.ctx.scene.add(mesh);
    const p = { kind, pos: from.clone(), vel: vel.clone(), mesh, fuse: kind === 'grenade' ? GRENADE.fuse : 6 };
    this.projectiles.push(p);
    return p;
  }

  clsKey() { return this.ctx.getCls ? this.ctx.getCls() : 'gunslinger'; }
  clsColor() { return new THREE.Color(CLASSES[this.clsKey()]?.color || '#7ae582').getHex(); }

  throwGrenade() {
    if (!this.ctx.player.alive || this.now < this.grenadeReadyAt) return;
    this.grenadeReadyAt = this.now + GRENADE.cd;
    const dir = this.aimDir(0);
    const from = this.muzzleWorld();
    this.ctx.audio.shot('melee');
    this.ctx.net.fire('grenade', from.toArray(), dir.toArray());
    const vel = dir.multiplyScalar(GRENADE.speed);
    vel.y += 3;
    this.spawnProjectile('grenade', from, vel, this.clsColor(), 0.14);
  }

  melee() {
    if (!this.ctx.player.alive || this.now < this.meleeReadyAt) return;
    this.meleeReadyAt = this.now + MELEE.cd;
    this.meleeAnim = 1;
    this.ctx.audio.shot('melee');
    const hit = this.raycast(this.aimDir(0), MELEE.range);
    if (!hit) return;
    const ent = this.entityOf(hit.object);
    if (!ent) return;
    const enc = this.ctx.getEnc();
    if (ent.kind === 'boss' && enc && enc.shield) {
      this.ctx.effects.damageNumber(hit.point, 'IMMUNE', 'immune');
      return;
    }
    if (ent.kind === 'enemy') {
      const v = this.ctx.enemies.views.get(ent.id);
      if (v?.sh || this.blisterSealed(v)) {
        this.ctx.effects.damageNumber(hit.point, 'IMMUNE', 'immune');
        return;
      }
    }
    let dmg = MELEE.dmg * (this.golden() ? SUPER.golden.mul : 1);
    dmg = Math.round(dmg);
    this.ctx.net.hit(ent.kind === 'boss' ? 'boss' : ent.id, dmg, 'melee');
    this.ctx.effects.damageNumber(hit.point, dmg, 'crit');
    this.ctx.hud.hitmarker(true);
    this.ctx.audio.hitTick(true);
    this.ctx.effects.shake(0.15);
  }

  castSuper() {
    if (!this.ctx.player.alive) return;
    if (this.ctx.player.sup < 99.5) {
      if (this.now - (this.lastSupNag || 0) > 1.5) {
        this.lastSupNag = this.now;
        this.ctx.hud.toast(`Super ${Math.floor(this.ctx.player.sup)}%`, 'info');
      }
      return;
    }
    this.ctx.net.superCast(this.aimDir(0).toArray());
  }

  // server confirmed our super: start the third-person flourish and hold the
  // payoff (throw/sfx/shake) for the apex — update() fires pendingSuper
  onSuperConfirmed(kind, dir) {
    this.ctx.player.startSuperCine(SUPER.cast.dur);
    this.ctx.audio.chargeUp(2, SUPER.cast.apex);
    this.pendingSuper = { kind, dir, at: this.now + SUPER.cast.apex };
  }

  fireSuper(kind, dir) {
    this.ctx.audio.superCast(kind);
    this.ctx.effects.shake(0.3);
    if (kind === 'nova') {
      // thrown from the body, not the camera — the camera is out behind us
      const d = (dir ? new THREE.Vector3(...dir) : this.aimDir(0)).normalize();
      const from = this.ctx.player.pos.clone()
        .add(new THREE.Vector3(0, 1.5, 0)).addScaledVector(d, 1.2);
      this.spawnProjectile('nova', from, d.multiplyScalar(SUPER.nova.speed), 0x9d4edd, 0.8);
    }
  }

  detonate(p) {
    const kind = p.kind === 'gjallyOrb' ? 'gjally' : p.kind;
    this.ctx.net.explode(kind, [p.pos.x, p.pos.y, p.pos.z]);
    this.ctx.effects.explosion(p.pos, kind, kind === 'grenade' ? this.clsColor() : null);
    this.ctx.audio.explosion(kind === 'nova');
    this.predictAoeNumbers(p.pos, kind);
    if (kind === 'nova') {
      this.spawnNovaSwarm(p.pos);
    }
    if (kind === 'grenade') {
      const cls = this.clsKey();
      if (cls === 'gunslinger') this.spawnEmberSwarm(p.pos);
      // the orb visual arrives via the server's voidOrb broadcast; this list
      // only mirrors the 0.5s gnaw ticks as predicted damage numbers
      if (cls === 'voidcaller') {
        this.voidZones.push({ pos: p.pos.clone(), until: this.now + GRENADE.voidcaller.orb.dur, nextAt: this.now + 0.5 });
      }
    }
  }

  predictAoeNumbers(pos, kind) {
    const base = kind === 'nova' ? SUPER.nova
      : kind === 'grenade' ? (GRENADE[this.clsKey()] || GRENADE.gunslinger)
        : kind === 'gjally' ? { dmg: WEAPONS.gjally.splashDmg, r: WEAPONS.gjally.splashR }
          : { dmg: WEAPONS.rocket.splashDmg, r: WEAPONS.rocket.splashR };
    if (!(base.r > 0)) return; // the sentinel grenade mends — nothing to predict
    let any = false;
    const wp = new THREE.Vector3();
    for (const v of this.ctx.enemies.views.values()) {
      if (v.sh) continue; // warded keepers take no splash either
      v.group.getWorldPosition(wp); // blisters are parented to the boss body
      const ey = v.ty === 'blister' || v.ty === 'seeker' ? wp.y : 1; // mirrors the server's splash check
      const d = pos.distanceTo(new THREE.Vector3(wp.x, ey, wp.z));
      if (d > base.r) continue;
      if (this.blisterSealed(v)) this.ctx.effects.damageNumber(new THREE.Vector3(wp.x, ey + 0.6, wp.z), 'IMMUNE', 'immune');
      else this.ctx.effects.damageNumber(new THREE.Vector3(wp.x, ey + 0.6, wp.z), Math.round(base.dmg * (1 - 0.55 * d / base.r)), 'crit');
      any = true;
    }
    const bossPos = new THREE.Vector3(...ENC.bossPos);
    if (pos.distanceTo(bossPos) < base.r + (kind === 'nova' ? 2.5 : 2)) {
      const enc = this.ctx.getEnc();
      if (enc && enc.shield) this.ctx.effects.damageNumber(pos.clone().add(new THREE.Vector3(0, 2, 0)), 'IMMUNE', 'immune');
      else this.ctx.effects.damageNumber(bossPos, Math.round(base.dmg), 'super');
      any = true;
    }
    if (any) this.ctx.hud.hitmarker(true);
  }

  update(dt, now) {
    this.now = now;
    const d = this.def, s = this.st;
    const cine = this.ctx.player.cineActive; // mid-flourish: no ADS/fire, no viewmodel
    const alive = this.ctx.player.alive && document.pointerLockElement && !cine;

    // the held-back super payoff lands at the flourish apex
    if (this.pendingSuper && now >= this.pendingSuper.at) {
      const { kind, dir } = this.pendingSuper;
      this.pendingSuper = null;
      this.fireSuper(kind, dir);
    }

    // ADS
    const wantAds = this.ads && alive && !this.reloading;
    this.ctx.player.fovTarget = wantAds ? d.zoomFov : this.ctx.player.baseFov;
    this.ctx.hud.scope(wantAds && d.key === 'sniper');
    this.rig.visible = !(wantAds && d.key === 'sniper') && !cine;

    // reload
    if (this.reloading) {
      // gun dip animation handled below
    } else if (this.reloadEnd > 0) {
      this.finishReload();
      this.reloadEnd = 0;
    }
    if (alive && s.mag <= 0 && !this.reloading && s.reserves > 0) this.startReload();

    // firing
    if (alive && this.triggerHeld && !this.reloading && !this.switching) {
      const interval = 60 / d.rpm;
      if (now - this.lastShot >= interval) {
        const canSemi = d.auto || this.semiReady;
        if (canSemi && s.mag > 0) {
          this.semiReady = false;
          if (d.kind === 'hitscan') this.fireHitscan();
          else if (d.kind === 'gjally') this.fireGjally();
          else this.fireRocket();
        } else if (canSemi && s.mag <= 0 && s.reserves <= 0) {
          this.semiReady = false;
          this.ctx.audio.dryFire();
        }
      }
    }
    if (!this.triggerHeld) this.semiReady = true;

    // viewmodel animation --------------------------------------------------
    this.fireKick = Math.max(0, this.fireKick - dt * 9);
    this.meleeAnim = Math.max(0, this.meleeAnim - dt * 4);

    // look sway: the gun lags behind quick mouse movement
    const pl = this.ctx.player;
    const dyaw = pl.yaw - (this._lastYaw ?? pl.yaw);
    const dpitch = pl.pitch - (this._lastPitch ?? pl.pitch);
    this._lastYaw = pl.yaw; this._lastPitch = pl.pitch;
    const decay = 1 - Math.min(1, 9 * dt);
    this._swayY = ((this._swayY || 0) + dyaw * 0.45) * decay;
    this._swayP = ((this._swayP || 0) + dpitch * 0.45) * decay;
    const swayY = Math.max(-0.05, Math.min(0.05, this._swayY));
    const swayP = Math.max(-0.05, Math.min(0.05, this._swayP));

    let px = wantAds ? 0.02 : 0.34;
    let py = -0.32 + (wantAds ? 0.075 : 0);
    let pz = -0.62 + (wantAds ? 0.08 : 0);
    let rx = 0, ry = 0, rz = 0;

    // sprint carry
    if (pl.sprinting && !wantAds && !this.reloading) { ry += 0.5; rx += 0.15; px -= 0.05; py -= 0.02; }

    // weapon raise on switch (ease-out)
    if (this.switching) {
      const k = 1 - Math.pow(1 - Math.max(0, 1 - (this.switchEnd - now) / 0.25), 3);
      py -= 0.3 * (1 - k);
      rx -= 0.7 * (1 - k);
    }

    // reload: dip down, fiddle, snap back with a little overshoot
    if (this.reloading) {
      const p = Math.max(0, Math.min(1, (now - this.reloadStart) / Math.max(0.01, this.reloadEnd - this.reloadStart)));
      let rot;
      if (p < 0.18) rot = -0.85 * (p / 0.18);
      else if (p < 0.72) rot = -0.85 + Math.sin(p * 26) * 0.05;
      else { const q = (p - 0.72) / 0.28; rot = -0.85 * (1 - q) + Math.sin(q * Math.PI) * 0.12; }
      rx += rot;
      py -= 0.07 * Math.sin(Math.PI * p);
    }

    // recoil kick + melee lunge
    pz += this.fireKick * 0.085 - this.meleeAnim * 0.3;
    rx += this.fireKick * 0.11;
    ry += this.fireKick * (this._kickYaw || 0);
    rz += this.fireKick * (this._kickRoll || 0) * 0.12 - this.meleeAnim * 0.25;

    this.rig.position.set(px - swayY * 0.4, py + swayP * 0.3, pz);
    this.rig.rotation.set(rx + swayP * 1.4, ry - swayY * 1.4, rz);

    // muzzle flash
    const flash = this.models[this.cur].userData.flash;
    if (flash) {
      const on = now < (this.flashUntil || 0);
      if (on && this._flashDirty) {
        this._flashDirty = false;
        flash.rotation.z = Math.random() * Math.PI;
        flash.scale.setScalar(0.8 + Math.random() * 0.6);
      }
      flash.visible = on;
    }

    // local projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      // the Gjallarhorn orb releases homing wolfpack missiles while in flight
      if (p.kind === 'gjallyOrb' && p.wolfLeft > 0 && now >= p.nextWolfAt) {
        p.nextWolfAt = now + WEAPONS.gjally.wolfInterval;
        p.wolfLeft--;
        this.spawnWolf(p.pos);
      }
      const prev = p.pos.clone();
      if (p.kind === 'grenade') p.vel.y -= 20 * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.fuse -= dt;
      let boom = p.fuse <= 0 || p.pos.y <= 0.1;
      if (!boom) {
        const step = p.pos.clone().sub(prev);
        const len = step.length();
        if (len > 0.001) {
          const ray = new THREE.Raycaster(prev, step.normalize(), 0, len + 0.3);
          const hits = ray.intersectObjects(this.ctx.targets, true);
          if (hits.length) { p.pos.copy(hits[0].point); boom = true; }
        }
      }
      if (p.pos.y <= 0.1) p.pos.y = 0.1;
      p.mesh.position.copy(p.pos);
      if (boom) {
        this.detonate(p);
        this.ctx.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }
    this.updateWolves(dt);

    // voidcaller orb: mirror the server's 0.5s gnaw ticks with predicted
    // numbers (the orb itself renders from the voidOrb broadcast)
    for (let i = this.voidZones.length - 1; i >= 0; i--) {
      const z = this.voidZones[i];
      if (now > z.until) { this.voidZones.splice(i, 1); continue; }
      if (now < z.nextAt) continue;
      z.nextAt = now + 0.5;
      const O = GRENADE.voidcaller.orb;
      const tick = Math.round(O.dps * 0.5);
      const wp = new THREE.Vector3();
      for (const v of this.ctx.enemies.views.values()) {
        if (v.sh || v.ty === 'blister') continue; // the zone never gnaws blisters
        v.group.getWorldPosition(wp);
        const ey = v.ty === 'seeker' ? wp.y : 1;
        if (z.pos.distanceTo(new THREE.Vector3(wp.x, ey, wp.z)) > O.r) continue;
        this.ctx.effects.damageNumber(new THREE.Vector3(wp.x, ey + 0.6, wp.z), tick, 'normal');
      }
      const enc = this.ctx.getEnc();
      if (enc && !enc.shield && !enc.bossDead
          && z.pos.distanceTo(new THREE.Vector3(...ENC.bossPos)) < O.r + 2) {
        this.ctx.effects.damageNumber(z.pos.clone().add(new THREE.Vector3(0, 2, 0)), tick, 'normal');
      }
    }
  }

  hudState() {
    return {
      defs: this.defs, state: this.state, cur: this.cur,
      reloading: this.reloading,
      grenadeIn: Math.max(0, this.grenadeReadyAt - this.now),
      meleeIn: Math.max(0, this.meleeReadyAt - this.now),
    };
  }
}
