export type WeaponId = "rifle" | "smg" | "shotgun";

export type FireMode = "semi" | "auto";

export interface WeaponDef {
  id: WeaponId;
  name: string;
  fireMode: FireMode;
  damage: number;
  /** Pellets fired per trigger pull. 1 for hitscan rifles/SMGs, >1 for shotguns. */
  pelletCount: number;
  /** Half-angle of the random spread cone, in radians. 0 = perfectly accurate. */
  spreadRadians: number;
  fireRateRpm: number;
  magazineSize: number;
  reloadTimeMs: number;
  range: number;
}

// Balance pass notes (numbers chosen so each weapon has a genuinely
// different identity, not just different damage — theoretical
// back-to-back-hits TTK is always going to be well under a second for any
// hitscan weapon; what actually produces 3-8s fights is missed shots,
// repositioning, and reaction time, which spread/range/fire-rate shape:
//  rifle:   3 hits to kill (34 x 3 = 102). Near-zero spread — reward for
//           landing precise hits at any range. The all-rounder/precision pick.
//  smg:     6 hits to kill (18 x 6 = 108). Fast fire rate, mobile, but
//           noticeably spreadier than the rifle (~1.6° vs ~0.1°) so it loses
//           the precision fight at range and wants to close distance.
//  shotgun: 8 pellets x 14 dmg = 112 max — kills in one shot only if
//           EVERY pellet connects (true point blank); at any real distance
//           you're relying on a fast follow-up, which the slow 70rpm fire
//           rate punishes. Spread widens fast with range so it's a genuine
//           close-range specialist, not just "the strong gun."
export const WEAPONS: Record<WeaponId, WeaponDef> = {
  rifle: {
    id: "rifle",
    name: "Rifle",
    fireMode: "semi",
    damage: 34,
    pelletCount: 1,
    spreadRadians: 0.0015,
    fireRateRpm: 420,
    magazineSize: 24,
    reloadTimeMs: 1600,
    range: 200,
  },
  smg: {
    id: "smg",
    name: "SMG",
    fireMode: "auto",
    damage: 18,
    pelletCount: 1,
    spreadRadians: 0.028,
    fireRateRpm: 780,
    magazineSize: 30,
    reloadTimeMs: 1800,
    range: 200,
  },
  shotgun: {
    id: "shotgun",
    name: "Shotgun",
    fireMode: "semi",
    damage: 14,
    pelletCount: 8,
    spreadRadians: 0.13,
    fireRateRpm: 70,
    magazineSize: 6,
    reloadTimeMs: 2200,
    range: 200,
  },
};

export const WEAPON_ORDER: WeaponId[] = ["rifle", "smg", "shotgun"];

export function fireIntervalMs(weapon: WeaponDef): number {
  return 60000 / weapon.fireRateRpm;
}
