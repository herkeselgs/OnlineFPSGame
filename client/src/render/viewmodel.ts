import * as THREE from "three";
import { buildStandaloneGun } from "./characterModel";

const REST_POSITION = new THREE.Vector3(0.2, -0.19, -0.75);
const REST_ROTATION_Y = THREE.MathUtils.degToRad(-9);
const REST_ROTATION_X = THREE.MathUtils.degToRad(1.5);
const SCALE = 0.8;
const KICK_DISTANCE = 0.07;
const KICK_RECOVER_PER_SECOND = 15;

/**
 * The local player's own held-weapon model — bottom-right of the view,
 * parented directly to the camera so it moves/rotates with it for free
 * (same trick MuzzleFlashEffect already used). Reuses the exact gun mesh
 * the third-person CharacterModel holds (buildStandaloneGun), so what you
 * see in your own hands matches what other players see you holding.
 *
 * Deliberately no arm/hand mesh here (unlike the third-person rig) — at
 * this close range and FOV a disembodied low-poly forearm reads as more
 * distracting than convincing, and the gun alone already answers "does it
 * look like I'm holding a gun," which is the actual ask.
 */
export class Viewmodel {
  private group: THREE.Group;
  private gun: { group: THREE.Group; dispose(): void };
  private kickOffset = 0;

  constructor(camera: THREE.Camera) {
    this.gun = buildStandaloneGun();
    this.group = new THREE.Group();
    this.group.position.copy(REST_POSITION);
    this.group.rotation.set(REST_ROTATION_X, REST_ROTATION_Y, 0);
    this.group.scale.setScalar(SCALE);
    this.group.add(this.gun.group);
    this.group.renderOrder = 998;
    camera.add(this.group);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** Call on every successful shot — kicks the gun back toward the camera,
   * then springs it forward again, echoing the same recoil moment
   * ScreenShake gives the camera itself. */
  triggerRecoil(): void {
    this.kickOffset = KICK_DISTANCE;
  }

  update(dtMs: number): void {
    if (this.kickOffset > 0) {
      this.kickOffset = Math.max(0, this.kickOffset - this.kickOffset * Math.min(1, (KICK_RECOVER_PER_SECOND * dtMs) / 1000));
      this.group.position.z = REST_POSITION.z + this.kickOffset;
    }
  }

  dispose(camera: THREE.Camera): void {
    camera.remove(this.group);
    this.gun.dispose();
  }
}
