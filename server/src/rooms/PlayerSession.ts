import {
  ClientInputMessage,
  createPlayerCombatState,
  PlayerCombatState,
  PlayerId,
  PlayerPhysicsState,
  PositionHistory,
  LAG_COMP_HISTORY_MS,
  WeaponState,
} from "@fps/shared";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export interface PlayerSession {
  id: PlayerId;
  ws: WebSocket;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
  /** Opaque credential the client persists (sessionStorage) so a dropped
   * socket can reattach to this exact session instead of joining as a new
   * player — see Room.rejoin(). Never sent to the other player. */
  reconnectToken: string;

  physics: PlayerPhysicsState;
  yaw: number;
  pitch: number;

  combat: PlayerCombatState;
  weapon: WeaponState;
  respawnAtMs: number;

  /** Lifetime-of-match stats for the post-match results screen (accuracy,
   * damage dealt) — reset at the start of each match alongside combat. */
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;

  inputQueue: ClientInputMessage[];
  lastProcessedSeq: number;
  lastRttMs: number;

  /** Position history for lag-compensated hit validation against this
   * player when they're the TARGET of someone else's shot. */
  history: PositionHistory;
}

export function createPlayerSession(id: PlayerId, ws: WebSocket, name: string, color: number): PlayerSession {
  return {
    id,
    ws,
    name,
    color,
    ready: false,
    connected: true,
    reconnectToken: randomUUID(),
    physics: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: false },
    yaw: 0,
    pitch: 0,
    combat: createPlayerCombatState(),
    weapon: new WeaponState(),
    respawnAtMs: 0,
    shotsFired: 0,
    shotsHit: 0,
    damageDealt: 0,
    inputQueue: [],
    lastProcessedSeq: 0,
    lastRttMs: 0,
    history: new PositionHistory(LAG_COMP_HISTORY_MS),
  };
}
