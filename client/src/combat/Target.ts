import { MAX_HEALTH, RESPAWN_TIME_MS, Vec3 } from "@fps/shared";
import * as THREE from "three";

const BODY_COLOR = 0xe0563a;
const FLASH_COLOR = 0xffffff;
const FLASH_DURATION_MS = 90;

/**
 * Stationary practice dummy for testing hit detection before real players
 * exist. Capsule silhouette roughly matches real player dimensions so aim
 * habits transfer once multiplayer lands.
 */
export class Target {
  readonly mesh: THREE.Mesh;
  health = MAX_HEALTH;
  alive = true;

  private material: THREE.MeshLambertMaterial;
  private flashRemainingMs = 0;
  private respawnRemainingMs = 0;
  private readonly spawnPosition: Vec3;

  constructor(scene: THREE.Scene, position: Vec3) {
    this.spawnPosition = { ...position };
    const geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.material = new THREE.MeshLambertMaterial({ color: BODY_COLOR });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.set(position.x, position.y, position.z);
    this.mesh.userData.targetRef = this;
    scene.add(this.mesh);
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
    this.mesh.position.set(this.spawnPosition.x, this.spawnPosition.y, this.spawnPosition.z);
  }
}
