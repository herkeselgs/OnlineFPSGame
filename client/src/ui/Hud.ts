const HITMARKER_DURATION_MS = 150;
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

  private hitmarkerRemainingMs = 0;

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
    this.scoreEl.textContent = `${selfName} ${selfScore} — ${oppScore} ${oppName}`;
  }

  updateTimer(remainingMs: number): void {
    const total = Math.max(0, Math.ceil(remainingMs / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    this.timerEl.textContent = `${m}:${s.toString().padStart(2, "0")}`;
  }

  flashHitmarker(killed: boolean): void {
    this.hitmarkerRemainingMs = HITMARKER_DURATION_MS;
    this.hitmarkerEl.classList.toggle("hitmarker-kill", killed);
    this.hitmarkerEl.style.opacity = "1";
  }

  pushFeed(message: string): void {
    const line = document.createElement("div");
    line.className = "feed-line";
    line.textContent = message;
    this.feedEl.appendChild(line);
    setTimeout(() => line.remove(), FEED_ITEM_LIFETIME_MS);
  }

  update(dtMs: number): void {
    if (this.hitmarkerRemainingMs <= 0) return;
    this.hitmarkerRemainingMs -= dtMs;
    this.hitmarkerEl.style.opacity = String(Math.max(0, this.hitmarkerRemainingMs / HITMARKER_DURATION_MS));
  }
}
