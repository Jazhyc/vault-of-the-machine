import * as THREE from 'three';
import { PLAYER, ARENA } from '/shared/constants.js';
import { collidePlayer } from './world.js';

export class LocalPlayer {
  constructor(camera, net) {
    this.camera = camera;
    this.net = net;
    this.pos = new THREE.Vector3(...ARENA.spawn);   // feet
    this.vel = new THREE.Vector3();
    this.yaw = 0;   // face the arena center (spawn is at +Z; yaw 0 looks down −Z)
    this.pitch = 0;
    this.onGround = true;
    this.airJumps = 1;
    this.keys = new Set();
    this.jumpBufferUntil = 0;   // jump pressed slightly early still fires on landing
    this.lastGroundedAt = 0;    // coyote time: jump slightly after leaving ground
    this.baseFov = 72;
    this.fovTarget = this.baseFov;
    this.sens = 0.0023;
    this.lastSent = 0;
    this.bobT = 0;
    this.recoilP = 0; this.recoilY = 0;   // applied camera recoil (chases the target)
    this.recoilTP = 0; this.recoilTY = 0; // recoil target — kicks add here, eases back to 0

    // mirrored server state
    this.hp = PLAYER.maxHp;
    this.sup = 0;
    this.downed = false;
    this.dead = false;
    this.goldenUntil = 0;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.jumpBufferUntil = performance.now() / 1000 + 0.13;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) {
        const zoomScale = this.camera.fov / this.baseFov;
        this.yaw -= e.movementX * this.sens * Math.max(0.35, zoomScale);
        this.pitch -= e.movementY * this.sens * Math.max(0.35, zoomScale);
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));
      }
    });
  }

  get alive() { return !this.downed && !this.dead; }

  applyServerSelf(p, serverNow) {
    const wasAlive = this.alive;
    this.hp = p.hp; this.sup = p.sup;
    this.downed = p.dn; this.dead = p.dd;
    this.goldenUntil = p.gu; this.serverNow = serverNow;
    this.wardUntil = p.wb;
    this.bleedAt = p.bleedAt;
    if (wasAlive && !this.alive) this.vel.set(0, 0, 0);
  }

  get golden() { return this.goldenUntil > (this.serverNow || 0); }
  get wardbreak() { return (this.wardUntil || 0) > (this.serverNow || 0); }

  impulse(v) { this.vel.x += v[0]; this.vel.y += v[1]; this.vel.z += v[2]; }

  teleportToSpawn() {
    this.pos.set(...ARENA.spawn);
    this.vel.set(0, 0, 0);
    this.yaw = 0; // face the arena center
    this.pitch = 0;
  }

  update(dt, now) {
    const k = this.keys;
    let fx = 0, fz = 0;
    if (this.alive && document.pointerLockElement) {
      if (k.has('KeyW')) fz += 1;
      if (k.has('KeyS')) fz -= 1;
      if (k.has('KeyA')) fx -= 1;
      if (k.has('KeyD')) fx += 1;
    }
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len;

    const sprinting = k.has('ShiftLeft') && fz > 0.5;
    this.sprinting = sprinting && Math.hypot(this.vel.x, this.vel.z) > 4; // for weapon carry anim
    const speed = sprinting ? PLAYER.sprint : PLAYER.walk;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wishX = (fx * cos - fz * sin) * speed;
    const wishZ = (-fz * cos - fx * sin) * speed;

    const control = this.onGround ? 1 : PLAYER.airControl;
    const blend = Math.min(1, 13 * control * dt);
    this.vel.x += (wishX - this.vel.x) * blend;
    this.vel.z += (wishZ - this.vel.z) * blend;

    // jump & double jump, with jump buffering + coyote time
    if (this.onGround) this.lastGroundedAt = now;
    if (now < this.jumpBufferUntil && this.alive) {
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

    this.vel.y -= PLAYER.gravity * dt;
    this.pos.addScaledVector(this.vel, dt);

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
