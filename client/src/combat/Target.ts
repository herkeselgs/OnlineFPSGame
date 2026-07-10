import { HEAD_BAND_MAX_Y, HEAD_BAND_MIN_Y, MAX_HEALTH, RESPAWN_TIME_MS, Vec3 } from "@fps/shared";
import * as THREE from "three";

const BODY_COLOR = 0xe0563a;
const FLASH_COLOR = 0xffffff;
const FLASH_DURATION_MS = 90;
const HEAD_VISUAL_RADIUS = 0.22;
const HEAD_VISUAL_OFFSET_Y = (HEAD_BAND_MIN_Y + HEAD_BAND_MAX_Y) / 2 + 0.05;

/**
 * Stationary practice dummy for testing hit detection before real players
 * exist. Capsule silhouette roughly matches real player dimensions so aim
 * habits transfer once multiplayer lands.
 */
export class Target {
  readonly mesh: THREE.Mesh;
  readonly headMesh: THREE.Mesh;
  health = MAX_HEALTH;
  alive = true;

  private geometry: THREE.CapsuleGeometry;
  private headGeometry: THREE.SphereGeometry;
  private material: THREE.MeshLambertMaterial;
  private flashRemainingMs = 0;
  private respawnRemainingMs = 0;
  private readonly spawnPosition: Vec3;

  constructor(scene: THREE.Scene, position: Vec3) {
    this.spawnPosition = { ...position };
    this.geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.headGeometry = new THREE.SphereGeometry(HEAD_VISUAL_RADIUS, 8, 6);
    this.material = new THREE.MeshLambertMaterial({ color: BODY_COLOR });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.set(position.x, position.y, position.z);
    this.mesh.userData.targetRef = this;
    // Shares the body's material so the hit-flash (color swap) hits both
    // meshes for free.
    this.headMesh = new THREE.Mesh(this.headGeometry, this.material);
    this.headMesh.position.set(position.x, position.y + HEAD_VISUAL_OFFSET_Y, position.z);
    this.headMesh.userData.targetRef = this;
    scene.add(this.mesh);
    scene.add(this.headMesh);
  }

  /** Returns true if this shot killed the target. */
  applyDamage(amount: number): boolean {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    this.flashRemainingMs = FLASH_DURATION_MS;
    this.material.color.setHex(FLASH_COLOR);

    if (this.health <= 0) {
      this.alive = false;
      this.mesh.visible = false;
      this.headMesh.visible = false;
      this.respawnRemainingMs = RESPAWN_TIME_MS;
      return true;
    }
    return false;
  }

  update(dtMs: number): void {
    if (this.flashRemainingMs > 0) {
      this.flashRemainingMs -= dtMs;
      if (this.flashRemainingMs <= 0) this.material.color.setHex(BODY_COLOR);
    }

    if (!this.alive) {
      this.respawnRemainingMs -= dtMs;
      if (this.respawnRemainingMs <= 0) this.respawn();
    }
  }

  private respawn(): void {
    this.alive = true;
    this.health = MAX_HEALTH;
    this.mesh.visible = true;
    this.headMesh.visible = true;
    this.mesh.position.set(this.spawnPosition.x, this.spawnPosition.y, this.spawnPosition.z);
    this.headMesh.position.set(
      this.spawnPosition.x,
      this.spawnPosition.y + HEAD_VISUAL_OFFSET_Y,
      this.spawnPosition.z
    );
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    scene.remove(this.headMesh);
    this.geometry.dispose();
    this.headGeometry.dispose();
    this.material.dispose();
  }
}
