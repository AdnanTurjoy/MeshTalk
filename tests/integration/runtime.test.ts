import { describe, expect, it } from 'vitest';

describe('integration runtime', () => {
  it('runs under Electron so native modules match the shipped ABI', () => {
    expect(process.versions.electron).toBeDefined();
  });
});
