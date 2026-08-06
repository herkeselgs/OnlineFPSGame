import { aabbOverlaps, BoxCollider, moveAndResolveAxis } from "./collision.js";
import {
  AIR_ACCEL,
  AIR_CONTROL_MAX_SPEED,
  CLIMB_SPEED,
  CROUCH_EYE_HEIGHT,
  CROUCH_HALF_EXTENTS,
  CROUCH_SPEED_MULTIPLIER,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  JUMP_SPEED,
  MAX_FALL_SPEED,
  MOVE_SPEED,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_EXTENTS,
  SLIDE_FRICTION,
  SLIDE_MIN_SPEED,
  SPRINT_SPEED_MULTIPLIER,
  STEP_HEIGHT,
} from "./constants.js";
import { Vec3 } from "./vec.js";

/** Per-tick player physics state. Position is the box CENTER (not feet/eye).
 * `crouching` is part of the deterministic simulation state (not derived
 * from input alone) because standing back up can be blocked by low
 * ceilings — see stepPlayerMovement — so it has to round-trip through
 * reconciliation/snapshots exactly like onGround does. */
export interface PlayerPhysicsState {
  position: Vec3;
  velocity: Vec3;
  onGround: boolean;
  crouching: boolean;
}

/** One tick of player input. Movement axes are in the -1..1 range, already
 * relative to the player (forward/right), and yaw is the absolute look yaw
 * in radians used to project movement into world space. sprint/crouch
 * default to false when omitted (e.g. bot AI, which never presses either)
 * rather than being required on every caller. */
export interface PlayerInputTick {
  forward: number;
  right: number;
  jump: boolean;
  yaw: number;
  seq: number;
  dt: number;
  sprint?: boolean;
  crouch?: boolean;
}

/** Eye height above the box CENTER for the given stance — feet-relative
 * PLAYER_EYE_HEIGHT/CROUCH_EYE_HEIGHT minus that stance's half-height,
 * since position is the box center, not the feet. Shared by every place
 * that turns a physics position into a camera/fire-ray origin (client
 * camera sync, server hit-ray origin) so they can never disagree. */
export function eyeHeightOffset(crouching: boolean): number {
  return crouching ? CROUCH_EYE_HEIGHT - CROUCH_HALF_EXTENTS.y : PLAYER_EYE_HEIGHT - PLAYER_HALF_EXTENTS.y;
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
  colliders: readonly BoxCollider[],
  ladders: readonly BoxCollider[] = []
): PlayerPhysicsState {
  const dt = input.dt;
  let { velocity, onGround } = state;
  const position: Vec3 = { ...state.position };
  velocity = { ...velocity };

  // Resolve this tick's crouch stance before anything else touches
  // position/collision — everything below (ladder overlap, movement
  // resolution) needs to already be using the right box for this tick.
  // Entering crouch is always safe (the crouched box is a strict subset of
  // the standing one at the same feet height, see constants.ts), so it's
  // unconditional; leaving crouch has to re-check headroom first, since a
  // low ceiling can legitimately keep a player pinned crouched until they
  // move somewhere clearer.
  let crouching = state.crouching;
  if (input.crouch && !crouching) {
    crouching = true;
    position.y -= PLAYER_HALF_EXTENTS.y - CROUCH_HALF_EXTENTS.y;
  } else if (!input.crouch && crouching) {
    const raisedY = position.y + (PLAYER_HALF_EXTENTS.y - CROUCH_HALF_EXTENTS.y);
    const blocked = colliders.some((c) =>
      aabbOverlaps({ ...position, y: raisedY }, PLAYER_HALF_EXTENTS, c.center, c.half)
    );
    if (!blocked) {
      crouching = false;
      position.y = raisedY;
    }
  }
  const half = crouching ? CROUCH_HALF_EXTENTS : PLAYER_HALF_EXTENTS;

  // Attached the instant the player's box overlaps a ladder volume — no
  // separate "grab" input, matching how most FPS ladders work. Holding jump
  // while attached lets go instead of (re)attaching, so jump doubles as
  // "drop off the ladder" at any height, not just at the top.
  const climbing = !input.jump && ladders.some((l) => aabbOverlaps(position, half, l.center, l.half));
  // Used only to pick horizontal accel/friction character below — full
  // Quake-ish ground control while climbing (not the looser air-control
  // model), since a ladder is something you actively grip, not something
  // you're falling past.
  const grounded = onGround || climbing;

  // Build world-space wish direction from input axes + yaw. While climbing,
  // forward/back is entirely repurposed as vertical climb speed below (not
  // horizontal — a ladder is normally only wide enough to strafe off of,
  // not walk forward on), so only `right` contributes to horizontal wish;
  // otherwise a player holding forward into the wall a ladder is mounted on
  // gets pushed sideways clean off the ladder the instant they climb high
  // enough to clear the wall's top and that push stops being blocked.
  const climbForward = climbing ? 0 : input.forward;
  const sinY = Math.sin(input.yaw);
  const cosY = Math.cos(input.yaw);
  // Forward is -Z at yaw 0 (matches Three.js camera convention).
  const wishX = input.right * cosY - climbForward * sinY;
  const wishZ = -climbForward * cosY - input.right * sinY;
  const wishLenSq = wishX * wishX + wishZ * wishZ;
  const wishDirX = wishLenSq > 1e-8 ? wishX / Math.sqrt(wishLenSq) : 0;
  const wishDirZ = wishLenSq > 1e-8 ? wishZ / Math.sqrt(wishLenSq) : 0;

  // Grounded top speed for this tick's stance: crouched is slower, sprint
  // (forward-biased, and only while neither crouching nor airborne) is
  // faster, plain walk otherwise. Air control is unaffected by stance.
  let groundSpeed = MOVE_SPEED;
  if (crouching) groundSpeed = MOVE_SPEED * CROUCH_SPEED_MULTIPLIER;
  else if (input.sprint && input.forward > 0.1) groundSpeed = MOVE_SPEED * SPRINT_SPEED_MULTIPLIER;

  // Sliding is a pure function of velocity + stance each tick (crouching,
  // grounded, and still carrying sprint-or-faster speed from before the
  // crouch), not a separate stored mode/timer — so it re-derives correctly
  // during reconciliation replay for free, and naturally ends the instant
  // friction decays speed back down to crouch-walk pace.
  const horizSpeedIncoming = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
  const sliding = crouching && grounded && !climbing && horizSpeedIncoming > SLIDE_MIN_SPEED;

  if (sliding) {
    // Momentum-only: ignore wish-direction steering entirely and let
    // friction bleed speed down, rather than the normal accelerate-toward-
    // wish/hard-clamp rules, which would otherwise instantly cut a sprint's
    // speed down to crouch-walk pace the moment crouch is pressed.
    const decayedSpeed = applyFriction(horizSpeedIncoming, SLIDE_FRICTION, dt);
    const scale = horizSpeedIncoming > 1e-8 ? decayedSpeed / horizSpeedIncoming : 0;
    velocity.x *= scale;
    velocity.z *= scale;
  } else {
    // Horizontal accel (ground/climbing: quake-ish accelerate-toward-wish; air: capped control)
    const wishSpeed = wishLenSq > 1e-8 ? (grounded ? groundSpeed : MOVE_SPEED) : 0;
    const curSpeed = velocity.x * wishDirX + velocity.z * wishDirZ;
    const accel = grounded ? GROUND_ACCEL : AIR_ACCEL;
    const maxSpeed = grounded ? groundSpeed : AIR_CONTROL_MAX_SPEED;
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

    if (grounded && wishSpeed === 0) {
      const horizSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
      const newSpeed = applyFriction(horizSpeed, GROUND_FRICTION, dt);
      const scale = horizSpeed > 1e-8 ? newSpeed / horizSpeed : 0;
      velocity.x *= scale;
      velocity.z *= scale;
    }
  }

  if (climbing) {
    // Vertical velocity comes straight from forward/back input instead of
    // gravity — hold forward to climb up, back to climb down, release to
    // hang in place. Not "onGround" (there's no floor underfoot), but not
    // falling either.
    velocity.y = input.forward * CLIMB_SPEED;
    onGround = false;
  } else if (onGround && input.jump) {
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

  return { position, velocity, onGround, crouching };
}
