import { spawn } from 'child_process';
import { createInterface } from 'readline';
import type { ProviderRuntimeEvent } from '@zclaudia/plugin-sdk/providers';
import { mapCursorEvent } from './map-events.js';
import {
  approveCursorMcpServers,
  injectCursorMcpBridge,
  type CursorMcpBridge,
} from './mcp-inject.js';
import { resolveCursorCliFromPath } from './resolve-cli.js';

export interface CursorRunOptions {
  cwd: string;
  sessionId?: string;
  cliPath?: string;
  env?: Record<string, string>;
  model?: string;
  mode?: 'plan' | 'ask';
  systemPrompt?: string;
  serverPort?: number;
  claudiaSessionId?: string;
  abortController?: AbortController;
  bridge?: CursorMcpBridge | null;
  onSessionId?: (id: string) => void;
}

// Track active processes for abort
const activeProcesses = new Map<string, ReturnType<typeof spawn>>();
const processTerminations = new WeakMap<ReturnType<typeof spawn>, Promise<void>>();
const MAX_STDERR_TAIL_LENGTH = 64 * 1024;

interface ProcessCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function appendStderrTail(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString()}`.slice(-MAX_STDERR_TAIL_LENGTH);
}

function formatProcessExitError(completion: ProcessCompletion, stderr: string): string {
  const status =
    completion.code === null
      ? `signal=${completion.signal ?? 'unknown'}`
      : `code=${completion.code}`;
  const details = stderr.trim();
  return `Cursor agent process exited (${status})${details ? `: ${details}` : ''}`;
}

function hasProcessExited(proc: ReturnType<typeof spawn>): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForProcessClose(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (hasProcessExited(proc)) return Promise.resolve(true);

  return new Promise(resolve => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const handleClose = () => finish(true);
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      proc.off('close', handleClose);
      if (timeout) clearTimeout(timeout);
      resolve(closed);
    };

    proc.once('close', handleClose);
    if (hasProcessExited(proc)) {
      finish(true);
      return;
    }
    timeout = setTimeout(() => finish(false), timeoutMs);
  });
}

function terminateCursorProcess(proc: ReturnType<typeof spawn>): Promise<void> {
  const pending = processTerminations.get(proc);
  if (pending) return pending;

  const termination = (async () => {
    if (hasProcessExited(proc)) return;

    const termClosePromise = waitForProcessClose(proc, 500);
    proc.kill('SIGTERM');
    if (await termClosePromise) return;
    if (hasProcessExited(proc)) return;

    const killClosePromise = waitForProcessClose(proc, 500);
    proc.kill('SIGKILL');
    await killClosePromise;
  })().finally(() => {
    processTerminations.delete(proc);
  });
  processTerminations.set(proc, termination);
  return termination;
}

export async function* runCursor(
  input: string,
  options: CursorRunOptions
): AsyncGenerator<ProviderRuntimeEvent, void, void> {
  let promptText = input;
  let cleanupMcpBridge: (() => void) | undefined;

  // Prepend systemPrompt to input
  if (options.systemPrompt) {
    const systemContext = `[System Context]\n${options.systemPrompt}`;
    promptText = `${systemContext}\n\n${promptText}`;
  }

  // Resolve binary
  const binary =
    options.cliPath ||
    resolveCursorCliFromPath(options.env?.PATH || process.env.PATH) ||
    'cursor-agent';

  // Build CLI args
  const args: string[] = ['-p', promptText, '--output-format', 'stream-json', '--trust'];

  if (options.mode === 'plan') {
    args.push('--mode=plan');
  } else if (options.mode === 'ask') {
    args.push('--mode=ask');
  } else {
    // Default mode: add --yolo so bash commands aren't auto-rejected in non-interactive mode
    args.push('--yolo');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  // Session resumption
  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  if (options.abortController?.signal.aborted) return;

  // Inject MCP bridge
  if (options.bridge) {
    const result = injectCursorMcpBridge(options.cwd, options.bridge);
    if (!result.ok) {
      console.error(`[Cursor SDK] Failed to inject MCP bridge: ${result.reason}`);
    } else if (result.injected) {
      cleanupMcpBridge = result.cleanup;
      // cursor-agent skips unapproved mcp.json servers in headless runs.
      await approveCursorMcpServers({
        binary,
        cwd: options.cwd,
        names: result.injectedNames,
      });
    }
  }

  // Spawn process
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cleanupMcpBridge?.();
    yield { type: 'error', error: `Failed to start Cursor agent at ${binary}: ${msg}` };
    return;
  }

  const registeredSessionIds = new Set<string>();
  const registerProcess = (sessionId: string) => {
    activeProcesses.set(sessionId, proc);
    registeredSessionIds.add(sessionId);
  };
  const unregisterProcess = (sessionId: string) => {
    if (activeProcesses.get(sessionId) === proc) {
      activeProcesses.delete(sessionId);
    }
    registeredSessionIds.delete(sessionId);
  };

  if (options.sessionId) registerProcess(options.sessionId);

  // Capture process completion before consuming stdout so a fast exit cannot be missed.
  let spawnError: Error | null = null;
  proc.once('error', err => {
    spawnError = err;
  });
  const completionPromise = new Promise<ProcessCompletion>(resolve => {
    proc.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });

  // Handle abort signal
  const handleAbort = () => {
    void terminateCursorProcess(proc);
  };
  options.abortController?.signal.addEventListener('abort', handleAbort, { once: true });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

  // Keep a bounded tail for failures. `close` fires after stdio closes, so this is
  // complete before the exit status is evaluated.
  let stderrTail = '';
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderrTail = appendStderrTail(stderrTail, chunk);
  });

  let hasUsefulOutput = false;
  let currentSessionId = options.sessionId;

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        // Non-JSON output from cursor-agent is typically a CLI-level error
        const trimmed = line.trim();
        if (trimmed.startsWith('I:') || trimmed.startsWith('E:') || trimmed.startsWith('W:')) {
          yield { type: 'error', error: trimmed };
        }
        continue;
      }

      const mapped = mapCursorEvent(event);

      for (const ev of mapped.events) {
        if (ev.type === 'assistant' || ev.type === 'tool_use' || ev.type === 'result') {
          hasUsefulOutput = true;
        }

        // Handle session ID from init event
        if (ev.type === 'init' && ev.sessionId) {
          if (currentSessionId && currentSessionId !== ev.sessionId) {
            unregisterProcess(currentSessionId);
          }
          currentSessionId = ev.sessionId;
          registerProcess(ev.sessionId);
          if (options.onSessionId) {
            options.onSessionId(ev.sessionId);
          }
        }

        yield ev;
      }
    }

    const completion = await completionPromise;
    if (options.abortController?.signal.aborted) return;

    // Check for spawn error after readline and stderr have closed.
    if (spawnError) {
      const err = spawnError as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        yield {
          type: 'error',
          error:
            `cursor-agent not found at ${binary}: ${err.message}. ` +
            'Install it from https://cursor.com/cli or verify the configured wrapper and interpreter.',
        };
      } else {
        yield { type: 'error', error: `cursor-agent error: ${err.message}` };
      }
      return;
    }

    if (completion.code !== 0 || completion.signal !== null) {
      yield {
        type: 'error',
        error: formatProcessExitError(completion, stderrTail),
      };
      return;
    }

    // Surface stderr errors if cursor-agent produced no useful output
    const stderrErrors = stderrTail
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith('I:') || line.startsWith('E:') || line.startsWith('W:'));
    if (!hasUsefulOutput && stderrErrors.length > 0) {
      for (const errMsg of stderrErrors) {
        yield { type: 'error', error: errMsg };
      }
    }
  } catch (err: unknown) {
    await terminateCursorProcess(proc);
    if (options.abortController?.signal.aborted) return;
    const errorMsg = err instanceof Error ? err.message : String(err);
    yield { type: 'error', error: `Cursor error: ${errorMsg}` };
  } finally {
    rl.close();
    options.abortController?.signal.removeEventListener('abort', handleAbort);
    for (const sessionId of registeredSessionIds) {
      unregisterProcess(sessionId);
    }
    cleanupMcpBridge?.();
  }
}

export async function abortCursorSession(sessionId: string): Promise<void> {
  const proc = activeProcesses.get(sessionId);
  if (!proc) return;
  await terminateCursorProcess(proc);
  if (activeProcesses.get(sessionId) === proc && hasProcessExited(proc)) {
    activeProcesses.delete(sessionId);
  }
}
