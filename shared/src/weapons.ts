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

// Starting numbers — tuned properly in the balance pass, but chosen so each
// weapon already plays distinctly differently and fights land in the
// 3-8s TTK target against MAX_HEALTH (100):
//  rifle:   3 hits to kill (34 x 3 = 102), precise, semi-auto
//  smg:     6 hits to kill (18 x 6 = 108), fast auto-fire, more spread
//  shotgun: ~2 point-blank hits to kill (8 pellets x 16 = 128), short range punch
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
    spreadRadians: 0.018,
    fireRateRpm: 780,
    magazineSize: 30,
    reloadTimeMs: 1800,
    range: 200,
  },
  shotgun: {
    id: "shotgun",
    name: "Shotgun",
    fireMode: "semi",
    damage: 16,
    pelletCount: 8,
    spreadRadians: 0.09,
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
