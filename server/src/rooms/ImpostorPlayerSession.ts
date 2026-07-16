import {
  ClientInputMessage,
  EMERGENCY_MEETINGS_PER_PLAYER,
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
 * PlayerSession — no combat/weapon fields, since this mode has no kill
 * mechanic yet (M4). Movement/connection fields mirror PlayerSession
 * exactly since that plumbing (physics stepping, reconnect, lag-comp
 * history for future hit validation) is identical.
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

  /** This crewmate's own checklist for the round — a subset of the map's
   * TASK_STATIONS, assigned at match start. Empty for imposters. Completing
   * a station only affects this player's own completedTaskIds, never
   * anyone else's — see ImpostorRoom's file comment on the per-player
   * (not shared-pool) task model. */
  assignedTaskIds: string[];
  completedTaskIds: Set<string>;

  emergencyMeetingsRemaining: number;
  /** Set once this player is voted out. Ejected players are excluded from
   * win-condition headcounts and further meetings/tasks, and their
   * movement input stops being processed, but they stay connected as a
   * spectator rather than being removed from the room outright. */
  ejected: boolean;
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
    assignedTaskIds: [],
    completedTaskIds: new Set(),
    emergencyMeetingsRemaining: EMERGENCY_MEETINGS_PER_PLAYER,
    ejected: false,
  };
}
