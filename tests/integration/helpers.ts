import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Logger } from '../../src/main/logger';

export function tempDir(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), 'meshtalk-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}
