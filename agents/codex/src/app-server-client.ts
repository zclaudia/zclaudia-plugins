import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { PermissionCallback, ProviderRuntimeEvent } from '@zclaudia/plugin-sdk/providers';
import { debugLog, type AppServerInputBlock } from './config.js';
import { mapCodexNotification } from './map-events.js';
import { resolveApprovalDecision } from './permissions.js';
import { resolveCodexCli } from './resolve-cli.js';
import {
  type ClientRequestParams,
  type ClientRequestResult,
  type CodexClientRequestMethod,
  type JsonRpcError,
  type RequestId,
  type TokenUsageBreakdown,
  isRecord,
  requireRecord,
  requireString,
} from './app-server-protocol.js';

interface ActiveTurnContext {
  onPermission: PermissionCallback;
  mode: string | undefined;
  turnId?: string;
  abortRequested: boolean;
}

const MAX_STDERR_TAIL_LENGTH = 4096;
// App-server uses one JSON-RPC object per line. Bound both directions so a
// broken or incompatible CLI cannot make this process retain an unbounded
// line (readline only reports the line after allocating it in full).
export const MAX_APP_SERVER_INBOUND_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_APP_SERVER_OUTBOUND_LINE_BYTES = 8 * 1024 * 1024;

export class CodexAppServerClient {
  private process: ChildProcess | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private emitter = new EventEmitter();
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private cliPath: string;
  private env: Record<string, string>;
  private extraArgs: string[];
  private activeTurnContexts = new Map<string, ActiveTurnContext>();
  private stderrTail = '';
  currentMode: string | undefined;

  private processCwd: string | undefined;

  lastActivity: number = Date.now();
  activeTurns = 0;

  constructor(
    cliPath: string | undefined,
    env: Record<string, string>,
    extraArgs: string[] = [],
    options?: { processCwd?: string }
  ) {
    this.cliPath = cliPath || resolveCodexCli() || 'codex';
    this.env = env;
    this.extraArgs = extraArgs;
    this.processCwd = options?.processCwd;
    // Each active turn owns one notification and one exit listener.
    this.emitter.setMaxListeners(0);
  }

  ensureRunning(): Promise<void> {
    if (this.process && !this.process.killed && this.initialized) return Promise.resolve();
    if (this.initializationPromise) return this.initializationPromise;

    const initialization = this.startProcess().finally(() => {
      if (this.initializationPromise === initialization) {
        this.initializationPromise = null;
      }
    });
    this.initializationPromise = initialization;
    return initialization;
  }

  private async startProcess(): Promise<void> {
    const args = ['app-server', '--listen', 'stdio://', ...this.extraArgs];
    debugLog(`[Codex AppServer] Spawning: ${this.cliPath} ${args.join(' ')}`);

    this.requestId = 0;
    this.pendingRequests.clear();
    this.stderrTail = '';
    this.stdoutBuffer = Buffer.alloc(0);
    const child = spawn(this.cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      cwd: this.processCwd,
    });
    this.process = child;

    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(
            new Error(
              'codex CLI not found. Install the Codex CLI and ensure it is on PATH, or set an explicit cliPath.'
            )
          );
        } else {
          reject(new Error(`Failed to start codex app-server: ${err.message}`));
        }
      });
    });

    child.stderr?.on('data', (data: Buffer) => {
      if (this.process !== child) return;
      const text = data.toString();
      this.stderrTail = `${this.stderrTail}${text}`.slice(-MAX_STDERR_TAIL_LENGTH);
      const trimmed = text.trim();
      if (trimmed) debugLog(`[Codex AppServer stderr] ${trimmed}`);
    });

    child.on('exit', (code, signal) => {
      // A deliberate restart can spawn the replacement before the previous
      // child reports exit. Never let that stale event tear down the new one.
      if (this.process !== child) return;
      debugLog(`[Codex AppServer] Process exited: code=${code}, signal=${signal}`);
      const stderr = this.stderrTail.trim();
      const status = code === null ? `signal=${signal ?? 'unknown'}` : `code=${code}`;
      const exitError = new Error(
        `Codex app-server process exited (${status})${stderr ? `: ${stderr}` : ''}`
      );
      this.process = null;
      this.initialized = false;
      for (const [id, { reject }] of this.pendingRequests) {
        reject(exitError);
        this.pendingRequests.delete(id);
      }
      this.emitter.emit('exit', exitError);
    });

    child.stdout?.on('data', data => {
      if (this.process === child) this.handleStdoutData(data as Buffer | string);
    });

    debugLog('[Codex AppServer] Sending initialize...');
    try {
      const initResult = await Promise.race([
        this.sendRequest('initialize', {
          clientInfo: { name: 'zclaudia', version: '1.0.0' },
        }),
        spawnErrorPromise,
      ]);
      this.initialized = true;
      debugLog(`[Codex AppServer] Initialized: ${JSON.stringify(initResult).slice(0, 200)}`);
    } catch (err) {
      debugLog(`[Codex AppServer] Initialize failed: ${err}`);
      this.destroy();
      throw err;
    }
  }

  destroy(): void {
    this.stopProcess(new Error('Codex app-server client was stopped'));
  }

  private stopProcess(error: Error): void {
    const child = this.process;
    this.process = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.initialized = false;
    for (const [id, { reject }] of this.pendingRequests) {
      reject(error);
      this.pendingRequests.delete(id);
    }
    if (this.activeTurns > 0) this.emitter.emit('exit', error);
    if (child && !child.killed) child.kill('SIGTERM');
  }

  updateExtraArgs(newArgs: string[]): void {
    const oldStr = JSON.stringify(this.extraArgs);
    const newStr = JSON.stringify(newArgs);
    if (oldStr !== newStr) {
      debugLog(`[Codex AppServer] ExtraArgs changed, restarting process: ${oldStr} → ${newStr}`);
      this.extraArgs = newArgs;
      this.destroy();
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Codex app-server process not running');
    }
    const line = JSON.stringify(msg);
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > MAX_APP_SERVER_OUTBOUND_LINE_BYTES) {
      throw new Error(
        `Codex app-server request exceeds ${MAX_APP_SERVER_OUTBOUND_LINE_BYTES} bytes (${lineBytes})`
      );
    }
    this.process.stdin.write(line + '\n');
  }

  private failProtocol(message: string): void {
    const failure = new Error(`Codex app-server protocol error: ${message}`);
    debugLog(`[Codex AppServer] ${failure.message}`);
    this.stopProcess(failure);
  }

  private handleStdoutData(data: Buffer | string): void {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let offset = 0;

    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      const nextLength = this.stdoutBuffer.length + segment.length;
      if (nextLength > MAX_APP_SERVER_INBOUND_LINE_BYTES) {
        this.stdoutBuffer = Buffer.alloc(0);
        this.failProtocol(
          `JSON-RPC line exceeds ${MAX_APP_SERVER_INBOUND_LINE_BYTES} bytes (${nextLength}+)`
        );
        return;
      }

      if (newline < 0) {
        this.stdoutBuffer =
          this.stdoutBuffer.length === 0
            ? Buffer.from(segment)
            : Buffer.concat([this.stdoutBuffer, segment], nextLength);
        return;
      }

      const lineBuffer =
        this.stdoutBuffer.length === 0
          ? segment
          : Buffer.concat([this.stdoutBuffer, segment], nextLength);
      this.stdoutBuffer = Buffer.alloc(0);
      let line = lineBuffer.toString('utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.handleLine(line);
      offset = newline + 1;
    }
  }

  private sendRequest<M extends CodexClientRequestMethod>(
    method: M,
    params: ClientRequestParams<M>
  ): Promise<ClientRequestResult<M>> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: value => resolve(value as ClientRequestResult<M>),
        reject,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendResponse(id: RequestId, result: unknown): void {
    this.send({ id, result });
  }

  private sendErrorResponse(id: RequestId, error: JsonRpcError): void {
    this.send({ id, error });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    this.lastActivity = Date.now();

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      debugLog(`[Codex AppServer] WARN: Failed to parse: ${line.slice(0, 200)}`);
      return;
    }
    if (!isRecord(parsed)) {
      debugLog(
        `[Codex AppServer] WARN: Ignored non-object JSON-RPC message: ${line.slice(0, 200)}`
      );
      return;
    }
    const msg = parsed;

    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (method !== 'item/agentMessage/delta' && method !== 'item/reasoning/textDelta') {
      debugLog(`[Codex AppServer] ← ${method || 'response'}: ${line.slice(0, 300)}`);
    }

    const hasId = 'id' in msg;
    const hasMethod = method !== undefined;

    if (hasId && !hasMethod) {
      const responseId = msg.id;
      const pending =
        typeof responseId === 'number' ? this.pendingRequests.get(responseId) : undefined;
      if (pending) {
        this.pendingRequests.delete(responseId as number);
        const responseError = isRecord(msg.error) ? msg.error : undefined;
        if (responseError) {
          pending.reject(
            new Error(
              `JSON-RPC error ${String(responseError.code ?? 'unknown')}: ${String(responseError.message ?? 'Unknown error')}`
            )
          );
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (hasId && hasMethod) {
      this.handleServerRequest(
        msg.id as RequestId,
        method,
        isRecord(msg.params) ? msg.params : undefined
      ).catch(err => {
        console.error(
          `[Codex AppServer] Unhandled error in server request handler (${method}):`,
          err
        );
        try {
          this.sendErrorResponse(msg.id as RequestId, { code: -1, message: String(err) });
        } catch (responseError) {
          debugLog(`[Codex AppServer] Could not send server-request error: ${responseError}`);
        }
      });
    } else if (hasMethod) {
      this.emitter.emit('notification', method, isRecord(msg.params) ? msg.params : {});
    }
  }

  private async handleServerRequest(
    id: RequestId,
    method: string,
    params?: Record<string, unknown>
  ): Promise<void> {
    debugLog(`[Codex AppServer] Server request: ${method}`);
    this.lastActivity = Date.now();
    const context = this.activeTurnContextFor(params);
    const permissionCallback = context?.onPermission ?? null;
    const currentMode = context?.mode ?? this.currentMode;

    if (
      method.includes('requestApproval') ||
      method.includes('Approval') ||
      method.includes('approval')
    ) {
      const result = await resolveApprovalDecision(currentMode, method, params, permissionCallback);
      this.sendResponse(id, result);
      return;
    }

    if (method === 'item/tool/call') {
      debugLog(
        `[Codex AppServer] Dynamic tool call: tool=${params?.tool} callId=${params?.callId}`
      );
      this.sendResponse(id, {
        success: false,
        contentItems: [
          { type: 'inputText', text: 'Dynamic tool calls are not supported by this client.' },
        ],
      });
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      debugLog(`[Codex AppServer] User input request: ${JSON.stringify(params).slice(0, 300)}`);
      this.sendResponse(id, { answers: {} });
      return;
    }

    if (method === 'mcpServer/elicitation/request') {
      debugLog(
        `[Codex AppServer] MCP elicitation: server=${params?.serverName} mode=${params?.mode}`
      );
      this.sendResponse(id, { action: 'decline' });
      return;
    }

    debugLog(`[Codex AppServer] WARN: Unhandled server request: ${method}`);
    this.sendResponse(id, {});
  }

  private activeTurnContextFor(
    params: Record<string, unknown> | undefined
  ): ActiveTurnContext | undefined {
    const threadId = params?.threadId;
    if (typeof threadId === 'string') return this.activeTurnContexts.get(threadId);
    if (this.activeTurnContexts.size === 1) {
      return this.activeTurnContexts.values().next().value;
    }
    return undefined;
  }

  private notificationBelongsToThread(threadId: string, params: Record<string, unknown>): boolean {
    const notificationThreadId = params.threadId;
    if (typeof notificationThreadId === 'string') return notificationThreadId === threadId;
    // Older app-server builds omitted threadId. That is only safe to support
    // when this client has exactly one active turn.
    return this.activeTurnContexts.size === 1;
  }

  async startThread(cwd: string): Promise<string> {
    await this.ensureRunning();
    const result = await this.sendRequest('thread/start', { cwd });
    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error(`thread/start did not return a threadId: ${JSON.stringify(result)}`);
    }
    debugLog(`[Codex AppServer] Thread started: ${threadId}`);
    return threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.ensureRunning();
    await this.sendRequest('thread/resume', { threadId });
    debugLog(`[Codex AppServer] Thread resumed: ${threadId}`);
  }

  async interruptTurn(threadId: string): Promise<void> {
    const context = this.activeTurnContexts.get(threadId);
    if (!context) {
      debugLog(`[Codex AppServer] WARN: no active turn to interrupt for thread ${threadId}`);
      return;
    }
    context.abortRequested = true;
    if (!context.turnId) return;
    try {
      await this.sendRequest('turn/interrupt', { threadId, turnId: context.turnId });
    } catch (error) {
      debugLog(`[Codex AppServer] WARN: turn/interrupt failed: ${error}`);
    }
  }

  private extractErrorMessage(params: Record<string, unknown>, fallback: string): string {
    const turn = params.turn as { error?: { message?: string } } | undefined;
    return (
      turn?.error?.message ||
      (params.error as { message?: string } | undefined)?.message ||
      (params.message as string | undefined) ||
      fallback
    );
  }

  async *runTurn(
    threadId: string,
    input: AppServerInputBlock[],
    onPermission: PermissionCallback,
    options?: { cwd?: string; model?: string; mode?: string; systemPrompt?: string }
  ): AsyncGenerator<ProviderRuntimeEvent, void, void> {
    if (this.activeTurnContexts.has(threadId)) {
      throw new Error(`A Codex turn is already active for thread ${threadId}`);
    }
    this.lastActivity = Date.now();
    this.activeTurns += 1;
    const activeTurnContext: ActiveTurnContext = {
      onPermission,
      mode: options?.mode ?? this.currentMode,
      abortRequested: false,
    };
    this.activeTurnContexts.set(threadId, activeTurnContext);

    try {
      yield {
        type: 'init',
        sessionId: threadId,
        systemInfo: {
          cwd: options?.cwd || '',
          apiKeySource: 'codex-app-server',
          model: options?.model || '',
          mcpServers: [],
          tools: [],
        },
      };

      const turnParams: ClientRequestParams<'turn/start'> = {
        threadId,
        input,
      };
      if (options?.model) {
        turnParams.model = options.model;
      }

      type QueueItem =
        | { type: 'msg'; msg: ProviderRuntimeEvent }
        | { type: 'done' }
        | { type: 'error'; error: Error };
      const queue: QueueItem[] = [];
      let resolve: (() => void) | null = null;

      const enqueue = (item: QueueItem) => {
        queue.push(item);
        if (resolve) {
          resolve();
          resolve = null;
        }
      };

      const waitForItem = (): Promise<void> => {
        if (queue.length > 0) return Promise.resolve();
        return new Promise<void>(r => {
          resolve = r;
        });
      };

      let lastUsage: TokenUsageBreakdown | undefined;
      const onNotification = (method: string, params: Record<string, unknown>) => {
        if (!this.notificationBelongsToThread(threadId, params)) return;
        const notificationTurnId =
          typeof params.turnId === 'string'
            ? params.turnId
            : isRecord(params.turn) && typeof params.turn.id === 'string'
              ? params.turn.id
              : undefined;
        if (
          activeTurnContext.turnId &&
          notificationTurnId &&
          notificationTurnId !== activeTurnContext.turnId
        ) {
          return;
        }
        if (method === 'thread/tokenUsage/updated') {
          const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
          if (tokenUsage && isRecord(tokenUsage.last)) {
            const last = tokenUsage.last;
            const number = (field: keyof TokenUsageBreakdown): number =>
              typeof last[field] === 'number' && Number.isFinite(last[field])
                ? (last[field] as number)
                : 0;
            lastUsage = {
              inputTokens: number('inputTokens'),
              outputTokens: number('outputTokens'),
              cachedInputTokens: number('cachedInputTokens'),
              cacheWriteInputTokens: number('cacheWriteInputTokens'),
              totalTokens: number('totalTokens'),
              reasoningOutputTokens: number('reasoningOutputTokens'),
            };
          }
          return;
        }
        const events = mapCodexNotification(method, params);
        for (const event of events) {
          if (event.type === 'mode_transition' && event.modeTransition?.mode) {
            this.currentMode = event.modeTransition.mode;
            activeTurnContext.mode = event.modeTransition.mode;
          }
          enqueue({ type: 'msg', msg: event });
        }

        if (method === 'turn/completed') {
          const turn = isRecord(params.turn) ? params.turn : undefined;
          const turnStatus =
            typeof turn?.status === 'string'
              ? turn.status
              : typeof params.status === 'string'
                ? params.status
                : undefined;

          if (!turn || !turnStatus) {
            enqueue({
              type: 'msg',
              msg: {
                type: 'provider_error',
                error: 'Codex error: invalid turn/completed notification',
              },
            });
            enqueue({ type: 'done' });
            return;
          }

          if (turnStatus === 'failed') {
            const errorMsg = this.extractErrorMessage(params, 'Turn completed with failed status');
            enqueue({
              type: 'msg',
              msg: { type: 'provider_error', error: `Codex error: ${errorMsg}` },
            });
            enqueue({ type: 'done' });
          } else {
            enqueue({
              type: 'msg',
              msg: {
                type: 'provider_turn_finished',
                isComplete: true,
                usage: lastUsage
                  ? {
                      input: lastUsage.inputTokens || 0,
                      output: lastUsage.outputTokens || 0,
                      cacheRead: lastUsage.cachedInputTokens || 0,
                      cacheWrite: lastUsage.cacheWriteInputTokens || 0,
                      totalTokens: lastUsage.totalTokens || 0,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    }
                  : undefined,
              },
            });
            enqueue({ type: 'done' });
          }
        } else if (method === 'turn/failed') {
          const errorMsg = this.extractErrorMessage(params, 'Turn failed');
          enqueue({
            type: 'msg',
            msg: { type: 'provider_error', error: `Codex error: ${errorMsg}` },
          });
          enqueue({ type: 'done' });
        } else if (method === 'error') {
          const errorMsg = this.extractErrorMessage(params, 'Unknown Codex error');
          enqueue({
            type: 'msg',
            msg: { type: 'provider_error', error: `Codex error: ${errorMsg}` },
          });
        }
      };

      const onExit = (error: Error) => {
        enqueue({ type: 'error', error });
      };

      this.emitter.on('notification', onNotification);
      this.emitter.on('exit', onExit);

      try {
        await this.ensureRunning();
        debugLog(`[Codex AppServer] Sending turn/start for thread: ${threadId}`);
        const turnStart = await this.sendRequest('turn/start', turnParams);
        const turn = requireRecord(turnStart.turn, 'turn/start response turn');
        activeTurnContext.turnId = requireString(turn, 'id', 'turn/start response turn');
        if (activeTurnContext.abortRequested) {
          await this.sendRequest('turn/interrupt', {
            threadId,
            turnId: activeTurnContext.turnId,
          });
        }

        while (true) {
          await waitForItem();
          while (queue.length > 0) {
            const item = queue.shift()!;
            if (item.type === 'done') return;
            if (item.type === 'error') throw item.error;
            yield item.msg;
          }
        }
      } finally {
        this.emitter.off('notification', onNotification);
        this.emitter.off('exit', onExit);
      }
    } finally {
      this.lastActivity = Date.now();
      this.activeTurns = Math.max(0, this.activeTurns - 1);
      if (this.activeTurnContexts.get(threadId) === activeTurnContext) {
        this.activeTurnContexts.delete(threadId);
      }
    }
  }
}
