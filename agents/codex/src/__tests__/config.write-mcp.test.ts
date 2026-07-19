import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

const writeFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: writeFileSyncMock,
  };
});

describe('writeMcpConfig graceful degradation', () => {
  beforeEach(() => {
    writeFileSyncMock.mockReset();
    writeFileSyncMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty configSignature without throwing when filesystem write fails', async () => {
    vi.stubEnv('ZCLAUDIA_DATA_DIR', '/tmp/codex-fail-test');
    vi.resetModules();
    const { writeMcpConfig } = await import('../config.js');

    const result = writeMcpConfig({
      name: 'claudia-plugins',
      config: { command: 'node', args: [`/unique-bridge-${Date.now()}`] },
    });

    expect(result.configSignature).toBe('');
    expect(result.configDir).toBe(join('/tmp/codex-fail-test', 'codex-config'));
    expect(writeFileSyncMock).toHaveBeenCalled();
  });
});
