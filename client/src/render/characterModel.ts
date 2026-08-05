import * as THREE from "three";

/**
 * Builds a low-poly articulated humanoid — head, chest, pelvis, two arms
 * gripping a held weapon, two legs — to replace the old "capsule + sphere"
 * silhouette every character in this game used to render as. Deliberately
 * still primitive boxes/spheres (matches the flat-shaded, shadow-less,
 * Chromebook-friendly look the rest of the game commits to — see
 * SceneBuilder's file comment), not a skinned/rigged model: no bone system
 * exists in this codebase, so limbs are plain Object3D pivots with a
 * geometry translated so it hangs from the pivot's origin, the standard
 * "poor man's rig" trick for posing primitives without real bones.
 *
 * One instance of this per rendered character (RemotePlayer,
 * ImpostorRemotePlayer, Target practice dummies, the first-person
 * viewmodel) — cheap enough that sharing geometry across instances isn't
 * worth the complexity at this game's player counts (2 for Duel, up to 10
 * for Imposter).
 */

const HELMET_COLOR = 0x20262c;
const GUN_COLOR = 0x1b1b1e;
const GUN_ACCENT_COLOR = 0x353538;
const GLOVE_DARKEN = 0.55;
const FLASH_COLOR = 0xffffff;
const FLASH_DURATION_MS = 90;

// Proportions in local space, relative to the character's physics center
// (y=0) — must stay inside the server's PLAYER_HALF_EXTENTS.y (0.9) band,
// feet at -0.9 and head-top at +0.9, so the model doesn't clip the floor
// or poke through low ceilings the collision box would already be
// bumping into.
const HEAD_RADIUS = 0.145;
const HEAD_Y = 0.71;
const NECK_RADIUS = 0.085;
const NECK_HEIGHT = 0.1;
const NECK_Y = 0.545;
const CHEST_SIZE = { x: 0.5, y: 0.46, z: 0.28 };
const CHEST_Y = 0.28;
const PELVIS_SIZE = { x: 0.4, y: 0.22, z: 0.26 };
const PELVIS_Y = -0.04;

const SHOULDER_Y = 0.44;
const SHOULDER_X = 0.32;
const ARM_LENGTH = 0.46;
const ARM_RADIUS = 0.075;
const HAND_SIZE = { x: 0.11, y: 0.1, z: 0.16 };
// Forward-and-slightly-down, tilted inward toward the midline so both
// hands converge near the gun instead of staying shoulder-width apart —
// tuned by eye against screenshots, not derived analytically.
const ARM_ROTATION_X = THREE.MathUtils.degToRad(68);
const ARM_ROTATION_Z_MAG = THREE.MathUtils.degToRad(16);

const HIP_Y = -0.32;
const HIP_X = 0.15;
const LEG_LENGTH = 0.58;
const LEG_RADIUS = 0.095;
const FOOT_SIZE = { x: 0.16, y: 0.08, z: 0.24 };

const GUN_POSITION = { x: 0, y: 0.32, z: -0.58 };
const WALK_SWING_MAX_RAD = THREE.MathUtils.degToRad(38);
const WALK_CYCLE_SPEED = 7.5; // radians of phase per m/s of horizontal speed

function darken(hex: number, factor: number): number {
  const r = ((hex >> 16) & 0xff) * factor;
  const g = ((hex >> 8) & 0xff) * factor;
  const b = (hex & 0xff) * factor;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** A limb segment: a cylinder whose geometry is pre-translated so it hangs
 * from local (0,0,0) down to (0,-length,0) — rotating the returned
 * pivot Group swings the whole segment around its top joint. */
function buildLimbSegment(length: number, radius: number, material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radius, radius * 0.85, length, 6);
  geometry.translate(0, -length / 2, 0);
  return new THREE.Mesh(geometry, material);
}

/** Body + barrel + stock + magazine, local -Z is the direction the barrel
 * points — shared between the third-person rig (as part of weaponPivot)
 * and the first-person viewmodel (client/src/render/viewmodel.ts), so the
 * same low-poly rifle silhouette shows up from both views. */
function buildGunAssembly(gunMaterial: THREE.Material, gunAccentMaterial: THREE.Material): THREE.Group {
  const gunGroup = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.5), gunMaterial);
  gunGroup.add(body);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.32, 6), gunMaterial);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, 0.01, -0.4);
  gunGroup.add(barrel);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.24), gunAccentMaterial);
  stock.position.set(0, -0.01, 0.32);
  gunGroup.add(stock);
  const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.22, 0.09), gunAccentMaterial);
  magazine.position.set(0, -0.15, -0.05);
  magazine.rotation.x = THREE.MathUtils.degToRad(-15);
  gunGroup.add(magazine);
  return gunGroup;
}

/** Standalone gun mesh (own materials, not tied to a character instance)
 * for the first-person viewmodel — see client/src/render/viewmodel.ts. */
export function buildStandaloneGun(): { group: THREE.Group; dispose(): void } {
  // A small constant emissive keeps the viewmodel readable regardless of
  // which way the scene's one directional light happens to be facing —
  // at first-person range and camera angle, a purely scene-lit dark gun
  // reads as a near-black silhouette far more often than the third-person
  // rig (which gets seen from many more angles and washes this out).
  const gunMaterial = new THREE.MeshLambertMaterial({ color: GUN_COLOR, emissive: GUN_COLOR, emissiveIntensity: 0.5 });
  const gunAccentMaterial = new THREE.MeshLambertMaterial({
    color: GUN_ACCENT_COLOR,
    emissive: GUN_ACCENT_COLOR,
    emissiveIntensity: 0.5,
  });
  const group = buildGunAssembly(gunMaterial, gunAccentMaterial);
  return {
    group,
    dispose(): void {
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
      gunMaterial.dispose();
      gunAccentMaterial.dispose();
    },
  };
}

export interface CharacterModel {
  /** Add this to the character's hit-collider mesh as a child so it rides
   * along with that mesh's per-frame position/yaw updates for free — see
   * RemotePlayer/ImpostorRemotePlayer, which keep their original capsule
   * (now invisible) as the actual raycast target and never touch it. */
  root: THREE.Group;
  setColor(hex: number): void;
  /** Crewmates in Imposter mode carry no weapon at all (that's the whole
   * "visible gun = imposter tell" mechanic) — false swings the arms down
   * to a relaxed idle pose and hides the gun instead of leaving it stuck
   * gripping an invisible weapon. Duel/Target always pass true. */
  setHoldingWeapon(holding: boolean): void;
  /** Call once per render frame. aimPitchRad tilts the arm/gun rig up or
   * down independent of body yaw (positive = looking down, matching this
   * game's existing pitch convention); horizontalSpeed (m/s) drives a
   * simple sine-wave leg swing so movement doesn't read as a statue
   * sliding across the floor. */
  updateAnimation(dtMs: number, horizontalSpeed: number, aimPitchRad: number): void;
  /** Brief white emissive flash across every body part, for hit feedback —
   * replaces the old single-mesh "swap material color" trick now that the
   * visible body is several separate meshes. */
  flashHit(): void;
  dispose(): void;
}

export function buildCharacterModel(initialColor: number): CharacterModel {
  const root = new THREE.Group();

  const bodyMaterial = new THREE.MeshLambertMaterial({ color: initialColor });
  const gloveMaterial = new THREE.MeshLambertMaterial({ color: darken(initialColor, GLOVE_DARKEN) });
  const helmetMaterial = new THREE.MeshLambertMaterial({ color: HELMET_COLOR });
  const gunMaterial = new THREE.MeshLambertMaterial({ color: GUN_COLOR });
  const gunAccentMaterial = new THREE.MeshLambertMaterial({ color: GUN_ACCENT_COLOR });
  const flashMaterials = [bodyMaterial, gloveMaterial, helmetMaterial];

  const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_RADIUS, 10, 8), helmetMaterial);
  head.position.set(0, HEAD_Y, 0);
  root.add(head);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(NECK_RADIUS, NECK_RADIUS, NECK_HEIGHT, 8), helmetMaterial);
  neck.position.set(0, NECK_Y, 0);
  root.add(neck);

  const chest = new THREE.Mesh(new THREE.BoxGeometry(CHEST_SIZE.x, CHEST_SIZE.y, CHEST_SIZE.z), bodyMaterial);
  chest.position.set(0, CHEST_Y, 0);
  root.add(chest);

  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(PELVIS_SIZE.x, PELVIS_SIZE.y, PELVIS_SIZE.z), bodyMaterial);
  pelvis.position.set(0, PELVIS_Y, 0);
  root.add(pelvis);

  // Arms + gun all live under one pivot so aim pitch tilts the whole
  // "holding a weapon" unit rigidly together — with no bone/IK system,
  // keeping hands and gun as one rigid group is what keeps them looking
  // attached to each other as the rig tilts, at the cost of the shoulders
  // themselves also drifting slightly with pitch (not noticeable at
  // gameplay camera distances).
  const weaponPivot = new THREE.Group();
  weaponPivot.position.set(0, SHOULDER_Y, 0);
  root.add(weaponPivot);

  function buildArm(side: 1 | -1): THREE.Group {
    const shoulder = new THREE.Group();
    shoulder.position.set(SHOULDER_X * side, 0, 0);
    shoulder.rotation.set(ARM_ROTATION_X, 0, ARM_ROTATION_Z_MAG * -side);
    const segment = buildLimbSegment(ARM_LENGTH, ARM_RADIUS, gloveMaterial);
    shoulder.add(segment);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(HAND_SIZE.x, HAND_SIZE.y, HAND_SIZE.z), gloveMaterial);
    hand.position.set(0, -ARM_LENGTH, 0);
    shoulder.add(hand);
    weaponPivot.add(shoulder);
    return shoulder;
  }
  const arms: { shoulder: THREE.Group; side: 1 | -1 }[] = [
    { shoulder: buildArm(1), side: 1 },
    { shoulder: buildArm(-1), side: -1 },
  ];

  const gunGroup = buildGunAssembly(gunMaterial, gunAccentMaterial);
  gunGroup.position.set(GUN_POSITION.x, GUN_POSITION.y - SHOULDER_Y, GUN_POSITION.z);
  weaponPivot.add(gunGroup);
  let holdingWeapon = true;

  const legPivots: THREE.Group[] = [];
  function buildLeg(side: 1 | -1): THREE.Group {
    const hip = new THREE.Group();
    hip.position.set(HIP_X * side, HIP_Y, 0);
    root.add(hip);
    const segment = buildLimbSegment(LEG_LENGTH, LEG_RADIUS, bodyMaterial);
    hip.add(segment);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(FOOT_SIZE.x, FOOT_SIZE.y, FOOT_SIZE.z), gloveMaterial);
    foot.position.set(0, -LEG_LENGTH, 0.03);
    hip.add(foot);
    legPivots.push(hip);
    return hip;
  }
  buildLeg(1);
  buildLeg(-1);

  let walkPhase = 0;
  let flashRemainingMs = 0;

  return {
    root,

    setColor(hex: number): void {
      bodyMaterial.color.setHex(hex);
      gloveMaterial.color.setHex(darken(hex, GLOVE_DARKEN));
    },

    setHoldingWeapon(holding: boolean): void {
      if (holding === holdingWeapon) return;
      holdingWeapon = holding;
      gunGroup.visible = holding;
      // Idle pose: arms hang straight down at the sides instead of
      // gripping a now-invisible gun.
      for (const { shoulder, side } of arms) {
        shoulder.rotation.set(holding ? ARM_ROTATION_X : 0, 0, holding ? ARM_ROTATION_Z_MAG * -side : 0);
      }
    },

    updateAnimation(dtMs: number, horizontalSpeed: number, aimPitchRad: number): void {
      weaponPivot.rotation.x = aimPitchRad;

      const amplitude = Math.min(1, horizontalSpeed / 4.5) * WALK_SWING_MAX_RAD;
      walkPhase += (dtMs / 1000) * WALK_CYCLE_SPEED * Math.min(1, horizontalSpeed / 2.5 + 0.15);
      const swing = Math.sin(walkPhase) * amplitude;
      legPivots[0].rotation.x = swing;
      legPivots[1].rotation.x = -swing;

      if (flashRemainingMs > 0) {
        flashRemainingMs -= dtMs;
        if (flashRemainingMs <= 0) {
          for (const m of flashMaterials) m.emissive.setHex(0x000000);
        }
      }
    },

    flashHit(): void {
      flashRemainingMs = FLASH_DURATION_MS;
      for (const m of flashMaterials) m.emissive.setHex(FLASH_COLOR);
    },

    dispose(): void {
      root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.geometry.dispose();
      });
      bodyMaterial.dispose();
      gloveMaterial.dispose();
      helmetMaterial.dispose();
      gunMaterial.dispose();
      gunAccentMaterial.dispose();
    },
  };
}
