import { BlockKind, LadderZone, MapBlock, MapDefinition, SpawnPoint } from "./maps.js";
import { HOLD_TASK_DURATION_MS, SEQUENCE_TASK_LENGTH, TASK_INTERACT_RADIUS, TaskStationDef } from "./impostorTasks.js";
import { Vec3 } from "./vec.js";

// Local helpers mirroring maps.ts's (intentionally un-exported) box()/ladder()
// — trivial enough that duplicating rather than exporting keeps this file's
// map data fully independent of Duel's, consistent with the rest of Imposter
// mode being a sibling rather than sharing internals with Duel's map module.
function box(kind: BlockKind, color: number, center: Vec3, half: Vec3): MapBlock {
  return { kind, color, center, half };
}

/**
 * A large central hub (where everyone spawns) with four corner rooms, each
 * housing one task station and partially walled off (an L-shaped interior
 * wall per corner, open toward the hub) so each room reads as a distinct
 * space with blocked sightlines rather than one open box — important for a
 * mode about splitting up. Sized for up to 10 roaming players, unlike
 * Duel's compact 1v1 arenas. This is Imposter mode's own map, not
 * registered in Duel's MAPS/MAP_ORDER, so it never shows up in Duel's
 * practice map picker.
 */
export const FACILITY_MAP: MapDefinition = {
  id: "facility",
  name: "Facility",
  skyColor: 0x2a3540,
  fogColor: 0x35424e,
  fogDensity: 0.01,
  ambientIntensity: 0.7,
  blocks: [
    // Perimeter walls (corner-overlap technique matching the other maps).
    box("wall", 0x4a5c68, { x: 0, y: 2, z: -15 }, { x: 15.5, y: 2, z: 0.5 }),
    box("wall", 0x4a5c68, { x: 0, y: 2, z: 15 }, { x: 15.5, y: 2, z: 0.5 }),
    box("wall", 0x4a5c68, { x: -15, y: 2, z: 0 }, { x: 0.5, y: 2, z: 15 }),
    box("wall", 0x4a5c68, { x: 15, y: 2, z: 0 }, { x: 0.5, y: 2, z: 15 }),

    box("floor", 0x556674, { x: 0, y: -0.5, z: 0 }, { x: 15, y: 0.5, z: 15 }),

    // Hub cover (a little visual/tactical structure around the spawn area,
    // same convention as Duel's maps).
    box("cover", 0x62727e, { x: -3, y: 0.75, z: 0 }, { x: 1, y: 0.75, z: 1 }),
    box("cover", 0x62727e, { x: 3, y: 0.75, z: 0 }, { x: 1, y: 0.75, z: 1 }),

    // --- NE corner room: "Engine Bay" (hold task) ---
    // Interior L, open toward the hub in the gap between x:7-10 and z:7-10.
    box("wall", 0x4a5c68, { x: 7, y: 2, z: 12.5 }, { x: 0.3, y: 2, z: 2.5 }),
    box("wall", 0x4a5c68, { x: 12.5, y: 2, z: 7 }, { x: 2.5, y: 2, z: 0.3 }),

    // --- NW corner room: "Lab" (sequence task) ---
    box("wall", 0x4a5c68, { x: -7, y: 2, z: 12.5 }, { x: 0.3, y: 2, z: 2.5 }),
    box("wall", 0x4a5c68, { x: -12.5, y: 2, z: 7 }, { x: 2.5, y: 2, z: 0.3 }),

    // --- SE corner room: "Storage" (hold task) ---
    box("wall", 0x4a5c68, { x: 7, y: 2, z: -12.5 }, { x: 0.3, y: 2, z: 2.5 }),
    box("wall", 0x4a5c68, { x: 12.5, y: 2, z: -7 }, { x: 2.5, y: 2, z: 0.3 }),

    // --- SW corner room: "Comms" (sequence task) ---
    box("wall", 0x4a5c68, { x: -7, y: 2, z: -12.5 }, { x: 0.3, y: 2, z: 2.5 }),
    box("wall", 0x4a5c68, { x: -12.5, y: 2, z: -7 }, { x: 2.5, y: 2, z: 0.3 }),
  ],
  ladders: [] as LadderZone[],
  // 10 spawns scattered in a ring around the hub center, clear of both cover
  // boxes (x: -4..-2 / 2..4) and all four corner rooms.
  spawns: ((): SpawnPoint[] => {
    const points: SpawnPoint[] = [];
    const radius = 5.5;
    const count = 10;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      points.push({
        position: { x: Math.cos(angle) * radius, y: 1.2, z: Math.sin(angle) * radius },
        yaw: angle + Math.PI,
      });
    }
    return points;
  })(),
};

export const TASK_STATIONS: TaskStationDef[] = [
  {
    id: "engine-bay",
    kind: "hold",
    name: "Fix Wiring (Engine Bay)",
    position: { x: 11, y: 1, z: 11 },
    radius: TASK_INTERACT_RADIUS,
    holdDurationMs: HOLD_TASK_DURATION_MS,
    sequenceLength: 0,
  },
  {
    id: "lab",
    kind: "sequence",
    name: "Scan Samples (Lab)",
    position: { x: -11, y: 1, z: 11 },
    radius: TASK_INTERACT_RADIUS,
    holdDurationMs: 0,
    sequenceLength: SEQUENCE_TASK_LENGTH,
  },
  {
    id: "storage",
    kind: "hold",
    name: "Sort Cargo (Storage)",
    position: { x: 11, y: 1, z: -11 },
    radius: TASK_INTERACT_RADIUS,
    holdDurationMs: HOLD_TASK_DURATION_MS,
    sequenceLength: 0,
  },
  {
    id: "comms",
    kind: "sequence",
    name: "Realign Antenna (Comms)",
    position: { x: -11, y: 1, z: -11 },
    radius: TASK_INTERACT_RADIUS,
    holdDurationMs: 0,
    sequenceLength: SEQUENCE_TASK_LENGTH,
  },
];

export const IMPOSTOR_MAPS: Record<string, MapDefinition> = {
  [FACILITY_MAP.id]: FACILITY_MAP,
};

export const DEFAULT_IMPOSTOR_MAP_ID = FACILITY_MAP.id;
