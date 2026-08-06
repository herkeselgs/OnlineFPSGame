import {
  armHitBoxes,
  HEAD_BAND_MAX_Y,
  HEAD_BAND_MIN_Y,
  HitZone,
  LAG_COMP_HISTORY_MS,
  legHitBox,
  PositionHistory,
  Vec3,
  WeaponId,
} from "@fps/shared";
import * as THREE from "three";
import { buildCharacterModel, CharacterModel } from "../render/characterModel";

const FALLBACK_COLOR = 0x3aa0e8;
const HEAD_VISUAL_RADIUS = 0.22;
// Nudged slightly above the headshot band's midpoint so the mesh visibly
// pokes up past the shoulders instead of reading as part of the torso.
const HEAD_VISUAL_OFFSET_Y = (HEAD_BAND_MIN_Y + HEAD_BAND_MAX_Y) / 2 + 0.05;

/**
 * Visual + interpolated representation of another player. Snapshots arrive
 * at SNAPSHOT_HZ (20/s); rather than teleporting between them, we buffer a
 * short position history and render at "now minus INTERP_DELAY_MS" so
 * there are always two real samples to lerp between — smooth motion at
 * render framerate without needing to guess/extrapolate.
 *
 * `mesh`/`headMesh`/`legMesh`/`armMeshLeft`/`armMeshRight` stay plain
 * invisible primitives — CombatSystem/MatchController raycast directly
 * against these to classify head/torso/limb hits for local prediction and
 * tracer endpoints (actual damage is server-authoritative regardless, via
 * the identical box math in shared/collision.ts's resolvePlayerHit). Their
 * material is invisible (raycasting doesn't consult material visibility,
 * only geometry) and an articulated CharacterModel riding as a child of
 * `mesh` is what actually renders.
 */
export class RemotePlayer {
  readonly mesh: THREE.Mesh;
  readonly headMesh: THREE.Mesh;
  readonly legMesh: THREE.Mesh;
  readonly armMeshLeft: THREE.Mesh;
  readonly armMeshRight: THREE.Mesh;
  readonly id: string;
  name: string;
  health = 100;
  alive = true;
  weapon: WeaponId = "rifle";
  kills = 0;
  deaths = 0;

  private history = new PositionHistory(LAG_COMP_HISTORY_MS);
  private geometry: THREE.CapsuleGeometry;
  private headGeometry: THREE.SphereGeometry;
  private legGeometry: THREE.BoxGeometry;
  private armGeometry: THREE.BoxGeometry;
  private material: THREE.MeshLambertMaterial;
  private currentColor = FALLBACK_COLOR;
  private character: CharacterModel;
  private lastHealth = 100;
  private lastVelocity: Vec3 = { x: 0, y: 0, z: 0 };
  private lastPitch = 0;
  private reloading = false;

  constructor(scene: THREE.Scene, id: string, name: string) {
    this.id = id;
    this.name = name;
    this.geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.headGeometry = new THREE.SphereGeometry(HEAD_VISUAL_RADIUS, 8, 6);
    const origin = { x: 0, y: 0, z: 0 };
    const leg = legHitBox(origin);
    this.legGeometry = new THREE.BoxGeometry(leg.half.x * 2, leg.half.y * 2, leg.half.z * 2);
    const [armLeft] = armHitBoxes(origin);
    this.armGeometry = new THREE.BoxGeometry(armLeft.half.x * 2, armLeft.half.y * 2, armLeft.half.z * 2);
    this.material = new THREE.MeshLambertMaterial({ color: FALLBACK_COLOR, visible: false });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.remotePlayerRef = this;
    this.mesh.userData.hitZone = "torso" as HitZone;
    // Shares the body's (invisible) material so nothing here draws — pure
    // raycast targets now, see the class comment.
    this.headMesh = new THREE.Mesh(this.headGeometry, this.material);
    this.headMesh.userData.remotePlayerRef = this;
    this.headMesh.userData.hitZone = "head" as HitZone;
    this.legMesh = new THREE.Mesh(this.legGeometry, this.material);
    this.legMesh.userData.remotePlayerRef = this;
    this.legMesh.userData.hitZone = "limb" as HitZone;
    this.armMeshLeft = new THREE.Mesh(this.armGeometry, this.material);
    this.armMeshLeft.userData.remotePlayerRef = this;
    this.armMeshLeft.userData.hitZone = "limb" as HitZone;
    this.armMeshRight = new THREE.Mesh(this.armGeometry, this.material);
    this.armMeshRight.userData.remotePlayerRef = this;
    this.armMeshRight.userData.hitZone = "limb" as HitZone;
    for (const m of this.raycastMeshes) scene.add(m);

    this.character = buildCharacterModel(FALLBACK_COLOR);
    this.character.setHoldingWeapon(true);
    this.mesh.add(this.character.root);
  }

  /** All raycast targets belonging to this player — see MatchController's
   * ingestSnapshot, which registers these the first time this id is seen. */
  get raycastMeshes(): THREE.Mesh[] {
    return [this.mesh, this.headMesh, this.legMesh, this.armMeshLeft, this.armMeshRight];
  }

  ingestSnapshot(
    position: Vec3,
    yaw: number,
    pitch: number,
    velocity: Vec3,
    serverTimeMs: number,
    health: number,
    alive: boolean,
    weapon: WeaponId,
    color: number,
    kills: number,
    deaths: number,
    reloading: boolean
  ): void {
    this.history.push({ time: serverTimeMs, position, yaw });
    if (health < this.lastHealth && alive) this.character.flashHit();
    this.lastHealth = health;
    this.health = health;
    this.alive = alive;
    this.weapon = weapon;
    this.kills = kills;
    this.deaths = deaths;
    this.lastVelocity = velocity;
    this.lastPitch = pitch;
    this.reloading = reloading;
    this.character.setWeapon(weapon);
    if (color !== this.currentColor) {
      this.currentColor = color;
      this.material.color.setHex(color);
      this.character.setColor(color);
    }
  }

  update(renderServerTimeMs: number, frameDtMs: number): void {
    const sample = this.history.sampleAt(renderServerTimeMs);
    if (sample) {
      this.mesh.position.set(sample.position.x, sample.position.y, sample.position.z);
      this.mesh.rotation.y = sample.yaw;
      this.headMesh.position.set(sample.position.x, sample.position.y + HEAD_VISUAL_OFFSET_Y, sample.position.z);
      const leg = legHitBox(sample.position);
      this.legMesh.position.set(leg.center.x, leg.center.y, leg.center.z);
      const [armLeft, armRight] = armHitBoxes(sample.position);
      this.armMeshLeft.position.set(armLeft.center.x, armLeft.center.y, armLeft.center.z);
      this.armMeshRight.position.set(armRight.center.x, armRight.center.y, armRight.center.z);
    }
    const speed = Math.hypot(this.lastVelocity.x, this.lastVelocity.z);
    this.character.updateAnimation(frameDtMs, speed, this.lastPitch, this.reloading);
    for (const m of this.raycastMeshes) m.visible = this.alive;
  }

  dispose(scene: THREE.Scene): void {
    for (const m of this.raycastMeshes) scene.remove(m);
    this.geometry.dispose();
    this.headGeometry.dispose();
    this.legGeometry.dispose();
    this.armGeometry.dispose();
    this.material.dispose();
    this.character.dispose();
  }
}
