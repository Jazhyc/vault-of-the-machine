import * as THREE from 'three';
import { PLAYER, ARENA } from '/shared/constants.js';
import { collidePlayer } from './world.js';
import { code, sens } from './settings.js';

export class LocalPlayer {
  constructor(camera, net) {
    this.camera = camera;
    this.net = net;
    this.pos = new THREE.Vector3(...ARENA.spawn);   // feet
    this.vel = new THREE.Vector3();
    this.yaw = ARENA.spawnYaw;   // face the arena center
    this.pitch = 0;
    this.onGround = true;
    this.airJumps = 1;
    this.keys = new Set();
    this.jumpBufferUntil = 0;   // jump pressed slightly early still fires on landing
    this.lastGroundedAt = 0;    // coyote time: jump slightly after leaving ground
    this.baseFov = 72;
    this.fovTarget = this.baseFov;
    this.lastSent = 0;
    this.bobT = 0;
    this.recoilP = 0; this.recoilY = 0;   // applied camera recoil (chases the target)
    this.recoilTP = 0; this.recoilTY = 0; // recoil target — kicks add here, eases back to 0
    this.impBudget = PLAYER.kbFrameCap;   // per-frame knockback budget (see impulse)
    this.windT = 0;                       // shockwave wind remaining (see blast)
    this.windDir = [1, 0];
    this.windAcc = 0;
    this.cine = 0;                        // super-cast flourish remaining (s) — see startSuperCine
    this.cineDur = 1;

    // mirrored server state
    this.hp = PLAYER.maxHp;
    this.sup = 0;
    this.downed = false;
    this.dead = false;
    this.goldenUntil = 0;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === code('jump')) this.jumpBufferUntil = performance.now() / 1000 + 0.13;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('mousemove', (e) => {
      if (this.cine > 0) return; // the flourish owns the camera — look stays where the cast aimed
      if (document.pointerLockElement) {
        const zoomScale = this.camera.fov / this.baseFov;
        const s = sens();
        this.yaw -= e.movementX * s * Math.max(0.35, zoomScale);
        this.pitch -= e.movementY * s * Math.max(0.35, zoomScale);
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
      }
    });
  }

  get alive() { return !this.downed && !this.dead; }
  get cineActive() { return this.cine > 0; }
  // 0→1 progress through the flourish (drives the third-person body + FX)
  get cineK() { return this.cine > 0 ? 1 - this.cine / this.cineDur : 0; }

  // Destiny-style super flourish: the camera eases out behind the guardian,
  // movement and look are rooted (the server grants SUPER.cast.dr meanwhile),
  // the caster hangs wherever the cast caught them — gravity, wind and shoves
  // pause, because falling out of your own cinematic reads as a glitch — and
  // update() glides back to first person as the window closes.
  startSuperCine(dur) { this.cine = dur; this.cineDur = dur; }

  applyServerSelf(p, serverNow) {
    const wasAlive = this.alive;
    this.hp = p.hp; this.sup = p.sup;
    this.downed = p.dn; this.dead = p.dd;
    this.goldenUntil = p.gu; this.serverNow = serverNow;
    this.wardUntil = p.wb;
    if (wasAlive && !this.alive) this.vel.set(0, 0, 0);
  }

  get golden() { return this.goldenUntil > (this.serverNow || 0); }
  get wardbreak() { return (this.wardUntil || 0) > (this.serverNow || 0); }

  // Budgeted per frame (PLAYER.kbFrameCap, reset in update): TCP clumping at
  // high ping can deliver several shoves between frames; the sum is scaled
  // down so a clump never out-throws the strongest single hit.
  // scripted shockwave (boss wake): an instant lift plus a wind that keeps
  // pushing away from `from` for dur seconds. Deliberately bypasses the
  // impulse budget — that cap tames clumped hurt messages, and a sustained
  // force is the only way a shove can outrun the air blend's velocity bleed.
  blast(from, { acc, lift, dur }) {
    const dx = this.pos.x - from[0], dz = this.pos.z - from[2];
    const d = Math.hypot(dx, dz);
    this.windDir = d > 0.1 ? [dx / d, dz / d] : [1, 0];
    this.windAcc = acc;
    this.windT = dur;
    this.vel.y = Math.max(this.vel.y, lift);
    this.onGround = false;
  }

  impulse(v) {
    const mag = Math.hypot(v[0], v[1], v[2]);
    if (mag < 0.001) return;
    const s = Math.min(1, this.impBudget / mag);
    if (s <= 0) return;
    this.impBudget -= mag * s;
    this.vel.x += v[0] * s; this.vel.y += v[1] * s; this.vel.z += v[2] * s;
  }

  teleportToSpawn() {
    this.pos.set(...ARENA.spawn);
    this.vel.set(0, 0, 0);
    this.windT = 0;
    this.cine = 0;
    this.yaw = ARENA.spawnYaw; // face the arena center
    this.pitch = 0;
  }

  update(dt, now) {
    this.impBudget = PLAYER.kbFrameCap;
    if (this.cine > 0 && !this.alive) this.cine = 0; // downed mid-flourish: snap straight back
    const k = this.keys;
    let fx = 0, fz = 0;
    if (this.alive && document.pointerLockElement && this.cine <= 0) {
      if (k.has(code('forward'))) fz += 1;
      if (k.has(code('back'))) fz -= 1;
      if (k.has(code('left'))) fx -= 1;
      if (k.has(code('right'))) fx += 1;
    }
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len;

    const sprinting = k.has(code('sprint')) && fz > 0.5;
    this.sprinting = sprinting && Math.hypot(this.vel.x, this.vel.z) > 4; // for weapon carry anim
    const speed = sprinting ? PLAYER.sprint : PLAYER.walk;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wishX = (fx * cos - fz * sin) * speed;
    const wishZ = (-fz * cos - fx * sin) * speed;

    const control = this.onGround ? 1 : PLAYER.airControl;
    const blend = Math.min(1, 13 * control * dt);
    this.vel.x += (wishX - this.vel.x) * blend;
    this.vel.z += (wishZ - this.vel.z) * blend;

    // shockwave wind: applied after the blend so input can't cancel the ride
    if (this.windT > 0) {
      this.windT -= dt;
      this.vel.x += this.windDir[0] * this.windAcc * dt;
      this.vel.z += this.windDir[1] * this.windAcc * dt;
    }

    // jump & double jump, with jump buffering + coyote time
    if (this.onGround) this.lastGroundedAt = now;
    if (now < this.jumpBufferUntil && this.alive && this.cine <= 0) {
      const coyote = now - this.lastGroundedAt < 0.1 && this.vel.y <= 0.1;
      if (this.onGround || coyote) {
        this.vel.y = PLAYER.jumpVel;
        this.onGround = false;
        this.jumpBufferUntil = 0;
      } else if (this.airJumps > 0) {
        this.vel.y = PLAYER.jumpVel * 0.95;
        this.airJumps--;
        this.jumpBufferUntil = 0;
      }
    }

    // the flourish suspends the caster where the cast caught them: velocity
    // dies and gravity/wind/shoves pause until the camera comes home
    if (this.cine > 0) {
      this.vel.set(0, 0, 0);
    } else {
      this.vel.y -= PLAYER.gravity * dt;
      this.pos.addScaledVector(this.vel, dt);
    }

    if (this.pos.y <= 0) {
      this.pos.y = 0;
      this.vel.y = 0;
      this.onGround = true;
      this.airJumps = 1;
    } else this.onGround = false;

    collidePlayer(this.pos, PLAYER.radius);

    // camera
    const moving = Math.hypot(this.vel.x, this.vel.z) > 1 && this.onGround;
    this.bobT += dt * (sprinting ? 13 : 9);
    const bob = moving ? Math.sin(this.bobT) * 0.045 : 0;
    // Recoil is two-stage: a kick raises the target instantly, the applied
    // offset chases it (the snap), and the target eases back toward zero (the
    // recovery). Sustained fire outpaces the recovery, so the spray visibly
    // walks the weapon's pattern instead of vanishing between shots.
    const chase = Math.min(1, 35 * dt);
    this.recoilP += (this.recoilTP - this.recoilP) * chase;
    this.recoilY += (this.recoilTY - this.recoilY) * chase;
    const rec = Math.pow(0.015, dt);
    this.recoilTP *= rec; this.recoilTY *= rec;
    this.camera.position.set(this.pos.x, this.pos.y + PLAYER.eye + bob, this.pos.z);
    // Explicitly zero roll: the lobby orbit camera's lookAt leaves a z (roll)
    // component behind, which otherwise tilts the view for the whole session.
    this.camera.rotation.set(this.pitch + this.recoilP, this.yaw + this.recoilY, 0, 'YXZ');
    // Super flourish: ease out behind the guardian with a slow orbital drift,
    // then glide back in over the last fifth. Both endpoints blend to the
    // exact first-person pose (camera at the eye, look target 6 m down the
    // aim), so there is never a cut. lookAt keeps up = world-Y → no roll, and
    // the rotation.set above re-zeros everything the frame the flourish ends.
    if (this.cine > 0) {
      this.cine -= dt;
      const k = this.cineK;
      const ease = (x) => x * x * (3 - 2 * x);
      const lift = ease(Math.min(1, k / 0.2)) - ease(Math.max(0, (k - 0.8) / 0.2));
      const a = this.yaw + (k - 0.5) * 0.7 * lift; // drift around the cast
      const cp = Math.cos(this.pitch);
      this.camera.position.set(
        this.pos.x + Math.sin(a) * 3.4 * lift,
        this.pos.y + PLAYER.eye + 1.1 * lift,
        this.pos.z + Math.cos(a) * 3.4 * lift,
      );
      this.camera.lookAt(
        this.pos.x - Math.sin(this.yaw) * cp * 6 * (1 - lift),
        this.pos.y + 1.3 + (PLAYER.eye - 1.3 + Math.sin(this.pitch) * 6) * (1 - lift),
        this.pos.z - Math.cos(this.yaw) * cp * 6 * (1 - lift),
      );
    }
    this.camera.fov += (this.fovTarget - this.camera.fov) * Math.min(1, 14 * dt);
    this.camera.updateProjectionMatrix();

    // network state
    if (now - this.lastSent > 0.066) {
      this.lastSent = now;
      this.net.sendState(
        [Math.round(this.pos.x * 100) / 100, Math.round(this.pos.y * 100) / 100, Math.round(this.pos.z * 100) / 100],
        Math.round(this.yaw * 100) / 100,
        Math.round(this.pitch * 100) / 100,
      );
    }
  }

  kick(p, y = 0) { this.recoilTP += p; this.recoilTY += y; }
}
