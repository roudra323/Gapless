/** Whether this process holds the advisory lock now. Read by `/readyz`, set by the supervisor. */
export class LeaderStatus {
  private leader = false;

  set(isLeader: boolean): void {
    this.leader = isLeader;
  }

  isLeader(): boolean {
    return this.leader;
  }
}
