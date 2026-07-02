import * as THREE from "three";

/** Uniform random direction within a small cone around `forward`, built
 * from an orthonormal right/up basis (small-angle approximation — accurate
 * enough for the spread angles our weapons use, a few degrees at most).
 * Used identically for local prediction (practice mode, and match-mode
 * visual-only tracer prediction) — the server re-derives its own hit
 * results from whatever directions the client actually sends, so this
 * function never needs to match the server bit-for-bit, just look right. */
export function randomSpreadDirection(
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
