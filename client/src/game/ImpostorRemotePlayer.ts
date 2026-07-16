import { LAG_COMP_HISTORY_MS, PositionHistory, Vec3 } from "@fps/shared";
import * as THREE from "three";

const FALLBACK_COLOR = 0x3aa0e8;

/**
 * Slim counterpart to Duel's RemotePlayer — same buffered/interpolated
 * rendering approach (render at "now minus INTERP_DELAY_MS" so there are
 * always two real samples to lerp between), but no head hitbox mesh or
 * combat-state fields, since this mode has neither yet. A visible weapon
 * mesh (for imposters, M4) and a name label are the obvious next additions
 * once there's a reason to tell players apart at a glance beyond color.
 */
export class ImpostorRemotePlayer {
  readonly mesh: THREE.Mesh;
  readonly id: string;
  name: string;

  private history = new PositionHistory(LAG_COMP_HISTORY_MS);
  private geometry: THREE.CapsuleGeometry;
  private material: THREE.MeshLambertMaterial;
  private currentColor = FALLBACK_COLOR;

  constructor(scene: THREE.Scene, id: string, name: string) {
    this.id = id;
    this.name = name;
    this.geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.material = new THREE.MeshLambertMaterial({ color: FALLBACK_COLOR });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.impostorRemotePlayerRef = this;
    scene.add(this.mesh);
  }

  ingestSnapshot(position: Vec3, yaw: number, serverTimeMs: number, color: number): void {
    this.history.push({ time: serverTimeMs, position, yaw });
    if (color !== this.currentColor) {
      this.currentColor = color;
      this.material.color.setHex(color);
    }
  }

  update(renderServerTimeMs: number): void {
    const sample = this.history.sampleAt(renderServerTimeMs);
    if (sample) {
      this.mesh.position.set(sample.position.x, sample.position.y, sample.position.z);
      this.mesh.rotation.y = sample.yaw;
    }
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
