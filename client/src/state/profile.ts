import { DEFAULT_COSMETIC_ID, unlockedCosmetics, xpForMatch, xpProgress } from "@fps/shared";

export interface MatchRecord {
  dateMs: number;
  mapName: string;
  result: "win" | "loss" | "draw";
  kills: number;
  deaths: number;
  shotsFired: number;
  shotsHit: number;
  damageDealt: number;
  opponentName: string;
}

export interface RivalryRecord {
  /** Preserves whatever casing/spelling the opponent last used, even though
   * matches are looked up by a normalized key — see normalizeOpponentKey. */
  displayName: string;
  wins: number;
  losses: number;
  draws: number;
}

export interface Profile {
  name: string;
  xp: number;
  cosmeticId: string;
  totalKills: number;
  totalDeaths: number;
  totalWins: number;
  totalMatches: number;
  history: MatchRecord[];
  /** Keyed by normalizeOpponentKey(opponentName) — a running record against
   * each person this profile has actually played, for two friends who
   * replay each other repeatedly and want to know who's really winning. */
  rivalries: Record<string, RivalryRecord>;
}

const DEFAULT_PROFILE: Profile = {
  name: "",
  xp: 0,
  cosmeticId: DEFAULT_COSMETIC_ID,
  totalKills: 0,
  totalDeaths: 0,
  totalWins: 0,
  totalMatches: 0,
  history: [],
  rivalries: {},
};

/** Names are freeform text, not accounts — this is the best available
 * "same person" signal without the backend work that's explicitly out of
 * scope for this pass. Trim/lowercase so "Bob", "bob ", "BOB" all count as
 * the same rivalry instead of splitting into three trivial ones. */
function normalizeOpponentKey(name: string): string {
  return name.trim().toLowerCase();
}

const STORAGE_KEY = "fps-profile";
const MAX_HISTORY = 20;

function load(): Profile {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PROFILE, ...parsed };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function save(profile: Profile): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // localStorage unavailable — non-fatal, progression just won't persist.
  }
}

type Listener = (profile: Profile) => void;

/** Same lightweight observable-store pattern as SettingsStore. Everything
 * here is local-only (no account, no server round trip) — "lightweight
 * backend" per the spec, structured so swapping in a real backend later is
 * a matter of replacing this class's internals, not the call sites. */
export class ProfileStore {
  private profile: Profile;
  private listeners = new Set<Listener>();

  constructor() {
    this.profile = load();
  }

  get(): Profile {
    return this.profile;
  }

  get levelInfo() {
    return xpProgress(this.profile.xp);
  }

  get unlockedCosmeticIds(): string[] {
    return unlockedCosmetics(this.levelInfo.level).map((c) => c.id);
  }

  setName(name: string): void {
    this.update({ name });
  }

  setCosmetic(id: string): void {
    if (!this.unlockedCosmeticIds.includes(id)) return;
    this.update({ cosmeticId: id });
  }

  /** Records a completed match, awards XP, and returns {xpAwarded,
   * leveledUpTo} so the results screen can show "+80 XP" / a level-up
   * banner. */
  recordMatch(record: MatchRecord): { xpAwarded: number; newLevel: number; leveledUp: boolean } {
    const beforeLevel = this.levelInfo.level;
    const xpAwarded = xpForMatch(record.kills, record.result === "win");

    const history = [record, ...this.profile.history].slice(0, MAX_HISTORY);

    const key = normalizeOpponentKey(record.opponentName);
    const prevRivalry = this.profile.rivalries[key];
    const rivalry: RivalryRecord = {
      displayName: record.opponentName,
      wins: (prevRivalry?.wins ?? 0) + (record.result === "win" ? 1 : 0),
      losses: (prevRivalry?.losses ?? 0) + (record.result === "loss" ? 1 : 0),
      draws: (prevRivalry?.draws ?? 0) + (record.result === "draw" ? 1 : 0),
    };

    this.update({
      xp: this.profile.xp + xpAwarded,
      totalKills: this.profile.totalKills + record.kills,
      totalDeaths: this.profile.totalDeaths + record.deaths,
      totalWins: this.profile.totalWins + (record.result === "win" ? 1 : 0),
      totalMatches: this.profile.totalMatches + 1,
      history,
      rivalries: { ...this.profile.rivalries, [key]: rivalry },
    });

    const afterLevel = this.levelInfo.level;
    return { xpAwarded, newLevel: afterLevel, leveledUp: afterLevel > beforeLevel };
  }

  /** The running record against a specific opponent, if any matches have
   * been played against them under this name yet. */
  getRivalry(opponentName: string): RivalryRecord | null {
    return this.profile.rivalries[normalizeOpponentKey(opponentName)] ?? null;
  }

  private update(patch: Partial<Profile>): void {
    this.profile = { ...this.profile, ...patch };
    save(this.profile);
    for (const l of this.listeners) l(this.profile);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const profileStore = new ProfileStore();
