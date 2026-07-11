import {
  BoxCollider,
  ClientInputMessage,
  createPlayerCombatState,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_EXTENTS,
  PlayerCombatState,
  PlayerPhysicsState,
  PlayerSnapshot,
  SIM_DT,
  SpawnPoint,
  stepPlayerMovement,
  WeaponDef,
  WeaponId,
  WeaponState,
} from "@fps/shared";
import * as THREE from "three";
import { soundEngine } from "../audio/SoundEngine";
import { randomSpreadDirection } from "../combat/spread";
import { InputManager } from "../engine/InputManager";
import { NetClient } from "../net/NetClient";

const MAX_PITCH = Math.PI / 2 - 0.01;
const MAX_ACCUMULATED_DT = 0.25;
const SWITCH_KEYS: Record<string, WeaponId> = {
  Digit1: "rifle",
  Digit2: "smg",
  Digit3: "shotgun",
};

export interface LocalFireEvent {
  origin: THREE.Vector3;
  directions: THREE.Vector3[];
  weapon: WeaponDef;
}

/**
 * The networked counterpart to PlayerController: same fixed-tick movement
 * (identical shared code, so prediction and the server's authoritative sim
 * never disagree about the RULES, only ever briefly about state under
 * latency), plus weapon-fire ticks folded into the same loop, an input
 * buffer for reconciliation replay, and a per-tick send to the server.
 *
 * Movement is predicted-and-replayed on every server correction. Health/
 * ammo/kills are simpler: just re-synced from each snapshot directly,
 * no replay — the player never "steers" those with continuous input the
 * way they do position, so a same-snapshot-interval correction (50ms) is
 * imperceptible and not worth replaying side effects like re-spawning
 * tracers for.
 */
export class PredictionController {
  physics: PlayerPhysicsState;
  yaw: number;
  pitch = 0;
  weapon = new WeaponState();
  combat: PlayerCombatState = createPlayerCombatState();

  private seq = 0;
  private accumulator = 0;
  private pendingInputs: ClientInputMessage[] = [];
  private rttMs = 0;
  private wasReloading = false;
  private lowAmmoWarned = false;
  private lastAmmoForWarning = -1;
  private lastWeaponIdForWarning: WeaponId | null = null;

  constructor(
    spawn: SpawnPoint,
    private colliders: readonly BoxCollider[],
    private input: InputManager,
    private net: NetClient,
    private camera: THREE.PerspectiveCamera,
    private ladders: readonly BoxCollider[] = []
  ) {
    this.physics = { position: { ...spawn.position }, velocity: { x: 0, y: 0, z: 0 }, onGround: false };
    this.yaw = spawn.yaw;
  }

  setRttEstimate(ms: number): void {
    this.rttMs = ms;
  }

  get rttEstimate(): number {
    return this.rttMs;
  }

  /** Steps prediction forward by frameDt (seconds), sending one network
   * input per fixed tick processed. Returns shots fired this frame so the
   * caller can spawn local tracer/muzzle-flash effects immediately —
   * actual damage always comes back from the server, never applied here. */
  update(frameDt: number): LocalFireEvent[] {
    const look = this.input.consumeLookDelta();
    this.yaw -= look.yaw;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - look.pitch));
    // Sync the camera transform to the freshly-updated look BEFORE stepping
    // ticks — fire-ray computation inside the loop reads this.camera's
    // matrixWorld, so it needs this frame's rotation, not last frame's.
    this.syncCamera();

    this.accumulator += Math.min(frameDt, MAX_ACCUMULATED_DT);
    const fireEvents: LocalFireEvent[] = [];
    while (this.accumulator >= SIM_DT) {
      const ev = this.stepOneTick();
      if (ev) fireEvents.push(ev);
      this.accumulator -= SIM_DT;
    }
    // Final sync so the position reflects this frame's movement for rendering.
    this.syncCamera();
    return fireEvents;
  }

  private syncCamera(): void {
    const eye = this.getEyePosition();
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.updateMatrixWorld(true);
  }

  private stepOneTick(): LocalFireEvent | null {
    this.weapon.update(SIM_DT * 1000);

    let switchTo: WeaponId | undefined;
    for (const [code, id] of Object.entries(SWITCH_KEYS)) {
      if (this.input.consumeJustPressed(code)) switchTo = id;
    }
    if (switchTo) this.weapon.switchTo(switchTo);

    const reload = this.input.consumeJustPressed("KeyR");
    if (reload) this.weapon.startReload();

    if (this.weapon.isReloading !== this.wasReloading) {
      if (this.weapon.isReloading) soundEngine.playReloadStart();
      else soundEngine.playReloadFinish();
      this.wasReloading = this.weapon.isReloading;
    }

    // Fires once as the magazine crosses its low threshold, not on every
    // tick spent below it — resets on reload/refill (ammo went back up) or
    // weapon switch (each gun's low-ammo state is independent — switching
    // TO an already-low second weapon must still warn even if the FIRST
    // weapon already triggered its own warning this life) so it can warn
    // again next time that gun runs low.
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

    // Drain the click edge unconditionally regardless of fire mode — see
    // CombatSystem for why (a stale edge from an auto weapon otherwise
    // fires a phantom shot the instant you switch to a semi-auto weapon).
    const clickEdge = this.input.consumeJustPressed("Mouse0");
    const wantsFire = this.weapon.current.fireMode === "auto" ? this.input.firing : clickEdge;

    let fireEvent: LocalFireEvent | null = null;
    let fireDirections: { x: number; y: number; z: number }[] | undefined;

    if (this.combat.alive && wantsFire) {
      const result = this.weapon.tryFire();
      if (result.fired) {
        soundEngine.playShot(this.weapon.current.id);
        const { origin, directions } = this.computeFireRay(result.pelletCount);
        fireDirections = directions.map((d) => ({ x: d.x, y: d.y, z: d.z }));
        fireEvent = { origin, directions, weapon: this.weapon.current };
      }
    }

    const axes = this.input.getMoveAxes();
    const seq = this.seq++;
    if (this.combat.alive) {
      this.physics = stepPlayerMovement(
        this.physics,
        { forward: axes.forward, right: axes.right, jump: axes.jump, yaw: this.yaw, seq, dt: SIM_DT },
        this.colliders,
        this.ladders
      );
    }

    const inputMsg: ClientInputMessage = {
      type: "input",
      seq,
      forward: axes.forward,
      right: axes.right,
      jump: axes.jump,
      yaw: this.yaw,
      pitch: this.pitch,
      dt: SIM_DT,
      fire: Boolean(fireDirections),
      reload,
      switchTo,
      fireDirections,
      rttMs: this.rttMs,
    };
    this.pendingInputs.push(inputMsg);
    this.net.send(inputMsg);

    return fireEvent;
  }

  private computeFireRay(pelletCount: number): { origin: THREE.Vector3; directions: THREE.Vector3[] } {
    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);

    const maxAngle = this.weapon.current.spreadRadians;
    const directions: THREE.Vector3[] = [];
    for (let i = 0; i < pelletCount; i++) {
      directions.push(randomSpreadDirection(forward, right, up, maxAngle));
    }
    return { origin, directions };
  }

  /** Reconciliation: drop confirmed inputs, snap to the server's
   * authoritative base state, and replay whatever inputs the server hasn't
   * processed yet on top of it. */
  applyServerSnapshot(entry: PlayerSnapshot): void {
    this.pendingInputs = this.pendingInputs.filter((i) => i.seq > entry.lastProcessedSeq);

    this.combat.health = entry.health;
    this.combat.alive = entry.alive;
    this.combat.spawnProtectedUntil = entry.spawnProtectedUntil;
    this.combat.kills = entry.kills;
    this.combat.deaths = entry.deaths;
    this.weapon.syncFromServer(entry.weapon, entry.ammo, entry.reloading);

    this.physics = { position: entry.position, velocity: entry.velocity, onGround: entry.onGround };
    if (this.combat.alive) {
      for (const replayInput of this.pendingInputs) {
        this.physics = stepPlayerMovement(
          this.physics,
          {
            forward: replayInput.forward,
            right: replayInput.right,
            jump: replayInput.jump,
            yaw: replayInput.yaw,
            seq: replayInput.seq,
            dt: replayInput.dt,
          },
          this.colliders,
          this.ladders
        );
      }
    }
  }

  getEyePosition(): { x: number; y: number; z: number } {
    const eyeOffset = PLAYER_EYE_HEIGHT - PLAYER_HALF_EXTENTS.y;
    return {
      x: this.physics.position.x,
      y: this.physics.position.y + eyeOffset,
      z: this.physics.position.z,
    };
  }
}
