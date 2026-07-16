import {
  defaultImpostorConfig,
  ImpostorClientMessage,
  ImpostorPhase,
  ImpostorPlayerSnapshot,
  ImpostorPlayerSummary,
  ImpostorRole,
  ImpostorRoomConfig,
  ImpostorServerMessage,
  IMPOSTOR_MAX_PLAYERS,
  IMPOSTOR_MIN_PLAYERS,
  isValidImposterCount,
  MAPS,
  MATCH_COUNTDOWN_MS,
  PlayerId,
  RECONNECT_GRACE_MS,
  SIM_HZ,
  SNAPSHOT_HZ,
  stepPlayerMovement,
} from "@fps/shared";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createImpostorPlayerSession, ImpostorPlayerSession } from "./ImpostorPlayerSession.js";

const SNAPSHOT_EVERY_N_TICKS = Math.round(SIM_HZ / SNAPSHOT_HZ);

// Placeholder map until Milestone 2 builds a dedicated task map sized for
// 4-10 roaming players — Outpost is reused as-is purely so this milestone
// has somewhere to walk around and prove role assignment/movement. Only 2
// spawn points, so with more than 2 players some will spawn stacked; that's
// an accepted temporary wrinkle, not something worth solving before the
// real map exists.
const PLACEHOLDER_MAP_ID = "outpost";

/**
 * Sibling to Duel's Room, not a subclass or a generalized merge — the phase
 * machine (lobby -> countdown -> active -> tasks/meetings in later
 * milestones) and win conditions are different enough that sharing one class
 * would mean threading mode-conditionals through Duel's already-tested code.
 * Movement/tick/snapshot/reconnect plumbing is intentionally near-identical
 * to Room's (same proven approach, generalized from 2 players to a range),
 * duplicated rather than shared for that same isolation reason.
 */
export class ImpostorRoom {
  readonly code: string;
  phase: ImpostorPhase = "lobby";
  private readonly mapId: string = PLACEHOLDER_MAP_ID;
  private config: ImpostorRoomConfig = defaultImpostorConfig();
  private hostId: PlayerId | null = null;

  private players = new Map<PlayerId, ImpostorPlayerSession>();
  private roles = new Map<PlayerId, ImpostorRole>();
  private countdownEndsAt = 0;
  private tickCount = 0;
  private ticksSinceSnapshot = 0;

  private pauseStartedAt: number | null = null;
  private disconnectTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();

  constructor(code: string, private onEmpty: () => void) {
    this.code = code;
  }

  get playerCount(): number {
    return this.players.size;
  }

  private get map() {
    return MAPS[this.mapId];
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
   * of "the other player". */
  handleDisconnect(id: PlayerId): void {
    const session = this.players.get(id);
    if (!session) return;

    if (this.phase !== "active" && this.phase !== "countdown") {
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
    if (this.phase === "active") {
      this.send(id, { type: "imp_match_started", serverTime: Date.now(), mapId: this.mapId });
      const role = this.roles.get(id);
      if (role) this.send(id, { type: "imp_role_assigned", role, fellowImposters: this.fellowImpostersFor(id, role) });
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
      // to the lobby rather than press on with a broken player count. No
      // real win/loss condition exists yet this milestone, so there's no
      // "match_ended" result to show; that lands with the real win
      // conditions in M2-M4.
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
        if (this.pauseStartedAt === null) session.inputQueue.push(msg);
        break;
      case "ping":
        this.send(id, { type: "pong", t: msg.t, serverTime: Date.now() });
        break;
      case "leave_room":
        this.removePlayer(id);
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

    let spawnIndex = 0;
    for (const session of this.players.values()) {
      this.assignSpawn(session, spawnIndex++);
      session.history.clear();
      session.inputQueue.length = 0;
    }

    this.broadcast({ type: "imp_match_started", serverTime: nowMs, mapId: this.mapId });
    for (const [id, role] of this.roles) {
      this.send(id, { type: "imp_role_assigned", role, fellowImposters: this.fellowImpostersFor(id, role) });
    }
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

  /** Cycles through the placeholder map's spawns via modulo — with more
   * than `spawns.length` players, some spawn stacked. Accepted for this
   * milestone (see PLACEHOLDER_MAP_ID's comment); not worth a
   * spawn-scattering hack for a map that's getting replaced next milestone. */
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
    this.phase = "lobby";
    this.roles.clear();
    for (const p of this.players.values()) p.ready = false;
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
    const players: ImpostorPlayerSnapshot[] = [...this.players.values()].map((p) => ({
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
