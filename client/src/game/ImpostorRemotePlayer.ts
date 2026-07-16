import { LAG_COMP_HISTORY_MS, PositionHistory, Vec3 } from "@fps/shared";
import * as THREE from "three";

const FALLBACK_COLOR = 0x3aa0e8;

const WEAPON_COLOR = 0x1c1c1c;

/**
 * Slim counterpart to Duel's RemotePlayer — same buffered/interpolated
 * rendering approach (render at "now minus INTERP_DELAY_MS" so there are
 * always two real samples to lerp between), but no head hitbox mesh or
 * combat-state fields, since this mode has no hit-scan combat. A visible
 * weapon mesh is the M4 "tell" — it's just a plain box parented to the
 * capsule and toggled visible/invisible per hasWeapon, not a proper model;
 * a crewmate close enough to actually notice it is exactly the intended
 * diegetic role-reveal moment from the design brief.
 */
export class ImpostorRemotePlayer {
  readonly mesh: THREE.Mesh;
  readonly id: string;
  name: string;

  private history = new PositionHistory(LAG_COMP_HISTORY_MS);
  private geometry: THREE.CapsuleGeometry;
  private material: THREE.MeshLambertMaterial;
  private currentColor = FALLBACK_COLOR;

  private weaponGeometry: THREE.BoxGeometry;
  private weaponMaterial: THREE.MeshLambertMaterial;
  private weaponMesh: THREE.Mesh;
  private hasWeapon = false;

  constructor(scene: THREE.Scene, id: string, name: string) {
    this.id = id;
    this.name = name;
    this.geometry = new THREE.CapsuleGeometry(0.35, 1.0, 4, 8);
    this.material = new THREE.MeshLambertMaterial({ color: FALLBACK_COLOR });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.userData.impostorRemotePlayerRef = this;
    scene.add(this.mesh);

    this.weaponGeometry = new THREE.BoxGeometry(0.12, 0.12, 0.55);
    this.weaponMaterial = new THREE.MeshLambertMaterial({ color: WEAPON_COLOR });
    this.weaponMesh = new THREE.Mesh(this.weaponGeometry, this.weaponMaterial);
    this.weaponMesh.position.set(0.32, 0, 0.35);
    this.weaponMesh.visible = false;
    this.mesh.add(this.weaponMesh);
  }

  ingestSnapshot(position: Vec3, yaw: number, serverTimeMs: number, color: number, hasWeapon: boolean): void {
    this.history.push({ time: serverTimeMs, position, yaw });
    if (color !== this.currentColor) {
      this.currentColor = color;
      this.material.color.setHex(color);
    }
    if (hasWeapon !== this.hasWeapon) {
      this.hasWeapon = hasWeapon;
      this.weaponMesh.visible = hasWeapon;
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
    this.weaponGeometry.dispose();
    this.weaponMaterial.dispose();
  }
}
