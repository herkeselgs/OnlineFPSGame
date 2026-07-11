import { Vec3 } from "./vec.js";
import { WeaponId } from "./weapons.js";

export type PlayerId = string;

/** Sent once per fixed physics tick the client simulates (~60/s under a
 * healthy frame rate, fewer under load — the server just processes whatever
 * arrives). Movement AND fire/reload/switch requests all ride the same
 * ordered stream so the server applies them in exactly the sequence the
 * client intended, tick by tick. */
export interface ClientInputMessage {
  type: "input";
  seq: number;
  forward: number;
  right: number;
  jump: boolean;
  yaw: number;
  pitch: number;
  dt: number;
  fire: boolean;
  reload: boolean;
  switchTo?: WeaponId;
  /** World-space ray direction(s) for this tick's shot, one per pellet.
   * Client-computed (including spread) and server-trusted for direction —
   * the server validates WHETHER a shot was allowed (ammo/cooldown) and
   * WHAT it hit, not the exact spread pattern. Manipulating spread nets a
   * cheater basically nothing since range/damage/rate are still enforced. */
  fireDirections?: Vec3[];
  /** Client's current round-trip-time estimate (ms), refreshed via
   * ping/pong. Rides along on every input so the server always has a fresh
   * number to rewind lag-compensated hit checks by, without a separate
   * request/response just for that. */
  rttMs: number;
}

export type ClientMessage =
  | { type: "create_room"; name: string; color: number }
  | { type: "join_room"; code: string; name: string; color: number }
  /** Reattaches to a session the sender previously held in this room —
   * sent automatically after an unexpected socket drop (see NetClient's
   * auto-reconnect), not something the UI exposes directly. */
  | { type: "rejoin_room"; code: string; token: string }
  | { type: "leave_room" }
  | { type: "set_ready"; ready: boolean }
  | { type: "set_map"; mapId: string }
  | { type: "ping"; t: number }
  | ClientInputMessage;

export interface RoomPlayerSummary {
  id: PlayerId;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
  kills: number;
  deaths: number;
}

export interface PlayerSnapshot {
  id: PlayerId;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  health: number;
  alive: boolean;
  spawnProtectedUntil: number;
  weapon: WeaponId;
  ammo: number;
  reloading: boolean;
  color: number;
  kills: number;
  deaths: number;
  /** Only meaningful to the player it belongs to — everyone else's entry is
   * ignored by every client except that one player, who uses it to discard
   * confirmed inputs and replay the rest during reconciliation. */
  lastProcessedSeq: number;
}

export interface MatchScoreEntry {
  id: PlayerId;
  name: string;
  kills: number;
  deaths: number;
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
}

export type MatchPhase = "lobby" | "countdown" | "active" | "ended";

export type ServerMessage =
  | { type: "room_created"; code: string; selfId: PlayerId; reconnectToken: string }
  | { type: "room_joined"; code: string; selfId: PlayerId; mapId: string; reconnectToken: string }
  | { type: "room_error"; message: string }
  | { type: "rejoin_failed"; message: string }
  /** A player's socket connection state changed. `graceMs` is only present
   * when connected=false, and tells the UI how long the other player has
   * to reconnect before the match is scored a forfeit. */
  | { type: "opponent_connection"; id: PlayerId; connected: boolean; graceMs?: number }
  | { type: "lobby_update"; phase: MatchPhase; players: RoomPlayerSummary[]; mapId: string }
  | { type: "match_countdown"; startsAtServerTime: number }
  | { type: "match_started"; serverTime: number; mapId: string; durationMs: number }
  | {
      type: "snapshot";
      tick: number;
      serverTime: number;
      players: PlayerSnapshot[];
    }
  | { type: "hit_confirmed"; targetId: PlayerId; damage: number; killed: boolean; headshot: boolean }
  /** Sent only to the player who got hit — the shooter's position at the
   * moment of the shot, so the victim's client can point a directional
   * indicator back at them. The generic full-screen damage flash alone
   * gives no positional information. */
  | { type: "damage_taken"; attackerPosition: Vec3 }
  | { type: "kill_feed"; killerId: PlayerId | null; victimId: PlayerId; weapon: WeaponId; headshot: boolean }
  | {
      type: "match_ended";
      scores: MatchScoreEntry[];
      winnerId: PlayerId | null;
    }
  | { type: "player_left"; id: PlayerId }
  | { type: "pong"; t: number; serverTime: number };
