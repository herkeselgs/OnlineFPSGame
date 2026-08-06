import * as THREE from "three";

/**
 * Gradient sky (canvas-baked equirectangular texture) instead of the flat
 * single-color background this used to be. Originally built with three.js's
 * physically-based Sky addon (a per-fragment atmospheric-scattering shader),
 * but that cost ~35% of frame time in testing — a real cost for a full-
 * screen dynamic shader, and this renderer deliberately stays cheap on
 * integrated GPUs (see SceneBuilder's file comment: flat Lambert materials,
 * no shadow maps). A baked gradient is the same "draw it once into a 2D
 * canvas at build time" trick every other surface in this game already uses
 * (see proceduralTextures.ts) — background rendering then costs one texture
 * sample per background pixel, the same as the flat color it replaces,
 * instead of evaluating scattering math per fragment every frame.
 *
 * `EquirectangularReflectionMapping` is what makes three.js treat this flat
 * 2D image as a spherical background sampled by view direction. One preset
 * per map, tuned by eye to match/replace that map's old flat skyColor mood:
 * Foundry stays a bright clear midday, Bastion becomes a warm low-sun dusk,
 * Outpost a cool hazy overcast dusk. The returned `sunDirection` also drives
 * the scene's DirectionalLight (and is the exact vector the glow blob below
 * is placed at), so the visible sun position and the actual key-light
 * direction always agree.
 */
interface SkyPreset {
  /** Sky color at the zenith (straight up). */
  zenithColor: string;
  /** Sky color right at the horizon band. */
  horizonColor: string;
  /** Warm glow color painted around the sun position. */
  glowColor: string;
  glowRadius: number;
  /** Degrees above the horizon. */
  elevationDeg: number;
  /** Compass-style rotation around the up axis, degrees. */
  azimuthDeg: number;
  sunColor: number;
  sunIntensity: number;
}

const SKY_PRESETS: Record<string, SkyPreset> = {
  // Foundry: bright, clear midday sky — matches the old cheerful sky-blue flat color.
  "test-arena": {
    zenithColor: "#4f8fce",
    horizonColor: "#dcedf7",
    glowColor: "#fffdf2",
    glowRadius: 0.35,
    elevationDeg: 58,
    azimuthDeg: 145,
    sunColor: 0xfff4e0,
    sunIntensity: 1.25,
  },
  // Bastion: warm, low-sun dusk — matches the old sunset-orange flat color.
  bastion: {
    zenithColor: "#2c4d78",
    horizonColor: "#f6b489",
    glowColor: "#ffe2a8",
    glowRadius: 0.4,
    elevationDeg: 7,
    azimuthDeg: 205,
    sunColor: 0xffb066,
    sunIntensity: 1.3,
  },
  // Outpost: cool, hazy overcast dusk — matches the old muted blue-gray flat color.
  outpost: {
    zenithColor: "#33495a",
    horizonColor: "#a9c1cc",
    glowColor: "#d9e6ea",
    glowRadius: 0.32,
    elevationDeg: 15,
    azimuthDeg: 250,
    sunColor: 0x9fb8c8,
    sunIntensity: 1.15,
  },
};

const DEFAULT_PRESET = SKY_PRESETS["test-arena"];

const WIDTH = 512;
const HEIGHT = 256;

function sunDirectionFor(preset: SkyPreset): THREE.Vector3 {
  return new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - preset.elevationDeg),
    THREE.MathUtils.degToRad(preset.azimuthDeg)
  );
}

/** Same convention three.js's own equirect shader chunk uses, so the glow
 * blob painted here lands exactly where EquirectangularReflectionMapping
 * will later sample this direction from. */
function equirectUv(dir: THREE.Vector3): { u: number; v: number } {
  const u = Math.atan2(dir.z, dir.x) / (2 * Math.PI) + 0.5;
  const v = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) / Math.PI + 0.5;
  return { u, v };
}

function buildTexture(preset: SkyPreset, sunDirection: THREE.Vector3): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  // Vertical gradient: canvas row 0 = zenith (v=1, straight up), row
  // HEIGHT/2 = horizon (v=0.5), extending toward the horizon tone below
  // that too (rarely visible — the map floor covers that view — but avoids
  // a hard seam if a gap in geometry ever exposes it).
  const gradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  gradient.addColorStop(0, preset.zenithColor);
  gradient.addColorStop(0.85, preset.horizonColor);
  gradient.addColorStop(1, preset.horizonColor);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Soft sun glow, drawn at its true equirect position plus one tiled copy
  // on each side so it still blends smoothly if it sits near the u=0/u=1
  // wrap seam.
  const { u, v } = equirectUv(sunDirection);
  const cx = u * WIDTH;
  const cy = (1 - v) * HEIGHT;
  const r = preset.glowRadius * WIDTH;
  ctx.globalCompositeOperation = "lighter";
  for (const offset of [-WIDTH, 0, WIDTH]) {
    const glow = ctx.createRadialGradient(cx + offset, cy, 0, cx + offset, cy, r);
    glow.addColorStop(0, preset.glowColor);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
  ctx.globalCompositeOperation = "source-over";

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export interface BuiltSky {
  texture: THREE.CanvasTexture;
  /** Unit vector pointing FROM the scene TOWARD the sun — feed this
   * directly into a DirectionalLight's position (any distance along it) to
   * match the visible glow. */
  sunDirection: THREE.Vector3;
  sunColor: number;
  sunIntensity: number;
  dispose(): void;
}

export function buildSky(mapId: string): BuiltSky {
  const preset = SKY_PRESETS[mapId] ?? DEFAULT_PRESET;
  const sunDirection = sunDirectionFor(preset);
  const texture = buildTexture(preset, sunDirection);

  return {
    texture,
    sunDirection,
    sunColor: preset.sunColor,
    sunIntensity: preset.sunIntensity,
    dispose() {
      texture.dispose();
    },
  };
}
