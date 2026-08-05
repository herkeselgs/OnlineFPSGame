import { LAG_COMP_HISTORY_MS, PositionHistory, Vec3 } from "@fps/shared";
import * as THREE from "three";
import { buildCharacterModel, CharacterModel } from "../render/characterModel";

const FALLBACK_COLOR = 0x3aa0e8;

/**
 * Slim counterpart to Duel's RemotePlayer — same buffered/interpolated
 * rendering approach (render at "now minus INTERP_DELAY_MS" so there are
 * always two real samples to lerp between), but no head hitbox mesh, since
 * this mode has no hit-scan combat. `mesh` stays a plain invisible capsule
 * purely as the thing that owns position/yaw each frame; the visible
 * articulated CharacterModel rides as its child. hasWeapon (the M4 "tell")
 * now toggles the shared model's held-gun pose instead of a standalone box
 * — a crewmate close enough to actually notice the gun is exactly the
 * intended diegetic role-reveal moment from the design brief.
 */
export class ImpostorRemotePlayer {
  readonly mesh: THREE.Mesh;
  readonly id: string;
  name: string;

  private history = new PositionHistory(LAG_COMP_HISTORY_MS);
  private geometry: THREE.CapsuleGeometry;
  private material: THREE.MeshLambertMaterial;
  private currentColor = FALLBACK_COLOR;
  private character: CharacterModel;
  private hasWeapon = false;
  private lastVelocity: Vec3 = { x: 0, y: 0, z: 0 };
  private lastPitch = 0;

  constructor(scene: THREE.Scene, id: string, name: string) {
    this.id = id;
    this.name = name;
    this.geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.material = new THREE.MeshLambertMaterial({ color: FALLBACK_COLOR, visible: false });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.impostorRemotePlayerRef = this;
    scene.add(this.mesh);

    this.character = buildCharacterModel(FALLBACK_COLOR);
    this.character.setHoldingWeapon(false);
    this.mesh.add(this.character.root);
  }

  ingestSnapshot(position: Vec3, yaw: number, pitch: number, velocity: Vec3, serverTimeMs: number, color: number, hasWeapon: boolean): void {
    this.history.push({ time: serverTimeMs, position, yaw });
    this.lastVelocity = velocity;
    this.lastPitch = pitch;
    if (color !== this.currentColor) {
      this.currentColor = color;
      this.material.color.setHex(color);
      this.character.setColor(color);
    }
    if (hasWeapon !== this.hasWeapon) {
      this.hasWeapon = hasWeapon;
      this.character.setHoldingWeapon(hasWeapon);
    }
  }

  update(renderServerTimeMs: number, frameDtMs: number): void {
    const sample = this.history.sampleAt(renderServerTimeMs);
    if (sample) {
      this.mesh.position.set(sample.position.x, sample.position.y, sample.position.z);
      this.mesh.rotation.y = sample.yaw;
    }
    const speed = Math.hypot(this.lastVelocity.x, this.lastVelocity.z);
    this.character.updateAnimation(frameDtMs, speed, this.lastPitch);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.character.dispose();
  }
}
