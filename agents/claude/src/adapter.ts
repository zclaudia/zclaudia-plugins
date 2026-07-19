import type {
  ExternalAgentAdapter,
  ExternalAgentRunContext,
  ExternalAgentRunState,
  PermissionCallback,
  ProviderRuntimeEvent,
  ProviderToolBridgeEntry,
  ProviderToolBridgeRequest,
} from '@zclaudia/plugin-sdk/providers';
import { loadClaudeAgentConfig } from './config.js';
import { buildClaudeCanUseTool } from './permissions.js';
import type { ClaudeAgentRunOptions } from './runner.js';
import { runClaudeAgent } from './runner.js';

type ToolBridgeFactory = (
  req: ProviderToolBridgeRequest
) => Promise<ProviderToolBridgeEntry | null>;
type ClaudeMcpServers = NonNullable<ClaudeAgentRunOptions['mcpServers']>;
type ClaudeThinkingOptions = Pick<ClaudeAgentRunOptions, 'thinking' | 'effort'>;

const CLAUDE_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);

function toClaudePermissionMode(mode?: string): ClaudeAgentRunOptions['permissionMode'] {
  return mode && CLAUDE_PERMISSION_MODES.has(mode)
    ? (mode as ClaudeAgentRunOptions['permissionMode'])
    : undefined;
}

function toClaudeThinkingOptions(
  level: ExternalAgentRunContext['thinkingLevel']
): ClaudeThinkingOptions {
  if (!level) return {};
  if (level === 'off') return { thinking: { type: 'disabled' } };
  const effort = level === 'minimal' ? 'low' : level;
  return { thinking: { type: 'adaptive' }, effort };
}

export class ClaudeAgentAdapter implements ExternalAgentAdapter {
  readonly type = 'claude';
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly runStates = new WeakMap<ExternalAgentRunContext, ExternalAgentRunState>();

  constructor(private readonly createToolBridge: ToolBridgeFactory) {}

  async *run(
    input: string,
    context: ExternalAgentRunContext,
    onPermission?: PermissionCallback
  ): AsyncGenerator<ProviderRuntimeEvent, void, void> {
    const key = context.sessionId || context.claudiaSessionId || `pending:${Date.now()}`;
    const abortController = context.abortController ?? new AbortController();
    this.abortControllers.set(key, abortController);
    this.runStates.set(context, { providerSessionId: context.sessionId, providerCwd: context.cwd });
    let currentKey = key;

    try {
      const claudeConfig = loadClaudeAgentConfig();
      const bridge = await this.createToolBridge({
        serverPort: context.serverPort,
        sessionId: context.claudiaSessionId,
      });
      // A user-configured MCP server already registered under the bridge's name
      // wins over the injected tool bridge (mirrors the original mergeClaudeMcpServers).
      const mcpServers: ClaudeMcpServers =
        bridge && !claudeConfig.mcpServers[bridge.name]
          ? { ...claudeConfig.mcpServers, [bridge.name]: bridge.config as ClaudeMcpServers[string] }
          : claudeConfig.mcpServers;
      const thinkingOptions = toClaudeThinkingOptions(context.thinkingLevel);
      yield* runClaudeAgent(input, {
        cwd: context.cwd,
        sessionId: context.sessionId,
        env: context.env,
        cliPath: context.cliPath,
        permissionMode: toClaudePermissionMode(context.mode),
        model: context.model,
        ...thinkingOptions,
        systemPrompt: context.systemPrompt,
        abortController,
        canUseTool: buildClaudeCanUseTool(onPermission),
        mcpServers,
        plugins: claudeConfig.plugins,
        onSessionId: sessionId => {
          if (sessionId && sessionId !== currentKey) {
            this.abortControllers.delete(currentKey);
            currentKey = sessionId;
            this.abortControllers.set(currentKey, abortController);
          }
          this.runStates.set(context, { providerSessionId: sessionId, providerCwd: context.cwd });
        },
      });
    } finally {
      this.abortControllers.delete(currentKey);
    }
  }

  getRunState(context: ExternalAgentRunContext): ExternalAgentRunState {
    return this.runStates.get(context) ?? { providerCwd: context.cwd };
  }

  async abort(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
  }
}
