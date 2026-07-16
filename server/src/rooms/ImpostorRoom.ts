import {
  defaultImpostorConfig,
  DEFAULT_IMPOSTOR_MAP_ID,
  EMERGENCY_MEETINGS_PER_PLAYER,
  ImpostorClientMessage,
  ImpostorPhase,
  ImpostorPlayerSnapshot,
  ImpostorPlayerSummary,
  ImpostorRole,
  ImpostorRoomConfig,
  ImpostorServerMessage,
  IMPOSTOR_MAPS,
  IMPOSTOR_MAX_PLAYERS,
  IMPOSTOR_MIN_PLAYERS,
  isValidImposterCount,
  MATCH_COUNTDOWN_MS,
  MeetingSubPhase,
  MEETING_DISCUSSION_MS,
  MEETING_RESULT_DISPLAY_MS,
  MEETING_VOTING_MS,
  PlayerId,
  RECONNECT_GRACE_MS,
  RESULTS_DISPLAY_MS,
  SequenceKey,
  SEQUENCE_KEYS,
  SIM_HZ,
  SNAPSHOT_HZ,
  stepPlayerMovement,
  TaskStationDef,
  TASKS_PER_PLAYER,
  TASK_STATIONS,
} from "@fps/shared";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createImpostorPlayerSession, ImpostorPlayerSession } from "./ImpostorPlayerSession.js";

const SNAPSHOT_EVERY_N_TICKS = Math.round(SIM_HZ / SNAPSHOT_HZ);

interface MeetingState {
  calledBy: PlayerId;
  subPhase: MeetingSubPhase;
  discussionEndsAt: number;
  votingEndsAt: number;
  votes: Map<PlayerId, PlayerId | "skip">;
}

/**
 * Sibling to Duel's Room, not a subclass or a generalized merge — the phase
 * machine (lobby -> countdown -> active -> meeting -> active -> ... ->
 * ended) and win conditions are different enough that sharing one class
 * would mean threading mode-conditionals through Duel's already-tested code.
 * Movement/tick/snapshot/reconnect plumbing is intentionally near-identical
 * to Room's (same proven approach, generalized from 2 players to a range),
 * duplicated rather than shared for that same isolation reason.
 *
 * Tasks are tracked per-player, not as a shared one-time pool: each
 * crewmate is dealt their own subset of TASK_STATIONS at match start
 * (assignedTaskIds) and completing one only checks it off THEIR list
 * (completedTaskIds). Two different crewmates can independently do the
 * "same" station. This was a deliberate revision after the first cut
 * (shared-pool, first-come-first-served) turned out to feel broken in
 * practice — finishing a task left nothing else to do the moment the
 * handful of stations got claimed by whoever reached them first.
 */
export class ImpostorRoom {
  readonly code: string;
  phase: ImpostorPhase = "lobby";
  private readonly mapId: string = DEFAULT_IMPOSTOR_MAP_ID;
  private config: ImpostorRoomConfig = defaultImpostorConfig();
  private hostId: PlayerId | null = null;

  private players = new Map<PlayerId, ImpostorPlayerSession>();
  private roles = new Map<PlayerId, ImpostorRole>();
  private countdownEndsAt = 0;
  private tickCount = 0;
  private ticksSinceSnapshot = 0;

  private readonly taskStations: readonly TaskStationDef[] = TASK_STATIONS;
  private meetingState: MeetingState | null = null;

  private pauseStartedAt: number | null = null;
  private disconnectTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();

  constructor(code: string, private onEmpty: () => void) {
    this.code = code;
  }

  get playerCount(): number {
    return this.players.size;
  }

  private get map() {
    return IMPOSTOR_MAPS[this.mapId];
  }

  addPlayer(ws: WebSocket, name: string, color: number): PlayerId | { error: string } {
    if (this.phase !== "lobby") return { error: "Match already in progress" };
    if (this.players.size >= this.config.maxPlayers) return { error: "Room is full" };

    const id = randomUUID();
    if (this.hostId === null) this.hostId = id;
    const session = createImpostorPlayerSession(id, ws, name || "Player", color);
    const spawnIndex = this.players.size;
    this.players.set(id, session);
    this.assignSpawn(session, spawnIndex);
    this.broadcastLobby();
    return id;
  }

  getToken(id: PlayerId): string | undefined {
    return this.players.get(id)?.reconnectToken;
  }

  /** Same shape as Duel's Room.handleDisconnect — pause-and-grace-window
   * rather than instant forfeit, generalized to "any of N players" instead
   * of "the other player". Pausing works identically whether the phase is
   * "active" or "meeting" — both just stop processing timers/input. */
  handleDisconnect(id: PlayerId): void {
    const session = this.players.get(id);
    if (!session) return;

    if (this.phase !== "active" && this.phase !== "countdown" && this.phase !== "meeting") {
      this.removePlayer(id);
      return;
    }

    session.connected = false;
    if (this.pauseStartedAt === null) {
      this.pauseStartedAt = Date.now();
      for (const p of this.players.values()) p.inputQueue.length = 0;
    }
    this.broadcast({ type: "imp_player_connection", id, connected: false, graceMs: RECONNECT_GRACE_MS });

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(id);
      if (!session.connected) this.removePlayer(id);
    }, RECONNECT_GRACE_MS);
    this.disconnectTimers.set(id, timer);
  }

  rejoin(token: string, ws: WebSocket): PlayerId | null {
    for (const [id, session] of this.players) {
      if (session.reconnectToken !== token || session.connected) continue;

      session.ws = ws;
      session.connected = true;
      const timer = this.disconnectTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.disconnectTimers.delete(id);
      }

      if (this.pauseStartedAt !== null && [...this.players.values()].every((p) => p.connected)) {
        const pausedMs = Date.now() - this.pauseStartedAt;
        // A hold task's progress and the meeting's own timers are measured
        // from wall-clock timestamps — shift them forward by however long
        // the room was frozen so the paused time doesn't silently count,
        // same reasoning as Duel's respawn/match-clock shifts on resume.
        for (const p of this.players.values()) {
          if (p.activeHold) p.activeHold.startedAt += pausedMs;
        }
        if (this.meetingState) {
          this.meetingState.discussionEndsAt += pausedMs;
          this.meetingState.votingEndsAt += pausedMs;
        }
        this.pauseStartedAt = null;
      }

      this.broadcast({ type: "imp_player_connection", id, connected: true });
      return id;
    }
    return null;
  }

  resendStateTo(id: PlayerId): void {
    this.send(id, {
      type: "imp_lobby_update",
      phase: this.phase,
      players: this.playersSummary(),
      config: this.config,
      hostId: this.hostId,
    });
    if (this.phase !== "active" && this.phase !== "meeting") return;

    this.send(id, { type: "imp_match_started", serverTime: Date.now(), mapId: this.mapId });
    const role = this.roles.get(id);
    if (role) this.send(id, { type: "imp_role_assigned", role, fellowImposters: this.fellowImpostersFor(id, role) });
    this.send(id, { type: "imp_task_stations", stations: [...this.taskStations] });

    const session = this.players.get(id);
    if (session) {
      this.send(id, { type: "imp_task_assignment", assignedIds: session.assignedTaskIds });
      this.send(id, { type: "imp_task_progress", completedIds: [...session.completedTaskIds] });
      this.send(id, { type: "imp_meeting_count", remaining: session.emergencyMeetingsRemaining });
    }
    const { completed, total } = this.computeAggregateProgress();
    this.send(id, { type: "imp_task_aggregate_progress", completed, total });

    if (this.phase === "meeting" && this.meetingState) {
      if (this.meetingState.subPhase === "discussion") {
        this.send(id, {
          type: "imp_meeting_started",
          calledBy: this.meetingState.calledBy,
          discussionEndsAt: this.meetingState.discussionEndsAt,
        });
      } else {
        this.send(id, { type: "imp_meeting_voting", votingEndsAt: this.meetingState.votingEndsAt });
      }
    }
  }

  removePlayer(id: PlayerId): void {
    const session = this.players.get(id);
    if (!session) return;
    const timer = this.disconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(id);
    }
    this.players.delete(id);
    this.roles.delete(id);
    if (this.hostId === id) this.hostId = this.players.keys().next().value ?? null;
    this.broadcast({ type: "imp_player_left", id });

    if (this.phase !== "lobby" && this.players.size < this.config.minPlayers) {
      // Not enough people left to keep a meaningful round going — bail back
      // to the lobby rather than press on with a broken player count.
      this.resetToLobby();
    } else {
      this.broadcastLobby();
    }

    if (this.players.size === 0) this.onEmpty();
  }

  handleMessage(id: PlayerId, msg: ImpostorClientMessage): void {
    const session = this.players.get(id);
    if (!session) return;

    switch (msg.type) {
      case "set_ready":
        session.ready = msg.ready;
        this.broadcastLobby();
        this.maybeStartCountdown();
        break;
      case "imp_set_config":
        if (this.phase === "lobby" && id === this.hostId) {
          this.applyConfig(msg.minPlayers, msg.maxPlayers, msg.imposterCount);
          this.broadcastLobby();
        }
        break;
      case "input":
        if (this.phase === "active" && this.pauseStartedAt === null && !session.ejected) session.inputQueue.push(msg);
        break;
      case "ping":
        this.send(id, { type: "pong", t: msg.t, serverTime: Date.now() });
        break;
      case "leave_room":
        this.removePlayer(id);
        break;
      case "imp_task_hold":
        if (this.phase === "active" && this.pauseStartedAt === null) this.handleTaskHold(session, msg.stationId, msg.holding);
        break;
      case "imp_task_key":
        if (this.phase === "active" && this.pauseStartedAt === null) this.handleTaskKey(session, msg.stationId, msg.key);
        break;
      case "imp_call_meeting":
        if (this.phase === "active" && this.pauseStartedAt === null) this.handleCallMeeting(session);
        break;
      case "imp_cast_vote":
        if (this.phase === "meeting" && this.pauseStartedAt === null) this.handleCastVote(session, msg.target);
        break;
    }
  }

  tick(nowMs: number): void {
    this.tickCount++;
    const paused = this.pauseStartedAt !== null;

    if (this.phase === "countdown" && !paused && nowMs >= this.countdownEndsAt) {
      this.startMatch(nowMs);
    }
    if (this.phase === "active" && !paused) {
      this.simulateActive(nowMs);
    }
    if (this.phase === "meeting" && !paused && this.meetingState) {
      if (this.meetingState.subPhase === "discussion" && nowMs >= this.meetingState.discussionEndsAt) {
        this.startVoting(nowMs);
      } else if (this.meetingState.subPhase === "voting" && nowMs >= this.meetingState.votingEndsAt) {
        this.resolveVoting();
      }
    }

    this.ticksSinceSnapshot++;
    if (this.phase === "active" && !paused && this.ticksSinceSnapshot >= SNAPSHOT_EVERY_N_TICKS) {
      this.ticksSinceSnapshot = 0;
      this.broadcastSnapshot(nowMs);
    }
  }

  private applyConfig(minPlayers: number, maxPlayers: number, imposterCount: number): void {
    if (!Number.isInteger(minPlayers) || !Number.isInteger(maxPlayers)) return;
    if (minPlayers < IMPOSTOR_MIN_PLAYERS || maxPlayers > IMPOSTOR_MAX_PLAYERS || minPlayers > maxPlayers) return;
    if (!isValidImposterCount(minPlayers, imposterCount)) return;
    this.config = { minPlayers, maxPlayers, imposterCount };
  }

  private maybeStartCountdown(): void {
    if (this.phase !== "lobby") return;
    if (this.players.size < this.config.minPlayers) return;
    if (![...this.players.values()].every((p) => p.ready)) return;
    if (!isValidImposterCount(this.players.size, this.config.imposterCount)) return;

    this.phase = "countdown";
    this.countdownEndsAt = Date.now() + MATCH_COUNTDOWN_MS;
    this.broadcast({ type: "imp_match_countdown", startsAtServerTime: this.countdownEndsAt });
  }

  private startMatch(nowMs: number): void {
    this.phase = "active";
    this.assignRoles();
    this.meetingState = null;

    let spawnIndex = 0;
    for (const [id, session] of this.players) {
      this.assignSpawn(session, spawnIndex++);
      session.history.clear();
      session.inputQueue.length = 0;
      session.activeHold = null;
      session.activeSequence = null;
      session.ejected = false;
      session.emergencyMeetingsRemaining = EMERGENCY_MEETINGS_PER_PLAYER;
      session.completedTaskIds = new Set();
      session.assignedTaskIds = this.roles.get(id) === "crewmate" ? this.pickAssignedTasks() : [];
    }

    this.broadcast({ type: "imp_match_started", serverTime: nowMs, mapId: this.mapId });
    for (const [id, role] of this.roles) {
      this.send(id, { type: "imp_role_assigned", role, fellowImposters: this.fellowImpostersFor(id, role) });
    }
    this.broadcast({ type: "imp_task_stations", stations: [...this.taskStations] });
    for (const [id, session] of this.players) {
      this.send(id, { type: "imp_task_assignment", assignedIds: session.assignedTaskIds });
      this.send(id, { type: "imp_meeting_count", remaining: session.emergencyMeetingsRemaining });
    }
    const { completed, total } = this.computeAggregateProgress();
    this.broadcast({ type: "imp_task_aggregate_progress", completed, total });
  }

  /** Fisher-Yates shuffle of the station list, first TASKS_PER_PLAYER
   * become this crewmate's assigned checklist. */
  private pickAssignedTasks(): string[] {
    const ids = this.taskStations.map((s) => s.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return ids.slice(0, Math.min(TASKS_PER_PLAYER, ids.length));
  }

  /** Fisher-Yates shuffle of the roster, first config.imposterCount become
   * imposters, everyone else is a crewmate. */
  private assignRoles(): void {
    this.roles.clear();
    const ids = [...this.players.keys()];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const imposterIds = new Set(ids.slice(0, this.config.imposterCount));
    for (const id of ids) this.roles.set(id, imposterIds.has(id) ? "imposter" : "crewmate");
  }

  private fellowImpostersFor(id: PlayerId, role: ImpostorRole): PlayerId[] {
    if (role !== "imposter") return [];
    return [...this.roles.entries()].filter(([otherId, r]) => r === "imposter" && otherId !== id).map(([otherId]) => otherId);
  }

  /** Cycles through the map's spawns via modulo — Facility has 10, matching
   * IMPOSTOR_MAX_PLAYERS, so this only wraps if the host's config somehow
   * allowed more (it can't; applyConfig caps maxPlayers there too). */
  private assignSpawn(session: ImpostorPlayerSession, spawnIndex: number): void {
    const spawn = this.map.spawns[spawnIndex % this.map.spawns.length];
    session.physics = { position: { ...spawn.position }, velocity: { x: 0, y: 0, z: 0 }, onGround: false };
    session.yaw = spawn.yaw;
    session.pitch = 0;
  }

  private simulateActive(nowMs: number): void {
    for (const session of this.players.values()) {
      this.drainInputs(session, nowMs);
    }
    this.checkActiveTasks(nowMs);
  }

  /** Task progress is time-based (holds) or requires staying put (sequences),
   * not purely edge-triggered, so it needs a check every tick regardless of
   * whether new input arrived this tick — both to advance/complete a hold
   * that's been held long enough, and to catch a player who walked out of
   * range without ever sending a release. */
  private checkActiveTasks(nowMs: number): void {
    for (const session of this.players.values()) {
      const hold = session.activeHold;
      if (hold) {
        const station = this.taskStations.find((s) => s.id === hold.stationId);
        if (!station || session.completedTaskIds.has(station.id) || !this.withinRange(session, station)) {
          session.activeHold = null;
        } else if (nowMs - hold.startedAt >= station.holdDurationMs) {
          session.activeHold = null;
          this.completeTask(session, station.id);
        }
      }

      const seq = session.activeSequence;
      if (seq) {
        const station = this.taskStations.find((s) => s.id === seq.stationId);
        if (!station || session.completedTaskIds.has(station.id) || !this.withinRange(session, station)) {
          session.activeSequence = null;
          this.send(session.id, { type: "imp_task_sequence_cancelled", stationId: seq.stationId });
        }
      }
    }
  }

  private withinRange(session: ImpostorPlayerSession, station: TaskStationDef): boolean {
    const dx = session.physics.position.x - station.position.x;
    const dz = session.physics.position.z - station.position.z;
    return Math.hypot(dx, dz) <= station.radius;
  }

  private handleTaskHold(session: ImpostorPlayerSession, stationId: string, holding: boolean): void {
    if (this.roles.get(session.id) !== "crewmate") return;
    if (!session.assignedTaskIds.includes(stationId) || session.completedTaskIds.has(stationId)) return;
    const station = this.taskStations.find((s) => s.id === stationId);
    if (!station) return;

    if (!holding) {
      if (session.activeHold?.stationId === stationId) session.activeHold = null;
      return;
    }
    if (!this.withinRange(session, station)) return;

    if (station.kind === "hold") {
      session.activeHold = { stationId, startedAt: Date.now() };
    } else if (station.kind === "sequence" && !session.activeSequence) {
      const sequence = randomSequence(station.sequenceLength);
      session.activeSequence = { stationId, sequence, progress: 0 };
      this.send(session.id, { type: "imp_task_sequence", stationId, sequence });
    }
  }

  private handleTaskKey(session: ImpostorPlayerSession, stationId: string, key: string): void {
    if (this.roles.get(session.id) !== "crewmate") return;
    const seq = session.activeSequence;
    if (!seq || seq.stationId !== stationId) return;
    if (!session.assignedTaskIds.includes(stationId) || session.completedTaskIds.has(stationId)) return;

    if (key === seq.sequence[seq.progress]) {
      seq.progress++;
      if (seq.progress >= seq.sequence.length) {
        session.activeSequence = null;
        this.completeTask(session, stationId);
        return;
      }
      this.send(session.id, { type: "imp_task_sequence_progress", stationId, correctCount: seq.progress });
    } else {
      seq.progress = 0;
      this.send(session.id, { type: "imp_task_sequence_progress", stationId, correctCount: 0 });
    }
  }

  private completeTask(session: ImpostorPlayerSession, stationId: string): void {
    if (session.completedTaskIds.has(stationId)) return;
    session.completedTaskIds.add(stationId);
    this.send(session.id, { type: "imp_task_progress", completedIds: [...session.completedTaskIds] });

    const { completed, total } = this.computeAggregateProgress();
    this.broadcast({ type: "imp_task_aggregate_progress", completed, total });

    this.checkTasksWinCondition();
  }

  private computeAggregateProgress(): { completed: number; total: number } {
    const crew = [...this.players.values()].filter((p) => this.roles.get(p.id) === "crewmate");
    const total = crew.reduce((sum, p) => sum + p.assignedTaskIds.length, 0);
    const completed = crew.reduce((sum, p) => sum + p.completedTaskIds.size, 0);
    return { completed, total };
  }

  private checkTasksWinCondition(): boolean {
    const crew = [...this.players.values()].filter((p) => !p.ejected && this.roles.get(p.id) === "crewmate");
    if (crew.length === 0) return false;
    const allDone = crew.every((p) => p.completedTaskIds.size >= p.assignedTaskIds.length);
    if (!allDone) return false;

    this.broadcast({ type: "imp_match_ended", reason: "tasks_complete" });
    setTimeout(() => this.resetToLobby(), RESULTS_DISPLAY_MS);
    return true;
  }

  // --- Meetings / voting ---

  private handleCallMeeting(session: ImpostorPlayerSession): void {
    if (session.ejected) return;
    if (this.roles.get(session.id) !== "crewmate") return;
    if (session.emergencyMeetingsRemaining <= 0) return;

    session.emergencyMeetingsRemaining--;
    this.send(session.id, { type: "imp_meeting_count", remaining: session.emergencyMeetingsRemaining });
    this.startMeeting(session.id);
  }

  private startMeeting(calledBy: PlayerId): void {
    this.phase = "meeting";
    const now = Date.now();
    this.meetingState = {
      calledBy,
      subPhase: "discussion",
      discussionEndsAt: now + MEETING_DISCUSSION_MS,
      votingEndsAt: 0,
      votes: new Map(),
    };

    // A meeting means "stop what you're doing and gather", not "keep
    // quietly finishing your task uninterrupted" — cancel any in-progress
    // attempts (hold tasks just silently drop; sequence attempts need an
    // explicit cancel message so the client's overlay clears).
    for (const session of this.players.values()) {
      if (session.activeSequence) {
        this.send(session.id, { type: "imp_task_sequence_cancelled", stationId: session.activeSequence.stationId });
      }
      session.activeHold = null;
      session.activeSequence = null;
      session.inputQueue.length = 0;
    }

    this.broadcast({ type: "imp_meeting_started", calledBy, discussionEndsAt: this.meetingState.discussionEndsAt });
  }

  private startVoting(nowMs: number): void {
    if (!this.meetingState) return;
    this.meetingState.subPhase = "voting";
    this.meetingState.votingEndsAt = nowMs + MEETING_VOTING_MS;
    this.broadcast({ type: "imp_meeting_voting", votingEndsAt: this.meetingState.votingEndsAt });
  }

  private handleCastVote(session: ImpostorPlayerSession, target: PlayerId | "skip"): void {
    if (session.ejected || !this.meetingState || this.meetingState.subPhase !== "voting") return;
    if (target !== "skip") {
      const targetSession = this.players.get(target);
      if (!targetSession || targetSession.ejected) return;
    }
    this.meetingState.votes.set(session.id, target);

    // If everyone who can still vote already has, resolve immediately
    // instead of sitting out the rest of the timer.
    const eligibleVoters = [...this.players.values()].filter((p) => !p.ejected && p.connected);
    if (eligibleVoters.every((p) => this.meetingState!.votes.has(p.id))) {
      this.resolveVoting();
    }
  }

  private resolveVoting(): void {
    if (!this.meetingState) return;
    const counts = new Map<PlayerId, number>();
    let skipCount = 0;
    for (const [voterId, target] of this.meetingState.votes) {
      if (!this.players.has(voterId)) continue; // voter left mid-meeting
      if (target === "skip") skipCount++;
      else counts.set(target, (counts.get(target) ?? 0) + 1);
    }

    let maxCount = 0;
    let leaders: PlayerId[] = [];
    for (const [pid, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        leaders = [pid];
      } else if (count === maxCount && maxCount > 0) {
        leaders.push(pid);
      }
    }

    // A single clear leader beating skip gets ejected. A tie among
    // players, no votes at all, or skip meeting/beating the leader all
    // mean no one goes home -- same convention as Among Us.
    let ejectedId: PlayerId | null = leaders.length === 1 && maxCount > skipCount ? leaders[0] : null;
    let ejectedRole: ImpostorRole | null = null;
    if (ejectedId) {
      const targetSession = this.players.get(ejectedId);
      if (targetSession) {
        targetSession.ejected = true;
        ejectedRole = this.roles.get(ejectedId) ?? null;
      } else {
        ejectedId = null; // left mid-meeting, nothing to eject
      }
    }

    const voteCounts: Record<string, number> = {};
    for (const [pid, count] of counts) voteCounts[pid] = count;

    this.broadcast({ type: "imp_meeting_result", ejectedId, ejectedRole, voteCounts, skipCount });
    this.meetingState = null;

    setTimeout(() => this.afterMeetingResult(), MEETING_RESULT_DISPLAY_MS);
  }

  private afterMeetingResult(): void {
    if (this.players.size === 0) return;
    if (this.checkEjectionWinConditions()) return;
    this.phase = "active";
    this.broadcast({ type: "imp_meeting_ended" });
  }

  private checkEjectionWinConditions(): boolean {
    const remaining = [...this.players.values()].filter((p) => !p.ejected);
    const remainingImposters = remaining.filter((p) => this.roles.get(p.id) === "imposter").length;
    const remainingCrew = remaining.length - remainingImposters;

    if (remainingImposters === 0) {
      this.broadcast({ type: "imp_match_ended", reason: "imposters_ejected" });
      setTimeout(() => this.resetToLobby(), RESULTS_DISPLAY_MS);
      return true;
    }
    if (remainingImposters >= remainingCrew) {
      this.broadcast({ type: "imp_match_ended", reason: "imposters_win_by_numbers" });
      setTimeout(() => this.resetToLobby(), RESULTS_DISPLAY_MS);
      return true;
    }
    return false;
  }

  private drainInputs(session: ImpostorPlayerSession, nowMs: number): void {
    for (const input of session.inputQueue) {
      session.lastProcessedSeq = input.seq;
      session.lastRttMs = input.rttMs ?? session.lastRttMs;
      session.yaw = input.yaw;
      session.pitch = input.pitch;

      session.physics = stepPlayerMovement(
        session.physics,
        { forward: input.forward, right: input.right, jump: input.jump, yaw: input.yaw, seq: input.seq, dt: input.dt },
        this.map.blocks,
        this.map.ladders
      );

      session.history.push({ time: nowMs, position: session.physics.position, yaw: session.yaw });
    }
    session.inputQueue.length = 0;
  }

  private resetToLobby(): void {
    this.pauseStartedAt = null;
    if (this.players.size === 0) return; // room emptied while results were showing
    this.phase = "lobby";
    this.roles.clear();
    this.meetingState = null;
    for (const p of this.players.values()) {
      p.ready = false;
      p.activeHold = null;
      p.activeSequence = null;
      p.assignedTaskIds = [];
      p.completedTaskIds = new Set();
      p.ejected = false;
    }
    this.broadcastLobby();
  }

  private playersSummary(): ImpostorPlayerSummary[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      ready: p.ready,
      connected: p.connected,
    }));
  }

  private broadcastLobby(): void {
    this.broadcast({
      type: "imp_lobby_update",
      phase: this.phase,
      players: this.playersSummary(),
      config: this.config,
      hostId: this.hostId,
    });
  }

  private broadcastSnapshot(nowMs: number): void {
    const players: ImpostorPlayerSnapshot[] = [...this.players.values()]
      .filter((p) => !p.ejected)
      .map((p) => ({
        id: p.id,
        position: p.physics.position,
        velocity: p.physics.velocity,
        yaw: p.yaw,
        pitch: p.pitch,
        onGround: p.physics.onGround,
        color: p.color,
        lastProcessedSeq: p.lastProcessedSeq,
      }));
    this.broadcast({ type: "imp_snapshot", tick: this.tickCount, serverTime: nowMs, players });
  }

  send(id: PlayerId, msg: ImpostorServerMessage): void {
    const session = this.players.get(id);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(msg));
    }
  }

  broadcast(msg: ImpostorServerMessage): void {
    for (const session of this.players.values()) {
      if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(msg));
    }
  }
}

function randomSequence(length: number): SequenceKey[] {
  const out: SequenceKey[] = [];
  for (let i = 0; i < length; i++) {
    out.push(SEQUENCE_KEYS[Math.floor(Math.random() * SEQUENCE_KEYS.length)]);
  }
  return out;
}
