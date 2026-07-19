import { EventEmitter } from 'events';
import { Readable } from 'stream';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

// Mock mcp-inject so tests do not touch real FS
vi.mock('../mcp-inject.js', () => ({
  injectCursorMcpBridge: vi.fn(() => ({ ok: true })),
}));

// Mock resolve-cli to avoid PATH resolution in tests
vi.mock('../resolve-cli.js', () => ({
  resolveCursorCliFromPath: vi.fn(() => undefined),
}));

import { spawn } from 'child_process';
import { abortCursorSession, runCursor } from '../runner.js';
import { injectCursorMcpBridge } from '../mcp-inject.js';

const spawnMock = vi.mocked(spawn);

function fakeProc(lines: string[]) {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
  };
  proc.stdout = Readable.from(lines.map(l => l + '\n'));
  proc.stderr = Readable.from([]);
  proc.kill = vi.fn(() => {
    proc.killed = true;
    return true;
  });
  proc.killed = false;
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
    const proc = fakeProc([]);
    spawnMock.mockReturnValueOnce(proc);

    // Emit error immediately on next tick, before readline can finish
    process.nextTick(() => {
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
      proc.emit('error', err);
    });

    // Push null after a short delay to close stdout
    setTimeout(() => {
      proc.stdout.push(null);
    }, 10);

    const events = [];
    for await (const e of runCursor('x', { cwd: '/proj' })) events.push(e);

    expect(
      events.some(e => e.type === 'error' && String(e.error).includes('cursor-agent not found'))
    ).toBe(true);
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
    const proc = fakeProc([JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' })]);
    spawnMock.mockReturnValueOnce(proc);

    const gen = runCursor('x', { cwd: '/proj', sessionId: 's1' });
    await gen.next();

    await abortCursorSession('s1');
    expect(proc.kill).toHaveBeenCalled();
  });
});
