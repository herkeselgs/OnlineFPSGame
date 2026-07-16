import { BlockKind, LadderZone, MapBlock, MapDefinition, SpawnPoint } from "./maps.js";
import { HOLD_TASK_DURATION_MS, SEQUENCE_TASK_LENGTH, TASK_INTERACT_RADIUS, TaskStationDef } from "./impostorTasks.js";
import { Vec3 } from "./vec.js";

// Local helper mirroring maps.ts's (intentionally un-exported) box() — see
// impostorMap.ts's original comment: kept independent of Duel's map module
// rather than exported/shared, consistent with Imposter mode being a
// sibling, not sharing internals with Duel.
function box(kind: BlockKind, color: number, center: Vec3, half: Vec3): MapBlock {
  return { kind, color, center, half };
}

const WALL = 0x4a5c68;

/**
 * An open central hub (everyone spawns here) with four "cardinal" rooms
 * (Bridge/Reactor/Armory/Medbay) directly off it via straight corridors,
 * and four further "corner" rooms (Engine Bay/Lab/Storage/Comms) reached by
 * branch corridors off the North and South rooms — 8 rooms and 6 corridors
 * total, each room housing one task station. Sized well beyond the first
 * cut (M2's 4 open corner nooks): this is a real building with actual
 * hallways, not just sightline breaks around one shared floor. Imposter
 * mode's own map, not registered in Duel's MAPS/MAP_ORDER.
 */
export const FACILITY_MAP: MapDefinition = {
  id: "facility",
  name: "Facility",
  skyColor: 0x2a3540,
  fogColor: 0x35424e,
  fogDensity: 0.009,
  ambientIntensity: 0.7,
  blocks: [
    // Perimeter (corner-overlap technique matching the other maps) and one
    // floor slab spanning the whole bounding box — every room/corridor sits
    // on this same slab rather than separate floor pieces, so even a wall
    // placement slightly off doesn't risk a fall-through-the-world gap,
    // only an unintended shortcut across otherwise-unused floor.
    box("wall", WALL, { x: 0, y: 2, z: -26 }, { x: 26.5, y: 2, z: 0.5 }),
    box("wall", WALL, { x: 0, y: 2, z: 26 }, { x: 26.5, y: 2, z: 0.5 }),
    box("wall", WALL, { x: -26, y: 2, z: 0 }, { x: 0.5, y: 2, z: 26 }),
    box("wall", WALL, { x: 26, y: 2, z: 0 }, { x: 0.5, y: 2, z: 26 }),
    box("floor", 0x556674, { x: 0, y: -0.5, z: 0 }, { x: 26, y: 0.5, z: 26 }),

    // Hub cover.
    box("cover", 0x62727e, { x: -3, y: 0.75, z: 0 }, { x: 1, y: 0.75, z: 1 }),
    box("cover", 0x62727e, { x: 3, y: 0.75, z: 0 }, { x: 1, y: 0.75, z: 1 }),

    // --- Hub -> North corridor (Bridge) ---
    box("wall", WALL, { x: -1.8, y: 2, z: 11 }, { x: 0.3, y: 2, z: 3 }),
    box("wall", WALL, { x: 1.8, y: 2, z: 11 }, { x: 0.3, y: 2, z: 3 }),
    // North room ("Bridge", x:-5..5 z:14..24). South side (facing the
    // corridor) is left fully open as the room's mouth -- see the file
    // comment on why hub-facing sides skip a wall entirely.
    box("wall", WALL, { x: 0, y: 2, z: 24 }, { x: 5.3, y: 2, z: 0.3 }), // back
    box("wall", WALL, { x: 5, y: 2, z: 15.75 }, { x: 0.3, y: 2, z: 1.75 }), // east, gap 17.5-20.5 for NE branch
    box("wall", WALL, { x: 5, y: 2, z: 22.25 }, { x: 0.3, y: 2, z: 1.75 }),
    box("wall", WALL, { x: -5, y: 2, z: 15.75 }, { x: 0.3, y: 2, z: 1.75 }), // west, gap 17.5-20.5 for NW branch
    box("wall", WALL, { x: -5, y: 2, z: 22.25 }, { x: 0.3, y: 2, z: 1.75 }),

    // --- Hub -> South corridor (Reactor) ---
    box("wall", WALL, { x: -1.8, y: 2, z: -11 }, { x: 0.3, y: 2, z: 3 }),
    box("wall", WALL, { x: 1.8, y: 2, z: -11 }, { x: 0.3, y: 2, z: 3 }),
    // South room ("Reactor", x:-5..5 z:-24..-14). North side open (mouth).
    box("wall", WALL, { x: 0, y: 2, z: -24 }, { x: 5.3, y: 2, z: 0.3 }), // back
    box("wall", WALL, { x: 5, y: 2, z: -22.25 }, { x: 0.3, y: 2, z: 1.75 }), // east, gap -20.5..-17.5 for SE branch
    box("wall", WALL, { x: 5, y: 2, z: -15.75 }, { x: 0.3, y: 2, z: 1.75 }),
    box("wall", WALL, { x: -5, y: 2, z: -22.25 }, { x: 0.3, y: 2, z: 1.75 }), // west, gap -20.5..-17.5 for SW branch
    box("wall", WALL, { x: -5, y: 2, z: -15.75 }, { x: 0.3, y: 2, z: 1.75 }),

    // --- Hub -> East corridor (Armory) ---
    box("wall", WALL, { x: 11, y: 2, z: -1.8 }, { x: 3, y: 2, z: 0.3 }),
    box("wall", WALL, { x: 11, y: 2, z: 1.8 }, { x: 3, y: 2, z: 0.3 }),
    // East room ("Armory", x:14..24 z:-5..5). West side open (mouth).
    box("wall", WALL, { x: 24, y: 2, z: 0 }, { x: 0.3, y: 2, z: 5.3 }), // back
    box("wall", WALL, { x: 19, y: 2, z: 5 }, { x: 5.3, y: 2, z: 0.3 }), // north
    box("wall", WALL, { x: 19, y: 2, z: -5 }, { x: 5.3, y: 2, z: 0.3 }), // south

    // --- Hub -> West corridor (Medbay) ---
    box("wall", WALL, { x: -11, y: 2, z: -1.8 }, { x: 3, y: 2, z: 0.3 }),
    box("wall", WALL, { x: -11, y: 2, z: 1.8 }, { x: 3, y: 2, z: 0.3 }),
    // West room ("Medbay", x:-24..-14 z:-5..5). East side open (mouth).
    box("wall", WALL, { x: -24, y: 2, z: 0 }, { x: 0.3, y: 2, z: 5.3 }), // back
    box("wall", WALL, { x: -19, y: 2, z: 5 }, { x: 5.3, y: 2, z: 0.3 }), // north
    box("wall", WALL, { x: -19, y: 2, z: -5 }, { x: 5.3, y: 2, z: 0.3 }), // south

    // --- North -> NE branch corridor (Engine Bay) ---
    box("wall", WALL, { x: 9, y: 2, z: 17.5 }, { x: 4, y: 2, z: 0.3 }),
    box("wall", WALL, { x: 9, y: 2, z: 20.5 }, { x: 4, y: 2, z: 0.3 }),
    // NE room ("Engine Bay", x:13..23 z:14..24). West side open toward branch.
    box("wall", WALL, { x: 18, y: 2, z: 24 }, { x: 5.3, y: 2, z: 0.3 }), // back
    box("wall", WALL, { x: 23, y: 2, z: 19 }, { x: 0.3, y: 2, z: 5.3 }), // east
    box("wall", WALL, { x: 18, y: 2, z: 14 }, { x: 5.3, y: 2, z: 0.3 }), // south

    // --- North -> NW branch corridor (Lab) ---
    box("wall", WALL, { x: -9, y: 2, z: 17.5 }, { x: 4, y: 2, z: 0.3 }),
    box("wall", WALL, { x: -9, y: 2, z: 20.5 }, { x: 4, y: 2, z: 0.3 }),
    // NW room ("Lab", x:-23..-13 z:14..24). East side open toward branch.
    box("wall", WALL, { x: -18, y: 2, z: 24 }, { x: 5.3, y: 2, z: 0.3 }), // back
    box("wall", WALL, { x: -23, y: 2, z: 19 }, { x: 0.3, y: 2, z: 5.3 }), // west
    box("wall", WALL, { x: -18, y: 2, z: 14 }, { x: 5.3, y: 2, z: 0.3 }), // south

    // --- South -> SE branch corridor (Storage) ---
    box("wall", WALL, { x: 9, y: 2, z: -17.5 }, { x: 4, y: 2, z: 0.3 }),
    box("wall", WALL, { x: 9, y: 2, z: -20.5 }, { x: 4, y: 2, z: 0.3 }),
    // SE room ("Storage", x:13..23 z:-24..-14). West side open toward branch.
    box("wall", WALL, { x: 18, y: 2, z: -24 }, { x: 5.3, y: 2, z: 0.3 }), // back
    box("wall", WALL, { x: 23, y: 2, z: -19 }, { x: 0.3, y: 2, z: 5.3 }), // east
    box("wall", WALL, { x: 18, y: 2, z: -14 }, { x: 5.3, y: 2, z: 0.3 }), // north

    // --- South -> SW branch corridor (Comms) ---
    box("wall", WALL, { x: -9, y: 2, z: -17.5 }, { x: 4, y: 2, z: 0.3 }),
    box("wall", WALL, { x: -9, y: 2, z: -20.5 }, { x: 4, y: 2, z: 0.3 }),
    // SW room ("Comms", x:-23..-13 z:-24..-14). East side open toward branch.
    box("wall", WALL, { x: -18, y: 2, z: -24 }, { x: 5.3, y: 2, z: 0.3 }), // back
    box("wall", WALL, { x: -23, y: 2, z: -19 }, { x: 0.3, y: 2, z: 5.3 }), // west
    box("wall", WALL, { x: -18, y: 2, z: -14 }, { x: 5.3, y: 2, z: 0.3 }), // north
  ],
  ladders: [] as LadderZone[],
  // 10 spawns scattered in a ring around the hub center, clear of both
  // cover boxes (x: -4..-2 / 2..4, z: -1..1) and every corridor mouth.
  spawns: ((): SpawnPoint[] => {
    const points: SpawnPoint[] = [];
    const radius = 6;
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

function hold(id: string, name: string, position: Vec3): TaskStationDef {
  return { id, kind: "hold", name, position, radius: TASK_INTERACT_RADIUS, holdDurationMs: HOLD_TASK_DURATION_MS, sequenceLength: 0 };
}

function sequence(id: string, name: string, position: Vec3): TaskStationDef {
  return {
    id,
    kind: "sequence",
    name,
    position,
    radius: TASK_INTERACT_RADIUS,
    holdDurationMs: 0,
    sequenceLength: SEQUENCE_TASK_LENGTH,
  };
}

// 8 stations (4 hold, 4 sequence), one per room -- each crewmate is
// randomly assigned a subset of these (see TASKS_PER_PLAYER), not the
// whole list, so different players naturally end up in different rooms.
export const TASK_STATIONS: TaskStationDef[] = [
  hold("bridge", "Plot Course (Bridge)", { x: 0, y: 1, z: 19 }),
  sequence("reactor", "Stabilize Reactor", { x: 0, y: 1, z: -19 }),
  hold("armory", "Restock Armory", { x: 19, y: 1, z: 0 }),
  sequence("medbay", "Run Diagnostics (Medbay)", { x: -19, y: 1, z: 0 }),
  sequence("engine-bay", "Fix Wiring (Engine Bay)", { x: 18, y: 1, z: 19 }),
  hold("lab", "Scan Samples (Lab)", { x: -18, y: 1, z: 19 }),
  hold("storage", "Sort Cargo (Storage)", { x: 18, y: 1, z: -19 }),
  sequence("comms", "Realign Antenna (Comms)", { x: -18, y: 1, z: -19 }),
];

export const IMPOSTOR_MAPS: Record<string, MapDefinition> = {
  [FACILITY_MAP.id]: FACILITY_MAP,
};

export const DEFAULT_IMPOSTOR_MAP_ID = FACILITY_MAP.id;
