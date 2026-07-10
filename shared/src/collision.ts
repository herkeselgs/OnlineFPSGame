import { HEAD_BAND_MAX_Y, HEAD_BAND_MIN_Y, HEAD_HALF_WIDTH, PLAYER_HALF_EXTENTS, PLAYER_RADIUS } from "./constants.js";
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

/**
 * Ray-vs-AABB slab test. Returns the distance along `dir` (assumed
 * normalized) to the nearest intersection, or null if the ray misses or the
 * box is beyond `maxDist`. Used server-side for authoritative hitscan
 * validation against both static map geometry and (lag-compensated) player
 * hitboxes — the exact same box colliders used for movement collision, so
 * "what blocks a bullet" and "what blocks a player" never disagree.
 */
export function rayIntersectsBox(
  origin: Vec3,
  dir: Vec3,
  box: BoxCollider,
  maxDist = Infinity
): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;

  for (const axis of AXES) {
    const o = origin[axis];
    const d = dir[axis];
    const min = box.center[axis] - box.half[axis];
    const max = box.center[axis] + box.half[axis];

    if (Math.abs(d) < 1e-9) {
      if (o < min || o > max) return null;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  if (tmax < 0 || tmin > maxDist) return null;
  return tmin >= 0 ? tmin : tmax;
}

/** The torso hit box for a player centered at `bodyCenter`: same width as
 * the movement box, but only up to HEAD_BAND_MIN_Y — the head box (below)
 * picks up everything above that. Used only for hit detection, never
 * movement/collision (which keeps using one uniform PLAYER_HALF_EXTENTS
 * box, unchanged). */
export function torsoHitBox(bodyCenter: Vec3): BoxCollider {
  const yMin = -PLAYER_HALF_EXTENTS.y;
  const yMax = HEAD_BAND_MIN_Y;
  return {
    center: { x: bodyCenter.x, y: bodyCenter.y + (yMin + yMax) / 2, z: bodyCenter.z },
    half: { x: PLAYER_RADIUS, y: (yMax - yMin) / 2, z: PLAYER_RADIUS },
  };
}

/** The head hit box: narrower than the torso, stacked directly on top of it
 * with no gap and no overlap (see constants.ts for why the two must stay
 * disjoint in Y — an overlapping narrower box would never win a nearest-hit
 * test against the wider torso box surrounding it). */
export function headHitBox(bodyCenter: Vec3): BoxCollider {
  const yMin = HEAD_BAND_MIN_Y;
  const yMax = HEAD_BAND_MAX_Y;
  return {
    center: { x: bodyCenter.x, y: bodyCenter.y + (yMin + yMax) / 2, z: bodyCenter.z },
    half: { x: HEAD_HALF_WIDTH, y: (yMax - yMin) / 2, z: HEAD_HALF_WIDTH },
  };
}

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
