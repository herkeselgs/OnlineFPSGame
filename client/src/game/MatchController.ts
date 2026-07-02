import {
  BoxCollider,
  INTERP_DELAY_MS,
  PlayerId,
  PlayerSnapshot,
  RESPAWN_TIME_MS,
  ServerMessage,
  SpawnPoint,
} from "@fps/shared";
import * as THREE from "three";
import { InputManager } from "../engine/InputManager";
import { NetClient } from "../net/NetClient";
import { MuzzleFlashEffect, ScreenShake, TracerPool } from "../render/effects";
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
  private shake = new ScreenShake();
  private raycaster = new THREE.Raycaster();
  private raycastables: THREE.Object3D[];
  private unsubscribe: () => void;
  private pingTimer: ReturnType<typeof setInterval>;
  private matchDurationMs = 0;
  private matchStartServerTime = 0;
  private wasAlive = true;
  private localDeathAtMs = 0;

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
    colliders: readonly BoxCollider[]
  ) {
    this.playerNames = playerNames;
    this.prediction = new PredictionController(spawn, colliders, input, net, camera);
    this.tracers = new TracerPool(scene);
    this.muzzleFlash = new MuzzleFlashEffect(camera);
    this.raycastables = [...mapMeshes];

    this.unsubscribe = net.onMessage((msg) => this.handleMessage(msg));
    this.pingTimer = setInterval(() => net.send({ type: "ping", t: Date.now() }), PING_INTERVAL_MS);
    net.send({ type: "ping", t: Date.now() });
  }

  update(frameDt: number): void {
    const fireEvents = this.prediction.update(frameDt);
    for (const ev of fireEvents) this.spawnLocalFireEffects(ev);

    const renderTime = this.clock.estimateServerTime() - INTERP_DELAY_MS;
    for (const rp of this.remotePlayersMap.values()) rp.update(renderTime);

    this.tracers.update(frameDt * 1000);
    this.muzzleFlash.update(frameDt * 1000);
    this.shake.update(frameDt);
    this.hud.update(frameDt * 1000);

    const w = this.prediction.weapon;
    this.hud.updateWeapon(w.current.name, w.currentAmmo, w.current.magazineSize, w.isReloading);
    this.hud.updateHealth(this.prediction.combat.health);

    const alive = this.prediction.combat.alive;
    if (this.wasAlive && !alive) this.localDeathAtMs = Date.now();
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
        this.hud.flashHitmarker(msg.killed);
        break;
      case "kill_feed":
        this.pushKillFeed(msg.killerId, msg.victimId);
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
        this.raycastables.push(rp.mesh);
      }
      rp.ingestSnapshot(p.position, p.yaw, serverTimeMs, p.health, p.alive, p.weapon, p.kills, p.deaths);
    }
  }

  private spawnLocalFireEffects(ev: LocalFireEvent): void {
    this.muzzleFlash.trigger();
    this.shake.addTrauma(0.18);
    for (const dir of ev.directions) {
      this.raycaster.set(ev.origin, dir);
      this.raycaster.far = ev.weapon.range;
      const hits = this.raycaster.intersectObjects(this.raycastables, false);
      const endPoint =
        hits.length > 0 ? hits[0].point : ev.origin.clone().addScaledVector(dir, ev.weapon.range);
      this.tracers.spawn(ev.origin, endPoint);
    }
  }

  private pushKillFeed(killerId: PlayerId | null, victimId: PlayerId): void {
    const name = (id: PlayerId) => (id === this.selfId ? "You" : this.playerNames.get(id) ?? "Player");
    if (killerId === this.selfId) this.hud.pushFeed(`You eliminated ${name(victimId)}`);
    else if (victimId === this.selfId) this.hud.pushFeed(`${killerId ? name(killerId) : "World"} eliminated you`);
    else this.hud.pushFeed(`${killerId ? name(killerId) : "World"} eliminated ${name(victimId)}`);
  }

  private updateScoreAndTimer(): void {
    const selfName = "You";
    let oppName = "Opponent";
    let oppKills = 0;
    for (const rp of this.remotePlayersMap.values()) {
      oppName = rp.name;
      oppKills = rp.kills;
      break;
    }
    this.hud.updateScore(selfName, this.prediction.combat.kills, oppName, oppKills);

    if (this.matchDurationMs > 0) {
      const elapsed = this.clock.estimateServerTime() - this.matchStartServerTime;
      this.hud.updateTimer(this.matchDurationMs - elapsed);
    }
  }
}
