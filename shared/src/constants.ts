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

// --- Ladder climbing ---
/** Vertical speed while climbing, roughly matching normal walk speed so
 * ladders don't feel like a shortcut or a penalty. */
export const CLIMB_SPEED = 4.2;

// --- Headshot hitbox ---
// Movement/body collision still uses one uniform box (PLAYER_HALF_EXTENTS,
// unchanged) — these only apply to hit *detection*, which tests two
// non-overlapping boxes stacked in Y instead: a torso box up to
// HEAD_BAND_MIN_Y, and a narrower head box above it. They must not overlap
// in Y — if they did, a ray entering through the (wider) torso box's front
// face would always win over the (narrower, recessed) head box, since the
// torso's near face is physically closer along most firing angles. Disjoint
// Y-ranges mean whichever height the ray actually lands at is the one it
// can hit, full stop.
export const HEAD_HALF_WIDTH = 0.22; // x/z half-extent of the head box
export const HEAD_BAND_MIN_Y = 0.58; // offset above the body's center; top of the torso box
export const HEAD_BAND_MAX_Y = PLAYER_HALF_EXTENTS.y; // top of the head box (matches the movement box's top)
/** Chosen so headshots meaningfully cut TTK (e.g. rifle: 3 body hits -> 2
 * headshots) without one-shotting from full health with any weapon's single
 * hit — still requires consecutive precision, not a coinflip. */
export const HEADSHOT_DAMAGE_MULTIPLIER = 2;

// --- Limb (arms/legs) hitbox ---
// The torso box used to run the full body's height (feet to HEAD_BAND_MIN_Y);
// it now stops at LEG_BAND_MAX_Y, with a separate leg box filling the rest of
// the way down — same "disjoint boxes stacked in Y" reasoning as the
// head/torso split above. Arms get their own boxes too, flanking the torso
// on either side rather than stacked in Y (a held-forward arm is beside the
// torso, not above or below it).
export const LEG_BAND_MAX_Y = -0.15; // hip line; below this is legs, at/above (up to HEAD_BAND_MIN_Y) is torso/arms
export const ARM_ZONE_HALF_WIDTH = 0.2; // x half-extent of each arm box
/** Limb hits (arms/legs) deal reduced damage relative to the torso baseline
 * — a real hit, just not center-mass. Headshot is 2x baseline; this is
 * 0.7x, so trading a body shot for a limb shot is never advantageous, but a
 * limb hit still meaningfully counts (rifle: ~5 limb hits to kill vs 3 body,
 * not a near-miss that may as well have not landed). */
export const LIMB_DAMAGE_MULTIPLIER = 0.7;

/** How long a disconnected player has to reconnect to their in-progress
 * match before it's scored as a forfeit. The match pauses (simulation and
 * timers frozen) for the whole window rather than continuing without them —
 * a brief school-wifi drop shouldn't hand the other player free kills. */
export const RECONNECT_GRACE_MS = 30000;

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
