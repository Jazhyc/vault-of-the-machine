// All SFX are synthesized with WebAudio — no asset files.
export class GameAudio {
  constructor() { this.ctx = null; this.master = null; this.ambGain = null; }

  init() {
    if (this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext;
    this.ctx = new C();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.42;
    // soft-knee compressor: an AoE multikill stacks many one-shots at once,
    // which otherwise clips and crackles
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 24; comp.ratio.value = 6;
    comp.attack.value = 0.003; comp.release.value = 0.25;
    this.master.connect(comp).connect(this.ctx.destination);
    this.noiseBuf = this.makeNoise();
    this.startAmbient();
    this.music = new Music(this);
  }

  setMusic(mode, round) { if (this.music) this.music.set(mode, round); }

  makeNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // helpers ------------------------------------------------------------
  env(gainNode, t, peak, attack, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  // -1 (left) … 1 (right); 0 routes straight to master.
  panNode(pan) {
    if (!pan || !this.ctx.createStereoPanner) return this.master;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master);
    return p;
  }

  noise(peak, decay, freq, q = 1, type = 'lowpass', attack = 0.005, pan = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    src.connect(f).connect(g).connect(this.panNode(pan));
    this.env(g, t, peak, attack, decay);
    src.start(t); src.stop(t + attack + decay + 0.05);
  }

  tone(freq, peak, decay, type = 'sine', slideTo = null, attack = 0.005, pan = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(slideTo, 1), t + attack + decay);
    const g = this.ctx.createGain();
    o.connect(g).connect(this.panNode(pan));
    this.env(g, t, peak, attack, decay);
    o.start(t); o.stop(t + attack + decay + 0.05);
  }

  seq(notes, gap, fn) { notes.forEach((n, i) => setTimeout(() => fn(n), i * gap)); }

  // sfx ------------------------------------------------------------
  shot(w) {
    if (w === 'auto') { this.noise(0.22, 0.07, 2600); this.tone(190, 0.1, 0.05, 'square', 90); }
    else if (w === 'hand') { this.noise(0.38, 0.12, 3200, 1, 'lowpass', 0.002); this.tone(150, 0.22, 0.09, 'square', 70); }
    else if (w === 'sniper') { this.noise(0.5, 0.3, 4200, 1, 'lowpass', 0.002); this.tone(110, 0.3, 0.25, 'sawtooth', 35); }
    else if (w === 'shotgun') { this.noise(0.55, 0.22, 1100); this.tone(80, 0.35, 0.18, 'sine', 40); }
    else if (w === 'lmg') { this.noise(0.26, 0.08, 1900); this.tone(120, 0.13, 0.06, 'square', 60); }
    else if (w === 'rocket') { this.noise(0.4, 0.5, 900, 2, 'bandpass'); this.tone(70, 0.3, 0.3, 'sawtooth', 30); }
    else if (w === 'gjally') {
      this.noise(0.45, 0.6, 900, 2, 'bandpass');
      this.tone(70, 0.3, 0.35, 'sawtooth', 30);
      this.tone(440, 0.18, 0.6, 'triangle', 880); // the howl
    }
    else if (w === 'melee') { this.noise(0.3, 0.1, 700, 2, 'bandpass'); }
  }
  dryFire() { this.tone(700, 0.08, 0.04, 'square'); }
  reload() { this.tone(420, 0.07, 0.05, 'square'); setTimeout(() => this.tone(640, 0.07, 0.05, 'square'), 120); }
  explosion(big = false, vol = 1) {
    this.noise((big ? 0.8 : 0.55) * vol, big ? 0.9 : 0.55, big ? 320 : 480);
    this.tone(big ? 55 : 70, 0.5 * vol, big ? 0.8 : 0.5, 'sine', 25);
  }
  hitTick(crit) {
    this.tone(crit ? 2300 : 1700, 0.09, 0.03, 'square');
    if (crit) setTimeout(() => this.tone(2800, 0.08, 0.03, 'square'), 35);
  }
  immune() { this.tone(300, 0.06, 0.08, 'sawtooth', 280); }
  pickup() { this.seq([520, 780, 1040], 60, f => this.tone(f, 0.12, 0.09, 'triangle')); }
  superReady() { this.seq([660, 880, 1320], 90, f => this.tone(f, 0.14, 0.25, 'triangle')); }
  superCast(kind) {
    if (kind === 'nova') { this.noise(0.5, 0.8, 500, 3, 'bandpass'); this.tone(60, 0.5, 1.0, 'sawtooth', 200); }
    else if (kind === 'golden') { this.seq([523, 659, 784, 1046], 70, f => this.tone(f, 0.2, 0.3, 'sawtooth')); }
    else { this.tone(180, 0.35, 0.9, 'sine', 320); this.noise(0.25, 0.7, 1200, 1, 'highpass'); }
  }
  roar() { this.tone(48, 0.55, 1.4, 'sawtooth', 38); this.noise(0.4, 1.2, 250); }
  slam() { this.tone(42, 0.6, 0.7, 'sine', 22); this.noise(0.45, 0.5, 200); }
  // Damage taken: the timbre says what hit you, the weight says how hard, and
  // the stereo pan (when the hit carries a knockback direction) says from where.
  hurt(dmg = 10, src = '', pan = 0) {
    const k = 0.55 + Math.min(1, dmg / 60) * 0.7;
    if (src === 'laser') { // sweep beam: electric sizzle
      this.noise(0.26 * k, 0.22, 3400, 3, 'highpass', 0.003, pan);
      this.tone(1900, 0.12 * k, 0.16, 'sawtooth', 900, 0.003, pan);
    } else if (src === 'husk' || src === 'slam') { // physical: body thud
      this.noise(0.3 * k, 0.14, 320, 1, 'lowpass', 0.002, pan);
      this.tone(85, 0.26 * k, 0.16, 'sine', 40, 0.002, pan);
    } else if (src === 'voidburn' || src === 'oblit') { // void: dark scorch
      this.noise(0.3 * k, 0.4, 700, 2, 'bandpass', 0.01, pan);
      this.tone(220, 0.16 * k, 0.35, 'sawtooth', 60, 0.01, pan);
    } else { // bolts, orbs, barrage rings: energy impact
      this.noise(0.26 * k, 0.16, 1500, 2, 'bandpass', 0.003, pan);
      this.tone(520, 0.14 * k, 0.12, 'square', 180, 0.003, pan);
    }
    if (dmg >= 45) this.tone(58, 0.3, 0.4, 'sine', 34); // heavy hits land a sub-thump
  }
  lowHp() { // dropped into critical health: sharp two-tone warning
    this.tone(1046, 0.18, 0.09, 'square');
    setTimeout(() => this.tone(740, 0.18, 0.16, 'square'), 110);
  }
  down() { this.seq([392, 261], 180, f => this.tone(f, 0.25, 0.4, 'sawtooth')); }
  revive() { this.seq([392, 523, 659], 110, f => this.tone(f, 0.18, 0.3, 'triangle')); }
  victory() { this.seq([523, 659, 784, 1046, 1318], 150, f => this.tone(f, 0.22, 0.5, 'triangle')); }
  wipe() { this.tone(160, 0.5, 2.2, 'sawtooth', 30); this.noise(0.35, 1.8, 220); }
  ui() { this.tone(880, 0.08, 0.05, 'square'); }
  ammo() { this.tone(330, 0.1, 0.06, 'square'); setTimeout(() => this.tone(440, 0.1, 0.08, 'square'), 70); }
  volley() { this.noise(0.16, 0.4, 700, 4, 'bandpass'); }
  laser() { this.tone(1400, 0.16, 0.6, 'sawtooth', 160); this.noise(0.18, 0.6, 3000, 4, 'bandpass'); }
  riser() { // long rising alarm for Obliteration
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 3.8);
    const g = this.ctx.createGain();
    this.env(g, t, 0.13, 3.2, 0.9);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 4.3);
    this.noise(0.15, 3.8, 1400, 1, 'highpass', 2.6);
  }

  // liveliness sfx ------------------------------------------------------
  // `vol` lets callers attenuate by distance (1 = at your feet).
  footstep(sprint) {
    this.noise(sprint ? 0.085 : 0.06, 0.045, 320 + Math.random() * 160, 1, 'lowpass', 0.002);
    this.tone(90 + Math.random() * 28, 0.03, 0.04, 'sine', 58);
  }
  jump() { this.noise(0.07, 0.16, 1200, 2, 'bandpass', 0.012); this.tone(210, 0.045, 0.12, 'sine', 320); }
  land(hard) {
    this.noise(hard ? 0.2 : 0.1, 0.08, 430, 1, 'lowpass', 0.002);
    this.tone(72, hard ? 0.15 : 0.08, 0.07, 'sine', 46);
  }
  heartbeat() {
    this.tone(52, 0.3, 0.12, 'sine', 40);
    setTimeout(() => this.tone(47, 0.22, 0.1, 'sine', 37), 150);
  }
  countTick(urgent) { this.tone(urgent ? 1320 : 990, 0.12, 0.05, 'square'); }
  enemyDie(ty, vol = 1) {
    if (ty === 'husk') { this.noise(0.28 * vol, 0.25, 520, 2, 'bandpass'); this.tone(150, 0.16 * vol, 0.22, 'sawtooth', 48); }
    else if (ty === 'acolyte') { this.tone(820, 0.16 * vol, 0.3, 'sawtooth', 85); this.noise(0.18 * vol, 0.2, 2400, 3, 'bandpass'); }
    else if (ty === 'keeper') { this.tone(70, 0.4 * vol, 0.9, 'sawtooth', 28); this.noise(0.32 * vol, 0.7, 340); this.tone(140, 0.18 * vol, 0.5, 'square', 44); }
    else if (ty === 'wisp') { this.seq([1568, 2093, 2637], 45, f => this.tone(f, 0.09 * vol, 0.18, 'triangle')); }
    else if (ty === 'seeker') { // ordnance popped mid-flight: metallic crack
      this.noise(0.22 * vol, 0.16, 1700, 3, 'bandpass');
      this.tone(620, 0.12 * vol, 0.18, 'square', 140);
    }
    else if (ty === 'blister') { // wet burst
      this.noise(0.42 * vol, 0.35, 330, 1, 'lowpass', 0.002);
      this.tone(250, 0.18 * vol, 0.3, 'sine', 46);
      this.tone(430, 0.1 * vol, 0.22, 'sine', 95);
    }
  }
  spawnBlip() { this.noise(0.11, 0.3, 950, 3, 'bandpass', 0.06); this.tone(150, 0.07, 0.26, 'sawtooth', 310); }
  capsuleDrop() { this.tone(1500, 0.055, 1.1, 'triangle', 460, 0.06); } // falling whistle
  capsuleLand(vol = 1) {
    this.noise(0.16 * vol, 0.09, 750, 1, 'lowpass', 0.002);
    this.tone(880, 0.07 * vol, 0.16, 'triangle');
  }
  seekerLaunch(n = 2, vol = 1) { // hatch thump, then one staggered whoosh per missile
    this.noise(0.3 * vol, 0.22, 420, 1, 'lowpass', 0.004);
    this.tone(95, 0.18 * vol, 0.2, 'sine', 50);
    for (let i = 0; i < Math.min(n, 4); i++) { // cap the salvo sfx — big waves must not stack
      setTimeout(() => {
        this.noise(0.16 * vol, 0.3, 1100, 2, 'bandpass', 0.02);
        this.tone(230, 0.08 * vol, 0.3, 'sawtooth', 560, 0.02);
      }, 100 + i * 120);
    }
  }
  // Homing-ordnance whine: ONE persistent loop (built on first need), gain 0
  // when idle — never per-seeker one-shots. Called every frame with the nearest
  // live seeker's closeness (0 far/none … 1 on top of you) and a stereo pan.
  seekerWhine(closeness = 0, pan = 0) {
    if (!this.ctx) return;
    if (!this.whine) {
      if (closeness <= 0) return; // don't build the nodes just to stay silent
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = 480;
      const lfo = this.ctx.createOscillator();
      const lfoG = this.ctx.createGain();
      lfo.frequency.value = 11; lfoG.gain.value = 26; // mechanical warble
      lfo.connect(lfoG).connect(o.frequency);
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1300; f.Q.value = 1.6;
      const g = this.ctx.createGain(); g.gain.value = 0;
      const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      o.connect(f).connect(g);
      (p ? g.connect(p) : g).connect(this.master);
      o.start(); lfo.start();
      this.whine = { o, g, p };
    }
    const t = this.ctx.currentTime;
    this.whine.g.gain.setTargetAtTime(closeness * 0.085, t, 0.09);
    this.whine.o.frequency.setTargetAtTime(480 + closeness * 540, t, 0.06);
    if (this.whine.p) this.whine.p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.09);
  }
  keyChime() { // golden sparkle, distinct from the generic pickup
    this.seq([784, 988, 1175, 1568], 70, f => this.tone(f, 0.13, 0.35, 'triangle'));
    this.tone(196, 0.1, 0.7, 'sine');
  }
  wellBloom() { // a dormant well waking: warm rising swell
    this.seq([262, 330, 392, 523], 95, f => this.tone(f, 0.15, 0.7, 'sine'));
    this.noise(0.1, 1.0, 2600, 1, 'highpass', 0.5);
  }
  unlockChime() { this.seq([659, 831, 988, 1318, 1661], 110, f => this.tone(f, 0.15, 0.5, 'triangle')); }
  bannerPlant(vol = 1) { // pole thunk into stone, then the cloth snaps open
    this.tone(70, 0.4 * vol, 0.35, 'sine', 40);
    this.noise(0.18 * vol, 0.25, 1800, 2, 'bandpass', 0.08);
    setTimeout(() => this.noise(0.14 * vol, 0.18, 3200, 3, 'highpass', 0.01), 180);
  }

  // ambient ------------------------------------------------------------
  startAmbient() {
    const t = this.ctx.currentTime;
    this.ambGain = this.ctx.createGain();
    this.ambGain.gain.value = 0.045;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 220;
    this.ambFilter = filt;
    for (const f of [55, 55.7, 110.4]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(filt); o.start(t);
    }
    const lfo = this.ctx.createOscillator();
    const lfoG = this.ctx.createGain();
    lfo.frequency.value = 0.07; lfoG.gain.value = 80;
    lfo.connect(lfoG).connect(filt.frequency); lfo.start(t);
    filt.connect(this.ambGain).connect(this.master);
  }
  intensity(x) { // 0 calm … 1 damage-phase
    if (this.ambFilter) this.ambFilter.frequency.setTargetAtTime(220 + x * 700, this.ctx.currentTime, 0.6);
    if (this.ambGain) this.ambGain.gain.setTargetAtTime(0.045 + x * 0.04, this.ctx.currentTime, 0.6);
  }
}

// ---------------------------------------------------------------------------
// Adaptive music: a 32-step sequencer in D minor.
//  - 'tense'  (mechanics): brooding industrial pulse; each round adds tempo,
//    dissonant bass grinds, and busier percussion — gradually more desperate.
//  - 'heroic' (damage phase): electronic metal at 134 BPM — distorted
//    power-chord chugs (saw stacks through a tanh waveshaper), kick gallop,
//    kick-sidechained gated sub, lead arp answering in the back half.
//  - 'final'  (final stand): the same riff at 150 BPM, double-time kicks and
//    tremolo picking with a semitone dread line on top.
// ---------------------------------------------------------------------------
const mf = (n) => 440 * Math.pow(2, (n - 69) / 12);

class Music {
  constructor(audio) {
    this.A = audio;
    const ctx = audio.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(audio.master);
    // electronic-metal chain for the damage phases: detuned saw stacks → tanh
    // waveshaper (the "guitar amp") → tone filter → sidechain pump → bus.
    // Percussion bypasses the pump so the kick that drives it stays punchy.
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.duck.connect(this.bus);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let j = 0; j < 1024; j++) curve[j] = Math.tanh(3.2 * (j / 511.5 - 1));
    shaper.curve = curve;
    shaper.oversample = '2x';
    const toneF = ctx.createBiquadFilter();
    toneF.type = 'lowpass'; toneF.frequency.value = 3400;
    this.distIn = ctx.createGain();
    this.distOut = ctx.createGain();
    this.distOut.gain.value = 0.16;
    this.distIn.connect(shaper).connect(toneF).connect(this.distOut).connect(this.duck);
    this.mode = 'off';
    this.round = 1;
    this.step = 0;
    this.nextAt = ctx.currentTime + 0.1;
    setInterval(() => this.pump(), 90);
  }

  set(mode, round = 1) {
    round = Math.min(round, 6);
    if (mode === this.mode && round === this.round) return;
    this.mode = mode;
    this.round = round;
    const silent = mode === 'off' || mode === 'calm';
    const heavy = mode === 'heroic' || mode === 'final';
    this.bus.gain.setTargetAtTime(silent ? 0 : heavy ? 0.17 : 0.2, this.A.ctx.currentTime, 0.8);
  }

  bpm() {
    if (this.mode === 'tense') return Math.min(126, 102 + (this.round - 1) * 7);
    if (this.mode === 'heroic') return 134;
    if (this.mode === 'final') return 150;
    return 96;
  }

  pump() {
    const ctx = this.A.ctx;
    while (this.nextAt < ctx.currentTime + 0.25) {
      if (this.mode !== 'off' && this.mode !== 'calm') this.playStep(this.step, this.nextAt);
      this.nextAt += 60 / this.bpm() / 4; // 16th notes
      this.step = (this.step + 1) % 32;
    }
  }

  note(t, midi, dur, type = 'sawtooth', peak = 0.09, fc = 1800) {
    const ctx = this.A.ctx;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = mf(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = fc;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.duck);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // A distorted power chord: detuned saw pair + fifth + octave into the amp.
  // Short dur = palm-muted chug, long dur = open sustained chord.
  chug(t, midi, dur, peak = 0.45) {
    const ctx = this.A.ctx;
    for (const [m, det] of [[midi, -7], [midi, 7], [midi + 7, 0], [midi + 12, 4]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mf(m);
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.distIn);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  // Gated sub bass, sidechained under the kick.
  bass(t, midi, dur = 0.1) {
    const ctx = this.A.ctx;
    const o = ctx.createOscillator();
    o.type = 'square'; o.frequency.value = mf(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.17, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.duck);
    o.start(t); o.stop(t + dur + 0.05);
  }

  snare(t) {
    this.hit(t, 0.12, 1300, 0.13);
    const ctx = this.A.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.bus);
    o.start(t); o.stop(t + 0.12);
  }

  kick(t) {
    const ctx = this.A.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(34, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.connect(g).connect(this.bus);
    o.start(t); o.stop(t + 0.18);
    // sidechain: duck the melodic bus and snap back — the electronic "pump"
    const p = this.duck.gain;
    p.cancelScheduledValues(t);
    p.setValueAtTime(0.4, t);
    p.linearRampToValueAtTime(1, t + 0.17);
  }

  hit(t, dur, hp, peak) { // noise percussion (hats/snares)
    const ctx = this.A.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.A.noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(this.bus);
    s.start(t); s.stop(t + dur + 0.02);
  }

  playStep(i, t) {
    const r = this.round, mode = this.mode;
    if (mode === 'tense') {
      if (i % 8 === 0) this.note(t, 38, 0.5, 'sawtooth', 0.12, 500);              // D2 pulse
      if (i % 8 === 6 && r >= 2) this.note(t, 37, 0.22, 'sawtooth', 0.1, 480);    // C#2 grind
      if (i % 16 === 14 && r >= 4) this.note(t, 39, 0.22, 'sawtooth', 0.1, 480);  // Eb2 dread
      if (i % (r >= 3 ? 2 : 4) === 0) this.hit(t, 0.03, 6500, 0.05);              // hats speed up
      if (i % 4 === 2) this.note(t, [62, 65, 69, 72][Math.floor(i / 4) % 4] - (r >= 3 ? 12 : 0), 0.12, 'square', 0.035, 1400);
      if (i === 16 && r >= 2) this.kick(t);
      if (i % 8 === 4 && r >= 5) this.hit(t, 0.1, 1800, 0.07);                    // panic snare
    } else if (mode === 'heroic' || mode === 'final') {
      // DPS: electronic metal. Distorted power-chord riff over a kick gallop
      // with sidechained gated sub — a different genre from the MECH brood,
      // not a busier version of it. FINAL goes double-time tremolo.
      const chords = [[50, 53, 57], [53, 57, 60], [48, 52, 55], [55, 59, 62]];    // Dm F C G
      const ch = chords[Math.floor(i / 8) % 4];
      const root = [38, 41, 36, 43][Math.floor(i / 8) % 4];                       // D2 F2 C2 G2
      const desperate = mode === 'final';
      // drums: four-on-the-floor + gallop kick; FINAL doubles the back half
      if (i % 4 === 0) this.kick(t);
      if (i % 8 === 6) this.kick(t);                                              // gallop
      if (desperate && i % 2 === 0 && i >= 16) this.kick(t);
      if (i % 8 === 4) this.snare(t);
      if (i % 2 === 1) this.hit(t, 0.025, 8000, 0.05);                            // off-beat hats
      // riff: open chord on the bar, palm-mute chugs between; FINAL tremolo-picks
      if (i % 8 === 0) this.chug(t, root, 0.55, 0.5);
      else if (i % 2 === 0) this.chug(t, root, 0.085, 0.4);
      if (desperate && i % 2 === 1) this.chug(t, root, 0.06, 0.28);
      // gated 16th sub under everything (the pump rides it)
      this.bass(t, root - 12);
      // lead arp answers in the back half of each bar
      if (i % 8 >= 4 || desperate) {
        this.note(t, ch[[0, 1, 2, 1][i % 4]] + 12, 0.09, 'square', 0.05, desperate ? 3000 : 2400);
      }
      if (desperate) this.note(t, i % 2 ? 75 : 74, 0.06, 'sawtooth', 0.05, 4200); // D/Eb tremolo dread
    }
  }
}
