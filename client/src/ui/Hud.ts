const HITMARKER_DURATION_MS = 150;
const DAMAGE_FLASH_DURATION_MS = 350;
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

  private hitmarkerRemainingMs = 0;
  private damageFlashRemainingMs = 0;
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

  /** Called when leaving a match — score/timer are match-only HUD elements
   * and shouldn't linger with stale content in practice mode or the menu. */
  hideMatchInfo(): void {
    this.scoreEl.style.display = "none";
    this.timerEl.style.display = "none";
    this.pingEl.style.display = "none";
    this.setDead(false, 0);
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
    if (this.reconnectDeadlineMs > 0) {
      const secs = Math.max(0, Math.ceil((this.reconnectDeadlineMs - Date.now()) / 1000));
      this.reconnectTextEl.textContent = `${this.reconnectBaseMessage} (${secs}s)`;
    }
  }
}
