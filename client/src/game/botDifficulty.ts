export type BotDifficultyLevel = "easy" | "medium" | "hard";

export interface BotDifficultyConfig {
  label: string;
  /** How long after first getting a clear shot the bot waits before it
   * starts actually pulling the trigger — simulates reaction time rather
   * than an instant, inhuman snap onto a target the moment it's visible. */
  reactionMs: number;
  /** Max turn rate (rad/s) the bot's facing can close the gap to the ideal
   * "look at the player" angle — low values read as sluggish/human, high
   * values track almost instantly. */
  aimTurnSpeed: number;
  /** Half-angle (radians) of the random cone the bot's actual fired shot
   * is jittered within — reuses the exact same randomSpreadDirection
   * weapons already use for pellet spread, so a wide cone naturally
   * produces frequent clean misses without a separate "miss chance" hack. */
  aimErrorRad: number;
  /** Minimum time between trigger pulls, layered on top of the rifle's own
   * semi-auto fire-rate cooldown — lower difficulties hold back a beat
   * between shots instead of firing the instant the weapon allows it. */
  fireIntervalMs: number;
}

export const BOT_DIFFICULTIES: Record<BotDifficultyLevel, BotDifficultyConfig> = {
  easy: {
    label: "Easy",
    reactionMs: 650,
    aimTurnSpeed: 2.2,
    aimErrorRad: 0.09,
    fireIntervalMs: 260,
  },
  medium: {
    label: "Medium",
    reactionMs: 350,
    aimTurnSpeed: 4.2,
    aimErrorRad: 0.045,
    fireIntervalMs: 140,
  },
  hard: {
    label: "Hard",
    reactionMs: 130,
    aimTurnSpeed: 7.5,
    aimErrorRad: 0.014,
    fireIntervalMs: 80,
  },
};

export const DEFAULT_BOT_DIFFICULTY: BotDifficultyLevel = "medium";
