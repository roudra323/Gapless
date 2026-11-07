/** Whether this process holds the advisory lock now. Read by `/readyz`, set by the supervisor. */
export class LeaderStatus {
  private leader = false;

  /** @param onChange called on every `set` (the `is_leader` gauge, docs/09). */
  constructor(private readonly onChange: (isLeader: boolean) => void = () => undefined) {}

  set(isLeader: boolean): void {
    this.leader = isLeader;
    this.onChange(isLeader);
  }

  isLeader(): boolean {
    return this.leader;
  }
}
