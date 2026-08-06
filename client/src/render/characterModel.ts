import { WeaponId } from "@fps/shared";
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

// Reload "tell": the held weapon dips and rolls forward while reloading,
// then springs back — driven either by exact WeaponState.reloadProgress
// (first-person viewmodel, which has that data locally) or an eased
// boolean approach/retreat toward the same pose (third-person rigs, which
// only ever get PlayerSnapshot's `reloading` flag, not a progress
// fraction — see RemotePlayer/Bot).
const RELOAD_EASE_MS = 260;
const RELOAD_TILT_X_RAD = THREE.MathUtils.degToRad(26);
const RELOAD_ROLL_Z_RAD = THREE.MathUtils.degToRad(12);

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

function addBox(
  group: THREE.Group,
  material: THREE.Material,
  size: { x: number; y: number; z: number },
  position: { x: number; y: number; z: number },
  rotationX = 0
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.position.set(position.x, position.y, position.z);
  if (rotationX) mesh.rotation.x = rotationX;
  group.add(mesh);
  return mesh;
}

function addBarrel(
  group: THREE.Group,
  material: THREE.Material,
  radius: number,
  length: number,
  position: { x: number; y: number; z: number }
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 6), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(position.x, position.y, position.z);
  group.add(mesh);
  return mesh;
}

/** Body + barrel + stock/magazine, local -Z is the direction the barrel
 * points — shared between the third-person rig (as part of weaponPivot)
 * and the first-person viewmodel (client/src/render/viewmodel.ts). Each
 * weapon gets its own silhouette (not just a shared mesh with different
 * damage numbers): the rifle keeps the original mid-length build, the SMG
 * is short and stubby with an angled magazine, the shotgun is long and
 * fat-barreled with a pump foregrip and a tube magazine instead of a box
 * one — all still flat-shaded low-poly primitives, matching this file's
 * existing aesthetic. */
function buildGunAssembly(weaponId: WeaponId, gunMaterial: THREE.Material, gunAccentMaterial: THREE.Material): THREE.Group {
  const gunGroup = new THREE.Group();

  switch (weaponId) {
    case "smg":
      addBox(gunGroup, gunMaterial, { x: 0.11, y: 0.13, z: 0.3 }, { x: 0, y: 0, z: 0 });
      addBarrel(gunGroup, gunMaterial, 0.024, 0.16, { x: 0, y: 0.01, z: -0.28 });
      addBox(gunGroup, gunAccentMaterial, { x: 0.06, y: 0.09, z: 0.14 }, { x: 0, y: -0.005, z: 0.24 });
      addBox(gunGroup, gunAccentMaterial, { x: 0.08, y: 0.07, z: 0.1 }, { x: 0, y: -0.08, z: -0.16 });
      addBox(
        gunGroup,
        gunAccentMaterial,
        { x: 0.06, y: 0.26, z: 0.08 },
        { x: 0, y: -0.17, z: 0.02 },
        THREE.MathUtils.degToRad(-28)
      );
      break;

    case "shotgun":
      addBox(gunGroup, gunMaterial, { x: 0.15, y: 0.15, z: 0.32 }, { x: 0, y: 0, z: 0 });
      addBarrel(gunGroup, gunMaterial, 0.036, 0.42, { x: 0, y: 0.02, z: -0.46 });
      addBox(gunGroup, gunAccentMaterial, { x: 0.12, y: 0.1, z: 0.16 }, { x: 0, y: -0.04, z: -0.3 });
      addBarrel(gunGroup, gunMaterial, 0.022, 0.38, { x: 0, y: -0.07, z: -0.42 });
      addBox(gunGroup, gunAccentMaterial, { x: 0.1, y: 0.12, z: 0.26 }, { x: 0, y: 0, z: 0.32 });
      break;

    case "rifle":
    default:
      addBox(gunGroup, gunMaterial, { x: 0.12, y: 0.12, z: 0.5 }, { x: 0, y: 0, z: 0 });
      addBarrel(gunGroup, gunMaterial, 0.028, 0.32, { x: 0, y: 0.01, z: -0.4 });
      addBox(gunGroup, gunAccentMaterial, { x: 0.09, y: 0.11, z: 0.24 }, { x: 0, y: -0.01, z: 0.32 });
      addBox(
        gunGroup,
        gunAccentMaterial,
        { x: 0.07, y: 0.22, z: 0.09 },
        { x: 0, y: -0.15, z: -0.05 },
        THREE.MathUtils.degToRad(-15)
      );
      break;
  }

  return gunGroup;
}

function disposeGunAssembly(assembly: THREE.Group): void {
  assembly.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.geometry.dispose();
  });
}

export interface StandaloneGun {
  /** Stable wrapper group — attach this to the camera/parent once. Its
   * child (the actual weapon geometry) gets swapped out wholesale by
   * setWeapon, so the parent never needs to re-attach anything. */
  group: THREE.Group;
  setWeapon(weaponId: WeaponId): void;
  dispose(): void;
}

/** Standalone gun mesh (own materials, not tied to a character instance)
 * for the first-person viewmodel — see client/src/render/viewmodel.ts. */
export function buildStandaloneGun(initialWeapon: WeaponId = "rifle"): StandaloneGun {
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
  const group = new THREE.Group();
  let currentWeapon = initialWeapon;
  let assembly = buildGunAssembly(currentWeapon, gunMaterial, gunAccentMaterial);
  group.add(assembly);

  return {
    group,
    setWeapon(weaponId: WeaponId): void {
      if (weaponId === currentWeapon) return;
      currentWeapon = weaponId;
      group.remove(assembly);
      disposeGunAssembly(assembly);
      assembly = buildGunAssembly(currentWeapon, gunMaterial, gunAccentMaterial);
      group.add(assembly);
    },
    dispose(): void {
      disposeGunAssembly(assembly);
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
  /** Swaps the held weapon's visual mesh (rifle/smg/shotgun each look
   * different now, not just a shared mesh with different damage numbers).
   * No-ops if it's already the current weapon. */
  setWeapon(weaponId: WeaponId): void;
  /** Call once per render frame. aimPitchRad tilts the arm/gun rig up or
   * down independent of body yaw (positive = looking down, matching this
   * game's existing pitch convention); horizontalSpeed (m/s) drives a
   * simple sine-wave leg swing so movement doesn't read as a statue
   * sliding across the floor. isReloading eases the gun into a
   * dipped/rolled "reloading" pose and back — this rig only ever sees a
   * boolean (RemotePlayer/Bot have no reload-progress fraction to work
   * with), so the pose is approached over a fixed duration rather than
   * synced to the actual reload timer; see Viewmodel for the first-person
   * version, which does have exact progress and syncs precisely. */
  updateAnimation(dtMs: number, horizontalSpeed: number, aimPitchRad: number, isReloading?: boolean): void;
  /** Brief white emissive flash across every body part, for hit feedback —
   * replaces the old single-mesh "swap material color" trick now that the
   * visible body is several separate meshes. */
  flashHit(): void;
  dispose(): void;
}

export function buildCharacterModel(initialColor: number, initialWeapon: WeaponId = "rifle"): CharacterModel {
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

  // gunMount stays put at GUN_POSITION for the lifetime of the character;
  // the actual weapon geometry (gunAssembly) is a swappable child of it so
  // setWeapon can rebuild just the mesh without touching this positioning.
  const gunMount = new THREE.Group();
  gunMount.position.set(GUN_POSITION.x, GUN_POSITION.y - SHOULDER_Y, GUN_POSITION.z);
  weaponPivot.add(gunMount);
  let currentWeapon = initialWeapon;
  let gunAssembly = buildGunAssembly(currentWeapon, gunMaterial, gunAccentMaterial);
  gunMount.add(gunAssembly);
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
  let reloadPhase = 0; // 0 = rest pose, 1 = fully into the reload pose

  return {
    root,

    setColor(hex: number): void {
      bodyMaterial.color.setHex(hex);
      gloveMaterial.color.setHex(darken(hex, GLOVE_DARKEN));
    },

    setWeapon(weaponId: WeaponId): void {
      if (weaponId === currentWeapon) return;
      currentWeapon = weaponId;
      gunMount.remove(gunAssembly);
      disposeGunAssembly(gunAssembly);
      gunAssembly = buildGunAssembly(currentWeapon, gunMaterial, gunAccentMaterial);
      gunAssembly.visible = holdingWeapon;
      gunMount.add(gunAssembly);
    },

    setHoldingWeapon(holding: boolean): void {
      if (holding === holdingWeapon) return;
      holdingWeapon = holding;
      gunAssembly.visible = holding;
      // Idle pose: arms hang straight down at the sides instead of
      // gripping a now-invisible gun.
      for (const { shoulder, side } of arms) {
        shoulder.rotation.set(holding ? ARM_ROTATION_X : 0, 0, holding ? ARM_ROTATION_Z_MAG * -side : 0);
      }
    },

    updateAnimation(dtMs: number, horizontalSpeed: number, aimPitchRad: number, isReloading = false): void {
      weaponPivot.rotation.x = aimPitchRad;

      const reloadStep = dtMs / RELOAD_EASE_MS;
      reloadPhase = isReloading ? Math.min(1, reloadPhase + reloadStep) : Math.max(0, reloadPhase - reloadStep);
      gunMount.rotation.x = reloadPhase * RELOAD_TILT_X_RAD;
      gunMount.rotation.z = reloadPhase * RELOAD_ROLL_Z_RAD;

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
