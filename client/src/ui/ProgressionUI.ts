import { COSMETICS } from "@fps/shared";
import { profileStore } from "../state/profile";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in index.html`);
  return found as T;
}

/** Owns the menu screen's level badge/XP bar, cosmetic color picker, and the
 * stats/match-history screen. Kept separate from MultiplayerFlow since none
 * of this touches the network — it's purely local profile data. */
export class ProgressionUI {
  private levelBadgeText = el("level-badge-text");
  private xpBarFill = el("xp-bar-fill");
  private cosmeticSelect = el("cosmetic-select");
  private cosmeticName = el("cosmetic-name");
  private statsSummary = el("stats-summary");
  private statsHistory = el("stats-history");
  private screenStats = el("screen-stats");
  private mobileNotice = el("mobile-notice");

  constructor(private showMenu: () => void, private hideAllScreens: () => void) {
    el<HTMLButtonElement>("btn-open-stats").addEventListener("click", () => this.openStats());
    el<HTMLButtonElement>("btn-stats-back").addEventListener("click", () => this.showMenu());

    this.renderLevelBadge();
    this.renderCosmeticSelector();
    this.detectMobile();

    profileStore.subscribe(() => {
      this.renderLevelBadge();
      this.renderCosmeticSelector();
    });
  }

  private renderLevelBadge(): void {
    const { level, intoLevel, forNextLevel } = profileStore.levelInfo;
    this.levelBadgeText.textContent = `Level ${level}`;
    const pct = forNextLevel > 0 ? Math.min(100, (intoLevel / forNextLevel) * 100) : 100;
    this.xpBarFill.style.width = `${pct}%`;
  }

  private renderCosmeticSelector(): void {
    const unlocked = new Set(profileStore.unlockedCosmeticIds);
    const selectedId = profileStore.get().cosmeticId;
    this.cosmeticSelect.innerHTML = "";

    for (const cosmetic of COSMETICS) {
      const isUnlocked = unlocked.has(cosmetic.id);
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "cosmetic-swatch" + (cosmetic.id === selectedId ? " cosmetic-swatch-selected" : "");
      swatch.style.background = `#${cosmetic.color.toString(16).padStart(6, "0")}`;
      swatch.title = isUnlocked ? cosmetic.name : `${cosmetic.name} — unlocks at level ${cosmetic.unlockLevel}`;

      if (!isUnlocked) {
        swatch.classList.add("cosmetic-swatch-locked");
        swatch.textContent = String(cosmetic.unlockLevel);
      } else {
        swatch.addEventListener("click", () => profileStore.setCosmetic(cosmetic.id));
      }
      this.cosmeticSelect.appendChild(swatch);
    }

    const current = COSMETICS.find((c) => c.id === selectedId);
    this.cosmeticName.textContent = current?.name ?? "";
  }

  private openStats(): void {
    this.hideAllScreens();
    this.screenStats.classList.remove("hidden");
    this.renderStats();
  }

  private renderStats(): void {
    const p = profileStore.get();
    const kd = p.totalDeaths > 0 ? (p.totalKills / p.totalDeaths).toFixed(2) : p.totalKills.toFixed(2);
    const winRate = p.totalMatches > 0 ? Math.round((p.totalWins / p.totalMatches) * 100) : 0;

    this.statsSummary.innerHTML = "";
    const tiles: [string, string][] = [
      [String(p.totalMatches), "Matches"],
      [`${winRate}%`, "Win Rate"],
      [kd, "K/D"],
      [String(p.totalKills), "Kills"],
    ];
    for (const [value, label] of tiles) {
      const tile = document.createElement("div");
      tile.className = "stat-tile";
      tile.innerHTML = `<div class="stat-tile-value">${value}</div><div class="stat-tile-label">${label}</div>`;
      this.statsSummary.appendChild(tile);
    }

    this.statsHistory.innerHTML = "";
    if (p.history.length === 0) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No matches played yet — jump into one!";
      this.statsHistory.appendChild(empty);
      return;
    }

    for (const m of p.history) {
      const row = document.createElement("div");
      row.className = "history-row";
      const accuracy = m.shotsFired > 0 ? Math.round((m.shotsHit / m.shotsFired) * 100) : 0;
      const date = new Date(m.dateMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      row.innerHTML = `
        <span class="history-result history-result-${m.result}">${m.result}</span>
        <span>vs ${escapeHtml(m.opponentName)} · ${m.mapName}</span>
        <span>${m.kills}K/${m.deaths}D · ${accuracy}% · ${date}</span>
      `;
      this.statsHistory.appendChild(row);
    }
  }

  private detectMobile(): void {
    const isTouchPrimary = window.matchMedia("(pointer: coarse)").matches;
    const isNarrow = window.innerWidth < 700;
    if (isTouchPrimary || isNarrow) {
      this.mobileNotice.classList.remove("hidden");
    }
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}
