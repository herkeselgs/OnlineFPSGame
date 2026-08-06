import { MapDefinition } from "@fps/shared";
import * as THREE from "three";
import { applyBastionTheme } from "./BastionDetails";
import { applyFoundryTheme } from "./FoundryDetails";
import { applyOutpostTheme } from "./OutpostDetails";

export interface BuiltMapScene {
  meshes: THREE.Mesh[];
  dispose(): void;
}

/** Per-map visual dressing (textures, decorative props, extra lighting) —
 * one module per map id, each free to give its map a distinct look since
 * none of them touch collision (see each file's comment). Keyed by id
 * rather than an if/else chain so adding a future map's theme is a
 * one-line addition here. */
const MAP_THEMES: Record<string, (scene: THREE.Scene, meshes: THREE.Mesh[]) => { dispose(): void }> = {
  "test-arena": applyFoundryTheme,
  bastion: applyBastionTheme,
  outpost: applyOutpostTheme,
};

/**
 * Builds the low-poly render geometry for a map directly from the shared
 * MapDefinition — the same block list the server/client use for collision.
 * Flat MeshLambertMaterial (no PBR, no shadow maps) keeps this cheap on
 * integrated GPUs. Returns a dispose() so switching maps (practice map
 * choice, or a different map each match) doesn't leak geometry/materials/
 * lights from the previous map.
 */
export function buildMapScene(scene: THREE.Scene, map: MapDefinition): BuiltMapScene {
  scene.background = new THREE.Color(map.skyColor);
  scene.fog = new THREE.FogExp2(map.fogColor, map.fogDensity);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x404050, map.ambientIntensity);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(30, 45, 20);
  sun.castShadow = false; // deliberately off — real-time shadows tank Chromebook GPUs
  scene.add(sun);

  const materialCache = new Map<number, THREE.MeshLambertMaterial>();
  const getMaterial = (color: number) => {
    let mat = materialCache.get(color);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({ color });
      materialCache.set(color, mat);
    }
    return mat;
  };

  const geometry = new THREE.BoxGeometry(1, 1, 1);

  const meshes: THREE.Mesh[] = [];
  for (const block of map.blocks) {
    const mesh = new THREE.Mesh(geometry, getMaterial(block.color));
    mesh.scale.set(block.half.x * 2, block.half.y * 2, block.half.z * 2);
    mesh.position.set(block.center.x, block.center.y, block.center.z);
    mesh.userData.blockKind = block.kind;
    scene.add(mesh);
    meshes.push(mesh);
  }

  // Ladders render as rungs + side rails so they read as climbable at a
  // glance, but deliberately aren't added to `meshes` — that array doubles
  // as the hitscan/LOS raycast target list, and a thin ladder frame
  // shouldn't block bullets or sightlines the way solid geometry does.
  const ladderMaterial = new THREE.MeshLambertMaterial({ color: 0x2c2f33 });
  const ladderMeshes: THREE.Mesh[] = [];
  for (const zone of map.ladders) {
    const widthAxis = zone.depthAxis === "x" ? "z" : "x";
    const width = zone.half[widthAxis] * 2;
    const height = zone.half.y * 2;
    const rungSpacing = 0.35;
    const rungCount = Math.max(2, Math.round(height / rungSpacing));
    const rungThickness = 0.06;

    for (let i = 0; i < rungCount; i++) {
      const t = (i + 0.5) / rungCount;
      const y = zone.center.y - zone.half.y + t * height;
      const rung = new THREE.Mesh(geometry, ladderMaterial);
      if (zone.depthAxis === "x") {
        rung.scale.set(zone.half.x * 2 * 0.8, rungThickness, width * 0.85);
      } else {
        rung.scale.set(width * 0.85, rungThickness, zone.half.z * 2 * 0.8);
      }
      rung.position.set(zone.center.x, y, zone.center.z);
      scene.add(rung);
      ladderMeshes.push(rung);
    }

    const railThickness = 0.05;
    for (const sign of [-1, 1] as const) {
      const rail = new THREE.Mesh(geometry, ladderMaterial);
      if (zone.depthAxis === "x") {
        rail.scale.set(zone.half.x * 2, height, railThickness);
        rail.position.set(zone.center.x, zone.center.y, zone.center.z + sign * width * 0.42);
      } else {
        rail.scale.set(railThickness, height, zone.half.z * 2);
        rail.position.set(zone.center.x + sign * width * 0.42, zone.center.y, zone.center.z);
      }
      scene.add(rail);
      ladderMeshes.push(rail);
    }
  }

  // Runs after the base meshes above exist since each theme re-skins their
  // materials and reads their sizes/positions.
  const theme = MAP_THEMES[map.id]?.(scene, meshes) ?? null;

  return {
    meshes,
    dispose() {
      scene.remove(hemi);
      scene.remove(sun);
      for (const mesh of meshes) scene.remove(mesh);
      for (const mesh of ladderMeshes) scene.remove(mesh);
      geometry.dispose();
      ladderMaterial.dispose();
      for (const mat of materialCache.values()) mat.dispose();
      theme?.dispose();
    },
  };
}
