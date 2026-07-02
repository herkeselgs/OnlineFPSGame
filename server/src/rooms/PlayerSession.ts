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
import { WebSocket } from "ws";

export interface PlayerSession {
  id: PlayerId;
  ws: WebSocket;
  name: string;
  ready: boolean;
  connected: boolean;

  physics: PlayerPhysicsState;
  yaw: number;
  pitch: number;

  combat: PlayerCombatState;
  weapon: WeaponState;
  respawnAtMs: number;

  inputQueue: ClientInputMessage[];
  lastProcessedSeq: number;
  lastRttMs: number;

  /** Position history for lag-compensated hit validation against this
   * player when they're the TARGET of someone else's shot. */
  history: PositionHistory;
}

export function createPlayerSession(id: PlayerId, ws: WebSocket, name: string): PlayerSession {
  return {
    id,
    ws,
    name,
    ready: false,
    connected: true,
    physics: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: false },
    yaw: 0,
    pitch: 0,
    combat: createPlayerCombatState(),
    weapon: new WeaponState(),
    respawnAtMs: 0,
    inputQueue: [],
    lastProcessedSeq: 0,
    lastRttMs: 0,
    history: new PositionHistory(LAG_COMP_HISTORY_MS),
  };
}
