export interface Cosmetic {
  id: string;
  name: string;
  color: number;
  unlockLevel: number;
}

/** Player color cosmetics, unlocked by level. Purely visual — sent to the
 * server on join so opponents see the color you picked (RemotePlayer mesh),
 * never affects gameplay, so no validation beyond "is this id real". */
export const COSMETICS: Cosmetic[] = [
  { id: "verdant", name: "Verdant", color: 0x5fd68a, unlockLevel: 1 },
  { id: "azure", name: "Azure", color: 0x3aa0e8, unlockLevel: 2 },
  { id: "ember", name: "Ember", color: 0xe8703a, unlockLevel: 3 },
  { id: "violet", name: "Violet", color: 0xa855f7, unlockLevel: 5 },
  { id: "crimson", name: "Crimson", color: 0xe63946, unlockLevel: 7 },
  { id: "gold", name: "Gold", color: 0xf2c94c, unlockLevel: 10 },
];

export const DEFAULT_COSMETIC_ID = COSMETICS[0].id;

export function cosmeticById(id: string): Cosmetic {
  return COSMETICS.find((c) => c.id === id) ?? COSMETICS[0];
}

export function colorForCosmetic(id: string): number {
  return cosmeticById(id).color;
}

export function unlockedCosmetics(level: number): Cosmetic[] {
  return COSMETICS.filter((c) => c.unlockLevel <= level);
}
