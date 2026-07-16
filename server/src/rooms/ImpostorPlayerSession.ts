import {
  ClientInputMessage,
  LAG_COMP_HISTORY_MS,
  PlayerId,
  PlayerPhysicsState,
  PositionHistory,
  SequenceKey,
} from "@fps/shared";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export interface ActiveHold {
  stationId: string;
  startedAt: number;
}

export interface ActiveSequence {
  stationId: string;
  sequence: SequenceKey[];
  progress: number;
}

/**
 * Per-player state for an ImpostorRoom. Deliberately lighter than Duel's
 * PlayerSession — no combat/weapon fields, since this mode has neither yet
 * (M4 adds the imposter kill mechanic). Movement/connection fields mirror
 * PlayerSession exactly since that plumbing (physics stepping, reconnect,
 * lag-comp history for future hit validation) is identical.
 */
export interface ImpostorPlayerSession {
  id: PlayerId;
  ws: WebSocket;
  name: string;
  color: number;
  ready: boolean;
  connected: boolean;
  reconnectToken: string;

  physics: PlayerPhysicsState;
  yaw: number;
  pitch: number;

  inputQueue: ClientInputMessage[];
  lastProcessedSeq: number;
  lastRttMs: number;

  /** Not used for hit validation yet (no combat this milestone), but kept
   * from the start so M4's kill mechanic doesn't need to retrofit history
   * tracking into every session that's already been ticking. */
  history: PositionHistory;

  activeHold: ActiveHold | null;
  activeSequence: ActiveSequence | null;
}

export function createImpostorPlayerSession(id: PlayerId, ws: WebSocket, name: string, color: number): ImpostorPlayerSession {
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
    inputQueue: [],
    lastProcessedSeq: 0,
    lastRttMs: 0,
    history: new PositionHistory(LAG_COMP_HISTORY_MS),
    activeHold: null,
    activeSequence: null,
  };
}
