/** XP/level curve, shared so the client's local calculation is the single
 * source of truth (there's no server-side account, so nothing to keep in
 * sync with — but keeping it here rather than duplicated in a UI file
 * keeps it next to the cosmetic unlock levels it feeds). Cumulative XP
 * needed for level L is 100 * L(L-1)/2 — a gentle ramp that keeps early
 * levels (and the first cosmetic unlocks) coming quickly.
 */
const XP_PER_LEVEL_STEP = 100;

export function xpForLevel(level: number): number {
  return (XP_PER_LEVEL_STEP * level * (level - 1)) / 2;
}

export function levelForXp(totalXp: number): number {
  let level = 1;
  while (xpForLevel(level + 1) <= totalXp) level++;
  return level;
}

export function xpProgress(totalXp: number): { level: number; intoLevel: number; forNextLevel: number } {
  const level = levelForXp(totalXp);
  const base = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { level, intoLevel: totalXp - base, forNextLevel: next - base };
}

export const XP_PER_KILL = 10;
export const XP_PER_WIN = 60;
export const XP_PER_MATCH_PLAYED = 20;

export function xpForMatch(kills: number, won: boolean): number {
  return kills * XP_PER_KILL + (won ? XP_PER_WIN : 0) + XP_PER_MATCH_PLAYED;
}
