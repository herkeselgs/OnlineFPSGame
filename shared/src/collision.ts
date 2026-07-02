import { Vec3 } from "./vec.js";

/** Axis-aligned static collider box, defined by center + half-extents.
 * Map geometry is authored as a list of these; both server physics and
 * client rendering/collision consume the exact same list. */
export interface BoxCollider {
  center: Vec3;
  half: Vec3;
}

// NOTE: deliberately no skin/epsilon margin here. Adding one seems tempting
// to stabilize exact-boundary resting contact (see stepPlayerMovement's
// ground-stick comment for how that's actually solved) but a uniform
// epsilon makes flush-resting-on-a-collider register as a true overlap on
// ALL three axes at once — which makes wide flat colliders like the floor
// get treated as a horizontal wall the moment you stand on them. Keep this
// strict.
export const aabbOverlaps = (
  posA: Vec3,
  halfA: Vec3,
  posB: Vec3,
  halfB: Vec3
): boolean =>
  Math.abs(posA.x - posB.x) < halfA.x + halfB.x &&
  Math.abs(posA.y - posB.y) < halfA.y + halfB.y &&
  Math.abs(posA.z - posB.z) < halfA.z + halfB.z;

export interface AxisMoveResult {
  position: number;
  velocity: number;
  collided: boolean;
}

const AXES = ["x", "y", "z"] as const;

// Require genuine (non-hairline) overlap on the two axes NOT being resolved
// this call, not just a boundary touch. Without this, resting flush against
// a wall (touching on one axis) combined with floating-point noise can
// register as overlapping on a completely different axis too — which lets a
// wall you're merely touching get treated as a floor to snap on top of,
// teleporting the player up by the wall's full height. Real "standing on a
// platform" overlaps are centimeters deep at least, so this margin never
// affects legitimate landings.
const CONTACT_MARGIN = 0.02;

/**
 * Discrete per-axis move + resolve against a set of static box colliders.
 * Moves `center` along `axis` by `delta`, and if the resulting box overlaps
 * any collider, pushes it back out to the boundary and zeroes velocity on
 * that axis. Classic blocky-world collision (Minecraft-style): simple,
 * deterministic, and cheap enough to share verbatim between client
 * prediction and the authoritative server.
 */
export function moveAndResolveAxis(
  center: Vec3,
  half: Vec3,
  velocity: number,
  axis: "x" | "y" | "z",
  delta: number,
  colliders: readonly BoxCollider[]
): AxisMoveResult {
  const next = { ...center, [axis]: center[axis] + delta };
  const otherAxes = AXES.filter((a) => a !== axis);

  let collided = false;
  for (const c of colliders) {
    const hasMargin = otherAxes.every(
      (a) => Math.abs(next[a] - c.center[a]) < half[a] + c.half[a] - CONTACT_MARGIN
    );
    if (!hasMargin) continue;
    if (Math.abs(next[axis] - c.center[axis]) >= half[axis] + c.half[axis]) continue;

    const halfSum = half[axis] + c.half[axis];
    if (delta > 0) {
      next[axis] = c.center[axis] - halfSum;
    } else if (delta < 0) {
      next[axis] = c.center[axis] + halfSum;
    } else {
      // Already overlapping with zero delta (shouldn't normally happen);
      // push out along the smallest resolution direction.
      next[axis] =
        center[axis] < c.center[axis] ? c.center[axis] - halfSum : c.center[axis] + halfSum;
    }
    collided = true;
    velocity = 0;
  }

  return { position: next[axis], velocity, collided };
}
