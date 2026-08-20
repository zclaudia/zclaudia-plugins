import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  CanUseTool,
  McpServerConfig,
  Options,
  PermissionMode,
  SdkPluginConfig,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProviderRuntimeEvent, SystemInfo } from '@zclaudia/plugin-sdk/providers';
import { inspectClaudeCli, resolveClaudeCliFromPath } from './resolve-cli.js';

export interface ClaudeAgentRunOptions {
  cwd: string;
  sessionId?: string;
  env?: Record<string, string>;
  cliPath?: string;
  permissionMode?: PermissionMode;
  model?: string;
  thinking?: Options['thinking'];
  effort?: Options['effort'];
  systemPrompt?: string;
  abortController?: AbortController;
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, McpServerConfig>;
  plugins?: SdkPluginConfig[];
  onSessionId?: (sessionId: string) => void;
}

export async function* runClaudeAgent(
  input: string,
  options: ClaudeAgentRunOptions
): AsyncGenerator<ProviderRuntimeEvent, void, void> {
  const abortController = options.abortController ?? new AbortController();
  const sdkOptions: Partial<Options> = {
    cwd: options.cwd,
    abortController,
  };

  if (options.sessionId) sdkOptions.resume = options.sessionId;
  if (options.permissionMode) sdkOptions.permissionMode = options.permissionMode;
  if (options.model) sdkOptions.model = options.model;
  if (options.thinking) sdkOptions.thinking = options.thinking;
  if (options.effort) sdkOptions.effort = options.effort;
  if (options.systemPrompt) {
    sdkOptions.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: options.systemPrompt,
    };
  }
  const effectiveEnv = options.env ? { ...process.env, ...options.env } : process.env;
  const cliPath = options.cliPath ?? resolveClaudeCliFromPath(effectiveEnv.PATH);
  if (!cliPath) {
    throw new Error(
      'Claude Code CLI is required. Install Claude Code and ensure `claude` is on PATH, or configure its executable path.'
    );
  }
  const compatibility = inspectClaudeCli(cliPath, { env: effectiveEnv });
  if (compatibility.status === 'blocked') throw new Error(compatibility.message);
  if (compatibility.status === 'warning') console.warn(compatibility.message);
  sdkOptions.pathToClaudeCodeExecutable = cliPath;
  if (options.env) sdkOptions.env = effectiveEnv;
  if (options.canUseTool) sdkOptions.canUseTool = options.canUseTool;
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    sdkOptions.mcpServers = options.mcpServers;
  }
  if (options.plugins && options.plugins.length > 0) {
    sdkOptions.plugins = options.plugins;
  }

  const stream = query({ prompt: input, options: sdkOptions });
  const planModeTools = new Map<string, 'EnterPlanMode' | 'ExitPlanMode'>();
  for await (const message of stream) {
    const transformed = transformClaudeSdkMessage(message);
    const events = Array.isArray(transformed) ? transformed : [transformed];
    for (const event of events) {
      if (event.type === 'init' && event.sessionId) {
        options.onSessionId?.(event.sessionId);
      }
      if ((event.type === 'tool_use' || event.type === 'tool_started') && event.toolUseId) {
        const planTool = canonicalClaudePlanTool(event.toolName);
        if (planTool) planModeTools.set(event.toolUseId, planTool);
      }
      yield event;
      if ((event.type === 'tool_result' || event.type === 'tool_finished') && event.toolUseId) {
        const toolName = planModeTools.get(event.toolUseId);
        planModeTools.delete(event.toolUseId);
        if (toolName && !event.isToolError) {
          const result =
            event.toolResult && typeof event.toolResult === 'object'
              ? (event.toolResult as Record<string, unknown>)
              : undefined;
          const plan =
            toolName === 'ExitPlanMode' && typeof result?.plan === 'string'
              ? result.plan
              : undefined;
          yield {
            type: 'mode_transition',
            modeTransition: {
              mode: toolName === 'EnterPlanMode' ? 'plan' : 'default',
              reason: toolName === 'EnterPlanMode' ? 'enter' : 'exit',
              sourceToolUseId: event.toolUseId,
              ...(plan ? { plan } : {}),
            },
          };
        }
      }
    }
  }
}

function claudeToolSemantic(toolName: unknown): 'plan_enter' | 'plan_proposal' | undefined {
  const canonical = canonicalClaudePlanTool(toolName);
  if (canonical === 'EnterPlanMode') return 'plan_enter';
  if (canonical === 'ExitPlanMode') return 'plan_proposal';
  return undefined;
}

function canonicalClaudePlanTool(toolName: unknown): 'EnterPlanMode' | 'ExitPlanMode' | undefined {
  if (typeof toolName !== 'string') return undefined;
  if (toolName === 'EnterPlanMode' || toolName.endsWith('__enter_plan_mode')) {
    return 'EnterPlanMode';
  }
  if (toolName === 'ExitPlanMode' || toolName.endsWith('__exit_plan_mode')) {
    return 'ExitPlanMode';
  }
  return undefined;
}

export function transformClaudeSdkMessage(
  message: unknown
): ProviderRuntimeEvent | ProviderRuntimeEvent[] {
  const msg = message as Record<string, unknown>;

  if (msg.type === 'system' && msg.subtype === 'init') {
    const systemInfo: SystemInfo = {
      model: msg.model as string | undefined,
      claudeCodeVersion: msg.claude_code_version as string | undefined,
      cwd: msg.cwd as string | undefined,
      tools: msg.tools as string[] | undefined,
      permissionMode: msg.permissionMode as string | undefined,
      slashCommands: msg.slash_commands as string[] | undefined,
      agents: msg.agents as string[] | undefined,
    };
    return {
      type: 'init',
      sessionId: msg.session_id as string | undefined,
      systemInfo,
    };
  }

  if (msg.type === 'system') {
    const subtype = typeof msg.subtype === 'string' ? msg.subtype : 'system';
    const taskId =
      (msg.task_id as string | undefined) ??
      (msg.taskId as string | undefined) ??
      (msg.id as string | undefined);
    if (subtype.startsWith('task_')) {
      const patch = msg.patch as Record<string, unknown> | undefined;
      return {
        type: 'task_notification',
        taskId,
        taskStatus:
          (patch?.status as string | undefined) ??
          (subtype === 'task_started' ? 'started' : subtype.replace(/^task_/, '')),
        taskMessage:
          (msg.description as string | undefined) ??
          (patch?.description as string | undefined) ??
          (patch?.error as string | undefined) ??
          (msg.message as string | undefined) ??
          (msg.title as string | undefined),
      };
    }
    return [];
  }

  if (msg.type === 'tool_progress') {
    return {
      type: 'tool_activity',
      toolUseId: msg.tool_use_id as string | undefined,
      toolName: msg.tool_name as string | undefined,
      taskId: msg.task_id as string | undefined,
      content:
        typeof msg.elapsed_time_seconds === 'number'
          ? `running ${msg.tool_name ?? 'tool'} (${msg.elapsed_time_seconds}s)`
          : undefined,
    };
  }

  if (msg.type === 'tool_use_summary') {
    return {
      type: 'tool_activity',
      content: msg.summary as string | undefined,
    };
  }

  if (msg.type === 'assistant') {
    const blocks = (msg.message as { content?: Array<Record<string, unknown>> } | undefined)
      ?.content;
    if (!Array.isArray(blocks)) return [];

    const events: ProviderRuntimeEvent[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        events.push({ type: 'assistant', content: block.text });
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool_use',
          toolUseId: block.id as string | undefined,
          toolName: block.name as string | undefined,
          toolInput: block.input,
          toolSemantic: claudeToolSemantic(block.name),
        });
      }
    }
    return events.length === 1 ? events[0] : events;
  }

  if (msg.type === 'user') {
    const blocks = (msg.message as { content?: Array<Record<string, unknown>> } | undefined)
      ?.content;
    if (!Array.isArray(blocks)) return [];

    const events = blocks
      .filter(block => block.type === 'tool_result')
      .map<ProviderRuntimeEvent>(block => ({
        type: 'tool_result',
        toolUseId: block.tool_use_id as string | undefined,
        toolResult: block.content,
        isToolError: block.is_error as boolean | undefined,
      }));
    return events.length === 1 ? events[0] : events;
  }

  if (msg.type === 'result') {
    if (msg.subtype === 'error_during_execution') {
      return {
        type: 'error',
        error:
          (msg.error as string | undefined) ??
          (msg.result as string | undefined) ??
          'Claude execution failed',
      };
    }
    return {
      type: 'result',
      content: msg.result as string | undefined,
      isComplete: true,
    };
  }

  return [];
}
