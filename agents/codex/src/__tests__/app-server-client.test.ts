import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import {
  MAX_APP_SERVER_INBOUND_LINE_BYTES,
  MAX_APP_SERVER_OUTBOUND_LINE_BYTES,
  CodexAppServerClient,
} from '../app-server-client.js';

const spawnMock = vi.mocked(spawn);

type FakeProc = EventEmitter & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
};

function fakeProc(options: {
  lines?: string[];
  stderrLines?: string[];
  onStdin?: (data: string, stdout: Readable) => void;
}): { proc: FakeProc; stdinWrites: string[] } {
  const stdinWrites: string[] = [];
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });

  const proc = new EventEmitter() as FakeProc;
  proc.stdin = new Writable({
    write(chunk, _enc, cb) {
      const data = chunk.toString();
      stdinWrites.push(data);
      options.onStdin?.(data, stdout);
      cb();
    },
  });
  proc.stderr = stderr;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  proc.killed = false;
  proc.stdout = stdout;

  process.nextTick(() => {
    for (const line of options.stderrLines ?? []) {
      stderr.push(line + '\n');
    }
    for (const line of options.lines ?? []) {
      stdout.push(line + '\n');
    }
  });

  return { proc, stdinWrites };
}

describe('CodexAppServerClient', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('spawns app-server with stdio listen and extra args', async () => {
    const { proc } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
    });
    spawnMock.mockReturnValueOnce(proc as never);

    const client = new CodexAppServerClient('/bin/codex', {}, ['-c', 'foo=bar']);
    await client.ensureRunning();

    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/codex',
      ['app-server', '--listen', 'stdio://', '-c', 'foo=bar'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
    client.destroy();
  });

  it('runTurn yields init, assistant_delta, and provider_turn_finished', async () => {
    const { proc } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
      onStdin(data, stdout) {
        for (const line of data.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (msg.method !== 'turn/start') continue;
          stdout.push(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-1' } } }) + '\n');
          stdout.push(
            JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'Hi' },
            }) + '\n'
          );
          stdout.push(
            JSON.stringify({
              method: 'thread/tokenUsage/updated',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                tokenUsage: {
                  total: {},
                  last: {
                    inputTokens: 12,
                    outputTokens: 5,
                    cachedInputTokens: 3,
                    cacheWriteInputTokens: 2,
                    totalTokens: 17,
                    reasoningOutputTokens: 1,
                  },
                },
              },
            }) + '\n'
          );
          stdout.push(
            JSON.stringify({
              method: 'turn/completed',
              params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
            }) + '\n'
          );
        }
      },
    });
    spawnMock.mockReturnValueOnce(proc as never);

    const client = new CodexAppServerClient('/bin/codex', {});
    const events = [];
    for await (const event of client.runTurn(
      'thread-1',
      [{ type: 'text', text: 'hello', text_elements: [] }],
      async () => ({ behavior: 'deny' as const })
    )) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'init' && e.sessionId === 'thread-1')).toBe(true);
    expect(events.some(e => e.type === 'assistant_delta' && e.content === 'Hi')).toBe(true);
    expect(events.some(e => e.type === 'provider_turn_finished' && e.isComplete === true)).toBe(
      true
    );
    expect(events.find(e => e.type === 'provider_turn_finished')).toMatchObject({
      usage: { input: 12, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 17 },
    });
    client.destroy();
  });

  it('emits provider_error and finishes when turn/completed is malformed', async () => {
    const { proc } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
      onStdin(data, stdout) {
        for (const line of data.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (msg.method !== 'turn/start') continue;
          stdout.push(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-1' } } }) + '\n');
          stdout.push(
            JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1' } }) + '\n'
          );
        }
      },
    });
    spawnMock.mockReturnValueOnce(proc as never);

    const client = new CodexAppServerClient('/bin/codex', {});
    const events = [];
    for await (const event of client.runTurn(
      'thread-1',
      [{ type: 'text', text: 'hello', text_elements: [] }],
      async () => ({ behavior: 'deny' as const })
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: 'provider_error',
      error: 'Codex error: invalid turn/completed notification',
    });
    client.destroy();
  });

  it('interrupts the exact turn returned by turn/start', async () => {
    let notifyTurnStart!: () => void;
    const turnStartSent = new Promise<void>(resolve => {
      notifyTurnStart = resolve;
    });
    let interruptParams: Record<string, unknown> | undefined;
    const { proc } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
      onStdin(data, stdout) {
        for (const line of data.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: Record<string, unknown>;
          };
          if (msg.method === 'turn/start') {
            stdout.push(
              JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-exact' } } }) + '\n'
            );
            notifyTurnStart();
          } else if (msg.method === 'turn/interrupt') {
            interruptParams = msg.params;
            stdout.push(JSON.stringify({ id: msg.id, result: {} }) + '\n');
            stdout.push(
              JSON.stringify({
                method: 'turn/completed',
                params: {
                  threadId: 'thread-1',
                  turn: { id: 'turn-exact', status: 'interrupted' },
                },
              }) + '\n'
            );
          }
        }
      },
    });
    spawnMock.mockReturnValueOnce(proc as never);

    const client = new CodexAppServerClient('/bin/codex', {});
    const completion = (async () => {
      for await (const _event of client.runTurn(
        'thread-1',
        [{ type: 'text', text: 'wait', text_elements: [] }],
        async () => ({ behavior: 'deny' as const })
      )) {
        /* drain */
      }
    })();

    await turnStartSent;
    await client.interruptTurn('thread-1');
    await completion;

    expect(interruptParams).toEqual({ threadId: 'thread-1', turnId: 'turn-exact' });
    client.destroy();
  });

  it('waits for one shared initialization when callers start concurrently', async () => {
    let initializeId: number | undefined;
    const { proc } = fakeProc({
      onStdin(data) {
        for (const line of data.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { method?: string; id?: number };
          if (msg.method === 'initialize') initializeId = msg.id;
        }
      },
    });
    spawnMock.mockReturnValueOnce(proc as never);

    const client = new CodexAppServerClient('/bin/codex', {});
    const first = client.ensureRunning();
    let secondResolved = false;
    const second = client.ensureRunning().then(() => {
      secondResolved = true;
    });

    await Promise.resolve();
    expect(secondResolved).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    proc.stdout.push(JSON.stringify({ id: initializeId, result: { capabilities: {} } }) + '\n');
    await Promise.all([first, second]);
    client.destroy();
  });

  it('parses JSON-RPC lines split across stdout chunks', async () => {
    const { proc } = fakeProc({});
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodexAppServerClient('/bin/codex', {});
    const running = client.ensureRunning();

    await Promise.resolve();
    const response = JSON.stringify({ id: 1, result: { capabilities: {} } }) + '\n';
    proc.stdout.push(response.slice(0, 7));
    proc.stdout.push(response.slice(7));

    await expect(running).resolves.toBeUndefined();
    client.destroy();
  });

  it('ignores valid JSON values that are not JSON-RPC objects', async () => {
    const { proc } = fakeProc({
      lines: ['null', JSON.stringify({ id: 1, result: { capabilities: {} } })],
    });
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodexAppServerClient('/bin/codex', {});

    await expect(client.ensureRunning()).resolves.toBeUndefined();
    client.destroy();
  });

  it('terminates app-server when one inbound JSON-RPC line exceeds its byte budget', async () => {
    const { proc } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
    });
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodexAppServerClient('/bin/codex', {});
    await client.ensureRunning();

    proc.stdout.push(Buffer.alloc(MAX_APP_SERVER_INBOUND_LINE_BYTES + 1, 0x61));

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    client.destroy();
  });

  it('rejects an outbound JSON-RPC request that exceeds its byte budget', async () => {
    const { proc } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
    });
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodexAppServerClient('/bin/codex', {});
    const iterator = client.runTurn(
      'thread-1',
      [
        {
          type: 'text',
          text: 'x'.repeat(MAX_APP_SERVER_OUTBOUND_LINE_BYTES),
          text_elements: [],
        },
      ],
      async () => ({ behavior: 'deny' as const })
    );

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'init' } });
    await expect(iterator.next()).rejects.toThrow(/request exceeds .* bytes/i);
    client.destroy();
  });

  it('isolates notifications and approval callbacks between concurrent threads', async () => {
    const startedThreads: string[] = [];
    const { proc, stdinWrites } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
      onStdin(data, stdout) {
        for (const line of data.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: { threadId?: string };
          };
          if (msg.method !== 'turn/start' || !msg.params?.threadId) continue;
          startedThreads.push(msg.params.threadId);
          stdout.push(
            JSON.stringify({
              id: msg.id,
              result: { turn: { id: `turn-${msg.params.threadId}` } },
            }) + '\n'
          );
          if (startedThreads.length !== 2) continue;

          stdout.push(
            JSON.stringify({
              id: 101,
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: 'thread-a',
                turnId: 'turn-thread-a',
                itemId: 'command-a',
                command: 'command-a',
              },
            }) + '\n'
          );
          stdout.push(
            JSON.stringify({
              id: 102,
              method: 'item/commandExecution/requestApproval',
              params: {
                threadId: 'thread-b',
                turnId: 'turn-thread-b',
                itemId: 'command-b',
                command: 'command-b',
              },
            }) + '\n'
          );
          stdout.push(
            JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-b', turnId: 'turn-thread-b', delta: 'from-b' },
            }) + '\n'
          );
          stdout.push(
            JSON.stringify({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-a', turnId: 'turn-thread-a', delta: 'from-a' },
            }) + '\n'
          );
          stdout.push(
            JSON.stringify({
              method: 'turn/completed',
              params: {
                threadId: 'thread-a',
                turn: { id: 'turn-thread-a', status: 'completed' },
              },
            }) + '\n'
          );
          stdout.push(
            JSON.stringify({
              method: 'turn/completed',
              params: {
                threadId: 'thread-b',
                turn: { id: 'turn-thread-b', status: 'completed' },
              },
            }) + '\n'
          );
        }
      },
    });
    spawnMock.mockReturnValueOnce(proc as never);

    const onPermissionA = vi.fn(async () => ({ behavior: 'allow' as const }));
    const onPermissionB = vi.fn(async () => ({ behavior: 'deny' as const }));
    const client = new CodexAppServerClient('/bin/codex', {});
    await client.ensureRunning();

    const eventsA: Array<{ type: string; content?: string }> = [];
    const eventsB: Array<{ type: string; content?: string }> = [];
    await Promise.all([
      (async () => {
        for await (const event of client.runTurn(
          'thread-a',
          [{ type: 'text', text: 'a', text_elements: [] }],
          onPermissionA
        )) {
          eventsA.push(event);
        }
      })(),
      (async () => {
        for await (const event of client.runTurn(
          'thread-b',
          [{ type: 'text', text: 'b', text_elements: [] }],
          onPermissionB
        )) {
          eventsB.push(event);
        }
      })(),
    ]);
    await new Promise(resolve => setImmediate(resolve));

    expect(eventsA).toContainEqual(
      expect.objectContaining({ type: 'assistant_delta', content: 'from-a' })
    );
    expect(eventsA).not.toContainEqual(expect.objectContaining({ content: 'from-b' }));
    expect(eventsB).toContainEqual(
      expect.objectContaining({ type: 'assistant_delta', content: 'from-b' })
    );
    expect(eventsB).not.toContainEqual(expect.objectContaining({ content: 'from-a' }));
    expect(onPermissionA).toHaveBeenCalledWith(
      expect.objectContaining({ toolInput: { command: 'command-a' } })
    );
    expect(onPermissionB).toHaveBeenCalledWith(
      expect.objectContaining({ toolInput: { command: 'command-b' } })
    );

    const responses = stdinWrites
      .flatMap(chunk => chunk.split('\n').filter(Boolean))
      .map(line => JSON.parse(line) as { id?: number; result?: { decision?: string } });
    expect(responses.find(message => message.id === 101)?.result?.decision).toBe('accept');
    expect(responses.find(message => message.id === 102)?.result?.decision).toBe('decline');
    client.destroy();
  });

  it('responds to command approval with accept when callback allows', async () => {
    const approvalLine = JSON.stringify({
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'npm test' },
    });
    const turnCompleted = JSON.stringify({
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });

    const { proc, stdinWrites } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
      onStdin(data, stdout) {
        for (const line of data.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { method?: string; id?: number };
          if (msg.method === 'turn/start') {
            stdout.push(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-1' } } }) + '\n');
            stdout.push(approvalLine + '\n');
            stdout.push(turnCompleted + '\n');
          }
        }
      },
    });
    spawnMock.mockReturnValueOnce(proc as never);

    const onPermission = vi.fn(async () => ({ behavior: 'allow' as const }));
    const client = new CodexAppServerClient('/bin/codex', {});

    for await (const _ of client.runTurn(
      'thread-1',
      [{ type: 'text', text: 'run tests', text_elements: [] }],
      onPermission
    )) {
      /* drain */
    }

    expect(onPermission).toHaveBeenCalled();
    const approvalResponse = stdinWrites
      .flatMap(chunk => chunk.split('\n').filter(Boolean))
      .map(line => JSON.parse(line) as { id?: number; result?: { decision?: string } })
      .find(msg => msg.id === 42);
    expect(approvalResponse).toEqual({ id: 42, result: { decision: 'accept' } });
    client.destroy();
  });

  it('answers requestUserInput with the hardcoded empty answer set', async () => {
    const { proc, stdinWrites } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
      onStdin(data, stdout) {
        for (const line of data.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (msg.method !== 'turn/start') continue;
          stdout.push(JSON.stringify({ id: msg.id, result: { turn: { id: 'turn-1' } } }) + '\n');
          stdout.push(
            JSON.stringify({
              id: 43,
              method: 'item/tool/requestUserInput',
              params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'item-1',
                questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?' }],
              },
            }) + '\n'
          );
          setImmediate(() =>
            stdout.push(
              JSON.stringify({
                method: 'turn/completed',
                params: {
                  threadId: 'thread-1',
                  turn: { id: 'turn-1', status: 'completed' },
                },
              }) + '\n'
            )
          );
        }
      },
    });
    spawnMock.mockReturnValueOnce(proc as never);
    const onPermission = vi.fn(async () => ({ behavior: 'deny' as const }));
    const client = new CodexAppServerClient('/bin/codex', {});

    for await (const _ of client.runTurn(
      'thread-1',
      [{ type: 'text', text: 'choose scope', text_elements: [] }],
      onPermission
    )) {
      /* drain */
    }

    expect(onPermission).not.toHaveBeenCalled();
    const response = stdinWrites
      .flatMap(chunk => chunk.split('\n').filter(Boolean))
      .map(line => JSON.parse(line) as { id?: number; result?: unknown })
      .find(message => message.id === 43);
    expect(response).toEqual({ id: 43, result: { answers: {} } });
    client.destroy();
  });

  it('isolates approval mode across concurrent threads', async () => {
    const requestIds = new Map([
      ['thread-default', 51],
      ['thread-plan', 52],
    ]);
    const { proc, stdinWrites } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
      onStdin(data, stdout) {
        for (const line of data.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: { threadId?: string };
          };
          if (msg.method !== 'turn/start' || !msg.params?.threadId) continue;
          const threadId = msg.params.threadId;
          const turnId = `turn-${threadId}`;
          const requestId = requestIds.get(threadId)!;
          stdout.push(JSON.stringify({ id: msg.id, result: { turn: { id: turnId } } }) + '\n');
          setImmediate(() => {
            stdout.push(
              `${JSON.stringify({
                id: requestId,
                method: 'item/commandExecution/requestApproval',
                params: { threadId, turnId, command: 'npm test' },
              })}\n`
            );
            stdout.push(
              `${JSON.stringify({
                method: 'turn/completed',
                params: { threadId, turn: { id: turnId, status: 'completed' } },
              })}\n`
            );
          });
        }
      },
    });
    spawnMock.mockReturnValueOnce(proc as never);
    const client = new CodexAppServerClient('/bin/codex', {});
    await client.ensureRunning();
    const defaultCallback = vi.fn(async () => ({ behavior: 'allow' as const }));
    const planCallback = vi.fn(async () => ({ behavior: 'allow' as const }));
    const drain = async (events: AsyncGenerator<unknown>) => {
      for await (const _event of events) {
        // drain
      }
    };

    await Promise.all([
      drain(
        client.runTurn(
          'thread-default',
          [{ type: 'text', text: 'implement', text_elements: [] }],
          defaultCallback,
          { mode: 'default' }
        )
      ),
      drain(
        client.runTurn(
          'thread-plan',
          [{ type: 'text', text: 'plan', text_elements: [] }],
          planCallback,
          { mode: 'plan' }
        )
      ),
    ]);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(defaultCallback).toHaveBeenCalledTimes(1);
    expect(planCallback).not.toHaveBeenCalled();
    const responses = stdinWrites
      .flatMap(chunk => chunk.split('\n').filter(Boolean))
      .map(line => JSON.parse(line) as { id?: number; result?: { decision?: string } });
    expect(responses).toContainEqual({ id: 51, result: { decision: 'accept' } });
    expect(responses).toContainEqual({ id: 52, result: { decision: 'decline' } });
    client.destroy();
  });

  it('throws clear error when spawn emits ENOENT', async () => {
    const { proc } = fakeProc({ lines: [] });
    spawnMock.mockReturnValueOnce(proc as never);

    const client = new CodexAppServerClient('codex', {});
    const ensurePromise = client.ensureRunning();

    process.nextTick(() => {
      const err = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      proc.emit('error', err);
    });

    await expect(ensurePromise).rejects.toThrow(/codex CLI not found/i);
    client.destroy();
  });

  it('includes stderr when app-server exits during initialization', async () => {
    const { proc } = fakeProc({
      stderrLines: ['/home/user/.local/bin/zcodex: line 2: exec: codex: not found'],
    });
    spawnMock.mockReturnValueOnce(proc as never);

    const client = new CodexAppServerClient('/home/user/.local/bin/zcodex', {});
    const ensurePromise = client.ensureRunning();

    process.nextTick(() => {
      proc.emit('exit', 127, null);
    });

    await expect(ensurePromise).rejects.toThrow(
      'Codex app-server process exited (code=127): /home/user/.local/bin/zcodex: line 2: exec: codex: not found'
    );
    client.destroy();
  });

  it('restarts process when updateExtraArgs changes', async () => {
    const initResponse = JSON.stringify({ id: 1, result: { capabilities: {} } });
    const { proc: proc1 } = fakeProc({ lines: [initResponse] });
    const { proc: proc2 } = fakeProc({ lines: [initResponse] });
    spawnMock.mockReturnValueOnce(proc1 as never).mockReturnValueOnce(proc2 as never);

    const client = new CodexAppServerClient('/bin/codex', {}, ['-c', 'old=1']);
    await client.ensureRunning();
    expect(proc1.kill).not.toHaveBeenCalled();

    client.updateExtraArgs(['-c', 'new=2']);
    expect(proc1.kill).toHaveBeenCalled();

    await client.ensureRunning();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][1]).toContain('new=2');

    proc1.emit('exit', 0, null);
    await client.ensureRunning();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    client.destroy();
  });
});
