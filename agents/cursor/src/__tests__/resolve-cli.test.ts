import { describe, expect, it } from 'vitest';

const { resolveCursorCliFromPath } = await import('../resolve-cli.js');

/** Build a fake `exists` predicate that returns true only for the given set of paths. */
function existsFor(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p: string) => set.has(p);
}

describe('resolveCursorCliFromPath', () => {
  it('returns the cursor-agent binary from the first PATH dir that contains it (posix)', () => {
    const result = resolveCursorCliFromPath('/opt/homebrew/bin:/usr/bin', {
      platform: 'darwin',
      exists: existsFor(['/opt/homebrew/bin/cursor-agent']),
    });
    expect(result).toBe('/opt/homebrew/bin/cursor-agent');
  });

  it('honors PATH order, preferring the earlier directory', () => {
    const result = resolveCursorCliFromPath('/first:/second', {
      platform: 'linux',
      exists: existsFor(['/first/cursor-agent', '/second/cursor-agent']),
    });
    expect(result).toBe('/first/cursor-agent');
  });

  it('returns undefined when no PATH dir contains cursor-agent', () => {
    const result = resolveCursorCliFromPath('/usr/bin:/bin', {
      platform: 'linux',
      exists: existsFor(['/usr/bin/node']),
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty or missing PATH', () => {
    expect(
      resolveCursorCliFromPath(undefined, { platform: 'linux', exists: () => true })
    ).toBeUndefined();
    expect(resolveCursorCliFromPath('', { platform: 'linux', exists: () => true })).toBeUndefined();
  });

  it('resolves windows executable extensions in preference order', () => {
    const result = resolveCursorCliFromPath('C:\\bin', {
      platform: 'win32',
      exists: existsFor(['C:\\bin\\cursor-agent.cmd', 'C:\\bin\\cursor-agent.exe']),
    });
    expect(result).toBe('C:\\bin\\cursor-agent.exe');
  });

  it('skips blank PATH segments', () => {
    const result = resolveCursorCliFromPath('::/usr/local/bin', {
      platform: 'linux',
      exists: existsFor(['/usr/local/bin/cursor-agent']),
    });
    expect(result).toBe('/usr/local/bin/cursor-agent');
  });
});
