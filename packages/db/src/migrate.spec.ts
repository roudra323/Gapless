import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER } from './migrate.js';

describe('MIGRATIONS_FOLDER', () => {
  it('points at the committed migrations', () => {
    expect(existsSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'))).toBe(true);
  });
});
