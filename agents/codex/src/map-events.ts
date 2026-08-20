import type { ProviderRuntimeEvent } from '@zclaudia/plugin-sdk/providers';
import {
  debugLog,
  normalizeClaudiaToolName,
  detectCodexToolSemantic,
  deriveCodexModeTransition,
} from './config.js';
import {
  fileChangeEffectFromChanges,
  fileChangeEffectFromMap,
  makeShellEffect,
} from './tool-effects.js';
import {
  MAX_CODEX_DELTA_BYTES,
  MAX_CODEX_TOOL_INPUT_BYTES,
  MAX_CODEX_TOOL_RESULT_BYTES,
  boundedJsonText,
  boundedToolInput,
  truncateUtf8,
} from './text-budget.js';
import { isRecord } from './app-server-protocol.js';

interface AppServerItem {
  id?: string;
  type: string;
  text?: string;
  command?: string;
  action?: string;
  status?: string;
  namespace?: string;
  name?: string;
  server?: string;
  tool?: string;
  arguments?: string | Record<string, unknown>;
  output?: unknown;
  result?: unknown;
  error?: unknown;
  aggregatedOutput?: string;
  query?: string;
  queries?: string[];
  results?: unknown[] | null;
  fileChanges?: Record<string, { type: string; content?: string; unified_diff?: string }>;
  changes?: Array<{
    path: string;
    kind: { type: string; move_path?: string | null };
    diff?: string;
  }>;
  [key: string]: unknown;
}

export function mapCodexNotification(
  method: string,
  params: Record<string, unknown>
): ProviderRuntimeEvent[] {
  switch (method) {
    case 'item/agentMessage/delta': {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        return [{ type: 'assistant_delta', content: truncateUtf8(delta, MAX_CODEX_DELTA_BYTES) }];
      }
      return [];
    }

    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      // Reasoning travels as thinking_delta, not as assistant text bracketed by
      // literal `<think>` markers: consumers would have to parse those back out,
      // and any that did not would render the tags as prose.
      const delta =
        typeof params.delta === 'string'
          ? params.delta
          : typeof params.text === 'string'
            ? params.text
            : '';
      if (!delta) return [];
      return [
        {
          type: 'thinking_delta',
          thinkingContent: truncateUtf8(delta, MAX_CODEX_DELTA_BYTES),
        },
      ];
    }

    case 'item/started': {
      const item = appServerItem(params.item);
      if (!item) return [];
      if (item.type !== 'reasoning') {
        return mapItemStarted(item);
      }
      return [];
    }

    case 'item/completed': {
      const item = appServerItem(params.item);
      if (!item) return [];
      // A completed reasoning item needs no event — there is no span to close.
      if (item.type === 'reasoning') return [];
      return mapItemCompleted(item);
    }

    case 'item/commandExecution/outputDelta': {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        return [{ type: 'tool_activity', content: truncateUtf8(delta, MAX_CODEX_DELTA_BYTES) }];
      }
      return [];
    }

    case 'item/fileChange/outputDelta': {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        return [{ type: 'tool_activity', content: truncateUtf8(delta, MAX_CODEX_DELTA_BYTES) }];
      }
      return [];
    }

    case 'item/mcpToolCall/progress': {
      const progress =
        typeof params.message === 'string'
          ? params.message
          : typeof params.progress === 'string'
            ? params.progress
            : undefined;
      if (progress) {
        return [{ type: 'tool_activity', content: truncateUtf8(progress, MAX_CODEX_DELTA_BYTES) }];
      }
      return [];
    }

    case 'item/plan/delta': {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        return [{ type: 'assistant_delta', content: truncateUtf8(delta, MAX_CODEX_DELTA_BYTES) }];
      }
      return [];
    }

    default:
      return [];
  }
}

function appServerItem(value: unknown): AppServerItem | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  return value as unknown as AppServerItem;
}

function currentFileChanges(value: unknown): AppServerItem['changes'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap(candidate => {
    if (!isRecord(candidate) || typeof candidate.path !== 'string' || !isRecord(candidate.kind)) {
      return [];
    }
    const type = candidate.kind.type;
    if (type !== 'add' && type !== 'delete' && type !== 'update') return [];
    return [
      {
        path: candidate.path,
        kind: {
          type,
          move_path: typeof candidate.kind.move_path === 'string' ? candidate.kind.move_path : null,
        },
        diff: typeof candidate.diff === 'string' ? candidate.diff : undefined,
      },
    ];
  });
}

function legacyFileChanges(value: unknown): AppServerItem['fileChanges'] | undefined {
  if (!isRecord(value)) return undefined;
  const result: NonNullable<AppServerItem['fileChanges']> = {};
  for (const [path, candidate] of Object.entries(value)) {
    if (!isRecord(candidate) || typeof candidate.type !== 'string') continue;
    result[path] = {
      type: candidate.type,
      content: typeof candidate.content === 'string' ? candidate.content : undefined,
      unified_diff: typeof candidate.unified_diff === 'string' ? candidate.unified_diff : undefined,
    };
  }
  return result;
}

function mapItemStarted(item: AppServerItem): ProviderRuntimeEvent[] {
  switch (item.type) {
    case 'commandExecution': {
      const command = truncateUtf8(
        typeof item.command === 'string'
          ? item.command
          : typeof item.action === 'string'
            ? item.action
            : '',
        MAX_CODEX_TOOL_INPUT_BYTES
      );
      return [
        {
          type: 'tool_started',
          toolUseId: item.id,
          toolName: 'Bash',
          toolInput: { command },
          toolEffect: makeShellEffect(command),
        },
      ];
    }

    case 'fileChange': {
      const fileChanges = legacyFileChanges(item.fileChanges);
      const changes = currentFileChanges(item.changes);
      let changesSummary = changes
        ? changes
            .map(change => {
              if (change.diff) return `${change.path}:\n${change.diff}`;
              if (change.kind?.type === 'add') return `${change.path}: (new file)`;
              if (change.kind?.type === 'delete') return `${change.path}: (deleted)`;
              return change.path;
            })
            .join('\n')
        : '';
      if (!changesSummary && fileChanges) {
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
          toolInput: {
            changes: truncateUtf8(changesSummary, MAX_CODEX_TOOL_INPUT_BYTES),
          },
          toolEffect: fileChangeEffectFromChanges(changes) ?? fileChangeEffectFromMap(fileChanges),
        },
      ];
    }

    case 'mcpToolCall': {
      let toolInput: Record<string, unknown> = {};
      if (item.arguments) {
        try {
          toolInput = boundedToolInput(
            typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments
          );
        } catch {
          debugLog(
            `[Codex AppServer] WARN: Failed to parse mcpToolCall arguments: ${String(item.arguments).slice(0, 200)}`
          );
          toolInput = { _raw: boundedJsonText(item.arguments, MAX_CODEX_TOOL_INPUT_BYTES) };
        }
      }
      const toolName = normalizeClaudiaToolName(
        typeof item.server === 'string'
          ? item.server
          : typeof item.namespace === 'string'
            ? item.namespace
            : undefined,
        typeof item.tool === 'string' ? item.tool : typeof item.name === 'string' ? item.name : ''
      );
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

    case 'webSearch': {
      const query =
        typeof item.query === 'string'
          ? item.query
          : Array.isArray(item.queries) && typeof item.queries[0] === 'string'
            ? item.queries[0]
            : '';
      return [
        {
          type: 'tool_started',
          toolUseId: item.id,
          toolName: 'WebSearch',
          toolInput: {
            query: truncateUtf8(query, MAX_CODEX_TOOL_INPUT_BYTES),
          },
        },
      ];
    }

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
          toolResult: boundedJsonText(
            item.aggregatedOutput ?? item.output ?? '',
            MAX_CODEX_TOOL_RESULT_BYTES
          ),
          isToolError: item.status === 'failed',
        },
      ];

    case 'fileChange': {
      const fileChanges = legacyFileChanges(item.fileChanges);
      const changes = currentFileChanges(item.changes);
      let resultText = item.status === 'completed' ? 'Applied' : 'Failed';
      if ((changes || fileChanges) && item.status === 'completed') {
        const paths = changes?.map(change => change.path) ?? Object.keys(fileChanges ?? {});
        resultText = `Applied changes to: ${paths.join(', ')}`;
      }
      return [
        {
          type: 'tool_finished',
          toolUseId: item.id,
          toolName: 'Edit',
          toolResult: truncateUtf8(resultText, MAX_CODEX_TOOL_RESULT_BYTES),
          isToolError: item.status === 'failed',
          toolEffect: fileChangeEffectFromChanges(changes) ?? fileChangeEffectFromMap(fileChanges),
        },
      ];
    }

    case 'mcpToolCall': {
      const result = item.result ?? item.output ?? item.error;
      const resultText =
        result !== undefined && result !== null
          ? boundedJsonText(result, MAX_CODEX_TOOL_RESULT_BYTES)
          : '';
      const toolName = normalizeClaudiaToolName(
        typeof item.server === 'string'
          ? item.server
          : typeof item.namespace === 'string'
            ? item.namespace
            : undefined,
        typeof item.tool === 'string' ? item.tool : typeof item.name === 'string' ? item.name : ''
      );
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
            parsedInput = boundedToolInput(
              typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments
            );
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
      const output = item.results ?? item.output;
      const resultText =
        output !== undefined && output !== null
          ? boundedJsonText(output, MAX_CODEX_TOOL_RESULT_BYTES)
          : 'Search completed';
      return [
        {
          type: 'tool_finished',
          toolUseId: item.id,
          toolName: 'WebSearch',
          toolResult: resultText,
        },
      ];
    }

    default:
      debugLog(`[Codex AppServer] Unhandled item/completed type: ${item.type} (id=${item.id})`);
      return [];
  }
}
