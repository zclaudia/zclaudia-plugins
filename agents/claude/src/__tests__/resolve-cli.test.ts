import { describe, expect, it } from 'vitest';

const { inspectClaudeCli, parseClaudeCliVersion, resolveClaudeCliFromPath } =
  await import('../resolve-cli.js');

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

describe('inspectClaudeCli', () => {
  it('accepts a CLI in the tested range using a deterministic spawn fixture', () => {
    expect(
      inspectClaudeCli('/fixture/claude', {
        run: () => ({ status: 0, stdout: '2.1.141 (Claude Code)' }),
      })
    ).toEqual({ status: 'supported', version: '2.1.141' });
  });

  it('blocks a CLI below the supported minimum', () => {
    expect(
      inspectClaudeCli('/fixture/claude', {
        run: () => ({ status: 0, stdout: 'Claude Code 2.1.139' }),
      })
    ).toMatchObject({ status: 'blocked', version: '2.1.139' });
  });

  it('warns for a CLI above the tested range', () => {
    expect(
      inspectClaudeCli('/fixture/claude', {
        run: () => ({ status: 0, stdout: '2.2.0' }),
      })
    ).toMatchObject({ status: 'warning', version: '2.2.0' });
  });

  it('rejects an unrecognized version response', () => {
    expect(() =>
      inspectClaudeCli('/fixture/claude', {
        run: () => ({ status: 0, stdout: 'unknown' }),
      })
    ).toThrow('unrecognized version');
  });
});

describe('parseClaudeCliVersion', () => {
  it('extracts versions from common Claude Code output', () => {
    expect(parseClaudeCliVersion('2.1.141 (Claude Code)')).toBe('2.1.141');
    expect(parseClaudeCliVersion('Claude Code 2.1.141')).toBe('2.1.141');
  });
});
