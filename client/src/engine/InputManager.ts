import { Settings, settingsStore } from "../state/settings";
import { applyLookCurve } from "./LookCurve";

export interface Keybinds {
  forward: string;
  back: string;
  left: string;
  right: string;
  jump: string;
}

export const DEFAULT_KEYBINDS: Keybinds = {
  forward: "KeyW",
  back: "KeyS",
  left: "KeyA",
  right: "KeyD",
  jump: "Space",
};

/**
 * Owns keyboard state, look-delta accumulation (pointer-lock or
 * click-and-drag), and shoot/fire button state. The render loop reads
 * `consumeLookDelta()` once per frame; physics reads the movement axes
 * directly each fixed tick.
 */
export class InputManager {
  private keys = new Set<string>();
  private keybinds: Keybinds = { ...DEFAULT_KEYBINDS };

  private pointerLocked = false;
  private dragging = false;
  private lastDragX = 0;
  private lastDragY = 0;

  private pendingLookX = 0;
  private pendingLookY = 0;

  private settings: Settings;
  private justPressed = new Set<string>();

  public firing = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private onLockChange?: (locked: boolean) => void
  ) {
    this.settings = settingsStore.get();
    settingsStore.subscribe((s) => (this.settings = s));

    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);

    canvas.addEventListener("mousedown", this.handleMouseDown);
    window.addEventListener("mouseup", this.handleMouseUp);
    window.addEventListener("mousemove", this.handleMouseMove);

    document.addEventListener("pointerlockchange", this.handlePointerLockChange);
  }

  setKeybinds(binds: Partial<Keybinds>): void {
    this.keybinds = { ...this.keybinds, ...binds };
  }

  requestPointerLock(): void {
    if (this.settings.lookMode !== "pointer-lock") return;
    this.canvas.requestPointerLock();
  }

  exitPointerLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  isLocked(): boolean {
    return this.pointerLocked;
  }

  /** Returns {yaw, pitch} deltas in radians accumulated since the last call. */
  consumeLookDelta(): { yaw: number; pitch: number } {
    const yaw = this.pendingLookX;
    const pitch = this.pendingLookY;
    this.pendingLookX = 0;
    this.pendingLookY = 0;
    return { yaw, pitch };
  }

  /** Edge-triggered: true exactly once per key-down transition (works for
   * real KeyboardEvent codes and the virtual "Mouse0" left-click code). Used
   * for semi-auto fire, reload, and weapon-switch keys where holding the
   * key shouldn't repeat the action every frame. */
  consumeJustPressed(code: string): boolean {
    if (!this.justPressed.has(code)) return false;
    this.justPressed.delete(code);
    return true;
  }

  /** Raw held-state check, unlike consumeJustPressed's edge-triggered
   * one-shot — for continuous "am I holding this key right now" reads
   * (e.g. Imposter mode's hold-to-complete tasks). */
  isKeyDown(code: string): boolean {
    return this.keys.has(code);
  }

  getMoveAxes(): { forward: number; right: number; jump: boolean } {
    let forward = 0;
    let right = 0;
    if (this.keys.has(this.keybinds.forward)) forward += 1;
    if (this.keys.has(this.keybinds.back)) forward -= 1;
    if (this.keys.has(this.keybinds.right)) right += 1;
    if (this.keys.has(this.keybinds.left)) right -= 1;
    const jump = this.keys.has(this.keybinds.jump);
    return { forward, right, jump };
  }

  destroy(): void {
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    this.canvas.removeEventListener("mousedown", this.handleMouseDown);
    window.removeEventListener("mouseup", this.handleMouseUp);
    window.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("pointerlockchange", this.handlePointerLockChange);
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (!this.keys.has(e.code)) this.justPressed.add(e.code);
    this.keys.add(e.code);
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private handleMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      this.firing = true;
      this.justPressed.add("Mouse0");
    }

    if (this.settings.lookMode === "pointer-lock") {
      if (!this.pointerLocked) this.requestPointerLock();
      return;
    }

    // drag-to-look mode: any mouse button starts a drag
    this.dragging = true;
    this.lastDragX = e.clientX;
    this.lastDragY = e.clientY;
  };

  private handleMouseUp = (e: MouseEvent) => {
    if (e.button === 0) this.firing = false;
    this.dragging = false;
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (this.settings.lookMode === "pointer-lock") {
      if (!this.pointerLocked) return;
      this.accumulateLook(e.movementX, e.movementY);
      return;
    }

    if (!this.dragging) return;
    const dx = e.clientX - this.lastDragX;
    const dy = e.clientY - this.lastDragY;
    this.lastDragX = e.clientX;
    this.lastDragY = e.clientY;
    this.accumulateLook(dx, dy);
  };

  private accumulateLook(dx: number, dy: number): void {
    const yawDelta = applyLookCurve(dx, this.settings);
    const pitchRaw = applyLookCurve(dy, this.settings);
    this.pendingLookX += yawDelta;
    this.pendingLookY += this.settings.invertY ? -pitchRaw : pitchRaw;
  }

  private handlePointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    this.onLockChange?.(this.pointerLocked);
  };
}
