/**
 * The liveness heartbeat (docs/03 "Health"). The indexer beats on every step that proves the
 * process works: each loop cycle, each retry attempt, and each leader-wait attempt.
 */
export class Heartbeat {
  private last: number;

  /**
   * @param now the clock (tests pass a fixed one).
   * @param onBeat called with the time of every beat (the `last_tick` gauge, docs/09).
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly onBeat: (atMs: number) => void = () => undefined,
  ) {
    // Boot counts as a beat, so the process is live while it starts.
    this.last = now();
    onBeat(this.last);
  }

  beat(): void {
    this.last = this.now();
    this.onBeat(this.last);
  }

  /** Epoch milliseconds of the last beat. */
  lastBeatAt(): number {
    return this.last;
  }
}
