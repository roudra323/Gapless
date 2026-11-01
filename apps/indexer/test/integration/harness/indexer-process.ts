import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';

import type { IndexerConfig } from '@gapless/config';

import { waitFor } from './wait-for.js';

const APP_DIR = join(import.meta.dirname, '../../..');
const MAIN = join(APP_DIR, 'dist/main.js');

export type LogLine = Record<string, unknown>;

export type IndexerProcess = {
  readonly lines: LogLine[];
  /** Resolves when the process ends. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly kill: (signal: NodeJS.Signals) => void;
  /** Waits for a log line that matches, or throws after `timeoutMs`. */
  readonly waitForLine: (match: (line: LogLine) => boolean, timeoutMs?: number) => Promise<LogLine>;
};

/** The config as environment variables, the way `loadConfig` reads them. */
export function toEnv(config: IndexerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) env[key] = String(value);
  }
  return env;
}

/**
 * Starts the built indexer (`dist/main.js`) as a real child process, for the tests that need a
 * real signal or a real kill: SIGKILL in the middle of a batch, SIGTERM and the exit code.
 * The env is explicit and no `.env` file is read. Run `pnpm test:chaos`, which builds first.
 */
export function startIndexerProcess(config: IndexerConfig): IndexerProcess {
  const child: ChildProcess = spawn(process.execPath, [MAIN], {
    cwd: APP_DIR,
    env: { PATH: process.env.PATH ?? '', ...toEnv(config) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: LogLine[] = [];
  let buffer = '';
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const text = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (text.trim() !== '') {
        try {
          lines.push(JSON.parse(text) as LogLine);
        } catch {
          lines.push({ msg: '<not json>', text });
        }
      }
      newline = buffer.indexOf('\n');
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    lines,
    exited,
    kill: (signal) => {
      child.kill(signal);
    },
    waitForLine: async (match, timeoutMs = 30_000) => {
      await waitFor(() => lines.some(match), { timeoutMs, description: 'a matching log line' });
      return lines.find(match) as LogLine;
    },
  };
}
