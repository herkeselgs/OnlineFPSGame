import { Settings } from "../state/settings";

// Base angular scale so "sensitivity = 1" feels reasonable in both modes.
const MOUSE_SCALE = 0.0022;
const TRACKPAD_SCALE = 0.0026;
// Reference input magnitude (px of pointer movement in one frame) at which
// the trackpad curve has unity gain — below it moves are damped (stable
// for tiny flicks), above it they're amplified (fast full swipes still spin
// you around quickly). This is what makes trackpad mode forgiving instead
// of twitchy while still allowing quick turns.
const TRACKPAD_REFERENCE_PX = 12;

/**
 * Converts a raw pointer delta (px) into a look-angle delta (radians) for
 * one axis, honoring the active look mode's response curve.
 */
export function applyLookCurve(rawDelta: number, settings: Settings): number {
  if (rawDelta === 0) return 0;

  if (!settings.trackpadMode) {
    return rawDelta * MOUSE_SCALE * settings.sensitivity;
  }

  const sign = Math.sign(rawDelta);
  const mag = Math.abs(rawDelta);
  const curved =
    Math.sign(mag - 0) *
    Math.pow(mag / TRACKPAD_REFERENCE_PX, settings.trackpadCurveExponent) *
    TRACKPAD_REFERENCE_PX;

  return sign * curved * TRACKPAD_SCALE * settings.sensitivity;
}

/** Pure function used both by the live game and the settings preview pad —
 * given an array of raw sample deltas, returns the curved output samples. */
export function previewCurve(samples: number[], settings: Settings): number[] {
  return samples.map((s) => applyLookCurve(s, settings));
}
