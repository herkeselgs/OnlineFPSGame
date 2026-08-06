import {
  BoxCollider,
  ClientInputMessage,
  eyeHeightOffset,
  ImpostorPlayerSnapshot,
  PlayerPhysicsState,
  SIM_DT,
  SpawnPoint,
  STAMINA_MAX,
  stepPlayerMovement,
} from "@fps/shared";
import * as THREE from "three";
import { InputManager } from "../engine/InputManager";
import { NetClient } from "../net/NetClient";

const MAX_PITCH = Math.PI / 2 - 0.01;
const MAX_ACCUMULATED_DT = 0.25;

/**
 * Movement-only counterpart to Duel's PredictionController — same fixed-tick
 * stepping/reconciliation approach (shared stepPlayerMovement means
 * prediction and the server's sim never disagree about the rules), but no
 * weapon/fire handling at all. Reusing PredictionController as-is would mean
 * every Imposter-mode player predicts local muzzle flash/tracer/gunshot
 * audio the instant they click, even crewmates who are never supposed to
 * have a weapon — wrong for this mode rather than just unused.
 */
export class ImpostorPredictionController {
  physics: PlayerPhysicsState;
  yaw: number;
  pitch = 0;

  private seq = 0;
  private accumulator = 0;
  private pendingInputs: ClientInputMessage[] = [];
  private rttMs = 0;

  constructor(
    spawn: SpawnPoint,
    private colliders: readonly BoxCollider[],
    private input: InputManager,
    private net: NetClient,
    private camera: THREE.PerspectiveCamera,
    private ladders: readonly BoxCollider[] = []
  ) {
    this.physics = {
      position: { ...spawn.position },
      velocity: { x: 0, y: 0, z: 0 },
      onGround: false,
      crouching: false,
      stamina: STAMINA_MAX,
      staminaRegenCooldownMs: 0,
    };
    this.yaw = spawn.yaw;
  }

  setRttEstimate(ms: number): void {
    this.rttMs = ms;
  }

  get rttEstimate(): number {
    return this.rttMs;
  }

  update(frameDt: number): void {
    const look = this.input.consumeLookDelta();
    this.yaw -= look.yaw;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - look.pitch));
    this.syncCamera();

    this.accumulator += Math.min(frameDt, MAX_ACCUMULATED_DT);
    while (this.accumulator >= SIM_DT) {
      this.stepOneTick();
      this.accumulator -= SIM_DT;
    }
    this.syncCamera();
  }

  private syncCamera(): void {
    const eye = this.getEyePosition();
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    this.camera.updateMatrixWorld(true);
  }

  private stepOneTick(): void {
    const axes = this.input.getMoveAxes();
    const seq = this.seq++;
    this.physics = stepPlayerMovement(
      this.physics,
      {
        forward: axes.forward,
        right: axes.right,
        jump: axes.jump,
        sprint: axes.sprint,
        crouch: axes.crouch,
        yaw: this.yaw,
        seq,
        dt: SIM_DT,
      },
      this.colliders,
      this.ladders
    );

    // Fire/reload/switchTo are hardcoded off — this mode has no weapon
    // input yet (M4 adds the imposter kill action, which will be a
    // dedicated message, not this one repurposed). Sent as "input" rather
    // than a new message type since movement is otherwise byte-for-byte
    // identical to Duel's, and the server already ignores these fields.
    const inputMsg: ClientInputMessage = {
      type: "input",
      seq,
      forward: axes.forward,
      right: axes.right,
      jump: axes.jump,
      sprint: axes.sprint,
      crouch: axes.crouch,
      yaw: this.yaw,
      pitch: this.pitch,
      dt: SIM_DT,
      fire: false,
      reload: false,
      rttMs: this.rttMs,
    };
    this.pendingInputs.push(inputMsg);
    this.net.send(inputMsg);
  }

  applyServerSnapshot(entry: ImpostorPlayerSnapshot): void {
    this.pendingInputs = this.pendingInputs.filter((i) => i.seq > entry.lastProcessedSeq);
    // ImpostorPlayerSnapshot never grew a stamina field (this mode is being
    // fully removed shortly — see the task list), so just reset to full
    // rather than threading it through this soon-to-be-deleted wire shape.
    this.physics = {
      position: entry.position,
      velocity: entry.velocity,
      onGround: entry.onGround,
      crouching: entry.crouching,
      stamina: STAMINA_MAX,
      staminaRegenCooldownMs: 0,
    };
    for (const replayInput of this.pendingInputs) {
      this.physics = stepPlayerMovement(
        this.physics,
        {
          forward: replayInput.forward,
          right: replayInput.right,
          jump: replayInput.jump,
          sprint: replayInput.sprint,
          crouch: replayInput.crouch,
          yaw: replayInput.yaw,
          seq: replayInput.seq,
          dt: replayInput.dt,
        },
        this.colliders,
        this.ladders
      );
    }
  }

  getEyePosition(): { x: number; y: number; z: number } {
    return {
      x: this.physics.position.x,
      y: this.physics.position.y + eyeHeightOffset(this.physics.crouching),
      z: this.physics.position.z,
    };
  }
}
