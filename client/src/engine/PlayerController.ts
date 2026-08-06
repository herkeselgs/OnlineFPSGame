import { BoxCollider, eyeHeightOffset, PlayerPhysicsState, SIM_DT, SpawnPoint, stepPlayerMovement } from "@fps/shared";
import { InputManager } from "./InputManager";

const MAX_PITCH = Math.PI / 2 - 0.01;
const MAX_ACCUMULATED_DT = 0.25; // avoid spiral-of-death after a tab freeze

/**
 * Drives the local player's physics using the shared fixed-timestep
 * movement function. This is the exact same stepping loop that will later
 * run predictively against server reconciliation — for now (single-player
 * milestone) its output is just authoritative and final.
 */
export class PlayerController {
  state: PlayerPhysicsState;
  yaw: number;
  pitch = 0;

  private accumulator = 0;
  private seq = 0;

  constructor(
    spawn: SpawnPoint,
    private colliders: readonly BoxCollider[],
    private input: InputManager,
    private ladders: readonly BoxCollider[] = []
  ) {
    this.state = {
      position: { ...spawn.position },
      velocity: { x: 0, y: 0, z: 0 },
      onGround: false,
      crouching: false,
    };
    this.yaw = spawn.yaw;
  }

  /** Call once per animation frame. Consumes look deltas immediately (for
   * responsive camera) and steps physics in fixed SIM_DT chunks. */
  update(frameDt: number): void {
    const look = this.input.consumeLookDelta();
    this.yaw -= look.yaw;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch - look.pitch));

    this.accumulator += Math.min(frameDt, MAX_ACCUMULATED_DT);
    const axes = this.input.getMoveAxes();

    while (this.accumulator >= SIM_DT) {
      this.state = stepPlayerMovement(
        this.state,
        {
          forward: axes.forward,
          right: axes.right,
          jump: axes.jump,
          sprint: axes.sprint,
          crouch: axes.crouch,
          yaw: this.yaw,
          seq: this.seq++,
          dt: SIM_DT,
        },
        this.colliders,
        this.ladders
      );
      this.accumulator -= SIM_DT;
    }
  }

  getEyePosition(): { x: number; y: number; z: number } {
    return {
      x: this.state.position.x,
      y: this.state.position.y + eyeHeightOffset(this.state.crouching),
      z: this.state.position.z,
    };
  }
}
