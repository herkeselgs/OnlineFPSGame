const HITMARKER_DURATION_MS = 150;
const DAMAGE_FLASH_DURATION_MS = 350;
const DAMAGE_DIR_DURATION_MS = 900;
const FEED_ITEM_LIFETIME_MS = 3500;

export class Hud {
  private weaponNameEl = document.getElementById("hud-weapon") as HTMLDivElement;
  private ammoEl = document.getElementById("hud-ammo") as HTMLDivElement;
  private reloadEl = document.getElementById("hud-reload") as HTMLDivElement;
  private hitmarkerEl = document.getElementById("hitmarker") as HTMLDivElement;
  private feedEl = document.getElementById("kill-feed") as HTMLDivElement;
  private healthEl = document.getElementById("hud-health") as HTMLDivElement;
  private deathOverlayEl = document.getElementById("death-overlay") as HTMLDivElement;
  private scoreEl = document.getElementById("hud-score") as HTMLDivElement;
  private timerEl = document.getElementById("hud-timer") as HTMLDivElement;
  private damageFlashEl = document.getElementById("damage-flash") as HTMLDivElement;
  private reconnectOverlayEl = document.getElementById("reconnect-overlay") as HTMLDivElement;
  private reconnectTextEl = document.getElementById("reconnect-text") as HTMLDivElement;
  private pingEl = document.getElementById("hud-ping") as HTMLDivElement;
  private damageDirEl = document.getElementById("damage-direction") as HTMLDivElement;
  private spawnShieldEl = document.getElementById("hud-spawn-shield") as HTMLDivElement;
  private spawnShieldTextEl = document.getElementById("hud-spawn-shield-text") as HTMLSpanElement;
  private crosshairEl = document.getElementById("crosshair") as HTMLDivElement;
  private healthWrapEl = document.getElementById("hud-health-wrap") as HTMLDivElement;
  private weaponHudEl = document.getElementById("weapon-hud") as HTMLDivElement;
  private staminaWrapEl = document.getElementById("hud-stamina-wrap") as HTMLDivElement;
  private staminaFillEl = document.getElementById("hud-stamina-fill") as HTMLDivElement;

  private hitmarkerRemainingMs = 0;
  private damageFlashRemainingMs = 0;
  private damageDirRemainingMs = 0;
  private reconnectBaseMessage = "";
  private reconnectDeadlineMs = 0;

  updateWeapon(name: string, ammo: number, magSize: number, reloading: boolean): void {
    this.weaponNameEl.textContent = name;
    this.ammoEl.textContent = `${ammo} / ${magSize}`;
    this.reloadEl.style.display = reloading ? "block" : "none";
  }

  updateHealth(health: number): void {
    this.healthEl.textContent = String(Math.max(0, Math.round(health)));
  }

  /** `stamina`/`max` in the same units as PlayerPhysicsState.stamina;
   * `low` toggles the warning color — pass true at/below
   * STAMINA_LOW_THRESHOLD, the same point sprint speed starts tapering off,
   * so the color explains the speed change. */
  updateStamina(stamina: number, max: number, low: boolean): void {
    const pct = Math.max(0, Math.min(1, stamina / max));
    this.staminaFillEl.style.width = `${pct * 100}%`;
    this.staminaFillEl.classList.toggle("stamina-low", low);
  }

  setDead(dead: boolean, respawnInMs: number): void {
    if (!dead) {
      this.deathOverlayEl.style.display = "none";
      return;
    }
    this.deathOverlayEl.style.display = "flex";
    const secs = Math.max(0, Math.ceil(respawnInMs / 1000));
    this.deathOverlayEl.textContent = secs > 0 ? `Respawning in ${secs}...` : "Respawning...";
  }

  updateScore(selfName: string, selfScore: number, oppName: string, oppScore: number): void {
    this.scoreEl.style.display = "block";
    this.scoreEl.textContent = `${selfName} ${selfScore} — ${oppScore} ${oppName}`;
  }

  /** School wifi is exactly the kind of connection that degrades before it
   * drops outright — surfacing ping (not just reacting to a hard
   * disconnect via the reconnect overlay) gives a player a chance to
   * notice "this is about to get bad" instead of being blindsided. */
  updatePing(rttMs: number): void {
    this.pingEl.style.display = "block";
    const ms = Math.round(rttMs);
    this.pingEl.textContent = `${ms}ms`;
    const quality = ms < 70 ? "good" : ms < 150 ? "ok" : "poor";
    this.pingEl.classList.remove("ping-good", "ping-ok", "ping-poor");
    this.pingEl.classList.add(`ping-${quality}`);
  }

  /** Called every frame with however long spawn protection has left (<=0
   * once it's expired or not applicable) — players otherwise have no way
   * to know they're currently invincible, or exactly when that stops. */
  updateSpawnProtection(remainingMs: number): void {
    if (remainingMs <= 0) {
      this.spawnShieldEl.style.display = "none";
      return;
    }
    this.spawnShieldEl.style.display = "flex";
    this.spawnShieldTextEl.textContent = `${(remainingMs / 1000).toFixed(1)}s`;
  }

  updateTimer(remainingMs: number): void {
    this.timerEl.style.display = "block";
    const total = Math.max(0, Math.ceil(remainingMs / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    this.timerEl.textContent = `${m}:${s.toString().padStart(2, "0")}`;
  }

  flashHitmarker(killed: boolean, headshot = false): void {
    this.hitmarkerRemainingMs = HITMARKER_DURATION_MS;
    this.hitmarkerEl.classList.toggle("hitmarker-kill", killed);
    this.hitmarkerEl.classList.toggle("hitmarker-headshot", headshot);
    this.hitmarkerEl.style.opacity = "1";
  }

  flashDamage(): void {
    this.damageFlashRemainingMs = DAMAGE_FLASH_DURATION_MS;
    this.damageFlashEl.style.opacity = "1";
  }

  /** `relativeAngleRad`: 0 = attacker directly ahead, positive = to the
   * right — rotates a chevron around the crosshair to point at them. */
  showDamageDirection(relativeAngleRad: number): void {
    this.damageDirRemainingMs = DAMAGE_DIR_DURATION_MS;
    const deg = (relativeAngleRad * 180) / Math.PI;
    this.damageDirEl.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
    this.damageDirEl.style.opacity = "1";
  }

  /** Called when leaving a Duel/Bot match — every element here is
   * CSS-visible by default from page load (only ever masked by whichever
   * full-screen `.screen` currently covers the viewport), so without an
   * explicit hide, stale match HUD content (crosshair, health, ammo) would
   * show through over the menu screens. showWeaponHud() is the matching
   * call each mode's start makes to bring them back. */
  hideMatchInfo(): void {
    this.scoreEl.style.display = "none";
    this.timerEl.style.display = "none";
    this.pingEl.style.display = "none";
    this.spawnShieldEl.style.display = "none";
    this.crosshairEl.style.display = "none";
    this.healthWrapEl.style.display = "none";
    this.weaponHudEl.style.display = "none";
    this.staminaWrapEl.style.display = "none";
    this.damageDirRemainingMs = 0;
    this.damageDirEl.style.opacity = "0";
    this.setDead(false, 0);
  }

  /** Restores the crosshair/health/weapon HUD — see hideMatchInfo's
   * comment. Called at the start of a Duel match or practice session. */
  showWeaponHud(): void {
    this.crosshairEl.style.display = "block";
    this.healthWrapEl.style.display = "flex";
    this.weaponHudEl.style.display = "block";
    this.staminaWrapEl.style.display = "block";
  }

  /** Shown both when the local connection drops and when the opponent's
   * does — same overlay, different message. `graceMs` > 0 shows a live
   * countdown to the reconnect deadline; 0 just shows the static message
   * (used for "reconnecting..." on the dropped player's own screen, where
   * there's no fixed deadline the way there is for the player waiting). */
  showReconnectOverlay(message: string, graceMs: number): void {
    this.reconnectOverlayEl.style.display = "flex";
    this.reconnectBaseMessage = message;
    this.reconnectDeadlineMs = graceMs > 0 ? Date.now() + graceMs : 0;
    this.reconnectTextEl.textContent = message;
  }

  hideReconnectOverlay(): void {
    this.reconnectOverlayEl.style.display = "none";
    this.reconnectDeadlineMs = 0;
  }

  pushFeed(message: string): void {
    const line = document.createElement("div");
    line.className = "feed-line";
    line.textContent = message;
    this.feedEl.appendChild(line);
    setTimeout(() => line.remove(), FEED_ITEM_LIFETIME_MS);
  }

  update(dtMs: number): void {
    if (this.hitmarkerRemainingMs > 0) {
      this.hitmarkerRemainingMs -= dtMs;
      this.hitmarkerEl.style.opacity = String(Math.max(0, this.hitmarkerRemainingMs / HITMARKER_DURATION_MS));
    }
    if (this.damageFlashRemainingMs > 0) {
      this.damageFlashRemainingMs -= dtMs;
      this.damageFlashEl.style.opacity = String(Math.max(0, this.damageFlashRemainingMs / DAMAGE_FLASH_DURATION_MS));
    }
    if (this.damageDirRemainingMs > 0) {
      this.damageDirRemainingMs -= dtMs;
      this.damageDirEl.style.opacity = String(Math.max(0, this.damageDirRemainingMs / DAMAGE_DIR_DURATION_MS));
    }
    if (this.reconnectDeadlineMs > 0) {
      const secs = Math.max(0, Math.ceil((this.reconnectDeadlineMs - Date.now()) / 1000));
      this.reconnectTextEl.textContent = `${this.reconnectBaseMessage} (${secs}s)`;
    }
  }
}
