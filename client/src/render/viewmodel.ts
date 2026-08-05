import * as THREE from "three";
import { buildStandaloneGun } from "./characterModel";

const REST_POSITION = new THREE.Vector3(0.2, -0.19, -0.75);
const REST_ROTATION_Y = THREE.MathUtils.degToRad(-9);
const REST_ROTATION_X = THREE.MathUtils.degToRad(1.5);
const SCALE = 0.8;
const KICK_DISTANCE = 0.07;
const KICK_RECOVER_PER_SECOND = 15;

const SLEEVE_COLOR = 0x2c3136;
const GLOVE_COLOR = 0x1c1f22;
const ARM_RADIUS = 0.058;

/** A tapered cylinder running from `from` to `to` in local space — same
 * "orient a cylinder along an arbitrary direction" trick TracerPool uses
 * for bullet tracers, reused here for a forearm instead of a bullet path. */
function buildArmSegment(from: THREE.Vector3, to: THREE.Vector3, material: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(to, from);
  const length = dir.length();
  const geometry = new THREE.CylinderGeometry(ARM_RADIUS * 0.75, ARM_RADIUS, length, 8);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(from).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return mesh;
}

/**
 * The local player's own held-weapon model — bottom-right of the view,
 * parented directly to the camera so it moves/rotates with it for free
 * (same trick MuzzleFlashEffect already used). Reuses the exact gun mesh
 * the third-person CharacterModel holds (buildStandaloneGun), so what you
 * see in your own hands matches what other players see you holding.
 *
 * Two low-poly forearms (no shoulders/torso — those would be off-frame
 * regardless at this FOV) reach up from off-screen to grip the stock and
 * the foregrip, same two-handed hold the third-person rig uses, so the gun
 * reads as held rather than floating. Not IK-driven or bone-rigged (no
 * bone system in this codebase, see characterModel.ts's file comment) —
 * just two fixed segments plus hand caps, positioned by eye against
 * screenshots to line up with the gun mesh's actual grip/foregrip points.
 */
export class Viewmodel {
  private group: THREE.Group;
  private gun: { group: THREE.Group; dispose(): void };
  private kickOffset = 0;

  private armGeometries: THREE.CylinderGeometry[] = [];
  private handGeometry: THREE.BoxGeometry;
  private sleeveMaterial: THREE.MeshLambertMaterial;
  private gloveMaterial: THREE.MeshLambertMaterial;

  constructor(camera: THREE.Camera) {
    this.gun = buildStandaloneGun();
    this.group = new THREE.Group();
    this.group.position.copy(REST_POSITION);
    this.group.rotation.set(REST_ROTATION_X, REST_ROTATION_Y, 0);
    this.group.scale.setScalar(SCALE);
    this.group.add(this.gun.group);
    this.group.renderOrder = 998;
    camera.add(this.group);

    this.sleeveMaterial = new THREE.MeshLambertMaterial({
      color: SLEEVE_COLOR,
      emissive: SLEEVE_COLOR,
      emissiveIntensity: 0.4,
    });
    this.gloveMaterial = new THREE.MeshLambertMaterial({
      color: GLOVE_COLOR,
      emissive: GLOVE_COLOR,
      emissiveIntensity: 0.4,
    });
    this.handGeometry = new THREE.BoxGeometry(0.095, 0.085, 0.13);

    // Grip hand: reaches up from off the bottom-right of frame to the
    // stock/trigger area, roughly under the magazine. Local +Z here means
    // CLOSER to the camera (this whole group sits at REST_POSITION.z, a
    // negative/forward offset — adding a positive local Z walks back
    // toward the lens), so "from" only needs a modest local Z, not a large
    // one — a large one was putting it almost on top of the near clip
    // plane, which is what made it read as a blob instead of an arm.
    const gripFrom = new THREE.Vector3(0.32, -0.45, 0.4);
    const gripTo = new THREE.Vector3(0.05, -0.05, 0.18);
    this.addArm(gripFrom, gripTo);

    // Support hand: reaches up from lower-center-left to the foregrip,
    // just behind the barrel.
    const supportFrom = new THREE.Vector3(-0.3, -0.35, 0.35);
    const supportTo = new THREE.Vector3(-0.03, -0.04, -0.28);
    this.addArm(supportFrom, supportTo);
  }

  private addArm(from: THREE.Vector3, to: THREE.Vector3): void {
    const arm = buildArmSegment(from, to, this.sleeveMaterial);
    this.armGeometries.push(arm.geometry as THREE.CylinderGeometry);
    this.group.add(arm);

    const hand = new THREE.Mesh(this.handGeometry, this.gloveMaterial);
    hand.position.copy(to);
    hand.quaternion.copy(arm.quaternion);
    this.group.add(hand);
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
    for (const g of this.armGeometries) g.dispose();
    this.handGeometry.dispose();
    this.sleeveMaterial.dispose();
    this.gloveMaterial.dispose();
  }
}
