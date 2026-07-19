import { spawn } from 'child_process';
import { createInterface } from 'readline';
import type { ProviderRuntimeEvent } from '@zclaudia/plugin-sdk/providers';
import { mapCursorEvent } from './map-events.js';
import { injectCursorMcpBridge, type CursorMcpBridge } from './mcp-inject.js';
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

export async function* runCursor(
  input: string,
  options: CursorRunOptions
): AsyncGenerator<ProviderRuntimeEvent, void, void> {
  let promptText = input;

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

  // Inject MCP bridge
  if (options.bridge) {
    const result = injectCursorMcpBridge(options.cwd, options.bridge);
    if (!result.ok) {
      console.error(`[Cursor SDK] Failed to inject MCP bridge: ${result.reason}`);
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
    yield { type: 'error', error: `Failed to start cursor-agent: ${msg}` };
    return;
  }

  // Register process for abort
  if (options.sessionId) {
    activeProcesses.set(options.sessionId, proc);
  }

  // Handle abort signal
  if (options.abortController) {
    options.abortController.signal.addEventListener('abort', () => {
      proc.kill('SIGTERM');
    });
  }

  // Capture spawn errors (e.g. ENOENT)
  let spawnError: Error | null = null;
  proc.on('error', err => {
    spawnError = err;
  });

  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

  // Collect stderr error messages
  const stderrErrors: string[] = [];
  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('I:') || trimmed.startsWith('E:') || trimmed.startsWith('W:')) {
          stderrErrors.push(trimmed);
        }
      }
    }
  });

  let inThinkBlock = false;
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

      const mapped = mapCursorEvent(event, inThinkBlock);
      inThinkBlock = mapped.inThinkBlock;

      for (const ev of mapped.events) {
        if (ev.type === 'assistant' || ev.type === 'tool_use' || ev.type === 'result') {
          hasUsefulOutput = true;
        }

        // Handle session ID from init event
        if (ev.type === 'init' && ev.sessionId) {
          currentSessionId = ev.sessionId;
          if (options.onSessionId) {
            options.onSessionId(ev.sessionId);
          }
          // Re-key activeProcesses if needed
          if (options.sessionId && ev.sessionId !== options.sessionId) {
            activeProcesses.delete(options.sessionId);
            activeProcesses.set(ev.sessionId, proc);
          }
        }

        yield ev;
      }
    }

    // Close any dangling think block
    if (inThinkBlock) {
      yield { type: 'assistant', content: '</think>' };
    }

    // Check for spawn error after readline closes
    if (spawnError) {
      const err = spawnError as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        yield {
          type: 'error',
          error: `cursor-agent not found. Install it from https://cursor.com/cli`,
        };
      } else {
        yield { type: 'error', error: `cursor-agent error: ${err.message}` };
      }
    }

    // Surface stderr errors if cursor-agent produced no useful output
    if (!hasUsefulOutput && stderrErrors.length > 0) {
      for (const errMsg of stderrErrors) {
        yield { type: 'error', error: errMsg };
      }
    }
  } catch (err: unknown) {
    if (inThinkBlock) {
      yield { type: 'assistant', content: '</think>' };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    yield { type: 'error', error: `Cursor error: ${errorMsg}` };
  } finally {
    rl.close();
    if (currentSessionId) {
      activeProcesses.delete(currentSessionId);
    }
  }
}

export async function abortCursorSession(sessionId: string): Promise<void> {
  const proc = activeProcesses.get(sessionId);
  activeProcesses.delete(sessionId);
  if (proc) {
    proc.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 500));
    if (!proc.killed) {
      proc.kill('SIGKILL');
    }
  }
}
