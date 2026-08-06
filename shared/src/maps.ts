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

/** A climbable volume — not a solid collider (never appears in `blocks`, so
 * it never blocks movement or bullets). A player attaches the instant their
 * box overlaps this zone; see stepPlayerMovement for the climbing state
 * itself. `depthAxis` is the horizontal axis the zone is thin along (the
 * wall it's mounted against faces along that axis) — the renderer uses it
 * to lay ladder rungs across the other horizontal axis. */
export interface LadderZone extends BoxCollider {
  depthAxis: "x" | "z";
}

export interface MapDefinition {
  id: string;
  name: string;
  skyColor: number;
  fogColor: number;
  fogDensity: number;
  ambientIntensity: number;
  blocks: MapBlock[];
  ladders: LadderZone[];
  /** Used by Duel (2 players — index 0/1 map directly to the two sides). */
  spawns: SpawnPoint[];
  /** Used by team 5v5 — one small cluster per side rather than a single
   * point, so up to TEAM_SIZE_MAX players on the same team don't spawn
   * stacked on top of each other. Hand-placed near (and reusing the facing
   * angle of) each map's existing Duel spawn corner, checked clear of that
   * corner's actual geometry — not a generic offset grid, since a couple of
   * these maps (Bastion's stairs, Outpost's ladder towers) have real
   * obstacles close to the original spawn point. */
  teamSpawns: { a: SpawnPoint[]; b: SpawnPoint[] };
}

function box(
  kind: BlockKind,
  color: number,
  center: Vec3,
  half: Vec3
): MapBlock {
  return { kind, color, center, half };
}

function ladder(center: Vec3, half: Vec3, depthAxis: "x" | "z"): LadderZone {
  return { center, half, depthAxis };
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
  ladders: [],
  spawns: [
    // Clear of the platform colliders (x: -16.5..-11.5 / 11.5..16.5) and side
    // cover boxes (z: +/-4) so players never spawn embedded in geometry.
    { position: { x: -18, y: 1.2, z: 8 }, yaw: -2.35 },
    { position: { x: 18, y: 1.2, z: -8 }, yaw: 0.79 },
  ],
  teamSpawns: {
    // All clear of the platform colliders (x: -16.5..-11.5 / 11.5..16.5)
    // and side cover boxes (x: -7.5..-4.5, z: +/-4).
    a: [
      { position: { x: -18, y: 1.2, z: 8 }, yaw: -2.35 },
      { position: { x: -18, y: 1.2, z: 11 }, yaw: -2.35 },
      { position: { x: -18, y: 1.2, z: 5 }, yaw: -2.35 },
      { position: { x: -15, y: 1.2, z: 10 }, yaw: -2.35 },
      { position: { x: -15, y: 1.2, z: 6 }, yaw: -2.35 },
    ],
    b: [
      { position: { x: 18, y: 1.2, z: -8 }, yaw: 0.79 },
      { position: { x: 18, y: 1.2, z: -11 }, yaw: 0.79 },
      { position: { x: 18, y: 1.2, z: -5 }, yaw: 0.79 },
      { position: { x: 15, y: 1.2, z: -10 }, yaw: 0.79 },
      { position: { x: 15, y: 1.2, z: -6 }, yaw: 0.79 },
    ],
  },
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
  ladders: [],
  spawns: [
    // Ground level near each platform's base, clear of the treads
    // (x: -11..-8 / 8..11) and low cover boxes.
    { position: { x: -8, y: 1.2, z: 8 }, yaw: -0.785 },
    { position: { x: 8, y: 1.2, z: -8 }, yaw: 2.356 },
  ],
  teamSpawns: {
    // Clear of the west platform/stairs (x: -19..-8, z: -4..4) and the low/
    // mid cover boxes, spread across the open ground east of the stairs.
    a: [
      { position: { x: -8, y: 1.2, z: 8 }, yaw: -0.785 },
      { position: { x: -8, y: 1.2, z: 11 }, yaw: -0.785 },
      { position: { x: -5, y: 1.2, z: 9 }, yaw: -0.785 },
      { position: { x: -5, y: 1.2, z: 12 }, yaw: -0.785 },
      { position: { x: -9.5, y: 1.2, z: 11 }, yaw: -0.785 },
    ],
    b: [
      { position: { x: 8, y: 1.2, z: -8 }, yaw: 2.356 },
      { position: { x: 8, y: 1.2, z: -11 }, yaw: 2.356 },
      { position: { x: 5, y: 1.2, z: -9 }, yaw: 2.356 },
      { position: { x: 5, y: 1.2, z: -12 }, yaw: 2.356 },
      { position: { x: 9.5, y: 1.2, z: -11 }, yaw: 2.356 },
    ],
  },
};

/**
 * The verticality/route-variety map: a sunken central tunnel (roofed in the
 * middle, open at both ends so it's also a jump-down shortcut from the
 * courtyard floor, not just a formal detour) plus two ladder towers with
 * catwalks overlooking the courtyard from real height (5m, well beyond
 * Bastion's 1.2m stair platforms). Three genuinely different routes between
 * spawns: straight through the courtyard, up and across the catwalks, or
 * through the tunnel. Built as a new map rather than reworking Foundry
 * (deliberately simple/flat by design) or Bastion (already tuned and
 * user-confirmed) — this keeps both existing maps intact.
 */
export const OUTPOST: MapDefinition = {
  id: "outpost",
  name: "Outpost",
  skyColor: 0x3d5560,
  fogColor: 0x4a6670,
  fogDensity: 0.014,
  ambientIntensity: 1.0,
  blocks: [
    // Perimeter walls (same corner-overlap technique as the other maps)
    box("wall", 0x5c7480, { x: 0, y: 2, z: -14 }, { x: 20.5, y: 2, z: 0.5 }),
    box("wall", 0x5c7480, { x: 0, y: 2, z: 14 }, { x: 20.5, y: 2, z: 0.5 }),
    box("wall", 0x5c7480, { x: -20, y: 2, z: 0 }, { x: 0.5, y: 2, z: 14.5 }),
    box("wall", 0x5c7480, { x: 20, y: 2, z: 0 }, { x: 0.5, y: 2, z: 14.5 }),

    // Courtyard floor, split around the sunken tunnel channel (x:-4..4,
    // z:-2..2) rather than one slab, so that channel can sit lower.
    box("floor", 0x6b7d85, { x: -12, y: -0.5, z: 0 }, { x: 8, y: 0.5, z: 14 }), // west of tunnel
    box("floor", 0x6b7d85, { x: 12, y: -0.5, z: 0 }, { x: 8, y: 0.5, z: 14 }), // east of tunnel
    box("floor", 0x6b7d85, { x: 0, y: -0.5, z: 8 }, { x: 4, y: 0.5, z: 6 }), // north strip over the channel
    box("floor", 0x6b7d85, { x: 0, y: -0.5, z: -8 }, { x: 4, y: 0.5, z: 6 }), // south strip over the channel

    // Sunken tunnel floor (top at y=-1.2) and a roof over its central,
    // fully-sunken section only — kept clear of the staircases' x-range
    // (-4..-2.8 / 2.8..4) entirely, since a player descending the stairs is
    // still mostly at courtyard height (and taller than the roof's
    // clearance) partway down; roofing that stretch would wedge them
    // between the ceiling and the stairs before they can duck under it.
    // The open ends also make jumping straight down from the courtyard
    // edge a legitimate (if risky) shortcut, while the middle reads as a
    // real enclosed tunnel.
    box("floor", 0x51616a, { x: 0, y: -1.7, z: 0 }, { x: 4, y: 0.5, z: 2 }),
    // Ceiling's *effective* blocking boundary is its edge plus the
    // player's own half-width (0.35), not just its raw edge — half.x=2.3
    // keeps that effective boundary (~2.65) clear of the staircases'
    // inner edge (2.8), which a naive "just narrower than the stairs"
    // width doesn't (found by simulating a walk-through and hitting
    // exactly this margin).
    box("wall", 0x445258, { x: 0, y: 0.95, z: 0 }, { x: 2.3, y: 0.15, z: 2 }),

    // West tunnel staircase (0.4m rise per tread, same technique as
    // Bastion's stairs, descending from courtyard level 0 to tunnel -1.2).
    box("platform", 0x5c6f78, { x: -3.8, y: -1.3, z: 0 }, { x: 0.2, y: 0.9, z: 2 }), // top -0.4
    box("platform", 0x5c6f78, { x: -3.4, y: -1.7, z: 0 }, { x: 0.2, y: 0.9, z: 2 }), // top -0.8
    box("platform", 0x5c6f78, { x: -3.0, y: -2.1, z: 0 }, { x: 0.2, y: 0.9, z: 2 }), // top -1.2

    // East tunnel staircase, mirrored
    box("platform", 0x5c6f78, { x: 3.8, y: -1.3, z: 0 }, { x: 0.2, y: 0.9, z: 2 }),
    box("platform", 0x5c6f78, { x: 3.4, y: -1.7, z: 0 }, { x: 0.2, y: 0.9, z: 2 }),
    box("platform", 0x5c6f78, { x: 3.0, y: -2.1, z: 0 }, { x: 0.2, y: 0.9, z: 2 }),

    // West ladder tower: a 6.5m backing wall with a ladder mounted on its
    // courtyard-facing side, topped by a catwalk (top at y=5.3) offset in
    // +Z from the ladder so reaching it means climbing up then stepping
    // sideways off the ladder, not just walking straight off the top. The
    // ladder (and this wall) climb well past the catwalk's height rather
    // than stopping right at it — a player's whole body has to clear the
    // catwalk's underside before shimmying sideways onto it, or the
    // catwalk's edge just blocks them like a wall instead of being
    // something to step up onto, so the extra headroom is load-bearing,
    // not just generous.
    box("wall", 0x475660, { x: -14, y: 3.25, z: 0 }, { x: 0.4, y: 3.25, z: 2 }),
    box("platform", 0x5c6f78, { x: -11.5, y: 5.15, z: 2.75 }, { x: 2.5, y: 0.15, z: 1.75 }),

    // East ladder tower, mirrored
    box("wall", 0x475660, { x: 14, y: 3.25, z: 0 }, { x: 0.4, y: 3.25, z: 2 }),
    box("platform", 0x5c6f78, { x: 11.5, y: 5.15, z: 2.75 }, { x: 2.5, y: 0.15, z: 1.75 }),

    // Courtyard cover, offset diagonally so there's no single dominant
    // sightline straight across the map.
    box("cover", 0x647680, { x: -9, y: 0.75, z: 6 }, { x: 1.2, y: 0.75, z: 1.2 }),
    box("cover", 0x647680, { x: 9, y: 0.75, z: -6 }, { x: 1.2, y: 0.75, z: 1.2 }),
  ],
  ladders: [
    // Spans the full 6.5m wall height, matching it.
    ladder({ x: -13.3, y: 3.25, z: 0 }, { x: 0.3, y: 3.25, z: 0.6 }, "x"),
    ladder({ x: 13.3, y: 3.25, z: 0 }, { x: 0.3, y: 3.25, z: 0.6 }, "x"),
  ],
  spawns: [
    // Clear of both towers (x: -14.4..-13.6 / 13.6..14.4) and the tunnel
    // channel (x: -4..4).
    { position: { x: -18, y: 1.2, z: 9 }, yaw: -2.35 },
    { position: { x: 18, y: 1.2, z: -9 }, yaw: 0.79 },
  ],
  teamSpawns: {
    // Clear of both towers (x: -14.4..-13.6 / 13.6..14.4), the tunnel
    // channel (x: -4..4), and each side's courtyard cover box.
    a: [
      { position: { x: -18, y: 1.2, z: 9 }, yaw: -2.35 },
      { position: { x: -18, y: 1.2, z: 12 }, yaw: -2.35 },
      { position: { x: -18, y: 1.2, z: 6 }, yaw: -2.35 },
      { position: { x: -16, y: 1.2, z: 11 }, yaw: -2.35 },
      { position: { x: -16, y: 1.2, z: 7 }, yaw: -2.35 },
    ],
    b: [
      { position: { x: 18, y: 1.2, z: -9 }, yaw: 0.79 },
      { position: { x: 18, y: 1.2, z: -12 }, yaw: 0.79 },
      { position: { x: 18, y: 1.2, z: -6 }, yaw: 0.79 },
      { position: { x: 16, y: 1.2, z: -11 }, yaw: 0.79 },
      { position: { x: 16, y: 1.2, z: -7 }, yaw: 0.79 },
    ],
  },
};

export const MAPS: Record<string, MapDefinition> = {
  [TEST_ARENA.id]: TEST_ARENA,
  [BASTION.id]: BASTION,
  [OUTPOST.id]: OUTPOST,
};

export const MAP_ORDER: string[] = [TEST_ARENA.id, BASTION.id, OUTPOST.id];

export const DEFAULT_MAP_ID = TEST_ARENA.id;
