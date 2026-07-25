import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runAdapterConformanceSuite } from '../../../../scripts/runtime-conformance.mjs';

const runCodexAppServerMock = vi.fn(async function* (_input, _opts) {
  yield { type: 'init', sessionId: 't1' };
});
const abortCodexSessionMock = vi.fn(async () => {});
const setCodexSessionModeMock = vi.fn();

vi.mock('../runner.js', () => ({
  runCodexAppServer: (...args: unknown[]) => runCodexAppServerMock(...args),
  abortCodexSession: (...args: unknown[]) => abortCodexSessionMock(...args),
  setCodexSessionMode: (...args: unknown[]) => setCodexSessionModeMock(...args),
}));

import { CodexAgentAdapter } from '../adapter.js';

describe('CodexAgentAdapter', () => {
  beforeEach(() => {
    runCodexAppServerMock.mockClear();
    abortCodexSessionMock.mockClear();
    setCodexSessionModeMock.mockClear();
    runCodexAppServerMock.mockImplementation(async function* (_input, _opts) {
      yield { type: 'init', sessionId: 't1' };
    });
  });

  it('registers type codex', () => {
    expect(new CodexAgentAdapter(async () => null).type).toBe('codex');
  });

  it('satisfies the shared normalized event-stream contract', async () => {
    runCodexAppServerMock.mockImplementationOnce(async function* () {
      yield { type: 'init', sessionId: 'codex-session' };
      yield { type: 'assistant_delta', content: 'hello from Codex' };
      yield { type: 'provider_turn_finished', isComplete: true };
    });
    const suite = await runAdapterConformanceSuite({
      adapter: new CodexAgentAdapter(async () => null),
      input: 'hello',
      context: { cwd: '/tmp/project', claudiaSessionId: 'session-1', serverPort: 3100 },
      onPermission: vi.fn(),
    });
    expect(suite.passed).toBe(true);
  });

  it('calls createToolBridge and passes bridge into runCodexAppServer', async () => {
    const bridge = { name: 'claudia-plugins', config: { command: 'node' } };
    const createToolBridge = vi.fn(async () => bridge);
    const onPermission = vi.fn();
    const adapter = new CodexAgentAdapter(createToolBridge);
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'sess', serverPort: 3100, mode: 'default' },
      onPermission
    )) {
      /* drain */
    }
    expect(createToolBridge).toHaveBeenCalledWith({
      serverPort: 3100,
      sessionId: 'sess',
    });
    expect(runCodexAppServerMock).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ cwd: '/p', bridge, mode: 'default' }),
      onPermission
    );
  });

  it('uses setSessionMode over context.mode for the next turn', async () => {
    const adapter = new CodexAgentAdapter(async () => null);
    adapter.setSessionMode('sess', 'plan');
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'sess', mode: 'default' },
      vi.fn()
    )) {
      /* drain */
    }
    expect(setCodexSessionModeMock).toHaveBeenCalledWith('sess', 'plan');
    expect(runCodexAppServerMock).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ mode: 'plan' }),
      expect.any(Function)
    );
  });

  it('abort clears session mode and kills runner session', async () => {
    const adapter = new CodexAgentAdapter(async () => null);
    adapter.setSessionMode('sess', 'ask');
    await adapter.abort('sess', '/p');
    expect(abortCodexSessionMock).toHaveBeenCalledWith('sess');
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'sess', mode: 'default' },
      vi.fn()
    )) {
      /* drain */
    }
    expect(runCodexAppServerMock).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ mode: 'default' }),
      expect.any(Function)
    );
  });

  it('abort with provider session id clears claudia-keyed session mode while run is active', async () => {
    let unblockRun: (() => void) | undefined;
    const runBlocked = new Promise<void>(resolve => {
      unblockRun = resolve;
    });
    runCodexAppServerMock.mockImplementationOnce(async function* () {
      yield { type: 'init', sessionId: 'prov-1' };
      await runBlocked;
    });
    const adapter = new CodexAgentAdapter(async () => null);
    adapter.setSessionMode('claudia-sess', 'plan');
    const collected: unknown[] = [];
    const runTask = (async () => {
      for await (const ev of adapter.run(
        'hi',
        { cwd: '/p', claudiaSessionId: 'claudia-sess', mode: 'default' },
        vi.fn()
      )) {
        collected.push(ev);
      }
    })();
    await vi.waitFor(() => expect(collected.length).toBe(1));
    await adapter.abort('prov-1', '/p');
    unblockRun?.();
    await runTask;
    expect(abortCodexSessionMock).toHaveBeenCalledWith('prov-1');
    runCodexAppServerMock.mockClear();
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'claudia-sess', mode: 'default' },
      vi.fn()
    )) {
      /* drain */
    }
    expect(runCodexAppServerMock).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ mode: 'default' }),
      expect.any(Function)
    );
  });

  it('getRunState returns providerSessionId and providerCwd after init', async () => {
    runCodexAppServerMock.mockImplementationOnce(async function* () {
      yield { type: 'init', sessionId: 'prov-9' };
    });
    const adapter = new CodexAgentAdapter(async () => null);
    const context = { cwd: '/p', claudiaSessionId: 'sess' };
    for await (const _ of adapter.run('hi', context, vi.fn())) {
      /* drain */
    }
    expect(adapter.getRunState(context)).toEqual({
      providerSessionId: 'prov-9',
      providerCwd: '/p',
    });
  });

  it('defaults onPermission to deny when not provided', async () => {
    const adapter = new CodexAgentAdapter(async () => null);
    for await (const _ of adapter.run('hi', { cwd: '/p', claudiaSessionId: 'sess' })) {
      /* drain */
    }
    const onPermission = runCodexAppServerMock.mock.calls[0][2] as () => Promise<{
      behavior: string;
    }>;
    expect(await onPermission()).toEqual({ behavior: 'deny' });
  });
});
