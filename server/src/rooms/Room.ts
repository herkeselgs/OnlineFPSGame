import {
  applyDamage,
  ClientMessage,
  createPlayerCombatState,
  damageMultiplierFor,
  DEFAULT_MAP_ID,
  eyeHeightOffset,
  HitZone,
  INTERP_DELAY_MS,
  MAPS,
  MATCH_COUNTDOWN_MS,
  MATCH_DURATION_MS,
  MATCH_SCORE_LIMIT,
  MatchPhase,
  normalize,
  PlayerId,
  PlayerSnapshot,
  rayIntersectsBox,
  RECONNECT_GRACE_MS,
  resolvePlayerHit,
  RESPAWN_TIME_MS,
  RESULTS_DISPLAY_MS,
  respawn,
  RoomMode,
  RoomPlayerSummary,
  SpawnPoint,
  ServerMessage,
  SIM_HZ,
  SNAPSHOT_HZ,
  STAMINA_MAX,
  stepPlayerMovement,
  TEAM_MATCH_SCORE_LIMIT,
  TEAM_SIZE_MAX,
  TeamId,
  Vec3,
  WeaponDef,
  WeaponState,
} from "@fps/shared";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createPlayerSession, PlayerSession } from "./PlayerSession.js";

const SNAPSHOT_EVERY_N_TICKS = Math.round(SIM_HZ / SNAPSHOT_HZ);
const DUEL_MAX_PLAYERS = 2;

export class Room {
  readonly code: string;
  readonly mode: RoomMode;
  phase: MatchPhase = "lobby";
  private mapId: string = DEFAULT_MAP_ID;

  get map() {
    return MAPS[this.mapId];
  }

  /** Room capacity — 2 for Duel, 2*TEAM_SIZE_MAX for team5v5. Doesn't
   * assume any particular team split beyond that cap; addPlayer's
   * balancing logic is what actually keeps the two sides even. */
  get maxPlayers(): number {
    return this.mode === "team5v5" ? TEAM_SIZE_MAX * 2 : DUEL_MAX_PLAYERS;
  }

  private players = new Map<PlayerId, PlayerSession>();
  private spawnIndexByPlayer = new Map<PlayerId, number>();
  private countdownEndsAt = 0;
  private matchEndsAt = 0;
  private tickCount = 0;
  private ticksSinceSnapshot = 0;

  /** Set the instant any player drops mid-match; simulation freezes (see
   * tick()) until everyone is reconnected or the grace period times out. */
  private pauseStartedAt: number | null = null;
  private disconnectTimers = new Map<PlayerId, ReturnType<typeof setTimeout>>();

  constructor(code: string, mode: RoomMode, private onEmpty: () => void) {
    this.code = code;
    this.mode = mode;
  }

  get playerCount(): number {
    return this.players.size;
  }

  private teamCount(team: TeamId): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n++;
    return n;
  }

  /** The spawn point a given (team-assigned, if applicable) player should
   * use — pulled from the map's team-spawn clusters in team5v5, or the
   * plain 2-entry spawns array in Duel. Centralized here rather than
   * duplicated at every call site (initial join, match start, respawn)
   * since all three need to agree. */
  private spawnFor(session: PlayerSession): SpawnPoint {
    const index = this.spawnIndexByPlayer.get(session.id) ?? 0;
    if (this.mode === "team5v5" && session.team) {
      const pool = session.team === "A" ? this.map.teamSpawns.a : this.map.teamSpawns.b;
      return pool[index % pool.length];
    }
    return this.map.spawns[index % this.map.spawns.length];
  }

  addPlayer(ws: WebSocket, name: string, color: number): PlayerId | { error: string } {
    if (this.players.size >= this.maxPlayers) return { error: "Room is full" };
    if (this.phase !== "lobby") return { error: "Match already in progress" };

    const id = randomUUID();
    const session = createPlayerSession(id, ws, name || "Player", color);
    if (this.mode === "team5v5") {
      // Whichever side currently has fewer players; ties go to A. Assigned
      // once at join and fixed for the rest of the session — players don't
      // switch sides mid-lobby.
      session.team = this.teamCount("A") <= this.teamCount("B") ? "A" : "B";
      // teamCount here is still pre-insertion (session isn't in `players`
      // yet), so it's already the correct 0-indexed slot for this player —
      // e.g. 2 existing A's -> this one is the 3rd -> index 2.
      this.spawnIndexByPlayer.set(id, this.teamCount(session.team));
    } else {
      this.spawnIndexByPlayer.set(id, this.players.size % this.map.spawns.length);
    }
    const spawn = this.spawnFor(session);
    session.physics.position = { ...spawn.position };
    session.yaw = spawn.yaw;
    this.players.set(id, session);
    this.broadcastLobby();
    return id;
  }

  getToken(id: PlayerId): string | undefined {
    return this.players.get(id)?.reconnectToken;
  }

  /** Called when a player's socket closes unexpectedly (not via an explicit
   * leave_room). Outside an active match there's no state worth preserving,
   * so it's an immediate removal same as before; mid-match, it pauses the
   * room and starts the reconnect grace window instead. */
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
      // Flush anything already queued for this tick before the pause flag
      // takes effect, so nothing from right before the drop sneaks into
      // the resume burst either.
      for (const p of this.players.values()) p.inputQueue.length = 0;
    }
    this.broadcast({ type: "opponent_connection", id, connected: false, graceMs: RECONNECT_GRACE_MS });

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(id);
      if (!session.connected) this.removePlayer(id); // never made it back -> forfeit, same as the old instant behavior
    }, RECONNECT_GRACE_MS);
    this.disconnectTimers.set(id, timer);
  }

  /** Reattaches `ws` to the session holding `token`, if one is disconnected
   * and waiting. Resumes simulation once nobody is left disconnected,
   * sliding the match clock and any in-flight respawn timers forward by
   * however long the room was paused so no time is unfairly lost. */
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
        this.matchEndsAt += pausedMs;
        for (const p of this.players.values()) {
          if (!p.combat.alive) p.respawnAtMs += pausedMs;
        }
        this.pauseStartedAt = null;
      }

      this.broadcast({ type: "opponent_connection", id, connected: true });
      return id;
    }
    return null;
  }

  /** Re-sends whatever state a just-reconnected client needs to rebuild its
   * view from scratch — lobby membership, and (if a match is already
   * running) the same match_started message a fresh join would never get,
   * so the client's existing handling reconstructs the match with no
   * reconnect-specific client logic needed. */
  resendStateTo(id: PlayerId): void {
    this.send(id, {
      type: "lobby_update",
      phase: this.phase,
      players: this.playersSummary(),
      mapId: this.mapId,
      mode: this.mode,
    });
    if (this.phase === "active") {
      this.send(id, {
        type: "match_started",
        serverTime: Date.now(),
        mapId: this.map.id,
        durationMs: Math.max(0, this.matchEndsAt - Date.now()),
      });
    }
  }

  removePlayer(id: PlayerId): void {
    const leavingSession = this.players.get(id);
    if (!leavingSession) return;
    const timer = this.disconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(id);
    }
    this.players.delete(id);
    this.spawnIndexByPlayer.delete(id);
    this.broadcast({ type: "player_left", id });

    // Duel only ever has 2 players, so any departure mid-match is
    // automatically a forfeit. team5v5 shouldn't end the whole match just
    // because one of up to 10 players dropped — only a fully-empty side
    // (everyone on one team gone) forfeits; otherwise play continues with
    // whoever's left (the already-broadcast player_left above is enough
    // for clients to stop rendering them).
    const forfeits = this.mode === "team5v5" ? this.teamCount("A") === 0 || this.teamCount("B") === 0 : true;

    if ((this.phase === "active" || this.phase === "countdown") && forfeits) {
      const remaining = [...this.players.values()];
      // Include the leaving player's final stats too, not just whoever's
      // left — otherwise the remaining player's results screen (and
      // anything derived from it, like the opponent name recorded into
      // match history/rivalry stats) loses all trace of who they actually
      // played the instant the other person leaves early.
      const scores = [...remaining, leavingSession].map((p) => ({
        id: p.id,
        name: p.name,
        kills: p.combat.kills,
        deaths: p.combat.deaths,
        shotsFired: p.shotsFired,
        shotsHit: p.shotsHit,
        damageDealt: p.damageDealt,
        team: p.team ?? undefined,
      }));
      this.phase = "ended";
      if (this.mode === "team5v5") {
        const winnerTeam: TeamId | null = this.teamCount("A") > 0 ? "A" : this.teamCount("B") > 0 ? "B" : null;
        this.broadcast({ type: "match_ended", scores, winnerId: null, winnerTeam });
      } else {
        const winnerId = remaining.length === 1 ? remaining[0].id : null;
        this.broadcast({ type: "match_ended", scores, winnerId });
      }
      setTimeout(() => this.resetToLobby(), RESULTS_DISPLAY_MS);
    } else if (this.phase !== "active" && this.phase !== "countdown") {
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
      case "set_map":
        if (this.phase === "lobby" && MAPS[msg.mapId]) {
          this.mapId = msg.mapId;
          this.broadcastLobby();
        }
        break;
      case "input":
        // Dropped, not queued, while paused for a disconnect — otherwise a
        // still-connected player's client keeps sending inputs every tick
        // regardless of the pause (it has no idea the room is frozen), they
        // pile up in the queue untouched since drainInputs isn't called
        // while paused, and then all land in a single burst the instant the
        // pause ends — including any fire commands, which is a real
        // "reconnect into a delayed volley" bug, not just a rendering
        // hiccup. Dropping them means play cleanly resumes from whatever
        // input arrives after the pause lifts, nothing backlogged.
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

  /** Called at SIM_HZ by the global game loop for every active room. */
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

  private maybeStartCountdown(): void {
    if (this.phase !== "lobby") return;
    if (this.players.size < 2) return;
    // Duel's cap (2) already forces an exact 1v1 once size>=2; team5v5 only
    // needs both sides non-empty (2v2, 3v5, ... up to 5v5 all start fine —
    // "still just rooms" doesn't require waiting for exactly 10 people).
    if (this.mode === "team5v5" && (this.teamCount("A") === 0 || this.teamCount("B") === 0)) return;
    if (![...this.players.values()].every((p) => p.ready)) return;

    this.phase = "countdown";
    this.countdownEndsAt = Date.now() + MATCH_COUNTDOWN_MS;
    this.broadcast({ type: "match_countdown", startsAtServerTime: this.countdownEndsAt });
  }

  private startMatch(nowMs: number): void {
    this.phase = "active";
    this.matchEndsAt = nowMs + MATCH_DURATION_MS;

    for (const session of this.players.values()) {
      const spawn = this.spawnFor(session);
      session.physics = {
        position: { ...spawn.position },
        velocity: { x: 0, y: 0, z: 0 },
        onGround: false,
        crouching: false,
        stamina: STAMINA_MAX,
        staminaRegenCooldownMs: 0,
      };
      session.yaw = spawn.yaw;
      session.pitch = 0;
      session.combat = createPlayerCombatState();
      respawn(session.combat, nowMs); // grants initial spawn protection too
      session.weapon = new WeaponState();
      session.history.clear();
      session.inputQueue.length = 0;
      session.shotsFired = 0;
      session.shotsHit = 0;
      session.damageDealt = 0;
    }

    this.broadcast({ type: "match_started", serverTime: nowMs, mapId: this.map.id, durationMs: MATCH_DURATION_MS });
  }

  private simulateActive(nowMs: number): void {
    for (const session of this.players.values()) {
      this.drainInputs(session, nowMs);

      if (!session.combat.alive && nowMs >= session.respawnAtMs) {
        const spawn = this.spawnFor(session);
        session.physics.position = { ...spawn.position };
        session.physics.velocity = { x: 0, y: 0, z: 0 };
        session.physics.onGround = false;
        session.physics.crouching = false;
        session.yaw = spawn.yaw;
        session.pitch = 0;
        respawn(session.combat, nowMs);
      }
    }

    if (this.mode === "team5v5") {
      if (this.teamKills("A") >= TEAM_MATCH_SCORE_LIMIT || this.teamKills("B") >= TEAM_MATCH_SCORE_LIMIT) {
        this.endMatch();
        return;
      }
    } else {
      for (const session of this.players.values()) {
        if (session.combat.kills >= MATCH_SCORE_LIMIT) {
          this.endMatch();
          return;
        }
      }
    }
    if (nowMs >= this.matchEndsAt) {
      this.endMatch();
    }
  }

  private teamKills(team: TeamId): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === team) n += p.combat.kills;
    return n;
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
            sprint: input.sprint,
            crouch: input.crouch,
            yaw: input.yaw,
            seq: input.seq,
            dt: input.dt,
          },
          this.map.blocks,
          this.map.ladders
        );
        session.weapon.update(input.dt * 1000);
        if (input.switchTo) session.weapon.switchTo(input.switchTo);
        if (input.reload) session.weapon.startReload();
        if (input.fire) this.handleFire(session, input.fireDirections ?? [], nowMs);
      }

      session.history.push({
        time: nowMs,
        position: session.physics.position,
        yaw: session.yaw,
        crouching: session.physics.crouching,
      });
    }
    session.inputQueue.length = 0;
  }

  private handleFire(shooter: PlayerSession, rawDirections: Vec3[], nowMs: number): void {
    const result = shooter.weapon.tryFire();
    if (!result.fired) return;

    const weaponDef = shooter.weapon.current;
    const origin: Vec3 = {
      x: shooter.physics.position.x,
      y: shooter.physics.position.y + eyeHeightOffset(shooter.physics.crouching),
      z: shooter.physics.position.z,
    };
    // Rewind other players to roughly where the shooter actually saw them:
    // their own network delay to us, halved for one-way, plus the render
    // interpolation delay every client applies to remote players.
    const rewindTime = nowMs - shooter.lastRttMs / 2 - INTERP_DELAY_MS;

    const pellets = rawDirections.slice(0, weaponDef.pelletCount);
    shooter.shotsFired += pellets.length;
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
    let bestZone: HitZone = "torso";
    for (const [id, target] of this.players) {
      if (id === shooter.id || !target.combat.alive) continue;
      // No friendly fire in team5v5 — shooter.team is only non-null there,
      // so this is a no-op for Duel (every other player is always fair game).
      if (shooter.team !== null && target.team === shooter.team) continue;
      const sample = target.history.sampleAt(rewindTime) ?? target.history.latest();
      if (!sample) continue;

      const hit = resolvePlayerHit(origin, dir, sample.position, nearestDist, sample.crouching);
      if (hit && hit.distance < nearestDist) {
        nearestDist = hit.distance;
        bestTarget = target;
        bestZone = hit.zone;
      }
    }

    if (!bestTarget) return;

    const headshot = bestZone === "head";
    const limbShot = bestZone === "limb";
    const damage = weaponDef.damage * damageMultiplierFor(bestZone);

    const dmg = applyDamage(bestTarget.combat, damage, nowMs);
    if (!dmg.applied) return;

    shooter.shotsHit += 1;
    shooter.damageDealt += damage;

    this.send(shooter.id, {
      type: "hit_confirmed",
      targetId: bestTarget.id,
      damage,
      killed: dmg.killed,
      headshot,
      limbShot,
    });
    this.send(bestTarget.id, { type: "damage_taken", attackerPosition: origin });

    if (dmg.killed) {
      shooter.combat.kills += 1;
      bestTarget.respawnAtMs = nowMs + RESPAWN_TIME_MS;
      this.broadcast({
        type: "kill_feed",
        killerId: shooter.id,
        victimId: bestTarget.id,
        weapon: weaponDef.id,
        headshot,
        limbShot,
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
      shotsFired: p.shotsFired,
      shotsHit: p.shotsHit,
      damageDealt: p.damageDealt,
      team: p.team ?? undefined,
    }));

    if (this.mode === "team5v5") {
      const a = this.teamKills("A");
      const b = this.teamKills("B");
      const winnerTeam: TeamId | null = a === b ? null : a > b ? "A" : "B";
      this.broadcast({ type: "match_ended", scores, winnerId: null, winnerTeam });
    } else {
      const sorted = [...scores].sort((a, b) => b.kills - a.kills);
      const winnerId = sorted.length >= 1 && (sorted.length === 1 || sorted[0].kills > sorted[1].kills) ? sorted[0].id : null;
      this.broadcast({ type: "match_ended", scores, winnerId });
    }
    setTimeout(() => this.resetToLobby(), RESULTS_DISPLAY_MS);
  }

  private resetToLobby(): void {
    this.pauseStartedAt = null;
    if (this.players.size === 0) return; // room was emptied while results were showing
    this.phase = "lobby";
    for (const p of this.players.values()) p.ready = false;
    this.broadcastLobby();
  }

  private playersSummary(): RoomPlayerSummary[] {
    return [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      ready: p.ready,
      connected: p.connected,
      kills: p.combat.kills,
      deaths: p.combat.deaths,
      team: p.team ?? undefined,
    }));
  }

  private broadcastLobby(): void {
    this.broadcast({
      type: "lobby_update",
      phase: this.phase,
      players: this.playersSummary(),
      mapId: this.mapId,
      mode: this.mode,
    });
  }

  private broadcastSnapshot(nowMs: number): void {
    const players: PlayerSnapshot[] = [...this.players.values()].map((p) => ({
      id: p.id,
      position: p.physics.position,
      velocity: p.physics.velocity,
      yaw: p.yaw,
      pitch: p.pitch,
      onGround: p.physics.onGround,
      crouching: p.physics.crouching,
      stamina: p.physics.stamina,
      staminaRegenCooldownMs: p.physics.staminaRegenCooldownMs,
      health: p.combat.health,
      alive: p.combat.alive,
      spawnProtectedUntil: p.combat.spawnProtectedUntil,
      weapon: p.weapon.currentId,
      ammo: p.weapon.currentAmmo,
      reloading: p.weapon.isReloading,
      color: p.color,
      kills: p.combat.kills,
      deaths: p.combat.deaths,
      team: p.team ?? undefined,
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
