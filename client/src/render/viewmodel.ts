import { WeaponId } from "@fps/shared";
import * as THREE from "three";
import { buildStandaloneGun, StandaloneGun } from "./characterModel";

const REST_POSITION = new THREE.Vector3(0.2, -0.19, -0.75);
const REST_ROTATION_Y = THREE.MathUtils.degToRad(-9);
const REST_ROTATION_X = THREE.MathUtils.degToRad(1.5);
const SCALE = 0.8;
const KICK_DISTANCE = 0.07;
const KICK_RECOVER_PER_SECOND = 15;

// Reload animation: the gun dips down and rolls forward, peaking at the
// midpoint of the reload and returning to rest exactly as it completes —
// shaped by sin(reloadProgress * PI) so it's 0 at both ends and 1 at the
// midpoint, synced precisely to WeaponState.reloadProgress since the local
// player (unlike remote ones) has that exact fraction available every frame.
const RELOAD_DIP_Y = 0.14;
const RELOAD_TILT_X_RAD = THREE.MathUtils.degToRad(30);
const RELOAD_ROLL_Z_RAD = THREE.MathUtils.degToRad(14);

const SLEEVE_COLOR = 0x2c3136;
const GLOVE_COLOR = 0x1c1f22;
const UPPER_ARM_RADIUS = 0.062;
const FOREARM_RADIUS = 0.052;
const THUMB_SIZE = { x: 0.035, y: 0.035, z: 0.06 };

/** A tapered cylinder running from `from` to `to` in local space — same
 * "orient a cylinder along an arbitrary direction" trick TracerPool uses
 * for bullet tracers, reused here for arm segments instead of a bullet
 * path. */
function buildArmSegment(from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(to, from);
  const length = dir.length();
  const geometry = new THREE.CylinderGeometry(radius * 0.75, radius, length, 8);
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
 * Two low-poly arms (no shoulders/torso — those would be off-frame
 * regardless at this FOV) reach up from off-screen to grip the stock and
 * the foregrip, same two-handed hold the third-person rig uses, so the gun
 * reads as held rather than floating. Each arm bends at an elbow (upper
 * arm + forearm, two segments instead of one straight rod) for a more
 * natural reach, matching the third-person rig's own elbow joint — not
 * IK-driven or bone-rigged (no bone system in this codebase, see
 * characterModel.ts's file comment), just fixed segments plus hand caps
 * with a thumb nub, positioned by eye against screenshots to line up with
 * the gun mesh's actual grip/foregrip points.
 */
export class Viewmodel {
  private group: THREE.Group;
  private gun: StandaloneGun;
  private kickOffset = 0;

  private armGeometries: THREE.CylinderGeometry[] = [];
  private handGeometry: THREE.BoxGeometry;
  private thumbGeometry: THREE.BoxGeometry;
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
    this.handGeometry = new THREE.BoxGeometry(0.09, 0.08, 0.12);
    this.thumbGeometry = new THREE.BoxGeometry(THUMB_SIZE.x, THUMB_SIZE.y, THUMB_SIZE.z);

    // Grip hand: reaches up from off the bottom-right of frame, elbow bent
    // outward, to the stock/trigger area roughly under the magazine.
    // Local +Z here means CLOSER to the camera (this whole group sits at
    // REST_POSITION.z, a negative/forward offset — adding a positive
    // local Z walks back toward the lens), so these points only need a
    // modest local Z, not a large one — a large one was putting it almost
    // on top of the near clip plane, which is what made it read as a blob
    // instead of an arm.
    const gripFrom = new THREE.Vector3(0.32, -0.45, 0.4);
    const gripElbow = new THREE.Vector3(0.3, -0.3, 0.3);
    const gripTo = new THREE.Vector3(0.05, -0.05, 0.18);
    this.addArm(gripFrom, gripElbow, gripTo, 1);

    // Support hand: reaches up from lower-center-left, elbow bent outward,
    // to the foregrip just behind the barrel.
    const supportFrom = new THREE.Vector3(-0.3, -0.35, 0.35);
    const supportElbow = new THREE.Vector3(-0.28, -0.22, 0.22);
    const supportTo = new THREE.Vector3(-0.03, -0.04, -0.28);
    this.addArm(supportFrom, supportElbow, supportTo, -1);
  }

  /** Builds a bent (upper-arm + forearm) arm from `from` through `elbow`
   * to `to`, plus a hand with a thumb nub at the end. `handSide` picks
   * which local-X side the thumb pokes out to (matches the two arms'
   * general left/right position so it reads as wrapped around the grip
   * rather than floating off the back of the hand). */
  private addArm(from: THREE.Vector3, elbow: THREE.Vector3, to: THREE.Vector3, handSide: 1 | -1): void {
    const upperArm = buildArmSegment(from, elbow, UPPER_ARM_RADIUS, this.sleeveMaterial);
    this.armGeometries.push(upperArm.geometry as THREE.CylinderGeometry);
    this.group.add(upperArm);

    const forearm = buildArmSegment(elbow, to, FOREARM_RADIUS, this.sleeveMaterial);
    this.armGeometries.push(forearm.geometry as THREE.CylinderGeometry);
    this.group.add(forearm);

    const hand = new THREE.Mesh(this.handGeometry, this.gloveMaterial);
    hand.position.copy(to);
    hand.quaternion.copy(forearm.quaternion);
    this.group.add(hand);

    const thumb = new THREE.Mesh(this.thumbGeometry, this.gloveMaterial);
    const thumbLocal = new THREE.Vector3(handSide * 0.06, 0, -0.02).applyQuaternion(forearm.quaternion);
    thumb.position.copy(to).add(thumbLocal);
    thumb.quaternion.copy(forearm.quaternion);
    this.group.add(thumb);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  /** Swaps the held weapon's mesh (rifle/smg/shotgun each look different
   * now). No-ops if it's already the current weapon. */
  setWeapon(weaponId: WeaponId): void {
    this.gun.setWeapon(weaponId);
  }

  /** Call on every successful shot — kicks the gun back toward the camera,
   * then springs it forward again, echoing the same recoil moment
   * ScreenShake gives the camera itself. */
  triggerRecoil(): void {
    this.kickOffset = KICK_DISTANCE;
  }

  update(dtMs: number, isReloading = false, reloadProgress = 1): void {
    if (this.kickOffset > 0) {
      this.kickOffset = Math.max(0, this.kickOffset - this.kickOffset * Math.min(1, (KICK_RECOVER_PER_SECOND * dtMs) / 1000));
    }

    const reloadShape = isReloading ? Math.sin(Math.min(1, Math.max(0, reloadProgress)) * Math.PI) : 0;
    this.group.position.set(REST_POSITION.x, REST_POSITION.y - reloadShape * RELOAD_DIP_Y, REST_POSITION.z + this.kickOffset);
    this.group.rotation.set(REST_ROTATION_X + reloadShape * RELOAD_TILT_X_RAD, REST_ROTATION_Y, reloadShape * RELOAD_ROLL_Z_RAD);
  }

  dispose(camera: THREE.Camera): void {
    camera.remove(this.group);
    this.gun.dispose();
    for (const g of this.armGeometries) g.dispose();
    this.handGeometry.dispose();
    this.thumbGeometry.dispose();
    this.sleeveMaterial.dispose();
    this.gloveMaterial.dispose();
  }
}
