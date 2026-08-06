import * as THREE from "three";
import { buildDiamondPlateTexture, buildFloorTexture, buildHazardStripeTexture, buildWeatheredPanelTexture, tiledTexture } from "./proceduralTextures";

/**
 * Outpost-only visual dressing — sibling to FoundryDetails.ts/BastionDetails.ts,
 * same overall pattern, but a moodier weathered-military palette matching
 * Outpost's dusk sky and verticality. Trickier than the other two maps:
 * several block *kinds* here cover more than one structural role (the
 * "wall" kind spans perimeter walls, the tunnel ceiling slab, AND the tower
 * backing walls; "platform" spans both the sunken staircase treads and the
 * high catwalks) — role is disambiguated by each block's actual size/height
 * rather than kind alone. Nothing here touches collision — every prop is
 * scene-only, never added to the raycast/hitscan `meshes` list.
 */

const STEEL = "#657785";
const STEEL_SEAM = "#2b333a";
const RIVET = "#8b98a3";
const RUST = "#9a5a34";
const FLOOR_BASE = "#4f5b62";
const FLOOR_JOINT = "#33393e";
const TUNNEL_FLOOR_BASE = "#383f43";
const TUNNEL_FLOOR_JOINT = "#212528";
const PLATE = "#4a555c";
const SEARCHLIGHT = 0xbfe0ff;

export function applyOutpostTheme(scene: THREE.Scene, meshes: THREE.Mesh[]): { dispose(): void } {
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

  const panelTex = buildWeatheredPanelTexture(STEEL, STEEL_SEAM, RIVET, RUST);
  const plateTex = buildDiamondPlateTexture(PLATE);
  const floorTex = buildFloorTexture(FLOOR_BASE, FLOOR_JOINT);
  const tunnelFloorTex = buildFloorTexture(TUNNEL_FLOOR_BASE, TUNNEL_FLOOR_JOINT);
  const hazardTex = buildHazardStripeTexture();
  extraTextures.push(panelTex, plateTex, floorTex, tunnelFloorTex, hazardTex);

  const unitBox = geo(new THREE.BoxGeometry(1, 1, 1));
  const TILE_M = 2.2;

  // --- Re-skin by disambiguated role (see file comment). ---
  const towerWalls: THREE.Mesh[] = [];
  const catwalks: THREE.Mesh[] = [];
  let tunnelCeiling: THREE.Mesh | null = null;
  for (const mesh of meshes) {
    const kind = mesh.userData.blockKind as string | undefined;
    const [w, h, d] = [mesh.scale.x, mesh.scale.y, mesh.scale.z];
    let material: THREE.MeshLambertMaterial | null = null;

    if (kind === "wall") {
      // Perimeter walls are h=4, towers are h=6.5 — the threshold has to
      // sit strictly between those (5), not just above the ceiling slab's
      // 0.3, or perimeter walls get misclassified as towers too (bracing
      // and searchlights would end up on all four map edges instead of
      // just the two actual towers).
      if (h > 5) {
        material = mat({ map: tiled(panelTex, Math.max(w, d), h, TILE_M) });
        towerWalls.push(mesh);
      } else if (h < 0.5) {
        // Thin ceiling slab, same weathered steel as the walls — hazard
        // striping goes on a thin edge trim below (see after this loop),
        // not covering the whole underside like a wrapped-in-tape look.
        material = mat({ map: tiled(panelTex, w, d, TILE_M) });
        tunnelCeiling = mesh;
      } else {
        material = mat({ map: tiled(panelTex, Math.max(w, d), h, TILE_M) });
      }
    } else if (kind === "floor") {
      material = mesh.position.y < -1 ? mat({ map: tiled(tunnelFloorTex, w, d, TILE_M) }) : mat({ map: tiled(floorTex, w, d, TILE_M) });
    } else if (kind === "platform") {
      // Top-face dominant (stood on) — (w,d), same reasoning as the
      // ceiling slab above.
      if (mesh.position.y > 3) {
        material = mat({ map: tiled(plateTex, w, d, TILE_M * 0.6) });
        catwalks.push(mesh);
      } else {
        material = mat({ map: tiled(plateTex, w, d, TILE_M * 0.5) });
      }
    } else if (kind === "cover") {
      material = mat({ map: tiled(panelTex, Math.max(w, d), h, TILE_M * 0.7) });
    }

    if (material) mesh.material = material;
  }

  // --- Tunnel-mouth hazard stripes: the courtyard floor's exposed edge
  // where it drops into the sunken channel is a real fall hazard, worth
  // marking the same way the platform edges are. Repeat dimensions must
  // match the mesh's actual (thin, long) footprint — passing the wrong
  // ones here once produced comically oversized stripes. ---
  const hazardLipMat = mat({ map: tiled(hazardTex, 0.15, 12, 0.9) });
  for (const x of [-4, 4]) {
    addMesh(unitBox, hazardLipMat, [x, 0.02, 0], [0.15, 0.06, 12]);
  }

  // --- Tunnel ceiling edge trim: a thin hazard-stripe lip along both open
  // edges (the low-clearance hazard a player ducking under it should
  // notice), rather than striping the whole underside. ---
  if (tunnelCeiling) {
    const [cw, ch, cd] = [tunnelCeiling.scale.x, tunnelCeiling.scale.y, tunnelCeiling.scale.z];
    const ceilingBottomY = tunnelCeiling.position.y - ch / 2;
    const ceilingTrimMat = mat({ map: tiled(hazardTex, cw, 0.15, 0.9) });
    for (const z of [-cd / 2, cd / 2]) {
      addMesh(unitBox, ceilingTrimMat, [tunnelCeiling.position.x, ceilingBottomY - 0.01, z], [cw * 0.98, 0.05, 0.2]);
    }
  }

  // --- Tower cross-bracing: diagonal scaffold struts on the towers' side
  // faces (the courtyard-facing face already carries the real climbable
  // ladder, so bracing goes on the depth faces instead to stay clear of
  // it). Purely decorative. ---
  const braceMat = mat({ color: 0x384049, emissive: 0x161a1e, emissiveIntensity: 0.5 });
  const braceGeo = geo(new THREE.CylinderGeometry(0.045, 0.045, 1, 6));
  for (const tower of towerWalls) {
    const [w, h, d] = [tower.scale.x, tower.scale.y, tower.scale.z];
    const baseY = tower.position.y - h / 2;
    const faceZ = tower.position.z + d / 2 - 0.03;
    const braceLen = Math.hypot(w * 0.9, h / 3);
    for (let tier = 0; tier < 3; tier++) {
      const y0 = baseY + (tier * h) / 3 + 0.15;
      const y1 = baseY + ((tier + 1) * h) / 3 - 0.15;
      const brace = addMesh(braceGeo, braceMat, [tower.position.x, (y0 + y1) / 2, faceZ], [1, braceLen, 1]);
      brace.rotation.z = Math.atan2(w * 0.9, y1 - y0);
    }
  }

  // --- Catwalk guard rails, same technique as Foundry's platform trim. ---
  const railMat = mat({ color: 0x2a3138, emissive: 0x10141a, emissiveIntensity: 0.5 });
  const railGeo = geo(new THREE.CylinderGeometry(0.035, 0.035, 1, 6));
  for (const cw of catwalks) {
    const [w, h, d] = [cw.scale.x, cw.scale.y, cw.scale.z];
    const topY = cw.position.y + h / 2;
    const outward = cw.position.x < 0 ? -1 : 1;
    const railX = cw.position.x + (outward * w) / 2 - outward * 0.08;
    for (const rz of [-d / 2 + 0.35, d / 2 - 0.35]) {
      addMesh(railGeo, railMat, [railX, topY + 0.45, cw.position.z + rz], [1, 0.9, 1]);
    }
    addMesh(railGeo, railMat, [railX, topY + 0.88, cw.position.z], [1, d - 0.7, 1]).rotation.z = Math.PI / 2;
    // Outward long edge too (the side away from the tower, most exposed).
    const outEdgeZ = cw.position.z + d / 2 - 0.06;
    addMesh(railGeo, railMat, [cw.position.x, topY + 0.88, outEdgeZ], [1, w - 0.6, 1]).rotation.x = Math.PI / 2;
  }

  // --- Watchtower searchlights: a cool-white spotlight at the top of each
  // tower aimed down into the courtyard — moody dusk-outpost lighting,
  // distinct from Foundry's warm hanging work-lamps and Bastion's torches. ---
  const housingMat = mat({ color: 0x20262b, emissive: SEARCHLIGHT, emissiveIntensity: 0.3 });
  const housingGeo = geo(new THREE.CylinderGeometry(0.16, 0.2, 0.32, 10));
  for (const tower of towerWalls) {
    const [, h] = [tower.scale.x, tower.scale.y];
    const topY = tower.position.y + h / 2 + 0.2;
    const housing = addMesh(housingGeo, housingMat, [tower.position.x, topY, tower.position.z], [1, 1, 1]);
    housing.rotation.x = Math.PI / 5;

    const target = new THREE.Object3D();
    target.position.set(tower.position.x * 0.3, 0, tower.position.z + 4);
    scene.add(target);
    extraMeshes.push(target);

    const spot = new THREE.SpotLight(SEARCHLIGHT, 18, 26, Math.PI / 7, 0.5, 1.5);
    spot.position.set(tower.position.x, topY, tower.position.z);
    spot.target = target;
    scene.add(spot);
    extraLights.push(spot);
  }

  // --- Distant hazy silhouettes beyond the walls, cool-toned to match the
  // dusk mood. ---
  const skylineMat = mat({ color: 0x4a5a66 });
  const skylineSpots: { pos: THREE.Vector3Tuple; size: THREE.Vector3Tuple }[] = [
    { pos: [-33, 5, -8], size: [7, 10, 7] },
    { pos: [-30, 7.5, 13], size: [6, 15, 6] },
    { pos: [33, 6, 6], size: [8, 12, 8] },
    { pos: [30, 4, -13], size: [5, 8, 5] },
    { pos: [0, 9, -31], size: [10, 18, 8] },
    { pos: [0, 7, 31], size: [12, 14, 8] },
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
