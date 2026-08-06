import * as THREE from "three";
import { buildBrickTexture, buildHazardStripeTexture, buildWoodPlankTexture, tiledTexture } from "./proceduralTextures";

/**
 * Bastion-only visual dressing — sibling to FoundryDetails.ts, same overall
 * pattern (re-skin the existing block meshes by role, layer in decorative
 * non-collidable props, add accent lighting) but a distinct sandstone-
 * fortress palette so the two maps keep reading differently at a glance,
 * not just playing differently (see maps.ts's file comment on Bastion).
 * Nothing here touches collision — every prop is scene-only, never added
 * to the raycast/hitscan `meshes` list.
 */

const STONE = "#d9b98a";
const STONE_MORTAR = "#8a6f4d";
const STONE_LOW = "#c2a179";
const WOOD = "#8a5a34";
const WOOD_GRAIN = "#4a3018";
const TORCH_WARM = 0xffab5e;

export function applyBastionTheme(scene: THREE.Scene, meshes: THREE.Mesh[]): { dispose(): void } {
  const extraMeshes: THREE.Object3D[] = [];
  const extraLights: THREE.Light[] = [];
  const extraGeometries: THREE.BufferGeometry[] = [];
  const extraMaterials: THREE.Material[] = [];
  const extraTextures: THREE.Texture[] = [];

  const tiled = (base: THREE.Texture, w: number, h: number, tileM: number): THREE.Texture => {
    const tex = tiledTexture(base, w, h, tileM);
    extraTextures.push(tex);
    return tex;
  };
  const mat = (params: THREE.MeshLambertMaterialParameters): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial(params);
    extraMaterials.push(m);
    return m;
  };
  const geo = <T extends THREE.BufferGeometry>(g: T): T => {
    extraGeometries.push(g);
    return g;
  };
  function addMesh(geometry: THREE.BufferGeometry, material: THREE.Material, pos: THREE.Vector3Tuple, scale?: THREE.Vector3Tuple): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...pos);
    if (scale) mesh.scale.set(...scale);
    scene.add(mesh);
    extraMeshes.push(mesh);
    return mesh;
  }

  const brickTex = buildBrickTexture(STONE, STONE_MORTAR);
  const lowBrickTex = buildBrickTexture(STONE_LOW, STONE_MORTAR);
  const plankTex = buildWoodPlankTexture(WOOD, WOOD_GRAIN);
  const hazardTex = buildHazardStripeTexture();
  extraTextures.push(brickTex, lowBrickTex, plankTex, hazardTex);

  const unitBox = geo(new THREE.BoxGeometry(1, 1, 1));
  const TILE_M = 2.4;

  // --- Re-skin by role. Platforms split into stone plinths (half.x ~4)
  // vs wood stair treads (half.x ~0.5); cover splits into taller wood
  // crates (mid, half.y ~1.25) vs low stone barriers (half.y ~0.6). ---
  for (const mesh of meshes) {
    const kind = mesh.userData.blockKind as string | undefined;
    const [w, h, d] = [mesh.scale.x, mesh.scale.y, mesh.scale.z];
    let material: THREE.MeshLambertMaterial | null = null;

    if (kind === "floor") {
      material = mat({ map: tiled(lowBrickTex, w, d, TILE_M) });
    } else if (kind === "wall") {
      material = mat({ map: tiled(brickTex, Math.max(w, d), h, TILE_M) });
    } else if (kind === "platform") {
      // Platforms are stood-on/looked-down-at — the top face (a box's
      // dominant visible face here) UV-maps to (X,Z), i.e. (w,d), NOT
      // (span,h) the way a wall's side-on face does. Using h here by
      // mistake once badly distorted the brick pattern into something
      // that read as wood planks instead — see repeat math in
      // proceduralTextures.tiledTexture.
      if (w > 2) material = mat({ map: tiled(brickTex, w, d, TILE_M) });
      else material = mat({ map: tiled(plankTex, w, d, 1.4) });
    } else if (kind === "cover") {
      // Mid cover is 2.5m tall (wood crate), low cover is 1.2m (stone
      // barrier) — the threshold has to sit strictly between those, not
      // just above zero, or both sizes take the same branch.
      if (h > 1.8) material = mat({ map: tiled(plankTex, Math.max(w, d), h, 1.4) });
      else material = mat({ map: tiled(lowBrickTex, Math.max(w, d), h, 1.6) });
    }

    if (material) mesh.material = material;
  }

  // --- Wood support posts bracing each stone platform's outer corners. ---
  const postMat = mat({ color: 0x5a3c22 });
  const postGeo = geo(new THREE.CylinderGeometry(0.09, 0.11, 1, 8));
  const platformBases = meshes.filter((m) => m.userData.blockKind === "platform" && m.scale.x > 2);
  for (const base of platformBases) {
    const [w, h, d] = [base.scale.x, base.scale.y, base.scale.z];
    const topY = base.position.y + h / 2;
    const outward = base.position.x < 0 ? -1 : 1;
    for (const rz of [-d / 2 + 0.3, d / 2 - 0.3]) {
      addMesh(postGeo, postMat, [base.position.x + (outward * w) / 2 - outward * 0.15, topY - 0.9, base.position.z + rz], [1, 1.8, 1]);
    }
  }

  // --- Banner flags on a pole at each platform, and a torch sconce below
  // each — warm accent lighting against the sunset sky, distinct from
  // Foundry's overhead work lamps. ---
  const poleMat = mat({ color: 0x3a2814 });
  const poleGeo = geo(new THREE.CylinderGeometry(0.04, 0.04, 1, 6));
  const flagMat = mat({ color: 0xb23b3b, side: THREE.DoubleSide });
  const flagGeo = geo(new THREE.PlaneGeometry(0.7, 1));
  const torchMat = mat({ color: TORCH_WARM, emissive: TORCH_WARM, emissiveIntensity: 1.5 });
  const torchGeo = geo(new THREE.SphereGeometry(0.1, 8, 6));
  for (const base of platformBases) {
    const [w, h, d] = [base.scale.x, base.scale.y, base.scale.z];
    const topY = base.position.y + h / 2;
    const poleX = base.position.x;
    addMesh(poleGeo, poleMat, [poleX, topY + 1.1, base.position.z], [1, 2.2, 1]);
    addMesh(flagGeo, flagMat, [poleX + 0.36, topY + 1.7, base.position.z]);

    const outward = base.position.x < 0 ? -1 : 1;
    const torchX = base.position.x + (outward * w) / 2 - outward * 0.2;
    const torchY = topY - 0.3;
    for (const rz of [-d / 2 + 1, d / 2 - 1]) {
      addMesh(torchGeo, torchMat, [torchX, torchY, base.position.z + rz]);
      const light = new THREE.PointLight(TORCH_WARM, 9, 9, 2);
      light.position.set(torchX, torchY, base.position.z + rz);
      scene.add(light);
      extraLights.push(light);
    }
  }

  // --- Hazard-stripe trim on the mid cover crates' base, matching
  // Foundry's "safety marking" motif in Bastion's own palette. ---
  const stripeMat = mat({ map: tiled(hazardTex, 3, 0.2, 0.7) });
  for (const mesh of meshes) {
    if (mesh.userData.blockKind !== "cover" || mesh.scale.y <= 1.8) continue;
    const [w, h, d] = [mesh.scale.x, mesh.scale.y, mesh.scale.z];
    addMesh(unitBox, stripeMat, [mesh.position.x, mesh.position.y - h / 2 + 0.12, mesh.position.z], [w * 1.01, 0.14, d * 1.01]);
  }

  // --- Distant dune/mesa silhouettes beyond the walls — warm desert
  // horizon instead of Foundry's industrial skyline. ---
  const duneMat = mat({ color: 0xc9865a });
  const duneSpots: { pos: THREE.Vector3Tuple; size: THREE.Vector3Tuple }[] = [
    { pos: [-34, 4, -6], size: [10, 8, 14] },
    { pos: [-30, 6, 16], size: [8, 12, 10] },
    { pos: [34, 5, 10], size: [11, 10, 16] },
    { pos: [30, 3.5, -16], size: [7, 7, 10] },
    { pos: [0, 5, -32], size: [16, 10, 8] },
    { pos: [0, 4.5, 32], size: [20, 9, 8] },
  ];
  for (const s of duneSpots) addMesh(unitBox, duneMat, s.pos, s.size);

  return {
    dispose(): void {
      for (const m of extraMeshes) scene.remove(m);
      for (const l of extraLights) scene.remove(l);
      for (const g of extraGeometries) g.dispose();
      for (const m of extraMaterials) m.dispose();
      for (const t of extraTextures) t.dispose();
    },
  };
}
