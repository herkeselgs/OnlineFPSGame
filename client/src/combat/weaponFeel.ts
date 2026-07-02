import { WeaponId } from "@fps/shared";

/** Cosmetic-only per-weapon feel tuning (screen shake / recoil kick amounts).
 * Deliberately NOT part of the shared WeaponDef — these have zero gameplay
 * effect (never sent over the network, never validated), so they don't
 * belong in the data the server also trusts. */
export interface WeaponFeel {
  trauma: number;
  kick: number;
}

const WEAPON_FEEL: Record<WeaponId, WeaponFeel> = {
  rifle: { trauma: 0.16, kick: 0.018 },
  smg: { trauma: 0.09, kick: 0.01 },
  shotgun: { trauma: 0.34, kick: 0.045 },
};

export function feelFor(weapon: WeaponId): WeaponFeel {
  return WEAPON_FEEL[weapon];
}
