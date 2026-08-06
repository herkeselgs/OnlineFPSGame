import * as THREE from "three";

/**
 * Small procedural canvas-texture helpers — this game has no asset pipeline
 * (see SceneBuilder's file comment: flat MeshLambertMaterial, no PBR/loaded
 * textures, cheap on integrated GPUs), so "give a surface visual identity"
 * means drawing a tileable pattern into a 2D canvas at build time rather
 * than loading an image file. Each pattern is drawn once into a shared
 * canvas per kind; callers needing different real-world tiling density
 * (a 41m-wide wall vs a 3m crate) clone the resulting texture and set
 * `repeat` per instance rather than redrawing the canvas.
 */

const TILE_PX = 128;

function makeCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = TILE_PX;
  canvas.height = TILE_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  return { canvas, ctx };
}

function finish(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Clones a base tileable texture and sets its repeat to match a real-world
 * size at `tileMeters` per tile — the standard fix for a shared unit-cube
 * BoxGeometry (sized via mesh.scale, so UVs always run 0..1 regardless of
 * the mesh's actual dimensions) needing consistent texel density across
 * differently-sized boxes of the same material. */
export function tiledTexture(base: THREE.Texture, widthMeters: number, heightMeters: number, tileMeters: number): THREE.Texture {
  const tex = base.clone();
  tex.needsUpdate = true;
  tex.repeat.set(Math.max(1, widthMeters / tileMeters), Math.max(1, heightMeters / tileMeters));
  return tex;
}

/** Riveted steel panel: seam lines on a grid + a rivet dot at each
 * intersection + faint diagonal brushed-metal streaking. Used for walls and
 * the crate-style cover props. */
export function buildPanelTexture(baseColor: string, seamColor: string, rivetColor: string): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);

  // Faint brushed-metal streaks.
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = "#ffffff";
  for (let i = 0; i < 18; i++) {
    const y = (i / 18) * TILE_PX + Math.random() * 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TILE_PX, y + (Math.random() - 0.5) * 6);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Panel seam border.
  ctx.strokeStyle = seamColor;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, TILE_PX - 3, TILE_PX - 3);

  // Rivets at the corners.
  ctx.fillStyle = rivetColor;
  const inset = 10;
  for (const [rx, ry] of [
    [inset, inset],
    [TILE_PX - inset, inset],
    [inset, TILE_PX - inset],
    [TILE_PX - inset, TILE_PX - inset],
  ]) {
    ctx.beginPath();
    ctx.arc(rx, ry, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  return finish(canvas);
}

/** Diamond-plate (checker-plate) steel: raised diamond bumps in a grid,
 * shaded with a light/dark pair to read as embossed under flat lighting.
 * Used for platform tops. */
export function buildDiamondPlateTexture(baseColor: string): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);

  const step = TILE_PX / 4;
  for (let iy = 0; iy < 4; iy++) {
    for (let ix = 0; ix < 4; ix++) {
      const cx = ix * step + step / 2 + (iy % 2 === 0 ? 0 : step / 2);
      const cy = iy * step + step / 2;
      const s = step * 0.28;
      ctx.beginPath();
      ctx.moveTo(cx, cy - s);
      ctx.lineTo(cx + s, cy);
      ctx.lineTo(cx, cy + s);
      ctx.lineTo(cx - s, cy);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx, cy - s);
      ctx.lineTo(cx - s, cy);
      ctx.lineTo(cx, cy + s * 0.15);
      ctx.closePath();
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fill();
    }
  }

  return finish(canvas);
}

/** Worn concrete/metal floor: subtle mottled noise + a faint expansion-
 * joint grid line every tile. */
export function buildFloorTexture(baseColor: string, jointColor: string): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = baseColor;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);

  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * TILE_PX;
    const y = Math.random() * TILE_PX;
    const v = Math.random();
    ctx.fillStyle = v > 0.5 ? "#000000" : "#ffffff";
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = jointColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, TILE_PX, TILE_PX);

  return finish(canvas);
}

/** Diagonal yellow/black hazard stripe band — used as a thin accent strip
 * near platform edges, the pillar's base, and cover prop trim. */
export function buildHazardStripeTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas();
  ctx.fillStyle = "#f2c230";
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  ctx.fillStyle = "#1c1c1c";
  const stripeWidth = TILE_PX / 6;
  ctx.save();
  ctx.translate(TILE_PX / 2, TILE_PX / 2);
  ctx.rotate(Math.PI / 4);
  ctx.translate(-TILE_PX, -TILE_PX);
  for (let i = 0; i < 8; i++) {
    if (i % 2 === 0) ctx.fillRect(i * stripeWidth, 0, stripeWidth, TILE_PX * 2);
  }
  ctx.restore();
  return finish(canvas);
}
