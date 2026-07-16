/** How close an imposter must be to a crewmate to kill them — close-range
 * only, deliberately nothing like Duel's ranged hitscan combat, so the
 * imposter has to commit to being right next to their target (and their
 * fellow crewmates) rather than picking people off from a distance. */
export const KILL_RANGE_M = 2.2;

/** Applies both at match start (so crewmates get a moment to scatter
 * before anyone can be killed) and after every kill — "so they can't just
 * spray" per the original design brief. */
export const KILL_COOLDOWN_MS = 20000;

/** How close a crewmate must be to a body to report it. */
export const BODY_REPORT_RADIUS_M = 2.4;

/** Beyond this distance, a gunshot isn't heard at all. The map's corner
 * rooms are roughly 60-65m apart along the diagonal, so this covers a bit
 * over half that — a kill is audible across a meaningful chunk of the map
 * (the intended risk/tension) without being audible literally everywhere,
 * which would make position irrelevant. */
export const GUNSHOT_AUDIBLE_RANGE_M = 35;
