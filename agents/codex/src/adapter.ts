import type {
  ExternalAgentAdapter,
  ExternalAgentRunContext,
  ExternalAgentRunState,
  PermissionCallback,
  ProviderRuntimeEvent,
  ProviderToolBridgeEntry,
  ProviderToolBridgeRequest,
} from '@zclaudia/plugin-sdk/providers';
import { runCodexAppServer, abortCodexSession, setCodexSessionMode } from './runner.js';

export type ToolBridgeFactory = (
  req: ProviderToolBridgeRequest
) => Promise<ProviderToolBridgeEntry | null>;

export class CodexAgentAdapter implements ExternalAgentAdapter {
  readonly type = 'codex';
  private readonly sessionModes = new Map<string, string>();
  private readonly providerToClaudiaSessionId = new Map<string, string>();
  private readonly runStates = new WeakMap<ExternalAgentRunContext, ExternalAgentRunState>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(private readonly createToolBridge: ToolBridgeFactory) {}

  async *run(
    input: string,
    context: ExternalAgentRunContext,
    onPermission?: PermissionCallback
  ): AsyncGenerator<ProviderRuntimeEvent, void, void> {
    const claudiaSessionId = context.claudiaSessionId ?? context.sessionId ?? '';
    const sessionKey = claudiaSessionId;
    const effectiveMode = (sessionKey && this.sessionModes.get(sessionKey)) ?? context.mode;

    const bridge = await this.createToolBridge({
      serverPort: context.serverPort,
      sessionId: context.claudiaSessionId,
    });

    const abortController = context.abortController ?? new AbortController();
    if (sessionKey) {
      this.abortControllers.set(sessionKey, abortController);
    }

    this.runStates.set(context, { providerSessionId: context.sessionId, providerCwd: context.cwd });
    let currentKey = sessionKey;
    const registeredProviderIds: string[] = [];

    try {
      for await (const event of runCodexAppServer(
        input,
        {
          cwd: context.cwd,
          sessionId: context.sessionId,
          cliPath: context.cliPath,
          env: context.env,
          model: context.model,
          mode: effectiveMode,
          systemPrompt: context.systemPrompt,
          claudiaSessionId: context.claudiaSessionId,
          bridge,
        },
        onPermission ?? (async () => ({ behavior: 'deny' }))
      )) {
        if (event.type === 'init' && event.sessionId) {
          const id = event.sessionId;
          if (id && claudiaSessionId) {
            this.providerToClaudiaSessionId.set(id, claudiaSessionId);
            registeredProviderIds.push(id);
          }
          if (id && id !== currentKey) {
            this.abortControllers.delete(currentKey);
            currentKey = id;
            this.abortControllers.set(currentKey, abortController);
          }
          this.runStates.set(context, { providerSessionId: id, providerCwd: context.cwd });
        }
        yield event;
      }
    } finally {
      if (currentKey) {
        this.abortControllers.delete(currentKey);
      }
      for (const id of registeredProviderIds) {
        this.providerToClaudiaSessionId.delete(id);
      }
    }
  }

  getRunState(context: ExternalAgentRunContext): ExternalAgentRunState {
    return this.runStates.get(context) ?? { providerCwd: context.cwd };
  }

  setSessionMode(sessionId: string, mode: string): void {
    if (!sessionId) return;
    this.sessionModes.set(sessionId, mode);
    setCodexSessionMode(sessionId, mode);
  }

  async abort(sessionId: string, _cwd: string): Promise<void> {
    const claudiaId = this.providerToClaudiaSessionId.get(sessionId) ?? sessionId;
    this.sessionModes.delete(claudiaId);
    this.sessionModes.delete(sessionId);
    this.providerToClaudiaSessionId.delete(sessionId);
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
    await abortCodexSession(sessionId);
  }
}
