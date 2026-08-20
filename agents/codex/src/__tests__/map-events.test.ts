import { describe, expect, it } from 'vitest';
import { mapCodexNotification } from '../map-events.js';
import { MAX_CODEX_DELTA_BYTES, MAX_CODEX_TOOL_RESULT_BYTES } from '../text-budget.js';

describe('mapCodexNotification', () => {
  it('maps item/agentMessage/delta to assistant_delta', () => {
    const events = mapCodexNotification('item/agentMessage/delta', { delta: 'Hello world' });
    expect(events).toEqual([{ type: 'assistant_delta', content: 'Hello world' }]);
  });

  it('ignores empty agent message deltas', () => {
    expect(mapCodexNotification('item/agentMessage/delta', { delta: '' })).toEqual([]);
    expect(mapCodexNotification('item/agentMessage/delta', { delta: { text: 'bad' } })).toEqual([]);
  });

  it('bounds streamed deltas and completed tool output by UTF-8 bytes', () => {
    const delta = mapCodexNotification('item/agentMessage/delta', {
      delta: '界'.repeat(MAX_CODEX_DELTA_BYTES),
    })[0];
    const completed = mapCodexNotification('item/completed', {
      item: {
        id: 'cmd-large',
        type: 'commandExecution',
        status: 'completed',
        aggregatedOutput: 'x'.repeat(MAX_CODEX_TOOL_RESULT_BYTES + 100),
      },
    })[0];

    expect(Buffer.byteLength(delta.content ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_CODEX_DELTA_BYTES
    );
    expect(Buffer.byteLength(String(completed.toolResult), 'utf8')).toBeLessThanOrEqual(
      MAX_CODEX_TOOL_RESULT_BYTES
    );
    expect(completed.toolResult).toContain('[truncated]');
  });

  it('maps item/started commandExecution to tool_started Bash with shell effect', () => {
    const events = mapCodexNotification('item/started', {
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'ls -la',
      },
    });
    expect(events).toEqual([
      {
        type: 'tool_started',
        toolUseId: 'cmd-1',
        toolName: 'Bash',
        toolInput: { command: 'ls -la' },
        toolEffect: { kind: 'shell', command: 'ls -la' },
      },
    ]);
  });

  it('maps item/completed mcpToolCall enter_plan_mode to tool_finished and mode_transition enter', () => {
    const events = mapCodexNotification('item/completed', {
      item: {
        id: 'ep-1',
        type: 'mcpToolCall',
        server: 'claudia-plugins',
        tool: 'enter_plan_mode',
        status: 'completed',
        result: 'entered plan mode',
      },
    });
    expect(events).toEqual([
      {
        type: 'tool_finished',
        toolUseId: 'ep-1',
        toolName: 'EnterPlanMode',
        toolResult: 'entered plan mode',
        isToolError: false,
      },
      {
        type: 'mode_transition',
        modeTransition: {
          mode: 'plan',
          reason: 'enter',
          sourceToolUseId: 'ep-1',
        },
      },
    ]);
  });

  it('maps item/completed mcpToolCall exit_plan_mode with plan to tool_finished and mode_transition exit', () => {
    const events = mapCodexNotification('item/completed', {
      item: {
        id: 'xp-1',
        type: 'mcpToolCall',
        server: 'claudia-plugins',
        tool: 'exit_plan_mode',
        status: 'completed',
        arguments: { plan: '# Plan' },
        result: 'plan submitted',
      },
    });
    expect(events).toEqual([
      {
        type: 'tool_finished',
        toolUseId: 'xp-1',
        toolName: 'ExitPlanMode',
        toolResult: 'plan submitted',
        isToolError: false,
      },
      {
        type: 'mode_transition',
        modeTransition: {
          mode: 'default',
          reason: 'exit',
          plan: '# Plan',
          sourceToolUseId: 'xp-1',
        },
      },
    ]);
  });

  it('tags exit_plan_mode tool_started with plan_proposal semantic', () => {
    const events = mapCodexNotification('item/started', {
      item: {
        id: 'xp-2',
        type: 'mcpToolCall',
        server: 'claudia-plugins',
        tool: 'exit_plan_mode',
        arguments: { plan: '# Plan' },
      },
    });
    expect(events[0]).toMatchObject({
      type: 'tool_started',
      toolName: 'ExitPlanMode',
      toolSemantic: 'plan_proposal',
    });
  });

  describe('reasoning blocks', () => {
    it('opens reasoning block with redacted_thinking tag on first textDelta', () => {
      const events = mapCodexNotification('item/reasoning/textDelta', { delta: 'thinking...' });
      expect(events).toEqual([{ type: 'thinking_delta', thinkingContent: 'thinking...' }]);
    });

    it('maps a summary delta the same way', () => {
      const events = mapCodexNotification('item/reasoning/summaryTextDelta', { text: ' more' });
      expect(events).toEqual([{ type: 'thinking_delta', thinkingContent: ' more' }]);
    });

    it('keeps reasoning out of the assistant text stream entirely', () => {
      const events = [
        ...mapCodexNotification('item/reasoning/textDelta', { delta: 'thinking...' }),
        ...mapCodexNotification('item/reasoning/textDelta', { delta: ' more' }),
      ];
      expect(events.every(event => event.type === 'thinking_delta')).toBe(true);
      // No literal markers left for a downstream consumer to parse back out.
      expect(JSON.stringify(events)).not.toContain('think>');
    });

    it('emits nothing when a reasoning item completes', () => {
      const events = mapCodexNotification('item/completed', {
        item: { id: 'r-1', type: 'reasoning', status: 'completed' },
      });
      expect(events).toEqual([]);
    });

    it('starts a non-reasoning item without any closing marker', () => {
      const events = mapCodexNotification('item/started', {
        item: { id: 'cmd-2', type: 'commandExecution', command: 'echo hi' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'tool_started', toolName: 'Bash' });
    });
  });

  describe('tool activity', () => {
    it('maps commandExecution outputDelta to tool_activity', () => {
      const events = mapCodexNotification('item/commandExecution/outputDelta', {
        delta: 'output line\n',
      });
      expect(events).toEqual([{ type: 'tool_activity', content: 'output line\n' }]);
    });

    it('maps fileChange outputDelta to tool_activity', () => {
      const events = mapCodexNotification('item/fileChange/outputDelta', { delta: '+added line' });
      expect(events).toEqual([{ type: 'tool_activity', content: '+added line' }]);
    });

    it('maps mcpToolCall progress to tool_activity', () => {
      const events = mapCodexNotification('item/mcpToolCall/progress', { message: '50% done' });
      expect(events).toEqual([{ type: 'tool_activity', content: '50% done' }]);
    });
  });

  describe('file and command completion', () => {
    it('maps commandExecution completed to tool_finished', () => {
      const events = mapCodexNotification('item/completed', {
        item: {
          id: 'cmd-3',
          type: 'commandExecution',
          status: 'completed',
          aggregatedOutput: 'done',
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_finished',
        toolUseId: 'cmd-3',
        toolName: 'Bash',
        toolResult: 'done',
        isToolError: false,
      });
    });

    it('maps fileChange started to tool_started Edit with file effect', () => {
      const events = mapCodexNotification('item/started', {
        item: {
          id: 'fc-1',
          type: 'fileChange',
          changes: [
            {
              path: 'src/a.ts',
              kind: { type: 'update', move_path: null },
              diff: '--- a\n+++ b',
            },
          ],
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_started',
        toolName: 'Edit',
        toolEffect: {
          kind: 'file_change',
          files: [{ path: 'src/a.ts', changeKind: 'modify' }],
        },
      });
    });

    it('maps fileChange completed to tool_finished with paths summary', () => {
      const events = mapCodexNotification('item/completed', {
        item: {
          id: 'fc-2',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '' },
            { path: 'src/b.ts', kind: { type: 'add' }, diff: '' },
          ],
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_finished',
        toolName: 'Edit',
        toolResult: 'Applied changes to: src/a.ts, src/b.ts',
        isToolError: false,
      });
    });
  });

  describe('web search', () => {
    it('maps webSearch started and completed', () => {
      const started = mapCodexNotification('item/started', {
        item: { id: 'ws-1', type: 'webSearch', query: 'vitest docs' },
      });
      expect(started[0]).toMatchObject({
        type: 'tool_started',
        toolName: 'WebSearch',
        toolInput: { query: 'vitest docs' },
      });

      const completed = mapCodexNotification('item/completed', {
        item: {
          id: 'ws-1',
          type: 'webSearch',
          results: ['results...'],
        },
      });
      expect(completed[0]).toMatchObject({
        type: 'tool_finished',
        toolResult: '["results..."]',
      });
    });
  });

  describe('plan deltas', () => {
    it('maps item/plan/delta to assistant_delta', () => {
      const events = mapCodexNotification('item/plan/delta', { delta: '# Step 1' });
      expect(events).toEqual([{ type: 'assistant_delta', content: '# Step 1' }]);
    });
  });

  describe('mcp tool naming', () => {
    it('normalizes non-claudia mcp tools to mcp:namespace:name', () => {
      const events = mapCodexNotification('item/started', {
        item: {
          id: 'mcp-1',
          type: 'mcpToolCall',
          server: 'my-server',
          tool: 'do_thing',
          arguments: {},
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_started',
        toolName: 'mcp:my-server:do_thing',
      });
    });

    it('preserves false-y MCP results', () => {
      const events = mapCodexNotification('item/completed', {
        item: {
          id: 'mcp-false',
          type: 'mcpToolCall',
          server: 'my-server',
          tool: 'check',
          status: 'completed',
          result: false,
        },
      });
      expect(events[0]).toMatchObject({ toolResult: 'false' });
    });
  });

  describe('failed tools', () => {
    it('marks failed commandExecution as isToolError', () => {
      const events = mapCodexNotification('item/completed', {
        item: {
          id: 'cmd-fail',
          type: 'commandExecution',
          status: 'failed',
          aggregatedOutput: 'error output',
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_finished',
        isToolError: true,
        toolResult: 'error output',
      });
    });
  });
});
