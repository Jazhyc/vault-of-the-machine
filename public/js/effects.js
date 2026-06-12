import * as THREE from 'three';
import { SUPER } from '/shared/constants.js';

const noRay = (o) => { o.raycast = () => {}; return o; };

// Spiral ribbon (two arms, two turns) for the voidcaller vortex disc, wound
// from the rim down into the core. Vertex colors ramp black→bright along the
// arm: with additive blending black is invisible, so the tail fades out for
// free (no per-vertex-opacity shader needed).
function vortexDiscGeo() {
  const steps = 64, turns = 2;
  const pos = [], col = [], idx = [];
  for (let arm = 0; arm < 2; arm++) {
    const a0 = arm * Math.PI, base = (steps + 1) * 2 * arm;
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;                      // 0 rim → 1 core
      const a = a0 + k * turns * 2 * Math.PI;
      const rad = 0.95 - 0.8 * k;
      const half = 0.16 * (1 - 0.45 * k);       // the arm thins as it falls in
      const dip = -0.22 * k;                    // funnel toward the singularity
      pos.push(Math.cos(a) * (rad + half), dip, Math.sin(a) * (rad + half),
               Math.cos(a) * (rad - half), dip, Math.sin(a) * (rad - half));
      const b = 0.1 + 0.9 * k * k;              // bright at the core, dark tail
      col.push(b, b, b, b, b, b);
      if (i < steps) { const o = base + i * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

function numberSprite() {
  const c = document.createElement('canvas');
  c.width = 192; c.height = 80;
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  spr.visible = false;
  return { spr, c, tex, life: 0, vel: null };
}

export class Effects {
  constructor(scene) {
    this.scene = scene;
    // frustumCulled=false on all pool objects: guarantees the boot warmup frame
    // actually draws them, and short-lived effects never pop out at screen edges
    this.numbers = Array.from({ length: 36 }, () => {
      const n = numberSprite();
      noRay(n.spr);
      n.spr.frustumCulled = false;
      scene.add(n.spr);
      return n;
    });
    this.numIdx = 0;

    // Pooled, and the lights live DIRECTLY in the scene, never under the
    // visibility-toggled boom meshes: three.js drops lights with an invisible
    // ancestor from the light state, so parenting them to the pooled meshes
    // changed the light count on every explosion → full shader recompile
    // (~200 ms first time per light-count, masked later by the driver cache).
    this.booms = Array.from({ length: 6 }, () => {
      const mesh = noRay(new THREE.Mesh(new THREE.SphereGeometry(1, 18, 14),
        new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.8, depthWrite: false })));
      const light = new THREE.PointLight(0xffaa33, 0, 40);
      scene.add(light);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      return { mesh, light, life: 0, max: 1, r: 1 };
    });
    this.boomIdx = 0;

    this.tracers = Array.from({ length: 24 }, () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = noRay(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0.9 })));
      line.visible = false;
      line.frustumCulled = false;
      scene.add(line);
      return { line, life: 0 };
    });
    this.tracerIdx = 0;

    // Voidcaller grenade vortices: a dark singularity core, two spiral
    // accretion discs (shared vortexDiscGeo, tilted sibling sells the volume),
    // six infalling motes, and a faint shell that keeps the DoT radius
    // readable. Tiny pool (one per voidcaller every ~18s, 6s life); materials
    // cloned per slot because opacity animates (the two discs of a slot share
    // one). No lights — the standing light-count rule applies.
    const voidShellGeo = new THREE.SphereGeometry(1, 18, 14);
    const voidCoreGeo = new THREE.SphereGeometry(0.16, 12, 10);
    const voidDiscGeo = vortexDiscGeo();
    const voidMoteGeo = new THREE.SphereGeometry(0.045, 6, 6);
    this.voids = Array.from({ length: 4 }, () => {
      const group = new THREE.Group();
      const shell = noRay(new THREE.Mesh(voidShellGeo,
        new THREE.MeshBasicMaterial({ color: 0x9d4edd, transparent: true, opacity: 0.1, depthWrite: false })));
      const core = noRay(new THREE.Mesh(voidCoreGeo,
        new THREE.MeshBasicMaterial({ color: 0x140523, transparent: true, opacity: 0.95, depthWrite: false })));
      const discMat = new THREE.MeshBasicMaterial({
        color: 0xb06bff, transparent: true, opacity: 0.6, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, vertexColors: true,
      });
      const disc = noRay(new THREE.Mesh(voidDiscGeo, discMat));
      const disc2 = noRay(new THREE.Mesh(voidDiscGeo, discMat));
      disc2.rotation.x = 0.5; // default XYZ euler order: per-frame Y spin stays in-plane under the tilt
      disc2.scale.setScalar(0.75);
      const moteMat = new THREE.MeshBasicMaterial({
        color: 0xd9b8ff, transparent: true, opacity: 0.85, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const motes = Array.from({ length: 6 }, () => noRay(new THREE.Mesh(voidMoteGeo, moteMat)));
      group.add(shell, core, disc, disc2, ...motes);
      group.visible = false;
      group.traverse((o) => { o.frustumCulled = false; });
      scene.add(group);
      return { group, shell, core, disc, disc2, motes, moteMat, life: 0, dur: 1, r: 1 };
    });
    this.voidIdx = 0;

    this.sparks = Array.from({ length: 16 }, () => {
      const m = noRay(new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffd27a })));
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      return { mesh: m, life: 0 };
    });
    this.sparkIdx = 0;

    // Super-cast flourish flares: a class-colored light pillar that breathes in
    // through the windup and bursts into a racing ground ring at the apex.
    // Also reused (pedestal-colored) for keeper spawn descents, which arrive
    // two at a time — pool of 6 so a twin-keeper drop can't steal a live
    // super flourish; materials cloned per slot — color and opacity animate
    // per instance. No lights — the standing light-count rule applies.
    const flareGeo = new THREE.CylinderGeometry(0.55, 0.85, 26, 12, 1, true);
    const flareRingGeo = new THREE.RingGeometry(0.9, 1.1, 40).rotateX(-Math.PI / 2);
    this.flares = Array.from({ length: 6 }, () => {
      const mat = () => new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const pillar = noRay(new THREE.Mesh(flareGeo, mat()));
      const ring = noRay(new THREE.Mesh(flareRingGeo, mat()));
      pillar.visible = ring.visible = false;
      pillar.frustumCulled = ring.frustumCulled = false;
      scene.add(pillar, ring);
      return { pillar, ring, life: 0, dur: 1, apex: 0.5 };
    });
    this.flareIdx = 0;

    this.numQueue = [];
    this.shakeAmt = 0;
    this.shakeBudget = 1; // per-frame growth cap (see shake)
  }

  // A guardian's super flourish at pos: windup until apex s in, burst after.
  superFlare(pos, color, dur, apex) {
    const f = this.flares[this.flareIdx++ % this.flares.length];
    f.pillar.material.color.set(color);
    f.ring.material.color.set(color);
    f.pillar.position.set(pos.x, pos.y + 13, pos.z);
    f.ring.position.set(pos.x, pos.y + 0.05, pos.z);
    f.dur = dur; f.apex = apex; f.life = dur;
    f.pillar.scale.setScalar(1);
    f.ring.scale.setScalar(1);
    f.pillar.visible = f.ring.visible = true;
  }

  paintNumber(n, text, kind) {
    const g = n.c.getContext('2d');
    g.clearRect(0, 0, 192, 80);
    const color = kind === 'crit' ? '#ffd23d' : kind === 'super' ? '#c77dff' : kind === 'immune' ? '#cdd7ff'
      : kind === 'heal' ? '#7dffcf' : '#ffffff';
    const size = kind === 'crit' || kind === 'super' ? 46 : 36;
    g.font = `700 ${size}px "Segoe UI", Arial`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // Stroke outline, NOT shadowBlur: blurred canvas shadows rasterize on the
    // CPU (~ms each), and an AoE multikill drawing 8+ numbers in one frame
    // caused visible hitches.
    g.lineWidth = 5; g.lineJoin = 'round'; g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(String(text), 96, 40);
    g.fillStyle = color;
    g.fillText(String(text), 96, 40);
    n.tex.needsUpdate = true;
  }

  // Queued, not immediate: a multikill requests many numbers in one frame, and
  // each one is a canvas paint + GPU texture upload. Bursts of uploads can
  // serialize into a pipeline stall (nonlinear cost), so update() drains the
  // queue at ≤3 per frame — an imperceptible 1-2 frame stagger.
  damageNumber(pos, text, kind = 'normal') {
    this.numQueue.push({ pos: new THREE.Vector3(pos.x, pos.y, pos.z), text, kind });
    if (this.numQueue.length > 24) this.numQueue.shift();
  }

  showNumber({ pos, text, kind }) {
    const n = this.numbers[this.numIdx++ % this.numbers.length];
    this.paintNumber(n, text, kind);
    n.spr.position.set(pos.x + (Math.random() - 0.5) * 0.6, pos.y + (Math.random() - 0.5) * 0.4, pos.z + (Math.random() - 0.5) * 0.6);
    n.spr.scale.set(2.6, 1.1, 1);
    n.spr.material.opacity = 1;
    n.spr.visible = true;
    n.life = 0.8;
    n.vel = new THREE.Vector3((Math.random() - 0.5) * 0.8, 2.2, (Math.random() - 0.5) * 0.8);
  }

  // Paint and show every pooled object once. The boot warmup frame draws them
  // all, paying glyph rasterization and the 36 sprite-texture uploads up front
  // instead of across the first few fights. Call update(1) afterwards to hide.
  warmup() {
    // Cycle the FULL glyph set through both font sizes: glyph rasters cache per
    // glyph+size, so warming only "888" left the first real kill to rasterize
    // nine fresh digits (stroke + fill) — a one-time first-kill hitch.
    const texts = ['0123', '4567', '89+', 'IMMUNE']; // '+' = heal numbers
    this.numbers.forEach((n, i) => {
      this.paintNumber(n, texts[i % texts.length], i % 2 ? 'crit' : 'normal');
      n.spr.visible = true;
      n.life = 0.0001;
      n.vel = new THREE.Vector3();
    });
    for (const b of this.booms) { b.mesh.visible = true; b.life = 0.0001; b.max = 1; b.r = 1; b.lit = false; }
    for (const t of this.tracers) { t.line.visible = true; t.life = 0.0001; }
    for (const s of this.sparks) { s.mesh.visible = true; s.life = 0.0001; }
    for (const v of this.voids) { v.group.visible = true; v.life = 0.0001; v.dur = 1; v.r = 1; }
    for (const f of this.flares) { f.pillar.visible = f.ring.visible = true; f.life = 0.0001; f.dur = 1; f.apex = 0.5; }
  }

  // colorOverride lets class-flavored booms (grenades, swarm embers) reuse the
  // pool without minting new kinds per class.
  explosion(pos, kind = 'rocket', colorOverride = null) {
    const b = this.booms[this.boomIdx++ % this.booms.length];
    const big = kind === 'nova';
    const col = colorOverride ?? (kind === 'nova' ? 0x9d4edd : kind === 'grenade' ? 0x7ae582
      : kind === 'death' ? 0xc77dff : kind === 'seeker' ? 0xff7733 : kind === 'heal' ? 0x7dffcf : 0xffaa33);
    b.mesh.material.color.set(col);
    b.light.color.set(col);
    b.light.position.copy(pos); // the light is scene-level, not a mesh child
    b.mesh.position.copy(pos);
    b.r = big ? SUPER.nova.r : kind === 'grenade' ? 5 : kind === 'death' ? 2.5 : kind === 'seeker' ? 3.5 : kind === 'heal' ? 2.2 : 6.5;
    b.max = big ? 0.85 : 0.4; // the nova wave is huge — give it longer to swell
    b.life = b.max;
    b.mesh.visible = true;
    // Death pops are flash-only: an AoE multikill would otherwise drive all six
    // pooled point lights at once — the light COUNT stays constant, but the
    // per-fragment lighting cost across the screen spikes for half a second.
    // Heal pops stay unlit too (two mend-orbs land near-simultaneously).
    b.lit = kind !== 'death' && kind !== 'heal';
    this.shake(big ? 0.5 : kind === 'death' || kind === 'heal' ? 0.08 : 0.25);
  }

  // A voidcaller grenade vortex parks at the blast for `dur` seconds.
  voidOrb(pos, r, dur) {
    const v = this.voids[this.voidIdx++ % this.voids.length];
    v.group.position.copy(pos);
    v.r = r; v.dur = dur; v.life = dur;
    v.group.visible = true;
  }

  tracer(from, to) {
    const t = this.tracers[this.tracerIdx++ % this.tracers.length];
    const a = t.line.geometry.attributes.position;
    a.setXYZ(0, from.x, from.y, from.z);
    a.setXYZ(1, to.x, to.y, to.z);
    a.needsUpdate = true;
    t.line.visible = true;
    t.line.material.opacity = 0.85;
    t.life = 0.09;
  }

  spark(pos) {
    const s = this.sparks[this.sparkIdx++ % this.sparks.length];
    s.mesh.position.copy(pos);
    s.mesh.visible = true;
    s.life = 0.12;
  }

  // Growth is budgeted per frame (reset in update): net bursts at high ping
  // can land several shake events between frames; the budget admits the
  // biggest single event (oblit, 1.0) but stops clumps slamming the 1.2 cap.
  shake(amt) {
    amt = Math.min(amt, this.shakeBudget);
    if (amt <= 0) return;
    this.shakeBudget -= amt;
    this.shakeAmt = Math.min(1.2, this.shakeAmt + amt);
  }

  applyShake(camera) {
    if (this.shakeAmt <= 0.001) return;
    camera.position.x += (Math.random() - 0.5) * this.shakeAmt * 0.3;
    camera.position.y += (Math.random() - 0.5) * this.shakeAmt * 0.3;
    camera.position.z += (Math.random() - 0.5) * this.shakeAmt * 0.3;
  }

  update(dt) {
    this.shakeBudget = 1;
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 3);
    for (let k = 0; k < 3 && this.numQueue.length; k++) this.showNumber(this.numQueue.shift());
    for (const n of this.numbers) {
      if (n.life <= 0) continue;
      n.life -= dt;
      n.spr.position.addScaledVector(n.vel, dt);
      n.spr.material.opacity = Math.min(1, n.life / 0.3);
      if (n.life <= 0) n.spr.visible = false;
    }
    for (const b of this.booms) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const k = 1 - b.life / b.max;
      b.mesh.scale.setScalar(0.5 + k * b.r);
      b.mesh.material.opacity = 0.85 * (1 - k);
      b.light.intensity = b.lit ? 30 * (1 - k) : 0;
      if (b.life <= 0) { b.mesh.visible = false; b.light.intensity = 0; }
    }
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.line.material.opacity = t.life / 0.09 * 0.85;
      if (t.life <= 0) t.line.visible = false;
    }
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) s.mesh.visible = false;
    }
    for (const v of this.voids) {
      if (v.life <= 0) continue;
      v.life -= dt;
      const t = v.dur - v.life;
      const fade = Math.min(1, v.life / 0.5) * Math.min(1, t / 0.25); // ease in, ease out
      v.group.scale.setScalar(v.r * (0.95 + 0.05 * Math.sin(t * 7)));
      v.disc.rotation.y = -t * 2.4;
      v.disc2.rotation.y = -t * 3.7; // same direction, faster — reads as depth
      v.shell.material.opacity = 0.1 * fade;
      v.core.material.opacity = 0.95 * fade;
      v.disc.material.opacity = 0.6 * fade;
      v.moteMat.opacity = 0.85 * fade;
      for (let j = 0; j < v.motes.length; j++) {
        const u = (t * 0.45 + j / v.motes.length) % 1; // staggered infall progress
        const a = j * 2.4 - t * 2.4 - u * 4;           // spirals in with the disc
        const rad = 0.95 - 0.8 * u;
        v.motes[j].position.set(Math.cos(a) * rad,
          0.3 * Math.sin(j * 1.7 + t * 1.1) * (1 - u) - 0.22 * u, Math.sin(a) * rad);
        v.motes[j].scale.setScalar(1 - 0.55 * u);
      }
      if (v.life <= 0) v.group.visible = false;
    }
    for (const f of this.flares) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const t = f.dur - f.life;
      if (t < f.apex) { // windup: the pillar breathes in, the ring quivers
        const k = t / f.apex;
        f.pillar.material.opacity = 0.45 * k;
        f.pillar.scale.set(1 - 0.45 * k, 1, 1 - 0.45 * k);
        f.ring.material.opacity = 0.5 * k;
        f.ring.scale.setScalar(1 + 0.35 * Math.abs(Math.sin(t * 9)));
      } else { // burst: the ring races out as the pillar flares and dies
        const k = Math.min(1, (t - f.apex) / Math.max(0.01, f.dur - f.apex));
        f.pillar.material.opacity = 0.9 * (1 - k);
        f.pillar.scale.set(0.55 + 1.6 * k, 1, 0.55 + 1.6 * k);
        f.ring.material.opacity = 0.8 * (1 - k);
        f.ring.scale.setScalar(1 + 11 * k);
      }
      if (f.life <= 0) f.pillar.visible = f.ring.visible = false;
    }
  }
}
