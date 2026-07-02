import { MapDefinition } from "@fps/shared";
import * as THREE from "three";

/**
 * Builds the low-poly render geometry for a map directly from the shared
 * MapDefinition — the same block list the server/client use for collision.
 * Flat MeshLambertMaterial (no PBR, no shadow maps) keeps this cheap on
 * integrated GPUs.
 */
export function buildMapScene(scene: THREE.Scene, map: MapDefinition): void {
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

  for (const block of map.blocks) {
    const mesh = new THREE.Mesh(geometry, getMaterial(block.color));
    mesh.scale.set(block.half.x * 2, block.half.y * 2, block.half.z * 2);
    mesh.position.set(block.center.x, block.center.y, block.center.z);
    mesh.userData.blockKind = block.kind;
    scene.add(mesh);
  }
}
