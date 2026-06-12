import * as THREE from 'three';
import { CLASSES, ARENA, PLAYER, ENC, ENEMIES, SUPER, WEAPONS, LOADOUT, MAX_PLAYERS } from '/shared/constants.js';
import { Net } from './net.js';
import { GameAudio } from './audio.js';
import { buildWorld } from './world.js';
import { EnemyManager, buildEnemyWarmup } from './enemies.js';
import { EntityManager, buildGuardian, buildEntityWarmup } from './entities.js';
import { Effects } from './effects.js';
import { LocalPlayer } from './player.js';
import { WeaponSystem, buildViewmodel, buildWeaponFxWarmup } from './weapons.js';
import { Hud } from './hud.js';
import { ACTIONS, RESERVED, settings, code, keyLabel, setSens, setBind, resetControls } from './settings.js';

const $ = (id) => document.getElementById(id);

// ---------- three.js bootstrap ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
// Adaptive resolution: start at native (capped 2x) and scale down/up to hold ~60fps.
const PR_MAX = Math.min(devicePixelRatio, 2);
let prCurrent = PR_MAX;
renderer.setPixelRatio(prCurrent);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 600);
scene.add(camera);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  showcaseCam.aspect = innerWidth / innerHeight;
  showcaseCam.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- lobby showcase: live 3D preview of guardian + loadout ----------
const showcaseScene = new THREE.Scene();
showcaseScene.background = new THREE.Color(0x0b0716);
showcaseScene.add(new THREE.HemisphereLight(0x9a7fe0, 0x141019, 1.6));
const showDir = new THREE.DirectionalLight(0xffffff, 1.5);
showDir.position.set(-2, 4, 5);
showcaseScene.add(showDir);
const showRim = new THREE.PointLight(0x9d4edd, 40, 30);
showRim.position.set(2.5, 2.5, -2.5);
showcaseScene.add(showRim);
const showFloor = new THREE.Mesh(new THREE.CircleGeometry(2.0, 40).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x1a1228, roughness: 0.6, metalness: 0.45 }));
showFloor.position.set(0.9, 0, 0);
showcaseScene.add(showFloor);
const showRing = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.02, 8, 64).rotateX(Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x6d4ab0 }));
showRing.position.set(0.9, 0.02, 0);
showcaseScene.add(showRing);
const showGroup = new THREE.Group();
showcaseScene.add(showGroup);
const showcaseCam = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 60);
showcaseCam.position.set(0, 1.7, 4.8);
showcaseCam.lookAt(0.9, 1.15, 0);

let showcaseDirty = true;
const rebuildShowcase = () => { showcaseDirty = true; };
function refreshShowcase() {
  showcaseDirty = false;
  showGroup.clear();
  const gv = buildGuardian($('nameInput').value.trim() || 'GUARDIAN', selectedClass);
  gv.g.position.set(0.9, 0, 0);
  showGroup.add(gv.g);
  [loadoutSel.primary, loadoutSel.special, loadoutSel.heavy].forEach((key, i) => {
    const m = buildViewmodel(key);
    m.scale.setScalar(2.1);
    m.userData.baseY = 2.35 - i * 0.9;
    m.position.set(3.2, m.userData.baseY, 0.2);
    m.userData.spin = true;
    showGroup.add(m);
  });
}
function updateShowcase(now) {
  if (showcaseDirty) refreshShowcase();
  for (const c of showGroup.children) {
    if (c.userData.spin) {
      c.rotation.y = now * 0.6;
      c.position.y = c.userData.baseY + Math.sin(now * 1.5 + c.userData.baseY * 3) * 0.035;
    } else {
      c.rotation.y = Math.sin(now * 0.4) * 0.35 + 0.15;
    }
  }
}

const targets = [];                       // shared raycast target list
const world = buildWorld(scene, targets);
const audio = new GameAudio();
const effects = new Effects(scene);
const enemies = new EnemyManager(scene, targets);
const hud = new Hud();
const net = new Net();

// Golden-buff glow lights: a fixed scene-level pool sized for a full fireteam,
// created BEFORE the warm frame. The light count must never change after boot —
// any change (a light gaining/losing an invisible ancestor counts!) recompiles
// every lit shader (~200 ms per new light-count on a cold driver cache).
const glowPool = Array.from({ length: MAX_PLAYERS }, () => {
  const l = new THREE.PointLight(0xffb703, 0, 8);
  scene.add(l);
  return l;
});

// Remote-projectile orbs (rockets/grenades/novas relayed via `pf`) churn
// constantly in a full fireteam — shared geometry + per-color cached materials,
// never allocated per spawn (perf playbook), and warmed in the boot frame below.
const RPROJ_GEO = new THREE.SphereGeometry(0.18, 8, 8);
const RPROJ_GEO_BIG = new THREE.SphereGeometry(0.55, 8, 8); // nova singularity
const rprojMats = new Map();
const rprojMat = (color) => {
  if (!rprojMats.has(color)) rprojMats.set(color, new THREE.MeshBasicMaterial({ color }));
  return rprojMats.get(color);
};
function spawnRemoteProj(from, dir, speed, color, { big = false, grav = false } = {}) {
  const mesh = new THREE.Mesh(big ? RPROJ_GEO_BIG : RPROJ_GEO, rprojMat(color));
  mesh.raycast = () => {};
  mesh.position.copy(from);
  scene.add(mesh);
  remoteProjs.push({ mesh, vel: dir.multiplyScalar(speed), ttl: 2.5, grav });
}

// Pre-warm the GPU: actually DRAW one of everything once — enemies, pickups,
// projectiles, a guardian, the boss and its beams — so first-use buffer uploads
// and shader compiles never land mid-fight. Frustum culling must be off (a
// culled warmup uploads nothing) and the lobby DOM covers this frame anyway.
{
  const warm = new THREE.Group();
  warm.add(buildEnemyWarmup(), buildEntityWarmup(), buildWeaponFxWarmup(),
    buildGuardian('WARMUP', 'gunslinger').g,
    new THREE.Mesh(RPROJ_GEO, rprojMat(0xffaa33)), new THREE.Mesh(RPROJ_GEO_BIG, rprojMat(0x9d4edd)));
  warm.traverse(o => { o.raycast = () => {}; o.frustumCulled = false; });
  warm.position.set(0, 8, -10);
  scene.add(warm);
  enemies.boss.g.visible = true;
  enemies.beams.forEach(b => { b.visible = true; });
  effects.warmup(); // paints + uploads every pooled sprite/boom/tracer/spark
  camera.position.set(0, 10, 30);
  camera.lookAt(0, 10, 0);
  renderer.render(scene, camera);
  effects.update(1); // tuck the warmed pools away again
  enemies.boss.g.visible = false;
  enemies.beams.forEach(b => { b.visible = false; });
  camera.position.set(0, 0, 0);
  camera.rotation.set(0, 0, 0); // keep the roll-free invariant
  scene.remove(warm);
  renderer.compile(scene, camera); // programs for the invisible pools (sprites, tracers, booms)
}

// ---------- lobby UI ----------
let selectedClass = localStorage.getItem('sv_class') || 'gunslinger';
const cards = $('classCards');
for (const [key, c] of Object.entries(CLASSES)) {
  const div = document.createElement('div');
  div.className = 'classCard';
  div.style.setProperty('--cc', c.color);
  div.innerHTML = `<h3>${c.name}</h3><div class="sup">★ ${c.superName}</div><p>${c.desc}</p>`;
  div.onclick = () => { selectedClass = key; refreshCards(); rebuildShowcase(); };
  div.dataset.cls = key;
  cards.appendChild(div);
}
function refreshCards() {
  for (const el of cards.children) el.classList.toggle('sel', el.dataset.cls === selectedClass);
}
refreshCards();
$('nameInput').value = localStorage.getItem('sv_name') || '';
$('nameInput').addEventListener('input', () => { rebuildShowcase(); fetchUnlocks(); });

// ---------- weapon loadout ----------
let unlocks = { gjally: false };
let loadoutSel = { primary: 'auto', special: 'sniper', heavy: 'rocket',
  ...(JSON.parse(localStorage.getItem('sv_loadout') || '{}')) };

function loadoutRows() {
  return [
    ['PRIMARY', 'primary', LOADOUT.primary],
    ['SPECIAL', 'special', LOADOUT.special],
    ['HEAVY', 'heavy', unlocks.gjally ? [...LOADOUT.heavy, ...LOADOUT.secretHeavy] : LOADOUT.heavy],
  ];
}

function renderLoadout() {
  const root = $('loadout');
  root.innerHTML = '';
  for (const [label, slot, keys] of loadoutRows()) {
    if (!keys.includes(loadoutSel[slot])) loadoutSel[slot] = keys[0]; // e.g. stale gjally pick
    const row = document.createElement('div');
    row.className = 'wRow';
    const lab = document.createElement('div');
    lab.className = 'wRowLabel';
    lab.textContent = label;
    row.appendChild(lab);
    for (const key of keys) {
      const w = WEAPONS[key];
      const card = document.createElement('div');
      card.className = 'wCard' + (w.secret ? ' exotic' : '') + (loadoutSel[slot] === key ? ' sel' : '');
      card.innerHTML = `${w.name}<span class="sub">${w.desc}</span>`;
      card.onclick = () => { loadoutSel[slot] = key; renderLoadout(); };
      row.appendChild(card);
    }
    root.appendChild(row);
  }
  rebuildShowcase();
}
renderLoadout();

// Unlocks belong to a guardian name, not the server as a whole.
async function fetchUnlocks() {
  if (joined) return; // in-session unlocks arrive over the socket
  const name = $('nameInput').value.trim() || localStorage.getItem('sv_name') || '';
  try {
    const u = await (await fetch(`/api/unlocks?name=${encodeURIComponent(name)}`)).json();
    if (!!u.gjally !== unlocks.gjally) { unlocks.gjally = !!u.gjally; renderLoadout(); }
  } catch { /* offline lobby — secret stays hidden */ }
}

function showLoadoutScreen(afterVictory) {
  document.exitPointerLock?.();
  $('hud').classList.add('hidden');
  $('resumeScreen').classList.add('hidden');
  $('lobbyScreen').classList.remove('hidden');
  $('deployBtn').disabled = false;
  $('connStatus').textContent = afterVictory && unlocks.gjally
    ? '✦ GJALLARHORN UNLOCKED — CHECK YOUR HEAVY SLOT ✦' : '';
  renderLoadout();
}

// ---------- game state ----------
let player = null, weapons = null, entities = null;
let snap = null, serverOffset = 0, prevSt = 'LOBBY', prevSup = 0, joined = false;
let bannerRallied = false; // this lobby's banner already restocked me
let prevHp = PLAYER.maxHp, lowHpCueAt = 0;
const remoteProjs = [];

const serverNow = () => performance.now() / 1000 + serverOffset;
const getEnc = () => snap ? snap.enc : null;
const me = () => snap && net.myId ? snap.players.find(p => p.id === net.myId) : null;
fetchUnlocks();

$('deployBtn').onclick = async () => {
  const name = $('nameInput').value.trim() || 'Guardian';
  localStorage.setItem('sv_name', name);
  localStorage.setItem('sv_class', selectedClass);
  localStorage.setItem('sv_loadout', JSON.stringify(loadoutSel));
  const keys = [loadoutSel.primary, loadoutSel.special, loadoutSel.heavy];

  if (joined) {
    // returning from the post-victory selection screen: same connection, new kit
    net.send({ t: 'loadout', cls: selectedClass });
    weapons.setLoadout(keys);
    player.teleportToSpawn();
    $('lobbyScreen').classList.add('hidden');
    hud.show();
    renderer.domElement.requestPointerLock();
    return;
  }

  $('deployBtn').disabled = true;
  $('connStatus').textContent = 'LINKING TO THE VAULT…';
  audio.init();
  try {
    await net.connect(name, selectedClass);
  } catch (err) {
    $('connStatus').textContent = err.message.toUpperCase();
    $('deployBtn').disabled = false;
    return;
  }
  joined = true;
  player = new LocalPlayer(camera, net);
  weapons = new WeaponSystem({ camera, scene, targets, net, effects, audio, player, hud, getEnc, enemies,
    getCls: () => selectedClass }, keys);
  entities = new EntityManager(scene, net.myId, glowPool);
  $('lobbyScreen').classList.add('hidden');
  hud.show();
  renderer.domElement.requestPointerLock();
};

document.addEventListener('pointerlockchange', () => {
  if (!joined) return;
  if (!$('lobbyScreen').classList.contains('hidden')) return; // selection screen owns the cursor
  const locked = !!document.pointerLockElement;
  $('resumeScreen').classList.toggle('hidden', locked);
  if (locked) stopCapture(); // never leave a rebind capture armed in-game
  else {
    $('resumeHint').textContent = getEnc()?.st === 'LOBBY'
      ? `Click to return · ${keyLabel(code('inventory'))} to rebuild your loadout`
      : 'Click to return to the fight';
  }
});
$('resumeScreen').onclick = (e) => {
  if (e.target.closest('#settingsPanel, #settingsBtn')) return; // panel clicks don't re-lock
  renderer.domElement.requestPointerLock();
};

addEventListener('keydown', (e) => {
  // !e.repeat matters: held-E key-repeat used to restart the revive channel forever
  if (e.code === code('interact') && !e.repeat && joined && document.pointerLockElement) net.interact();
  // The inventory key (default TAB) reopens the selection screen — lobby
  // only. Unlike ESC, the browser doesn't eat it under pointer lock, so it
  // works mid-game AND from the pause overlay (showLoadoutScreen releases
  // the lock itself).
  if (e.code === code('inventory') && !e.repeat && joined
      && $('lobbyScreen').classList.contains('hidden') && getEnc()?.st === 'LOBBY') {
    e.preventDefault(); // keep focus off browser chrome / hidden UI buttons
    showLoadoutScreen(false);
  }
  // Fullscreen toggle — preventDefault takes over the browser's native F11 so
  // the element-fullscreen path runs instead (and the action stays rebindable).
  // Chrome can drop pointer lock across a fullscreen transition, which would
  // dump the player onto the pause overlay mid-fight — re-request it after the
  // flip while the keypress's transient activation still allows it.
  if (e.code === code('fullscreen') && !e.repeat) {
    e.preventDefault();
    const relock = !!document.pointerLockElement;
    const flip = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    flip.then(() => { if (relock && !document.pointerLockElement) renderer.domElement.requestPointerLock(); })
      .catch(() => {}); // denied (no gesture / iframe policy) — stay windowed
  }
});

// ---------- settings panel (pause overlay) ----------
// Pure client config (see settings.js). The rebind capture listener runs in
// the CAPTURE phase and stops propagation, so a captured press can never also
// drive gameplay handlers or the TAB loadout shortcut.
$('settingsBtn').onclick = () => { stopCapture(); $('settingsPanel').classList.toggle('hidden'); };

let capturing = null; // { action, btn } while waiting for a key press
function stopCapture() {
  if (!capturing) return;
  capturing.btn.classList.remove('listening');
  capturing.btn.textContent = keyLabel(code(capturing.action));
  capturing = null;
}

function renderBindRows() {
  const rows = $('bindRows');
  rows.textContent = '';
  for (const [action, label] of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'setRow';
    const name = document.createElement('span');
    name.className = 'setLabel';
    name.textContent = label;
    const btn = document.createElement('div');
    btn.className = 'bindKey';
    btn.textContent = keyLabel(code(action));
    btn.onclick = () => {
      const wasThis = capturing?.action === action;
      stopCapture();
      if (wasThis) return; // clicking the listening button cancels
      capturing = { action, btn };
      btn.classList.add('listening');
      btn.textContent = 'PRESS KEY';
    };
    row.append(name, btn);
    rows.appendChild(row);
  }
}
renderBindRows();

addEventListener('keydown', (e) => {
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') { stopCapture(); return; }
  if (RESERVED.has(e.code)) return; // unbindable key — keep listening
  const { action } = capturing;
  stopCapture();
  setBind(action, e.code); // fires sv-settings → rows and hint text re-render
}, true);

const sensSlider = $('sensSlider'), sensVal = $('sensVal');
function renderSens() {
  sensSlider.value = settings.sensMult;
  sensVal.textContent = `${settings.sensMult.toFixed(2)}×`;
}
renderSens();
sensSlider.addEventListener('input', () => setSens(parseFloat(sensSlider.value)));

$('bindReset').onclick = () => { stopCapture(); resetControls(); };

// Every bind-dependent hint string in the static HTML, re-rendered from the
// live binds (lobby controls hint, HUD ability hints, H help overlay).
function renderBindHints() {
  const L = (a) => keyLabel(code(a));
  const move = ['forward', 'left', 'back', 'right'].map(L);
  const moveStr = move.every((s) => s.length === 1) ? move.join('') : move.join(' ');
  const b = (s) => `<b>${s}</b>`;
  $('helpHint').textContent = `${L('help')} — CONTROLS`;
  $('abilityHints').textContent = `${L('super')} SUPER · ${L('grenade')} GRENADE · ${L('melee')} MELEE`;
  $('help').innerHTML =
    `${b(moveStr)} move<br>${b(`${L('jump')} ×2`)} double jump<br>${b(L('sprint'))} sprint<br>` +
    `${b('LMB')} fire<br>${b('RMB')} ADS<br>` +
    `${b(`${L('weapon1')}/${L('weapon2')}/${L('weapon3')}`)} weapons<br>${b(L('reload'))} reload<br>` +
    `${b(L('grenade'))} grenade<br>${b(L('melee'))} melee<br>${b(L('super'))} super<br>` +
    `${b(L('interact'))} interact / revive<br>${b(L('inventory'))} inventory (lobby)<br>` +
    `${b(L('fullscreen'))} fullscreen`;
  document.querySelector('.controlsHint').innerHTML =
    `${b(moveStr)} move &nbsp; ${b(L('jump'))} jump (×2) &nbsp; ${b(L('sprint'))} sprint &nbsp; ` +
    `${b('MOUSE')} aim / fire &nbsp; ${b('RMB')} aim-down-sights<br>` +
    `${b(`${L('weapon1')} / ${L('weapon2')} / ${L('weapon3')}`)} or ${b('WHEEL')} swap weapons &nbsp; ` +
    `${b(L('reload'))} reload &nbsp; ${b(L('grenade'))} grenade &nbsp; ${b(L('melee'))} melee &nbsp; ` +
    `${b(L('super'))} super &nbsp; ${b(L('interact'))} interact / revive &nbsp; ` +
    `${b(L('inventory'))} inventory &nbsp; ${b(L('help'))} help &nbsp; ${b(L('fullscreen'))} fullscreen`;
}
renderBindHints();
addEventListener('sv-settings', () => { renderBindRows(); renderSens(); renderBindHints(); });

// ---------- liveliness sfx state ----------
// crude distance attenuation: 1 at your feet, fading to 0.15 across the arena
const volAt = (p) => player
  ? Math.max(0.15, Math.min(1, 1 - Math.hypot(player.pos.x - p[0], player.pos.z - p[2]) / 55))
  : 1;
const capsTracked = new Map(); // capsule id -> { land, landed, p }
let lastSpawnSfx = 0, lastDieSfx = 0, lastChargeSfx = 0, stepIn = 0.1, prevGrounded = true, prevVy = 0, heartbeatIn = 0, lastTickSec = -1;
enemies.onSpawn = () => { // one portal blip per spawn burst, not one per add
  const n = performance.now();
  if (n - lastSpawnSfx > 350) { lastSpawnSfx = n; audio.spawnBlip(); }
};
enemies.onCharge = (ty, p, dur) => { // close-quarters cue only — silent past ~18 m
  if (!player) return;
  const d = Math.hypot(player.pos.x - p[0], player.pos.z - p[2]);
  const vol = Math.max(0, 1 - d / 18) ** 2; // steep: ~half gone by 6 m
  if (!vol) return;
  const n = performance.now();
  if (n - lastChargeSfx > 250) { lastChargeSfx = n; audio.chargeUp(vol, dur); } // one whine per beat even if a wave channels in sync
};

// ---------- net events ----------
net.on('toast', (m) => hud.toast(m.text, m.kind));
net.on('welcome', (m) => { if (m.gj) unlocks.gjally = true; }); // this name owns the exotic

net.on('snap', (m) => {
  snap = m;
  serverOffset = m.now - performance.now() / 1000;
  const now = performance.now() / 1000;
  enemies.sync(m, now);
  if (entities) { entities.sync(m, now); entities.setServerNow(m.now); }

  const my = me();
  if (my && player) {
    player.applyServerSelf(my, m.now);
    if (prevSup < 99.5 && my.sup >= 99.5) { audio.superReady(); hud.toast('SUPER READY', 'good'); }
    prevSup = my.sup;
    // dropping into critical health gets a one-shot warning (4 s cooldown so
    // regen flutter around the threshold can't machine-gun it)
    if (prevHp >= 70 && my.hp < 70 && my.hp > 0 && m.now > lowHpCueAt) {
      lowHpCueAt = m.now + 4;
      audio.lowHp();
    }
    prevHp = my.hp;
  }
  // blisters pulse hot for players whose fire can burst them
  enemies.localEmpowered = !!my && my.av >= ENC.capsulesNeeded;

  // capsule foley: a falling whistle per fresh drop batch; land times feed the
  // touchdown thuds in the render loop
  let newCaps = false;
  for (const c of m.caps) {
    if (!capsTracked.has(c.id)) { capsTracked.set(c.id, { land: c.land, landed: false, p: c.p }); newCaps = true; }
  }
  if (newCaps) audio.capsuleDrop();
  for (const id of [...capsTracked.keys()]) {
    if (!m.caps.some(c => c.id === id)) capsTracked.delete(id);
  }

  const st = m.enc.st;
  if (st !== prevSt) {
    // the fireteam plate-started the raid while this guardian lingered on the
    // selection screen — yank them back to the pause veil so they notice
    if (st === 'MECH' && prevSt === 'LOBBY' && joined && !$('lobbyScreen').classList.contains('hidden')) {
      $('lobbyScreen').classList.add('hidden');
      hud.show();
      $('resumeHint').textContent = 'Click to return to the fight';
      $('resumeScreen').classList.remove('hidden');
      hud.toast('The Vault seals!', 'warn');
    }
    if (st === 'OBLIT') { hud.announce('OBLITERATION INCOMING', 'KINDLED LIGHT ENDURES'); audio.riser(); }
    if (st === 'FINAL') { hud.announce('FINAL STAND', 'ITS LAST GENERATOR SCREAMS'); audio.roar(); }
    if (st === 'DAMAGE') hud.announce('DAMAGE PHASE', 'UNLOAD EVERYTHING');
    if (st === 'LOBBY' && prevSt !== 'LOBBY') hud.endScreen(null);
    audio.intensity(st === 'DAMAGE' || st === 'FINAL' ? 1 : st === 'LOBBY' ? 0 : 0.35);
    const mm = st === 'DAMAGE' ? 'heroic' : st === 'FINAL' ? 'final'
      : (st === 'MECH' || st === 'OBLIT') ? 'tense' : 'calm';
    audio.setMusic(mm, m.enc.round);
    prevSt = st;
  }
});

// grenades and their booms wear the thrower's class color on every screen
const clsColorOf = (id) => {
  const cls = snap?.players.find(p => p.id === id)?.cls;
  return cls ? new THREE.Color(CLASSES[cls].color).getHex() : null;
};

net.on('pf', (m) => {
  if (m.id === net.myId) return;
  if (!m.from || !m.dir) return;
  const from = new THREE.Vector3(...m.from);
  const dir = new THREE.Vector3(...m.dir);
  if (['auto', 'hand', 'sniper', 'shotgun', 'lmg'].includes(m.w)) {
    effects.tracer(from, from.clone().addScaledVector(dir, 60));
    audio.shot(m.w);
  } else if (['rocket', 'gjally', 'grenade', 'nova'].includes(m.w)) {
    const speed = m.w === 'rocket' ? 55 : m.w === 'gjally' ? WEAPONS.gjally.projSpeed : m.w === 'nova' ? SUPER.nova.speed : 22;
    const color = m.w === 'rocket' ? 0xffaa33 : m.w === 'gjally' ? 0x7dffb0 : m.w === 'nova' ? 0x9d4edd
      : (clsColorOf(m.id) ?? 0x7ae582);
    spawnRemoteProj(from, dir, speed, color, { big: m.w === 'nova', grav: m.w === 'grenade' });
    audio.shot(m.w === 'grenade' ? 'melee' : m.w === 'gjally' ? 'gjally' : 'rocket');
  }
});

net.on('explosion', (m) => {
  effects.explosion(new THREE.Vector3(...m.p), m.kind, m.kind === 'grenade' ? clsColorOf(m.by) : null);
  audio.explosion(m.kind === 'nova');
});
// voidcaller grenade orb: the server-owned DoT zone parks where the blast was
net.on('voidOrb', (m) => effects.voidOrb(new THREE.Vector3(m.p[0], m.p[1], m.p[2]), m.r, m.dur));
// sentinel mend-orb delivery: cyan pop + '+hp' number on every screen
net.on('healBurst', (m) => {
  const p = new THREE.Vector3(m.p[0], m.p[1], m.p[2]);
  effects.explosion(p, 'heal');
  effects.damageNumber(p, `+${m.amt}`, 'heal');
  if (m.id === net.myId) audio.pickup();
});
net.on('enemyDied', (m) => {
  // seekers die where they fly; ground adds pop at chest height
  effects.explosion(new THREE.Vector3(m.p[0], m.ty === 'seeker' ? m.p[1] : 1.2, m.p[2]), 'death');
  // an AoE multikill delivers many deaths in one tick — cap the sfx burst
  // (blisters always sound: bursting one is mechanic-critical feedback)
  const n = performance.now();
  if (m.ty === 'blister' || n - lastDieSfx > 60) {
    lastDieSfx = n;
    audio.enemyDie(m.ty, volAt(m.p));
  }
});
net.on('super', (m) => {
  const cls = snap?.players.find(p => p.id === m.id)?.cls;
  const superName = cls ? CLASSES[cls].superName : 'SUPER';
  hud.toast(`${m.name} unleashes ${superName}!`, 'warn');
  if (m.id === net.myId && weapons) weapons.onSuperConfirmed(m.kind, m.dir);
  else {
    audio.superCast(m.kind);
    if (m.kind === 'nova' && m.dir && snap) {
      const caster = snap.players.find(p => p.id === m.id);
      if (caster) {
        const from = new THREE.Vector3(caster.p[0], caster.p[1] + 1.5, caster.p[2]);
        spawnRemoteProj(from, new THREE.Vector3(...m.dir), SUPER.nova.speed, 0x9d4edd, { big: true });
      }
    }
  }
});
net.on('hurt', (m) => {
  hud.hurt();
  // pan toward the attacker when the hit carries a knockback direction
  let pan = 0;
  if (m.imp && player) {
    const ax = -m.imp[0], az = -m.imp[2]; // knockback points away from the source
    const len = Math.hypot(ax, az);
    if (len > 0.01) pan = (ax * Math.cos(player.yaw) - az * Math.sin(player.yaw)) / len;
  }
  audio.hurt(m.dmg, m.src, pan);
  effects.shake(Math.min(0.6, m.dmg / 80));
  // slam/seeker shoves are client-computed in their FX handlers (off our live
  // position); their imp is direction-for-the-pan only, never applied twice
  if (m.imp && player && m.src !== 'slam' && m.src !== 'seeker') player.impulse(m.imp);
});
net.on('ammo', (m) => { if (weapons) weapons.addAmmo(m.kind); });
// rally banner: ammo/cooldowns restock client-side (they live in WeaponSystem);
// the super gauge is server-owned — the server fills it on the same interact;
// bannerRallied gates the prompt so it stops offering a rally you've already taken
net.on('banner', (m) => audio.bannerPlant(volAt(m.p)));
net.on('restock', () => {
  bannerRallied = true;
  if (weapons) weapons.restock();
  hud.toast('Arms heavy and ready.', 'good');
});
net.on('down', () => audio.down());
net.on('revived', () => audio.revive());
net.on('shieldBreak', () => {
  audio.roar(); effects.shake(0.5);
  // mid-FINAL this is the generator surge ending, not a missile shield break
  if (snap && snap.enc.st === 'FINAL') hud.announce('THE GENERATOR DIES', 'UNLOAD EVERYTHING');
});
net.on('oblit', () => {
  // arena-wide white flash; muted if you made it into a well
  let safe = false;
  if (snap && player) {
    safe = snap.wells.some(w => Math.hypot(player.pos.x - w.p[0], player.pos.z - w.p[2]) < w.r);
  }
  hud.flash(safe ? 0.4 : 1.0);
  effects.shake(safe ? 0.4 : 1.0);
  audio.explosion(true);
});
net.on('bossSlam', () => {
  effects.shake(0.7); audio.slam();
  // shove ourselves off our live position, in sync with the slam FX — the
  // server's hurt only carries the damage (see the hurt handler)
  if (player && player.alive) {
    const d = Math.hypot(player.pos.x - ENC.bossPos[0], player.pos.z - ENC.bossPos[2]);
    if (d < ENC.slamRange + 2) {
      const dir = d > 0.1 ? [(player.pos.x - ENC.bossPos[0]) / d, (player.pos.z - ENC.bossPos[2]) / d] : [1, 0];
      player.impulse([dir[0] * ENC.slamKb[0], ENC.slamKb[1], dir[1] * ENC.slamKb[0]]);
    }
  }
});
net.on('bossVolley', () => audio.volley());
net.on('sweep', () => {
  hud.announce('ARENA PARTITION', 'THE BEAMS HUNT LOW');
  audio.laser();
});
net.on('barrage', () => {
  hud.announce('RHYTHMIC BARRAGE', 'KEEP THE BEAT');
  audio.volley();
});
net.on('bossWake', () => {
  audio.roar(); hud.announce('VAULTHUR AWAKENS', 'WATCHER OF THE DEEP');
  enemies.wake(); // the dormant hull drops out of its hover (ENC.wakeDrop)
});
// touchdown of the wake descent: the slam hurls the fireteam off the plate —
// harmless, client-computed off our live position like bossSlam, but a
// sustained shockwave wind
enemies.onBossSlam = () => {
  effects.shake(1.0); audio.slam();
  if (player && player.alive) player.blast(ENC.bossPos, ENC.wakeShove);
};
net.on('bossFocus', (m) => {
  audio.roar();
  if (m.id === net.myId) hud.announce('VAULTHUR MARKS YOU', 'ITS GAZE FINDS YOU');
  else hud.announce(`VAULTHUR MARKS ${m.name.toUpperCase()}`, 'ITS BACK LIES OPEN');
});
net.on('capsule', () => audio.pickup()); // progress lives in the side buff readout
net.on('keyGet', (m) => {
  // broadcast: whoever claimed it, the floor key vanishes for everyone at once
  if (entities) entities.removeKeyDrop(m.kid);
  if (m.id !== net.myId) return;
  audio.keyChime();
  hud.itemTip('RAID RELIC', 'AURIC KEY', '"Wakes one well. Once."');
});
net.on('wellWake', (m) => {
  audio.wellBloom();
  const ped = ARENA.pedestals[m.ped];
  if (ped) effects.explosion(new THREE.Vector3(ped.p[0], 1.5, ped.p[2]), 'death');
});
net.on('keeperSpawn', () => audio.roar());
// --- sky-sigil mechanic events ---
net.on('sigilNode', () => audio.ui()); // a star answers the shot
net.on('sigilMatch', (m) => {
  audio.keyChime();
  const name = ARENA.pedestals[m.color]?.name || '';
  hud.announce(`${name} CIPHER ACCEPTED`, 'THE LATTICE GATHERS LIGHT');
  // stars → focal dot → laser; the server's sigilBlast lands strikeDelay later
  world.sigilStrike(m.code, m.color, () => enemies.views.get(String(m.kid))?.group.position || null);
  setTimeout(() => audio.laser(), ENC.sigil.strikeDelay * 0.55 * 1000);
});
net.on('latticeGrab', (m) => {
  // the boss tethers the sky panel — world.update replays the seeded drag
  world.latticeGrab(m);
  audio.laser();
});
net.on('sigilBlast', (m) => {
  effects.explosion(new THREE.Vector3(m.p[0], 2, m.p[2]), 'nova');
  effects.shake(0.5);
  audio.explosion(true);
});
net.on('heraldRise', (m) => {
  audio.roar();
  const name = ARENA.pedestals[m.color]?.name || '';
  hud.announce('THE LAST KEEPER ASCENDS', `ATTUNED TO LOCK ${name}`);
});
net.on('wardBuff', () => {
  // private: this guardian kindled the lock — their fire now wounds the ward
  audio.wellBloom();
  hud.announce('THE LOCK ANSWERS YOU', 'ITS WARD LIES BARE');
});
net.on('wardBlast', (m) => {
  effects.explosion(new THREE.Vector3(m.p[0], m.p[1], m.p[2]), 'nova');
  effects.shake(0.6);
  audio.explosion(true);
});
net.on('wormhole', () => {
  audio.riser();
  hud.announce('THE SKY TEARS OPEN', 'SOMETHING VAST FALLS THROUGH');
});
net.on('missile', () => {
  // the lance detonates on the Watcher: blue flash, adds erased, shield ash
  hud.flash(0.9, '#7fc8ff');
  effects.shake(0.9);
  effects.explosion(new THREE.Vector3(ENC.bossPos[0], ENC.bossPos[1], ENC.bossPos[2]), 'nova');
  audio.explosion(true);
});
// boss seekers: salvo launch off the back, and a boom wherever one lands
// (shot-down seekers pop via the regular enemyDied path instead)
net.on('seekers', (m) => audio.seekerLaunch(m.n, volAt(ENC.bossPos)));
net.on('seekerBoom', (m) => {
  effects.explosion(new THREE.Vector3(m.p[0], m.p[1], m.p[2]), 'seeker');
  audio.explosion(false, volAt(m.p));
  // client-computed shove, mirroring detonateSeeker's chest-height blast check
  if (player && player.alive) {
    const def = ENEMIES.seeker;
    const c = [player.pos.x, player.pos.y + 1.0, player.pos.z];
    const d = Math.hypot(c[0] - m.p[0], c[1] - m.p[1], c[2] - m.p[2]);
    if (d < def.blastR) {
      const dir = d > 0.1 ? [(c[0] - m.p[0]) / d, (c[2] - m.p[2]) / d] : [0, 1];
      player.impulse([dir[0] * def.kb[0], def.kb[1], dir[1] * def.kb[0]]);
    }
  }
});
net.on('bossDied', (m) => {
  audio.victory();
  hud.announce('RAID COMPLETE', 'OPEN THE VAULT CACHE');
  setTimeout(() => { if (getEnc()?.st === 'VICTORY') hud.endScreen('win', m.stats); }, 2500);
  setTimeout(() => hud.endScreen(null), 8000);
});
net.on('wipe', (m) => { audio.wipe(); hud.endScreen('lose', m.stats); });
net.on('reset', (m) => {
  hud.endScreen(null);
  bannerRallied = false; // fresh lobby, fresh banner
  if (player) player.teleportToSpawn();
  audio.intensity(0);
  audio.setMusic('calm', 1);
  if (m.reason === 'victory') showLoadoutScreen(true); // re-pick class & weapons
});
net.on('unlock', (m) => {
  if (m.what === 'gjally') {
    unlocks.gjally = true;
    audio.unlockChime();
    hud.toast('✦ GJALLARHORN UNLOCKED ✦', 'good');
  }
});
net.on('loot', (m) => { hud.lootToast(m.item); audio.victory(); });
net.on('_closed', () => {
  if (!joined) return;
  hud.endScreen('lose');
  $('endTitle').textContent = 'DISCONNECTED';
  $('endSub').textContent = 'REFRESH TO REJOIN THE FIRETEAM';
});

// ---------- interact prompts ----------
function updatePrompt() {
  if (!snap || !player || !player.alive) { hud.prompt(null); return; }
  const my = me();
  if (!my) { hud.prompt(null); return; }
  const pos = player.pos;
  const dist2 = (p) => Math.hypot(pos.x - p[0], pos.z - p[2]);

  const channeling = my.rv > serverNow();
  for (const p of snap.players) {
    if (!p.dn || p.id === net.myId) continue;
    if (dist2(p.p) < PLAYER.reviveRange) {
      // the channel progress bar takes over once the revive is running
      hud.prompt(channeling ? null : `PRESS <b>E</b> — REVIVE ${p.name.toUpperCase()} (3s)`);
      return;
    }
  }
  if (snap.chest && dist2(snap.chest.p) < PLAYER.interactRange + 0.5) {
    hud.prompt('PRESS <b>E</b> — OPEN THE VAULT CACHE');
    return;
  }
  if (snap.enc.st === 'LOBBY') {
    if (!snap.banner && dist2(ENC.banner.pos) < ENC.banner.placeR) {
      hud.prompt('PRESS <b>E</b> — PLANT THE FIRETEAM STANDARD');
      return;
    }
    if (snap.banner && !bannerRallied && dist2(snap.banner.p) < ENC.banner.restockR) {
      hud.prompt('PRESS <b>E</b> — RALLY AT THE STANDARD');
      return;
    }
  }
  hud.prompt(null);
}

// ---------- adaptive resolution + fps readout ----------
const perfEl = $('perf');
let frameAcc = 0, frameN = 0, perfNextAt = 0;
function perfTick(dt, now) {
  frameAcc += dt; frameN++;
  if (now < perfNextAt) return;
  perfNextAt = now + 1.5;
  const avg = frameAcc / Math.max(1, frameN);
  frameAcc = 0; frameN = 0;
  let next = prCurrent;
  if (avg > 1 / 45 && prCurrent > 0.75) next = Math.max(0.75, prCurrent - 0.25);       // struggling: drop res
  else if (avg < 1 / 70 && prCurrent < PR_MAX) next = Math.min(PR_MAX, prCurrent + 0.25); // headroom: restore
  if (next !== prCurrent) {
    prCurrent = next;
    renderer.setPixelRatio(prCurrent);
    renderer.setSize(innerWidth, innerHeight);
  }
  if (perfEl) perfEl.textContent = `${Math.round(1 / avg)} FPS · ${Math.round(prCurrent / PR_MAX * 100)}% RES`;
}

// ---------- main loop + spike profiler ----------
// When the gap between frames exceeds 50 ms, log where the PREVIOUS frame spent
// its time: per-stage ms, ws-handler ms accumulated between frames, and the JS
// heap delta (a large negative delta = a GC pass landed). Read the [spike] line
// in the console to attribute residual hitches instead of guessing.
const stageMs = { world: 0, enemies: 0, effects: 0, proj: 0, sim: 0, render: 0 };
let lastSpikeAt = 0, prevHeap = 0;

let last = performance.now() / 1000;
function loop() {
  requestAnimationFrame(loop);
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, now - last);
  last = now;

  const heap = performance.memory ? performance.memory.usedJSHeapSize : 0;
  if (joined && dt > 0.05 && now - lastSpikeAt > 1) {
    lastSpikeAt = now;
    const parts = Object.entries(stageMs).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · ');
    const gc = heap && prevHeap ? ` · heapΔ ${((heap - prevHeap) / 1048576).toFixed(1)}MB` : '';
    console.warn(`[spike] ${(dt * 1000).toFixed(0)}ms frame — prev frame ms: ${parts} · ws ${net.handlerMs.toFixed(1)}${gc}`);
  }
  prevHeap = heap;
  net.handlerMs = 0;

  perfTick(dt, now);
  const renderTime = now - 0.13; // interpolation delay
  let stageT = performance.now();
  const mark = (key) => { const n2 = performance.now(); stageMs[key] = n2 - stageT; stageT = n2; };

  world.update(dt, getEnc(), serverNow());
  mark('world');
  enemies.update(dt, renderTime, joined ? camera : null);
  mark('enemies');
  effects.update(dt);
  mark('effects');

  for (let i = remoteProjs.length - 1; i >= 0; i--) {
    const p = remoteProjs[i];
    if (p.grav) p.vel.y -= 20 * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    p.ttl -= dt;
    if (p.ttl <= 0 || p.mesh.position.y < 0) { scene.remove(p.mesh); remoteProjs.splice(i, 1); }
  }
  mark('proj');

  const lobbyVisible = !$('lobbyScreen').classList.contains('hidden');
  if (joined && player && !lobbyVisible) {
    player.update(dt, now);
    weapons.update(dt, now);
    entities.update(dt, renderTime, now, player.pos);
    const my = me();
    hud.update(dt, snap, my, weapons, serverNow(), net.myId);
    updatePrompt();
    effects.applyShake(camera);

    // movement foley: landings, jump whooshes, footsteps paced by speed
    if (!prevGrounded && player.onGround) audio.land(prevVy < -14);
    if (player.vel.y > 8 && prevVy < player.vel.y - 5) audio.jump();
    const hSpeed = Math.hypot(player.vel.x, player.vel.z);
    if (player.onGround && player.alive && hSpeed > 3) {
      stepIn -= dt * hSpeed / 8;
      if (stepIn <= 0) { stepIn = 0.42; audio.footstep(player.sprinting); }
    } else stepIn = Math.min(stepIn, 0.12);
    prevGrounded = player.onGround; prevVy = player.vel.y;

    // low-health heartbeat, quickening as hp falls
    if (my && !my.dn && !my.dd && my.hp > 0 && my.hp < 70) {
      heartbeatIn -= dt;
      if (heartbeatIn <= 0) { heartbeatIn = 0.5 + (my.hp / 70) * 0.55; audio.heartbeat(); }
    } else heartbeatIn = 0.25;

    // countdown ticks through the last seconds of Obliteration / Annihilation
    const encNow = getEnc();
    if (encNow && (encNow.st === 'OBLIT' || encNow.st === 'FINAL') && encNow.ends) {
      const remain = encNow.ends - serverNow();
      const windowS = encNow.st === 'OBLIT' ? 3 : 5;
      const sec = Math.ceil(remain);
      if (remain > 0 && remain <= windowS && sec !== lastTickSec) {
        lastTickSec = sec;
        audio.countTick(encNow.st === 'OBLIT');
      }
    } else lastTickSec = -1;

    // capsule touchdown thuds
    for (const c of capsTracked.values()) {
      if (!c.landed && serverNow() >= c.land) { c.landed = true; audio.capsuleLand(volAt(c.p)); }
    }

    // incoming-ordnance whine: tracks the nearest live seeker — pitch and
    // volume climb as it closes, panned toward it (one persistent loop node
    // in audio.js, gain 0 when none are airborne)
    let seekNear = 0, seekPan = 0;
    for (const v of enemies.views.values()) {
      if (v.ty !== 'seeker') continue;
      const wp = v.group.position;
      const dx = wp.x - player.pos.x, dz = wp.z - player.pos.z;
      const d = Math.hypot(dx, wp.y - (player.pos.y + 1.2), dz);
      const c = Math.max(0, 1 - d / 26);
      if (c > seekNear) {
        seekNear = c;
        seekPan = d > 1 ? (dx * Math.cos(player.yaw) - dz * Math.sin(player.yaw)) / d : 0;
      }
    }
    audio.seekerWhine(seekNear, seekPan);
  } else audio.seekerWhine(0); // back in the lobby/dead reset: silence the loop
  mark('sim');

  if (lobbyVisible) {
    // selection screen: render the guardian/loadout showcase instead of the arena
    updateShowcase(now);
    renderer.render(showcaseScene, showcaseCam);
  } else {
    renderer.render(scene, camera);
  }
  mark('render');
}
loop();

// ---------- loading veil release ----------
// #loadScreen (static HTML, painted before this module evaluates) covers the
// dead window where the lobby is visible but inert: module fetch/parse plus
// the warmup frame above. Lift it only after the first live frame has drawn
// beneath it, and never before the minimum hold — a sub-second flash of a
// loading screen reads as a glitch, not a load.
{
  const veil = $('loadScreen');
  const MIN_HOLD_MS = 1400; // measured from navigation start (performance.now origin)
  requestAnimationFrame(() => setTimeout(() => {
    veil.classList.add('out');
    setTimeout(() => veil.classList.add('hidden'), 800); // past the .7s opacity transition
  }, Math.max(0, MIN_HOLD_MS - performance.now())));
}
