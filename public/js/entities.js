// Snapshot-driven world entities: remote players, server projectiles,
// ammo bricks, capsules, keys, wells, the victory chest.
import * as THREE from 'three';
import { CLASSES, ENC } from '/shared/constants.js';
import { Interp } from './enemies.js';

const noRay = (o) => { o.raycast = () => {}; return o; };

function makeNameTag(name, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 48;
  const g = c.getContext('2d');
  g.font = '600 26px "Segoe UI", Arial';
  g.textAlign = 'center';
  g.fillStyle = color;
  g.shadowColor = 'black'; g.shadowBlur = 6;
  g.fillText(name.toUpperCase(), 128, 32);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  spr.scale.set(3.4, 0.64, 1);
  return noRay(spr);
}

// Guardian geometries are shared module singletons (the materials stay
// per-guardian — accents carry the class color).
const G_GEO = {
  body: new THREE.CapsuleGeometry(0.42, 0.9, 4, 8),
  head: new THREE.SphereGeometry(0.26, 12, 10),
  visor: new THREE.BoxGeometry(0.34, 0.1, 0.1),
  trim: new THREE.TorusGeometry(0.46, 0.05, 6, 16).rotateX(Math.PI / 2),
  ankle: new THREE.TorusGeometry(0.34, 0.04, 6, 14).rotateX(Math.PI / 2),
  spine: new THREE.BoxGeometry(0.05, 0.8, 0.03),
  core: new THREE.SphereGeometry(0.06, 8, 8),
  stud: new THREE.SphereGeometry(0.08, 8, 8),
  crest: new THREE.BoxGeometry(0.05, 0.04, 0.36),
  gun: new THREE.BoxGeometry(0.12, 0.16, 0.8),
  key: new THREE.OctahedronGeometry(0.22),
  beacon: new THREE.CylinderGeometry(0.35, 0.6, 30, 10, 1, true),
};
const G_SUIT_MAT = new THREE.MeshStandardMaterial({ color: 0x14151d, roughness: 0.45, metalness: 0.55 });
const G_HEAD_MAT = new THREE.MeshStandardMaterial({ color: 0x101018, roughness: 0.3, metalness: 0.6 });
const G_KEY_MAT = new THREE.MeshBasicMaterial({ color: 0xffd34d });
const G_BEACON_MAT = new THREE.MeshBasicMaterial({ color: 0x7ae582, transparent: true, opacity: 0.35,
  side: THREE.DoubleSide, depthWrite: false }); // cloned per guardian (opacity pulses while downed)

export function buildGuardian(name, cls) {
  const col = new THREE.Color(CLASSES[cls]?.color || '#ffffff');
  const g = new THREE.Group();
  const lightLine = new THREE.MeshBasicMaterial({ color: col }); // Tron accent, class-colored
  const body = noRay(new THREE.Mesh(G_GEO.body, G_SUIT_MAT));
  body.position.y = 1.1;
  const head = noRay(new THREE.Mesh(G_GEO.head, G_HEAD_MAT));
  head.position.y = 1.95;
  const visor = noRay(new THREE.Mesh(G_GEO.visor, lightLine));
  visor.position.set(0, 1.95, 0.2);
  // light-lines: waist + ankle rings, spine strip, chest core, shoulder studs, helmet crest
  const trim = noRay(new THREE.Mesh(G_GEO.trim, lightLine));
  trim.position.y = 1.5;
  const ankle = noRay(new THREE.Mesh(G_GEO.ankle, lightLine));
  ankle.position.y = 0.42;
  const spine = noRay(new THREE.Mesh(G_GEO.spine, lightLine));
  spine.position.set(0, 1.2, -0.42);
  const core = noRay(new THREE.Mesh(G_GEO.core, lightLine));
  core.position.set(0, 1.55, 0.41);
  const studL = noRay(new THREE.Mesh(G_GEO.stud, lightLine));
  studL.position.set(-0.46, 1.62, 0);
  const studR = studL.clone();
  studR.position.x = 0.46;
  const crest = noRay(new THREE.Mesh(G_GEO.crest, lightLine));
  crest.position.set(0, 2.16, 0);
  const gun = noRay(new THREE.Mesh(G_GEO.gun, G_SUIT_MAT));
  gun.position.set(0.3, 1.4, 0.5);
  // auric key marker — everyone can see who holds the well key
  const key = noRay(new THREE.Mesh(G_GEO.key, G_KEY_MAT));
  key.position.y = 3.1; key.visible = false;
  // NOTE: no PointLight in here — guardian groups visibility-toggle (death) and
  // come/go (joins), which would change the light count → shader recompiles.
  // Golden glows come from EntityManager's fixed scene-level pool.
  const tag = makeNameTag(name, CLASSES[cls]?.color || '#fff');
  tag.position.y = 2.6;
  // revive beacon: tall pillar of light, visible across the arena while downed
  const beacon = noRay(new THREE.Mesh(G_GEO.beacon, G_BEACON_MAT.clone()));
  beacon.position.y = 15;
  beacon.visible = false;
  g.add(body, head, visor, trim, ankle, spine, core, studL, studR, crest, gun, key, tag, beacon);
  return { g, key, tag, body, beacon };
}

// NOTE: transient entities (projectiles, orbs, chest) must NOT carry
// PointLights — adding/removing lights changes the scene light count and
// forces Three.js to recompile every lit shader, causing frame hitches.
//
// Same discipline for GPU buffers: these entities churn constantly (barrage
// rings, bricks, capsules), so all geometries/materials are shared module
// singletons — creating a view allocates only cheap Mesh wrappers.
const PROJ_GEO = new THREE.SphereGeometry(1, 10, 8);
const PROJ_STYLE = {
  bolt:    { mat: new THREE.MeshBasicMaterial({ color: 0x46c8ff }), size: 0.26 },
  heavy:   { mat: new THREE.MeshBasicMaterial({ color: 0xc77dff }), size: 0.5 },
  bossOrb: { mat: new THREE.MeshBasicMaterial({ color: 0xff5d8f }), size: 0.85 },
  hell:    { mat: new THREE.MeshBasicMaterial({ color: 0xff7ab8 }), size: 0.5 },
};
const BRICK_GEO = new THREE.BoxGeometry(0.5, 0.3, 0.3);
const BRICK_MATS = {
  heavy: new THREE.MeshBasicMaterial({ color: 0xc77dff }),
  energy: new THREE.MeshBasicMaterial({ color: 0x4ade80 }),
};
const PILL_GEO = new THREE.CapsuleGeometry(0.22, 0.4, 4, 10);
const PILL_MAT = new THREE.MeshStandardMaterial({ color: 0x1d4a2a, roughness: 0.3, metalness: 0.4,
  emissive: 0x4ade80, emissiveIntensity: 0.8 });
const BEAM_GEO = new THREE.CylinderGeometry(0.32, 0.55, 26, 10, 1, true);
const BEAM_MAT = new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.18,
  side: THREE.DoubleSide, depthWrite: false }); // cloned per capsule — opacity animates per instance
const KEY_GOLD = new THREE.MeshStandardMaterial({ color: 0xb8941f, roughness: 0.25, metalness: 0.9,
  emissive: 0xffb703, emissiveIntensity: 0.55 });
const KEY_HEAD_GEO = new THREE.TorusGeometry(0.22, 0.07, 8, 16);
const KEY_SHAFT_GEO = new THREE.BoxGeometry(0.09, 0.62, 0.09);
const KEY_TOOTH_GEO = new THREE.BoxGeometry(0.2, 0.08, 0.08);
const KEY_HALO_GEO = new THREE.SphereGeometry(0.65, 12, 10);
const KEY_HALO_MAT = new THREE.MeshBasicMaterial({ color: 0xffb703, transparent: true, opacity: 0.18, depthWrite: false });
const DOME_GEO = new THREE.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
const WELL_RING_GEO = new THREE.RingGeometry(0.955, 1, 40).rotateX(-Math.PI / 2);
const WELL_MATS = {
  ward: {
    dome: new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    ring: new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.6, depthWrite: false }),
  },
  refuge: {
    dome: new THREE.MeshBasicMaterial({ color: 0xf0e14c, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    ring: new THREE.MeshBasicMaterial({ color: 0xf0e14c, transparent: true, opacity: 0.6, depthWrite: false }),
  },
};

// One mesh per shared entity asset, drawn once at boot so first-use buffer
// uploads (first volley, first brick, …) never land mid-fight.
export function buildEntityWarmup() {
  const g = new THREE.Group();
  for (const st of Object.values(PROJ_STYLE)) g.add(new THREE.Mesh(PROJ_GEO, st.mat));
  g.add(new THREE.Mesh(BRICK_GEO, BRICK_MATS.heavy));
  g.add(new THREE.Mesh(BRICK_GEO, BRICK_MATS.energy));
  g.add(new THREE.Mesh(PILL_GEO, PILL_MAT));
  g.add(new THREE.Mesh(BEAM_GEO, BEAM_MAT));
  g.add(new THREE.Mesh(KEY_HEAD_GEO, KEY_GOLD));
  g.add(new THREE.Mesh(KEY_SHAFT_GEO, KEY_GOLD));
  g.add(new THREE.Mesh(KEY_TOOTH_GEO, KEY_GOLD));
  g.add(new THREE.Mesh(KEY_HALO_GEO, KEY_HALO_MAT));
  g.add(new THREE.Mesh(DOME_GEO, WELL_MATS.ward.dome));
  g.add(new THREE.Mesh(DOME_GEO, WELL_MATS.refuge.dome));
  g.add(new THREE.Mesh(WELL_RING_GEO, WELL_MATS.ward.ring));
  g.add(new THREE.Mesh(WELL_RING_GEO, WELL_MATS.refuge.ring));
  return g;
}

export class EntityManager {
  constructor(scene, myId, glowPool = []) {
    this.scene = scene;
    this.myId = myId;
    this.glowPool = glowPool; // fixed scene-level lights (golden buff glows)
    this.guardians = new Map();
    this.projs = new Map();
    this.bricks = new Map();
    this.wells = new Map();
    this.capsules = new Map();
    this.keyDrops = new Map();
    this.chestMesh = null;
    this.t = 0;
    this.lastSnapAt = 0;
  }

  sync(snap, now) {
    this.lastSnapAt = now;
    // --- remote players ---
    const seenP = new Set();
    for (const p of snap.players) {
      if (p.id === this.myId) continue;
      seenP.add(p.id);
      let v = this.guardians.get(p.id);
      if (!v) {
        v = { ...buildGuardian(p.name, p.cls), interp: new Interp(), data: p };
        v.glow = this.glowPool.find(l => !l.userData.used) || null;
        if (v.glow) v.glow.userData.used = true;
        this.scene.add(v.g);
        this.guardians.set(p.id, v);
      }
      v.data = p;
      v.interp.push(p.p, p.yaw, now);
    }
    for (const [id, v] of this.guardians) {
      if (!seenP.has(id)) {
        if (v.glow) { v.glow.userData.used = false; v.glow.intensity = 0; }
        this.scene.remove(v.g);
        this.guardians.delete(id);
      }
    }

    // --- generic id-keyed sets ---
    this.syncSet(this.projs, snap.projs, (pr) => {
      const st = PROJ_STYLE[pr.k] || PROJ_STYLE.bolt;
      const m = noRay(new THREE.Mesh(PROJ_GEO, st.mat));
      m.scale.setScalar(st.size);
      this.scene.add(m);
      return { mesh: m };
    }, (v, pr) => { v.p = [...pr.p]; v.v = [...pr.v]; v.at = now; });

    this.syncSet(this.bricks, snap.bricks, (b) => {
      const m = noRay(new THREE.Mesh(BRICK_GEO, BRICK_MATS[b.k] || BRICK_MATS.energy));
      this.scene.add(m);
      return { mesh: m };
    }, (v, b) => { v.p = b.p; });

    // antiviral capsules: a green pod sliding down a landing beacon from the sky
    this.syncSet(this.capsules, snap.caps || [], () => {
      const grp = new THREE.Group();
      const pill = noRay(new THREE.Mesh(PILL_GEO, PILL_MAT));
      const beam = noRay(new THREE.Mesh(BEAM_GEO, BEAM_MAT.clone()));
      beam.position.y = 13;
      grp.add(pill, beam);
      this.scene.add(grp);
      return { mesh: grp, pill, beam };
    }, (v, c) => { v.p = c.p; v.land = c.land; });

    // dropped auric keys
    this.syncSet(this.keyDrops, snap.keys || [], () => {
      const grp = new THREE.Group();
      const head = noRay(new THREE.Mesh(KEY_HEAD_GEO, KEY_GOLD));
      head.position.y = 0.34;
      const shaft = noRay(new THREE.Mesh(KEY_SHAFT_GEO, KEY_GOLD));
      shaft.position.y = -0.12;
      const tooth1 = noRay(new THREE.Mesh(KEY_TOOTH_GEO, KEY_GOLD));
      tooth1.position.set(0.12, -0.3, 0);
      const tooth2 = tooth1.clone();
      tooth2.position.y = -0.42;
      const halo = noRay(new THREE.Mesh(KEY_HALO_GEO, KEY_HALO_MAT));
      grp.add(head, shaft, tooth1, tooth2, halo);
      this.scene.add(grp);
      return { mesh: grp };
    }, (v, k) => { v.p = k.p; });

    this.syncSet(this.wells, snap.wells, (w) => {
      const mats = WELL_MATS[w.k] || WELL_MATS.refuge;
      const dome = noRay(new THREE.Mesh(DOME_GEO, mats.dome));
      dome.scale.setScalar(w.r);
      const ring = noRay(new THREE.Mesh(WELL_RING_GEO, mats.ring));
      ring.scale.setScalar(w.r);
      ring.position.y = 0.04;
      const grp = new THREE.Group();
      grp.add(dome, ring);
      this.scene.add(grp);
      return { mesh: grp, dome };
    }, (v, w) => { v.p = w.p; });

    // --- chest ---
    if (snap.chest && !this.chestMesh) {
      const grp = new THREE.Group();
      const box = noRay(new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 1.0),
        new THREE.MeshStandardMaterial({ color: 0x8a6d1a, roughness: 0.3, metalness: 0.8, emissive: 0xffb703, emissiveIntensity: 0.35 })));
      box.position.y = 0.5;
      const lid = noRay(new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.3, 1.1),
        new THREE.MeshStandardMaterial({ color: 0xb8941f, roughness: 0.3, metalness: 0.8, emissive: 0xffb703, emissiveIntensity: 0.4 })));
      lid.position.y = 1.1;
      grp.add(box, lid);
      grp.position.set(...snap.chest.p);
      this.scene.add(grp);
      this.chestMesh = grp;
    } else if (!snap.chest && this.chestMesh) {
      this.scene.remove(this.chestMesh);
      this.chestMesh = null;
    }
  }

  syncSet(map, list, create, apply) {
    const seen = new Set();
    for (const item of list) {
      seen.add(item.id);
      let v = map.get(item.id);
      if (!v) { v = create(item); map.set(item.id, v); }
      apply(v, item);
    }
    for (const [id, v] of map) {
      if (!seen.has(id)) { this.scene.remove(v.mesh); map.delete(id); }
    }
  }

  update(dt, renderTime, now) {
    this.t += dt;
    for (const v of this.guardians.values()) {
      const s = v.interp.at(renderTime);
      if (!s) continue;
      v.g.position.set(s.p[0], s.p[1], s.p[2]);
      v.g.rotation.y = s.yaw + Math.PI;
      const d = v.data;
      v.g.visible = !d.dd;
      v.key.visible = !!d.ky;
      if (d.ky) { v.key.rotation.y += dt * 3; v.key.position.y = 3.1 + Math.sin(this.t * 3) * 0.12; }
      const golden = d.gu && d.gu > 0 && this.goldenActive(d);
      if (v.glow) {
        v.glow.position.set(s.p[0], s.p[1] + 1.5, s.p[2]);
        v.glow.intensity = golden && !d.dd ? 3 : 0;
        v.glow.color.set(0xffb703);
      }
      v.body.rotation.z = d.dn ? Math.PI / 2 : 0;
      v.body.position.y = d.dn ? 0.5 : 1.1;
      v.beacon.visible = !!d.dn;
      if (d.dn) v.beacon.material.opacity = 0.28 + Math.sin(this.t * 5) * 0.12;
    }
    for (const v of this.projs.values()) {
      const age = now - v.at;
      v.mesh.position.set(v.p[0] + v.v[0] * age, v.p[1] + v.v[1] * age, v.p[2] + v.v[2] * age);
    }
    for (const v of this.bricks.values()) {
      v.mesh.position.set(v.p[0], 0.4, v.p[2]);
      v.mesh.rotation.y += dt * 2;
    }
    for (const v of this.wells.values()) {
      v.mesh.position.set(v.p[0], 0, v.p[2]);
      v.dome.material.opacity = 0.13 + Math.sin(this.t * 2.5) * 0.05;
    }
    // capsules tumble out of the wormhole above the boss, arcing down to their
    // beacon-marked landing point (land times are server-clock seconds)
    const sNow = (this.serverNow || 0) + Math.max(0, now - this.lastSnapAt);
    const wp = ENC.sigil.wormholePos;
    for (const v of this.capsules.values()) {
      const tLeft = (v.land || 0) - sNow;
      const falling = tLeft > 0;
      if (falling) {
        const k = Math.min(1, tLeft / ENC.capsuleFall); // 1 at the tear, 0 grounded
        v.pill.position.set((wp[0] - v.p[0]) * k, 0.5 + (wp[1] - 0.5) * k, (wp[2] - v.p[2]) * k);
        v.pill.rotation.z = this.t * 6;
      } else {
        v.pill.position.set(0, 0.5 + Math.sin(this.t * 3) * 0.15, 0);
        v.pill.rotation.z = Math.PI / 14;
      }
      v.beam.material.opacity = falling ? 0.22 : 0.07 + (Math.sin(this.t * 4) + 1) * 0.03;
      v.mesh.position.set(v.p[0], 0, v.p[2]);
    }
    for (const v of this.keyDrops.values()) {
      v.mesh.position.set(v.p[0], 1.0 + Math.sin(this.t * 2.5) * 0.2, v.p[2]);
      v.mesh.rotation.y += dt * 2.2;
    }
    if (this.chestMesh) this.chestMesh.rotation.y += dt * 0.5;
  }

  // Golden buff timestamps are server-time; we just trust the flag while the
  // snapshot keeps reporting a future-ish value (server zeroes it implicitly).
  goldenActive(d) { return d.gu > (this.serverNow || 0); }
  setServerNow(t) { this.serverNow = t; }
}
