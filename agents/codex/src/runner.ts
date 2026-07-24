import type { PermissionCallback, ProviderRuntimeEvent } from '@zclaudia/plugin-sdk/providers';
import type { ProviderToolBridgeEntry } from '@zclaudia/plugin-sdk/providers';
import { createHash } from 'node:crypto';
import { CodexAppServerClient } from './app-server-client.js';
import {
  buildEnv,
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
  return cwd.replace(/[\\/]+$/, '');
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
  const envPayload = JSON.stringify(
    Object.keys(env)
      .sort()
      .map(key => [key, env[key]])
  );
  const envSignature = createHash('sha256').update(envPayload).digest('hex');
  return `${options.cliPath || '__default__'}::${configSignature}::${envSignature}`;
}

export function getOrCreateAppServerClient(options: CodexRunOptions): CodexAppServerClient {
  const env = buildEnv(options);
  const modeArgs = mapModeToConfigArgs(options.mode);
  const modelArgs = options.model ? ['-c', `model="${options.model}"`] : [];
  const extraArgs = [...modeArgs, ...modelArgs];
  const { configDir, configSignature } = writeMcpConfig(options.bridge ?? null);
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
const sessionClientMap = new Map<string, CodexAppServerClient>();

function registerSessionClient(sessionKey: string | undefined, client: CodexAppServerClient): void {
  if (sessionKey) {
    sessionClientMap.set(sessionKey, client);
  }
}

export async function* runCodexAppServer(
  input: string,
  options: CodexRunOptions,
  onPermission: PermissionCallback
): AsyncGenerator<ProviderRuntimeEvent, void, void> {
  const client = getOrCreateAppServerClient(options);
  client.currentMode = options.mode;

  registerSessionClient(options.claudiaSessionId, client);
  registerSessionClient(options.sessionId, client);

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

  registerSessionClient(threadId, client);
  activeThreadIds.set(threadId, { client, threadId });

  try {
    let inputBlocks = prepareAppServerInput(input);

    if (options.systemPrompt && !options.sessionId) {
      const systemContext = `[System Context]\n${options.systemPrompt}`;
      const firstText = inputBlocks.find(b => b.type === 'text');
      if (firstText && firstText.text) {
        firstText.text = `${systemContext}\n\n${firstText.text}`;
      } else {
        inputBlocks = [{ type: 'text', text: systemContext }, ...inputBlocks];
      }
    }

    let encounteredError: string | null = null;
    const buffered: ProviderRuntimeEvent[] = [];
    let streamingMode = !isResumed;

    for await (const msg of client.runTurn(threadId, inputBlocks, onPermission, {
      cwd: options.cwd,
      model: options.model,
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
      registerSessionClient(freshThreadId, client);
      debugLog(`[Codex AppServer] Recovery: new threadId=${freshThreadId}`);

      inputBlocks = prepareAppServerInput(input);

      yield* client.runTurn(freshThreadId, inputBlocks, onPermission, {
        cwd: options.cwd,
        model: options.model,
        systemPrompt: options.systemPrompt,
      });
    }
  } finally {
    activeThreadIds.delete(threadId);
  }
}

// ── Abort ────────────────────────────────────────────────────

function deleteSessionClientRefs(client: CodexAppServerClient): void {
  for (const [sessionId, mappedClient] of sessionClientMap) {
    if (mappedClient === client) {
      sessionClientMap.delete(sessionId);
    }
  }
}

export async function abortCodexSession(sessionId: string): Promise<void> {
  const entry = activeThreadIds.get(sessionId);
  if (entry) {
    await entry.client.interruptTurn(entry.threadId);
    activeThreadIds.delete(sessionId);
  }
  sessionClientMap.delete(sessionId);
}

export function setCodexSessionMode(sessionId: string, mode: string): void {
  const client = sessionClientMap.get(sessionId);
  if (client) {
    client.currentMode = mode;
    debugLog(`[Codex AppServer] Dynamic mode change for session ${sessionId}: ${mode}`);
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
      deleteSessionClientRefs(client);
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
  sessionClientMap.clear();
  threadCwds.clear();
  activeThreadIds.clear();
  clearInterval(cleanupTimer);
}

export function resetCodexRunnerForTests(): void {
  appServerClients.clear();
  sessionClientMap.clear();
  threadCwds.clear();
  activeThreadIds.clear();
}
