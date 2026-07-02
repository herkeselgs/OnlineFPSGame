import { lerp, lerpAngle, Vec3 } from "./vec.js";

export interface PositionSample {
  time: number; // ms, same clock domain as whatever calls sampleAt
  position: Vec3;
  yaw: number;
}

/**
 * Timestamped ring-buffer of position samples with time-based lerp lookup.
 * Two different jobs, same data structure:
 *  - server-side lag compensation: rewind a target to where it was at the
 *    shooter's perceived time before hit-testing against it
 *  - client-side entity interpolation: render remote players slightly in
 *    the past (INTERP_DELAY_MS) so motion is smooth between snapshots
 *    instead of stair-stepping at the snapshot rate
 */
export class PositionHistory {
  private samples: PositionSample[] = [];

  constructor(private maxAgeMs: number) {}

  push(sample: PositionSample): void {
    this.samples.push(sample);
    const cutoff = sample.time - this.maxAgeMs;
    while (this.samples.length > 0 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
  }

  latest(): PositionSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  /** Interpolated (or extrapolated-by-clamping at the ends) sample at `time`. */
  sampleAt(time: number): PositionSample | undefined {
    const n = this.samples.length;
    if (n === 0) return undefined;
    if (n === 1 || time <= this.samples[0].time) return this.samples[0];
    if (time >= this.samples[n - 1].time) return this.samples[n - 1];

    for (let i = 0; i < n - 1; i++) {
      const a = this.samples[i];
      const b = this.samples[i + 1];
      if (time >= a.time && time <= b.time) {
        const span = b.time - a.time;
        const t = span > 1e-6 ? (time - a.time) / span : 0;
        return {
          time,
          position: lerp(a.position, b.position, t),
          yaw: lerpAngle(a.yaw, b.yaw, t),
        };
      }
    }
    return this.samples[n - 1];
  }

  clear(): void {
    this.samples = [];
  }
}
