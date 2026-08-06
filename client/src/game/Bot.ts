import {
  applyDamage as applyDamageToCombatState,
  armHitBoxes,
  BoxCollider,
  createPlayerCombatState,
  eyeHeightOffset,
  HEAD_BAND_MAX_Y,
  HEAD_BAND_MIN_Y,
  HitZone,
  legHitBox,
  PlayerCombatState,
  PlayerPhysicsState,
  rayIntersectsBox,
  respawn,
  SIM_DT,
  SpawnPoint,
  STAMINA_MAX,
  stepPlayerMovement,
  Vec3,
  WeaponState,
} from "@fps/shared";
import * as THREE from "three";
import { buildCharacterModel, CharacterModel } from "../render/characterModel";
import { BotDifficultyConfig } from "./botDifficulty";

const MAX_ACCUMULATED_DT = 0.25;
const IDEAL_RANGE_MIN = 6;
const IDEAL_RANGE_MAX = 15;
const STRAFE_SWITCH_MIN_MS = 900;
const STRAFE_SWITCH_MAX_MS = 2200;
const BOT_COLOR = 0xd9553f;
const UNSTUCK_CHECK_MS = 700;
const UNSTUCK_MOVE_THRESHOLD = 0.35;
const UNSTUCK_BACKOFF_MS = 550;

export interface BotFireEvent {
  origin: Vec3;
  dir: Vec3;
}

/**
 * AI-controlled opponent for the solo "vs Computer" mode — sibling to a
 * real player in every way that matters for combat/physics (same shared
 * stepPlayerMovement, same PlayerCombatState, same WeaponState, same
 * head/torso/limb hitboxes a real shot classifies against), just driven by
 * a decision loop instead of network input. Deliberately local-only: no
 * position history/interpolation buffer like RemotePlayer needs, since
 * there's no network jitter to smooth over — the bot's mesh always reflects
 * its current physics state directly, one process, one frame.
 */
export class Bot {
  physics: PlayerPhysicsState;
  yaw: number;
  readonly combat: PlayerCombatState = createPlayerCombatState();
  readonly weapon = new WeaponState();

  readonly mesh: THREE.Mesh;
  readonly headMesh: THREE.Mesh;
  readonly legMesh: THREE.Mesh;
  readonly armMeshLeft: THREE.Mesh;
  readonly armMeshRight: THREE.Mesh;

  private geometry: THREE.CapsuleGeometry;
  private headGeometry: THREE.SphereGeometry;
  private legGeometry: THREE.BoxGeometry;
  private armGeometry: THREE.BoxGeometry;
  private material: THREE.MeshLambertMaterial;
  private character: CharacterModel;

  private accumulator = 0;
  private seq = 0;
  private readonly spawnPosition: Vec3;
  private readonly spawnYaw: number;

  private strafeDir: 1 | -1 = 1;
  private strafeChangeAtMs = 0;
  private losAcquiredAtMs: number | null = null;
  /** No real pathfinding/wall-avoidance here — just approach/retreat/strafe
   * input each frame, so it's entirely possible for that input to keep
   * pushing the bot straight into a wall or piece of cover with nowhere to
   * go. Comparing position every UNSTUCK_CHECK_MS and forcing a strafe
   * flip (+ a brief random extra kick) if it barely moved is a cheap,
   * standard fix for this class of steering-free AI — not real pathing,
   * but enough to keep it from parking itself against geometry forever. */
  private unstuckCheckAtMs = 0;
  private positionAtLastUnstuckCheck: Vec3 | null = null;
  private forceBackoffUntilMs = 0;
  private lastFireAttemptMs = 0;

  constructor(
    scene: THREE.Scene,
    private spawn: SpawnPoint,
    private colliders: readonly BoxCollider[],
    private ladders: readonly BoxCollider[]
  ) {
    this.spawnPosition = { ...spawn.position };
    this.spawnYaw = spawn.yaw;
    this.physics = { position: { ...spawn.position }, velocity: { x: 0, y: 0, z: 0 }, onGround: false, crouching: false, stamina: STAMINA_MAX, staminaRegenCooldownMs: 0 };
    this.yaw = spawn.yaw;

    this.geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.headGeometry = new THREE.SphereGeometry(0.22, 8, 6);
    const origin = { x: 0, y: 0, z: 0 };
    const leg = legHitBox(origin);
    this.legGeometry = new THREE.BoxGeometry(leg.half.x * 2, leg.half.y * 2, leg.half.z * 2);
    const [armLeft] = armHitBoxes(origin);
    this.armGeometry = new THREE.BoxGeometry(armLeft.half.x * 2, armLeft.half.y * 2, armLeft.half.z * 2);
    this.material = new THREE.MeshLambertMaterial({ color: BOT_COLOR, visible: false });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.botRef = this;
    this.mesh.userData.hitZone = "torso" as HitZone;
    this.headMesh = new THREE.Mesh(this.headGeometry, this.material);
    this.headMesh.userData.botRef = this;
    this.headMesh.userData.hitZone = "head" as HitZone;
    this.legMesh = new THREE.Mesh(this.legGeometry, this.material);
    this.legMesh.userData.botRef = this;
    this.legMesh.userData.hitZone = "limb" as HitZone;
    this.armMeshLeft = new THREE.Mesh(this.armGeometry, this.material);
    this.armMeshLeft.userData.botRef = this;
    this.armMeshLeft.userData.hitZone = "limb" as HitZone;
    this.armMeshRight = new THREE.Mesh(this.armGeometry, this.material);
    this.armMeshRight.userData.botRef = this;
    this.armMeshRight.userData.hitZone = "limb" as HitZone;
    for (const m of this.raycastMeshes) scene.add(m);
    this.positionHitboxes();

    this.character = buildCharacterModel(BOT_COLOR);
    this.character.setHoldingWeapon(true);
    this.mesh.add(this.character.root);

    this.rollNextStrafeSwitch(Date.now());
  }

  get raycastMeshes(): THREE.Mesh[] {
    return [this.mesh, this.headMesh, this.legMesh, this.armMeshLeft, this.armMeshRight];
  }

  getEyePosition(): Vec3 {
    return { x: this.physics.position.x, y: this.physics.position.y + eyeHeightOffset(this.physics.crouching), z: this.physics.position.z };
  }

  private positionHitboxes(): void {
    const p = this.physics.position;
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.rotation.y = this.yaw;
    this.headMesh.position.set(p.x, p.y + (HEAD_BAND_MIN_Y + HEAD_BAND_MAX_Y) / 2 + 0.05, p.z);
    const leg = legHitBox(p);
    this.legMesh.position.set(leg.center.x, leg.center.y, leg.center.z);
    const [armLeft, armRight] = armHitBoxes(p);
    this.armMeshLeft.position.set(armLeft.center.x, armLeft.center.y, armLeft.center.z);
    this.armMeshRight.position.set(armRight.center.x, armRight.center.y, armRight.center.z);
  }

  private rollNextStrafeSwitch(nowMs: number): void {
    this.strafeChangeAtMs = nowMs + STRAFE_SWITCH_MIN_MS + Math.random() * (STRAFE_SWITCH_MAX_MS - STRAFE_SWITCH_MIN_MS);
  }

  /** Runs the AI decision loop + physics for one frame. Returns a fire
   * event if the bot decided to shoot this frame (BotMode resolves the
   * actual hit against the player, same as a server resolving a client's
   * shot — this class only decides to pull the trigger and where). */
  update(frameDt: number, nowMs: number, difficulty: BotDifficultyConfig, playerPos: Vec3, playerAlive: boolean): BotFireEvent | null {
    this.weapon.update(frameDt * 1000);

    if (!this.combat.alive || !playerAlive) {
      this.character.updateAnimation(frameDt * 1000, 0, 0, this.weapon.isReloading, this.physics.crouching);
      return null;
    }

    const eye = this.getEyePosition();
    const dx = playerPos.x - eye.x;
    const dz = playerPos.z - eye.z;
    const distXZ = Math.hypot(dx, dz);
    const hasLineOfSight = distXZ > 1e-6 && this.hasClearShot(eye, playerPos);

    if (hasLineOfSight) {
      if (this.losAcquiredAtMs === null) this.losAcquiredAtMs = nowMs;
    } else {
      this.losAcquiredAtMs = null;
    }

    // Smoothly turn to face the player at a limited rate rather than
    // snapping — see BotDifficultyConfig.aimTurnSpeed's comment.
    if (distXZ > 1e-6) {
      const idealYaw = Math.atan2(-dx / distXZ, -dz / distXZ);
      let diff = ((idealYaw - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (diff < -Math.PI) diff += Math.PI * 2;
      const maxStep = difficulty.aimTurnSpeed * frameDt;
      this.yaw += Math.max(-maxStep, Math.min(maxStep, diff));
    }

    if (nowMs >= this.strafeChangeAtMs) {
      this.strafeDir = Math.random() < 0.5 ? 1 : -1;
      this.rollNextStrafeSwitch(nowMs);
    }

    if (nowMs >= this.unstuckCheckAtMs) {
      if (this.positionAtLastUnstuckCheck) {
        const moved = Math.hypot(
          this.physics.position.x - this.positionAtLastUnstuckCheck.x,
          this.physics.position.z - this.positionAtLastUnstuckCheck.z
        );
        if (moved < UNSTUCK_MOVE_THRESHOLD) {
          this.strafeDir = this.strafeDir === 1 ? -1 : 1;
          this.rollNextStrafeSwitch(nowMs);
          this.forceBackoffUntilMs = nowMs + UNSTUCK_BACKOFF_MS;
        }
      }
      this.positionAtLastUnstuckCheck = { ...this.physics.position };
      this.unstuckCheckAtMs = nowMs + UNSTUCK_CHECK_MS;
    }

    let forward = 0;
    if (nowMs < this.forceBackoffUntilMs) forward = -1;
    else if (distXZ < IDEAL_RANGE_MIN) forward = -1;
    else if (distXZ > IDEAL_RANGE_MAX) forward = 1;
    const right = hasLineOfSight || nowMs < this.forceBackoffUntilMs ? this.strafeDir : 0;

    this.accumulator += Math.min(frameDt, MAX_ACCUMULATED_DT);
    while (this.accumulator >= SIM_DT) {
      this.physics = stepPlayerMovement(
        this.physics,
        { forward, right, jump: false, yaw: this.yaw, seq: this.seq++, dt: SIM_DT },
        this.colliders,
        this.ladders
      );
      this.accumulator -= SIM_DT;
    }

    this.positionHitboxes();
    const speed = Math.hypot(this.physics.velocity.x, this.physics.velocity.z);
    this.character.updateAnimation(frameDt * 1000, speed, 0, this.weapon.isReloading, this.physics.crouching);

    let fireEvent: BotFireEvent | null = null;
    const reactionElapsed = this.losAcquiredAtMs !== null && nowMs - this.losAcquiredAtMs >= difficulty.reactionMs;
    const cooldownElapsed = nowMs - this.lastFireAttemptMs >= difficulty.fireIntervalMs;
    if (hasLineOfSight && reactionElapsed && cooldownElapsed) {
      this.lastFireAttemptMs = nowMs;
      const result = this.weapon.tryFire();
      if (result.fired) {
        fireEvent = this.buildFireEvent(eye, playerPos, difficulty.aimErrorRad);
      }
    }

    return fireEvent;
  }

  private hasClearShot(eye: Vec3, targetEye: Vec3): boolean {
    const dir = { x: targetEye.x - eye.x, y: targetEye.y - eye.y, z: targetEye.z - eye.z };
    const dist = Math.hypot(dir.x, dir.y, dir.z);
    if (dist < 1e-6) return true;
    const norm = { x: dir.x / dist, y: dir.y / dist, z: dir.z / dist };
    for (const block of this.colliders) {
      const hit = rayIntersectsBox(eye, norm, block, dist - 0.05);
      if (hit !== null) return false;
    }
    return true;
  }

  private buildFireEvent(eye: Vec3, targetPos: Vec3, aimErrorRad: number): BotFireEvent {
    // Aim at the target's torso height (roughly eye-level minus a bit),
    // not their exact eye — a real player's own PLAYER_EYE_HEIGHT sits
    // near the very top of their hitbox, so aiming precisely there wastes
    // a chunk of the error cone above the player's head.
    const targetPoint = { x: targetPos.x, y: targetPos.y + 0.2, z: targetPos.z };
    const forward = new THREE.Vector3(
      targetPoint.x - eye.x,
      targetPoint.y - eye.y,
      targetPoint.z - eye.z
    ).normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const r = Math.sqrt(Math.random()) * aimErrorRad;
    const theta = Math.random() * Math.PI * 2;
    const jittered = forward
      .clone()
      .addScaledVector(right, Math.cos(theta) * r)
      .addScaledVector(up, Math.sin(theta) * r)
      .normalize();

    return { origin: eye, dir: { x: jittered.x, y: jittered.y, z: jittered.z } };
  }

  applyDamage(amount: number, nowMs: number): { applied: boolean; killed: boolean } {
    const result = applyDamageToCombatState(this.combat, amount, nowMs);
    if (!result.applied) return result;
    this.character.flashHit();
    if (result.killed) {
      for (const m of this.raycastMeshes) m.visible = false;
    }
    return result;
  }

  respawnAt(nowMs: number): void {
    respawn(this.combat, nowMs);
    this.physics = { position: { ...this.spawnPosition }, velocity: { x: 0, y: 0, z: 0 }, onGround: false, crouching: false, stamina: STAMINA_MAX, staminaRegenCooldownMs: 0 };
    this.yaw = this.spawnYaw;
    for (const m of this.raycastMeshes) m.visible = true;
    this.positionHitboxes();
    this.losAcquiredAtMs = null;
    this.positionAtLastUnstuckCheck = null;
    this.forceBackoffUntilMs = 0;
  }

  dispose(scene: THREE.Scene): void {
    for (const m of this.raycastMeshes) scene.remove(m);
    this.geometry.dispose();
    this.headGeometry.dispose();
    this.legGeometry.dispose();
    this.armGeometry.dispose();
    this.material.dispose();
    this.character.dispose();
  }
}
