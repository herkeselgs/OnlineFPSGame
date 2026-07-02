import { BoxCollider, moveAndResolveAxis } from "./collision.js";
import {
  AIR_ACCEL,
  AIR_CONTROL_MAX_SPEED,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  JUMP_SPEED,
  MAX_FALL_SPEED,
  MOVE_SPEED,
  PLAYER_HALF_EXTENTS,
  STEP_HEIGHT,
} from "./constants.js";
import { Vec3 } from "./vec.js";

/** Per-tick player physics state. Position is the box CENTER (not feet/eye). */
export interface PlayerPhysicsState {
  position: Vec3;
  velocity: Vec3;
  onGround: boolean;
}

/** One tick of player input. Movement axes are in the -1..1 range, already
 * relative to the player (forward/right), and yaw is the absolute look yaw
 * in radians used to project movement into world space. */
export interface PlayerInputTick {
  forward: number;
  right: number;
  jump: boolean;
  yaw: number;
  seq: number;
  dt: number;
}

function applyFriction(speed: number, friction: number, dt: number): number {
  if (speed <= 0) return speed;
  const drop = speed * friction * dt;
  return Math.max(speed - drop, 0);
}

/**
 * If a horizontal move was blocked, retry it from STEP_HEIGHT higher up —
 * if THAT clears (no collision at the raised height, on this axis or the
 * other two), the obstacle is a short step (stair, curb, small ledge) and
 * we can climb it. Only ever called for grounded players. Returns null if
 * the obstacle is too tall to step over (or a ceiling blocks the raise
 * itself, which the same overlap check catches automatically since it
 * requires genuine clearance on every axis, not just the one being moved).
 */
function tryStepUp(
  position: Vec3,
  half: Vec3,
  axis: "x" | "z",
  delta: number,
  colliders: readonly BoxCollider[]
): number | null {
  const raised: Vec3 = { ...position, y: position.y + STEP_HEIGHT };
  const result = moveAndResolveAxis(raised, half, 0, axis, delta, colliders);
  return result.collided ? null : result.position;
}

/**
 * After a step-up raises the player, immediately probe downward by the same
 * amount to snap onto the actual step surface rather than leaving them
 * floating STEP_HEIGHT above it until gravity slowly catches up over many
 * ticks (which, combined with "ground stick" gravity, would never actually
 * happen — they'd float there indefinitely).
 */
function settleOntoStep(position: Vec3, half: Vec3, colliders: readonly BoxCollider[]): number {
  const settle = moveAndResolveAxis(position, half, 0, "y", -STEP_HEIGHT, colliders);
  return settle.position;
}

/**
 * Advance a player's physics state by one fixed tick given input and the
 * static map colliders. This function is imported verbatim by both the
 * client (for prediction + replay during reconciliation) and the server
 * (authoritative simulation) — identical inputs always produce identical
 * outputs, which is the whole point.
 */
export function stepPlayerMovement(
  state: PlayerPhysicsState,
  input: PlayerInputTick,
  colliders: readonly BoxCollider[]
): PlayerPhysicsState {
  const dt = input.dt;
  let { velocity, onGround } = state;
  const position: Vec3 = { ...state.position };
  velocity = { ...velocity };

  // Build world-space wish direction from input axes + yaw.
  const sinY = Math.sin(input.yaw);
  const cosY = Math.cos(input.yaw);
  // Forward is -Z at yaw 0 (matches Three.js camera convention).
  const wishX = input.right * cosY - input.forward * sinY;
  const wishZ = -input.forward * cosY - input.right * sinY;
  const wishLenSq = wishX * wishX + wishZ * wishZ;
  const wishDirX = wishLenSq > 1e-8 ? wishX / Math.sqrt(wishLenSq) : 0;
  const wishDirZ = wishLenSq > 1e-8 ? wishZ / Math.sqrt(wishLenSq) : 0;
  const wishSpeed = wishLenSq > 1e-8 ? MOVE_SPEED : 0;

  // Horizontal accel (ground: quake-ish accelerate-toward-wish; air: capped control)
  const curSpeed = velocity.x * wishDirX + velocity.z * wishDirZ;
  const accel = onGround ? GROUND_ACCEL : AIR_ACCEL;
  const maxSpeed = onGround ? MOVE_SPEED : AIR_CONTROL_MAX_SPEED;
  const addSpeed = Math.min(wishSpeed, maxSpeed) - curSpeed;
  if (addSpeed > 0) {
    const accelAmount = Math.min(accel * dt * wishSpeed, addSpeed);
    velocity.x += wishDirX * accelAmount;
    velocity.z += wishDirZ * accelAmount;
  }

  // Safety clamp: curSpeed above only measures the velocity component along
  // wishDir, so when a collision repeatedly zeroes one axis (e.g. sliding
  // along a wall) this accel step "compensates" for the lost component every
  // tick, which can pump the OTHER axis's speed past maxSpeed over many
  // ticks. Hard-clamp total horizontal speed as a backstop so that feedback
  // loop can never run away.
  const horizSpeedNow = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
  if (horizSpeedNow > maxSpeed) {
    const clampScale = maxSpeed / horizSpeedNow;
    velocity.x *= clampScale;
    velocity.z *= clampScale;
  }

  if (onGround && wishSpeed === 0) {
    const horizSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    const newSpeed = applyFriction(horizSpeed, GROUND_FRICTION, dt);
    const scale = horizSpeed > 1e-8 ? newSpeed / horizSpeed : 0;
    velocity.x *= scale;
    velocity.z *= scale;
  }

  // Gravity / jump
  if (onGround && input.jump) {
    velocity.y = JUMP_SPEED;
    onGround = false;
  } else if (!onGround) {
    velocity.y = Math.max(velocity.y + GRAVITY * dt, MAX_FALL_SPEED);
  } else {
    // "Ground stick": a tiny constant downward velocity instead of exactly
    // zero. A player resting exactly on a boundary with zero vertical
    // velocity produces zero vertical delta, which never re-triggers the
    // (strict, no-epsilon) overlap check below — so onGround would flicker
    // off every other tick as it drifts to precisely touching. A small
    // steady downward nudge guarantees a real (non-hairline) overlap every
    // grounded tick, which collision resolution snaps back to the exact
    // resting height. Standard technique in most character controllers.
    velocity.y = -0.5;
  }

  // Move + resolve per axis (X, Z horizontal; Y vertical) against static colliders.
  const half = PLAYER_HALF_EXTENTS;
  let stepped = false;

  const rx = moveAndResolveAxis(position, half, velocity.x, "x", velocity.x * dt, colliders);
  if (rx.collided && onGround) {
    const steppedX = tryStepUp(position, half, "x", velocity.x * dt, colliders);
    if (steppedX !== null) {
      position.x = steppedX;
      stepped = true;
    } else {
      position.x = rx.position;
      velocity.x = rx.velocity;
    }
  } else {
    position.x = rx.position;
    velocity.x = rx.velocity;
  }

  const rz = moveAndResolveAxis(position, half, velocity.z, "z", velocity.z * dt, colliders);
  if (rz.collided && onGround) {
    const steppedZ = tryStepUp(position, half, "z", velocity.z * dt, colliders);
    if (steppedZ !== null) {
      position.z = steppedZ;
      stepped = true;
    } else {
      position.z = rz.position;
      velocity.z = rz.velocity;
    }
  } else {
    position.z = rz.position;
    velocity.z = rz.velocity;
  }

  if (stepped) {
    position.y += STEP_HEIGHT;
    position.y = settleOntoStep(position, half, colliders);
  }

  const ry = moveAndResolveAxis(position, half, velocity.y, "y", velocity.y * dt, colliders);
  position.y = ry.position;
  // Falling and hit something below => grounded. Moving up and hit ceiling => stop.
  if (ry.collided) {
    onGround = velocity.y <= 0 ? true : onGround;
    velocity.y = 0;
  } else {
    onGround = false;
  }

  return { position, velocity, onGround };
}
