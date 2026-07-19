import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { CodexAppServerClient } from '../app-server-client.js';

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
  onStdin?: (data: string, stdout: Readable) => void;
}): { proc: FakeProc; stdinWrites: string[] } {
  const stdinWrites: string[] = [];
  const stdout = new Readable({ read() {} });

  const proc = new EventEmitter() as FakeProc;
  proc.stdin = new Writable({
    write(chunk, _enc, cb) {
      const data = chunk.toString();
      stdinWrites.push(data);
      options.onStdin?.(data, stdout);
      cb();
    },
  });
  proc.stderr = Readable.from([]);
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  proc.killed = false;
  proc.stdout = stdout;

  process.nextTick(() => {
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
    const lines = [
      JSON.stringify({ id: 1, result: { capabilities: {} } }),
      JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'Hi' } }),
      JSON.stringify({ method: 'turn/completed', params: { turn: { status: 'completed' } } }),
    ];
    const { proc } = fakeProc({ lines });
    spawnMock.mockReturnValueOnce(proc as never);

    const client = new CodexAppServerClient('/bin/codex', {});
    const events = [];
    for await (const event of client.runTurn(
      'thread-1',
      [{ type: 'text', text: 'hello' }],
      async () => ({ behavior: 'deny' as const })
    )) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'init' && e.sessionId === 'thread-1')).toBe(true);
    expect(events.some(e => e.type === 'assistant_delta' && e.content === 'Hi')).toBe(true);
    expect(events.some(e => e.type === 'provider_turn_finished' && e.isComplete === true)).toBe(
      true
    );
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
      params: { turn: { status: 'completed' } },
    });

    const { proc, stdinWrites } = fakeProc({
      lines: [JSON.stringify({ id: 1, result: { capabilities: {} } })],
      onStdin(data, stdout) {
        for (const line of data.split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { method?: string; id?: number };
          if (msg.method === 'turn/start') {
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
      [{ type: 'text', text: 'run tests' }],
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
    client.destroy();
  });
});
