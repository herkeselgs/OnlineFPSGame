import { colorForCosmetic, MAP_ORDER, MAPS, MapDefinition, MatchScoreEntry, PlayerId, ServerMessage } from "@fps/shared";
import * as THREE from "three";
import { soundEngine } from "../audio/SoundEngine";
import { MatchController } from "../game/MatchController";
import { InputManager } from "../engine/InputManager";
import { MatchRecord, profileStore } from "../state/profile";
import { Hud } from "../ui/Hud";
import { NetClient } from "./NetClient";

export type LoadMapFn = (mapId: string) => { map: MapDefinition; meshes: THREE.Mesh[] };

const WS_URL = resolveWsUrl();

/** In dev, falls back to a local server on :8787. In production this must be
 * set via VITE_WS_URL (baked in at build time) — a same-origin guess would be
 * wrong anyway since the client and server deploy to different hosts. */
function resolveWsUrl(): string {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  if (location.protocol === "https:") {
    console.warn(
      "[fps] VITE_WS_URL was not set at build time and this page is served over HTTPS — " +
        "falling back to an insecure ws:// URL, which browsers will block. " +
        "Set VITE_WS_URL to your server's wss://.../ws URL and redeploy."
    );
  }
  return `ws://${location.hostname}:8787/ws`;
}

function randomDefaultName(): string {
  return `Player${Math.floor(1000 + Math.random() * 9000)}`;
}

/**
 * Owns the menu -> lobby -> countdown -> match -> results flow: connecting,
 * creating/joining rooms by code, ready-up, and instantiating/tearing down
 * MatchController when a match starts/ends. Talks to the DOM directly for
 * this milestone's screens (functional, not the final visual pass).
 */
export class MultiplayerFlow {
  private net = new NetClient(WS_URL);
  private selfId: PlayerId | null = null;
  private roomCode: string | null = null;
  private playerNames = new Map<PlayerId, string>();
  private match: MatchController | null = null;
  private unsubscribe: (() => void) | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  // DOM
  private screenMenu = el("screen-menu");
  private screenLobby = el("screen-lobby");
  private screenCountdown = el("screen-countdown");
  private screenResults = el("screen-results");
  private nameInput = el<HTMLInputElement>("player-name");
  private joinCodeInput = el<HTMLInputElement>("join-code-input");
  private menuError = el("menu-error");
  private lobbyCode = el("lobby-code");
  private shareLink = el<HTMLInputElement>("share-link");
  private lobbyPlayers = el("lobby-players");
  private readyBtn = el<HTMLButtonElement>("btn-ready");
  private countdownNumber = el("countdown-number");
  private resultsTitle = el("results-title");
  private resultsScores = el("results-scores");
  private lockOverlay = el("lock-overlay");
  private mapSelector = el("lobby-map-select");

  private ready = false;
  private lobbyPhase: "lobby" | "countdown" | "active" | "ended" = "lobby";
  private currentMapId = MAP_ORDER[0];

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private input: InputManager,
    private hud: Hud,
    private loadMap: LoadMapFn,
    private onMatchActiveChange: (active: MatchController | null) => void
  ) {
    el<HTMLButtonElement>("btn-create-room").addEventListener("click", () => this.createRoom());
    el<HTMLButtonElement>("btn-join-room").addEventListener("click", () => this.joinRoom(this.joinCodeInput.value));
    el<HTMLButtonElement>("btn-copy-link").addEventListener("click", () => this.copyShareLink());
    this.readyBtn.addEventListener("click", () => this.toggleReady());
    el<HTMLButtonElement>("btn-leave-lobby").addEventListener("click", () => this.leaveRoom());
    el<HTMLButtonElement>("btn-rematch").addEventListener("click", () => this.rematch());
    el<HTMLButtonElement>("btn-results-menu").addEventListener("click", () => this.leaveRoom());
    // btn-leave-match is owned by main.ts (it needs to branch on practice vs.
    // match mode, which this class doesn't know about) — it calls
    // leaveRoom() directly when appropriate instead of listening here.

    this.buildMapSelector();

    if (profileStore.get().name) this.nameInput.value = profileStore.get().name;

    const urlRoom = new URLSearchParams(location.search).get("room");
    if (urlRoom) {
      this.joinCodeInput.value = urlRoom.toUpperCase();
      if (!this.nameInput.value) this.nameInput.value = randomDefaultName();
      this.joinRoom(urlRoom);
    }
  }

  showMenu(): void {
    this.hideAllScreens();
    this.screenMenu.classList.remove("hidden");
  }

  private buildMapSelector(): void {
    this.mapSelector.innerHTML = "";
    for (const mapId of MAP_ORDER) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "map-option";
      btn.textContent = MAPS[mapId].name;
      btn.dataset.mapId = mapId;
      btn.addEventListener("click", () => this.net.send({ type: "set_map", mapId }));
      this.mapSelector.appendChild(btn);
    }
    this.highlightSelectedMap();
  }

  private highlightSelectedMap(): void {
    for (const child of Array.from(this.mapSelector.children)) {
      child.classList.toggle("map-option-selected", (child as HTMLElement).dataset.mapId === this.currentMapId);
    }
  }

  get activeMatch(): MatchController | null {
    return this.match;
  }

  hideAllScreens(): void {
    this.screenMenu.classList.add("hidden");
    this.screenLobby.classList.add("hidden");
    this.screenCountdown.classList.add("hidden");
    this.screenResults.classList.add("hidden");
  }

  private createRoom(): void {
    this.menuError.textContent = "";
    const name = this.nameInput.value.trim() || randomDefaultName();
    profileStore.setName(name);
    const color = colorForCosmetic(profileStore.get().cosmeticId);
    this.connectThen(() => this.net.send({ type: "create_room", name, color }));
  }

  private joinRoom(rawCode: string): void {
    const code = rawCode.trim().toUpperCase();
    if (code.length === 0) {
      this.menuError.textContent = "Enter a room code";
      return;
    }
    this.menuError.textContent = "";
    const name = this.nameInput.value.trim() || randomDefaultName();
    profileStore.setName(name);
    const color = colorForCosmetic(profileStore.get().cosmeticId);
    this.connectThen(() => this.net.send({ type: "join_room", code, name, color }));
  }

  private connectThen(action: () => void): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = this.net.onMessage((msg) => this.handleMessage(msg));
    const unsubConn = this.net.onConnectionChange((connected) => {
      if (connected) {
        unsubConn();
        action();
      }
    });
    this.net.connect();
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "room_created":
        this.selfId = msg.selfId;
        this.roomCode = msg.code;
        this.showLobby();
        break;
      case "room_joined":
        this.selfId = msg.selfId;
        this.roomCode = msg.code;
        this.showLobby();
        break;
      case "room_error":
        this.menuError.textContent = msg.message;
        break;
      case "lobby_update":
        this.lobbyPhase = msg.phase;
        this.currentMapId = msg.mapId;
        this.playerNames.clear();
        for (const p of msg.players) this.playerNames.set(p.id, p.name);
        this.renderLobby(msg.players);
        this.highlightSelectedMap();
        break;
      case "match_countdown":
        this.showCountdown(msg.startsAtServerTime);
        break;
      case "match_started":
        this.startMatch(msg.mapId);
        break;
      case "match_ended":
        this.showResults(msg.scores, msg.winnerId);
        break;
      default:
        break;
    }
  }

  private showLobby(): void {
    this.hideAllScreens();
    this.screenLobby.classList.remove("hidden");
    this.lobbyCode.textContent = this.roomCode ?? "";
    this.shareLink.value = `${location.origin}${location.pathname}?room=${this.roomCode}`;
    this.ready = false;
    this.readyBtn.textContent = "Ready";
  }

  private renderLobby(players: { id: PlayerId; name: string; color: number; ready: boolean }[]): void {
    this.lobbyPlayers.innerHTML = "";
    for (const p of players) {
      const row = document.createElement("div");
      row.className = "lobby-player-row";

      const identity = document.createElement("div");
      identity.className = "lobby-player-identity";
      const avatar = document.createElement("div");
      avatar.className = "lobby-avatar";
      avatar.style.background = `#${p.color.toString(16).padStart(6, "0")}`;
      avatar.textContent = (p.name[0] ?? "?").toUpperCase();
      const label = document.createElement("span");
      label.textContent = p.id === this.selfId ? `${p.name} (you)` : p.name;
      identity.append(avatar, label);

      const status = document.createElement("span");
      status.textContent = p.ready ? "READY" : "waiting...";
      status.className = p.ready ? "status-ready" : "status-waiting";
      row.append(identity, status);
      this.lobbyPlayers.appendChild(row);
    }
    if (players.length < 2) {
      const row = document.createElement("div");
      row.className = "lobby-player-row";
      row.textContent = "Waiting for opponent to join...";
      this.lobbyPlayers.appendChild(row);
    }
  }

  private toggleReady(): void {
    this.ready = !this.ready;
    this.readyBtn.textContent = this.ready ? "Not Ready" : "Ready";
    this.net.send({ type: "set_ready", ready: this.ready });
  }

  private showCountdown(startsAtServerTime: number): void {
    this.hideAllScreens();
    this.screenCountdown.classList.remove("hidden");
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    let lastDisplayed: string | null = null;
    const tick = () => {
      const remaining = Math.ceil((startsAtServerTime - Date.now()) / 1000);
      const display = remaining > 0 ? String(remaining) : "GO";
      if (display !== lastDisplayed) {
        lastDisplayed = display;
        this.countdownNumber.textContent = display;
        soundEngine.playCountdownBeep(display === "GO");
      }
      if (remaining <= 0 && this.countdownTimer) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
      }
    };
    tick();
    this.countdownTimer = setInterval(tick, 100);
  }

  private startMatch(mapId: string): void {
    this.hideAllScreens();
    this.lockOverlay.classList.add("hidden");
    if (this.match) this.match.dispose();
    const { map, meshes } = this.loadMap(mapId);
    const spawn = map.spawns[0];
    this.match = new MatchController(
      this.scene,
      this.camera,
      this.input,
      this.net,
      this.hud,
      this.selfId as PlayerId,
      this.playerNames,
      meshes,
      spawn,
      map.blocks,
      map.ladders
    );
    this.onMatchActiveChange(this.match);
    soundEngine.startAmbient();
  }

  private showResults(scores: MatchScoreEntry[], winnerId: PlayerId | null): void {
    soundEngine.stopAmbient();
    if (this.match) {
      this.match.dispose();
      this.match = null;
      this.onMatchActiveChange(null);
    }
    this.hideAllScreens();
    this.screenResults.classList.remove("hidden");
    const won = winnerId === this.selfId;
    this.resultsTitle.textContent = won ? "Victory!" : winnerId ? "Defeat" : "Match Over";

    this.resultsScores.innerHTML = "";
    for (const s of [...scores].sort((a, b) => b.kills - a.kills)) {
      const row = document.createElement("div");
      row.className = "results-score-row" + (s.id === winnerId ? " is-winner" : "");
      const label = s.id === this.selfId ? `${s.name} (you)` : s.name;
      const accuracy = s.shotsFired > 0 ? Math.round((s.shotsHit / s.shotsFired) * 100) : 0;
      row.innerHTML = `<span>${label}</span><span>${s.kills} K / ${s.deaths} D &middot; ${accuracy}% acc &middot; ${s.damageDealt} dmg</span>`;
      this.resultsScores.appendChild(row);
    }

    const self = scores.find((s) => s.id === this.selfId);
    if (self) {
      const opponent = scores.find((s) => s.id !== this.selfId);
      const record: MatchRecord = {
        dateMs: Date.now(),
        mapName: MAPS[this.currentMapId]?.name ?? this.currentMapId,
        result: winnerId === null ? "draw" : won ? "win" : "loss",
        kills: self.kills,
        deaths: self.deaths,
        shotsFired: self.shotsFired,
        shotsHit: self.shotsHit,
        damageDealt: self.damageDealt,
        opponentName: opponent?.name ?? "Opponent",
      };
      const { xpAwarded, newLevel, leveledUp } = profileStore.recordMatch(record);
      const xpLine = document.createElement("div");
      xpLine.className = "results-xp-line";
      xpLine.textContent = leveledUp ? `+${xpAwarded} XP — Level up! Now level ${newLevel}` : `+${xpAwarded} XP`;
      this.resultsScores.appendChild(xpLine);
    }
  }

  private rematch(): void {
    this.showLobby();
    this.ready = true;
    this.readyBtn.textContent = "Not Ready";
    this.net.send({ type: "set_ready", ready: true });
  }

  /** Leaves the current room/match (if any) and returns to the menu.
   * Called both from this class's own lobby/results buttons and directly
   * by main.ts's leave-match button. */
  leaveRoom(): void {
    soundEngine.stopAmbient();
    this.net.send({ type: "leave_room" });
    this.net.close();
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    if (this.match) {
      this.match.dispose();
      this.match = null;
      this.onMatchActiveChange(null);
    }
    this.selfId = null;
    this.roomCode = null;
    this.playerNames.clear();
    this.showMenu();
  }

  private copyShareLink(): void {
    this.shareLink.select();
    navigator.clipboard?.writeText(this.shareLink.value).catch(() => {
      document.execCommand("copy");
    });
  }
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in index.html`);
  return found as T;
}
