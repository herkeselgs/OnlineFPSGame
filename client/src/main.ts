import { DEFAULT_MAP_ID, MapDefinition, MAPS } from "@fps/shared";
import * as THREE from "three";
import { soundEngine } from "./audio/SoundEngine";
import { InputManager } from "./engine/InputManager";
import { BotMatchResult, BotMode } from "./game/BotMode";
import { BOT_DIFFICULTIES, BotDifficultyLevel, DEFAULT_BOT_DIFFICULTY } from "./game/botDifficulty";
import { MatchController } from "./game/MatchController";
import { PracticeMode } from "./game/PracticeMode";
import { MultiplayerFlow } from "./net/MultiplayerFlow";
import { buildMapScene, BuiltMapScene } from "./render/SceneBuilder";
import { settingsStore } from "./state/settings";
import { Hud } from "./ui/Hud";
import { ProgressionUI } from "./ui/ProgressionUI";

// Browsers block audio until a real user gesture — resume on the very first
// pointer interaction anywhere, so audio is ready well before any button the
// player might click to start playing.
document.addEventListener("pointerdown", () => soundEngine.resume(), { once: true });

// One delegated listener covers every button in the app (menu, lobby,
// results, settings, map selector) rather than wiring a click sound into
// each individual handler.
document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("button")) soundEngine.playUIClick();
});

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
const volumeSlider = document.getElementById("volume-slider") as HTMLInputElement;
const volumeValueLabel = document.getElementById("volume-value") as HTMLSpanElement;

// --- Dev settings panel wiring (stand-in for the full Settings screen coming later) ---
function syncSettingsUI() {
  const s = settingsStore.get();
  looksModeSelect.value = s.lookMode;
  trackpadToggle.checked = s.trackpadMode;
  sensitivitySlider.value = String(s.sensitivity);
  sensValueLabel.textContent = s.sensitivity.toFixed(2);
  invertYToggle.checked = s.invertY;
  volumeSlider.value = String(s.masterVolume);
  volumeValueLabel.textContent = `${Math.round(s.masterVolume * 100)}%`;
  soundEngine.setVolume(s.masterVolume);
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
volumeSlider.addEventListener("input", () => {
  const v = parseFloat(volumeSlider.value);
  volumeValueLabel.textContent = `${Math.round(v * 100)}%`;
  settingsStore.update({ masterVolume: v });
  soundEngine.setVolume(v);
});

// --- Three.js scene setup ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.05, 200);
camera.rotation.order = "YXZ";
// WebGLRenderer.render(scene, camera) only ever walks the `scene` graph to
// build its render list — camera.add(x) (MuzzleFlashEffect's sprite, the
// first-person Viewmodel) silently never renders unless the camera itself
// is somewhere inside that graph. Doesn't affect view/projection (those
// still come from the `camera` argument passed to render() directly), just
// makes its children actually show up.
scene.add(camera);

// Map geometry is (re)built on demand — practice mode and each multiplayer
// match may use a different map, so nothing is built once-and-reused here.
let currentBuilt: BuiltMapScene | null = null;

function loadMap(mapId: string): { map: MapDefinition; meshes: THREE.Mesh[] } {
  const map = MAPS[mapId] ?? MAPS[DEFAULT_MAP_ID];
  if (currentBuilt) currentBuilt.dispose();
  currentBuilt = buildMapScene(scene, map);
  return { map, meshes: currentBuilt.meshes };
}

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
let botMode: BotMode | null = null;

function startPractice(mapId: string): void {
  if (practice) practice.dispose();
  const { map, meshes } = loadMap(mapId);
  practice = new PracticeMode(scene, camera, input, hud, map, meshes);
  activeMode = practice;
  hud.showWeaponHud();
  lockTitle.textContent = `${map.name} — Practice Mode`;
  lockOverlay.classList.remove("hidden");
}

function stopPractice(): void {
  if (!practice) return;
  if (activeMode === practice) activeMode = null;
  practice.dispose();
  practice = null;
}

function startBotMatch(mapId: string, difficulty: BotDifficultyLevel): void {
  if (botMode) botMode.dispose();
  screenBotResults.classList.add("hidden");
  const { map, meshes } = loadMap(mapId);
  botMode = new BotMode(scene, camera, input, hud, map, meshes, difficulty, (result) => showBotResults(result));
  activeMode = botMode;
  hud.showWeaponHud();
  lockTitle.textContent = `${map.name} — vs Computer (${BOT_DIFFICULTIES[difficulty].label})`;
  lockOverlay.classList.remove("hidden");
}

function stopBotMode(): void {
  if (!botMode) return;
  if (activeMode === botMode) activeMode = null;
  botMode.dispose();
  botMode = null;
}

function showBotResults(result: BotMatchResult): void {
  if (activeMode === botMode) activeMode = null;
  input.exitPointerLock();
  lockOverlay.classList.add("hidden");
  botResultsTitle.textContent =
    result.playerKills > result.botKills ? "You Win!" : result.playerKills < result.botKills ? "Bot Wins" : "Draw";
  botResultsScores.textContent = `You ${result.playerKills} — ${result.botKills} Bot`;
  screenBotResults.classList.remove("hidden");
}

const practiceMapSelect = document.getElementById("practice-map") as HTMLSelectElement;
btnPractice.addEventListener("click", () => {
  multiplayer.hideAllScreens();
  stopBotMode();
  startPractice(practiceMapSelect.value);
});

const botDifficultySelect = document.getElementById("bot-difficulty") as HTMLSelectElement;
botDifficultySelect.value = DEFAULT_BOT_DIFFICULTY;
const btnPlayBot = document.getElementById("btn-play-bot") as HTMLButtonElement;
const screenBotResults = document.getElementById("screen-bot-results") as HTMLDivElement;
const botResultsTitle = document.getElementById("bot-results-title") as HTMLHeadingElement;
const botResultsScores = document.getElementById("bot-results-scores") as HTMLDivElement;
const btnBotRematch = document.getElementById("btn-bot-rematch") as HTMLButtonElement;
const btnBotResultsMenu = document.getElementById("btn-bot-results-menu") as HTMLButtonElement;

btnPlayBot.addEventListener("click", () => {
  multiplayer.hideAllScreens();
  stopPractice();
  startBotMatch(practiceMapSelect.value, botDifficultySelect.value as BotDifficultyLevel);
});

btnBotRematch.addEventListener("click", () => {
  startBotMatch(practiceMapSelect.value, botDifficultySelect.value as BotDifficultyLevel);
});

btnBotResultsMenu.addEventListener("click", () => {
  stopBotMode();
  screenBotResults.classList.add("hidden");
  multiplayer.showMenu();
});

const multiplayer = new MultiplayerFlow(scene, camera, input, hud, loadMap, (match: MatchController | null) => {
  stopPractice();
  stopBotMode();
  activeMode = match;
  if (match) {
    hud.showWeaponHud();
    lockOverlay.classList.add("hidden");
  }
});

new ProgressionUI(
  () => multiplayer.showMenu(),
  () => multiplayer.hideAllScreens()
);

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
  } else if (activeMode === botMode) {
    stopBotMode();
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
  if (activeMode === practice || activeMode === botMode) {
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

  // Captured once per frame rather than re-reading the outer `activeMode`
  // between calls — BotMode's match-end callback fires synchronously from
  // inside its own update() (no server round-trip to defer it to, unlike
  // Duel), which reassigns the outer variable to null mid-frame. Re-reading
  // it for getShakeOffset() would then crash on a null access.
  const mode = activeMode;
  if (mode) {
    mode.update(frameDt);
    const shake = mode.getShakeOffset();
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
    get botMode() {
      return botMode;
    },
    camera,
    scene,
    multiplayer,
    soundEngine,
  };
}
