import {
  BoxCollider,
  INTERP_DELAY_MS,
  MAX_HEALTH,
  PlayerId,
  PlayerSnapshot,
  RESPAWN_TIME_MS,
  RoomMode,
  ServerMessage,
  SpawnPoint,
  STAMINA_LOW_THRESHOLD,
  STAMINA_MAX,
  Vec3,
} from "@fps/shared";
import * as THREE from "three";
import { soundEngine } from "../audio/SoundEngine";
import { feelFor } from "../combat/weaponFeel";
import { InputManager } from "../engine/InputManager";
import { NetClient } from "../net/NetClient";
import { MuzzleFlashEffect, ScreenShake, TracerPool } from "../render/effects";
import { Viewmodel } from "../render/viewmodel";
import { Hud } from "../ui/Hud";
import { ClockSync } from "../net/ClockSync";
import { LocalFireEvent, PredictionController } from "./PredictionController";
import { RemotePlayer } from "./RemotePlayer";

const PING_INTERVAL_MS = 2000;

/**
 * Owns everything for the duration of one live match: the local player's
 * predicted/reconciled state, every remote player's interpolated state,
 * local-only visual effects (tracers/flash/shake — cosmetic, spawned from
 * the client's own prediction, never authoritative), and HUD updates driven
 * by server snapshots and events.
 */
export class MatchController {
  readonly prediction: PredictionController;

  private remotePlayersMap = new Map<PlayerId, RemotePlayer>();
  private playerNames: Map<PlayerId, string>;
  private clock = new ClockSync();
  private tracers: TracerPool;
  private muzzleFlash: MuzzleFlashEffect;
  private viewmodel: Viewmodel;
  private shake = new ScreenShake();
  private raycaster = new THREE.Raycaster();
  private raycastables: THREE.Object3D[];
  private unsubscribe: () => void;
  private pingTimer: ReturnType<typeof setInterval>;
  private matchDurationMs = 0;
  private matchStartServerTime = 0;
  private wasAlive = true;
  private localDeathAtMs = 0;
  private lastHealth = MAX_HEALTH;
  private firstBloodClaimed = false;
  private killStreaks = new Map<PlayerId, number>();

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    input: InputManager,
    private net: NetClient,
    private hud: Hud,
    private selfId: PlayerId,
    playerNames: Map<PlayerId, string>,
    mapMeshes: THREE.Mesh[],
    spawn: SpawnPoint,
    colliders: readonly BoxCollider[],
    ladders: readonly BoxCollider[] = [],
    private mode: RoomMode = "duel"
  ) {
    this.playerNames = playerNames;
    this.prediction = new PredictionController(spawn, colliders, input, net, camera, ladders);
    this.tracers = new TracerPool(scene);
    this.muzzleFlash = new MuzzleFlashEffect(camera);
    this.viewmodel = new Viewmodel(camera);
    this.raycastables = [...mapMeshes];

    this.unsubscribe = net.onMessage((msg) => this.handleMessage(msg as ServerMessage));
    this.pingTimer = setInterval(() => net.send({ type: "ping", t: Date.now() }), PING_INTERVAL_MS);
    net.send({ type: "ping", t: Date.now() });
  }

  update(frameDt: number): void {
    const fireEvents = this.prediction.update(frameDt);
    for (const ev of fireEvents) this.spawnLocalFireEffects(ev);

    const renderTime = this.clock.estimateServerTime() - INTERP_DELAY_MS;
    for (const rp of this.remotePlayersMap.values()) rp.update(renderTime, frameDt * 1000);

    this.tracers.update(frameDt * 1000);
    this.muzzleFlash.update(frameDt * 1000);
    const w = this.prediction.weapon;
    this.viewmodel.setWeapon(w.currentId);
    this.viewmodel.update(frameDt * 1000, w.isReloading, w.reloadProgress);
    this.shake.update(frameDt);
    this.hud.update(frameDt * 1000);

    this.hud.updateWeapon(w.current.name, w.currentAmmo, w.current.magazineSize, w.isReloading);
    this.hud.updateHealth(this.prediction.combat.health);
    this.hud.updatePing(this.prediction.rttEstimate);
    this.hud.updateSpawnProtection(this.prediction.combat.spawnProtectedUntil - this.clock.estimateServerTime());
    this.hud.updateStamina(this.prediction.physics.stamina, STAMINA_MAX, this.prediction.physics.stamina < STAMINA_LOW_THRESHOLD);

    if (this.prediction.combat.health < this.lastHealth) {
      this.hud.flashDamage();
      this.shake.addTrauma(0.22);
      soundEngine.playDamageTaken();
    }
    this.lastHealth = this.prediction.combat.health;

    const alive = this.prediction.combat.alive;
    if (this.wasAlive && !alive) this.localDeathAtMs = Date.now();
    if (!this.wasAlive && alive) soundEngine.playRespawn();
    this.wasAlive = alive;
    const respawnInMs = RESPAWN_TIME_MS - (Date.now() - this.localDeathAtMs);
    this.hud.setDead(!alive, respawnInMs);

    this.updateScoreAndTimer();
  }

  getShakeOffset(): { yaw: number; pitch: number; roll: number } {
    return { yaw: this.shake.offsetYaw, pitch: this.shake.offsetPitch, roll: this.shake.offsetRoll };
  }

  get remotePlayers(): ReadonlyMap<PlayerId, RemotePlayer> {
    return this.remotePlayersMap;
  }

  dispose(): void {
    this.unsubscribe();
    clearInterval(this.pingTimer);
    for (const rp of this.remotePlayersMap.values()) rp.dispose(this.scene);
    this.remotePlayersMap.clear();
    this.viewmodel.dispose(this.camera);
    this.hud.hideMatchInfo();
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "pong":
        this.prediction.setRttEstimate(Math.max(0, Date.now() - msg.t));
        break;
      case "snapshot":
        this.clock.ingestServerTime(msg.serverTime);
        this.ingestSnapshot(msg.serverTime, msg.players);
        break;
      case "match_started":
        this.matchDurationMs = msg.durationMs;
        this.matchStartServerTime = msg.serverTime;
        this.clock.ingestServerTime(msg.serverTime);
        break;
      case "hit_confirmed":
        this.hud.flashHitmarker(msg.killed, msg.headshot);
        soundEngine.playHitmarker(msg.killed, msg.headshot);
        break;
      case "damage_taken":
        this.hud.showDamageDirection(this.relativeAngleTo(msg.attackerPosition));
        break;
      case "kill_feed":
        this.pushKillFeed(msg.killerId, msg.victimId, msg.headshot, msg.limbShot);
        break;
      default:
        break;
    }
  }

  private ingestSnapshot(serverTimeMs: number, players: PlayerSnapshot[]): void {
    for (const p of players) {
      if (p.id === this.selfId) {
        this.prediction.applyServerSnapshot(p);
        continue;
      }
      let rp = this.remotePlayersMap.get(p.id);
      if (!rp) {
        rp = new RemotePlayer(this.scene, p.id, this.playerNames.get(p.id) ?? "Player");
        this.remotePlayersMap.set(p.id, rp);
        this.raycastables.push(...rp.raycastMeshes);
      }
      rp.ingestSnapshot(
        p.position,
        p.yaw,
        p.pitch,
        p.velocity,
        serverTimeMs,
        p.health,
        p.alive,
        p.weapon,
        p.color,
        p.kills,
        p.deaths,
        p.reloading,
        p.crouching,
        p.team ?? null
      );
    }
  }

  private spawnLocalFireEffects(ev: LocalFireEvent): void {
    this.muzzleFlash.trigger();
    this.viewmodel.triggerRecoil();
    const feel = feelFor(ev.weapon.id);
    this.shake.addTrauma(feel.trauma);
    this.shake.addKick(feel.kick);
    for (const dir of ev.directions) {
      this.raycaster.set(ev.origin, dir);
      this.raycaster.far = ev.weapon.range;
      const hits = this.raycaster.intersectObjects(this.raycastables, false);
      const endPoint =
        hits.length > 0 ? hits[0].point : ev.origin.clone().addScaledVector(dir, ev.weapon.range);
      this.tracers.spawn(ev.origin, endPoint);
    }
  }

  /** [kill count, callout label] — checked as an exact match (not a
   * threshold), so each tier fires exactly once per streak rather than
   * re-announcing "on a rampage" on every kill from 3 onward. */
  private static readonly STREAK_TIERS: [number, string][] = [
    [3, "is on a rampage"],
    [5, "is unstoppable"],
  ];

  private pushKillFeed(killerId: PlayerId | null, victimId: PlayerId, headshot: boolean, limbShot: boolean): void {
    const name = (id: PlayerId) => (id === this.selfId ? "You" : this.playerNames.get(id) ?? "Player");
    const suffix = headshot ? " (headshot)" : limbShot ? " (limb shot)" : "";

    if (!this.firstBloodClaimed) {
      this.firstBloodClaimed = true;
      soundEngine.playAnnouncer("first-blood");
      const killerLabel = killerId ? (killerId === this.selfId ? "You" : name(killerId)) : "World";
      const victimLabel = victimId === this.selfId ? "you" : name(victimId);
      this.hud.pushFeed(`First blood — ${killerLabel} eliminated ${victimLabel}${suffix}`);
    } else if (killerId === this.selfId) {
      this.hud.pushFeed(`You eliminated ${name(victimId)}${suffix}`);
    } else if (victimId === this.selfId) {
      this.hud.pushFeed(`${killerId ? name(killerId) : "World"} eliminated you${suffix}`);
    } else {
      this.hud.pushFeed(`${killerId ? name(killerId) : "World"} eliminated ${name(victimId)}${suffix}`);
    }

    this.killStreaks.set(victimId, 0);
    if (killerId) {
      const streak = (this.killStreaks.get(killerId) ?? 0) + 1;
      this.killStreaks.set(killerId, streak);
      const tier = MatchController.STREAK_TIERS.find(([count]) => count === streak);
      if (tier) {
        soundEngine.playAnnouncer("streak");
        this.hud.pushFeed(`${name(killerId)} ${tier[1]}! (${streak} kills)`);
      }
    }
  }

  /** Angle (radians) from the local player's current facing to `attackerPos`
   * — 0 means directly ahead, positive means to the right (so it can feed
   * straight into a clockwise-positive CSS rotate()).
   *
   * `Math.atan2(-dx, -dz)` (used all over this codebase's "aim at point P"
   * helpers) gives the yaw VALUE that would face P, not the on-screen
   * turn direction — and in this engine decreasing yaw turns you right
   * (PredictionController does `yaw -= look.yaw` for a rightward mouse
   * delta). So "target yaw minus current yaw" is negative exactly when the
   * target is to the right, the opposite of what a clockwise-positive CSS
   * rotation needs — hence current-minus-target below, not the other way
   * around. (Worth spelling out because it's the kind of sign flip that's
   * easy to silently get backwards and only notice by actually looking at
   * the result.) */
  private relativeAngleTo(attackerPos: Vec3): number {
    const self = this.prediction.physics.position;
    const dx = attackerPos.x - self.x;
    const dz = attackerPos.z - self.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return 0;
    const yawToFaceAttacker = Math.atan2(-dx / len, -dz / len);
    // Same wrap-to-(-PI,PI] pattern as vec.ts's lerpAngle -- JS's % can
    // return a negative remainder, so the naive one-line version doesn't
    // actually stay in range for every input.
    let relative = ((this.prediction.yaw - yawToFaceAttacker + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (relative < -Math.PI) relative += Math.PI * 2;
    return relative;
  }

  private updateScoreAndTimer(): void {
    if (this.mode === "team5v5") {
      // Sum kills across everyone on each side (self + every remote player
      // sharing that team), rather than the single-opponent 1v1 readout —
      // team5v5 can have up to 9 other players, not one.
      let teamAKills = 0;
      let teamBKills = 0;
      if (this.prediction.team === "A") teamAKills += this.prediction.combat.kills;
      else if (this.prediction.team === "B") teamBKills += this.prediction.combat.kills;
      for (const rp of this.remotePlayersMap.values()) {
        if (rp.team === "A") teamAKills += rp.kills;
        else if (rp.team === "B") teamBKills += rp.kills;
      }
      this.hud.updateScore("Team A", teamAKills, "Team B", teamBKills);
    } else {
      const selfName = "You";
      let oppName = "Opponent";
      let oppKills = 0;
      for (const rp of this.remotePlayersMap.values()) {
        oppName = rp.name;
        oppKills = rp.kills;
        break;
      }
      this.hud.updateScore(selfName, this.prediction.combat.kills, oppName, oppKills);
    }

    if (this.matchDurationMs > 0) {
      const elapsed = this.clock.estimateServerTime() - this.matchStartServerTime;
      this.hud.updateTimer(this.matchDurationMs - elapsed);
    }
  }
}
