export type LookMode = "pointer-lock" | "drag";

export interface Settings {
  lookMode: LookMode;
  sensitivity: number; // 0.1 - 3, applies to both modes
  trackpadMode: boolean; // apply acceleration curve instead of linear response
  trackpadCurveExponent: number; // >1 = gentler on small moves, punchier on big swipes
  invertY: boolean;
  aimAssist: boolean;
  aimAssistStrength: number; // 0 - 1
  masterVolume: number; // 0 - 1
}

export const DEFAULT_SETTINGS: Settings = {
  lookMode: "pointer-lock",
  sensitivity: 1,
  trackpadMode: false,
  trackpadCurveExponent: 1.5,
  invertY: false,
  aimAssist: true,
  aimAssistStrength: 0.35,
  masterVolume: 0.6,
};

const STORAGE_KEY = "fps-settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage unavailable (e.g. private mode) — non-fatal, settings just won't persist.
  }
}

type Listener = (settings: Settings) => void;

/** Tiny observable store so the settings UI and the input manager both stay
 * in sync without a full framework. */
export class SettingsStore {
  private settings: Settings;
  private listeners = new Set<Listener>();

  constructor() {
    this.settings = loadSettings();
  }

  get(): Settings {
    return this.settings;
  }

  update(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    for (const l of this.listeners) l(this.settings);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const settingsStore = new SettingsStore();
