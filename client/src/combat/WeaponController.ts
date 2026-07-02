import { fireIntervalMs, WEAPON_ORDER, WEAPONS, WeaponDef, WeaponId } from "@fps/shared";

export interface FireAttemptResult {
  fired: boolean;
  pelletDirOffsets: number; // count only — CombatSystem generates the actual jittered directions
}

/**
 * Local ammo/fire-rate/reload state machine, one per weapon so switching
 * back and forth preserves each gun's remaining ammo (reloading cancels if
 * you swap away, same as most FPS games). This is entirely client-trusted
 * for now; the multiplayer milestone re-does fire-rate/ammo validation
 * server-side and treats this as prediction only.
 */
export class WeaponController {
  private ammo = new Map<WeaponId, number>();
  private currentId: WeaponId = "rifle";
  private cooldown = 0;
  private reloading = false;
  private reloadRemaining = 0;

  constructor() {
    for (const id of WEAPON_ORDER) this.ammo.set(id, WEAPONS[id].magazineSize);
  }

  get current(): WeaponDef {
    return WEAPONS[this.currentId];
  }

  get currentAmmo(): number {
    return this.ammo.get(this.currentId) ?? 0;
  }

  get isReloading(): boolean {
    return this.reloading;
  }

  get reloadProgress(): number {
    if (!this.reloading) return 1;
    return 1 - this.reloadRemaining / this.current.reloadTimeMs;
  }

  switchTo(id: WeaponId): void {
    if (id === this.currentId) return;
    this.currentId = id;
    this.reloading = false;
    this.reloadRemaining = 0;
    this.cooldown = 0;
  }

  cycleNext(): void {
    const idx = WEAPON_ORDER.indexOf(this.currentId);
    this.switchTo(WEAPON_ORDER[(idx + 1) % WEAPON_ORDER.length]);
  }

  update(dtMs: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dtMs);

    if (this.reloading) {
      this.reloadRemaining -= dtMs;
      if (this.reloadRemaining <= 0) {
        this.reloading = false;
        this.ammo.set(this.currentId, this.current.magazineSize);
      }
    }
  }

  startReload(): boolean {
    if (this.reloading) return false;
    if (this.currentAmmo >= this.current.magazineSize) return false;
    this.reloading = true;
    this.reloadRemaining = this.current.reloadTimeMs;
    return true;
  }

  /** Attempt to fire once. Consumes ammo + resets cooldown on success. */
  tryFire(): FireAttemptResult {
    const def = this.current;
    if (this.reloading || this.cooldown > 0 || this.currentAmmo <= 0) {
      return { fired: false, pelletDirOffsets: 0 };
    }
    this.ammo.set(this.currentId, this.currentAmmo - 1);
    this.cooldown = fireIntervalMs(def);
    if (this.currentAmmo === 0) this.startReload();
    return { fired: true, pelletDirOffsets: def.pelletCount };
  }
}
