import { DEFAULT_MAP_ID, MAPS } from "@fps/shared";
import * as THREE from "three";
import { InputManager } from "./engine/InputManager";
import { PlayerController } from "./engine/PlayerController";
import { buildMapScene } from "./render/SceneBuilder";
import { settingsStore } from "./state/settings";

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
const lockOverlay = document.getElementById("lock-overlay") as HTMLDivElement;
const btnStart = document.getElementById("btn-start") as HTMLButtonElement;
const perfHud = document.getElementById("perf-hud") as HTMLDivElement;

const looksModeSelect = document.getElementById("look-mode") as HTMLSelectElement;
const trackpadToggle = document.getElementById("trackpad-toggle") as HTMLInputElement;
const sensitivitySlider = document.getElementById("sensitivity") as HTMLInputElement;
const sensValueLabel = document.getElementById("sens-value") as HTMLSpanElement;
const invertYToggle = document.getElementById("invert-y") as HTMLInputElement;

// --- Dev settings panel wiring (stand-in for the full Settings screen coming later) ---
function syncSettingsUI() {
  const s = settingsStore.get();
  looksModeSelect.value = s.lookMode;
  trackpadToggle.checked = s.trackpadMode;
  sensitivitySlider.value = String(s.sensitivity);
  sensValueLabel.textContent = s.sensitivity.toFixed(2);
  invertYToggle.checked = s.invertY;
}
syncSettingsUI();

looksModeSelect.addEventListener("change", () => {
  settingsStore.update({ lookMode: looksModeSelect.value as "pointer-lock" | "drag" });
});
trackpadToggle.addEventListener("change", () => {
  settingsStore.update({ trackpadMode: trackpadToggle.checked });
});
sensitivitySlider.addEventListener("input", () => {
  const v = parseFloat(sensitivitySlider.value);
  sensValueLabel.textContent = v.toFixed(2);
  settingsStore.update({ sensitivity: v });
});
invertYToggle.addEventListener("change", () => {
  settingsStore.update({ invertY: invertYToggle.checked });
});

// --- Three.js scene setup ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.05, 200);
camera.rotation.order = "YXZ";

const map = MAPS[DEFAULT_MAP_ID];
buildMapScene(scene, map);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Input + player controller ---
const input = new InputManager(canvas, (locked) => {
  if (locked) lockOverlay.classList.add("hidden");
});

const player = new PlayerController(map.spawns[0], map.blocks, input);

btnStart.addEventListener("click", () => {
  const mode = settingsStore.get().lookMode;
  if (mode === "pointer-lock") {
    input.requestPointerLock();
  } else {
    lockOverlay.classList.add("hidden");
  }
});

// Drag-to-look mode has no "locked" concept, so hide overlay on canvas click too.
canvas.addEventListener("mousedown", () => {
  if (settingsStore.get().lookMode === "drag") {
    lockOverlay.classList.add("hidden");
  }
});

window.addEventListener("keydown", (e) => {
  if (e.code === "Escape") lockOverlay.classList.remove("hidden");
});

// --- Perf HUD (toggle with F3) ---
let showPerf = true;
window.addEventListener("keydown", (e) => {
  if (e.code === "F3") showPerf = !showPerf;
});

let last = performance.now();
let frames = 0;
let fpsAccum = 0;
let fps = 0;

function animate(now: number) {
  requestAnimationFrame(animate);
  const frameDt = Math.min((now - last) / 1000, 0.1);
  last = now;

  player.update(frameDt);

  const eye = player.getEyePosition();
  camera.position.set(eye.x, eye.y, eye.z);
  camera.rotation.x = player.pitch;
  camera.rotation.y = player.yaw;

  renderer.render(scene, camera);

  frames++;
  fpsAccum += frameDt;
  if (fpsAccum >= 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
  }

  if (showPerf) {
    perfHud.style.display = "block";
    perfHud.textContent = `${fps} fps\npos ${player.state.position.x.toFixed(1)}, ${player.state.position.y.toFixed(1)}, ${player.state.position.z.toFixed(1)}\nground ${player.state.onGround}`;
  } else {
    perfHud.style.display = "none";
  }
}

requestAnimationFrame(animate);
