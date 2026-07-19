import { describe, expect, it } from 'vitest';

const { resolveClaudeCliFromPath } = await import('../resolve-cli.js');

/** Build a fake `exists` predicate that returns true only for the given set of paths. */
function existsFor(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p: string) => set.has(p);
}

describe('resolveClaudeCliFromPath', () => {
  it('returns the claude binary from the first PATH dir that contains it (posix)', () => {
    const result = resolveClaudeCliFromPath('/opt/homebrew/bin:/usr/bin', {
      platform: 'darwin',
      exists: existsFor(['/opt/homebrew/bin/claude']),
    });
    expect(result).toBe('/opt/homebrew/bin/claude');
  });

  it('honors PATH order, preferring the earlier directory', () => {
    const result = resolveClaudeCliFromPath('/first:/second', {
      platform: 'linux',
      exists: existsFor(['/first/claude', '/second/claude']),
    });
    expect(result).toBe('/first/claude');
  });

  it('returns undefined when no PATH dir contains claude', () => {
    const result = resolveClaudeCliFromPath('/usr/bin:/bin', {
      platform: 'linux',
      exists: existsFor(['/usr/bin/node']),
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty or missing PATH', () => {
    expect(
      resolveClaudeCliFromPath(undefined, { platform: 'linux', exists: () => true })
    ).toBeUndefined();
    expect(resolveClaudeCliFromPath('', { platform: 'linux', exists: () => true })).toBeUndefined();
  });

  it('resolves windows executable extensions in preference order', () => {
    const result = resolveClaudeCliFromPath('C:\\bin', {
      platform: 'win32',
      exists: existsFor(['C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe']),
    });
    expect(result).toBe('C:\\bin\\claude.exe');
  });

  it('skips blank PATH segments', () => {
    const result = resolveClaudeCliFromPath('::/usr/local/bin', {
      platform: 'linux',
      exists: existsFor(['/usr/local/bin/claude']),
    });
    expect(result).toBe('/usr/local/bin/claude');
  });
});
