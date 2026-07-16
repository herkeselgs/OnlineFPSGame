import { SequenceKey, TaskStationDef, TaskStationState } from "./impostorTasks.js";
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
  /** Press/release of the interact key near a station. For "hold" stations
   * this directly drives progress (see imp_task_progress). For "sequence"
   * stations, holding:true is "start an attempt" — release has no meaning
   * there and is ignored server-side. Server-validated: ignored unless the
   * sender is a crewmate, in range, and the station isn't already done. */
  | { type: "imp_task_hold"; stationId: string; holding: boolean }
  /** One keypress during an active sequence attempt at stationId. */
  | { type: "imp_task_key"; stationId: string; key: string }
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
  /** Sent once at match start — station locations/kinds are visible to
   * everyone (imposters included, same as task icons being visible in
   * Among Us), only the ability to interact is crewmate-only. */
  | { type: "imp_task_stations"; stations: TaskStationDef[] }
  /** Broadcast whenever any station's completed flag changes; carries the
   * full list rather than a diff since it's at most a handful of entries. */
  | { type: "imp_task_progress"; stations: TaskStationState[] }
  /** Sent privately to the player who just began a sequence attempt. */
  | { type: "imp_task_sequence"; stationId: string; sequence: SequenceKey[] }
  /** Sent privately after each keypress during a sequence attempt —
   * correctCount is how many of the sequence's keys have been correctly
   * pressed in a row so far (reset to 0 on a wrong key, not an instant
   * fail — these are meant to be quick, low-stakes interactions). */
  | { type: "imp_task_sequence_progress"; stationId: string; correctCount: number }
  /** Sent privately if an in-progress sequence attempt is cancelled
   * (walked out of range, station completed by someone else meanwhile). */
  | { type: "imp_task_sequence_cancelled"; stationId: string }
  | { type: "imp_match_ended"; reason: "tasks_complete" }
  | { type: "imp_player_left"; id: PlayerId }
  | { type: "pong"; t: number; serverTime: number };
