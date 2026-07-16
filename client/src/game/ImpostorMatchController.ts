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
const STATION_MARKER_ASSIGNED_COLOR = 0xf2c14e;
const STATION_MARKER_DONE_COLOR = 0x4caf6a;
const STATION_MARKER_UNASSIGNED_COLOR = 0x5a6b78;

export interface ImpostorMatchCallbacks {
  onRoleAssigned(role: ImpostorRole, fellowImposterNames: string[]): void;
  onMatchEnded(reason: "tasks_complete" | "imposters_ejected" | "imposters_win_by_numbers"): void;
  onMeetingStarted(calledByName: string, discussionEndsAt: number): void;
  onMeetingVoting(votingEndsAt: number): void;
  onMeetingResult(
    ejectedId: PlayerId | null,
    ejectedName: string | null,
    ejectedRole: ImpostorRole | null,
    wasSelf: boolean,
    voteCounts: Record<string, number>,
    skipCount: number
  ): void;
  onMeetingEnded(): void;
}

/**
 * Sibling to Duel's MatchController. M1 covered movement prediction + role
 * reveal, M2 added the task system; this milestone (3) adds emergency
 * meetings — proximity/task interaction all freezes the moment a meeting
 * starts (no local prediction stepping, no task messages sent) exactly like
 * the server independently freezes processing for everyone, so the two
 * never disagree about whether the round is "live" right now.
 */
export class ImpostorMatchController {
  readonly prediction: ImpostorPredictionController;

  private remotePlayersMap = new Map<PlayerId, ImpostorRemotePlayer>();
  private playerNames: Map<PlayerId, string>;
  private clock = new ClockSync();
  private unsubscribe: () => void;
  private pingTimer: ReturnType<typeof setInterval>;
  private role: ImpostorRole | null = null;
  private callbacks: ImpostorMatchCallbacks;

  private input: InputManager;
  private taskHud: ImpostorTaskHud;
  private stations: TaskStationDef[] = [];
  private assignedTaskIds = new Set<string>();
  private completedTaskIds = new Set<string>();
  private stationMarkers = new Map<string, THREE.Mesh>();
  private meetingsRemaining = 0;

  /** True from imp_meeting_started until imp_meeting_ended (or the match
   * ends) — gates both local movement prediction and task interaction, the
   * client-side mirror of the server dropping input/task messages during a
   * meeting. */
  private frozen = false;

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
    callbacks: ImpostorMatchCallbacks
  ) {
    this.playerNames = playerNames;
    this.input = input;
    this.taskHud = taskHud;
    this.callbacks = callbacks;
    this.prediction = new ImpostorPredictionController(spawn, colliders, input, net, camera, ladders);

    this.unsubscribe = net.onMessage((msg) => this.handleMessage(msg as ImpostorServerMessage));
    this.pingTimer = setInterval(() => net.send({ type: "ping", t: Date.now() }), PING_INTERVAL_MS);
    net.send({ type: "ping", t: Date.now() });
    this.taskHud.show();
  }

  update(frameDt: number): void {
    if (!this.frozen) {
      this.prediction.update(frameDt);
      if (this.role === "crewmate") this.updateTaskInteraction();
    }

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

  castVote(target: PlayerId | "skip"): void {
    this.net.send({ type: "imp_cast_vote", target });
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
        this.callbacks.onRoleAssigned(
          msg.role,
          msg.fellowImposters.map((id) => this.playerNames.get(id) ?? "Player")
        );
        break;
      case "imp_task_stations":
        this.stations = msg.stations;
        this.taskHud.setStations(msg.stations);
        this.buildStationMarkers();
        break;
      case "imp_task_assignment":
        this.assignedTaskIds = new Set(msg.assignedIds);
        this.taskHud.setAssignment(msg.assignedIds);
        this.refreshMarkerColors();
        break;
      case "imp_task_progress":
        this.completedTaskIds = new Set(msg.completedIds);
        this.taskHud.setProgress(msg.completedIds);
        this.refreshMarkerColors();
        // A sequence task's final (correct) keypress completes it directly
        // server-side (ImpostorRoom.handleTaskKey) without ever sending a
        // dedicated "sequence over" message — this progress update is the
        // only signal that arrives. Without clearing activeSequenceStationId
        // here, updateTaskInteraction's very first check keeps matching this
        // now-finished station forever, permanently blocking it from ever
        // looking for the player's next task.
        if (this.activeSequenceStationId && this.completedTaskIds.has(this.activeSequenceStationId)) {
          this.clearActiveSequence();
        }
        break;
      case "imp_task_aggregate_progress":
        this.taskHud.setAggregateProgress(msg.completed, msg.total);
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
      case "imp_meeting_count":
        this.meetingsRemaining = msg.remaining;
        if (this.role === "crewmate" && !this.frozen) this.taskHud.showMeetingButton(msg.remaining);
        break;
      case "imp_meeting_started":
        this.frozen = true;
        this.taskHud.hidePrompt();
        this.taskHud.hideMeetingButton();
        this.clearActiveSequence();
        this.releaseHoldLocally();
        this.callbacks.onMeetingStarted(this.playerNames.get(msg.calledBy) ?? "Someone", msg.discussionEndsAt);
        break;
      case "imp_meeting_voting":
        this.callbacks.onMeetingVoting(msg.votingEndsAt);
        break;
      case "imp_meeting_result": {
        const ejectedName = msg.ejectedId ? this.playerNames.get(msg.ejectedId) ?? "Player" : null;
        const wasSelf = msg.ejectedId === this.selfId;
        if (msg.ejectedId) this.removeRemotePlayer(msg.ejectedId);
        this.callbacks.onMeetingResult(msg.ejectedId, ejectedName, msg.ejectedRole, wasSelf, msg.voteCounts, msg.skipCount);
        break;
      }
      case "imp_meeting_ended":
        this.frozen = false;
        if (this.role === "crewmate") this.taskHud.showMeetingButton(this.meetingsRemaining);
        this.callbacks.onMeetingEnded();
        break;
      case "imp_match_ended":
        this.callbacks.onMatchEnded(msg.reason);
        break;
      default:
        break;
    }
  }

  private ingestSnapshot(serverTimeMs: number, players: ImpostorPlayerSnapshot[]): void {
    const seenIds = new Set<PlayerId>([this.selfId]);
    for (const p of players) {
      seenIds.add(p.id);
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
    // Ejected players stop appearing in snapshots entirely (see
    // ImpostorRoom.broadcastSnapshot) — imp_meeting_result already disposes
    // them explicitly the moment they're ejected, but this is a defensive
    // backstop for anyone who somehow still has a stale entry.
    for (const id of [...this.remotePlayersMap.keys()]) {
      if (!seenIds.has(id)) this.removeRemotePlayer(id);
    }
  }

  private removeRemotePlayer(id: PlayerId): void {
    const rp = this.remotePlayersMap.get(id);
    if (!rp) return;
    rp.dispose(this.scene);
    this.remotePlayersMap.delete(id);
  }

  private buildStationMarkers(): void {
    for (const marker of this.stationMarkers.values()) this.disposeMarker(marker);
    this.stationMarkers.clear();
    for (const station of this.stations) {
      const geometry = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 10);
      const material = new THREE.MeshLambertMaterial({ color: STATION_MARKER_UNASSIGNED_COLOR });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(station.position.x, station.position.y, station.position.z);
      this.scene.add(mesh);
      this.stationMarkers.set(station.id, mesh);
    }
    this.refreshMarkerColors();
  }

  /** Colored by THIS player's own relationship to each station — done,
   * assigned-and-pending, or not on their checklist at all. Completion is
   * per-player now (see ImpostorRoom's file comment), so a station can't
   * meaningfully be "done" from a shared/global point of view anymore. */
  private refreshMarkerColors(): void {
    for (const [id, mesh] of this.stationMarkers) {
      const material = mesh.material as THREE.MeshLambertMaterial;
      const color = this.completedTaskIds.has(id)
        ? STATION_MARKER_DONE_COLOR
        : this.assignedTaskIds.has(id)
        ? STATION_MARKER_ASSIGNED_COLOR
        : STATION_MARKER_UNASSIGNED_COLOR;
      material.color.setHex(color);
    }
  }

  private disposeMarker(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  /** Proximity-based UI + interact-key handling. All server-facing sends
   * here are requests, not authoritative state — ImpostorRoom independently
   * validates range, role, assignment, and station kind before acting on
   * any of them. */
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
  }

  private releaseHold(): void {
    if (this.holdingStationId) {
      this.net.send({ type: "imp_task_hold", stationId: this.holdingStationId, holding: false });
    }
    this.holdingStationId = null;
  }

  /** Like releaseHold, but for when a meeting yanks control away — no
   * point telling the server "released" for a hold it already dropped the
   * instant the meeting started, just clear the local tracking. */
  private releaseHoldLocally(): void {
    this.holdingStationId = null;
  }

  private findNearestIncompleteStation(): TaskStationDef | null {
    const pos = this.prediction.physics.position;
    let best: TaskStationDef | null = null;
    let bestDist = Infinity;
    for (const station of this.stations) {
      if (!this.assignedTaskIds.has(station.id) || this.completedTaskIds.has(station.id)) continue;
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
