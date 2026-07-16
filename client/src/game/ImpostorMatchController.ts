import {
  BoxCollider,
  ImpostorPlayerSnapshot,
  ImpostorRole,
  ImpostorServerMessage,
  INTERP_DELAY_MS,
  PlayerId,
  SpawnPoint,
} from "@fps/shared";
import * as THREE from "three";
import { ClockSync } from "../net/ClockSync";
import { InputManager } from "../engine/InputManager";
import { NetClient } from "../net/NetClient";
import { ImpostorPredictionController } from "./ImpostorPredictionController";
import { ImpostorRemotePlayer } from "./ImpostorRemotePlayer";

const PING_INTERVAL_MS = 2000;

/**
 * Sibling to Duel's MatchController, scoped to Milestone 1: local movement
 * prediction + interpolated remote players + role reveal. No tasks,
 * meetings, or kill mechanic yet — those are separate milestones layered on
 * top of this same controller as the mode grows, not a rewrite of it.
 */
export class ImpostorMatchController {
  readonly prediction: ImpostorPredictionController;

  private remotePlayersMap = new Map<PlayerId, ImpostorRemotePlayer>();
  private playerNames: Map<PlayerId, string>;
  private clock = new ClockSync();
  private unsubscribe: () => void;
  private pingTimer: ReturnType<typeof setInterval>;
  private role: ImpostorRole | null = null;
  private onRoleAssigned: (role: ImpostorRole, fellowImposterNames: string[]) => void;

  constructor(
    private scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    input: InputManager,
    private net: NetClient,
    private selfId: PlayerId,
    playerNames: Map<PlayerId, string>,
    spawn: SpawnPoint,
    colliders: readonly BoxCollider[],
    ladders: readonly BoxCollider[],
    onRoleAssigned: (role: ImpostorRole, fellowImposterNames: string[]) => void
  ) {
    this.playerNames = playerNames;
    this.onRoleAssigned = onRoleAssigned;
    this.prediction = new ImpostorPredictionController(spawn, colliders, input, net, camera, ladders);

    this.unsubscribe = net.onMessage((msg) => this.handleMessage(msg as ImpostorServerMessage));
    this.pingTimer = setInterval(() => net.send({ type: "ping", t: Date.now() }), PING_INTERVAL_MS);
    net.send({ type: "ping", t: Date.now() });
  }

  update(frameDt: number): void {
    this.prediction.update(frameDt);

    const renderTime = this.clock.estimateServerTime() - INTERP_DELAY_MS;
    for (const rp of this.remotePlayersMap.values()) rp.update(renderTime);
  }

  getShakeOffset(): { yaw: number; pitch: number; roll: number } {
    return { yaw: 0, pitch: 0, roll: 0 };
  }

  get remotePlayers(): ReadonlyMap<PlayerId, ImpostorRemotePlayer> {
    return this.remotePlayersMap;
  }

  get currentRole(): ImpostorRole | null {
    return this.role;
  }

  dispose(): void {
    this.unsubscribe();
    clearInterval(this.pingTimer);
    for (const rp of this.remotePlayersMap.values()) rp.dispose(this.scene);
    this.remotePlayersMap.clear();
  }

  private handleMessage(msg: ImpostorServerMessage): void {
    switch (msg.type) {
      case "pong":
        this.prediction.setRttEstimate(Math.max(0, Date.now() - msg.t));
        break;
      case "imp_snapshot":
        this.clock.ingestServerTime(msg.serverTime);
        this.ingestSnapshot(msg.serverTime, msg.players);
        break;
      case "imp_match_started":
        this.clock.ingestServerTime(msg.serverTime);
        break;
      case "imp_role_assigned":
        this.role = msg.role;
        this.onRoleAssigned(
          msg.role,
          msg.fellowImposters.map((id) => this.playerNames.get(id) ?? "Player")
        );
        break;
      default:
        break;
    }
  }

  private ingestSnapshot(serverTimeMs: number, players: ImpostorPlayerSnapshot[]): void {
    for (const p of players) {
      if (p.id === this.selfId) {
        this.prediction.applyServerSnapshot(p);
        continue;
      }
      let rp = this.remotePlayersMap.get(p.id);
      if (!rp) {
        rp = new ImpostorRemotePlayer(this.scene, p.id, this.playerNames.get(p.id) ?? "Player");
        this.remotePlayersMap.set(p.id, rp);
      }
      rp.ingestSnapshot(p.position, p.yaw, serverTimeMs, p.color);
    }
  }
}
