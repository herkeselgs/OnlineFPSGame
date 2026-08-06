import * as THREE from "three";
import {
  buildDiamondPlateTexture,
  buildFloorTexture,
  buildHazardStripeTexture,
  buildPanelTexture,
  tiledTexture,
} from "./proceduralTextures";

/**
 * Foundry-only visual dressing: re-skins the map's existing block meshes
 * with tiled procedural textures (by kind) and layers in purely decorative
 * extras (ceiling trusses, hanging work lights, wall pipes, crate lids,
 * platform trim, a distant skyline). Nothing here touches collision —
 * every prop added is scene-only, never added to the raycast/hitscan
 * `meshes` list SceneBuilder returns, same pattern as ladder rungs/rails
 * already use. Called once from buildMapScene, gated to test-arena only,
 * so Bastion/Outpost are untouched.
 */

const STEEL = "#5b6672";
const STEEL_SEAM = "#242a30";
const RIVET = "#9aa4ad";
const CRATE = "#6b5a42";
const CRATE_SEAM = "#332a1e";
const CRATE_RIVET = "#c9a35a";
const PLATE = "#4a545e";
const FLOOR_BASE = "#454d54";
const FLOOR_JOINT = "#2c3237";
const LAMP_WARM = 0xffc98a;

export function applyFoundryTheme(scene: THREE.Scene, meshes: THREE.Mesh[]): { dispose(): void } {
  // Every disposable resource this pass creates lands in exactly one of
  // these arrays — nothing is tracked twice, and cloned per-block textures
  // (from tiledTexture) are tracked too, since Material.dispose() does NOT
  // free the textures it references.
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

  // --- Base tileable patterns (one canvas draw each, cloned+repeated per
  // block below for correct real-world texel density). ---
  const panelTex = buildPanelTexture(STEEL, STEEL_SEAM, RIVET);
  const crateTex = buildPanelTexture(CRATE, CRATE_SEAM, CRATE_RIVET);
  const plateTex = buildDiamondPlateTexture(PLATE);
  const floorTex = buildFloorTexture(FLOOR_BASE, FLOOR_JOINT);
  const hazardTex = buildHazardStripeTexture();
  extraTextures.push(panelTex, crateTex, plateTex, floorTex, hazardTex);

  const unitBox = geo(new THREE.BoxGeometry(1, 1, 1));

  // --- Re-skin existing collision blocks by kind, tiling each texture to
  // that block's actual footprint so a 41m wall and a 3m crate both read at
  // a consistent scale instead of one giant stretched copy. ---
  const TILE_M = 2.2;
  for (const mesh of meshes) {
    const kind = mesh.userData.blockKind as string | undefined;
    const [w, h, d] = [mesh.scale.x, mesh.scale.y, mesh.scale.z];
    let material: THREE.MeshLambertMaterial | null = null;

    if (kind === "floor") {
      material = mat({ map: tiled(floorTex, w, d, TILE_M) });
    } else if (kind === "wall") {
      material = mat({ map: tiled(panelTex, Math.max(w, d), h, TILE_M) });
    } else if (kind === "cover") {
      material = mat({ map: tiled(crateTex, Math.max(w, d), h, TILE_M * 0.7) });
    } else if (kind === "platform" || kind === "ramp") {
      // Top-face dominant (stood on) — (w,d), not a height-based repeat
      // (diamond plate is isotropic so this was never visibly wrong here,
      // unlike the directional brick/plank patterns Bastion caught it on,
      // but the correct dimensions are still (w,d)).
      material = mat({ map: tiled(plateTex, w, d, TILE_M * 0.6) });
    }

    if (material) mesh.material = material;
  }

  // --- Crate lids: a slightly inset, contrasting-color slab on top of each
  // cover box so the flat cube reads as a stacked crate rather than a
  // plain block. Purely decorative — sized just inside the collision
  // footprint so it never pokes out past the actual hitbox. ---
  const lidMaterial = mat({ color: 0x8a734f });
  for (const mesh of meshes) {
    if (mesh.userData.blockKind !== "cover") continue;
    const [w, h, d] = [mesh.scale.x, mesh.scale.y, mesh.scale.z];
    // Skip the tall center pillar (roughly square footprint, much taller
    // than the corner crates) — it gets its own base-collar treatment
    // below instead of a crate lid.
    if (h > 2) continue;
    addMesh(unitBox, lidMaterial, [mesh.position.x, mesh.position.y + h / 2 + 0.04, mesh.position.z], [w * 0.94, 0.08, d * 0.94]);
  }

  // --- Center pillar: riveted base collar + hazard-stripe band so it
  // reads as a structural support column, not a gray box. ---
  const pillar = meshes.find((m) => m.userData.blockKind === "cover" && m.scale.y > 2);
  if (pillar) {
    const collarMat = mat({ map: tiled(panelTex, pillar.scale.x * 1.3, 0.3, TILE_M * 0.5) });
    addMesh(unitBox, collarMat, [pillar.position.x, 0.15, pillar.position.z], [pillar.scale.x * 1.35, 0.3, pillar.scale.z * 1.35]);

    const stripeMat = mat({ map: tiled(hazardTex, pillar.scale.x * 4, 0.35, 0.9) });
    addMesh(unitBox, stripeMat, [pillar.position.x, 0.42, pillar.position.z], [pillar.scale.x * 1.02, 0.32, pillar.scale.z * 1.02]);
  }

  // --- Wall base trim: a hazard-stripe strip along the interior floor/wall
  // junction of the two long (north/south) walls, facing into the arena. ---
  const stripeStripMat = mat({ map: tiled(hazardTex, 12, 0.3, 0.9) });
  for (const wall of meshes) {
    if (wall.userData.blockKind !== "wall") continue;
    const isLongWall = wall.scale.x > wall.scale.z; // north/south walls are wide in X
    if (!isLongWall) continue;
    const faceZ = wall.position.z > 0 ? wall.position.z - wall.scale.z / 2 - 0.03 : wall.position.z + wall.scale.z / 2 + 0.03;
    addMesh(unitBox, stripeStripMat, [wall.position.x, 0.15, faceZ], [wall.scale.x * 0.985, 0.3, 0.05]);
  }

  // --- Wall-mounted pipes: a pair of horizontal conduits running the
  // length of each long wall, offset above the hazard strip. A touch of
  // emissive keeps thin dark props like this from crushing to pure black
  // when a grazing/near-end-on view angle puts them at a steep angle to
  // both the hemisphere and directional light (see trussMat below for the
  // same fix on a case where it's much more visible). ---
  const pipeMat = mat({ color: 0x3a4550, emissive: 0x14181d, emissiveIntensity: 0.5 });
  const pipeGeo = geo(new THREE.CylinderGeometry(0.08, 0.08, 1, 8));
  for (const wall of meshes) {
    if (wall.userData.blockKind !== "wall") continue;
    if (wall.scale.x <= wall.scale.z) continue; // long walls only
    const faceZ = wall.position.z > 0 ? wall.position.z - wall.scale.z / 2 - 0.12 : wall.position.z + wall.scale.z / 2 + 0.12;
    for (const y of [0.9, 2.7]) {
      addMesh(pipeGeo, pipeMat, [wall.position.x, y, faceZ], [1, wall.scale.x * 1.9, 1]).rotation.z = Math.PI / 2;
    }
  }

  // --- Platform trim: thin hazard-stripe edge lip around each platform's
  // top perimeter, and a couple of low guard rail posts+rail for
  // readability (purely visual — no collision, matches the rest of this
  // pass). ---
  const railMat = mat({ color: 0x2c333a, emissive: 0x111318, emissiveIntensity: 0.5 });
  const railGeo = geo(new THREE.CylinderGeometry(0.035, 0.035, 1, 6));
  for (const platform of meshes) {
    if (platform.userData.blockKind !== "platform") continue;
    const [w, h, d] = [platform.scale.x, platform.scale.y, platform.scale.z];
    const topY = platform.position.y + h / 2;
    const edgeStripMat = mat({ map: tiled(hazardTex, w, 0.2, 0.8) });
    // Outer-facing edge (away from map center) gets the hazard lip — the
    // side a player actually approaches/falls off of.
    const outward = platform.position.x < 0 ? -1 : 1;
    addMesh(unitBox, edgeStripMat, [platform.position.x + (outward * w) / 2, topY + 0.02, platform.position.z], [0.06, 0.06, d * 0.98]);

    // Two waist-high rail posts + a top rail along the outward edge.
    const railX = platform.position.x + (outward * w) / 2 - outward * 0.06;
    for (const rz of [-d / 2 + 0.4, d / 2 - 0.4]) {
      addMesh(railGeo, railMat, [railX, topY + 0.45, platform.position.z + rz], [1, 0.9, 1]);
    }
    addMesh(railGeo, railMat, [railX, topY + 0.88, platform.position.z], [1, d - 0.8, 1]).rotation.z = Math.PI / 2;
  }

  // --- Ceiling trusses + hanging work lights: breaks up the open sky
  // overhead and gives the flat hemisphere+sun lighting some warm pools of
  // contrast. Each fixture pairs a small emissive bulb mesh with a real
  // THREE.PointLight so it actually casts light, not just looks lit. ---
  const trussMat = mat({ color: 0x454e57, emissive: 0x2a3138, emissiveIntensity: 0.9 });
  // The two beam sets cross at x=0/z=0 — sharing the exact same coordinates
  // there causes z-fighting (depth-buffer precision fights between two
  // overlapping faces at an identical depth), which renders as a solid
  // black smear right where a player looking down the map's centerline
  // would see it most: nearly end-on. A small vertical offset between the
  // two sets keeps them visually one structure while never sharing exact
  // geometry.
  const trussY = 4.35;
  for (const x of [-10, 0, 10]) addMesh(unitBox, trussMat, [x, trussY + 0.05, 0], [0.22, 0.22, 27.6]);
  for (const z of [-10, 0, 10]) addMesh(unitBox, trussMat, [0, trussY - 0.05, z], [39.6, 0.16, 0.16]);

  const bulbMat = mat({ color: LAMP_WARM, emissive: LAMP_WARM, emissiveIntensity: 1.4 });
  const bulbGeo = geo(new THREE.SphereGeometry(0.14, 8, 6));
  const cordMat = mat({ color: 0x1c1f22 });
  const lampSpots: THREE.Vector3Tuple[] = [
    [-10, 0, -7],
    [10, 0, 7],
    [-10, 0, 7],
    [10, 0, -7],
    [0, 0, 0],
  ];
  for (const [x, , z] of lampSpots) {
    addMesh(unitBox, cordMat, [x, trussY - 0.3, z], [0.03, 0.55, 0.03]);
    const bulbY = trussY - 0.6;
    addMesh(bulbGeo, bulbMat, [x, bulbY, z]);

    const light = new THREE.PointLight(LAMP_WARM, 12, 11, 2);
    light.position.set(x, bulbY - 0.1, z);
    scene.add(light);
    extraLights.push(light);
  }

  // --- Distant skyline beyond the walls: large muted silhouettes so the
  // horizon isn't a flat color the moment a sightline clears the 4m
  // perimeter walls (from raised platforms/jumps especially). Fog softens
  // them, keeping the "cheap flat-shaded" look intact. ---
  const skylineMat = mat({ color: 0x6f8296 });
  const skylineSpots: { pos: THREE.Vector3Tuple; size: THREE.Vector3Tuple }[] = [
    { pos: [-32, 5, -10], size: [6, 10, 6] },
    { pos: [-30, 7, 12], size: [5, 14, 5] },
    { pos: [32, 6, 8], size: [7, 12, 7] },
    { pos: [30, 4.5, -14], size: [5, 9, 5] },
    { pos: [0, 8, -30], size: [8, 16, 30] },
    { pos: [0, 6, 30], size: [10, 12, 26] },
  ];
  for (const s of skylineSpots) addMesh(unitBox, skylineMat, s.pos, s.size);

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
