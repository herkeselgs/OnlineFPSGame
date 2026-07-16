import {
  BoxCollider,
  ImpostorPlayerSnapshot,
  ImpostorRole,
  ImpostorServerMessage,
  INTERP_DELAY_MS,
  PlayerId,
  SequenceKey,
  SpawnPoint,
  TaskStationDef,
} from "@fps/shared";
import * as THREE from "three";
import { ClockSync } from "../net/ClockSync";
import { InputManager } from "../engine/InputManager";
import { NetClient } from "../net/NetClient";
import { ImpostorPredictionController } from "./ImpostorPredictionController";
import { ImpostorRemotePlayer } from "./ImpostorRemotePlayer";
import { ImpostorTaskHud } from "./ImpostorTaskHud";

const PING_INTERVAL_MS = 2000;
const INTERACT_KEY = "KeyE";
const STATION_MARKER_COLOR = 0xf2c14e;
const STATION_MARKER_DONE_COLOR = 0x4caf6a;

/**
 * Sibling to Duel's MatchController. Milestone 1 covered local movement
 * prediction + interpolated remote players + role reveal; this milestone
 * (2) layers task interaction on top of that same controller — proximity
 * detection, hold/sequence task messages, station markers in the world, and
 * the crewmate all-tasks-complete win condition. Still no meetings or the
 * imposter kill mechanic (M3/M4).
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
  private onMatchEnded: () => void;

  private input: InputManager;
  private taskHud: ImpostorTaskHud;
  private stations: TaskStationDef[] = [];
  private completedStationIds = new Set<string>();
  private stationMarkers = new Map<string, THREE.Mesh>();

  // Local (client-only) interact-key edge tracking — InputManager only
  // exposes edge-triggered "just pressed" for one-shot actions and raw
  // isKeyDown for continuous state; a hold task needs to know the PRESS and
  // RELEASE edges itself so it sends exactly one imp_task_hold per
  // transition, not one every frame (which would keep resetting the
  // server's hold timer — see ImpostorRoom.handleTaskHold).
  private wasHoldingInteract = false;
  private holdingStationId: string | null = null;
  private holdStartedAtLocal = 0;

  private activeSequenceStationId: string | null = null;
  private activeSequenceKeys: SequenceKey[] = [];
  private activeSequenceProgress = 0;
  private static readonly SEQUENCE_KEY_CODES = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"] as const;

  constructor(
    private scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    input: InputManager,
    private net: NetClient,
    private selfId: PlayerId,
    playerNames: Map<PlayerId, string>,
    taskHud: ImpostorTaskHud,
    spawn: SpawnPoint,
    colliders: readonly BoxCollider[],
    ladders: readonly BoxCollider[],
    onRoleAssigned: (role: ImpostorRole, fellowImposterNames: string[]) => void,
    onMatchEnded: () => void
  ) {
    this.playerNames = playerNames;
    this.input = input;
    this.taskHud = taskHud;
    this.onRoleAssigned = onRoleAssigned;
    this.onMatchEnded = onMatchEnded;
    this.prediction = new ImpostorPredictionController(spawn, colliders, input, net, camera, ladders);

    this.unsubscribe = net.onMessage((msg) => this.handleMessage(msg as ImpostorServerMessage));
    this.pingTimer = setInterval(() => net.send({ type: "ping", t: Date.now() }), PING_INTERVAL_MS);
    net.send({ type: "ping", t: Date.now() });
    this.taskHud.show();
  }

  update(frameDt: number): void {
    this.prediction.update(frameDt);

    const renderTime = this.clock.estimateServerTime() - INTERP_DELAY_MS;
    for (const rp of this.remotePlayersMap.values()) rp.update(renderTime);

    if (this.role === "crewmate") this.updateTaskInteraction();
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
    for (const marker of this.stationMarkers.values()) this.disposeMarker(marker);
    this.stationMarkers.clear();
    this.taskHud.hide();
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
      case "imp_task_stations":
        this.stations = msg.stations;
        this.taskHud.setStations(msg.stations);
        this.buildStationMarkers();
        break;
      case "imp_task_progress":
        this.completedStationIds = new Set(msg.stations.filter((s) => s.completed).map((s) => s.id));
        this.taskHud.setProgress(msg.stations);
        this.refreshMarkerColors();
        break;
      case "imp_task_sequence":
        this.activeSequenceStationId = msg.stationId;
        this.activeSequenceKeys = msg.sequence;
        this.activeSequenceProgress = 0;
        break;
      case "imp_task_sequence_progress":
        if (this.activeSequenceStationId === msg.stationId) this.activeSequenceProgress = msg.correctCount;
        break;
      case "imp_task_sequence_cancelled":
        if (this.activeSequenceStationId === msg.stationId) this.clearActiveSequence();
        break;
      case "imp_match_ended":
        this.onMatchEnded();
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

  private buildStationMarkers(): void {
    for (const marker of this.stationMarkers.values()) this.disposeMarker(marker);
    this.stationMarkers.clear();
    for (const station of this.stations) {
      const geometry = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 10);
      const material = new THREE.MeshLambertMaterial({ color: STATION_MARKER_COLOR });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(station.position.x, station.position.y, station.position.z);
      this.scene.add(mesh);
      this.stationMarkers.set(station.id, mesh);
    }
    this.refreshMarkerColors();
  }

  private refreshMarkerColors(): void {
    for (const [id, mesh] of this.stationMarkers) {
      const material = mesh.material as THREE.MeshLambertMaterial;
      material.color.setHex(this.completedStationIds.has(id) ? STATION_MARKER_DONE_COLOR : STATION_MARKER_COLOR);
    }
  }

  private disposeMarker(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  /** Proximity-based UI + interact-key handling. All server-facing sends
   * here are requests, not authoritative state — ImpostorRoom independently
   * validates range, role, and station kind before acting on any of them. */
  private updateTaskInteraction(): void {
    if (this.activeSequenceStationId) {
      this.updateActiveSequence();
      return;
    }

    const nearest = this.findNearestIncompleteStation();
    const holdingKeyNow = this.input.isKeyDown(INTERACT_KEY);
    const pressedEdge = holdingKeyNow && !this.wasHoldingInteract;
    const releasedEdge = !holdingKeyNow && this.wasHoldingInteract;
    this.wasHoldingInteract = holdingKeyNow;

    if (!nearest) {
      this.taskHud.hidePrompt();
      if (this.holdingStationId) this.releaseHold();
      return;
    }

    if (nearest.kind === "hold") {
      if (pressedEdge) {
        this.holdingStationId = nearest.id;
        this.holdStartedAtLocal = Date.now();
        this.net.send({ type: "imp_task_hold", stationId: nearest.id, holding: true });
      } else if (releasedEdge && this.holdingStationId === nearest.id) {
        this.releaseHold();
      }

      if (this.holdingStationId === nearest.id) {
        const progress = (Date.now() - this.holdStartedAtLocal) / nearest.holdDurationMs;
        this.taskHud.showHoldPrompt(nearest.name, progress);
      } else {
        this.taskHud.showHoldPrompt(nearest.name, 0);
      }
    } else {
      if (this.holdingStationId) this.releaseHold();
      if (pressedEdge) {
        this.net.send({ type: "imp_task_hold", stationId: nearest.id, holding: true });
      }
      this.taskHud.showStartPrompt(nearest.name);
    }
  }

  private updateActiveSequence(): void {
    const stationId = this.activeSequenceStationId;
    if (!stationId) return;
    const station = this.stations.find((s) => s.id === stationId);
    for (const key of ImpostorMatchController.SEQUENCE_KEY_CODES) {
      if (this.input.consumeJustPressed(key)) {
        this.net.send({ type: "imp_task_key", stationId, key });
      }
    }
    this.taskHud.showSequence(station?.name ?? "", this.activeSequenceKeys, this.activeSequenceProgress);
  }

  private clearActiveSequence(): void {
    this.activeSequenceStationId = null;
    this.activeSequenceKeys = [];
    this.activeSequenceProgress = 0;
    this.taskHud.hidePrompt();
  }

  private releaseHold(): void {
    if (this.holdingStationId) {
      this.net.send({ type: "imp_task_hold", stationId: this.holdingStationId, holding: false });
    }
    this.holdingStationId = null;
  }

  private findNearestIncompleteStation(): TaskStationDef | null {
    const pos = this.prediction.physics.position;
    let best: TaskStationDef | null = null;
    let bestDist = Infinity;
    for (const station of this.stations) {
      if (this.completedStationIds.has(station.id)) continue;
      const dx = pos.x - station.position.x;
      const dz = pos.z - station.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist <= station.radius && dist < bestDist) {
        best = station;
        bestDist = dist;
      }
    }
    return best;
  }
}
