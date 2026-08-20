import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionCallback } from '@zclaudia/plugin-sdk/providers';

const { mockClient, MockCodexAppServerClient } = vi.hoisted(() => {
  const mockClient = {
    currentMode: undefined as string | undefined,
    startThread: vi.fn(async () => 'thread-1'),
    resumeThread: vi.fn(async () => {}),
    runTurn: vi.fn(async function* () {
      yield { type: 'init', sessionId: 'thread-1' };
      yield { type: 'assistant_delta', content: 'ok' };
    }),
    interruptTurn: vi.fn(async () => {}),
    updateExtraArgs: vi.fn(),
    destroy: vi.fn(),
    activeTurns: 0,
    lastActivity: Date.now(),
  };
  return {
    mockClient,
    MockCodexAppServerClient: vi.fn(function MockCodexAppServerClient() {
      return mockClient;
    }),
  };
});

vi.mock('../app-server-client.js', () => ({
  CodexAppServerClient: MockCodexAppServerClient,
}));

const writeMcpConfigMock = vi.hoisted(() =>
  vi.fn(() => ({ configDir: '/tmp/codex-config', configSignature: 'sig-1' }))
);

vi.mock('../config.js', async importOriginal => {
  const original = await importOriginal<typeof import('../config.js')>();
  return {
    ...original,
    writeMcpConfig: writeMcpConfigMock,
  };
});

import {
  abortCodexSession,
  destroyAllCodexClients,
  getCacheKey,
  getOrCreateAppServerClient,
  resetCodexRunnerForTests,
  runCodexAppServer,
} from '../runner.js';

const denyAll: PermissionCallback = async () => ({ behavior: 'deny' as const });

describe('runner', () => {
  beforeEach(() => {
    resetCodexRunnerForTests();
    MockCodexAppServerClient.mockClear();
    writeMcpConfigMock.mockClear();
    mockClient.startThread.mockClear();
    mockClient.resumeThread.mockClear();
    mockClient.runTurn.mockClear();
    mockClient.interruptTurn.mockClear();
    mockClient.updateExtraArgs.mockClear();
    mockClient.currentMode = undefined;
  });

  it('uses an opaque cache key that does not expose environment or MCP secrets', () => {
    const key = getCacheKey(
      { cwd: '/tmp/project', cliPath: '/private/bin/codex' },
      { API_TOKEN: 'super-secret-token' },
      'mcp-token = "another-secret"'
    );

    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain('super-secret-token');
    expect(key).not.toContain('another-secret');
    expect(
      getCacheKey(
        { cwd: '/tmp/project', cliPath: '/private/bin/codex' },
        { API_TOKEN: 'super-secret-token' },
        'mcp-token = "another-secret"'
      )
    ).toBe(key);
    expect(
      getCacheKey(
        { cwd: '/tmp/project', cliPath: '/private/bin/codex' },
        { API_TOKEN: 'different-secret-token' },
        'mcp-token = "another-secret"'
      )
    ).not.toBe(key);
  });

  it('cache key ignores mode because permission behavior updates on the reused client', () => {
    const base = { cwd: '/tmp/project', cliPath: '/tmp/codex' };
    const env = { PATH: '/usr/bin' };
    expect(getCacheKey({ ...base, mode: 'plan' }, env, 'sig')).toBe(
      getCacheKey({ ...base, mode: 'ask' }, env, 'sig')
    );
  });

  it('cache key ignores model because model is a turn-level override', () => {
    const base = { cwd: '/tmp/project', cliPath: '/tmp/codex' };
    const env = { PATH: '/usr/bin' };
    expect(getCacheKey({ ...base, model: 'gpt-5' }, env, 'sig')).toBe(
      getCacheKey({ ...base, model: 'o3' }, env, 'sig')
    );
  });

  it('reuses one client across mode and model changes without model process args', () => {
    getOrCreateAppServerClient({ cwd: '/tmp/p', mode: 'plan', bridge: null });
    getOrCreateAppServerClient({ cwd: '/tmp/p', mode: 'ask', model: 'gpt-5', bridge: null });
    expect(MockCodexAppServerClient).toHaveBeenCalledTimes(1);
    expect(mockClient.currentMode).toBe('ask');
    expect(mockClient.updateExtraArgs).toHaveBeenLastCalledWith([
      '-c',
      'approval_policy="on-request"',
    ]);
  });

  it('sets currentMode on the client at creation from options.mode', () => {
    getOrCreateAppServerClient({ cwd: '/tmp/p', mode: 'plan', bridge: null });
    expect(mockClient.currentMode).toBe('plan');
  });

  it('new run calls writeMcpConfig, startThread(cwd), and streams events', async () => {
    const events = [];
    for await (const event of runCodexAppServer(
      'hello',
      { cwd: '/tmp/project', bridge: null },
      denyAll
    )) {
      events.push(event);
    }

    expect(writeMcpConfigMock).toHaveBeenCalledWith(null);
    expect(mockClient.startThread).toHaveBeenCalledWith('/tmp/project');
    expect(mockClient.resumeThread).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: 'init', sessionId: 'thread-1' },
      { type: 'assistant_delta', content: 'ok' },
    ]);
  });

  it('resume with sessionId calls resumeThread', async () => {
    for await (const _event of runCodexAppServer(
      'hello',
      { cwd: '/tmp/project', sessionId: 'existing-thread', bridge: null },
      denyAll
    )) {
      // drain generator
    }

    expect(mockClient.resumeThread).toHaveBeenCalledWith('existing-thread');
    expect(mockClient.startThread).not.toHaveBeenCalled();
  });

  it('abortCodexSession calls interruptTurn', async () => {
    const gen = runCodexAppServer(
      'hello',
      { cwd: '/tmp/project', sessionId: 'thread-1', bridge: null },
      denyAll
    );
    await gen.next();

    await abortCodexSession('thread-1');

    expect(mockClient.interruptTurn).toHaveBeenCalledWith('thread-1');
  });

  it('re-registers the fresh thread for aborts after session recovery', async () => {
    let unblockTurn: (() => void) | undefined;
    const turnBlocked = new Promise<void>(resolve => {
      unblockTurn = resolve;
    });
    mockClient.runTurn
      .mockImplementationOnce(async function* () {
        yield { type: 'init', sessionId: 'existing-thread' };
        yield { type: 'provider_error', error: 'thread not found' };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'init', sessionId: 'thread-fresh' };
        await turnBlocked;
        yield { type: 'assistant_delta', content: 'recovered' };
      });
    mockClient.startThread.mockResolvedValueOnce('thread-fresh');

    const gen = runCodexAppServer(
      'hello',
      { cwd: '/tmp/project', sessionId: 'existing-thread', bridge: null },
      denyAll
    );
    // Recovery notice, then the fresh turn's init.
    await expect(gen.next()).resolves.toMatchObject({
      value: expect.objectContaining({ type: 'assistant_delta' }),
    });
    await expect(gen.next()).resolves.toMatchObject({
      value: { type: 'init', sessionId: 'thread-fresh' },
    });

    await abortCodexSession('existing-thread');
    expect(mockClient.interruptTurn).not.toHaveBeenCalled();

    await abortCodexSession('thread-fresh');
    expect(mockClient.interruptTurn).toHaveBeenCalledWith('thread-fresh');

    unblockTurn?.();
    await gen.next();
    await gen.return(undefined);
  });

  afterEach(() => {
    destroyAllCodexClients();
  });
});
