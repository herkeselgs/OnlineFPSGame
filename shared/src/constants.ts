// Shared simulation constants. These MUST be identical on client and server —
// that agreement is what makes client-side prediction reconcile cleanly.

/** Physics simulation rate. Both client prediction and the authoritative
 * server run movement at this fixed tick so replays reconcile deterministically. */
export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;

/** Rate the server broadcasts authoritative world snapshots to clients.
 * Lower than SIM_HZ to save bandwidth; clients interpolate between snapshots. */
export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_DT = 1 / SNAPSHOT_HZ;

/** Extra delay (ms) the client buffers remote-player snapshots by before
 * rendering, so interpolation always has two real snapshots to lerp between
 * even under mild jitter. */
export const INTERP_DELAY_MS = 100;

/** How much position history the server retains per player for lag-compensated
 * hit validation (rewind-and-check). */
export const LAG_COMP_HISTORY_MS = 1000;

// --- Player physical dimensions (box-approximated capsule, box/box collision) ---
export const PLAYER_RADIUS = 0.35;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE_HEIGHT = 1.62;
export const PLAYER_HALF_EXTENTS = {
  x: PLAYER_RADIUS,
  y: PLAYER_HEIGHT / 2,
  z: PLAYER_RADIUS,
};

// --- Movement tuning ---
export const MOVE_SPEED = 6.2; // m/s
export const GROUND_ACCEL = 60;
export const GROUND_FRICTION = 10;
export const AIR_ACCEL = 15;
export const AIR_CONTROL_MAX_SPEED = 6.2;
export const GRAVITY = -22;
export const MAX_FALL_SPEED = -40;
export const JUMP_SPEED = 7.8;
/** Max height (m) a grounded player can walk up onto without jumping —
 * lets maps use short stair-step geometry for real verticality despite
 * collision being axis-aligned boxes only (no sloped ramps). */
export const STEP_HEIGHT = 0.55;

// --- Gameplay ---
export const MAX_HEALTH = 100;
export const RESPAWN_TIME_MS = 3000;
export const SPAWN_PROTECTION_MS = 1500;
export const MATCH_DURATION_MS = 5 * 60 * 1000;
export const MATCH_SCORE_LIMIT = 20;
export const MATCH_COUNTDOWN_MS = 3000;
export const RESULTS_DISPLAY_MS = 8000;

// --- Room codes ---
// Unambiguous charset: no 0/O, 1/I/l — easy to read aloud or text.
export const ROOM_CODE_CHARSET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 5;
