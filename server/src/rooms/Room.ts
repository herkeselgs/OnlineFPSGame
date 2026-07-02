import {
  applyDamage,
  BoxCollider,
  ClientMessage,
  createPlayerCombatState,
  INTERP_DELAY_MS,
  MATCH_COUNTDOWN_MS,
  MATCH_DURATION_MS,
  MATCH_SCORE_LIMIT,
  MatchPhase,
  normalize,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_EXTENTS,
  PlayerId,
  PlayerSnapshot,
  rayIntersectsBox,
  RESPAWN_TIME_MS,
  RESULTS_DISPLAY_MS,
  respawn,
  RoomPlayerSummary,
  ServerMessage,
  SIM_HZ,
  SNAPSHOT_HZ,
  stepPlayerMovement,
  TEST_ARENA,
  Vec3,
  WeaponDef,
  WeaponState,
} from "@fps/shared";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createPlayerSession, PlayerSession } from "./PlayerSession.js";

const SNAPSHOT_EVERY_N_TICKS = Math.round(SIM_HZ / SNAPSHOT_HZ);
const MAX_PLAYERS = 2; // 1v1 for now; room model below doesn't assume this beyond this one constant

export class Room {
  readonly code: string;
  readonly map = TEST_ARENA;
  phase: MatchPhase = "lobby";

  private players = new Map<PlayerId, PlayerSession>();
  private spawnIndexByPlayer = new Map<PlayerId, number>();
  private countdownEndsAt = 0;
  private matchEndsAt = 0;
  private tickCount = 0;
  private ticksSinceSnapshot = 0;

  constructor(code: string, private onEmpty: () => void) {
    this.code = code;
  }

  get playerCount(): number {
    return this.players.size;
  }

  addPlayer(ws: WebSocket, name: string): PlayerId | { error: string } {
    if (this.players.size >= MAX_PLAYERS) return { error: "Room is full" };
    if (this.phase !== "lobby") return { error: "Match already in progress" };

    const id = randomUUID();
    const session = createPlayerSession(id, ws, name || "Player");
    const spawnIndex = this.players.size % this.map.spawns.length;
    const spawn = this.map.spawns[spawnIndex];
    session.physics.position = { ...spawn.position };
    session.yaw = spawn.yaw;
    this.spawnIndexByPlayer.set(id, spawnIndex);
    this.players.set(id, session);
    this.broadcastLobby();
    return id;
  }

  removePlayer(id: PlayerId): void {
    if (!this.players.has(id)) return;
    this.players.delete(id);
    this.spawnIndexByPlayer.delete(id);
    this.broadcast({ type: "player_left", id });

    if (this.phase === "active" || this.phase === "countdown") {
      const remaining = [...this.players.values()];
      const winnerId = remaining.length === 1 ? remaining[0].id : null;
      const scores = remaining.map((p) => ({
        id: p.id,
        name: p.name,
        kills: p.combat.kills,
        deaths: p.combat.deaths,
      }));
      this.phase = "ended";
      this.broadcast({ type: "match_ended", scores, winnerId });
      setTimeout(() => this.resetToLobby(), RESULTS_DISPLAY_MS);
    } else {
      this.broadcastLobby();
    }

    if (this.players.size === 0) this.onEmpty();
  }

  handleMessage(id: PlayerId, msg: ClientMessage): void {
    const session = this.players.get(id);
    if (!session) return;

    switch (msg.type) {
      case "set_ready":
        session.ready = msg.ready;
        this.broadcastLobby();
        this.maybeStartCountdown();
        break;
      case "input":
        session.inputQueue.push(msg);
        break;
      case "ping":
        this.send(id, { type: "pong", t: msg.t, serverTime: Date.now() });
        break;
      case "leave_room":
        this.removePlayer(id);
        break;
    }
  }

  /** Called at SIM_HZ by the global game loop for every active room. */
  tick(nowMs: number): void {
    this.tickCount++;

    if (this.phase === "countdown" && nowMs >= this.countdownEndsAt) {
      this.startMatch(nowMs);
    }
    if (this.phase === "active") {
      this.simulateActive(nowMs);
    }

    this.ticksSinceSnapshot++;
    if (this.phase === "active" && this.ticksSinceSnapshot >= SNAPSHOT_EVERY_N_TICKS) {
      this.ticksSinceSnapshot = 0;
      this.broadcastSnapshot(nowMs);
    }
  }

  private maybeStartCountdown(): void {
    if (this.phase !== "lobby") return;
    if (this.players.size < MAX_PLAYERS) return;
    if (![...this.players.values()].every((p) => p.ready)) return;

    this.phase = "countdown";
    this.countdownEndsAt = Date.now() + MATCH_COUNTDOWN_MS;
    this.broadcast({ type: "match_countdown", startsAtServerTime: this.countdownEndsAt });
  }

  private startMatch(nowMs: number): void {
    this.phase = "active";
    this.matchEndsAt = nowMs + MATCH_DURATION_MS;

    for (const [id, session] of this.players) {
      const spawnIndex = this.spawnIndexByPlayer.get(id) ?? 0;
      const spawn = this.map.spawns[spawnIndex];
      session.physics = { position: { ...spawn.position }, velocity: { x: 0, y: 0, z: 0 }, onGround: false };
      session.yaw = spawn.yaw;
      session.pitch = 0;
      session.combat = createPlayerCombatState();
      respawn(session.combat, nowMs); // grants initial spawn protection too
      session.weapon = new WeaponState();
      session.history.clear();
      session.inputQueue.length = 0;
    }

    this.broadcast({ type: "match_started", serverTime: nowMs, mapId: this.map.id, durationMs: MATCH_DURATION_MS });
  }

  private simulateActive(nowMs: number): void {
    for (const session of this.players.values()) {
      this.drainInputs(session, nowMs);

      if (!session.combat.alive && nowMs >= session.respawnAtMs) {
        const spawnIndex = this.spawnIndexByPlayer.get(session.id) ?? 0;
        const spawn = this.map.spawns[spawnIndex];
        session.physics.position = { ...spawn.position };
        session.physics.velocity = { x: 0, y: 0, z: 0 };
        session.physics.onGround = false;
        session.yaw = spawn.yaw;
        session.pitch = 0;
        respawn(session.combat, nowMs);
      }
    }

    for (const session of this.players.values()) {
      if (session.combat.kills >= MATCH_SCORE_LIMIT) {
        this.endMatch();
        return;
      }
    }
    if (nowMs >= this.matchEndsAt) {
      this.endMatch();
    }
  }

  private drainInputs(session: PlayerSession, nowMs: number): void {
    for (const input of session.inputQueue) {
      session.lastProcessedSeq = input.seq;
      session.lastRttMs = input.rttMs ?? session.lastRttMs;
      session.yaw = input.yaw;
      session.pitch = input.pitch;

      if (session.combat.alive) {
        session.physics = stepPlayerMovement(
          session.physics,
          {
            forward: input.forward,
            right: input.right,
            jump: input.jump,
            yaw: input.yaw,
            seq: input.seq,
            dt: input.dt,
          },
          this.map.blocks
        );
        session.weapon.update(input.dt * 1000);
        if (input.switchTo) session.weapon.switchTo(input.switchTo);
        if (input.reload) session.weapon.startReload();
        if (input.fire) this.handleFire(session, input.fireDirections ?? [], nowMs);
      }

      session.history.push({ time: nowMs, position: session.physics.position, yaw: session.yaw });
    }
    session.inputQueue.length = 0;
  }

  private handleFire(shooter: PlayerSession, rawDirections: Vec3[], nowMs: number): void {
    const result = shooter.weapon.tryFire();
    if (!result.fired) return;

    const weaponDef = shooter.weapon.current;
    const eyeOffset = PLAYER_EYE_HEIGHT - PLAYER_HALF_EXTENTS.y;
    const origin: Vec3 = {
      x: shooter.physics.position.x,
      y: shooter.physics.position.y + eyeOffset,
      z: shooter.physics.position.z,
    };
    // Rewind other players to roughly where the shooter actually saw them:
    // their own network delay to us, halved for one-way, plus the render
    // interpolation delay every client applies to remote players.
    const rewindTime = nowMs - shooter.lastRttMs / 2 - INTERP_DELAY_MS;

    const pellets = rawDirections.slice(0, weaponDef.pelletCount);
    for (const rawDir of pellets) {
      const dir = safeNormalize(rawDir);
      if (!dir) continue;
      this.resolvePellet(shooter, weaponDef, origin, dir, rewindTime, nowMs);
    }
  }

  private resolvePellet(
    shooter: PlayerSession,
    weaponDef: WeaponDef,
    origin: Vec3,
    dir: Vec3,
    rewindTime: number,
    nowMs: number
  ): void {
    let nearestDist = weaponDef.range;
    for (const block of this.map.blocks) {
      const d = rayIntersectsBox(origin, dir, block, nearestDist);
      if (d !== null && d < nearestDist) nearestDist = d;
    }

    let bestTarget: PlayerSession | null = null;
    for (const [id, target] of this.players) {
      if (id === shooter.id || !target.combat.alive) continue;
      const sample = target.history.sampleAt(rewindTime) ?? target.history.latest();
      if (!sample) continue;
      const box: BoxCollider = { center: sample.position, half: PLAYER_HALF_EXTENTS };
      const d = rayIntersectsBox(origin, dir, box, nearestDist);
      if (d !== null && d < nearestDist) {
        nearestDist = d;
        bestTarget = target;
      }
    }

    if (!bestTarget) return;
    const dmg = applyDamage(bestTarget.combat, weaponDef.damage, nowMs);
    if (!dmg.applied) return;

    this.send(shooter.id, {
      type: "hit_confirmed",
      targetId: bestTarget.id,
      damage: weaponDef.damage,
      killed: dmg.killed,
    });

    if (dmg.killed) {
      shooter.combat.kills += 1;
      bestTarget.respawnAtMs = nowMs + RESPAWN_TIME_MS;
      this.broadcast({
        type: "kill_feed",
        killerId: shooter.id,
        victimId: bestTarget.id,
        weapon: weaponDef.id,
      });
    }
  }

  private endMatch(): void {
    this.phase = "ended";
    const scores = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      kills: p.combat.kills,
      deaths: p.combat.deaths,
    }));
    const sorted = [...scores].sort((a, b) => b.kills - a.kills);
    const winnerId = sorted.length >= 1 && (sorted.length === 1 || sorted[0].kills > sorted[1].kills) ? sorted[0].id : null;

    this.broadcast({ type: "match_ended", scores, winnerId });
    setTimeout(() => this.resetToLobby(), RESULTS_DISPLAY_MS);
  }

  private resetToLobby(): void {
    if (this.players.size === 0) return; // room was emptied while results were showing
    this.phase = "lobby";
    for (const p of this.players.values()) p.ready = false;
    this.broadcastLobby();
  }

  private broadcastLobby(): void {
    const players: RoomPlayerSummary[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      connected: p.connected,
      kills: p.combat.kills,
      deaths: p.combat.deaths,
    }));
    this.broadcast({ type: "lobby_update", phase: this.phase, players });
  }

  private broadcastSnapshot(nowMs: number): void {
    const players: PlayerSnapshot[] = [...this.players.values()].map((p) => ({
      id: p.id,
      position: p.physics.position,
      velocity: p.physics.velocity,
      yaw: p.yaw,
      pitch: p.pitch,
      onGround: p.physics.onGround,
      health: p.combat.health,
      alive: p.combat.alive,
      spawnProtectedUntil: p.combat.spawnProtectedUntil,
      weapon: p.weapon.currentId,
      ammo: p.weapon.currentAmmo,
      reloading: p.weapon.isReloading,
      kills: p.combat.kills,
      deaths: p.combat.deaths,
      lastProcessedSeq: p.lastProcessedSeq,
    }));
    this.broadcast({ type: "snapshot", tick: this.tickCount, serverTime: nowMs, players });
  }

  send(id: PlayerId, msg: ServerMessage): void {
    const session = this.players.get(id);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(msg));
    }
  }

  broadcast(msg: ServerMessage): void {
    for (const session of this.players.values()) {
      if (session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify(msg));
    }
  }
}

function safeNormalize(v: Vec3): Vec3 | null {
  const n = normalize(v);
  if (n.x === 0 && n.y === 0 && n.z === 0) return null;
  return n;
}
