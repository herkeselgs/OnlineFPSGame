import { HEAD_BAND_MAX_Y, HEAD_BAND_MIN_Y, LAG_COMP_HISTORY_MS, PositionHistory, Vec3, WeaponId } from "@fps/shared";
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
 * `mesh`/`headMesh` stay exactly the plain capsule + sphere they always
 * were — CombatSystem/MatchController raycast directly against these two
 * objects to classify body vs. headshot, so their geometry/position must
 * never change. What DOES change: their material is now invisible
 * (raycasting doesn't consult material visibility, only geometry — hiding
 * them costs nothing functionally) and an articulated CharacterModel
 * riding as a child of `mesh` is what actually renders, replacing the old
 * flat capsule-and-ball look with a proper head/torso/arms/legs silhouette
 * holding a gun.
 */
export class RemotePlayer {
  readonly mesh: THREE.Mesh;
  readonly headMesh: THREE.Mesh;
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
  private material: THREE.MeshLambertMaterial;
  private currentColor = FALLBACK_COLOR;
  private character: CharacterModel;
  private lastHealth = 100;
  private lastVelocity: Vec3 = { x: 0, y: 0, z: 0 };
  private lastPitch = 0;

  constructor(scene: THREE.Scene, id: string, name: string) {
    this.id = id;
    this.name = name;
    this.geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.headGeometry = new THREE.SphereGeometry(HEAD_VISUAL_RADIUS, 8, 6);
    this.material = new THREE.MeshLambertMaterial({ color: FALLBACK_COLOR, visible: false });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.remotePlayerRef = this;
    // Shares the body's (invisible) material so nothing here draws — pure
    // raycast targets now, see the class comment.
    this.headMesh = new THREE.Mesh(this.headGeometry, this.material);
    this.headMesh.userData.remotePlayerRef = this;
    scene.add(this.mesh);
    scene.add(this.headMesh);

    this.character = buildCharacterModel(FALLBACK_COLOR);
    this.character.setHoldingWeapon(true);
    this.mesh.add(this.character.root);
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
    deaths: number
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
    }
    const speed = Math.hypot(this.lastVelocity.x, this.lastVelocity.z);
    this.character.updateAnimation(frameDtMs, speed, this.lastPitch);
    this.mesh.visible = this.alive;
    this.headMesh.visible = this.alive;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    scene.remove(this.headMesh);
    this.geometry.dispose();
    this.headGeometry.dispose();
    this.material.dispose();
    this.character.dispose();
  }
}
