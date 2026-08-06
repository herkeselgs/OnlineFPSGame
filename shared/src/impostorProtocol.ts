import { SequenceKey, TaskStationDef } from "./impostorTasks.js";
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
 * active: free-roam, tasks running. meeting: everyone frozen for
 * discussion/voting. Kills (M4) don't add a phase of their own — they just
 * happen during "active", same as a task does. */
export type ImpostorPhase = "lobby" | "countdown" | "active" | "meeting";

// --- Meetings / voting ---

export const EMERGENCY_MEETINGS_PER_PLAYER = 1;
export const MEETING_DISCUSSION_MS = 15000;
export const MEETING_VOTING_MS = 20000;
export const MEETING_RESULT_DISPLAY_MS = 6000;

/** discussion: free talk (voice/text happens outside this app), no votes
 * accepted yet. voting: votes accepted, switches the moment discussion's
 * timer elapses. */
export type MeetingSubPhase = "discussion" | "voting";

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
  crouching: boolean;
  color: number;
  /** Purely a visual attribute — true for imposters, false for crewmates,
   * fixed for the round. This IS the "carries a visible gun" tell from the
   * design brief: any player who happens to be looking at this player's
   * model can notice the weapon and deduce their role, the same as it
   * would look in the game world. Deliberately not called "isImposter" —
   * what's sent over the wire is a rendering fact (does this player model
   * hold a gun), not a role label; the inference is the player's to make,
   * same as it would be in the actual 3D scene. */
  hasWeapon: boolean;
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
   * this directly drives progress. For "sequence" stations, holding:true is
   * "start an attempt" — release has no meaning there and is ignored
   * server-side. Server-validated: ignored unless the sender is a crewmate,
   * the station is on THEIR assigned checklist, they're in range, and they
   * haven't already completed it. */
  | { type: "imp_task_hold"; stationId: string; holding: boolean }
  /** One keypress during an active sequence attempt at stationId. */
  | { type: "imp_task_key"; stationId: string; key: string }
  /** Crewmate-only, limited uses per match (see EMERGENCY_MEETINGS_PER_PLAYER)
   * — ignored server-side otherwise. */
  | { type: "imp_call_meeting" }
  /** target is a PlayerId to vote for ejecting, or "skip". Sent during the
   * voting sub-phase; a player may resend to change their vote before
   * voting ends. */
  | { type: "imp_cast_vote"; target: PlayerId | "skip" }
  /** Imposter-only, crewmate targets only, range/cooldown/alive all
   * re-validated server-side regardless of what the client thinks it can
   * see — ignored otherwise. */
  | { type: "imp_kill"; targetId: PlayerId }
  /** Crewmate-only; ignored unless the sender is actually near an
   * unreported body with this id. */
  | { type: "imp_report_body"; bodyId: string }
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
  /** Sent privately to each crewmate at match start: which stations (out of
   * the full list above) are THEIRS to complete this round. Imposters get
   * an empty list. */
  | { type: "imp_task_assignment"; assignedIds: string[] }
  /** Sent privately, only to the player it belongs to, whenever THEIR own
   * completed set changes — this is personal progress, not a shared
   * world-state flag, so unlike M2's version it's never broadcast. */
  | { type: "imp_task_progress"; completedIds: string[] }
  /** Broadcast crew-wide whenever anyone completes a task, so everyone can
   * see overall pace ("12/20 tasks done") without seeing who's doing what. */
  | { type: "imp_task_aggregate_progress"; completed: number; total: number }
  /** Sent privately to the player who just began a sequence attempt. */
  | { type: "imp_task_sequence"; stationId: string; sequence: SequenceKey[] }
  /** Sent privately after each keypress during a sequence attempt —
   * correctCount is how many of the sequence's keys have been correctly
   * pressed in a row so far (reset to 0 on a wrong key, not an instant
   * fail — these are meant to be quick, low-stakes interactions). */
  | { type: "imp_task_sequence_progress"; stationId: string; correctCount: number }
  /** Sent privately if an in-progress sequence attempt is cancelled
   * (walked out of range, a meeting started). */
  | { type: "imp_task_sequence_cancelled"; stationId: string }
  /** Sent privately to every crewmate at match start and again after they
   * personally call a meeting, so their client knows whether to show the
   * button as available. */
  | { type: "imp_meeting_count"; remaining: number }
  /** "emergency": a living player pressed the call-meeting button, calledBy
   * is who and victimId is absent. "body_report": calledBy found and
   * reported victimId's body — the client shows "X found Y's body" instead
   * of "X called an emergency meeting" for this one. Either way the
   * discussion/voting/result flow after this is identical. */
  | {
      type: "imp_meeting_started";
      reason: "emergency" | "body_report";
      calledBy: PlayerId;
      victimId?: PlayerId;
      discussionEndsAt: number;
    }
  | { type: "imp_meeting_voting"; votingEndsAt: number }
  /** voteCounts keys are PlayerIds; skipCount is separate since "skip" isn't
   * a PlayerId. ejectedId/ejectedRole are both null on a tie or a skip
   * majority — no one goes home. */
  | {
      type: "imp_meeting_result";
      ejectedId: PlayerId | null;
      ejectedRole: ImpostorRole | null;
      voteCounts: Record<string, number>;
      skipCount: number;
    }
  | {
      type: "imp_match_ended";
      reason: "tasks_complete" | "imposters_ejected" | "imposters_win_by_numbers";
    }
  /** Broadcast to everyone in range — deliberately doesn't say who fired
   * or who (if anyone) was hit, just where the sound came from. Clients
   * compute their own distance/direction from `position` and decide
   * locally whether it's close enough to hear at all; this is the mode's
   * core risk mechanic (see GUNSHOT_AUDIBLE_RANGE_M) and has nothing to do
   * with who's near enough to actually witness the kill. */
  | { type: "imp_gunshot"; position: Vec3 }
  /** Sent privately, only to the player who was killed. */
  | { type: "imp_you_were_killed" }
  /** Sent privately to the imposter after a successful kill (and once at
   * match start) so their client knows when the cooldown clears. */
  | { type: "imp_kill_cooldown"; readyAt: number }
  /** Broadcast when a kill happens — a body is a discoverable world object,
   * not an announcement of who died; nothing here reaches players who
   * aren't already looking at this location, unlike imp_gunshot. */
  | { type: "imp_body_spawned"; bodyId: string; victimId: PlayerId; position: Vec3 }
  /** Broadcast once a body's been reported (starting a meeting) so every
   * client removes its marker. */
  | { type: "imp_body_removed"; bodyId: string }
  /** The room resumed "active" after a meeting resolved without ending the
   * match — the client-side signal to stop showing the meeting screen and
   * resume normal play. */
  | { type: "imp_meeting_ended" }
  | { type: "imp_player_left"; id: PlayerId }
  | { type: "pong"; t: number; serverTime: number };
