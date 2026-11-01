import { setTimeout as delay } from 'node:timers/promises';

export type WaitForOptions = {
  readonly timeoutMs: number;
  /** How often the condition is checked. Defaults to 100 ms. */
  readonly intervalMs?: number;
  /** Shown in the timeout error. */
  readonly description: string;
};

/**
 * Polls `condition` until it returns true, or throws after `timeoutMs`. Tests use it instead of
 * sleeping for a fixed time (docs/06 "Rules").
 */
export async function waitFor(
  condition: () => Promise<boolean> | boolean,
  { timeoutMs, intervalMs = 100, description }: WaitForOptions,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms: ${description}`);
    await delay(intervalMs);
  }
}
