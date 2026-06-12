// Snapshot-driven world entities: remote players, server projectiles,
// ammo bricks, capsules, keys, wells, the victory chest.
import * as THREE from 'three';
import { CLASSES, ENC, BOTS } from '/shared/constants.js';
import { Interp } from './enemies.js';

const noRay = (o) => { o.raycast = () => {}; return o; };

// Tag materials are cached per name+color: the same label repeats across a
// soul-sign, the summoned echo's head, and rebuilds — and each cache miss is
// a canvas raster + a GPU texture upload, which must never land mid-session
// in a burst (the banner plant spawns five sign tags in ONE frame). The echo
// roster's tags are pre-painted at boot in buildEntityWarmup.
const tagMats = new Map(); // `${name}|${color}` -> SpriteMaterial
function tagMaterial(name, color) {
  const key = `${name}|${color}`;
  if (!tagMats.has(key)) {
    // The lobby showcase puts this sprite a few meters from the camera, where it
    // spans most of the screen — raster it large enough for that, not just for
    // in-arena distances (256px across 3.4 m read visibly blurry up close).
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 192;
    const g = c.getContext('2d');
    g.font = '600 104px "Segoe UI", Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.lineWidth = 10;
    g.lineJoin = 'round';
    const label = name.toUpperCase();
    g.strokeText(label, 512, 104, 960);
    g.fillText(label, 512, 104, 960);
    tagMats.set(key, new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  }
  return tagMats.get(key);
}
function makeNameTag(name, color) {
  const spr = new THREE.Sprite(tagMaterial(name, color));
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
// Echo (bot) guardians wear a translucent pale-gold shell — summoned-phantom
// read at a glance. Shared module singletons like every other guardian
// material (class accents stay per-guardian as usual).
const G_SUIT_PHANTOM = new THREE.MeshStandardMaterial({ color: 0x2e2a1c, roughness: 0.4, metalness: 0.6,
  transparent: true, opacity: 0.78, emissive: 0xc8a84b, emissiveIntensity: 0.22 });
const G_HEAD_PHANTOM = new THREE.MeshStandardMaterial({ color: 0x262214, roughness: 0.3, metalness: 0.6,
  transparent: true, opacity: 0.85, emissive: 0xc8a84b, emissiveIntensity: 0.18 });
const G_KEY_MAT = new THREE.MeshBasicMaterial({ color: 0xffd34d });
const G_BEACON_MAT = new THREE.MeshBasicMaterial({ color: 0x7ae582, transparent: true, opacity: 0.35,
  side: THREE.DoubleSide, depthWrite: false }); // cloned per guardian (opacity pulses while downed)

export function buildGuardian(name, cls, phantom = false) {
  const col = new THREE.Color(CLASSES[cls]?.color || '#ffffff');
  const g = new THREE.Group();
  const lightLine = new THREE.MeshBasicMaterial({ color: col }); // Tron accent, class-colored
  const suitMat = phantom ? G_SUIT_PHANTOM : G_SUIT_MAT;
  const body = noRay(new THREE.Mesh(G_GEO.body, suitMat));
  body.position.y = 1.1;
  const head = noRay(new THREE.Mesh(G_GEO.head, phantom ? G_HEAD_PHANTOM : G_HEAD_MAT));
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
  const gun = noRay(new THREE.Mesh(G_GEO.gun, suitMat));
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
// barrage ember: molten core in a spinning additive wire cage — must read
// hotter and angrier than the boss's pink volley orbs
const HELL_CAGE_GEO = new THREE.OctahedronGeometry(1.5, 0);
const HELL_CAGE_MAT = new THREE.MeshBasicMaterial({ color: 0xffb84d, wireframe: true, transparent: true,
  opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
const PROJ_STYLE = {
  bolt:    { mat: new THREE.MeshBasicMaterial({ color: 0x46c8ff }), size: 0.26 },
  heavy:   { mat: new THREE.MeshBasicMaterial({ color: 0xc77dff }), size: 0.5 },
  bossOrb: { mat: new THREE.MeshBasicMaterial({ color: 0xff5d8f }), size: 0.85 },
  hell:    { mat: new THREE.MeshBasicMaterial({ color: 0xff7a1c }), size: 0.5, spin: 4.2 },
  heal:    { mat: new THREE.MeshBasicMaterial({ color: 0x7dffcf }), size: 0.3 }, // sentinel mend-orbs
};
function buildProjMesh(k) {
  const st = PROJ_STYLE[k] || PROJ_STYLE.bolt;
  const m = noRay(new THREE.Mesh(PROJ_GEO, st.mat));
  m.scale.setScalar(st.size);
  if (k === 'hell') m.add(noRay(new THREE.Mesh(HELL_CAGE_GEO, HELL_CAGE_MAT)));
  return m;
}

// Corkscrew-bolt trails: a fixed pool of Lines (created once in the
// EntityManager constructor — never per spawned bolt), vertex colors fading
// head→black under additive blending (additive black = invisible). The trail
// needs no history buffer: it IS the helix curve's recent past, evaluated
// analytically each frame from the snapshot's hx params.
const TRAIL_PTS = 24, TRAIL_SPAN = 0.55, TRAIL_POOL = 10;
const TRAIL_MAT = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true,
  blending: THREE.AdditiveBlending, depthWrite: false });
function buildTrail() {
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(TRAIL_PTS * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  const col = new Float32Array(TRAIL_PTS * 3);
  const c = new THREE.Color(0x46c8ff); // the bolt cyan
  for (let i = 0; i < TRAIL_PTS; i++) {
    const f = (1 - i / (TRAIL_PTS - 1)) ** 2;
    col[i * 3] = c.r * f; col[i * 3 + 1] = c.g * f; col[i * 3 + 2] = c.b * f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const line = noRay(new THREE.Line(geo, TRAIL_MAT));
  line.frustumCulled = false; // positions churn every frame; skip stale-bounds culling
  line.visible = false;
  return line;
}

// Position on a bolt's corkscrew `age` seconds after its latest snapshot
// (negative age = the recent past, for the trail). Mirrors the server math in
// tickProjectiles exactly; t clamps at launch so a young bolt's trail can't
// poke back out of the muzzle.
const _hp = [0, 0, 0];
function helixAt(v, age, out) {
  const h = v.hx;
  const t = Math.max(0, h.a + age);
  const rad = Math.sin(Math.PI * Math.min(1, t / h.T)) * h.r;
  const ph = h.om * t + h.ph;
  const c = Math.cos(ph) * rad, s = Math.sin(ph) * rad;
  const a2 = t - h.a; // clamped age, relative to the snapshot base point
  out[0] = h.bp[0] + h.bv[0] * a2 + v.hxU[0] * c + v.hxW[0] * s;
  out[1] = h.bp[1] + h.bv[1] * a2 + v.hxU[1] * c + v.hxW[1] * s;
  out[2] = h.bp[2] + h.bv[2] * a2 + v.hxU[2] * c + v.hxW[2] * s;
}
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
// rally banner: pole + crossbar + hanging cloth, and the white placement circle
const BANNER_POLE_GEO = new THREE.CylinderGeometry(0.05, 0.08, 3.6, 8);
const BANNER_ARM_GEO = new THREE.CylinderGeometry(0.035, 0.035, 1.2, 6).rotateZ(Math.PI / 2);
const BANNER_TOP_GEO = new THREE.OctahedronGeometry(0.14);
const BANNER_CLOTH_GEO = new THREE.PlaneGeometry(1.0, 1.7);
const BANNER_POLE_MAT = new THREE.MeshStandardMaterial({ color: 0x2a2a38, roughness: 0.35, metalness: 0.75 });
const BANNER_TOP_MAT = new THREE.MeshBasicMaterial({ color: 0xf0e9d8 });
const BANNER_CLOTH_MAT = new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.9, metalness: 0,
  emissive: 0xe8e2d2, emissiveIntensity: 0.12, side: THREE.DoubleSide });
const BANNER_SPOT_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
// Soul-signs around the planted banner (echo summoning): a gold rune ring at
// the summon radius, a slow-turning class-colored sigil, the name overhead.
const SIGN_RING_MAT = new THREE.MeshBasicMaterial({ color: 0xd8b85a, transparent: true, opacity: 0.5,
  blending: THREE.AdditiveBlending, depthWrite: false });
const SIGN_GLYPH_GEO = new THREE.OctahedronGeometry(0.32);
const signGlyphMats = new Map(); // cached per class (3 entries), never per-sign
const signGlyphMat = (cls) => {
  if (!signGlyphMats.has(cls)) {
    signGlyphMats.set(cls, new THREE.MeshBasicMaterial({
      color: new THREE.Color(CLASSES[cls]?.color || '#ffffff'), transparent: true, opacity: 0.9,
    }));
  }
  return signGlyphMats.get(cls);
};
const FOCUS_RING_MAT = new THREE.MeshBasicMaterial({ color: 0xff3347, transparent: true, opacity: 0.6, depthWrite: false });
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
  for (const k of Object.keys(PROJ_STYLE)) g.add(buildProjMesh(k));
  const trail = buildTrail(); // compile the vertexColors+additive line program
  trail.visible = true;       // (all-zero positions — draws degenerate)
  g.add(trail);
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
  g.add(new THREE.Mesh(BANNER_POLE_GEO, BANNER_POLE_MAT));
  g.add(new THREE.Mesh(BANNER_ARM_GEO, BANNER_POLE_MAT));
  g.add(new THREE.Mesh(BANNER_TOP_GEO, BANNER_TOP_MAT));
  g.add(new THREE.Mesh(BANNER_CLOTH_GEO, BANNER_CLOTH_MAT));
  g.add(new THREE.Mesh(WELL_RING_GEO, BANNER_SPOT_MAT));
  g.add(new THREE.Mesh(WELL_RING_GEO, FOCUS_RING_MAT));
  g.add(new THREE.Mesh(WELL_RING_GEO, SIGN_RING_MAT));
  g.add(new THREE.Mesh(SIGN_GLYPH_GEO, signGlyphMat('gunslinger')));
  // pre-raster + upload every roster echo's name tag: the banner plant builds
  // five sign tags in one frame and the first summon builds a guardian tag —
  // none of those may pay a canvas raster or texture upload mid-session
  for (const r of BOTS.roster) g.add(makeNameTag(r.name, CLASSES[r.cls]?.color || '#fff'));
  return g;
}

function buildBanner() {
  const grp = new THREE.Group();
  const pole = noRay(new THREE.Mesh(BANNER_POLE_GEO, BANNER_POLE_MAT));
  pole.position.y = 1.8;
  const arm = noRay(new THREE.Mesh(BANNER_ARM_GEO, BANNER_POLE_MAT));
  arm.position.set(0.55, 3.45, 0);
  const finial = noRay(new THREE.Mesh(BANNER_TOP_GEO, BANNER_TOP_MAT));
  finial.position.y = 3.75;
  const cloth = noRay(new THREE.Mesh(BANNER_CLOTH_GEO, BANNER_CLOTH_MAT));
  cloth.position.set(0.62, 2.55, 0);
  grp.add(pole, arm, finial, cloth);
  return { grp, cloth };
}

// Status glow for a guardian (one pooled light each), highest priority first:
// the boss's mark outranks everything, then the golden super, then the auric
// key, then a full antiviral charge.
function statusGlow(d, focused, golden) {
  if (focused) return { c: 0xff3347, i: 3.2 };
  if (golden) return { c: 0xffb703, i: 3 };
  if (d.ky) return { c: 0xffd34d, i: 2.4 };
  if (d.av >= ENC.capsulesNeeded) return { c: 0x4ade80, i: 2.4 };
  return null;
}

export class EntityManager {
  constructor(scene, myId, glowPool = []) {
    this.scene = scene;
    this.myId = myId;
    this.glowPool = glowPool; // fixed scene-level lights (status glows)
    // one pool light is reserved for the local player's own glow — the pool
    // holds MAX_PLAYERS lights and remotes number at most MAX_PLAYERS - 1
    this.selfGlow = glowPool.find(l => !l.userData.used) || null;
    if (this.selfGlow) this.selfGlow.userData.used = true;
    this.focusId = null;
    this.myData = null;
    // red circle pinned under whichever guardian the boss hard-focuses
    this.focusRing = noRay(new THREE.Mesh(WELL_RING_GEO, FOCUS_RING_MAT));
    this.focusRing.scale.setScalar(1.7);
    this.focusRing.position.y = 0.05;
    this.focusRing.visible = false;
    scene.add(this.focusRing);
    this.guardians = new Map();
    this.projs = new Map();
    // corkscrew-bolt trails — pooled at boot (see buildTrail), assigned per
    // helix bolt, released when the bolt leaves the snapshot
    this.trailPool = Array.from({ length: TRAIL_POOL }, () => {
      const l = buildTrail();
      scene.add(l);
      return l;
    });
    this.bricks = new Map();
    this.wells = new Map();
    this.capsules = new Map();
    this.keyDrops = new Map();
    this.signs = new Map(); // echo soul-signs (LOBBY, banner planted)
    this.chestMesh = null;
    this.banner = null;
    // white circle marking where the rally banner can be planted; lives in the
    // scene permanently, shown only while LOBBY runs without a banner
    this.bannerSpot = noRay(new THREE.Mesh(WELL_RING_GEO, BANNER_SPOT_MAT));
    this.bannerSpot.scale.setScalar(ENC.banner.placeR);
    this.bannerSpot.position.set(ENC.banner.pos[0], 0.04, ENC.banner.pos[2]);
    this.bannerSpot.visible = false;
    scene.add(this.bannerSpot);
    this.t = 0;
    this.lastSnapAt = 0;
  }

  sync(snap, now) {
    this.lastSnapAt = now;
    this.focusId = snap.enc ? snap.enc.focus : null;
    this.myData = snap.players.find(p => p.id === this.myId) || null;
    // --- remote players ---
    const seenP = new Set();
    for (const p of snap.players) {
      if (p.id === this.myId) continue;
      seenP.add(p.id);
      let v = this.guardians.get(p.id);
      if (!v) {
        v = { ...buildGuardian(p.name, p.cls, !!p.bt), interp: new Interp(), data: p };
        v.glow = this.glowPool.find(l => !l.userData.used) || null;
        if (v.glow) v.glow.userData.used = true;
        this.scene.add(v.g);
        this.guardians.set(p.id, v);
      }
      v.data = p;
      v.interp.push(p.p, p.yaw, snap.now); // server-time stamp (see Interp)
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
      const m = buildProjMesh(pr.k);
      this.scene.add(m);
      const v = { mesh: m, spin: (PROJ_STYLE[pr.k] || PROJ_STYLE.bolt).spin };
      if (pr.hx) {
        v.trail = this.trailPool.find(l => !l.userData.used) || null; // dry pool = just no trail
        if (v.trail) v.trail.userData.used = true;
      }
      return v;
    }, (v, pr) => {
      // server-time stamp: ages computed on the server clock make the bolt's
      // deterministic path exact — arrival-time bases re-stepped it per clump
      v.p = [...pr.p]; v.v = [...pr.v]; v.at = snap.now;
      if (pr.hx) {
        v.hx = pr.hx;
        // basis ⊥ the flight line — must match the server's derivation
        const b = pr.hx.bv, sp = Math.hypot(b[0], b[1], b[2]) || 1;
        const d = [b[0] / sp, b[1] / sp, b[2] / sp];
        const ul = Math.hypot(d[2], d[0]) || 1;
        v.hxU = [-d[2] / ul, 0, d[0] / ul];
        v.hxW = [d[1] * v.hxU[2], d[2] * v.hxU[0] - d[0] * v.hxU[2], -d[1] * v.hxU[0]];
      }
    });

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

    // echo soul-signs — summonable companion roster around the banner
    this.syncSet(this.signs, snap.signs || [], (s) => {
      const grp = new THREE.Group();
      const ring = noRay(new THREE.Mesh(WELL_RING_GEO, SIGN_RING_MAT));
      ring.scale.setScalar(BOTS.summonR);
      ring.position.y = 0.04;
      const glyph = noRay(new THREE.Mesh(SIGN_GLYPH_GEO, signGlyphMat(s.cls)));
      glyph.position.y = 1.1;
      const tag = makeNameTag(s.name, CLASSES[s.cls]?.color || '#fff');
      tag.position.y = 2.0;
      tag.scale.set(2.6, 0.49, 1);
      grp.add(ring, glyph, tag);
      this.scene.add(grp);
      return { mesh: grp, glyph };
    }, (v, s) => { v.p = s.p; });

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

    // --- rally banner + its placement circle ---
    this.bannerSpot.visible = snap.enc.st === 'LOBBY' && !snap.banner;
    if (snap.banner && !this.banner) {
      this.banner = buildBanner();
      this.banner.grp.position.set(...snap.banner.p);
      this.scene.add(this.banner.grp);
    } else if (!snap.banner && this.banner) {
      this.scene.remove(this.banner.grp);
      this.banner = null;
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
      if (!seen.has(id)) {
        this.scene.remove(v.mesh);
        if (v.trail) { v.trail.visible = false; v.trail.userData.used = false; }
        map.delete(id);
      }
    }
  }

  update(dt, renderTime, now, myPos = null, srvNow = null) {
    this.t += dt;
    // estimated current server time (de-jittered netClock from main.js, with
    // a last-snapshot fallback) — drives projectile ages and capsule arcs
    const sNow = srvNow ?? (this.serverNow || 0) + Math.max(0, now - this.lastSnapAt);
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
      const st = d.dd ? null : statusGlow(d, d.id === this.focusId, golden);
      if (v.glow) {
        v.glow.position.set(s.p[0], s.p[1] + 1.5, s.p[2]);
        v.glow.intensity = st ? st.i : 0;
        if (st) v.glow.color.set(st.c);
      }
      v.body.rotation.z = d.dn ? Math.PI / 2 : 0;
      v.body.position.y = d.dn ? 0.5 : 1.1;
      v.beacon.visible = !!d.dn;
      if (d.dn) v.beacon.material.opacity = 0.28 + Math.sin(this.t * 5) * 0.12;
    }
    for (const v of this.projs.values()) {
      const age = sNow - v.at;
      if (v.hx) {
        // exact parametric corkscrew, smooth at any fps — the generic p+v·age
        // extrapolation below would chord the spiral at the 10 Hz snap rate
        helixAt(v, age, _hp);
        v.mesh.position.set(_hp[0], _hp[1], _hp[2]);
        if (v.trail) {
          const attr = v.trail.geometry.attributes.position;
          for (let i = 0; i < TRAIL_PTS; i++) {
            helixAt(v, age - (i / (TRAIL_PTS - 1)) * TRAIL_SPAN, _hp);
            attr.setXYZ(i, _hp[0], _hp[1], _hp[2]);
          }
          attr.needsUpdate = true;
          v.trail.visible = true;
        }
      } else {
        v.mesh.position.set(v.p[0] + v.v[0] * age, v.p[1] + v.v[1] * age, v.p[2] + v.v[2] * age);
      }
      if (v.spin) { v.mesh.rotation.x += dt * v.spin * 0.6; v.mesh.rotation.y += dt * v.spin; }
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
    if (this.signs.size) SIGN_RING_MAT.opacity = 0.4 + Math.sin(this.t * 2.2) * 0.15;
    for (const v of this.signs.values()) {
      v.mesh.position.set(v.p[0], 0, v.p[2]);
      v.glyph.rotation.y += dt * 1.2;
      v.glyph.position.y = 1.1 + Math.sin(this.t * 2 + v.p[0]) * 0.12;
    }
    if (this.chestMesh) this.chestMesh.rotation.y += dt * 0.5;
    if (this.bannerSpot.visible) this.bannerSpot.material.opacity = 0.4 + Math.sin(this.t * 2.5) * 0.18;
    if (this.banner) this.banner.cloth.rotation.y = Math.sin(this.t * 1.7) * 0.12; // lazy flutter

    // the local player's own status light (remotes see theirs via v.glow)
    if (this.selfGlow && myPos) {
      const d = this.myData;
      const st = d && !d.dd ? statusGlow(d, d.id === this.focusId, this.goldenActive(d)) : null;
      this.selfGlow.position.set(myPos.x, myPos.y + 1.5, myPos.z);
      this.selfGlow.intensity = st ? st.i : 0;
      if (st) this.selfGlow.color.set(st.c);
    }
    // red mark ring pinned under the boss's quarry — every client sees it,
    // the quarry included (it follows their own feet)
    let fp = null;
    if (this.focusId === this.myId) fp = myPos;
    else {
      const fv = this.guardians.get(this.focusId);
      if (fv && !fv.data.dd) fp = fv.g.position;
    }
    this.focusRing.visible = !!fp;
    if (fp) {
      this.focusRing.position.set(fp.x, 0.05, fp.z);
      this.focusRing.material.opacity = 0.45 + Math.sin(this.t * 7) * 0.25;
    }
  }

  // keyGet broadcast: clear the claimed key at once instead of waiting a snapshot
  removeKeyDrop(id) {
    const v = this.keyDrops.get(id);
    if (!v) return;
    this.scene.remove(v.mesh);
    this.keyDrops.delete(id);
  }

  // Golden buff timestamps are server-time; we just trust the flag while the
  // snapshot keeps reporting a future-ish value (server zeroes it implicitly).
  goldenActive(d) { return d.gu > (this.serverNow || 0); }
  setServerNow(t) { this.serverNow = t; }
}
