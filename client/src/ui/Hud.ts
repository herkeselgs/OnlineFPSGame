const HITMARKER_DURATION_MS = 150;
const FEED_ITEM_LIFETIME_MS = 3500;

export class Hud {
  private weaponNameEl = document.getElementById("hud-weapon") as HTMLDivElement;
  private ammoEl = document.getElementById("hud-ammo") as HTMLDivElement;
  private reloadEl = document.getElementById("hud-reload") as HTMLDivElement;
  private hitmarkerEl = document.getElementById("hitmarker") as HTMLDivElement;
  private feedEl = document.getElementById("kill-feed") as HTMLDivElement;

  private hitmarkerRemainingMs = 0;

  updateWeapon(name: string, ammo: number, magSize: number, reloading: boolean): void {
    this.weaponNameEl.textContent = name;
    this.ammoEl.textContent = `${ammo} / ${magSize}`;
    this.reloadEl.style.display = reloading ? "block" : "none";
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
