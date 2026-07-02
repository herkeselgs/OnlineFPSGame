import { BoxCollider } from "./collision.js";
import { Vec3 } from "./vec.js";

/** Visual category so the client renderer can pick materials without the
 * shared layer knowing anything about Three.js. */
export type BlockKind = "floor" | "wall" | "cover" | "platform" | "ramp";

export interface MapBlock extends BoxCollider {
  kind: BlockKind;
  /** Hex color hint for the low-poly renderer, e.g. 0x3a5a78 */
  color: number;
}

export interface SpawnPoint {
  position: Vec3;
  yaw: number;
}

export interface MapDefinition {
  id: string;
  name: string;
  skyColor: number;
  fogColor: number;
  fogDensity: number;
  ambientIntensity: number;
  blocks: MapBlock[];
  spawns: SpawnPoint[];
}

function box(
  kind: BlockKind,
  color: number,
  center: Vec3,
  half: Vec3
): MapBlock {
  return { kind, color, center, half };
}

/**
 * Small symmetric duel arena used both as the movement/combat test map and
 * as the first real 1v1 map. Deliberately compact with clear sightline
 * breaks (the center pillar + two side boxes) so fights stay close-range.
 */
export const TEST_ARENA: MapDefinition = {
  id: "test-arena",
  name: "Foundry",
  skyColor: 0x8fc6e8,
  fogColor: 0x9fd0ec,
  fogDensity: 0.012,
  ambientIntensity: 0.65,
  blocks: [
    // Floor
    box("floor", 0x6b7280, { x: 0, y: -0.5, z: 0 }, { x: 20, y: 0.5, z: 14 }),

    // Perimeter walls. Extended half-extents overlap by the wall thickness at
    // each corner (rather than meeting edge-to-edge) so there's no hairline
    // gap for fast diagonal movement to tunnel through.
    box("wall", 0x9ca3af, { x: 0, y: 2, z: -14 }, { x: 20.5, y: 2, z: 0.5 }),
    box("wall", 0x9ca3af, { x: 0, y: 2, z: 14 }, { x: 20.5, y: 2, z: 0.5 }),
    box("wall", 0x9ca3af, { x: -20, y: 2, z: 0 }, { x: 0.5, y: 2, z: 14.5 }),
    box("wall", 0x9ca3af, { x: 20, y: 2, z: 0 }, { x: 0.5, y: 2, z: 14.5 }),

    // Center pillar (breaks the long sightline through mid)
    box("cover", 0x475569, { x: 0, y: 1.5, z: 0 }, { x: 1.2, y: 1.5, z: 1.2 }),

    // Side cover boxes
    box("cover", 0x64748b, { x: -6, y: 0.75, z: -4 }, { x: 1.5, y: 0.75, z: 1.5 }),
    box("cover", 0x64748b, { x: 6, y: 0.75, z: 4 }, { x: 1.5, y: 0.75, z: 1.5 }),
    box("cover", 0x64748b, { x: -6, y: 0.75, z: 4 }, { x: 1.5, y: 0.75, z: 1.5 }),
    box("cover", 0x64748b, { x: 6, y: 0.75, z: -4 }, { x: 1.5, y: 0.75, z: 1.5 }),

    // Raised side platforms for verticality
    box("platform", 0x52606d, { x: -14, y: 1, z: 0 }, { x: 2.5, y: 1, z: 3 }),
    box("platform", 0x52606d, { x: 14, y: 1, z: 0 }, { x: 2.5, y: 1, z: 3 }),
  ],
  spawns: [
    // Clear of the platform colliders (x: -16.5..-11.5 / 11.5..16.5) and side
    // cover boxes (z: +/-4) so players never spawn embedded in geometry.
    { position: { x: -18, y: 1.2, z: 8 }, yaw: -2.35 },
    { position: { x: 18, y: 1.2, z: -8 }, yaw: 0.79 },
  ],
};

export const MAPS: Record<string, MapDefinition> = {
  [TEST_ARENA.id]: TEST_ARENA,
};

export const DEFAULT_MAP_ID = TEST_ARENA.id;
