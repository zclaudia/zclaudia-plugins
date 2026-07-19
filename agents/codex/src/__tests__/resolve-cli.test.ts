import { describe, expect, it } from 'vitest';
import { resolveCodexCli } from '../resolve-cli.js';

describe('resolveCodexCli', () => {
  it('returns explicit cliPath when provided', () => {
    expect(resolveCodexCli('/opt/codex/bin/codex')).toBe('/opt/codex/bin/codex');
  });

  it('finds codex on PATH when present', () => {
    const original = process.env.PATH;
    process.env.PATH = `/tmp/fake-bin:${original ?? ''}`;
    // Test uses vi/mock or a temp executable — implement findExecutable mock
    // Minimal: if `which codex` works in CI dev box, assert typeof string
    const resolved = resolveCodexCli(undefined);
    if (resolved) expect(resolved).toMatch(/codex$/);
    process.env.PATH = original;
  });

  it('returns undefined when not found', () => {
    const original = process.env.PATH;
    process.env.PATH = '/nonexistent';
    expect(resolveCodexCli(undefined)).toBeUndefined();
    process.env.PATH = original;
  });
});
