import {
  colorForCosmetic,
  defaultImpostorConfig,
  DEFAULT_IMPOSTOR_MAP_ID,
  ImpostorPhase,
  ImpostorPlayerSummary,
  ImpostorRole,
  ImpostorRoomConfig,
  ImpostorServerMessage,
  IMPOSTOR_MAPS,
  IMPOSTOR_MAX_IMPOSTERS,
  IMPOSTOR_MAX_PLAYERS,
  IMPOSTOR_MIN_PLAYERS,
  MapDefinition,
  PlayerId,
  suggestImposterCount,
} from "@fps/shared";
import * as THREE from "three";
import { soundEngine } from "../audio/SoundEngine";
import { InputManager } from "../engine/InputManager";
import { ImpostorMatchController } from "../game/ImpostorMatchController";
import { ImpostorTaskHud } from "../game/ImpostorTaskHud";
import { profileStore } from "../state/profile";
import { NetClient } from "./NetClient";

const MATCH_END_MESSAGES: Record<"tasks_complete" | "imposters_ejected" | "imposters_win_by_numbers", string> = {
  tasks_complete: "Crewmates Win — All Tasks Complete!",
  imposters_ejected: "Crewmates Win — All Imposters Ejected!",
  imposters_win_by_numbers: "Imposters Win",
};

export type LoadMapFn = (mapId: string) => { map: MapDefinition; meshes: THREE.Mesh[] };

const WS_URL = resolveWsUrl();

function resolveWsUrl(): string {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  return `ws://${location.hostname}:8787/ws`;
}

function randomDefaultName(): string {
  return `Player${Math.floor(1000 + Math.random() * 9000)}`;
}

const IMPOSTOR_RECONNECT_SESSION_KEY = "fps-impostor-reconnect";

interface SavedSession {
  code: string;
  token: string;
}

function saveSession(code: string, token: string): void {
  try {
    sessionStorage.setItem(IMPOSTOR_RECONNECT_SESSION_KEY, JSON.stringify({ code, token }));
  } catch {
    // sessionStorage unavailable — non-fatal, reconnect just won't resume.
  }
}

function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(IMPOSTOR_RECONNECT_SESSION_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}

function clearSession(): void {
  try {
    sessionStorage.removeItem(IMPOSTOR_RECONNECT_SESSION_KEY);
  } catch {
    // ignore
  }
}

/**
 * Owns the Imposter mode's menu -> lobby -> countdown -> active flow.
 * Deliberately a separate class from MultiplayerFlow (Duel's) rather than a
 * generalized single flow — the lobby has host-only config controls and a
 * private role reveal that Duel's screens have no equivalent of, and this
 * keeps Duel's flow class completely untouched.
 */
export class ImpostorFlow {
  private net = new NetClient(WS_URL);
  private selfId: PlayerId | null = null;
  private roomCode: string | null = null;
  private playerNames = new Map<PlayerId, string>();
  private match: ImpostorMatchController | null = null;
  private unsubscribe: (() => void) | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  private screenMenu = el("screen-menu");
  private screenLobby = el("screen-impostor-lobby");
  private screenCountdown = el("screen-impostor-countdown");
  private nameInput = el<HTMLInputElement>("player-name");
  private joinCodeInput = el<HTMLInputElement>("join-impostor-code-input");
  private menuError = el("menu-error");
  private lobbyCode = el("imp-lobby-code");
  private shareLink = el<HTMLInputElement>("imp-share-link");
  private lobbyPlayers = el("imp-lobby-players");
  private readyBtn = el<HTMLButtonElement>("btn-imp-ready");
  private countdownNumber = el("imp-countdown-number");
  private lockOverlay = el("lock-overlay");
  private hostConfigPanel = el("imp-host-config");
  private configReadonly = el("imp-config-readonly");
  private minPlayersSelect = el<HTMLSelectElement>("imp-min-players");
  private maxPlayersSelect = el<HTMLSelectElement>("imp-max-players");
  private imposterCountSelect = el<HTMLSelectElement>("imp-imposter-count");
  private roleBanner = el("imp-role-banner");
  private roleText = el("imp-role-text");
  private fellowImpostersEl = el("imp-fellow-imposters");
  private matchResultBanner = el("imp-match-result-banner");
  private matchResultText = el("imp-match-result-text");
  private taskHud = new ImpostorTaskHud(() => this.net.send({ type: "imp_call_meeting" }));

  private screenMeeting = el("screen-impostor-meeting");
  private meetingTitle = el("imp-meeting-title");
  private meetingTimerEl = el("imp-meeting-timer");
  private meetingDiscussionEl = el("imp-meeting-discussion");
  private meetingVotingEl = el("imp-meeting-voting");
  private voteListEl = el("imp-vote-list");
  private meetingResultEl = el("imp-meeting-result");
  private meetingResultTextEl = el("imp-meeting-result-text");
  private ejectedOverlay = el("imp-ejected-overlay");

  private ready = false;
  private lobbyPhase: ImpostorPhase = "lobby";
  private inRoom = false;
  private isHost = false;
  /** Last hostId seen from the server, independent of whether selfId was
   * known yet when it arrived — see the comment in handleMessage's
   * imp_room_created/imp_room_joined cases for why this is needed. */
  private lastHostId: PlayerId | null = null;
  private config: ImpostorRoomConfig = defaultImpostorConfig();
  private roleBannerTimer: ReturnType<typeof setTimeout> | null = null;
  private meetingCountdownTimer: ReturnType<typeof setInterval> | null = null;
  /** Round-scoped: who's already been voted out this round, so a second
   * meeting's vote list excludes them. Cleared on every match start. */
  private ejectedIds = new Set<PlayerId>();

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private input: InputManager,
    private loadMap: LoadMapFn,
    private onMatchActiveChange: (active: ImpostorMatchController | null) => void
  ) {
    el<HTMLButtonElement>("btn-create-impostor-room").addEventListener("click", () => this.createRoom());
    el<HTMLButtonElement>("btn-join-impostor-room").addEventListener("click", () => this.joinRoom(this.joinCodeInput.value));
    el<HTMLButtonElement>("btn-imp-copy-link").addEventListener("click", () => this.copyShareLink());
    this.readyBtn.addEventListener("click", () => this.toggleReady());
    el<HTMLButtonElement>("btn-imp-leave-lobby").addEventListener("click", () => this.leaveRoom());

    this.buildConfigSelectors();
    this.minPlayersSelect.addEventListener("change", () => this.sendHostConfig());
    this.maxPlayersSelect.addEventListener("change", () => this.sendHostConfig());
    this.imposterCountSelect.addEventListener("change", () => this.sendHostConfig());

    this.net.onConnectionChange((connected) => {
      if (connected && this.inRoom) {
        const saved = loadSession();
        if (saved) this.net.send({ type: "rejoin_room", code: saved.code, token: saved.token });
      }
    });
  }

  showMenu(): void {
    this.hideAllScreens();
    this.screenMenu.classList.remove("hidden");
  }

  hideAllScreens(): void {
    this.screenMenu.classList.add("hidden");
    this.screenLobby.classList.add("hidden");
    this.screenCountdown.classList.add("hidden");
    this.screenMeeting.classList.add("hidden");
  }

  get activeMatch(): ImpostorMatchController | null {
    return this.match;
  }

  private buildConfigSelectors(): void {
    fillNumberSelect(this.minPlayersSelect, IMPOSTOR_MIN_PLAYERS, IMPOSTOR_MAX_PLAYERS);
    fillNumberSelect(this.maxPlayersSelect, IMPOSTOR_MIN_PLAYERS, IMPOSTOR_MAX_PLAYERS);
    fillNumberSelect(this.imposterCountSelect, 1, IMPOSTOR_MAX_IMPOSTERS);
  }

  private createRoom(): void {
    this.menuError.textContent = "";
    const name = this.nameInput.value.trim() || randomDefaultName();
    profileStore.setName(name);
    const color = colorForCosmetic(profileStore.get().cosmeticId);
    this.connectThen(() => this.net.send({ type: "imp_create_room", name, color }));
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
    this.connectThen(() => this.net.send({ type: "imp_join_room", code, name, color }));
  }

  private connectThen(action: () => void): void {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = this.net.onMessage((msg) => this.handleMessage(msg as ImpostorServerMessage));
    const unsubConn = this.net.onConnectionChange((connected) => {
      if (connected) {
        unsubConn();
        action();
      }
    });
    this.net.connect();
  }

  private handleMessage(msg: ImpostorServerMessage): void {
    switch (msg.type) {
      case "imp_room_created":
      case "imp_room_joined":
        this.selfId = msg.selfId;
        this.roomCode = msg.code;
        this.inRoom = true;
        saveSession(msg.code, msg.reconnectToken);
        // The room's very first imp_lobby_update (broadcast synchronously
        // inside addPlayer, server-side) reaches the client BEFORE this
        // confirmation does — so isHost couldn't be correctly evaluated
        // there yet (selfId was still null). Recompute it now that selfId
        // is finally known, using whatever hostId that early update carried.
        this.isHost = this.lastHostId === this.selfId;
        this.showLobby();
        this.renderConfig();
        break;
      case "rejoin_failed":
        clearSession();
        this.inRoom = false;
        this.menuError.textContent = msg.message;
        this.showMenu();
        break;
      case "imp_room_error":
        this.menuError.textContent = msg.message;
        break;
      case "imp_lobby_update":
        this.lobbyPhase = msg.phase;
        this.config = msg.config;
        this.lastHostId = msg.hostId;
        this.isHost = msg.hostId === this.selfId;
        this.playerNames.clear();
        for (const p of msg.players) this.playerNames.set(p.id, p.name);
        // The server force-reverts an active round to "lobby" with no
        // separate message (unlike Duel's explicit match_ended) when the
        // headcount drops below minPlayers mid-round — there's no result to
        // show, just not enough people left to continue. If we're still
        // showing the active match view when that happens, tear it down and
        // return to the lobby screen; this is the only path that transition
        // reaches the client through.
        if (msg.phase === "lobby" && this.match) {
          this.input.exitPointerLock();
          this.match.dispose();
          this.match = null;
          this.onMatchActiveChange(null);
          this.hideRoleBanner();
          this.hideMatchResultBanner();
          this.hideMeetingScreen();
          this.ejectedOverlay.classList.add("hidden");
          if (this.meetingCountdownTimer) {
            clearInterval(this.meetingCountdownTimer);
            this.meetingCountdownTimer = null;
          }
          this.showLobby();
        }
        this.renderLobby(msg.players);
        this.renderConfig();
        break;
      case "imp_match_countdown":
        this.showCountdown(msg.startsAtServerTime);
        break;
      case "imp_match_started":
        this.startMatch(msg.mapId);
        break;
      default:
        break;
    }
  }

  private showLobby(): void {
    this.hideAllScreens();
    this.screenLobby.classList.remove("hidden");
    this.lobbyCode.textContent = this.roomCode ?? "";
    this.shareLink.value = `${location.origin}${location.pathname}?imp=${this.roomCode}`;
    this.ready = false;
    this.readyBtn.textContent = "Ready";
  }

  private renderLobby(players: ImpostorPlayerSummary[]): void {
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
    if (players.length < this.config.minPlayers) {
      const row = document.createElement("div");
      row.className = "lobby-player-row";
      row.textContent = `Waiting for ${this.config.minPlayers - players.length} more player(s) (need ${this.config.minPlayers}-${this.config.maxPlayers})...`;
      this.lobbyPlayers.appendChild(row);
    }
  }

  private renderConfig(): void {
    if (this.isHost && this.lobbyPhase === "lobby") {
      this.hostConfigPanel.classList.remove("hidden");
      this.configReadonly.classList.add("hidden");
      this.minPlayersSelect.value = String(this.config.minPlayers);
      this.maxPlayersSelect.value = String(this.config.maxPlayers);
      this.imposterCountSelect.value = String(this.config.imposterCount);
    } else {
      this.hostConfigPanel.classList.add("hidden");
      this.configReadonly.classList.remove("hidden");
      this.configReadonly.textContent = `${this.config.minPlayers}-${this.config.maxPlayers} players, ${this.config.imposterCount} imposter(s)`;
    }
  }

  private sendHostConfig(): void {
    const minPlayers = Number(this.minPlayersSelect.value);
    let maxPlayers = Number(this.maxPlayersSelect.value);
    if (maxPlayers < minPlayers) maxPlayers = minPlayers;
    const imposterCount = Number(this.imposterCountSelect.value) || suggestImposterCount(minPlayers);
    this.net.send({ type: "imp_set_config", minPlayers, maxPlayers, imposterCount });
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
    this.lockOverlay.classList.remove("hidden");
    if (this.match) this.match.dispose();
    this.ejectedIds.clear();
    this.ejectedOverlay.classList.add("hidden");
    const resolvedMapId = IMPOSTOR_MAPS[mapId] ? mapId : DEFAULT_IMPOSTOR_MAP_ID;
    // meshes (Duel uses these for hitscan raycasting) are unused here — this
    // mode has no shooting yet, loadMap's side effect of building the scene
    // geometry is all that's needed.
    const { map } = this.loadMap(resolvedMapId);
    const spawn = map.spawns[0];
    this.match = new ImpostorMatchController(
      this.scene,
      this.camera,
      this.input,
      this.net,
      this.selfId as PlayerId,
      this.playerNames,
      this.taskHud,
      spawn,
      map.blocks,
      map.ladders,
      {
        onRoleAssigned: (role, fellowNames) => this.showRoleBanner(role, fellowNames),
        onMatchEnded: (reason) => this.showMatchResult(MATCH_END_MESSAGES[reason]),
        onMeetingStarted: (calledByName, discussionEndsAt) => this.showMeetingDiscussion(calledByName, discussionEndsAt),
        onMeetingVoting: (votingEndsAt) => this.showMeetingVoting(votingEndsAt),
        onMeetingResult: (ejectedId, ejectedName, ejectedRole, wasSelf, voteCounts, skipCount) =>
          this.showMeetingResult(ejectedId, ejectedName, ejectedRole, wasSelf, voteCounts, skipCount),
        onMeetingEnded: () => this.hideMeetingScreen(),
      }
    );
    this.onMatchActiveChange(this.match);
  }

  private showMatchResult(text: string): void {
    this.matchResultText.textContent = text;
    this.matchResultBanner.classList.remove("hidden");
  }

  private hideMatchResultBanner(): void {
    this.matchResultBanner.classList.add("hidden");
  }

  // --- Meetings ---

  private showMeetingDiscussion(calledByName: string, discussionEndsAt: number): void {
    this.input.exitPointerLock();
    this.hideAllScreens();
    this.screenMeeting.classList.remove("hidden");
    this.meetingTitle.textContent = `${calledByName} called an emergency meeting`;
    this.meetingDiscussionEl.classList.remove("hidden");
    this.meetingVotingEl.classList.add("hidden");
    this.meetingResultEl.classList.add("hidden");
    // No local onDone callback needed here -- the server drives the actual
    // discussion -> voting transition and sends imp_meeting_voting on its
    // own; this timer is purely the visible countdown.
    this.startMeetingCountdown(discussionEndsAt);
  }

  private showMeetingVoting(votingEndsAt: number): void {
    this.meetingTitle.textContent = "Vote to eject";
    this.meetingDiscussionEl.classList.add("hidden");
    this.meetingVotingEl.classList.remove("hidden");
    this.meetingResultEl.classList.add("hidden");
    this.renderVoteList();
    this.startMeetingCountdown(votingEndsAt);
  }

  private renderVoteList(): void {
    this.voteListEl.innerHTML = "";
    for (const [id, name] of this.playerNames) {
      if (this.ejectedIds.has(id)) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn-secondary imp-vote-option";
      btn.textContent = id === this.selfId ? `${name} (you)` : name;
      btn.addEventListener("click", () => this.castVote(id, btn));
      this.voteListEl.appendChild(btn);
    }
    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "btn-secondary imp-vote-option";
    skipBtn.textContent = "Skip Vote";
    skipBtn.addEventListener("click", () => this.castVote("skip", skipBtn));
    this.voteListEl.appendChild(skipBtn);
  }

  private castVote(target: PlayerId | "skip", clickedBtn: HTMLButtonElement): void {
    this.match?.castVote(target);
    for (const child of Array.from(this.voteListEl.children)) {
      child.classList.toggle("imp-vote-selected", child === clickedBtn);
    }
  }

  private showMeetingResult(
    ejectedId: PlayerId | null,
    ejectedName: string | null,
    ejectedRole: ImpostorRole | null,
    wasSelf: boolean,
    voteCounts: Record<string, number>,
    skipCount: number
  ): void {
    void voteCounts;
    if (ejectedId) this.ejectedIds.add(ejectedId);
    if (this.meetingCountdownTimer) {
      clearInterval(this.meetingCountdownTimer);
      this.meetingCountdownTimer = null;
    }
    this.meetingDiscussionEl.classList.add("hidden");
    this.meetingVotingEl.classList.add("hidden");
    this.meetingResultEl.classList.remove("hidden");
    this.meetingTitle.textContent = "Results";

    if (ejectedName) {
      const roleLabel = ejectedRole === "imposter" ? "was an Imposter" : "was not an Imposter";
      this.meetingResultTextEl.textContent = `${ejectedName} was ejected — ${roleLabel}.`;
    } else if (skipCount > 0) {
      this.meetingResultTextEl.textContent = "No one was ejected (skipped or tied).";
    } else {
      this.meetingResultTextEl.textContent = "No one was ejected.";
    }

    if (wasSelf) {
      this.ejectedOverlay.classList.remove("hidden");
    }
  }

  private hideMeetingScreen(): void {
    this.screenMeeting.classList.add("hidden");
  }

  /** Purely a visible countdown — the actual discussion -> voting -> result
   * transitions are server-driven (imp_meeting_voting / imp_meeting_result
   * arrive on their own), this never needs to trigger anything itself. */
  private startMeetingCountdown(endsAt: number): void {
    if (this.meetingCountdownTimer) clearInterval(this.meetingCountdownTimer);
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      this.meetingTimerEl.textContent = `${remaining}s`;
      if (remaining <= 0 && this.meetingCountdownTimer) {
        clearInterval(this.meetingCountdownTimer);
        this.meetingCountdownTimer = null;
      }
    };
    tick();
    this.meetingCountdownTimer = setInterval(tick, 250);
  }

  private showRoleBanner(role: ImpostorRole, fellowImposterNames: string[]): void {
    this.roleBanner.classList.remove("hidden");
    this.roleBanner.classList.toggle("imp-role-imposter", role === "imposter");
    this.roleText.textContent = role === "imposter" ? "You are an Imposter" : "You are a Crewmate";
    this.fellowImpostersEl.textContent =
      role === "imposter" && fellowImposterNames.length > 0 ? `With: ${fellowImposterNames.join(", ")}` : "";

    if (this.roleBannerTimer) clearTimeout(this.roleBannerTimer);
    this.roleBannerTimer = setTimeout(() => {
      this.roleBanner.classList.add("imp-role-banner-small");
    }, 4000);
  }

  private hideRoleBanner(): void {
    this.roleBanner.classList.add("hidden");
    this.roleBanner.classList.remove("imp-role-banner-small");
    if (this.roleBannerTimer) {
      clearTimeout(this.roleBannerTimer);
      this.roleBannerTimer = null;
    }
  }

  leaveRoom(): void {
    this.inRoom = false;
    clearSession();
    this.net.send({ type: "leave_room" });
    this.net.close();
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    if (this.match) {
      this.match.dispose();
      this.match = null;
      this.onMatchActiveChange(null);
    }
    this.hideRoleBanner();
    this.hideMatchResultBanner();
    this.hideMeetingScreen();
    this.ejectedOverlay.classList.add("hidden");
    this.ejectedIds.clear();
    if (this.meetingCountdownTimer) {
      clearInterval(this.meetingCountdownTimer);
      this.meetingCountdownTimer = null;
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

function fillNumberSelect(select: HTMLSelectElement, min: number, max: number): void {
  select.innerHTML = "";
  for (let i = min; i <= max; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = String(i);
    select.appendChild(opt);
  }
}

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in index.html`);
  return found as T;
}
