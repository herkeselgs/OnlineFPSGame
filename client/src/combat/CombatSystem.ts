import { damageMultiplierFor, HitZone, WeaponId, WeaponState } from "@fps/shared";
import * as THREE from "three";
import { soundEngine } from "../audio/SoundEngine";
import { InputManager } from "../engine/InputManager";
import { MuzzleFlashEffect, ScreenShake, TracerPool } from "../render/effects";
import { Viewmodel } from "../render/viewmodel";
import { randomSpreadDirection } from "./spread";
import { Target } from "./Target";
import { feelFor } from "./weaponFeel";

const SWITCH_KEYS: Record<string, WeaponId> = {
  Digit1: "rifle",
  Digit2: "smg",
  Digit3: "shotgun",
};

export interface CombatEvents {
  onHit(killed: boolean, headshot: boolean, limbShot: boolean): void;
}

/**
 * Orchestrates client-side weapon firing: input -> raycast -> damage +
 * effects. Entirely local for this milestone (no server round-trip yet) —
 * the multiplayer milestone will keep this exact prediction path but add
 * server-authoritative validation on top rather than replacing it.
 */
export class CombatSystem {
  readonly weapon = new WeaponState();
  readonly targets: Target[] = [];

  private raycaster = new THREE.Raycaster();
  private raycastables: THREE.Object3D[] = [];
  private muzzleFlash: MuzzleFlashEffect;
  private viewmodel: Viewmodel;
  private tracers: TracerPool;
  private shake = new ScreenShake();
  private wasReloading = false;
  private lowAmmoWarned = false;
  private lastAmmoForWarning = -1;
  private lastWeaponIdForWarning: WeaponId | null = null;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private input: InputManager,
    private events: CombatEvents
  ) {
    this.muzzleFlash = new MuzzleFlashEffect(camera);
    this.viewmodel = new Viewmodel(camera);
    this.tracers = new TracerPool(scene);
  }

  /** Unlike MuzzleFlashEffect (a cheap, invisible-by-default sprite this
   * class has always just left attached to the long-lived camera across
   * practice restarts), the viewmodel is a visible gun mesh — leaving old
   * ones behind would visibly stack up, so it gets its own cleanup. */
  dispose(): void {
    this.viewmodel.dispose(this.camera);
  }

  setRaycastables(objects: THREE.Object3D[]): void {
    this.raycastables = objects;
  }

  addTarget(target: Target): void {
    this.targets.push(target);
    this.raycastables.push(...target.raycastMeshes);
  }

  /** dt in seconds (matches the render loop), used for shake decay. */
  update(dt: number): void {
    const dtMs = dt * 1000;
    this.weapon.update(dtMs);
    for (const t of this.targets) t.update(dtMs);
    this.tracers.update(dtMs);
    this.muzzleFlash.update(dtMs);
    this.viewmodel.setWeapon(this.weapon.currentId);
    this.viewmodel.update(dtMs, this.weapon.isReloading, this.weapon.reloadProgress);
    this.shake.update(dt);

    for (const [code, id] of Object.entries(SWITCH_KEYS)) {
      if (this.input.consumeJustPressed(code)) this.weapon.switchTo(id);
    }
    if (this.input.consumeJustPressed("KeyR")) this.weapon.startReload();

    // Catches both a manual R press AND the auto-reload WeaponState triggers
    // when a magazine empties, rather than only playing the start sound for
    // the explicit-keypress path.
    if (this.weapon.isReloading !== this.wasReloading) {
      if (this.weapon.isReloading) soundEngine.playReloadStart();
      else soundEngine.playReloadFinish();
      this.wasReloading = this.weapon.isReloading;
    }

    // Fires once as the magazine crosses its low threshold — see the
    // identical logic in PredictionController for the multiplayer path
    // (this class is practice mode's, kept as its own copy same as the
    // reload-sound trigger above, not a new duplication pattern).
    const ammo = this.weapon.currentAmmo;
    const weaponId = this.weapon.currentId;
    if (weaponId !== this.lastWeaponIdForWarning || ammo > this.lastAmmoForWarning) this.lowAmmoWarned = false;
    const lowThreshold = Math.max(2, Math.ceil(this.weapon.current.magazineSize * 0.15));
    if (!this.lowAmmoWarned && ammo > 0 && ammo <= lowThreshold) {
      this.lowAmmoWarned = true;
      soundEngine.playLowAmmo();
    }
    this.lastAmmoForWarning = ammo;
    this.lastWeaponIdForWarning = weaponId;

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
    this.viewmodel.triggerRecoil();
    const def = this.weapon.current;
    const feel = feelFor(def.id);
    this.shake.addTrauma(feel.trauma);
    this.shake.addKick(feel.kick);
    soundEngine.playShot(def.id);

    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);

    let anyHit = false;
    let anyKill = false;
    let anyHeadshot = false;
    let anyLimbShot = false;

    for (let i = 0; i < result.pelletCount; i++) {
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
      // Practice mode has real geometry to raycast against (unlike the
      // server, which has no visual scene and uses the box-based
      // classification directly) — but each hitbox mesh carries the same
      // "head" | "torso" | "limb" tag the server's boxes would classify it
      // as, via userData.hitZone (see Target's constructor), so the two
      // stay in agreement despite using different mechanisms to get there.
      const zone = (hits[0].object.userData.hitZone as HitZone | undefined) ?? "torso";
      const damage = def.damage * damageMultiplierFor(zone);
      const killed = targetRef.applyDamage(damage);
      if (killed) anyKill = true;
      if (zone === "head") anyHeadshot = true;
      if (zone === "limb") anyLimbShot = true;
    }

    if (anyHit) {
      soundEngine.playHitmarker(anyKill, anyHeadshot);
      this.events.onHit(anyKill, anyHeadshot, anyLimbShot);
    }
  }
}
