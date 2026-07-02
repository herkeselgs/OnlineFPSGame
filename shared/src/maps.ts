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

/**
 * A stair-climbable duel map (contrast to Foundry, which is deliberately
 * flat) — a raised sandstone platform at each spawn end gives a real
 * high-ground choice, reached by a 3-tread staircase (each tread rises
 * 0.4m, under STEP_HEIGHT so it's walkable, no jump-timing required).
 * Warm palette against Foundry's cool industrial gray so the two maps also
 * read differently at a glance, not just play differently.
 */
export const BASTION: MapDefinition = {
  id: "bastion",
  name: "Bastion",
  skyColor: 0xffb877,
  fogColor: 0xf2b483,
  fogDensity: 0.012,
  ambientIntensity: 0.72,
  blocks: [
    // Floor
    box("floor", 0xc9a876, { x: 0, y: -0.5, z: 0 }, { x: 20, y: 0.5, z: 14 }),

    // Perimeter walls (same corner-overlap technique as Foundry)
    box("wall", 0xddc39c, { x: 0, y: 2, z: -14 }, { x: 20.5, y: 2, z: 0.5 }),
    box("wall", 0xddc39c, { x: 0, y: 2, z: 14 }, { x: 20.5, y: 2, z: 0.5 }),
    box("wall", 0xddc39c, { x: -20, y: 2, z: 0 }, { x: 0.5, y: 2, z: 14.5 }),
    box("wall", 0xddc39c, { x: 20, y: 2, z: 0 }, { x: 0.5, y: 2, z: 14.5 }),

    // West platform (top at y=1.2) + 3-tread staircase leading up to it
    box("platform", 0xb98f5c, { x: -15, y: 0.1, z: 0 }, { x: 4, y: 1.1, z: 4 }),
    box("platform", 0xa9834f, { x: -8.5, y: -0.3, z: 0 }, { x: 0.5, y: 0.7, z: 4 }), // tread, top 0.4
    box("platform", 0xa9834f, { x: -9.5, y: -0.1, z: 0 }, { x: 0.5, y: 0.9, z: 4 }), // tread, top 0.8
    box("platform", 0xa9834f, { x: -10.5, y: 0.1, z: 0 }, { x: 0.5, y: 1.1, z: 4 }), // tread, top 1.2

    // East platform, mirrored
    box("platform", 0xb98f5c, { x: 15, y: 0.1, z: 0 }, { x: 4, y: 1.1, z: 4 }),
    box("platform", 0xa9834f, { x: 8.5, y: -0.3, z: 0 }, { x: 0.5, y: 0.7, z: 4 }),
    box("platform", 0xa9834f, { x: 9.5, y: -0.1, z: 0 }, { x: 0.5, y: 0.9, z: 4 }),
    box("platform", 0xa9834f, { x: 10.5, y: 0.1, z: 0 }, { x: 0.5, y: 1.1, z: 4 }),

    // Mid cover, offset (not centered) so there's no single dominant
    // sightline between the two platforms
    box("cover", 0x8a6a42, { x: -3, y: 1.25, z: 3 }, { x: 1, y: 1.25, z: 1 }),
    box("cover", 0x8a6a42, { x: 3, y: 1.25, z: -3 }, { x: 1, y: 1.25, z: 1 }),

    // Low cover near each spawn
    box("cover", 0x9c7a52, { x: -6, y: 0.6, z: -6 }, { x: 1.3, y: 0.6, z: 1.3 }),
    box("cover", 0x9c7a52, { x: 6, y: 0.6, z: 6 }, { x: 1.3, y: 0.6, z: 1.3 }),
  ],
  spawns: [
    // Ground level near each platform's base, clear of the treads
    // (x: -11..-8 / 8..11) and low cover boxes.
    { position: { x: -8, y: 1.2, z: 8 }, yaw: -0.785 },
    { position: { x: 8, y: 1.2, z: -8 }, yaw: 2.356 },
  ],
};

export const MAPS: Record<string, MapDefinition> = {
  [TEST_ARENA.id]: TEST_ARENA,
  [BASTION.id]: BASTION,
};

export const MAP_ORDER: string[] = [TEST_ARENA.id, BASTION.id];

export const DEFAULT_MAP_ID = TEST_ARENA.id;
