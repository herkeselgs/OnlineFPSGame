import { fireIntervalMs, WEAPON_ORDER, WEAPONS, WeaponDef, WeaponId } from "./weapons.js";

export interface FireAttemptResult {
  fired: boolean;
  pelletCount: number;
}

/**
 * Ammo/fire-rate/reload state machine, one per weapon so switching back and
 * forth preserves each gun's remaining ammo (reloading cancels if you swap
 * away, same as most FPS games). This exact class runs in two places: on
 * the client for local prediction (instant feedback), and on the server as
 * the authoritative source of truth — the server's copy is what actually
 * decides whether a shot counts, so rate-of-fire/ammo can't be cheated by a
 * modified client.
 */
export class WeaponState {
  private ammo = new Map<WeaponId, number>();
  private activeId: WeaponId = "rifle";
  private cooldown = 0;
  private reloading = false;
  private reloadRemaining = 0;

  constructor() {
    for (const id of WEAPON_ORDER) this.ammo.set(id, WEAPONS[id].magazineSize);
  }

  get current(): WeaponDef {
    return WEAPONS[this.activeId];
  }

  get currentId(): WeaponId {
    return this.activeId;
  }

  get currentAmmo(): number {
    return this.ammo.get(this.activeId) ?? 0;
  }

  get isReloading(): boolean {
    return this.reloading;
  }

  get reloadProgress(): number {
    if (!this.reloading) return 1;
    return 1 - this.reloadRemaining / this.current.reloadTimeMs;
  }

  switchTo(id: WeaponId): void {
    if (id === this.activeId) return;
    this.activeId = id;
    this.reloading = false;
    this.reloadRemaining = 0;
    this.cooldown = 0;
  }

  cycleNext(): void {
    const idx = WEAPON_ORDER.indexOf(this.activeId);
    this.switchTo(WEAPON_ORDER[(idx + 1) % WEAPON_ORDER.length]);
  }

  update(dtMs: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dtMs);

    if (this.reloading) {
      this.reloadRemaining -= dtMs;
      if (this.reloadRemaining <= 0) {
        this.reloading = false;
        this.ammo.set(this.activeId, this.current.magazineSize);
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
      return { fired: false, pelletCount: 0 };
    }
    this.ammo.set(this.activeId, this.currentAmmo - 1);
    this.cooldown = fireIntervalMs(def);
    if (this.currentAmmo === 0) this.startReload();
    return { fired: true, pelletCount: def.pelletCount };
  }

  /** Client-only: snap the predicted state to the server's authoritative
   * numbers on every snapshot. Ammo/reload are pure display data (the
   * server is what actually gates whether a shot counts), so unlike
   * movement there's no replay — just resync and let the next few
   * predicted ticks build back on top of the corrected value. Any drift is
   * gone within one snapshot interval (50ms), imperceptible. */
  syncFromServer(id: WeaponId, ammo: number, reloading: boolean): void {
    this.activeId = id;
    this.ammo.set(id, ammo);
    if (reloading && !this.reloading) {
      this.reloading = true;
      this.reloadRemaining = this.current.reloadTimeMs;
    } else if (!reloading) {
      this.reloading = false;
      this.reloadRemaining = 0;
    }
  }
}
