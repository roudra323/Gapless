/**
 * The liveness heartbeat (docs/03 "Health"). The indexer beats on every step that proves the
 * process works: each loop cycle, each retry attempt, and each leader-wait attempt.
 */
export class Heartbeat {
  private last: number;

  constructor(private readonly now: () => number = Date.now) {
    // Boot counts as a beat, so the process is live while it starts.
    this.last = now();
  }

  beat(): void {
    this.last = this.now();
  }

  /** Epoch milliseconds of the last beat. */
  lastBeatAt(): number {
    return this.last;
  }
}
