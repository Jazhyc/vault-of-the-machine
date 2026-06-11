import * as THREE from 'three';
import { ARENA, ENC } from '/shared/constants.js';

const noRay = (o) => { o.raycast = () => {}; return o; };
// scratch vectors for per-frame seeker orientation (no per-frame allocation)
const _Z = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();

// Smooth interpolation between the last two snapshots.
export class Interp {
  constructor() { this.a = null; this.b = null; }
  push(p, yaw, t) { this.a = this.b; this.b = { p: [...p], yaw, t }; }
  at(t) {
    if (!this.b) return null;
    if (!this.a || this.b.t - this.a.t < 0.001) return this.b;
    const f = Math.min(1.3, Math.max(0, (t - this.a.t) / (this.b.t - this.a.t)));
    let dy = this.b.yaw - this.a.yaw;
    if (dy > Math.PI) dy -= Math.PI * 2; if (dy < -Math.PI) dy += Math.PI * 2;
    return {
      p: [0, 1, 2].map(i => this.a.p[i] + (this.b.p[i] - this.a.p[i]) * f),
      yaw: this.a.yaw + dy * f,
    };
  }
}

// All enemies share these geometries and materials. Spawning an enemy must NOT
// allocate GPU resources: per-enemy geometry/material objects meant a wave of
// adds uploaded dozens of fresh buffers in a single frame (visible lag spikes),
// and nothing was ever disposed afterwards.
const GEO = {
  // husk — hunched fissured thrall
  huskBody: new THREE.ConeGeometry(0.62, 1.7, 6),
  huskCrack: new THREE.ConeGeometry(0.65, 1.72, 6),
  huskHead: new THREE.SphereGeometry(0.34, 10, 8),
  huskHorn: new THREE.ConeGeometry(0.09, 0.5, 5),
  huskArm: new THREE.CylinderGeometry(0.09, 0.14, 1.1, 5),
  huskClaw: new THREE.ConeGeometry(0.13, 0.45, 4),
  huskShard: new THREE.TetrahedronGeometry(0.26),
  // acolyte — hooded ranged ordnant
  acoBody: new THREE.CylinderGeometry(0.3, 0.5, 1.7, 6),
  acoSkirt: new THREE.ConeGeometry(0.68, 0.9, 6, 1, true),
  acoPauldron: new THREE.BoxGeometry(0.52, 0.2, 0.62),
  acoHood: new THREE.ConeGeometry(0.4, 0.8, 6),
  acoHead: new THREE.BoxGeometry(0.5, 0.45, 0.5),
  acoFace: new THREE.BoxGeometry(0.36, 0.28, 0.07),
  acoEmblem: new THREE.OctahedronGeometry(0.15),
  acoReceiver: new THREE.BoxGeometry(0.26, 0.3, 0.5),
  acoBarrel: new THREE.CylinderGeometry(0.12, 0.16, 1.1, 6).rotateX(Math.PI / 2),
  acoMuzzle: new THREE.CylinderGeometry(0.06, 0.11, 0.22, 6).rotateX(Math.PI / 2),
  // keeper — armored construct elite (also the herald, which hangs inverted in the sky)
  keepLeg: new THREE.CylinderGeometry(0.26, 0.4, 1.3, 6),
  keepPelvis: new THREE.BoxGeometry(1.2, 0.5, 0.8),
  keepBody: new THREE.CylinderGeometry(1.0, 0.65, 1.5, 8),
  keepPauldron: new THREE.BoxGeometry(0.95, 0.45, 1.05),
  keepHead: new THREE.OctahedronGeometry(0.5),
  keepCrest: new THREE.ConeGeometry(0.12, 0.9, 4),
  keepSigil: new THREE.OctahedronGeometry(0.22),
  keepHaloShard: new THREE.TetrahedronGeometry(0.2),
  // wisp
  wispCore: new THREE.OctahedronGeometry(0.42),
  wispRing: new THREE.TorusGeometry(0.62, 0.05, 6, 18),
  wispRing2: new THREE.TorusGeometry(0.78, 0.035, 6, 18),
  wispMote: new THREE.OctahedronGeometry(0.09),
  // seeker — boss-launched homing missile (built nose-forward along +Z)
  seekerBody: new THREE.CylinderGeometry(0.16, 0.16, 0.9, 6).rotateX(Math.PI / 2),
  seekerNose: new THREE.ConeGeometry(0.17, 0.4, 6).rotateX(Math.PI / 2),
  seekerFin: new THREE.BoxGeometry(0.05, 0.42, 0.3),
  seekerFlame: new THREE.ConeGeometry(0.12, 0.55, 6).rotateX(-Math.PI / 2),
  // exhaust plume: vertex colors fade ember→black down the cone; with additive
  // blending black IS transparent (floor-grid trick), so no texture needed.
  // Base sits at z=0, tail tip at z=-2.4 (scale.z flicker stretches aft only).
  seekerTrail: (() => {
    const len = 2.4;
    const g = new THREE.ConeGeometry(0.15, len, 6, 6, true)
      .rotateX(-Math.PI / 2).translate(0, 0, -len / 2);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.max(0, 1 + pos.getZ(i) / len) ** 2; // 1 at engine → 0 at tip
      col[i * 3] = k; col[i * 3 + 1] = 0.55 * k; col[i * 3 + 2] = 0.2 * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  })(),
  // blister
  blisterSac: new THREE.SphereGeometry(1.0, 14, 12),
  blisterPustule: new THREE.SphereGeometry(0.3, 8, 8),
  blisterPustuleBig: new THREE.SphereGeometry(0.42, 8, 8),
  blisterVein: new THREE.TorusGeometry(0.92, 0.045, 5, 14, Math.PI * 1.1),
  keepShield: new THREE.SphereGeometry(2.3, 18, 12),
  keepTrim: new THREE.TorusGeometry(1.25, 0.07, 6, 24).rotateX(Math.PI / 2),
};
// One ward material per pedestal color, shared by every keeper of that color
// (spawns must not allocate; the pulse is uniform scale, not per-instance material).
const KEEP_SHIELD_MATS = ARENA.pedestals.map(pd => new THREE.MeshBasicMaterial({
  color: pd.color, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
const KEEP_TRIM_MATS = ARENA.pedestals.map(pd => new THREE.MeshBasicMaterial({ color: pd.color }));
const MAT = {
  husk: new THREE.MeshStandardMaterial({ color: 0x2a1a3a, roughness: 0.7 }),
  huskHead: new THREE.MeshStandardMaterial({ color: 0x3a2255, emissive: 0xff2244, emissiveIntensity: 0.7, roughness: 0.5 }),
  // glowing fissures: the cone's own wireframe triangulation reads as cracks
  huskCrack: new THREE.MeshBasicMaterial({ color: 0xff2244, wireframe: true, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
  huskBone: new THREE.MeshStandardMaterial({ color: 0x4a3a5f, roughness: 0.8 }),
  aco: new THREE.MeshStandardMaterial({ color: 0x1d1535, roughness: 0.6, metalness: 0.4 }),
  acoRobe: new THREE.MeshStandardMaterial({ color: 0x161030, roughness: 0.8, side: THREE.DoubleSide }),
  acoHead: new THREE.MeshStandardMaterial({ color: 0x241a44, emissive: 0x46c8ff, emissiveIntensity: 0.9, roughness: 0.4 }),
  acoTrim: new THREE.MeshBasicMaterial({ color: 0x46c8ff }),
  keep: new THREE.MeshStandardMaterial({ color: 0x33214f, roughness: 0.5, metalness: 0.5 }),
  keepHead: new THREE.MeshStandardMaterial({ color: 0x5533aa, emissive: 0xc77dff, emissiveIntensity: 1.1, roughness: 0.3 }),
  keepGlow: new THREE.MeshBasicMaterial({ color: 0xc77dff }),
  wispCore: new THREE.MeshStandardMaterial({ color: 0x223355, emissive: 0x66e0ff, emissiveIntensity: 1.2, roughness: 0.3 }),
  wispRing: new THREE.MeshBasicMaterial({ color: 0x66e0ff }),
  seeker: new THREE.MeshStandardMaterial({ color: 0x3a2255, roughness: 0.4, metalness: 0.6 }),
  seekerNose: new THREE.MeshStandardMaterial({ color: 0x2a1020, emissive: 0xff5d2e, emissiveIntensity: 0.9, roughness: 0.4 }),
  seekerFlame: new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
  seekerTrail: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  // shared across all blisters; the empowered pulse animates them in unison
  blister: new THREE.MeshStandardMaterial({ color: 0x44521c, roughness: 0.35, emissive: 0x86e63c, emissiveIntensity: 0.35 }),
  blisterPustule: new THREE.MeshStandardMaterial({ color: 0x53631f, roughness: 0.3, emissive: 0x9aff3c, emissiveIntensity: 0.5 }),
  blisterVein: new THREE.MeshStandardMaterial({ color: 0x2f3d12, roughness: 0.4, emissive: 0x86e63c, emissiveIntensity: 0.45 }),
};

function buildHusk() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(GEO.huskBody, MAT.husk);
  body.position.y = 0.9;
  body.rotation.x = 0.12; // hunched forward
  const crack = noRay(new THREE.Mesh(GEO.huskCrack, MAT.huskCrack));
  crack.position.copy(body.position);
  crack.rotation.copy(body.rotation);
  const head = new THREE.Mesh(GEO.huskHead, MAT.huskHead);
  head.position.set(0, 1.95, 0.18);
  head.userData.crit = true;
  g.add(body, crack, head);
  const arms = [-1, 1].map(s => {
    const arm = new THREE.Group(); // pivot at the shoulder, limb hangs -y
    arm.position.set(0.5 * s, 1.5, 0.15);
    const limb = new THREE.Mesh(GEO.huskArm, MAT.husk);
    limb.position.y = -0.5;
    const claw = new THREE.Mesh(GEO.huskClaw, MAT.huskBone);
    claw.position.y = -1.1;
    claw.rotation.x = Math.PI;
    arm.add(limb, claw);
    arm.rotation.x = -0.7; // reaching forward
    g.add(arm);
    return arm;
  });
  for (const s of [-1, 1]) {
    const horn = new THREE.Mesh(GEO.huskHorn, MAT.huskBone);
    horn.position.set(0.18 * s, 2.28, 0.1);
    horn.rotation.z = -s * 0.45;
    g.add(horn);
    const shard = new THREE.Mesh(GEO.huskShard, MAT.huskBone);
    shard.position.set(0.48 * s, 1.78, -0.05);
    shard.rotation.set(0.4 * s, 0.8, 0.3);
    g.add(shard);
  }
  g.userData.anim = { arms, phase: Math.random() * Math.PI * 2 };
  return g;
}

function buildAcolyte() {
  const g = new THREE.Group();
  const torso = new THREE.Group(); // bobs as one while hovering
  const body = new THREE.Mesh(GEO.acoBody, MAT.acoRobe);
  body.position.y = 1.25;
  const skirt = new THREE.Mesh(GEO.acoSkirt, MAT.acoRobe);
  skirt.position.y = 0.45;
  const head = new THREE.Mesh(GEO.acoHead, MAT.acoHead);
  head.position.y = 2.3;
  head.userData.crit = true;
  const hood = new THREE.Mesh(GEO.acoHood, MAT.aco);
  hood.position.y = 2.45;
  hood.rotation.x = 0.15;
  const face = noRay(new THREE.Mesh(GEO.acoFace, MAT.acoTrim));
  face.position.set(0, 2.28, 0.26);
  const emblem = noRay(new THREE.Mesh(GEO.acoEmblem, MAT.acoTrim));
  emblem.position.set(0, 1.7, 0.45);
  torso.add(body, skirt, head, hood, face, emblem);
  for (const s of [-1, 1]) {
    const pauldron = new THREE.Mesh(GEO.acoPauldron, MAT.aco);
    pauldron.position.set(0.55 * s, 2.05, 0);
    pauldron.rotation.z = s * 0.25;
    torso.add(pauldron);
  }
  const cannon = new THREE.Group();
  cannon.position.set(0.42, 1.55, 0.1);
  const receiver = new THREE.Mesh(GEO.acoReceiver, MAT.aco);
  receiver.position.z = -0.1;
  const barrel = new THREE.Mesh(GEO.acoBarrel, MAT.aco);
  barrel.position.z = 0.3;
  const muzzle = noRay(new THREE.Mesh(GEO.acoMuzzle, MAT.acoTrim));
  muzzle.position.z = 0.95;
  cannon.add(receiver, barrel, muzzle);
  torso.add(cannon);
  g.add(torso);
  g.userData.anim = { torso, emblem, phase: Math.random() * Math.PI * 2 };
  return g;
}

function buildKeeper() {
  const g = new THREE.Group();
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(GEO.keepLeg, MAT.keep);
    leg.position.set(0.45 * s, 0.65, 0);
    leg.rotation.z = s * 0.12;
    g.add(leg);
    const pauldron = new THREE.Mesh(GEO.keepPauldron, MAT.keep);
    pauldron.position.set(0.95 * s, 2.95, 0);
    pauldron.rotation.z = s * 0.18;
    g.add(pauldron);
  }
  const pelvis = new THREE.Mesh(GEO.keepPelvis, MAT.keep);
  pelvis.position.y = 1.35;
  const chest = new THREE.Mesh(GEO.keepBody, MAT.keep);
  chest.position.y = 2.25;
  const head = new THREE.Mesh(GEO.keepHead, MAT.keepHead);
  head.position.y = 3.4;
  head.userData.crit = true;
  const sigil = new THREE.Mesh(GEO.keepSigil, MAT.keepGlow);
  sigil.position.set(0, 2.45, 0.95);
  g.add(pelvis, chest, head, sigil);
  for (let i = -1; i <= 1; i++) {
    const crest = new THREE.Mesh(GEO.keepCrest, MAT.keep);
    crest.position.set(i * 0.32, 3.1, -0.6);
    crest.rotation.x = -0.45;
    crest.scale.y = 1 - Math.abs(i) * 0.3;
    g.add(crest);
  }
  // slowly orbiting rune shards mark the elite (outside the body → noRay)
  const halo = new THREE.Group();
  halo.position.y = 2.7;
  for (let i = 0; i < 3; i++) {
    const shard = noRay(new THREE.Mesh(GEO.keepHaloShard, MAT.keepGlow));
    const a = i * Math.PI * 2 / 3;
    shard.position.set(Math.cos(a) * 1.5, 0, Math.sin(a) * 1.5);
    shard.rotation.set(0.5, a, 0.3);
    halo.add(shard);
  }
  g.add(halo);
  g.userData.anim = { halo, head };
  return g;
}

function buildWisp() {
  const g = new THREE.Group();
  const core = new THREE.Mesh(GEO.wispCore, MAT.wispCore);
  core.userData.crit = true;
  const ring1 = noRay(new THREE.Mesh(GEO.wispRing, MAT.wispRing));
  ring1.rotation.x = Math.PI / 2;
  const ring2 = noRay(new THREE.Mesh(GEO.wispRing2, MAT.wispRing));
  const motes = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const mote = noRay(new THREE.Mesh(GEO.wispMote, MAT.wispRing));
    const a = i * Math.PI * 2 / 3;
    mote.position.set(Math.cos(a) * 0.85, Math.sin(a * 2) * 0.15, Math.sin(a) * 0.85);
    motes.add(mote);
  }
  g.add(core, ring1, ring2, motes);
  g.userData.anim = { core, ring1, ring2, motes };
  return g;
}

// Boss-launched homing missile: shoot-downable, so the warhead nose is a crit
// zone. No hp bar — it reads as ordnance, not a creature.
function buildSeeker() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(GEO.seekerBody, MAT.seeker);
  const nose = new THREE.Mesh(GEO.seekerNose, MAT.seekerNose);
  nose.position.z = 0.62;
  nose.userData.crit = true;
  g.add(body, nose);
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(GEO.seekerFin, MAT.seeker);
    fin.position.z = -0.32;
    fin.rotation.z = i * Math.PI * 2 / 3;
    g.add(fin);
  }
  const flame = noRay(new THREE.Mesh(GEO.seekerFlame, MAT.seekerFlame));
  flame.position.z = -0.66;
  g.add(flame);
  const trail = noRay(new THREE.Mesh(GEO.seekerTrail, MAT.seekerTrail));
  trail.position.z = -0.55;
  g.add(trail);
  g.userData.anim = { flame, trail, phase: Math.random() * Math.PI * 2 };
  g.scale.setScalar(3); // reads as real ordnance, not a dart — and shoot-downable at range
  return g;
}

// A pustulent sac protruding from the boss body; built bulging along +Z so the
// group can be aimed radially outward from the mount point.
const BLISTER_PUSTULES = [ // x, y, z, big
  [0.0, 0.45, 0.78, 1],
  [0.55, -0.25, 0.65, 0],
  [-0.5, 0.1, 0.7, 0],
  [0.3, 0.75, 0.5, 0],
  [-0.25, -0.6, 0.6, 1],
];
function buildBlister() {
  const g = new THREE.Group();
  const sac = new THREE.Mesh(GEO.blisterSac, MAT.blister);
  sac.scale.set(1.0, 1.25, 0.9);
  g.add(sac);
  for (const [x, y, z, big] of BLISTER_PUSTULES) {
    const pustule = new THREE.Mesh(big ? GEO.blisterPustuleBig : GEO.blisterPustule, MAT.blisterPustule);
    pustule.position.set(x, y, z);
    g.add(pustule);
  }
  const vein1 = noRay(new THREE.Mesh(GEO.blisterVein, MAT.blisterVein));
  vein1.rotation.set(0.3, Math.PI / 2, 0);
  const vein2 = noRay(new THREE.Mesh(GEO.blisterVein, MAT.blisterVein));
  vein2.rotation.set(Math.PI / 2, 0, 0.5);
  g.add(vein1, vein2);
  return g;
}

const BUILDERS = { husk: buildHusk, acolyte: buildAcolyte, keeper: buildKeeper, wisp: buildWisp, blister: buildBlister, seeker: buildSeeker };

// One of everything, drawn once at startup so first-spawn buffer uploads and
// program setup never happen mid-fight (the caller disables frustum culling —
// a culled warmup uploads nothing).
export function buildEnemyWarmup() {
  const g = new THREE.Group();
  for (const build of Object.values(BUILDERS)) g.add(build());
  // keeper ward assets (added per-view, so the builders above never draw them)
  g.add(new THREE.Mesh(GEO.keepShield, KEEP_SHIELD_MATS[0]));
  g.add(new THREE.Mesh(GEO.keepTrim, KEEP_TRIM_MATS[0]));
  return g;
}

function makeHpBar() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 12;
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(2.2, 0.22, 1);
  noRay(spr);
  return { spr, c, tex, frac: -1 };
}

export class EnemyManager {
  constructor(scene, targets) {
    this.scene = scene;
    this.targets = targets;   // shared raycast target list
    this.views = new Map();   // id -> view
    this.t = 0;
    this.bossDeathT = -1;
    this.buildBoss();
  }

  buildBoss() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(ENC.bossBodyR, 1),
      new THREE.MeshStandardMaterial({ color: 0x1a1030, roughness: 0.35, metalness: 0.6, emissive: 0x33114f, emissiveIntensity: 0.6 }));
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff9e3d }));
    core.userData.crit = true;
    core.position.z = ENC.bossBodyR * 0.78; // exposed eye-core on the body's face
    // armored socket ring framing the eye (decorative: only body+core are targets)
    const shardMat = new THREE.MeshStandardMaterial({ color: 0x241845, roughness: 0.5, metalness: 0.5, emissive: 0x33114f, emissiveIntensity: 0.4 });
    const socket = noRay(new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.22, 8, 24), shardMat));
    socket.position.z = ENC.bossBodyR * 0.82;
    // jagged shards radiating from the hull, alternating above/below the equator
    const spikeGeo = new THREE.ConeGeometry(0.5, 3.0, 5);
    const spikes = [];
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2 + 0.4;
      const dir = new THREE.Vector3(Math.cos(a), i % 2 ? 0.55 : -0.45, Math.sin(a)).normalize();
      const sp = noRay(new THREE.Mesh(spikeGeo, shardMat));
      sp.position.copy(dir).multiplyScalar(ENC.bossBodyR * 0.92);
      sp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      spikes.push(sp);
    }
    // additive geodesic lattice shell, slowly counter-rotating against the hull
    const lattice = noRay(new THREE.Mesh(new THREE.IcosahedronGeometry(ENC.bossBodyR * 1.06, 1),
      new THREE.MeshBasicMaterial({ color: 0x9d4edd, wireframe: true, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })));
    const ring1 = noRay(new THREE.Mesh(new THREE.TorusGeometry(6.4, 0.25, 8, 48),
      new THREE.MeshStandardMaterial({ color: 0x6d4ab0, emissive: 0x4b2a90, emissiveIntensity: 0.8 })));
    const ring2 = ring1.clone(); ring2.scale.setScalar(1.22); ring2.rotation.x = Math.PI / 3;
    const shield = noRay(new THREE.Mesh(new THREE.SphereGeometry(7.5, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0x7d5fff, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false })));
    // scene-level light (see CLAUDE.md): parenting it to the visibility-toggled
    // boss group changed the light count at encounter start → shader recompile
    const light = new THREE.PointLight(0x9d4edd, 0, 60);
    light.position.set(...ENC.bossPos);
    this.scene.add(light);
    g.add(body, core, socket, lattice, ring1, ring2, shield, ...spikes);
    g.position.set(...ENC.bossPos);
    g.visible = false;
    body.userData.ent = { kind: 'boss' };
    core.userData.ent = { kind: 'boss' };
    this.boss = { g, body, core, lattice, ring1, ring2, shield, light };
    this.scene.add(g);
    this.targets.push(body, core);

    // sweep lasers: two full-diameter beams at shin height (shared material)
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xff3d5e, transparent: true, opacity: 0, depthWrite: false });
    this.beams = [0, 1].map(() => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(76, 0.9, 1.1), beamMat);
      b.raycast = () => {};
      b.position.y = 0.9;
      b.visible = false;
      this.scene.add(b);
      return b;
    });
    this.beamMat = beamMat;
  }

  sync(snap, now) {
    const seen = new Set();
    for (const e of snap.enemies) {
      seen.add(e.id);
      let v = this.views.get(e.id);
      if (!v) {
        const group = BUILDERS[e.ty]();
        group.userData.ent = { kind: 'enemy', id: e.id };
        group.traverse(o => { o.userData.entRoot = group; });
        const hpBar = e.ty === 'keeper' ? makeHpBar() : null; // blisters stay unlabeled
        if (hpBar) { hpBar.spr.position.y = 4.1; group.add(hpBar.spr); }
        let shield = null;
        // only the sky herald carries a ward health pool — that marks it here.
        // It hangs head-down: upright at 19 m the body hides the crit head from
        // everyone below, and inverted levitation reads as held aloft rather
        // than a statue floating on nothing. Roll (z), not pitch, so forward
        // stays +z and the per-frame yaw still faces normally; the flip also
        // drops the hp-bar child to just under the dangling head.
        const sky = e.ty === 'keeper' && e.shp != null;
        if (sky) group.rotation.z = Math.PI;
        if (e.ty === 'keeper') {
          // color-coded ward: bubble + waist trim in the keeper's pedestal color
          const ci = e.cl ?? 0;
          shield = noRay(new THREE.Mesh(GEO.keepShield, KEEP_SHIELD_MATS[ci]));
          shield.position.y = 1.8;
          const trim = noRay(new THREE.Mesh(GEO.keepTrim, KEEP_TRIM_MATS[ci]));
          trim.position.y = 0.6;
          group.add(shield, trim);
        }
        if (e.ty === 'blister') {
          // mounted on the boss: recover the static local offset from the world
          // snapshot pos, then ride the body group as it turns
          const yaw = snap.enc.bossYaw || 0;
          const dx = e.p[0] - ENC.bossPos[0], dz = e.p[2] - ENC.bossPos[2];
          const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
          const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
          const ly = e.p[1] - ENC.bossPos[1];
          group.position.set(lx, ly, lz);
          // bulge radially out of the body — the underbelly mount points down
          group.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(lx, ly, lz).normalize(),
          );
          this.boss.g.add(group);
        } else {
          this.scene.add(group);
        }
        this.targets.push(group);
        v = { group, interp: new Interp(), hpBar, shield, ty: e.ty, sky, bornAt: this.t };
        this.views.set(e.id, v);
        if (this.onSpawn && e.ty !== 'blister') this.onSpawn(e.ty); // sfx hook
      }
      v.sh = !!e.sh; // warded keepers — weapons read this for IMMUNE feedback
      v.shp = e.shp; // herald only: the ward's own (breakable) health
      v.interp.push(e.p, e.yaw, now);
      if (v.hpBar) {
        // while the herald's ward holds, its bar tracks the ward in ward-color
        if (v.sh && e.shp != null && e.smh) this.drawHpBar(v.hpBar, e.shp / e.smh, ARENA.pedestals[e.cl ?? 0].color);
        else this.drawHpBar(v.hpBar, e.hp / e.mh);
      }
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) this.removeView(id, v);
    }
    this.enc = snap.enc;
    this.encAt = now; // arrival time — base for sweep-beam angle extrapolation
  }

  removeView(id, v) {
    if (v.group.parent) v.group.parent.remove(v.group); // scene, or the boss body
    if (v.hpBar) { v.hpBar.tex.dispose(); v.hpBar.spr.material.dispose(); } // per-view canvas
    const i = this.targets.indexOf(v.group);
    if (i >= 0) this.targets.splice(i, 1);
    this.views.delete(id);
  }

  drawHpBar(bar, frac, color = '#c77dff') {
    frac = Math.max(0, Math.min(1, frac));
    if (Math.abs(frac - bar.frac) < 0.01 && bar.col === color) return;
    bar.frac = frac; bar.col = color;
    const g = bar.c.getContext('2d');
    g.clearRect(0, 0, 128, 12);
    g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0, 0, 128, 12);
    g.fillStyle = color; g.fillRect(2, 2, 124 * frac, 8);
    bar.tex.needsUpdate = true;
  }

  update(dt, renderTime, camera) {
    this.t += dt;
    // blister materials are shared by every sac — one pulse drives them all;
    // glows hot once YOUR fire can burst them
    const pulse = this.localEmpowered
      ? 0.9 + Math.sin(this.t * 7) * 0.45
      : 0.25 + Math.sin(this.t * 2) * 0.1;
    MAT.blister.emissiveIntensity = pulse;
    MAT.blisterPustule.emissiveIntensity = pulse * 1.7;
    MAT.blisterVein.emissiveIntensity = pulse * 1.3;
    for (const v of this.views.values()) {
      const a = v.group.userData.anim;
      if (v.ty === 'blister') {
        // static on the boss body (the parent group turns): swell in, then breathe
        const k = Math.min(1, (this.t - v.bornAt) / 0.9);
        const grown = k * k * (3 - 2 * k);
        v.group.scale.setScalar(Math.max(0.01, grown * (1 + Math.sin(this.t * 4 + v.group.position.x) * 0.05)));
        continue;
      }
      const s = v.interp.at(renderTime);
      if (!s) continue;
      v.group.position.set(s.p[0], s.p[1], s.p[2]);
      if (v.sky) {
        // inverted, so the group origin is the upturned feet: lift by the body
        // height (~4) to keep the dangling head where the feet stood — clear of
        // the boss hull below (top ≈ y17.5) — and bob slowly to sell the hang
        v.group.position.y += 4 + Math.sin(this.t * 1.1) * 0.3;
      }
      if (v.ty === 'seeker') {
        // a 3D flier: aim the dart along its snapshot-to-snapshot flight path
        // (yaw alone can't pitch it); keep the old heading while data is thin
        const A = v.interp.a, B = v.interp.b;
        if (A && B) {
          _dir.set(B.p[0] - A.p[0], B.p[1] - A.p[1], B.p[2] - A.p[2]);
          if (_dir.lengthSq() > 1e-6) v.group.quaternion.setFromUnitVectors(_Z, _dir.normalize());
        }
        if (a) {
          a.flame.scale.setScalar(0.75 + Math.sin(this.t * 30 + a.phase) * 0.3);
          a.trail.scale.z = 0.85 + Math.sin(this.t * 21 + a.phase) * 0.18;
        }
        continue;
      }
      v.group.rotation.y = s.yaw;
      if (v.ty === 'husk' && a) {
        // shamble: hop with the legs it doesn't have, claws raking in counter-swing
        const ph = this.t * 9 + a.phase;
        v.group.position.y = Math.abs(Math.sin(ph)) * 0.15;
        const swing = Math.sin(ph) * 0.35;
        a.arms[0].rotation.x = -0.7 + swing;
        a.arms[1].rotation.x = -0.7 - swing;
      }
      if (v.ty === 'acolyte' && a) {
        a.torso.position.y = Math.sin(this.t * 2.2 + a.phase) * 0.07;
        a.emblem.rotation.y += dt * 2.5;
      }
      if (v.ty === 'keeper' && a) {
        a.halo.rotation.y += dt * 0.9;
        a.head.rotation.y += dt * 0.6;
      }
      if (v.ty === 'wisp' && a) {
        a.core.rotation.y += dt * 1.6;
        a.ring1.rotation.z += dt * 1.4;
        a.ring2.rotation.x += dt * 1.1;
        a.ring2.rotation.y += dt * 0.6;
        a.motes.rotation.y += dt * 2.2;
      }
      if (v.shield) {
        v.shield.visible = !!v.sh;
        if (v.sh) v.shield.scale.setScalar(1 + Math.sin(this.t * 3) * 0.05);
      }
    }
    // boss
    const b = this.boss, enc = this.enc;
    if (!enc) return;
    // sweep beams (rotation.y = -angle maps the server's atan2(z,x) convention)
    const sw = enc.sweep;
    if (sw) {
      // raw snapshot angles step at 10 Hz; glide them by extrapolating with the
      // server's constant per-sweep angular velocities at the shared render delay
      const ext = renderTime - this.encAt;
      this.beams[0].visible = this.beams[1].visible = true;
      this.beams[0].rotation.y = -(sw.a1 + (sw.w1 || 0) * ext);
      this.beams[1].rotation.y = -(sw.a2 + (sw.w2 || 0) * ext);
      this.beamMat.opacity = sw.on ? 0.75 : 0.15 + (Math.sin(this.t * 12) + 1) * 0.1;
      this.beamMat.color.set(sw.on ? 0xff3d5e : 0xffb3c0);
    } else if (this.beams[0].visible) {
      this.beams[0].visible = this.beams[1].visible = false;
    }
    if (enc.bossDead) {
      b.light.intensity = 0;
      // death animation: sink, tilt, shrink, then stay hidden until reset
      if (this.bossDeathT === -1 && b.g.visible) this.bossDeathT = this.t;
      if (this.bossDeathT >= 0) {
        const k = Math.min(1, (this.t - this.bossDeathT) / 4);
        b.g.position.y = ENC.bossPos[1] - k * 9;
        b.g.rotation.z += dt * k * 2;
        b.g.scale.setScalar(1 - k * 0.4);
        b.shield.visible = false;
        if (k >= 1) { b.g.visible = false; this.bossDeathT = -2; }
      }
      return;
    }
    this.bossDeathT = -1;
    b.g.visible = enc.st !== 'LOBBY';
    if (!b.g.visible) {
      b.g.scale.setScalar(1); b.g.rotation.z = 0; b.g.position.y = ENC.bossPos[1];
      b.light.intensity = 0;
      return;
    }
    b.g.position.y = ENC.bossPos[1] + Math.sin(this.t * 0.8) * 0.7;
    b.ring1.rotation.x += dt * 0.4; b.ring1.rotation.y += dt * 0.23;
    b.ring2.rotation.y -= dt * 0.31; b.ring2.rotation.z += dt * 0.17;
    b.lattice.rotation.y -= dt * 0.12; b.lattice.rotation.x += dt * 0.07;
    b.shield.visible = !!enc.shield;
    b.shield.material.opacity = 0.10 + Math.sin(this.t * 2.2) * 0.04;
    // core glows when vulnerable; the server owns the facing (it tracks the
    // quarry / marked player), so every client sees the same back side
    const vulnerable = !enc.shield;
    b.core.material.color.set(vulnerable ? 0xffc24d : 0x552b11);
    b.core.scale.setScalar(vulnerable ? 1 + Math.sin(this.t * 5) * 0.12 : 0.7);
    let dy = (enc.bossYaw || 0) - b.g.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    b.g.rotation.y += dy * Math.min(1, dt * 6);
    const final = enc.st === 'FINAL';
    const oblit = enc.st === 'OBLIT';
    if (oblit) {
      // charging Obliteration: white-hot, pulsing faster and faster
      b.body.material.emissive.set(0xffffff);
      b.body.material.emissiveIntensity = 0.9 + Math.sin(this.t * 16) * 0.6;
      b.light.color.set(0xffffff);
      b.light.intensity = 4 + Math.sin(this.t * 16) * 2;
      b.shield.visible = true;
      b.shield.material.opacity = 0.22 + Math.sin(this.t * 16) * 0.1;
    } else {
      b.body.material.emissive.set(final ? 0x801010 : 0x33114f);
      b.body.material.emissiveIntensity = final ? 0.6 + Math.sin(this.t * 8) * 0.4 : 0.6;
      b.light.color.set(final ? 0xff3030 : 0x9d4edd);
      b.light.intensity = 2.2;
    }
  }
}
