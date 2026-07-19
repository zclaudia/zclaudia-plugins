import type { ProviderRuntimeEvent } from '@zclaudia/plugin-sdk/providers';
import {
  debugLog,
  normalizeClaudiaToolName,
  detectCodexToolSemantic,
  deriveCodexModeTransition,
} from './config.js';
import { fileChangeEffectFromMap, makeShellEffect } from './tool-effects.js';

interface AppServerItem {
  id?: string;
  type: string;
  text?: string;
  command?: string;
  action?: string;
  status?: string;
  namespace?: string;
  name?: string;
  arguments?: string | Record<string, unknown>;
  output?: unknown;
  aggregatedOutput?: string;
  query?: string;
  queries?: string[];
  fileChanges?: Record<string, { type: string; content?: string; unified_diff?: string }>;
  [key: string]: unknown;
}

export interface MapEventState {
  inReasoningBlock: boolean;
}

export function mapCodexNotification(
  method: string,
  params: Record<string, unknown>,
  state: MapEventState
): ProviderRuntimeEvent[] {
  switch (method) {
    case 'item/agentMessage/delta': {
      const delta = params.delta as string;
      if (delta) {
        return [{ type: 'assistant_delta', content: delta }];
      }
      return [];
    }

    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const delta = (params.delta || params.text || '') as string;
      if (!delta) return [];
      const events: ProviderRuntimeEvent[] = [];
      if (!state.inReasoningBlock) {
        events.push({ type: 'assistant_delta', content: '<think>' });
        state.inReasoningBlock = true;
      }
      events.push({ type: 'assistant_delta', content: delta });
      return events;
    }

    case 'item/started': {
      const item = params.item as AppServerItem;
      if (!item) return [];
      if (item.type !== 'reasoning') {
        return [...closeReasoningBlock(state), ...mapItemStarted(item)];
      }
      return [];
    }

    case 'item/completed': {
      const item = params.item as AppServerItem;
      if (!item) return [];
      if (item.type === 'reasoning') {
        return closeReasoningBlock(state);
      }
      return mapItemCompleted(item);
    }

    case 'item/commandExecution/outputDelta': {
      const delta = params.delta as string;
      if (delta) {
        return [{ type: 'tool_activity', content: delta }];
      }
      return [];
    }

    case 'item/fileChange/outputDelta': {
      const delta = params.delta as string;
      if (delta) {
        return [{ type: 'tool_activity', content: delta }];
      }
      return [];
    }

    case 'item/mcpToolCall/progress': {
      const progress = params.progress as string | undefined;
      if (progress) {
        return [{ type: 'tool_activity', content: progress }];
      }
      return [];
    }

    case 'item/plan/delta': {
      const delta = (params.delta || '') as string;
      if (delta) {
        return [{ type: 'assistant_delta', content: delta }];
      }
      return [];
    }

    default:
      return [];
  }
}

function closeReasoningBlock(state: MapEventState): ProviderRuntimeEvent[] {
  if (state.inReasoningBlock) {
    state.inReasoningBlock = false;
    return [{ type: 'assistant_delta', content: '</think>' }];
  }
  return [];
}

function mapItemStarted(item: AppServerItem): ProviderRuntimeEvent[] {
  switch (item.type) {
    case 'commandExecution':
      return [
        {
          type: 'tool_started',
          toolUseId: item.id,
          toolName: 'Bash',
          toolInput: { command: item.command || item.action || '' },
          toolEffect: makeShellEffect(item.command || item.action || ''),
        },
      ];

    case 'fileChange': {
      const fileChanges = item.fileChanges;
      let changesSummary = '';
      if (fileChanges) {
        changesSummary = Object.entries(fileChanges)
          .map(([path, change]) => {
            if (change.unified_diff) return `${path}:\n${change.unified_diff}`;
            if (change.type === 'add') return `${path}: (new file)`;
            if (change.type === 'delete') return `${path}: (deleted)`;
            return path;
          })
          .join('\n');
      }
      return [
        {
          type: 'tool_started',
          toolUseId: item.id,
          toolName: 'Edit',
          toolInput: { changes: changesSummary },
          toolEffect: fileChangeEffectFromMap(fileChanges),
        },
      ];
    }

    case 'mcpToolCall': {
      let toolInput: Record<string, unknown> = {};
      if (item.arguments) {
        try {
          toolInput =
            typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
        } catch {
          debugLog(
            `[Codex AppServer] WARN: Failed to parse mcpToolCall arguments: ${String(item.arguments).slice(0, 200)}`
          );
          toolInput = { _raw: String(item.arguments) };
        }
      }
      const toolName = normalizeClaudiaToolName(item.namespace, item.name ?? '');
      return [
        {
          type: 'tool_started',
          toolUseId: item.id,
          toolName,
          toolInput,
          toolSemantic: detectCodexToolSemantic(toolName),
        },
      ];
    }

    case 'webSearch':
      return [
        {
          type: 'tool_started',
          toolUseId: item.id,
          toolName: 'WebSearch',
          toolInput: { query: item.query || item.queries?.[0] || '' },
        },
      ];

    default:
      debugLog(`[Codex AppServer] Unhandled item/started type: ${item.type} (id=${item.id})`);
      return [];
  }
}

function mapItemCompleted(item: AppServerItem): ProviderRuntimeEvent[] {
  switch (item.type) {
    case 'commandExecution':
      return [
        {
          type: 'tool_finished',
          toolUseId: item.id,
          toolName: 'Bash',
          toolResult: item.output || item.aggregatedOutput || '',
          isToolError: item.status === 'failed',
        },
      ];

    case 'fileChange': {
      const fileChanges = item.fileChanges;
      let resultText = item.status === 'completed' ? 'Applied' : 'Failed';
      if (fileChanges && item.status === 'completed') {
        const paths = Object.keys(fileChanges);
        resultText = `Applied changes to: ${paths.join(', ')}`;
      }
      return [
        {
          type: 'tool_finished',
          toolUseId: item.id,
          toolName: 'Edit',
          toolResult: resultText,
          isToolError: item.status === 'failed',
          toolEffect: fileChangeEffectFromMap(fileChanges),
        },
      ];
    }

    case 'mcpToolCall': {
      const resultText = item.output
        ? typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output)
        : '';
      const toolName = normalizeClaudiaToolName(item.namespace, item.name ?? '');
      const events: ProviderRuntimeEvent[] = [
        {
          type: 'tool_finished',
          toolUseId: item.id,
          toolName,
          toolResult: resultText,
          isToolError: item.status === 'failed',
        },
      ];
      if (item.status === 'completed') {
        let parsedInput: unknown = {};
        if (item.arguments) {
          try {
            parsedInput =
              typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
          } catch {
            parsedInput = {};
          }
        }
        const transition = deriveCodexModeTransition(toolName, parsedInput, item.id);
        if (transition) {
          events.push({ type: 'mode_transition', modeTransition: transition });
        }
      }
      return events;
    }

    case 'webSearch': {
      const output = item.output
        ? typeof item.output === 'string'
          ? item.output
          : JSON.stringify(item.output)
        : 'Search completed';
      return [
        {
          type: 'tool_finished',
          toolUseId: item.id,
          toolName: 'WebSearch',
          toolResult: output,
        },
      ];
    }

    default:
      debugLog(`[Codex AppServer] Unhandled item/completed type: ${item.type} (id=${item.id})`);
      return [];
  }
}
