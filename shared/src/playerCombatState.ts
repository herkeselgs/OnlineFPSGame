import { MAX_HEALTH, SPAWN_PROTECTION_MS } from "./constants.js";

export interface PlayerCombatState {
  health: number;
  alive: boolean;
  /** Server-time (ms) until which this player cannot take damage. Prevents
   * spawn-killing on small 1v1 maps. */
  spawnProtectedUntil: number;
  kills: number;
  deaths: number;
}

export function createPlayerCombatState(): PlayerCombatState {
  return { health: MAX_HEALTH, alive: true, spawnProtectedUntil: 0, kills: 0, deaths: 0 };
}

export interface DamageResult {
  applied: boolean;
  killed: boolean;
}

/** Authoritative damage application — call only on the server's copy of a
 * player's state. Returns applied=false if the shot should have no effect
 * (already dead, or still spawn-protected). */
export function applyDamage(state: PlayerCombatState, amount: number, nowMs: number): DamageResult {
  if (!state.alive) return { applied: false, killed: false };
  if (nowMs < state.spawnProtectedUntil) return { applied: false, killed: false };

  state.health = Math.max(0, state.health - amount);
  if (state.health <= 0) {
    state.alive = false;
    state.deaths += 1;
    return { applied: true, killed: true };
  }
  return { applied: true, killed: false };
}

export function respawn(state: PlayerCombatState, nowMs: number): void {
  state.health = MAX_HEALTH;
  state.alive = true;
  state.spawnProtectedUntil = nowMs + SPAWN_PROTECTION_MS;
}
