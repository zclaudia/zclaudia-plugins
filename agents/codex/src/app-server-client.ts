import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { EventEmitter } from 'events';
import type { PermissionCallback, ProviderRuntimeEvent } from '@zclaudia/plugin-sdk/providers';
import { debugLog, type AppServerInputBlock } from './config.js';
import { mapCodexNotification, type MapEventState } from './map-events.js';
import { resolveApprovalDecision } from './permissions.js';
import { resolveCodexCli } from './resolve-cli.js';

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class CodexAppServerClient {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
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
  private cliPath: string;
  private env: Record<string, string>;
  private extraArgs: string[];
  private permissionCallback: PermissionCallback | null = null;
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
  }

  async ensureRunning(): Promise<void> {
    if (this.process && !this.process.killed) return;

    const args = ['app-server', '--listen', 'stdio://', ...this.extraArgs];
    debugLog(`[Codex AppServer] Spawning: ${this.cliPath} ${args.join(' ')}`);

    this.requestId = 0;
    this.pendingRequests.clear();
    this.process = spawn(this.cliPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
      cwd: this.processCwd,
    });

    const spawnErrorPromise = new Promise<never>((_, reject) => {
      this.process!.once('error', (err: NodeJS.ErrnoException) => {
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

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) debugLog(`[Codex AppServer stderr] ${text}`);
    });

    this.process.on('exit', (code, signal) => {
      debugLog(`[Codex AppServer] Process exited: code=${code}, signal=${signal}`);
      this.process = null;
      this.initialized = false;
      for (const [id, { reject }] of this.pendingRequests) {
        reject(new Error(`Codex app-server process exited (code=${code})`));
        this.pendingRequests.delete(id);
      }
      this.emitter.emit('exit', code);
    });

    this.readline = createInterface({ input: this.process.stdout!, crlfDelay: Infinity });
    this.readline.on('line', line => this.handleLine(line));

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
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }
    this.readline?.close();
    this.process = null;
    this.initialized = false;
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
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  private sendResponse(id: number, result: unknown): void {
    this.send({ id, result });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    this.lastActivity = Date.now();

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      debugLog(`[Codex AppServer] WARN: Failed to parse: ${line.slice(0, 200)}`);
      return;
    }

    const method = msg.method as string | undefined;
    if (method !== 'item/agentMessage/delta' && method !== 'item/reasoning/textDelta') {
      debugLog(`[Codex AppServer] ← ${method || 'response'}: ${JSON.stringify(msg).slice(0, 300)}`);
    }

    const hasId = 'id' in msg;
    const hasMethod = 'method' in msg;

    if (hasId && !hasMethod) {
      const resp = msg as unknown as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(`JSON-RPC error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
    } else if (hasId && hasMethod) {
      this.handleServerRequest(
        msg.id as number,
        msg.method as string,
        msg.params as Record<string, unknown> | undefined
      ).catch(err => {
        console.error(
          `[Codex AppServer] Unhandled error in server request handler (${msg.method}):`,
          err
        );
        this.sendResponse(msg.id as number, { error: { code: -1, message: String(err) } });
      });
    } else if (hasMethod) {
      this.emitter.emit('notification', msg.method, msg.params || {});
    }
  }

  private async handleServerRequest(
    id: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<void> {
    debugLog(`[Codex AppServer] Server request: ${method}`);
    this.lastActivity = Date.now();

    if (
      method.includes('requestApproval') ||
      method.includes('Approval') ||
      method.includes('approval')
    ) {
      const result = await resolveApprovalDecision(
        this.currentMode,
        method,
        params,
        this.permissionCallback
      );
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

  async startThread(cwd: string): Promise<string> {
    await this.ensureRunning();
    const result = (await this.sendRequest('thread/start', { cwd })) as Record<string, unknown>;
    const thread = result?.thread as Record<string, unknown>;
    const threadId = (thread?.id as string) || (result?.threadId as string);
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
    try {
      await this.sendRequest('turn/interrupt', { threadId });
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
    options?: { cwd?: string; model?: string; systemPrompt?: string }
  ): AsyncGenerator<ProviderRuntimeEvent, void, void> {
    this.lastActivity = Date.now();
    this.activeTurns += 1;
    this.permissionCallback = onPermission;

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

    const turnParams: Record<string, unknown> = {
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
    const mapState: MapEventState = { inReasoningBlock: false };

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

    const onNotification = (method: string, params: Record<string, unknown>) => {
      const events = mapCodexNotification(method, params, mapState);
      for (const event of events) {
        enqueue({ type: 'msg', msg: event });
      }

      if (method === 'turn/completed') {
        const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
        const turnStatus = turn?.status || (params as { status?: string }).status;

        if (turnStatus === 'failed') {
          const errorMsg = this.extractErrorMessage(params, 'Turn completed with failed status');
          enqueue({
            type: 'msg',
            msg: { type: 'provider_error', error: `Codex error: ${errorMsg}` },
          });
          enqueue({ type: 'done' });
        } else {
          const usage = params.usage as
            { input_tokens?: number; output_tokens?: number } | undefined;
          enqueue({
            type: 'msg',
            msg: {
              type: 'provider_turn_finished',
              isComplete: true,
              usage: usage
                ? {
                    input: usage.input_tokens || 0,
                    output: usage.output_tokens || 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
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

    const onExit = () => {
      enqueue({ type: 'error', error: new Error('Codex app-server process exited') });
    };

    this.emitter.on('notification', onNotification);
    this.emitter.on('exit', onExit);

    try {
      await this.ensureRunning();
      debugLog(`[Codex AppServer] Sending turn/start for thread: ${threadId}`);
      this.sendRequest('turn/start', turnParams).catch(err => {
        enqueue({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      });

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
      this.lastActivity = Date.now();
      this.activeTurns = Math.max(0, this.activeTurns - 1);
      this.emitter.off('notification', onNotification);
      this.emitter.off('exit', onExit);
    }
  }
}
