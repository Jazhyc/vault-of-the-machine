import * as THREE from 'three';
import { ARENA, ENC } from '/shared/constants.js';
import { SIGIL_SEGMENTS } from '/shared/sigil.js';

const noRay = (o) => { o.raycast = () => {}; return o; };

const PED_COLS = ARENA.pedestals.map(p => new THREE.Color(p.color));
const PILLAR_DEFAULT = new THREE.Color(0x8a5fff);
const SCRAMBLE_CSS = 'rgba(150,200,255,0.9)'; // idle holograms drift in neutral blue
const UP = new THREE.Vector3(0, 1, 0);
const V3 = new THREE.Vector3(); // scratch — never allocate in the render loop
const V3B = new THREE.Vector3();

// Deterministic per-(seed, waypoint) hash → [0, 1). Every client must derive
// the SAME panel-grab jerk path from just the broadcast seed — no Math.random.
const grabHash = (seed, j) => {
  let h = (seed + Math.imul(j, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export function buildWorld(scene, targets) {
  const world = new THREE.Group();
  scene.add(world);

  scene.fog = new THREE.FogExp2(0x0a0614, 0.009);
  scene.background = new THREE.Color(0x07040c);

  const hemi = new THREE.HemisphereLight(0x7a5fc0, 0x140a1e, 1.1);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xbfa8ff, 0.7);
  dir.position.set(20, 40, 10);
  scene.add(dir);
  const fogBase = new THREE.Color(0x0a0614);
  const fogOblit = new THREE.Color(0x3d3556);

  // floor — plain dark base; the Tron light-grid is real geometry (one merged
  // mesh, one draw call), because no affordable texture stays crisp across a
  // 76 m floor seen from standing height
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(ARENA.radius, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x06080f, roughness: 0.85, metalness: 0.3 })
  );
  world.add(floor); targets.push(floor);
  world.add(buildFloorGrid());

  // wall ring — dark panels with glowing light-lines and violet seams
  const wallTex = makeWallTexture();
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA.radius, ARENA.radius, ARENA.wallHeight, 64, 1, true),
    new THREE.MeshStandardMaterial({ map: wallTex, emissiveMap: wallTex, emissive: 0xffffff,
      emissiveIntensity: 0.5, roughness: 0.9, side: THREE.BackSide })
  );
  wall.position.y = ARENA.wallHeight / 2;
  world.add(wall); targets.push(wall);

  // glowing wall trim: violet base line + azure crown line
  const trimGeo = new THREE.TorusGeometry(ARENA.radius - 0.15, 0.09, 8, 96).rotateX(Math.PI / 2);
  const trim = noRay(new THREE.Mesh(trimGeo, new THREE.MeshBasicMaterial({ color: 0x6d4ab0 })));
  trim.position.y = 0.12;
  world.add(trim);
  const crown = noRay(new THREE.Mesh(trimGeo, new THREE.MeshBasicMaterial({ color: 0x1cd3f7 })));
  crown.position.y = ARENA.wallHeight - 0.4;
  world.add(crown);

  // light ring under the Watcher's hover column
  const bossRing = noRay(new THREE.Mesh(
    new THREE.TorusGeometry(5.5, 0.07, 8, 64).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x9d4edd })
  ));
  bossRing.position.y = 0.05;
  world.add(bossRing);

  // pillars — light-banded top and bottom (all pillars share one radius).
  // Each round the sigil assigns every pillar a twin keeper's color: the bands
  // tint to it (cloned materials — color animates per pillar) and an outward
  // panel shows that pillar's fragment of the sky code (row 0 top, col 0 left,
  // exactly the orientation the lattice presents to the arena).
  const pilMat = new THREE.MeshStandardMaterial({ color: 0x1a1230, roughness: 0.6, metalness: 0.45 });
  const pilGlowMat = new THREE.MeshBasicMaterial({ color: 0x8a5fff });
  const pilGeo = new THREE.CylinderGeometry(ARENA.pillars[0].r, ARENA.pillars[0].r * 1.15, ARENA.pillars[0].h, 8);
  const bandGeo = new THREE.TorusGeometry(ARENA.pillars[0].r + 0.06, 0.05, 6, 24).rotateX(Math.PI / 2);
  // holo-socket parts: a hollow housing on the pillar's outward face. The
  // pillar is a tapered 8-sided prism whose surface reaches ~1.83 at panel
  // height and is never actually carved — so the ENTIRE cavity (back plate,
  // hologram, mouth) must sit outboard of 1.83 or the stone occludes it. The
  // back plate doubles as the dark hollow that hides the bulge behind it.
  const socketBackGeo = new THREE.BoxGeometry(2.7, 2.7, 0.12);
  const socketHGeo = new THREE.BoxGeometry(2.7, 0.24, 0.46);
  const socketVGeo = new THREE.BoxGeometry(0.24, 2.22, 0.46);
  const bezelHGeo = new THREE.BoxGeometry(2.58, 0.07, 0.07);
  const bezelVGeo = new THREE.BoxGeometry(0.07, 2.2, 0.07);
  const holoGeo = new THREE.PlaneGeometry(2.0, 2.0);
  const socketMat = new THREE.MeshStandardMaterial({ color: 0x0c0a18, roughness: 0.55, metalness: 0.5 });
  const voidMat = new THREE.MeshBasicMaterial({ color: 0x030309 }); // the dark hollow behind the hologram
  const pillars = ARENA.pillars.map((pil) => {
    const m = new THREE.Mesh(pilGeo, pilMat);
    m.position.set(pil.p[0], pil.h / 2, pil.p[2]);
    world.add(m); targets.push(m);
    const bandMat = pilGlowMat.clone();
    const band = noRay(new THREE.Mesh(bandGeo, bandMat));
    band.position.set(pil.p[0], pil.h - 1.2, pil.p[2]);
    world.add(band);
    const base = noRay(new THREE.Mesh(bandGeo, bandMat));
    base.scale.setScalar(1.12);
    base.position.set(pil.p[0], 0.22, pil.p[2]);
    world.add(base);
    // recessed code socket on the face turned away from the boss: back plate
    // (the hollow), four walls, a glowing bezel at the mouth (tints with the
    // keeper color like the bands), and the hologram floating sunken inside
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const tex = new THREE.CanvasTexture(c);
    const grp = new THREE.Group();
    const back = new THREE.Mesh(socketBackGeo, voidMat);
    back.position.z = 1.84; // front face 1.90 — just clear of the 1.83 stone bulge
    const wallT = new THREE.Mesh(socketHGeo, socketMat);
    wallT.position.set(0, 1.23, 1.99);
    const wallB = new THREE.Mesh(socketHGeo, socketMat);
    wallB.position.set(0, -1.23, 1.99);
    const wallL = new THREE.Mesh(socketVGeo, socketMat);
    wallL.position.set(-1.23, 0, 1.99);
    const wallR = new THREE.Mesh(socketVGeo, socketMat);
    wallR.position.set(1.23, 0, 1.99);
    const holoMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false }); // additive: black paints nothing
    const holo = noRay(new THREE.Mesh(holoGeo, holoMat));
    holo.position.z = 2.0; // floats 0.10 off the dark plate, sunken 0.22 inside the mouth
    const bzT = noRay(new THREE.Mesh(bezelHGeo, bandMat));
    bzT.position.set(0, 1.135, 2.22);
    const bzB = noRay(new THREE.Mesh(bezelHGeo, bandMat));
    bzB.position.set(0, -1.135, 2.22);
    const bzL = noRay(new THREE.Mesh(bezelVGeo, bandMat));
    bzL.position.set(-1.135, 0, 2.22);
    const bzR = noRay(new THREE.Mesh(bezelVGeo, bandMat));
    bzR.position.set(1.135, 0, 2.22);
    grp.add(back, wallT, wallB, wallL, wallR, holo, bzT, bzB, bzL, bzR);
    const or = Math.hypot(pil.p[0], pil.p[2]);
    const ox = pil.p[0] / or, oz = pil.p[2] / or;
    grp.position.set(pil.p[0], 5.0, pil.p[2]);
    grp.lookAt(pil.p[0] + ox * 50, 5.0, pil.p[2] + oz * 50);
    grp.traverse(o => { o.frustumCulled = false; }); // warm frame must upload all six
    world.add(grp); targets.push(grp);
    return { bandMat, c, tex, holoMat };
  });
  // paint the idle lattice now so all six texture uploads land in the boot
  // warm frame, not the first MECH frame
  pillars.forEach(pl => paintPanel(pl, null, null));

  // gates (enemy spawn doors) — framed in glowing edge-lines
  const gateMat = new THREE.MeshStandardMaterial({ color: 0x141026, roughness: 0.75, metalness: 0.3 });
  const gateGlowMat = new THREE.MeshBasicMaterial({ color: 0x4cc9f0 });
  const gateFrameGeo = new THREE.BoxGeometry(6, 7, 1);
  const portalGeo = new THREE.PlaneGeometry(4.4, 5.6);
  const gateBarGeo = new THREE.BoxGeometry(6.2, 0.12, 0.16);
  const gatePostGeo = new THREE.BoxGeometry(0.12, 7.1, 0.16);
  for (const g of ARENA.gates) {
    const gate = new THREE.Group();
    const frame = new THREE.Mesh(gateFrameGeo, gateMat);
    frame.position.y = 3.5;
    const portal = noRay(new THREE.Mesh(portalGeo,
      new THREE.MeshBasicMaterial({ color: 0x3b1f66, transparent: true, opacity: 0.85 })));
    portal.position.set(0, 3, 0.51); // faces arena center (lookAt points +Z inward)
    const lintel = noRay(new THREE.Mesh(gateBarGeo, gateGlowMat));
    lintel.position.set(0, 7.05, 0.45);
    const postL = noRay(new THREE.Mesh(gatePostGeo, gateGlowMat));
    postL.position.set(-3.05, 3.55, 0.45);
    const postR = postL.clone();
    postR.position.x = 3.05;
    gate.add(frame, portal, lintel, postL, postR);
    // recessed into the arena wall — a doorway in the wall, not a free-standing
    // structure in the playfield (spawns still anchor to ARENA.gates positions,
    // so adds step out of the portal into the arena)
    const gr = Math.hypot(g.p[0], g.p[2]);
    const flush = (ARENA.radius - 0.45) / gr;
    gate.position.set(g.p[0] * flush, 0, g.p[2] * flush);
    gate.lookAt(0, 0, 0);
    world.add(gate); targets.push(frame);
  }

  // pedestals (Resonance Locks)
  const pedestals = ARENA.pedestals.map((ped) => {
    const grp = new THREE.Group();
    const col = new THREE.Color(ped.color);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.0, 1.0, 8),
      new THREE.MeshStandardMaterial({ color: 0x221540, roughness: 0.6 }));
    base.position.y = 0.5;
    const crystal = noRay(new THREE.Mesh(new THREE.OctahedronGeometry(0.65),
      new THREE.MeshBasicMaterial({ color: col })));
    crystal.position.y = 2.0;
    const beam = noRay(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 40, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false })));
    beam.position.y = 20;
    const ringFloor = noRay(new THREE.Mesh(new THREE.RingGeometry(2.2, 2.6, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5, depthWrite: false })));
    ringFloor.position.y = 0.02;
    const light = new THREE.PointLight(col, 0, 18);
    light.position.y = 3;
    grp.add(base, crystal, beam, ringFloor, light);
    grp.position.set(ped.p[0], 0, ped.p[2]);
    world.add(grp); targets.push(base);
    return { grp, crystal, beam, ringFloor, light, baseColor: col };
  });

  // center ready plate
  const plate = noRay(new THREE.Mesh(new THREE.RingGeometry(3.0, 4.0, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.35, depthWrite: false })));
  plate.position.y = 0.03;
  world.add(plate);

  // sky sigil lattice — a vertical 3x3 constellation in the northern sky,
  // beyond the wall. Vertical on purpose: a flat overhead grid has no "top
  // row" (it rotates with the viewer's heading), so the pillar panels could
  // never be matched to it unambiguously. Everything starts visible so the
  // boot warm frame uploads/compiles it, then update() hides it.
  const sigil = buildSigilLattice(targets);
  world.add(sigil.group);

  // wormhole + the falling lance (visible through MISSILE/DAMAGE via update)
  const wormhole = buildWormhole();
  world.add(wormhole.group);
  const missile = buildMissile();
  world.add(missile.group);

  // lattice-strike rigs (2 — one per twin, codes can land back to back): the
  // matched code's stars beam into a focal dot in front of the lattice, then
  // the dot lasers the keeper until the server's blast lands. Built visible so
  // the warm frame uploads them; update() hides idle rigs.
  const strikeFocus = (() => {
    const origin = new THREE.Vector3(...ENC.sigil.gridPos);
    const dir = new THREE.Vector3(0, 6, 0).sub(origin).normalize();
    return origin.addScaledVector(dir, 8); // a step out of the plane, toward the arena
  })();
  const strikeRigs = [0, 1].map(() => {
    const beamMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const beamGeo = new THREE.BufferGeometry();
    beamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 2 * 3), 3));
    const beams = noRay(new THREE.LineSegments(beamGeo, beamMat));
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const dot = noRay(new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), dotMat));
    dot.position.copy(strikeFocus);
    const laserMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85,
      depthWrite: false, fog: false });
    const laser = noRay(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1, 8, 1, true), laserMat));
    for (const o of [beams, dot, laser]) { o.frustumCulled = false; world.add(o); }
    return { beams, beamMat, dot, dotMat, laser, laserMat, active: false,
      // per-rig focal point: the panel can have been dragged anywhere on the
      // sky-ring, so the dot gathers in front of wherever it sits at match time
      focus: strikeFocus.clone(), target: new THREE.Vector3() };
  });

  // boss panel-grab tether: ONE persistent beam from the Watcher to a lattice
  // handle while a grab runs. Built visible so the warm frame uploads it; the
  // first update() hides it.
  const grabMat = new THREE.MeshBasicMaterial({ color: 0xff5a4d, transparent: true, opacity: 0.8,
    depthWrite: false, fog: false });
  const grabBeam = noRay(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1, 8, 1, true), grabMat));
  grabBeam.frustumCulled = false;
  world.add(grabBeam);
  let grab = null;    // live grab event { at, dur, seed, a0, a1 } — replayed off server time
  let grabTheta = 0;  // panel's current sky-ring offset (rad, 0 = north)
  // the lattice rides a fixed ring around the arena: radius + base azimuth of gridPos
  const GRID_R = Math.hypot(ENC.sigil.gridPos[0], ENC.sigil.gridPos[2]);
  const GRID_AZ = Math.atan2(ENC.sigil.gridPos[0], ENC.sigil.gridPos[2]);

  // stars
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(900 * 3);
  for (let i = 0; i < 900; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(250 + Math.random() * 150);
    v.y = Math.abs(v.y) + 10;
    starPos.set([v.x, v.y, v.z], i * 3);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = noRay(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xb9a8e8, size: 0.7, fog: false })));
  world.add(stars);

  let t = 0;
  let litT = 0; // 0 = dim lobby, 1 = bright combat lighting
  let sigKey = '';            // round signature — repaint panels when it turns
  const panelQueue = [];      // staggered repaints: canvas uploads burst-stall the GPU
  let scrambleAt = 0, scrambleIdx = 0; // idle hologram drift
  let gridActive = true;      // built live for the warm frame; first update() disarms it
  let wormT = 0;              // wormhole open/close ease
  const burnedCol = new THREE.Color(0xc02035);
  const deadCrystal = new THREE.Color(0x3a2a35);
  return {
    pedestals, plate,
    // Launch the strike FX for a matched code: the code's lit stars beam into
    // the focal dot, which then lasers the keeper. getTarget() is polled each
    // frame for the keeper's current position; timing mirrors the server's
    // strikeDelay so the blast event lands as the laser bites.
    sigilStrike(code, colorIdx, getTarget) {
      const rig = strikeRigs.find(r => !r.active) || strikeRigs[0];
      rig.active = true;
      rig.t0 = t;
      rig.getTarget = getTarget;
      rig.target.set(0, 3, 0);
      // gather a step out of the panel's CURRENT plane, toward the arena
      rig.focus.copy(sigil.group.position);
      V3.set(0, 6, 0).sub(rig.focus).normalize();
      rig.focus.addScaledVector(V3, 8);
      rig.dot.position.copy(rig.focus);
      const col = PED_COLS[colorIdx] || PILLAR_DEFAULT;
      rig.beamMat.color.copy(col);
      rig.dotMat.color.copy(col);
      rig.laserMat.color.copy(col);
      const pos = rig.beams.geometry.attributes.position;
      let n = 0;
      for (let i = 0; i < 9; i++) {
        if (!(code & (1 << i))) continue;
        V3.copy(sigil.nodes[i].mesh.position);
        sigil.group.localToWorld(V3);
        pos.setXYZ(n * 2, V3.x, V3.y, V3.z);
        pos.setXYZ(n * 2 + 1, rig.focus.x, rig.focus.y, rig.focus.z);
        n++;
      }
      for (; n < 9; n++) { // collapse unused segments — they draw nothing
        pos.setXYZ(n * 2, rig.focus.x, rig.focus.y, rig.focus.z);
        pos.setXYZ(n * 2 + 1, rig.focus.x, rig.focus.y, rig.focus.z);
      }
      pos.needsUpdate = true;
    },
    // The boss tethers the panel: stash the event, update() replays the path.
    latticeGrab(m) { grab = m; },
    update(dt, enc, serverNow) {
      t += dt;
      const sig = enc ? enc.sig : null;

      // --- sky lattice: live only while the twin wards stand ---
      const wantGrid = !!(sig && enc.st === 'MECH' && enc.stage === 'KEEPERS');
      if (wantGrid !== gridActive) {
        gridActive = wantGrid;
        sigil.group.visible = wantGrid;
        sigil.setActive(wantGrid); // invisible stars must not eat raycasts
      }
      if (gridActive) {
        for (let i = 0; i < 9; i++) {
          const on = !!(sig.g & (1 << i));
          const n = sigil.nodes[i];
          if (n.on !== on) {
            n.on = on;
            n.mesh.material = on ? sigil.onMat : sigil.offMat;
            n.halo.material = on ? sigil.haloOnMat : sigil.haloOffMat;
          }
          n.mesh.scale.setScalar(on ? 1 + Math.sin(t * 6 + i) * 0.12 : 1);
        }
      }

      // --- boss panel-grab: the tether seizes a handle and drags the whole
      // lattice around the arena's sky-ring, jerking along the arc — and the
      // panel RESTS where it lands (snapshot sig.ga). Driven by server time so
      // every guardian watches the same motion; node raycasts ride along free
      // (hits are world-matrix based, and only the index is reported anyway).
      let grabbing = false;
      if (!gridActive) grab = null;
      if (grab && serverNow != null) {
        const age = serverNow - grab.at;
        if (age >= 0 && age <= grab.dur) {
          grabbing = true;
          // waypoints march from a0 to a1 with seeded wobble; each step lunges
          // in its first quarter, then dwells — abrupt, pure fn of (seed, age)
          const step = ENC.sigil.grabStep, jit = ENC.sigil.grabJitter;
          const N = Math.max(1, Math.ceil(grab.dur / step));
          const j = Math.floor(age / step), f = age / step - j;
          const wp = (n) => n <= 0 ? grab.a0 : n >= N ? grab.a1
            : grab.a0 + (grab.a1 - grab.a0) * (n / N) + (grabHash(grab.seed, n) * 2 - 1) * jit;
          const k = Math.min(1, f / 0.25), s = k * k * (3 - 2 * k);
          grabTheta = wp(j) + (wp(j + 1) - wp(j)) * s;
        } else if (age > grab.dur) grab = null;
      }
      if (!grabbing) {
        const rest = (sig && sig.ga) || 0;
        if (gridActive) grabTheta += (rest - grabTheta) * Math.min(1, dt * 2.5); // settles onto its perch
        else grabTheta = rest; // hidden: snap, no invisible glide
      }
      const az = GRID_AZ + grabTheta;
      sigil.group.position.set(Math.sin(az) * GRID_R, ENC.sigil.gridPos[1], Math.cos(az) * GRID_R);
      sigil.group.lookAt(0, 6, 0); // re-faces the arena as it rides — codes stay readable
      grabBeam.visible = grabbing;
      if (grabbing) {
        // the tether bites the handle on the seed's side and thrums
        const hand = sigil.handles[grab.seed & 1].getWorldPosition(V3B);
        V3.set(ENC.bossPos[0], ENC.bossPos[1] + 2, ENC.bossPos[2]);
        const len = V3.distanceTo(hand);
        grabBeam.position.copy(V3).add(hand).multiplyScalar(0.5);
        const thrum = 1 + Math.sin(t * 34) * 0.3;
        grabBeam.scale.set(thrum, len, thrum);
        grabBeam.quaternion.setFromUnitVectors(UP, hand.sub(V3).normalize());
        grabMat.opacity = 0.55 + Math.sin(t * 21) * 0.25;
      }

      // --- pillar panels & band tints follow the round's sigil ---
      // Codes render only while the twin wards stand; before the keepers
      // arrive (and once a code is spent) the holograms drift through random
      // ghost patterns instead of leaking the layout early.
      const colorsLive = !!(sig && enc.st === 'MECH' && enc.stage);
      const codePillar = (i) => colorsLive && enc.stage === 'KEEPERS' && !sig.m[sig.o[i]];
      const key = colorsLive
        ? `${enc.stage === 'KEEPERS' ? sig.m.join() : 'spent'}|${sig.c.join()}|${sig.o.join()}|${sig.s.map(s => s.join('.')).join()}`
        : '';
      if (key !== sigKey) {
        sigKey = key;
        panelQueue.length = 0;
        for (let i = 0; i < pillars.length; i++) panelQueue.push(i);
      }
      const ghostSeg = () => SIGIL_SEGMENTS[(Math.random() * SIGIL_SEGMENTS.length) | 0];
      for (let k = 0; k < 2 && panelQueue.length; k++) {
        const i = panelQueue.shift();
        if (codePillar(i)) paintPanel(pillars[i], sig.s[i], ARENA.pedestals[sig.c[sig.o[i]]].color);
        else paintPanel(pillars[i], ghostSeg(), SCRAMBLE_CSS, true);
      }
      // idle holograms re-scramble one at a time (a canvas upload each — never burst)
      if (t >= scrambleAt && !panelQueue.length) {
        scrambleAt = t + 0.14;
        scrambleIdx = (scrambleIdx + 1) % pillars.length;
        if (!codePillar(scrambleIdx)) paintPanel(pillars[scrambleIdx], ghostSeg(), SCRAMBLE_CSS, true);
      }
      pillars.forEach((pl, i) => {
        const want = colorsLive ? PED_COLS[sig.c[sig.o[i]]] : PILLAR_DEFAULT;
        pl.bandMat.color.lerp(want, Math.min(1, dt * 3));
        // holographic shimmer
        pl.holoMat.opacity = 0.88 + Math.sin(t * 13 + i * 2.3) * 0.07 + Math.sin(t * 4.7 + i) * 0.05;
      });

      // --- lattice strikes: stars → focal dot → laser → (server blast) ---
      const D = ENC.sigil.strikeDelay, cEnd = D * 0.55;
      for (const rig of strikeRigs) {
        if (!rig.active) {
          if (rig.dot.visible) { rig.beams.visible = rig.dot.visible = rig.laser.visible = false; }
          continue;
        }
        const age = t - rig.t0;
        if (age > D + 0.25) { rig.active = false; continue; }
        const tp = rig.getTarget && rig.getTarget();
        if (tp) rig.target.set(tp.x, tp.y + 2, tp.z);
        if (age < cEnd) {
          // the code's stars pour into the focal dot
          const k = age / cEnd;
          rig.beams.visible = rig.dot.visible = true;
          rig.laser.visible = false;
          rig.beamMat.opacity = 0.25 + k * 0.75;
          rig.dot.scale.setScalar(0.25 + k * 1.6);
        } else {
          // the gathered dot lasers the keeper until the blast lands
          rig.beams.visible = false;
          rig.dot.visible = rig.laser.visible = true;
          rig.dot.scale.setScalar(1.85 + Math.sin(t * 22) * 0.25);
          const len = rig.focus.distanceTo(rig.target);
          rig.laser.position.copy(rig.focus).add(rig.target).multiplyScalar(0.5);
          rig.laser.scale.set(1 + Math.sin(t * 30) * 0.25, len, 1 + Math.sin(t * 30) * 0.25);
          rig.laser.quaternion.setFromUnitVectors(
            UP, V3.copy(rig.target).sub(rig.focus).normalize());
        }
      }

      // --- wormhole + the falling lance ---
      wormT += (((enc && enc.wh) ? 1 : 0) - wormT) * Math.min(1, dt * 3.5);
      wormhole.group.visible = wormT > 0.02;
      if (wormhole.group.visible) {
        wormhole.group.scale.setScalar(Math.max(0.01, wormT));
        wormhole.swirl1.rotation.y += dt * 1.9; // arcs spin in the horizontal plane
        wormhole.swirl2.rotation.y -= dt * 1.3;
        wormhole.rim.scale.setScalar(1 + Math.sin(t * 5) * 0.04);
      }
      const dropping = enc && enc.st === 'MECH' && enc.stage === 'MISSILE' && enc.mAt && serverNow != null;
      missile.group.visible = !!dropping;
      if (dropping) {
        const k = Math.max(0, Math.min(1, 1 - (enc.mAt - serverNow) / ENC.sigil.missileFall));
        const y0 = ENC.sigil.wormholePos[1], y1 = ENC.bossPos[1] + 3;
        missile.group.position.y = y0 + (y1 - y0) * k * k; // it falls hungrily
      }

      // the arena lights up when the encounter starts (visibility in combat)
      const active = enc && enc.st !== 'LOBBY';
      litT += ((active ? 1 : 0) - litT) * Math.min(1, dt * 1.2);
      pedestals.forEach((pd, i) => {
        // the herald's lock blazes as the place to ground its ward
        const lit = !!(enc && enc.st === 'MECH' && enc.stage === 'FINAL' && sig && sig.c[2] === i);
        const burned = !!(enc && enc.burned && enc.burned.includes(i));
        pd.beam.visible = lit;
        pd.light.intensity = lit ? 2.5 + Math.sin(t * 6) * 0.8 : 0;
        const k = Math.min(1, dt * 2.5);
        if (burned) {
          // collapsed refuge: the crystal tumbles off the pedestal and lies dead
          pd.crystal.position.x += (1.8 - pd.crystal.position.x) * k;
          pd.crystal.position.y += (0.45 - pd.crystal.position.y) * k;
          pd.crystal.rotation.z += (1.35 - pd.crystal.rotation.z) * k;
          pd.crystal.material.color.lerp(deadCrystal, k);
        } else {
          pd.crystal.position.x += (0 - pd.crystal.position.x) * k;
          pd.crystal.rotation.z += (0 - pd.crystal.rotation.z) * k;
          pd.crystal.rotation.y += dt * (lit ? 3 : 0.5);
          pd.crystal.position.y = 2.0 + Math.sin(t * 2 + i) * 0.15;
          pd.crystal.material.color.copy(pd.baseColor);
        }
        // ...and the floor ring scars red
        pd.ringFloor.material.color.copy(burned ? burnedCol : pd.baseColor);
        pd.ringFloor.material.opacity = lit ? 0.5 + Math.sin(t * 6) * 0.25 : burned ? 0.45 : 0.18;
      });
      const lobby = enc && enc.st === 'LOBBY';
      plate.visible = !!lobby;
      if (lobby) plate.material.opacity = 0.25 + Math.sin(t * 3) * 0.15;

      // Obliteration wind-up: the whole arena outside the wells blanches and pulses
      const oblit = enc && enc.st === 'OBLIT';
      if (oblit) {
        const pulse = Math.sin(t * 14) * 0.5 + 0.5;
        hemi.intensity = 1.1 + pulse * 2.2;
        hemi.color.setHex(0xfff6ff);
        scene.fog.color.copy(fogBase).lerp(fogOblit, 0.4 + pulse * 0.6);
      } else {
        hemi.intensity = 1.1 + litT * 0.55;
        hemi.color.setHex(0x7a5fc0);
        dir.intensity = 0.7 + litT * 0.4;
        scene.fog.color.copy(fogBase);
      }
    },
  };
}

// The Tron floor grid as real geometry: one merged mesh, one draw call.
// Each line is a single strip whose vertex colors fade from a bright
// centerline out to the floor color — the gradient IS the glow. No stacked
// glow/core quads (coplanar layers z-fought and flickered), and polygonOffset
// settles the grid-vs-floor depth race at all distances (a few cm of height
// can't — the 0.05 near plane leaves no depth precision 30 m out).
function buildFloorGrid() {
  const verts = [], cols = [], idx = [];
  const EDGE = [0, 0, 0]; // additive blending: black adds nothing — perfect fade
  const BRIGHT = 0.5;     // grid is set dressing — projectiles/pickups must outshine it
  const section = (x, z, dirX, dirZ, halfW, c) => {
    verts.push(x - dirX * halfW, 0, z - dirZ * halfW, x, 0, z, x + dirX * halfW, 0, z + dirZ * halfW);
    cols.push(...EDGE, c[0] * BRIGHT, c[1] * BRIGHT, c[2] * BRIGHT, ...EDGE);
  };
  const join = (base, i) => { // bridge two 3-vertex cross-sections
    const v = base + i * 3;
    idx.push(v, v + 3, v + 1, v + 1, v + 3, v + 4);
    idx.push(v + 1, v + 4, v + 2, v + 2, v + 4, v + 5);
  };
  const ring = (r, halfW, c, segs = 96) => {
    const base = verts.length / 3;
    for (let i = 0; i <= segs; i++) {
      const a = i / segs * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      section(ca * r, sa * r, ca, sa, halfW, c);
    }
    for (let i = 0; i < segs; i++) join(base, i);
  };
  const spoke = (ang, r0, r1, halfW, c) => {
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const base = verts.length / 3;
    section(dx * r0, dz * r0, -dz, dx, halfW, c);
    section(dx * r1, dz * r1, -dz, dx, halfW, c);
    join(base, 0);
  };
  // tiered density: a calm zone around the hub, majors from mid-field, minors
  // only in the outer field — 48 spokes converging on the center was visual
  // noise (and near-overlapping geometry)
  for (let r = 9; r <= 36; r += 4.5) ring(r, 0.34, [0.3, 0.72, 0.85]);
  for (let a = 0; a < 12; a++) {
    spoke(a * Math.PI / 6, 6.0, 37.3, 0.22, [0.18, 0.5, 0.62]);
    spoke(a * Math.PI / 6 + Math.PI / 12, 13.5, 37.3, 0.15, [0.08, 0.26, 0.34]);
  }
  // violet hub ring under the boss column
  ring(4.0, 0.44, [0.62, 0.45, 0.85]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.setIndex(idx);
  // Additive + no depth write: where lines cross they sum into a bright node
  // instead of z-fighting (coplanar strips with depth writes flickered at
  // every ring×spoke intersection).
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  mesh.position.y = 0.02;
  return noRay(mesh);
}

// The 3x3 star lattice: nine shootable star-nodes (row-major, row 0 = top,
// col 0 = left as seen from the arena) joined by a faint frame. Node meshes
// carry userData.ent = { kind:'node', i } and live in the raycast targets;
// setActive() swaps their raycast in/out so the hidden lattice can't eat shots.
// All shared materials/geometry — nodes light up by material swap, not clones.
function buildSigilLattice(targets) {
  const group = new THREE.Group();
  const gap = ENC.sigil.gridGap;
  const offMat = new THREE.MeshBasicMaterial({ color: 0x37406e, fog: false });
  const onMat = new THREE.MeshBasicMaterial({ color: 0xffeebb, fog: false });
  const haloOffMat = new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.10, fog: false, depthWrite: false });
  const haloOnMat = new THREE.MeshBasicMaterial({ color: 0xffd24d, transparent: true, opacity: 0.32, fog: false, depthWrite: false });
  const nodeGeo = new THREE.SphereGeometry(1.35, 14, 10);
  const haloGeo = new THREE.SphereGeometry(2.2, 14, 10);
  const protoRaycast = THREE.Mesh.prototype.raycast;
  const nodes = [];
  for (let i = 0; i < 9; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    const mesh = new THREE.Mesh(nodeGeo, offMat);
    mesh.position.set((col - 1) * gap, (1 - row) * gap, 0);
    mesh.userData.ent = { kind: 'node', i };
    mesh.frustumCulled = false; // must draw in the boot warm frame
    const halo = noRay(new THREE.Mesh(haloGeo, haloOffMat));
    halo.frustumCulled = false;
    mesh.add(halo);
    group.add(mesh);
    targets.push(mesh);
    nodes.push({ mesh, halo, on: false });
  }
  const framePts = [];
  for (let r = 0; r < 3; r++) framePts.push(-gap, (1 - r) * gap, 0, gap, (1 - r) * gap, 0);
  for (let c = 0; c < 3; c++) framePts.push((c - 1) * gap, gap, 0, (c - 1) * gap, -gap, 0);
  const frameGeo = new THREE.BufferGeometry();
  frameGeo.setAttribute('position', new THREE.Float32BufferAttribute(framePts, 3));
  const frame = noRay(new THREE.LineSegments(frameGeo,
    new THREE.LineBasicMaterial({ color: 0x35406e, transparent: true, opacity: 0.45, fog: false })));
  frame.frustumCulled = false;
  group.add(frame);

  // The panel reads as a physical object the boss can seize: a faint backing
  // plate, a bright border, and grab-handles standing off each side edge.
  // None of it is shootable — only the star nodes live in `targets`.
  const ext = gap + 3.2; // panel half-extent beyond the node grid
  const plate = noRay(new THREE.Mesh(new THREE.PlaneGeometry(ext * 2, ext * 2),
    new THREE.MeshBasicMaterial({ color: 0x131c42, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide })));
  plate.position.z = -0.6; // behind the node plane — never coplanar with it
  plate.frustumCulled = false;
  group.add(plate);
  const borderPts = [];
  const corners = [[-ext, ext], [ext, ext], [ext, -ext], [-ext, -ext]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 4];
    borderPts.push(ax, ay, 0, bx, by, 0);
  }
  const borderGeo = new THREE.BufferGeometry();
  borderGeo.setAttribute('position', new THREE.Float32BufferAttribute(borderPts, 3));
  const border = noRay(new THREE.LineSegments(borderGeo,
    new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.8, fog: false })));
  border.frustumCulled = false;
  group.add(border);
  const handleMat = new THREE.MeshBasicMaterial({ color: 0x5fd7ff, fog: false });
  const barGeo = new THREE.CylinderGeometry(0.45, 0.45, gap * 1.5, 8);
  const armGeo = new THREE.CylinderGeometry(0.3, 0.3, 2.4, 6).rotateZ(Math.PI / 2);
  const handles = [-1, 1].map((side) => {
    const h = new THREE.Group();
    const bar = noRay(new THREE.Mesh(barGeo, handleMat));
    bar.frustumCulled = false;
    h.add(bar);
    for (const y of [-gap * 0.55, gap * 0.55]) {
      const arm = noRay(new THREE.Mesh(armGeo, handleMat));
      arm.position.set(-side * 1.2, y, 0); // reaches back to the panel edge
      arm.frustumCulled = false;
      h.add(arm);
    }
    h.position.set(side * (ext + 1.6), 0, 0);
    group.add(h);
    return h;
  });

  group.position.set(...ENC.sigil.gridPos);
  group.lookAt(0, 6, 0); // gently tilted down toward the arena floor
  return {
    group, nodes, handles, offMat, onMat, haloOffMat, haloOnMat,
    setActive(on) { for (const n of nodes) n.mesh.raycast = on ? protoRaycast : () => {}; },
  };
}

// Swirling tear high above the Watcher, parallel to the arena floor: a dark
// flattened lens seen from below, a bright horizontal rim, and two partial-arc
// swirls counter-rotating in the plane (full tori are rotationally symmetric —
// a spinning arc is what reads as motion). Opens for the lance, lingers
// through the damage phase feeding capsules down. No lights — basics only.
function buildWormhole() {
  const group = new THREE.Group();
  const core = noRay(new THREE.Mesh(new THREE.SphereGeometry(6.2, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0x070412, fog: false })));
  core.scale.y = 0.22;
  const rim = noRay(new THREE.Mesh(new THREE.TorusGeometry(7.4, 0.4, 10, 48).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x5ab7ff, fog: false })));
  const swirlMat = new THREE.MeshBasicMaterial({ color: 0x9d4edd, transparent: true, opacity: 0.7, fog: false, depthWrite: false });
  const swirl1 = noRay(new THREE.Mesh(
    new THREE.TorusGeometry(9.0, 0.18, 8, 48, Math.PI * 1.5).rotateX(Math.PI / 2), swirlMat));
  const swirl2 = noRay(new THREE.Mesh(
    new THREE.TorusGeometry(10.6, 0.12, 8, 48, Math.PI * 1.2).rotateX(Math.PI / 2), swirlMat));
  swirl2.rotation.x = 0.07; // a hair off-plane so the outer arc shimmers
  group.add(core, rim, swirl1, swirl2);
  group.traverse(o => { o.frustumCulled = false; });
  group.position.set(...ENC.sigil.wormholePos);
  return { group, rim, swirl1, swirl2 };
}

// The shield-breaker lance that drops from the wormhole onto the boss.
function buildMissile() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0xbfe6ff, fog: false });
  const body = noRay(new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.5, 2.6, 10), bodyMat));
  const tip = noRay(new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.2, 10).rotateX(Math.PI), bodyMat));
  tip.position.y = -1.9;
  const halo = noRay(new THREE.Mesh(new THREE.SphereGeometry(1.2, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0x5ab7ff, transparent: true, opacity: 0.35, fog: false, depthWrite: false })));
  group.add(body, tip, halo);
  group.traverse(o => { o.frustumCulled = false; });
  group.position.set(ENC.sigil.wormholePos[0], ENC.sigil.wormholePos[1], ENC.sigil.wormholePos[2]);
  return { group };
}

// One pillar's fragment of a sky code: the 3x3 dot lattice with this pillar's
// line segment drawn through it in the owning keeper's color. Same orientation
// as the lattice in the sky (row 0 top, col 0 left). Painted on black for the
// additive hologram material (black adds nothing → only the light shows);
// ghost=true draws the dim drifting noise patterns shown while no code is live.
function paintPanel(pl, seg, colorCss, ghost = false) {
  const g = pl.c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 128);
  // scanlines + frame sell the projection
  g.fillStyle = 'rgba(90,150,255,0.13)';
  for (let y = 2; y < 128; y += 5) g.fillRect(0, y, 128, 2);
  g.strokeStyle = 'rgba(120,180,255,0.7)';
  g.lineWidth = 2;
  g.strokeRect(5, 5, 118, 118);
  const xy = (i) => [24 + (i % 3) * 40, 24 + Math.floor(i / 3) * 40];
  g.fillStyle = 'rgba(130,180,255,0.65)';
  for (let i = 0; i < 9; i++) {
    const [x, y] = xy(i);
    g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
  }
  if (seg) {
    const [x0, y0] = xy(seg[0]);
    const [x1, y1] = xy(seg[seg.length - 1]);
    g.globalAlpha = ghost ? 0.4 : 1;
    g.strokeStyle = colorCss; g.lineWidth = ghost ? 5 : 9; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.fillStyle = ghost ? colorCss : '#ffffff';
    for (const i of seg) {
      const [x, y] = xy(i);
      g.beginPath(); g.arc(x, y, ghost ? 5 : 7, 0, 7); g.fill();
    }
    g.globalAlpha = 1;
  }
  pl.tex.needsUpdate = true;
}

// Dark wall panels: horizontal azure light-lines + faint violet seams.
function makeWallTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#070a14'; g.fillRect(0, 0, 1024, 512);
  const line = (y, w, style) => {
    g.strokeStyle = style; g.lineWidth = w;
    g.beginPath(); g.moveTo(0, y); g.lineTo(1024, y); g.stroke();
  };
  for (const y of [88, 256, 412]) {
    line(y, 18, 'rgba(28,211,247,0.10)');
    line(y, 4, 'rgba(125,235,255,0.5)');
  }
  for (let x = 64; x < 1024; x += 128) {
    g.strokeStyle = 'rgba(157,78,221,0.25)'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 512); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(6, 1);
  tex.anisotropy = 8;
  return tex;
}

// Player movement collision helpers (pure math, used by player.js).
export function collidePlayer(pos, radius = 0.8) {
  const r = Math.hypot(pos.x, pos.z);
  const max = ARENA.radius - radius - 0.2;
  if (r > max) { pos.x *= max / r; pos.z *= max / r; }
  for (const pil of ARENA.pillars) {
    const dx = pos.x - pil.p[0], dz = pos.z - pil.p[2];
    const d = Math.hypot(dx, dz), min = pil.r + radius;
    if (d < min && d > 0.001 && pos.y < pil.h) {
      pos.x = pil.p[0] + dx / d * min;
      pos.z = pil.p[2] + dz / d * min;
    }
  }
}
