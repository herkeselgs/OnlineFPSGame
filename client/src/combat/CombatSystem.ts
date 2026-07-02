import { WeaponId } from "@fps/shared";
import * as THREE from "three";
import { InputManager } from "../engine/InputManager";
import { MuzzleFlashEffect, ScreenShake, TracerPool } from "../render/effects";
import { Target } from "./Target";
import { WeaponController } from "./WeaponController";

const SWITCH_KEYS: Record<string, WeaponId> = {
  Digit1: "rifle",
  Digit2: "smg",
  Digit3: "shotgun",
};

export interface CombatEvents {
  onHit(killed: boolean): void;
}

/**
 * Orchestrates client-side weapon firing: input -> raycast -> damage +
 * effects. Entirely local for this milestone (no server round-trip yet) —
 * the multiplayer milestone will keep this exact prediction path but add
 * server-authoritative validation on top rather than replacing it.
 */
export class CombatSystem {
  readonly weapon = new WeaponController();
  readonly targets: Target[] = [];

  private raycaster = new THREE.Raycaster();
  private raycastables: THREE.Object3D[] = [];
  private muzzleFlash: MuzzleFlashEffect;
  private tracers: TracerPool;
  private shake = new ScreenShake();

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private input: InputManager,
    private events: CombatEvents
  ) {
    this.muzzleFlash = new MuzzleFlashEffect(camera);
    this.tracers = new TracerPool(scene);
  }

  setRaycastables(objects: THREE.Object3D[]): void {
    this.raycastables = objects;
  }

  addTarget(target: Target): void {
    this.targets.push(target);
    this.raycastables.push(target.mesh);
  }

  /** dt in seconds (matches the render loop), used for shake decay. */
  update(dt: number): void {
    const dtMs = dt * 1000;
    this.weapon.update(dtMs);
    for (const t of this.targets) t.update(dtMs);
    this.tracers.update(dtMs);
    this.muzzleFlash.update(dtMs);
    this.shake.update(dt);

    for (const [code, id] of Object.entries(SWITCH_KEYS)) {
      if (this.input.consumeJustPressed(code)) this.weapon.switchTo(id);
    }
    if (this.input.consumeJustPressed("KeyR")) this.weapon.startReload();

    // Always drain the click edge, even for auto weapons that fire off
    // .firing instead — otherwise an edge from a click while an auto weapon
    // was active sits unconsumed and fires a free phantom shot the instant
    // you switch to a semi-auto weapon later, even with the mouse already up.
    const clickEdge = this.input.consumeJustPressed("Mouse0");
    const def = this.weapon.current;
    const wantsFire = def.fireMode === "auto" ? this.input.firing : clickEdge;
    if (wantsFire) this.tryFire();
  }

  /** Shake offsets to add on top of look-derived camera rotation each frame. */
  getShakeOffset(): { yaw: number; pitch: number; roll: number } {
    return { yaw: this.shake.offsetYaw, pitch: this.shake.offsetPitch, roll: this.shake.offsetRoll };
  }

  private tryFire(): void {
    const result = this.weapon.tryFire();
    if (!result.fired) return;

    this.muzzleFlash.trigger();
    this.shake.addTrauma(0.18);

    const def = this.weapon.current;
    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);

    let anyHit = false;
    let anyKill = false;

    for (let i = 0; i < result.pelletDirOffsets; i++) {
      const dir = randomSpreadDirection(forward, right, up, def.spreadRadians);
      this.raycaster.set(origin, dir);
      this.raycaster.far = def.range;
      const hits = this.raycaster.intersectObjects(this.raycastables, false);

      const endPoint = hits.length > 0 ? hits[0].point : origin.clone().addScaledVector(dir, def.range);
      this.tracers.spawn(origin, endPoint);

      if (hits.length === 0) continue;
      const targetRef = hits[0].object.userData.targetRef as Target | undefined;
      if (!targetRef) continue;

      anyHit = true;
      const killed = targetRef.applyDamage(def.damage);
      if (killed) anyKill = true;
    }

    if (anyHit) this.events.onHit(anyKill);
  }
}

/** Uniform random direction within a small cone around `forward`, built from
 * the camera's own right/up basis vectors (small-angle approximation —
 * accurate enough for the spread angles our weapons use, a few degrees at
 * most). */
function randomSpreadDirection(
  forward: THREE.Vector3,
  right: THREE.Vector3,
  up: THREE.Vector3,
  maxAngle: number
): THREE.Vector3 {
  if (maxAngle <= 0) return forward.clone();
  const r = Math.sqrt(Math.random()) * maxAngle;
  const theta = Math.random() * Math.PI * 2;
  return forward
    .clone()
    .addScaledVector(right, Math.cos(theta) * r)
    .addScaledVector(up, Math.sin(theta) * r)
    .normalize();
}
