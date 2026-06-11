import * as THREE from 'three';

const noRay = (o) => { o.raycast = () => {}; return o; };

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

    this.sparks = Array.from({ length: 16 }, () => {
      const m = noRay(new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffd27a })));
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      return { mesh: m, life: 0 };
    });
    this.sparkIdx = 0;

    this.numQueue = [];
    this.shakeAmt = 0;
  }

  paintNumber(n, text, kind) {
    const g = n.c.getContext('2d');
    g.clearRect(0, 0, 192, 80);
    const color = kind === 'crit' ? '#ffd23d' : kind === 'super' ? '#c77dff' : kind === 'immune' ? '#cdd7ff' : '#ffffff';
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
    const texts = ['0123', '4567', '89', 'IMMUNE'];
    this.numbers.forEach((n, i) => {
      this.paintNumber(n, texts[i % texts.length], i % 2 ? 'crit' : 'normal');
      n.spr.visible = true;
      n.life = 0.0001;
      n.vel = new THREE.Vector3();
    });
    for (const b of this.booms) { b.mesh.visible = true; b.life = 0.0001; b.max = 1; b.r = 1; b.lit = false; }
    for (const t of this.tracers) { t.line.visible = true; t.life = 0.0001; }
    for (const s of this.sparks) { s.mesh.visible = true; s.life = 0.0001; }
  }

  explosion(pos, kind = 'rocket') {
    const b = this.booms[this.boomIdx++ % this.booms.length];
    const big = kind === 'nova';
    const col = kind === 'nova' ? 0x9d4edd : kind === 'grenade' ? 0x7ae582 : kind === 'death' ? 0xc77dff : kind === 'seeker' ? 0xff7733 : 0xffaa33;
    b.mesh.material.color.set(col);
    b.light.color.set(col);
    b.light.position.copy(pos); // the light is scene-level, not a mesh child
    b.mesh.position.copy(pos);
    b.r = big ? 9 : kind === 'grenade' ? 5 : kind === 'death' ? 2.5 : kind === 'seeker' ? 3.5 : 6.5;
    b.max = big ? 0.7 : 0.4;
    b.life = b.max;
    b.mesh.visible = true;
    // Death pops are flash-only: an AoE multikill would otherwise drive all six
    // pooled point lights at once — the light COUNT stays constant, but the
    // per-fragment lighting cost across the screen spikes for half a second.
    b.lit = kind !== 'death';
    this.shake(big ? 0.5 : kind === 'death' ? 0.08 : 0.25);
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

  shake(amt) { this.shakeAmt = Math.min(1.2, this.shakeAmt + amt); }

  applyShake(camera) {
    if (this.shakeAmt <= 0.001) return;
    camera.position.x += (Math.random() - 0.5) * this.shakeAmt * 0.3;
    camera.position.y += (Math.random() - 0.5) * this.shakeAmt * 0.3;
    camera.position.z += (Math.random() - 0.5) * this.shakeAmt * 0.3;
  }

  update(dt) {
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
  }
}
