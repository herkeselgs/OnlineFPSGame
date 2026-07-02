import { DEFAULT_MAP_ID, MAPS } from "@fps/shared";
import * as THREE from "three";
import { InputManager } from "./engine/InputManager";
import { MatchController } from "./game/MatchController";
import { PracticeMode } from "./game/PracticeMode";
import { MultiplayerFlow } from "./net/MultiplayerFlow";
import { buildMapScene } from "./render/SceneBuilder";
import { settingsStore } from "./state/settings";
import { Hud } from "./ui/Hud";

interface GameModeLike {
  update(frameDt: number): void;
  getShakeOffset(): { yaw: number; pitch: number; roll: number };
}

const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
const lockOverlay = document.getElementById("lock-overlay") as HTMLDivElement;
const lockTitle = document.getElementById("lock-title") as HTMLHeadingElement;
const btnStart = document.getElementById("btn-start") as HTMLButtonElement;
const btnLeaveMatch = document.getElementById("btn-leave-match") as HTMLButtonElement;
const btnPractice = document.getElementById("btn-practice") as HTMLButtonElement;
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
const mapMeshes = buildMapScene(scene, map);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Input + HUD (shared across practice and match modes) ---
const input = new InputManager(canvas, (locked) => {
  if (locked) lockOverlay.classList.add("hidden");
});
const hud = new Hud();

// --- Mode management: menu (idle) <-> practice <-> multiplayer match ---
let activeMode: GameModeLike | null = null;
let practice: PracticeMode | null = null;

function startPractice(): void {
  if (practice) practice.dispose();
  practice = new PracticeMode(scene, camera, input, hud, map, mapMeshes);
  activeMode = practice;
  lockTitle.textContent = "Foundry — Practice Mode";
  lockOverlay.classList.remove("hidden");
}

function stopPractice(): void {
  if (!practice) return;
  if (activeMode === practice) activeMode = null;
  practice.dispose();
  practice = null;
}

btnPractice.addEventListener("click", () => {
  multiplayer.hideAllScreens();
  startPractice();
});

const multiplayer = new MultiplayerFlow(scene, camera, input, hud, mapMeshes, map, (match: MatchController | null) => {
  stopPractice();
  activeMode = match;
  if (match) lockOverlay.classList.add("hidden");
});

btnStart.addEventListener("click", () => {
  const mode = settingsStore.get().lookMode;
  if (mode === "pointer-lock") {
    input.requestPointerLock();
  } else {
    lockOverlay.classList.add("hidden");
  }
});

btnLeaveMatch.addEventListener("click", () => {
  input.exitPointerLock();
  lockOverlay.classList.add("hidden");
  if (activeMode === practice) {
    stopPractice();
    multiplayer.showMenu();
  } else {
    multiplayer.leaveRoom();
  }
});

// Drag-to-look mode has no "locked" concept, so hide overlay on canvas click too.
canvas.addEventListener("mousedown", () => {
  if (settingsStore.get().lookMode === "drag") {
    lockOverlay.classList.add("hidden");
  }
});

window.addEventListener("keydown", (e) => {
  if (e.code !== "Escape") return;
  if (activeMode === practice) {
    lockOverlay.classList.remove("hidden");
  } else {
    input.exitPointerLock();
  }
});

// --- Perf HUD (toggle with F3) ---
let showPerf = false;
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

  if (activeMode) {
    activeMode.update(frameDt);
    const shake = activeMode.getShakeOffset();
    camera.rotation.x += shake.pitch;
    camera.rotation.y += shake.yaw;
    camera.rotation.z += shake.roll;
    renderer.render(scene, camera);
  }

  frames++;
  fpsAccum += frameDt;
  if (fpsAccum >= 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
  }

  if (showPerf && activeMode === practice && practice) {
    perfHud.style.display = "block";
    const p = practice.player.state;
    perfHud.textContent = `${fps} fps\npos ${p.position.x.toFixed(1)}, ${p.position.y.toFixed(1)}, ${p.position.z.toFixed(1)}\nground ${p.onGround}`;
  } else if (showPerf) {
    perfHud.style.display = "block";
    perfHud.textContent = `${fps} fps`;
  } else {
    perfHud.style.display = "none";
  }
}

requestAnimationFrame(animate);

multiplayer.showMenu();

// Dev-only inspection hook, stripped from production builds by Vite's
// import.meta.env.DEV dead-code elimination.
if (import.meta.env.DEV) {
  (window as unknown as { __debug: unknown }).__debug = {
    get practice() {
      return practice;
    },
    get activeMode() {
      return activeMode;
    },
    get player() {
      return practice?.player;
    },
    get combat() {
      return practice?.combat;
    },
    camera,
    scene,
    multiplayer,
  };
}
