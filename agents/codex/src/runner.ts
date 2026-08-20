import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { PermissionCallback, ProviderRuntimeEvent } from '@zclaudia/plugin-sdk/providers';
import type { ProviderToolBridgeEntry } from '@zclaudia/plugin-sdk/providers';
import { CodexAppServerClient } from './app-server-client.js';
import {
  buildEnv,
  buildMcpConfigArgs,
  debugLog,
  mapModeToConfigArgs,
  prepareAppServerInput,
  writeMcpConfig,
} from './config.js';

export interface CodexRunOptions {
  cwd: string;
  sessionId?: string;
  cliPath?: string;
  env?: Record<string, string>;
  model?: string;
  mode?: string;
  systemPrompt?: string;
  claudiaSessionId?: string;
  bridge?: ProviderToolBridgeEntry | null;
}

// ── Client cache ─────────────────────────────────────────────

const appServerClients = new Map<string, CodexAppServerClient>();
const threadCwds = new Map<string, string>();

function normalizeCwdForCompare(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isLikelyManagedWorktree(cwd: string): boolean {
  return /(^|[/\\])\.worktrees([/\\]|$)/.test(cwd);
}

function rememberThreadCwd(threadId: string, cwd: string): void {
  threadCwds.set(threadId, normalizeCwdForCompare(cwd));
}

function canResumeThreadInCwd(threadId: string, cwd: string): boolean {
  const normalizedCwd = normalizeCwdForCompare(cwd);
  const knownCwd = threadCwds.get(threadId);
  if (knownCwd) return knownCwd === normalizedCwd;

  // Codex app-server binds cwd at thread/start and thread/resume cannot
  // override it. If this is a managed worktree and we lost the in-memory cwd
  // record (for example after server restart), prefer a fresh thread over
  // risking writes in the main checkout.
  return !isLikelyManagedWorktree(normalizedCwd);
}

export function getCacheKey(
  options: CodexRunOptions,
  env: Record<string, string>,
  configSignature = ''
): string {
  const cacheInputs = JSON.stringify({
    cliPath: options.cliPath || '__default__',
    configSignature,
    env: Object.keys(env)
      .sort()
      .map(key => [key, env[key]]),
  });
  return createHash('sha256').update(cacheInputs).digest('hex');
}

export function getOrCreateAppServerClient(options: CodexRunOptions): CodexAppServerClient {
  const env = buildEnv(options);
  const modeArgs = mapModeToConfigArgs(options.mode);
  const { configDir, configSignature } = writeMcpConfig(options.bridge ?? null);
  const mcpArgs = buildMcpConfigArgs(options.bridge ?? null);
  // Model is supplied to turn/start below. Keeping it out of process-level
  // args lets a loaded thread change models without restarting its writer.
  const extraArgs = [...modeArgs, ...mcpArgs];
  const key = getCacheKey(options, env, configSignature);
  let client = appServerClients.get(key);
  if (!client) {
    client = new CodexAppServerClient(options.cliPath, env, extraArgs, {
      processCwd: options.bridge ? configDir : options.cwd,
    });
    appServerClients.set(key, client);
  } else {
    client.updateExtraArgs(extraArgs);
  }
  client.currentMode = options.mode;
  return client;
}

// ── Main run function ────────────────────────────────────────

const SESSION_RECOVERY_PATTERNS = [
  /invalid.*image_url/i,
  /invalid.*url/i,
  /systemError/i,
  /session.*corrupt/i,
  /thread.*not.*found/i,
  /invalid.*input/i,
];

function isRecoverableSessionError(error: string): boolean {
  return SESSION_RECOVERY_PATTERNS.some(p => p.test(error));
}

function isProviderError(msg: ProviderRuntimeEvent): boolean {
  return msg.type === 'provider_error' || msg.type === 'error';
}

function isContentMessage(msg: ProviderRuntimeEvent): boolean {
  return (
    msg.type === 'assistant_delta' ||
    msg.type === 'assistant' ||
    msg.type === 'tool_started' ||
    msg.type === 'tool_use' ||
    msg.type === 'tool_finished' ||
    msg.type === 'tool_result' ||
    msg.type === 'tool_activity'
  );
}

function isTurnComplete(msg: ProviderRuntimeEvent): boolean {
  return (
    (msg.type === 'provider_turn_finished' || msg.type === 'result') && msg.isComplete === true
  );
}

const activeThreadIds = new Map<string, { client: CodexAppServerClient; threadId: string }>();

export async function* runCodexAppServer(
  input: string,
  options: CodexRunOptions,
  onPermission: PermissionCallback
): AsyncGenerator<ProviderRuntimeEvent, void, void> {
  const client = getOrCreateAppServerClient(options);

  let threadId: string;
  let isResumed = false;
  debugLog(
    `[Codex AppServer] runCodexAppServer: sessionId=${options.sessionId || 'NEW'}, cwd=${options.cwd}`
  );

  if (options.sessionId) {
    if (canResumeThreadInCwd(options.sessionId, options.cwd)) {
      try {
        debugLog(`[Codex AppServer] Resuming thread: ${options.sessionId}`);
        await client.resumeThread(options.sessionId);
        rememberThreadCwd(options.sessionId, options.cwd);
        threadId = options.sessionId;
        isResumed = true;
      } catch (err) {
        debugLog(`[Codex AppServer] WARN: Resume failed, starting fresh: ${err}`);
        threadId = await client.startThread(options.cwd);
        rememberThreadCwd(threadId, options.cwd);
      }
    } else {
      debugLog(
        `[Codex AppServer] Skipping resume for cwd-bound thread ${options.sessionId}; starting fresh in ${options.cwd}`
      );
      threadId = await client.startThread(options.cwd);
      rememberThreadCwd(threadId, options.cwd);
    }
  } else {
    threadId = await client.startThread(options.cwd);
    rememberThreadCwd(threadId, options.cwd);
  }
  debugLog(`[Codex AppServer] Using threadId: ${threadId}`);

  activeThreadIds.set(threadId, { client, threadId });

  try {
    let inputBlocks = prepareAppServerInput(input);

    if (options.systemPrompt && !options.sessionId) {
      const systemContext = `[System Context]\n${options.systemPrompt}`;
      const firstText = inputBlocks.find(b => b.type === 'text');
      if (firstText && firstText.text) {
        firstText.text = `${systemContext}\n\n${firstText.text}`;
      } else {
        inputBlocks = [{ type: 'text', text: systemContext, text_elements: [] }, ...inputBlocks];
      }
    }

    let encounteredError: string | null = null;
    const buffered: ProviderRuntimeEvent[] = [];
    let streamingMode = !isResumed;

    for await (const msg of client.runTurn(threadId, inputBlocks, onPermission, {
      cwd: options.cwd,
      model: options.model,
      mode: options.mode,
      systemPrompt: options.systemPrompt,
    })) {
      if (isProviderError(msg) && !streamingMode && isRecoverableSessionError(msg.error || '')) {
        encounteredError = msg.error || 'Unknown session error';
        break;
      }

      if (streamingMode) {
        yield msg;
        if (isTurnComplete(msg)) {
          return;
        }
      } else {
        buffered.push(msg);
        if (isContentMessage(msg) || isTurnComplete(msg)) {
          streamingMode = true;
          for (const m of buffered) yield m;
          buffered.length = 0;
          if (isTurnComplete(msg)) {
            return;
          }
        }
      }
    }

    if (!encounteredError && buffered.length > 0) {
      for (const m of buffered) yield m;
    }

    if (encounteredError && isResumed) {
      console.warn(
        `[Codex AppServer] Recovered from broken session ${threadId}: ${encounteredError}. Starting fresh thread.`
      );
      yield {
        type: 'assistant_delta',
        content: `[Session recovery: previous thread failed (${encounteredError}), starting fresh]`,
      };

      const freshThreadId = await client.startThread(options.cwd);
      rememberThreadCwd(freshThreadId, options.cwd);
      debugLog(`[Codex AppServer] Recovery: new threadId=${freshThreadId}`);
      activeThreadIds.delete(threadId);
      threadId = freshThreadId;
      activeThreadIds.set(threadId, { client, threadId });

      inputBlocks = prepareAppServerInput(input);

      yield* client.runTurn(freshThreadId, inputBlocks, onPermission, {
        cwd: options.cwd,
        model: options.model,
        mode: options.mode,
        systemPrompt: options.systemPrompt,
      });
    }
  } finally {
    activeThreadIds.delete(threadId);
  }
}

// ── Abort ────────────────────────────────────────────────────

export async function abortCodexSession(sessionId: string): Promise<void> {
  const entry = activeThreadIds.get(sessionId);
  if (entry) {
    await entry.client.interruptTurn(entry.threadId);
    activeThreadIds.delete(sessionId);
  }
}

// ── Idle cleanup ─────────────────────────────────────────────

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export function runIdleCleanup(now = Date.now()): void {
  for (const [key, client] of appServerClients) {
    if (client.activeTurns > 0) continue;
    if (now - client.lastActivity > IDLE_TIMEOUT_MS) {
      debugLog(`[Codex AppServer] Idle cleanup: ${key}`);
      client.destroy();
      appServerClients.delete(key);
    }
  }
}

const cleanupTimer = setInterval(() => {
  runIdleCleanup();
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

export function destroyAllCodexClients(): void {
  for (const [key, client] of appServerClients) {
    debugLog(`[Codex AppServer] Shutdown cleanup: ${key}`);
    client.destroy();
  }
  appServerClients.clear();
  threadCwds.clear();
  activeThreadIds.clear();
  clearInterval(cleanupTimer);
}

export function resetCodexRunnerForTests(): void {
  appServerClients.clear();
  threadCwds.clear();
  activeThreadIds.clear();
}
