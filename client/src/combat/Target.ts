import {
  armHitBoxes,
  HEAD_BAND_MAX_Y,
  HEAD_BAND_MIN_Y,
  HitZone,
  legHitBox,
  MAX_HEALTH,
  RESPAWN_TIME_MS,
  Vec3,
} from "@fps/shared";
import * as THREE from "three";
import { buildCharacterModel, CharacterModel } from "../render/characterModel";

const BODY_COLOR = 0xe0563a;
const HEAD_VISUAL_RADIUS = 0.22;
const HEAD_VISUAL_OFFSET_Y = (HEAD_BAND_MIN_Y + HEAD_BAND_MAX_Y) / 2 + 0.05;

/**
 * Stationary practice dummy for testing hit detection before real players
 * exist. Capsule silhouette roughly matches real player dimensions so aim
 * habits transfer once multiplayer lands. `mesh`/`headMesh`/`legMesh`/
 * `armMeshLeft`/`armMeshRight` are the actual raycast targets (see
 * CombatSystem) and stay invisible primitives at their original geometry/
 * position, exactly like RemotePlayer — the visible body is an articulated
 * CharacterModel riding on top. Each carries a `hitZone` in userData so
 * CombatSystem can classify head/torso/limb the same way the server does
 * (see shared/collision.ts's resolvePlayerHit, the single source of truth
 * both sides use).
 */
export class Target {
  readonly mesh: THREE.Mesh;
  readonly headMesh: THREE.Mesh;
  readonly legMesh: THREE.Mesh;
  readonly armMeshLeft: THREE.Mesh;
  readonly armMeshRight: THREE.Mesh;
  health = MAX_HEALTH;
  alive = true;

  private geometry: THREE.CapsuleGeometry;
  private headGeometry: THREE.SphereGeometry;
  private legGeometry: THREE.BoxGeometry;
  private armGeometry: THREE.BoxGeometry;
  private material: THREE.MeshLambertMaterial;
  private character: CharacterModel;
  private respawnRemainingMs = 0;
  private readonly spawnPosition: Vec3;

  constructor(scene: THREE.Scene, position: Vec3) {
    this.spawnPosition = { ...position };
    this.geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.headGeometry = new THREE.SphereGeometry(HEAD_VISUAL_RADIUS, 8, 6);
    const leg = legHitBox(position);
    this.legGeometry = new THREE.BoxGeometry(leg.half.x * 2, leg.half.y * 2, leg.half.z * 2);
    const [armLeft] = armHitBoxes(position);
    this.armGeometry = new THREE.BoxGeometry(armLeft.half.x * 2, armLeft.half.y * 2, armLeft.half.z * 2);
    this.material = new THREE.MeshLambertMaterial({ color: BODY_COLOR, visible: false });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.set(position.x, position.y, position.z);
    this.mesh.userData.targetRef = this;
    this.mesh.userData.hitZone = "torso" as HitZone;

    this.headMesh = new THREE.Mesh(this.headGeometry, this.material);
    this.headMesh.userData.targetRef = this;
    this.headMesh.userData.hitZone = "head" as HitZone;

    this.legMesh = new THREE.Mesh(this.legGeometry, this.material);
    this.legMesh.userData.targetRef = this;
    this.legMesh.userData.hitZone = "limb" as HitZone;

    this.armMeshLeft = new THREE.Mesh(this.armGeometry, this.material);
    this.armMeshLeft.userData.targetRef = this;
    this.armMeshLeft.userData.hitZone = "limb" as HitZone;

    this.armMeshRight = new THREE.Mesh(this.armGeometry, this.material);
    this.armMeshRight.userData.targetRef = this;
    this.armMeshRight.userData.hitZone = "limb" as HitZone;

    for (const m of [this.mesh, this.headMesh, this.legMesh, this.armMeshLeft, this.armMeshRight]) {
      scene.add(m);
    }
    this.positionHitboxes(position);

    this.character = buildCharacterModel(BODY_COLOR);
    this.character.setHoldingWeapon(true);
    this.mesh.add(this.character.root);
  }

  /** All raycast targets belonging to this dummy — see CombatSystem.addTarget. */
  get raycastMeshes(): THREE.Mesh[] {
    return [this.mesh, this.headMesh, this.legMesh, this.armMeshLeft, this.armMeshRight];
  }

  private positionHitboxes(position: Vec3): void {
    this.headMesh.position.set(position.x, position.y + HEAD_VISUAL_OFFSET_Y, position.z);
    const leg = legHitBox(position);
    this.legMesh.position.set(leg.center.x, leg.center.y, leg.center.z);
    const [armLeft, armRight] = armHitBoxes(position);
    this.armMeshLeft.position.set(armLeft.center.x, armLeft.center.y, armLeft.center.z);
    this.armMeshRight.position.set(armRight.center.x, armRight.center.y, armRight.center.z);
  }

  /** Returns true if this shot killed the target. */
  applyDamage(amount: number): boolean {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    this.character.flashHit();

    if (this.health <= 0) {
      this.alive = false;
      for (const m of this.raycastMeshes) m.visible = false;
      this.respawnRemainingMs = RESPAWN_TIME_MS;
      return true;
    }
    return false;
  }

  update(dtMs: number): void {
    this.character.updateAnimation(dtMs, 0, 0);

    if (!this.alive) {
      this.respawnRemainingMs -= dtMs;
      if (this.respawnRemainingMs <= 0) this.respawn();
    }
  }

  private respawn(): void {
    this.alive = true;
    this.health = MAX_HEALTH;
    for (const m of this.raycastMeshes) m.visible = true;
    this.mesh.position.set(this.spawnPosition.x, this.spawnPosition.y, this.spawnPosition.z);
    this.positionHitboxes(this.spawnPosition);
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
