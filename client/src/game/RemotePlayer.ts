import { PositionHistory, Vec3, WeaponId, LAG_COMP_HISTORY_MS } from "@fps/shared";
import * as THREE from "three";

const BODY_COLOR = 0x3aa0e8;

/**
 * Visual + interpolated representation of another player. Snapshots arrive
 * at SNAPSHOT_HZ (20/s); rather than teleporting between them, we buffer a
 * short position history and render at "now minus INTERP_DELAY_MS" so
 * there are always two real samples to lerp between — smooth motion at
 * render framerate without needing to guess/extrapolate.
 */
export class RemotePlayer {
  readonly mesh: THREE.Mesh;
  readonly id: string;
  name: string;
  health = 100;
  alive = true;
  weapon: WeaponId = "rifle";
  kills = 0;
  deaths = 0;

  private history = new PositionHistory(LAG_COMP_HISTORY_MS);
  private material: THREE.MeshLambertMaterial;

  constructor(scene: THREE.Scene, id: string, name: string) {
    this.id = id;
    this.name = name;
    const geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.material = new THREE.MeshLambertMaterial({ color: BODY_COLOR });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.userData.remotePlayerRef = this;
    scene.add(this.mesh);
  }

  ingestSnapshot(
    position: Vec3,
    yaw: number,
    serverTimeMs: number,
    health: number,
    alive: boolean,
    weapon: WeaponId,
    kills: number,
    deaths: number
  ): void {
    this.history.push({ time: serverTimeMs, position, yaw });
    this.health = health;
    this.alive = alive;
    this.weapon = weapon;
    this.kills = kills;
    this.deaths = deaths;
  }

  update(renderServerTimeMs: number): void {
    const sample = this.history.sampleAt(renderServerTimeMs);
    if (sample) {
      this.mesh.position.set(sample.position.x, sample.position.y, sample.position.z);
      this.mesh.rotation.y = sample.yaw;
    }
    this.mesh.visible = this.alive;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.material.dispose();
  }
}
