import { ClientInputMessage, PlayerId } from "./protocol.js";
import { Vec3 } from "./vec.js";

/**
 * Wire protocol + shared config for the Imposter social-deduction mode.
 * Deliberately a separate file/type surface from protocol.ts (Duel's) rather
 * than folding into the same unions — the two modes' phase machines and win
 * conditions are different enough that sharing one Room class would mean
 * threading mode-conditionals through Duel's tested code. A few truly generic
 * messages (ready-up, leave, ping/pong, reconnect, movement input) are reused
 * as-is; everything mode-specific below is its own type.
 */

// --- Lobby configuration ---

/** Absolute floor/ceiling the host's range picker is constrained to —
 * below 4 there's no meaningful crew to deduce among; above 10 the map/task
 * count this milestone plans for stops making sense. */
export const IMPOSTOR_MIN_PLAYERS = 4;
export const IMPOSTOR_MAX_PLAYERS = 10;
/** Matches classic Among Us's ceiling — beyond 3, imposters usually
 * outnumber the remaining crew before the crew can realistically organize a
 * vote, which isn't a fun failure mode. */
export const IMPOSTOR_MAX_IMPOSTERS = 3;

/** Default imposter count for a given lobby size, same scaling shape as
 * Among Us: roughly one imposter per 4-5 crewmates. The host can always
 * override this within isValidImposterCount's bounds. */
export function suggestImposterCount(playerCount: number): number {
  if (playerCount >= 9) return 3;
  if (playerCount >= 6) return 2;
  return 1;
}

/** At least 1 imposter, at most IMPOSTOR_MAX_IMPOSTERS, and imposters must
 * never be the majority (crew needs to outnumber them for a vote to mean
 * anything). */
export function isValidImposterCount(playerCount: number, imposterCount: number): boolean {
  return (
    Number.isInteger(imposterCount) &&
    imposterCount >= 1 &&
    imposterCount <= IMPOSTOR_MAX_IMPOSTERS &&
    imposterCount < playerCount
  );
}

export interface ImpostorRoomConfig {
  minPlayers: number;
  maxPlayers: number;
  imposterCount: number;
}

export function defaultImpostorConfig(): ImpostorRoomConfig {
  return { minPlayers: IMPOSTOR_MIN_PLAYERS, maxPlayers: IMPOSTOR_MAX_PLAYERS, imposterCount: 1 };
}

// --- Roles ---

export type ImpostorRole = "crewmate" | "imposter";

/** lobby: configuring/readying up. countdown: locked in, about to start.
 * active: free-roam (tasks/meetings/kills land in later milestones — this
 * phase will grow richer, not change shape). */
export type ImpostorPhase = "lobby" | "countdown" | "active";

// --- Lobby / roster ---

export interface ImpostorPlayerSummary {
  id: PlayerId;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
}

// --- Movement snapshot ---
// Deliberately its own (smaller) shape rather than reusing Duel's
// PlayerSnapshot — this mode has no health/weapon/kills yet, and stuffing
// fake values into those fields just to satisfy an unrelated wire shape
// would be more confusing than a few duplicated lines here.
export interface ImpostorPlayerSnapshot {
  id: PlayerId;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  color: number;
  /** Only meaningful to the player it belongs to, same convention as
   * Duel's PlayerSnapshot — used for input reconciliation. */
  lastProcessedSeq: number;
}

// --- Messages ---

export type ImpostorClientMessage =
  | { type: "imp_create_room"; name: string; color: number }
  | { type: "imp_join_room"; code: string; name: string; color: number }
  /** Host-only; ignored server-side if the sender isn't the host or the
   * room isn't in the lobby phase. */
  | { type: "imp_set_config"; minPlayers: number; maxPlayers: number; imposterCount: number }
  | { type: "set_ready"; ready: boolean }
  | { type: "leave_room" }
  | { type: "ping"; t: number }
  | { type: "rejoin_room"; code: string; token: string }
  | ClientInputMessage;

export type ImpostorServerMessage =
  | { type: "imp_room_created"; code: string; selfId: PlayerId; reconnectToken: string }
  | { type: "imp_room_joined"; code: string; selfId: PlayerId; reconnectToken: string }
  | { type: "imp_room_error"; message: string }
  | { type: "rejoin_failed"; message: string }
  | { type: "imp_player_connection"; id: PlayerId; connected: boolean; graceMs?: number }
  | {
      type: "imp_lobby_update";
      phase: ImpostorPhase;
      players: ImpostorPlayerSummary[];
      config: ImpostorRoomConfig;
      hostId: PlayerId | null;
    }
  | { type: "imp_match_countdown"; startsAtServerTime: number }
  | { type: "imp_match_started"; serverTime: number; mapId: string }
  /** Sent privately to each player at match start. fellowImposters is empty
   * for crewmates (they must learn nothing) and, for imposters, lists the
   * OTHER imposters' ids so their client can identify them. */
  | { type: "imp_role_assigned"; role: ImpostorRole; fellowImposters: PlayerId[] }
  | { type: "imp_snapshot"; tick: number; serverTime: number; players: ImpostorPlayerSnapshot[] }
  | { type: "imp_player_left"; id: PlayerId }
  | { type: "pong"; t: number; serverTime: number };
