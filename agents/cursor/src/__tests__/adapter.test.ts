import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runAdapterConformanceSuite } from '../../../../scripts/runtime-conformance.mjs';

const runCursorMock = vi.fn(async function* () {
  yield { type: 'init', sessionId: 'prov-1' } as const;
});
const abortCursorSessionMock = vi.fn(async () => {});

vi.mock('../runner.js', () => ({
  runCursor: (...args: unknown[]) => runCursorMock(...args),
  abortCursorSession: (...args: unknown[]) => abortCursorSessionMock(...args),
}));

import { CursorAgentAdapter } from '../adapter.js';

describe('CursorAgentAdapter', () => {
  beforeEach(() => {
    runCursorMock.mockClear();
    abortCursorSessionMock.mockClear();
  });

  it('registers type cursor', () => {
    expect(new CursorAgentAdapter(async () => null).type).toBe('cursor');
  });

  it('satisfies the shared normalized event-stream contract', async () => {
    runCursorMock.mockImplementationOnce(async function* () {
      yield { type: 'init', sessionId: 'cursor-session' };
      yield { type: 'assistant', content: 'hello from Cursor' };
      yield { type: 'result', isComplete: true };
    });
    const suite = await runAdapterConformanceSuite({
      adapter: new CursorAgentAdapter(async () => null),
      input: 'hello',
      context: { cwd: '/tmp/project', claudiaSessionId: 'session-1', serverPort: 3100 },
      onPermission: vi.fn(),
    });
    expect(suite.passed).toBe(true);
  });

  it('calls createToolBridge and passes bridge into runCursor', async () => {
    const bridge = { name: 'claudia-plugins', config: { command: 'node' } };
    const createToolBridge = vi.fn(async () => bridge);
    const adapter = new CursorAgentAdapter(createToolBridge);
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'sess', serverPort: 3100, mode: 'default' },
      vi.fn()
    )) {
      /* drain */
    }
    expect(createToolBridge).toHaveBeenCalledWith({
      serverPort: 3100,
      sessionId: 'sess',
    });
    expect(runCursorMock).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ cwd: '/p', bridge, mode: 'default' })
    );
  });

  it('uses setSessionMode over context.mode for the next turn', async () => {
    const adapter = new CursorAgentAdapter(async () => null);
    adapter.setSessionMode('sess', 'plan');
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'sess', mode: 'default' },
      vi.fn()
    )) {
      /* drain */
    }
    expect(runCursorMock).toHaveBeenCalledWith('hi', expect.objectContaining({ mode: 'plan' }));
  });

  it('abort clears session mode and kills runner session', async () => {
    const adapter = new CursorAgentAdapter(async () => null);
    adapter.setSessionMode('sess', 'ask');
    await adapter.abort('sess', '/p');
    expect(abortCursorSessionMock).toHaveBeenCalledWith('sess');
    // next run should not force ask
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'sess', mode: 'default' },
      vi.fn()
    )) {
      /* drain */
    }
    expect(runCursorMock).toHaveBeenCalledWith('hi', expect.objectContaining({ mode: 'default' }));
  });

  it('abort with provider session id clears claudia-keyed session mode while run is active', async () => {
    let unblockRun: (() => void) | undefined;
    const runBlocked = new Promise<void>(resolve => {
      unblockRun = resolve;
    });
    runCursorMock.mockImplementationOnce(async function* (_input, options) {
      options.onSessionId?.('prov-1');
      yield { type: 'init', sessionId: 'prov-1' };
      await runBlocked;
    });
    const adapter = new CursorAgentAdapter(async () => null);
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
    expect(abortCursorSessionMock).toHaveBeenCalledWith('prov-1');
    runCursorMock.mockClear();
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'claudia-sess', mode: 'default' },
      vi.fn()
    )) {
      /* drain */
    }
    expect(runCursorMock).toHaveBeenCalledWith('hi', expect.objectContaining({ mode: 'default' }));
  });

  it('clears providerToClaudiaSessionId after normal run completion', async () => {
    runCursorMock.mockImplementationOnce(async function* (_input, options) {
      options.onSessionId?.('prov-1');
      yield { type: 'init', sessionId: 'prov-1' };
    });
    const adapter = new CursorAgentAdapter(async () => null);
    adapter.setSessionMode('claudia-sess', 'plan');
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'claudia-sess', mode: 'default' },
      vi.fn()
    )) {
      /* drain */
    }
    // Stale abort with provider id should not resolve to claudia session after cleanup.
    await adapter.abort('prov-1', '/p');
    runCursorMock.mockClear();
    for await (const _ of adapter.run(
      'hi',
      { cwd: '/p', claudiaSessionId: 'claudia-sess', mode: 'default' },
      vi.fn()
    )) {
      /* drain */
    }
    expect(runCursorMock).toHaveBeenCalledWith('hi', expect.objectContaining({ mode: 'plan' }));
  });

  it('updates getRunState when onSessionId fires', async () => {
    runCursorMock.mockImplementationOnce(async function* (_input, options) {
      options.onSessionId?.('prov-9');
      yield { type: 'init', sessionId: 'prov-9' };
    });
    const adapter = new CursorAgentAdapter(async () => null);
    const context = { cwd: '/p', claudiaSessionId: 'sess' };
    for await (const _ of adapter.run('hi', context, vi.fn())) {
      /* drain */
    }
    expect(adapter.getRunState(context).providerSessionId).toBe('prov-9');
  });
});
