import {
  applyDamage,
  BoxCollider,
  createPlayerCombatState,
  damageMultiplierFor,
  HitZone,
  MapDefinition,
  MATCH_DURATION_MS,
  MATCH_SCORE_LIMIT,
  PlayerCombatState,
  rayIntersectsBox,
  resolvePlayerHit,
  respawn,
  RESPAWN_TIME_MS,
  Vec3,
  WEAPONS,
  WeaponState,
} from "@fps/shared";
import * as THREE from "three";
import { soundEngine } from "../audio/SoundEngine";
import { feelFor } from "../combat/weaponFeel";
import { randomSpreadDirection } from "../combat/spread";
import { InputManager } from "../engine/InputManager";
import { PlayerController } from "../engine/PlayerController";
import { MuzzleFlashEffect, ScreenShake, TracerPool } from "../render/effects";
import { Viewmodel } from "../render/viewmodel";
import { Hud } from "../ui/Hud";
import { Bot } from "./Bot";
import { BOT_DIFFICULTIES, BotDifficultyLevel } from "./botDifficulty";

const SWITCH_KEYS: Record<string, "rifle" | "smg" | "shotgun"> = {
  Digit1: "rifle",
  Digit2: "smg",
  Digit3: "shotgun",
};
const BOT_WEAPON = WEAPONS.rifle;

export interface BotMatchResult {
  playerKills: number;
  botKills: number;
  reason: "score" | "time";
}

/**
 * Solo "vs Computer" mode — structurally a hybrid of PracticeMode (local
 * authoritative player physics/weapon, no server) and MatchController
 * (the full Duel HUD experience: score, timer, kill feed, damage
 * direction, spawn protection, respawns), fighting a single AI-controlled
 * Bot instead of either practice dummies or a networked opponent. Nothing
 * here is shared with either of those classes — same sibling-class
 * reasoning as Duel vs. Imposter: threading a third mode's needs through
 * either existing class would risk both of them for a mode that has a
 * fundamentally different opponent model (an AI decision loop instead of
 * a stationary dummy or a remote player's snapshots).
 */
export class BotMode {
  readonly player: PlayerController;
  readonly bot: Bot;
  readonly playerCombat: PlayerCombatState = createPlayerCombatState();
  readonly weapon = new WeaponState();

  private raycaster = new THREE.Raycaster();
  private raycastables: THREE.Object3D[];
  private tracers: TracerPool;
  private muzzleFlash: MuzzleFlashEffect;
  private viewmodel: Viewmodel;
  private shake = new ScreenShake();

  private difficulty: BotDifficultyLevel;
  private matchStartMs = Date.now();
  private matchEnded = false;
  private localDeathAtMs = 0;
  private botDeathAtMs = 0;
  private wasAlive = true;
  private botWasAlive = true;
  private lastHealth = 100;
  private firstBloodClaimed = false;
  private playerStreak = 0;
  private botStreak = 0;
  private wasReloading = false;
  private lowAmmoWarned = false;
  private lastAmmoForWarning = -1;
  private lastWeaponIdForWarning: string | null = null;

  private readonly playerSpawnPosition: Vec3;
  private readonly playerSpawnYaw: number;
  private readonly mapBlocks: readonly BoxCollider[];

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private input: InputManager,
    private hud: Hud,
    map: MapDefinition,
    mapMeshes: THREE.Mesh[],
    difficulty: BotDifficultyLevel,
    private onMatchEnd: (result: BotMatchResult) => void
  ) {
    this.difficulty = difficulty;
    this.mapBlocks = map.blocks;
    const playerSpawn = map.spawns[0];
    const botSpawn = map.spawns[1] ?? map.spawns[0];
    this.playerSpawnPosition = { ...playerSpawn.position };
    this.playerSpawnYaw = playerSpawn.yaw;

    this.player = new PlayerController(playerSpawn, map.blocks, input, map.ladders);
    this.bot = new Bot(scene, botSpawn, map.blocks, map.ladders);

    this.muzzleFlash = new MuzzleFlashEffect(camera);
    this.viewmodel = new Viewmodel(camera);
    this.viewmodel.setVisible(true);
    this.tracers = new TracerPool(scene);
    this.raycastables = [...mapMeshes, ...this.bot.raycastMeshes];

    soundEngine.startAmbient();
  }

  update(frameDt: number): void {
    const nowMs = Date.now();

    this.player.update(frameDt);
    const eye = this.player.getEyePosition();
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.x = this.player.pitch;
    this.camera.rotation.y = this.player.yaw;
    this.camera.rotation.z = 0;

    this.weapon.update(frameDt * 1000);
    this.tracers.update(frameDt * 1000);
    this.muzzleFlash.update(frameDt * 1000);
    this.viewmodel.setWeapon(this.weapon.currentId);
    this.viewmodel.update(frameDt * 1000, this.weapon.isReloading, this.weapon.reloadProgress);
    this.shake.update(frameDt);
    this.hud.update(frameDt * 1000);
    this.handlePlayerWeaponInput();

    const fireEvent = this.bot.update(frameDt, nowMs, BOT_DIFFICULTIES[this.difficulty], this.player.state.position, this.playerCombat.alive);
    if (fireEvent) this.resolveBotShot(fireEvent);

    this.hud.updateWeapon(this.weapon.current.name, this.weapon.currentAmmo, this.weapon.current.magazineSize, this.weapon.isReloading);
    this.hud.updateHealth(this.playerCombat.health);
    this.hud.updateSpawnProtection(this.playerCombat.spawnProtectedUntil - nowMs);

    if (this.playerCombat.health < this.lastHealth) {
      this.hud.flashDamage();
      this.shake.addTrauma(0.22);
      soundEngine.playDamageTaken();
    }
    this.lastHealth = this.playerCombat.health;

    if (this.wasAlive && !this.playerCombat.alive) this.localDeathAtMs = nowMs;
    if (!this.wasAlive && this.playerCombat.alive) soundEngine.playRespawn();
    this.wasAlive = this.playerCombat.alive;
    this.hud.setDead(!this.playerCombat.alive, RESPAWN_TIME_MS - (nowMs - this.localDeathAtMs));

    if (!this.playerCombat.alive && nowMs - this.localDeathAtMs >= RESPAWN_TIME_MS) {
      respawn(this.playerCombat, nowMs);
      this.player.state = { position: { ...this.playerSpawnPosition }, velocity: { x: 0, y: 0, z: 0 }, onGround: false };
      this.player.yaw = this.playerSpawnYaw;
      this.player.pitch = 0;
    }
    if (!this.bot.combat.alive && nowMs - this.botDeathAtMs >= RESPAWN_TIME_MS) {
      this.bot.respawnAt(nowMs);
    }
    this.botWasAlive = this.bot.combat.alive;

    this.hud.updateScore("You", this.playerCombat.kills, "Bot", this.bot.combat.kills);
    const elapsed = nowMs - this.matchStartMs;
    this.hud.updateTimer(MATCH_DURATION_MS - elapsed);

    if (!this.matchEnded) {
      if (this.playerCombat.kills >= MATCH_SCORE_LIMIT || this.bot.combat.kills >= MATCH_SCORE_LIMIT) {
        this.endMatch("score");
      } else if (elapsed >= MATCH_DURATION_MS) {
        this.endMatch("time");
      }
    }
  }

  getShakeOffset(): { yaw: number; pitch: number; roll: number } {
    return { yaw: this.shake.offsetYaw, pitch: this.shake.offsetPitch, roll: this.shake.offsetRoll };
  }

  dispose(): void {
    soundEngine.stopAmbient();
    this.bot.dispose(this.scene);
    this.viewmodel.dispose(this.camera);
    this.hud.hideMatchInfo();
  }

  private handlePlayerWeaponInput(): void {
    for (const [code, id] of Object.entries(SWITCH_KEYS)) {
      if (this.input.consumeJustPressed(code)) this.weapon.switchTo(id);
    }
    if (this.input.consumeJustPressed("KeyR")) this.weapon.startReload();

    if (this.weapon.isReloading !== this.wasReloading) {
      if (this.weapon.isReloading) soundEngine.playReloadStart();
      else soundEngine.playReloadFinish();
      this.wasReloading = this.weapon.isReloading;
    }

    const ammo = this.weapon.currentAmmo;
    const weaponId = this.weapon.currentId;
    if (weaponId !== this.lastWeaponIdForWarning || ammo > this.lastAmmoForWarning) this.lowAmmoWarned = false;
    const lowThreshold = Math.max(2, Math.ceil(this.weapon.current.magazineSize * 0.15));
    if (!this.lowAmmoWarned && ammo > 0 && ammo <= lowThreshold) {
      this.lowAmmoWarned = true;
      soundEngine.playLowAmmo();
    }
    this.lastAmmoForWarning = ammo;
    this.lastWeaponIdForWarning = weaponId;

    const clickEdge = this.input.consumeJustPressed("Mouse0");
    const def = this.weapon.current;
    const wantsFire = def.fireMode === "auto" ? this.input.firing : clickEdge;
    if (wantsFire && this.playerCombat.alive) this.tryPlayerFire();
  }

  private tryPlayerFire(): void {
    const result = this.weapon.tryFire();
    if (!result.fired) return;

    this.muzzleFlash.trigger();
    this.viewmodel.triggerRecoil();
    const def = this.weapon.current;
    const feel = feelFor(def.id);
    this.shake.addTrauma(feel.trauma);
    this.shake.addKick(feel.kick);
    soundEngine.playShot(def.id);

    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);

    let anyHit = false;
    let anyKill = false;
    let anyHeadshot = false;
    let anyLimbShot = false;

    for (let i = 0; i < result.pelletCount; i++) {
      const dir = randomSpreadDirection(forward, right, up, def.spreadRadians);
      this.raycaster.set(origin, dir);
      this.raycaster.far = def.range;
      const hits = this.raycaster.intersectObjects(this.raycastables, false);

      const endPoint = hits.length > 0 ? hits[0].point : origin.clone().addScaledVector(dir, def.range);
      this.tracers.spawn(origin, endPoint);

      if (hits.length === 0) continue;
      if (hits[0].object.userData.botRef !== this.bot) continue; // hit a wall, not the bot

      const zone = (hits[0].object.userData.hitZone as HitZone | undefined) ?? "torso";
      const damage = def.damage * damageMultiplierFor(zone);
      const dmg = this.bot.applyDamage(damage, Date.now());
      if (!dmg.applied) continue;

      anyHit = true;
      if (zone === "head") anyHeadshot = true;
      if (zone === "limb") anyLimbShot = true;
      if (dmg.killed) {
        anyKill = true;
        this.playerCombat.kills += 1;
        this.botDeathAtMs = Date.now();
        this.pushKillFeed(true, anyHeadshot, anyLimbShot);
      }
    }

    if (anyHit) {
      soundEngine.playHitmarker(anyKill, anyHeadshot);
      this.hud.flashHitmarker(anyKill, anyHeadshot);
    }
  }

  /** Mirrors Room.ts's resolvePellet — same box-based zone classification
   * and map-obstruction check a real server would run, just resolved
   * locally since there's no server for a solo bot match. */
  private resolveBotShot(ev: { origin: Vec3; dir: Vec3 }): void {
    let nearestDist = BOT_WEAPON.range;
    for (const block of this.mapBlocks) {
      const d = rayIntersectsBox(ev.origin, ev.dir, block, nearestDist);
      if (d !== null && d < nearestDist) nearestDist = d;
    }

    const hit = resolvePlayerHit(ev.origin, ev.dir, this.player.state.position, nearestDist);
    const travelDist = hit ? hit.distance : nearestDist;
    const from = new THREE.Vector3(ev.origin.x, ev.origin.y, ev.origin.z);
    const to = from.clone().add(new THREE.Vector3(ev.dir.x, ev.dir.y, ev.dir.z).multiplyScalar(travelDist));
    this.tracers.spawn(from, to);

    if (!hit) return;
    const damage = BOT_WEAPON.damage * damageMultiplierFor(hit.zone);
    const dmg = applyDamage(this.playerCombat, damage, Date.now());
    if (!dmg.applied) return;

    this.hud.showDamageDirection(this.relativeAngleTo(ev.origin));

    if (dmg.killed) {
      this.bot.combat.kills += 1;
      this.localDeathAtMs = Date.now();
      this.pushKillFeed(false, hit.zone === "head", hit.zone === "limb");
    }
  }

  private relativeAngleTo(attackerPos: Vec3): number {
    const self = this.player.state.position;
    const dx = attackerPos.x - self.x;
    const dz = attackerPos.z - self.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return 0;
    const yawToFaceAttacker = Math.atan2(-dx / len, -dz / len);
    let relative = ((this.player.yaw - yawToFaceAttacker + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (relative < -Math.PI) relative += Math.PI * 2;
    return relative;
  }

  private pushKillFeed(playerKilled: boolean, headshot: boolean, limbShot: boolean): void {
    const suffix = headshot ? " (headshot)" : limbShot ? " (limb shot)" : "";
    if (!this.firstBloodClaimed) {
      this.firstBloodClaimed = true;
      soundEngine.playAnnouncer("first-blood");
      this.hud.pushFeed(playerKilled ? `First blood — You eliminated Bot${suffix}` : `First blood — Bot eliminated you${suffix}`);
    } else if (playerKilled) {
      this.hud.pushFeed(`You eliminated Bot${suffix}`);
    } else {
      this.hud.pushFeed(`Bot eliminated you${suffix}`);
    }

    if (playerKilled) {
      this.playerStreak += 1;
      this.botStreak = 0;
      if (this.playerStreak === 3) {
        soundEngine.playAnnouncer("streak");
        this.hud.pushFeed(`You are on a rampage! (${this.playerStreak} kills)`);
      } else if (this.playerStreak === 5) {
        soundEngine.playAnnouncer("streak");
        this.hud.pushFeed(`You are unstoppable! (${this.playerStreak} kills)`);
      }
    } else {
      this.botStreak += 1;
      this.playerStreak = 0;
      if (this.botStreak === 3) {
        soundEngine.playAnnouncer("streak");
        this.hud.pushFeed(`Bot is on a rampage! (${this.botStreak} kills)`);
      } else if (this.botStreak === 5) {
        soundEngine.playAnnouncer("streak");
        this.hud.pushFeed(`Bot is unstoppable! (${this.botStreak} kills)`);
      }
    }
  }

  private endMatch(reason: "score" | "time"): void {
    this.matchEnded = true;
    this.onMatchEnd({ playerKills: this.playerCombat.kills, botKills: this.bot.combat.kills, reason });
  }
}
