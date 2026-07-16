import {
  BODY_REPORT_RADIUS_M,
  BoxCollider,
  GUNSHOT_AUDIBLE_RANGE_M,
  ImpostorPlayerSnapshot,
  ImpostorRole,
  ImpostorServerMessage,
  INTERP_DELAY_MS,
  KILL_RANGE_M,
  PlayerId,
  SequenceKey,
  SpawnPoint,
  TaskStationDef,
  Vec3,
} from "@fps/shared";
import * as THREE from "three";
import { soundEngine } from "../audio/SoundEngine";
import { ClockSync } from "../net/ClockSync";
import { InputManager } from "../engine/InputManager";
import { NetClient } from "../net/NetClient";
import { ImpostorPredictionController } from "./ImpostorPredictionController";
import { ImpostorRemotePlayer } from "./ImpostorRemotePlayer";
import { ImpostorTaskHud } from "./ImpostorTaskHud";

const PING_INTERVAL_MS = 2000;
const INTERACT_KEY = "KeyE";
const REPORT_KEY = "KeyR";
const STATION_MARKER_ASSIGNED_COLOR = 0xf2c14e;
const STATION_MARKER_DONE_COLOR = 0x4caf6a;
const STATION_MARKER_UNASSIGNED_COLOR = 0x5a6b78;
const BODY_MARKER_COLOR = 0x8a2020;

interface BodyInfo {
  id: string;
  victimId: PlayerId;
  position: Vec3;
}

export interface ImpostorMatchCallbacks {
  onRoleAssigned(role: ImpostorRole, fellowImposterNames: string[]): void;
  onMatchEnded(reason: "tasks_complete" | "imposters_ejected" | "imposters_win_by_numbers"): void;
  onMeetingStarted(
    reason: "emergency" | "body_report",
    calledByName: string,
    victimName: string | null,
    discussionEndsAt: number
  ): void;
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
  onYouWereKilled(): void;
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

  /** Tracks each remote player's current `hasWeapon` flag from snapshots —
   * used by an imposter to skip targeting fellow imposters (see
   * findNearestKillableCrewmate), separate from ImpostorRemotePlayer's own
   * copy (which only drives its weapon mesh's visibility). */
  private remoteHasWeapon = new Map<PlayerId, boolean>();
  private bodies = new Map<string, BodyInfo>();
  private bodyMarkers = new Map<string, THREE.Mesh>();
  /** Imposter-only; mirrors ImpostorRoom's killCooldownReadyAt for this
   * client so the kill prompt/cooldown badge can be shown without waiting
   * on a round trip. 0 until the first imp_kill_cooldown arrives. */
  private killCooldownReadyAt = 0;

  /** True from imp_you_were_killed for the rest of the round — like frozen,
   * but distinct (a killed player never gets "unfrozen"). Gates the same
   * task/kill/report interaction the meeting freeze does, so a just-killed
   * crewmate's own screen doesn't keep showing "Press R — Report Body" for
   * the body that is, in fact, them, underneath the killed overlay. */
  private dead = false;

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
      if (!this.dead) {
        if (this.role === "crewmate") {
          if (!this.updateBodyReportInteraction()) this.updateTaskInteraction();
        } else if (this.role === "imposter") {
          this.updateKillInteraction();
        }
      }
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
    for (const marker of this.bodyMarkers.values()) this.disposeMarker(marker);
    this.bodyMarkers.clear();
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
        this.taskHud.showKillCooldown(null);
        this.clearActiveSequence();
        this.releaseHoldLocally();
        this.callbacks.onMeetingStarted(
          msg.reason,
          this.playerNames.get(msg.calledBy) ?? "Someone",
          msg.victimId ? this.playerNames.get(msg.victimId) ?? "Player" : null,
          msg.discussionEndsAt
        );
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
      case "imp_gunshot":
        this.playGunshotAudio(msg.position);
        break;
      case "imp_you_were_killed":
        this.dead = true;
        this.taskHud.hidePrompt();
        this.taskHud.showKillCooldown(null);
        this.taskHud.hideMeetingButton();
        this.callbacks.onYouWereKilled();
        break;
      case "imp_kill_cooldown":
        this.killCooldownReadyAt = msg.readyAt;
        break;
      case "imp_body_spawned":
        this.bodies.set(msg.bodyId, { id: msg.bodyId, victimId: msg.victimId, position: msg.position });
        this.addBodyMarker(msg.bodyId, msg.position);
        break;
      case "imp_body_removed":
        this.bodies.delete(msg.bodyId);
        this.removeBodyMarker(msg.bodyId);
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
      rp.ingestSnapshot(p.position, p.yaw, serverTimeMs, p.color, p.hasWeapon);
      this.remoteHasWeapon.set(p.id, p.hasWeapon);
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
    this.remoteHasWeapon.delete(id);
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

  // --- Kills (imposter-only) ---

  /** Client-side hint only — ImpostorRoom independently re-validates role,
   * alive/ejected state, range, and cooldown before actually killing anyone,
   * same convention as every other interaction in this class. */
  private updateKillInteraction(): void {
    const cooldownRemainingMs = this.killCooldownReadyAt - Date.now();
    if (cooldownRemainingMs > 0) {
      this.taskHud.hidePrompt();
      this.taskHud.showKillCooldown(cooldownRemainingMs / 1000);
      return;
    }
    this.taskHud.showKillCooldown(null);

    const target = this.findNearestKillableCrewmate();
    if (!target) {
      this.taskHud.hidePrompt();
      return;
    }
    this.taskHud.showKillPrompt(this.playerNames.get(target) ?? "Player");
    if (this.input.consumeJustPressed(INTERACT_KEY)) {
      this.net.send({ type: "imp_kill", targetId: target });
    }
  }

  private findNearestKillableCrewmate(): PlayerId | null {
    const pos = this.prediction.physics.position;
    let best: PlayerId | null = null;
    let bestDist = Infinity;
    for (const [id, rp] of this.remotePlayersMap) {
      if (this.remoteHasWeapon.get(id)) continue; // fellow imposter, not a valid target
      const dx = pos.x - rp.mesh.position.x;
      const dy = pos.y - rp.mesh.position.y;
      const dz = pos.z - rp.mesh.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= KILL_RANGE_M && dist < bestDist) {
        best = id;
        bestDist = dist;
      }
    }
    return best;
  }

  // --- Bodies (crewmate-only) ---

  /** Returns true if a body was in range this frame (and the report prompt
   * is now showing) — the caller uses this to decide whether to fall back
   * to normal task-interaction prompts, since both share the same prompt
   * DOM and a player is only ever shown one at a time. */
  private updateBodyReportInteraction(): boolean {
    const nearest = this.findNearestBody();
    if (!nearest) return false;
    this.taskHud.showReportPrompt();
    if (this.input.consumeJustPressed(REPORT_KEY)) {
      this.net.send({ type: "imp_report_body", bodyId: nearest.id });
    }
    return true;
  }

  private findNearestBody(): BodyInfo | null {
    const pos = this.prediction.physics.position;
    let best: BodyInfo | null = null;
    let bestDist = Infinity;
    for (const body of this.bodies.values()) {
      const dx = pos.x - body.position.x;
      const dy = pos.y - body.position.y;
      const dz = pos.z - body.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= BODY_REPORT_RADIUS_M && dist < bestDist) {
        best = body;
        bestDist = dist;
      }
    }
    return best;
  }

  private addBodyMarker(bodyId: string, position: Vec3): void {
    const geometry = new THREE.BoxGeometry(0.6, 0.3, 1.1);
    const material = new THREE.MeshLambertMaterial({ color: BODY_MARKER_COLOR });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(position.x, position.y, position.z);
    this.scene.add(mesh);
    this.bodyMarkers.set(bodyId, mesh);
  }

  private removeBodyMarker(bodyId: string): void {
    const mesh = this.bodyMarkers.get(bodyId);
    if (!mesh) return;
    this.disposeMarker(mesh);
    this.bodyMarkers.delete(bodyId);
  }

  // --- Gunshot audio ---

  /** Distance/pan are computed here (client-side, from the local player's
   * own predicted position) rather than server-side — the server only ever
   * broadcasts where the shot happened (see imp_gunshot's comment in
   * impostorProtocol.ts), same "each client figures out its own mix"
   * approach real positional audio always uses. */
  private playGunshotAudio(shotPosition: Vec3): void {
    const pos = this.prediction.physics.position;
    const dx = shotPosition.x - pos.x;
    const dy = shotPosition.y - pos.y;
    const dz = shotPosition.z - pos.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > GUNSHOT_AUDIBLE_RANGE_M) return;

    // Same relative-bearing math as MatchController.relativeAngleTo (Duel's
    // damage-direction indicator): positive means "target is to my right"
    // given this engine's yaw convention (decreasing yaw turns you right).
    // sin() of that bearing maps cleanly onto stereo pan — 0 dead ahead/
    // behind, +/-1 hard right/left — without needing full 3D panning.
    let pan = 0;
    const flatLen = Math.hypot(dx, dz);
    if (flatLen > 1e-6) {
      const yawToFaceShot = Math.atan2(-dx / flatLen, -dz / flatLen);
      let relative = ((this.prediction.yaw - yawToFaceShot + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (relative < -Math.PI) relative += Math.PI * 2;
      pan = Math.sin(relative);
    }

    const volumeMul = 1 - dist / GUNSHOT_AUDIBLE_RANGE_M;
    soundEngine.playPositionalGunshot(pan, volumeMul);
  }
}
