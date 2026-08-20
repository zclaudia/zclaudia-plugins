import { EventEmitter } from 'events';
import { PassThrough, Readable } from 'stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock mcp-inject so tests do not touch real FS
vi.mock('../mcp-inject.js', () => ({
  injectCursorMcpBridge: vi.fn(() => ({ ok: true })),
  approveCursorMcpServers: vi.fn(async () => {}),
}));

// Mock resolve-cli to avoid PATH resolution in tests
vi.mock('../resolve-cli.js', () => ({
  resolveCursorCliFromPath: vi.fn(() => undefined),
}));

import { spawn } from 'child_process';
import { abortCursorSession, runCursor } from '../runner.js';
import { approveCursorMcpServers, injectCursorMcpBridge } from '../mcp-inject.js';

const spawnMock = vi.mocked(spawn);

interface FakeProcessOptions {
  stderr?: string[];
  closeCode?: number | null;
  closeSignal?: NodeJS.Signals | null;
  autoClose?: boolean;
  closeOnKill?: boolean;
}

function fakeProc(lines: string[], options: FakeProcessOptions = {}) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  };
  proc.stdout = Readable.from(lines.map(l => l + '\n'));
  proc.stderr = Readable.from(options.stderr ?? []);
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;

  let closed = false;
  proc.emitClose = (code, signal) => {
    if (closed) return;
    closed = true;
    proc.exitCode = code;
    proc.signalCode = signal;
    proc.emit('close', code, signal);
  };
  proc.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    proc.killed = true;
    if (options.closeOnKill) proc.emitClose(null, signal);
    return true;
  });

  if (options.autoClose !== false) {
    let endedStreams = 0;
    const emitCloseWhenStreamsEnd = () => {
      endedStreams += 1;
      if (endedStreams === 2) {
        proc.emitClose(
          options.closeCode === undefined ? 0 : options.closeCode,
          options.closeSignal ?? null
        );
      }
    };
    proc.stdout.once('end', emitCloseWhenStreamsEnd);
    proc.stderr.once('end', emitCloseWhenStreamsEnd);
  }

  return proc;
}

describe('runCursor', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.mocked(injectCursorMcpBridge).mockClear();
  });

  it('spawns cursor-agent with stream-json, trust, and yolo in default mode', async () => {
    spawnMock.mockReturnValueOnce(
      fakeProc([
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello' }] },
        }),
        JSON.stringify({ type: 'result', result: 'done' }),
      ])
    );

    const events = [];
    for await (const e of runCursor('hi', { cwd: '/proj' })) events.push(e);

    expect(spawnMock).toHaveBeenCalled();
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('cursor-agent');
    expect(args).toEqual(
      expect.arrayContaining(['-p', 'hi', '--output-format', 'stream-json', '--trust', '--yolo'])
    );
    expect(events.some(e => e.type === 'init' && e.sessionId === 's1')).toBe(true);
    expect(events.some(e => e.type === 'assistant' && e.content === 'hello')).toBe(true);
  });

  it('passes --mode=plan and --resume when set', async () => {
    spawnMock.mockReturnValueOnce(fakeProc([]));
    for await (const _ of runCursor('x', {
      cwd: '/proj',
      mode: 'plan',
      sessionId: 'chat-1',
    })) {
      /* drain */
    }
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--mode=plan');
    expect(args).toContain('--resume');
    expect(args).toContain('chat-1');
    expect(args).not.toContain('--yolo');
  });

  it('surfaces a resume failure without spawning a replacement session', async () => {
    spawnMock.mockReturnValueOnce(
      fakeProc([], { stderr: ['E: session not found\n'], closeCode: 1 })
    );
    const events = [];

    for await (const event of runCursor('continue', {
      cwd: '/proj',
      sessionId: 'missing-session',
    })) {
      events.push(event);
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--resume', 'missing-session'])
    );
    expect(events).toContainEqual({
      type: 'error',
      error: 'Cursor agent process exited (code=1): E: session not found',
    });
  });

  it('passes --mode=ask without yolo', async () => {
    spawnMock.mockReturnValueOnce(fakeProc([]));
    for await (const _ of runCursor('x', { cwd: '/proj', mode: 'ask' })) {
      /* drain */
    }
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--mode=ask');
    expect(args).not.toContain('--yolo');
  });

  it('prepends systemPrompt to the -p payload', async () => {
    spawnMock.mockReturnValueOnce(fakeProc([]));
    for await (const _ of runCursor('user', {
      cwd: '/proj',
      systemPrompt: 'be brief',
    })) {
      /* drain */
    }
    const args = spawnMock.mock.calls[0][1] as string[];
    const promptIdx = args.indexOf('-p');
    expect(args[promptIdx + 1]).toContain('[System Context]');
    expect(args[promptIdx + 1]).toContain('be brief');
    expect(args[promptIdx + 1]).toContain('user');
  });

  it('injects MCP bridge when bridge config is provided', async () => {
    spawnMock.mockReturnValueOnce(fakeProc([]));
    for await (const _ of runCursor('x', {
      cwd: '/proj',
      bridge: { name: 'claudia-plugins', config: { command: 'node' } },
    })) {
      /* drain */
    }
    expect(injectCursorMcpBridge).toHaveBeenCalledWith(
      '/proj',
      expect.objectContaining({ name: 'claudia-plugins' })
    );
  });

  it('yields ENOENT guidance when spawn emits error', async () => {
    const proc = fakeProc([], { autoClose: false });
    spawnMock.mockReturnValueOnce(proc);

    // Emit error immediately on next tick, before readline can finish
    process.nextTick(() => {
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
      proc.emit('error', err);
      proc.emitClose(null, null);
    });

    const events = [];
    for await (const e of runCursor('x', { cwd: '/proj' })) events.push(e);

    expect(
      events.some(e => e.type === 'error' && String(e.error).includes('cursor-agent not found'))
    ).toBe(true);
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(String(events.find(event => event.type === 'error')?.error)).toContain('cursor-agent');
  });

  it('surfaces a wrapper exit code with unfiltered stderr', async () => {
    spawnMock.mockReturnValueOnce(
      fakeProc([], {
        stderr: ['/opt/bin/zcursor: line 2: exec: cursor-agent: not found\n'],
        closeCode: 127,
      })
    );

    const events = [];
    for await (const e of runCursor('x', { cwd: '/proj', cliPath: '/opt/bin/zcursor' })) {
      events.push(e);
    }

    expect(events).toContainEqual({
      type: 'error',
      error:
        'Cursor agent process exited (code=127): ' +
        '/opt/bin/zcursor: line 2: exec: cursor-agent: not found',
    });
  });

  it('does not turn benign stderr from a successful run into an error', async () => {
    spawnMock.mockReturnValueOnce(
      fakeProc(
        [
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'hello' }] },
          }),
          JSON.stringify({ type: 'result', result: 'done' }),
        ],
        { stderr: ['Cursor agent diagnostic output\n'] }
      )
    );

    const events = [];
    for await (const e of runCursor('x', { cwd: '/proj' })) events.push(e);

    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('reports a non-zero exit even after useful output', async () => {
    spawnMock.mockReturnValueOnce(
      fakeProc(
        [
          JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'partial answer' }] },
          }),
          JSON.stringify({ type: 'result', result: 'partial result' }),
        ],
        { stderr: ['wrapper failed after output\n'], closeCode: 127 }
      )
    );

    const events = [];
    for await (const event of runCursor('x', { cwd: '/proj' })) events.push(event);

    expect(events.some(event => event.type === 'assistant')).toBe(true);
    expect(events).toContainEqual({
      type: 'error',
      error: 'Cursor agent process exited (code=127): wrapper failed after output',
    });
  });

  it('waits for close and includes stderr that arrives after stdout ends', async () => {
    const proc = fakeProc([], { autoClose: false });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    proc.stdout = stdout;
    proc.stderr = stderr;
    spawnMock.mockReturnValueOnce(proc);

    const resultPromise = (async () => {
      const events = [];
      for await (const event of runCursor('x', { cwd: '/proj' })) events.push(event);
      return events;
    })();

    await new Promise<void>(resolve => setImmediate(resolve));
    stdout.end();
    stderr.write('/opt/bin/zcursor: line 2: exec: ');
    stderr.end('cursor-agent: not found\n');

    const earlyResult = await Promise.race([
      resultPromise.then(() => 'finished'),
      new Promise<'waiting'>(resolve => setImmediate(() => resolve('waiting'))),
    ]);
    expect(earlyResult).toBe('waiting');

    proc.emitClose(127, null);
    await expect(resultPromise).resolves.toContainEqual({
      type: 'error',
      error:
        'Cursor agent process exited (code=127): ' +
        '/opt/bin/zcursor: line 2: exec: cursor-agent: not found',
    });
  });

  it('reports an unexpected terminating signal', async () => {
    spawnMock.mockReturnValueOnce(
      fakeProc([], {
        closeCode: null,
        closeSignal: 'SIGSEGV',
      })
    );

    const events = [];
    for await (const event of runCursor('x', { cwd: '/proj' })) events.push(event);

    expect(events).toContainEqual({
      type: 'error',
      error: 'Cursor agent process exited (signal=SIGSEGV)',
    });
  });

  it('does not spawn when the run was already aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const events = [];
    for await (const event of runCursor('x', { cwd: '/proj', abortController })) {
      events.push(event);
    }

    expect(spawnMock).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('escalates an early abort and suppresses interruption stderr', async () => {
    vi.useFakeTimers();
    try {
      const abortController = new AbortController();
      const proc = fakeProc([], {
        stderr: ['E: interrupted\n'],
        autoClose: false,
      });
      proc.kill.mockImplementation((signal: NodeJS.Signals) => {
        proc.killed = true;
        if (signal === 'SIGKILL') proc.emitClose(null, 'SIGKILL');
        return true;
      });
      spawnMock.mockReturnValueOnce(proc);

      const eventsPromise = (async () => {
        const events = [];
        for await (const event of runCursor('x', { cwd: '/proj', abortController })) {
          events.push(event);
        }
        return events;
      })();

      for (let index = 0; index < 5 && spawnMock.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      abortController.abort();
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

      await vi.advanceTimersByTimeAsync(500);
      const events = await eventsPromise;

      expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      expect(events.some(event => event.type === 'error')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('terminates the child when event handling throws', async () => {
    const proc = fakeProc(
      [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'provider-1' })],
      { autoClose: false, closeOnKill: true }
    );
    spawnMock.mockReturnValueOnce(proc);

    const events = [];
    for await (const event of runCursor('x', {
      cwd: '/proj',
      onSessionId: () => {
        throw new Error('session callback failed');
      },
    })) {
      events.push(event);
    }

    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(events).toContainEqual({
      type: 'error',
      error: 'Cursor error: session callback failed',
    });
  });

  it('cleans up an injected MCP bridge when spawn throws synchronously', async () => {
    const cleanup = vi.fn();
    vi.mocked(injectCursorMcpBridge).mockReturnValueOnce({
      ok: true,
      injected: true,
      injectedNames: ['claudia-plugins'],
      cleanup,
    });
    spawnMock.mockImplementationOnce(() => {
      throw new Error('invalid executable');
    });

    const events = [];
    for await (const event of runCursor('x', {
      cwd: '/proj',
      bridge: { name: 'claudia-plugins', config: { command: 'node' } },
    })) {
      events.push(event);
    }

    expect(cleanup).toHaveBeenCalledOnce();
    // Approval runs right after injection, before the spawn attempt.
    expect(approveCursorMcpServers).toHaveBeenCalledWith({
      binary: 'cursor-agent',
      cwd: '/proj',
      names: ['claudia-plugins'],
    });
    expect(events).toContainEqual({
      type: 'error',
      error: 'Failed to start Cursor agent at cursor-agent: invalid executable',
    });
  });

  it('passes --model when model is specified', async () => {
    spawnMock.mockReturnValueOnce(fakeProc([]));
    for await (const _ of runCursor('x', { cwd: '/proj', model: 'gpt-4' })) {
      /* drain */
    }
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('gpt-4');
  });

  it('uses cliPath when provided', async () => {
    spawnMock.mockReturnValueOnce(fakeProc([]));
    for await (const _ of runCursor('x', { cwd: '/proj', cliPath: '/custom/cursor-agent' })) {
      /* drain */
    }
    const [bin] = spawnMock.mock.calls[0];
    expect(bin).toBe('/custom/cursor-agent');
  });
});

describe('abortCursorSession', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('kills the active process for a session id', async () => {
    const proc = fakeProc([JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })], {
      autoClose: false,
      closeOnKill: true,
    });
    spawnMock.mockReturnValueOnce(proc);

    const gen = runCursor('x', { cwd: '/proj', sessionId: 's1' });
    await gen.next();

    await abortCursorSession('s1');
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await gen.return();
  });

  it('registers a fresh provider session for abort after init', async () => {
    const proc = fakeProc(
      [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'provider-1' })],
      { autoClose: false, closeOnKill: true }
    );
    spawnMock.mockReturnValueOnce(proc);

    const gen = runCursor('x', { cwd: '/proj' });
    await gen.next();

    await abortCursorSession('provider-1');
    expect(proc.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await gen.return();
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    vi.useFakeTimers();
    try {
      const proc = fakeProc(
        [JSON.stringify({ type: 'system', subtype: 'init', session_id: 'stuck' })],
        { autoClose: false }
      );
      proc.kill.mockImplementation((signal: NodeJS.Signals) => {
        proc.killed = true;
        if (signal === 'SIGKILL') {
          setTimeout(() => proc.emitClose(null, 'SIGKILL'), 100);
        }
        return true;
      });
      spawnMock.mockReturnValueOnce(proc);

      const gen = runCursor('x', { cwd: '/proj', sessionId: 'stuck' });
      await gen.next();

      const abortPromise = abortCursorSession('stuck');
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(500);
      expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      let settled = false;
      void abortPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await abortPromise;
      expect(settled).toBe(true);
      await gen.return();
    } finally {
      vi.useRealTimers();
    }
  });
});
