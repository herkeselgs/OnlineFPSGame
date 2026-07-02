/**
 * Tracks an estimate of (server clock - local clock) from the serverTime
 * carried on every snapshot, smoothed so per-packet jitter doesn't make the
 * offset (and therefore remote-player interpolation timing) jump around.
 * Needed because entity interpolation renders remote players at
 * "estimated current server time minus INTERP_DELAY_MS", and the only clock
 * we have locally is our own.
 */
export class ClockSync {
  private offsetMs = 0;
  private initialized = false;

  ingestServerTime(serverTimeMs: number): void {
    const sample = serverTimeMs - Date.now();
    if (!this.initialized) {
      this.offsetMs = sample;
      this.initialized = true;
      return;
    }
    this.offsetMs += (sample - this.offsetMs) * 0.1;
  }

  estimateServerTime(): number {
    return Date.now() + this.offsetMs;
  }
}
