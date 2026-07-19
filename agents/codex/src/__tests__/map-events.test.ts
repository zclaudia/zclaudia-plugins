import { describe, expect, it } from 'vitest';
import { mapCodexNotification, type MapEventState } from '../map-events.js';

function freshState(): MapEventState {
  return { inReasoningBlock: false };
}

describe('mapCodexNotification', () => {
  it('maps item/agentMessage/delta to assistant_delta', () => {
    const events = mapCodexNotification(
      'item/agentMessage/delta',
      { delta: 'Hello world' },
      freshState()
    );
    expect(events).toEqual([{ type: 'assistant_delta', content: 'Hello world' }]);
  });

  it('ignores empty agent message deltas', () => {
    expect(mapCodexNotification('item/agentMessage/delta', { delta: '' }, freshState())).toEqual(
      []
    );
  });

  it('maps item/started commandExecution to tool_started Bash with shell effect', () => {
    const events = mapCodexNotification(
      'item/started',
      {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: 'ls -la',
        },
      },
      freshState()
    );
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
    const events = mapCodexNotification(
      'item/completed',
      {
        item: {
          id: 'ep-1',
          type: 'mcpToolCall',
          namespace: 'claudia-plugins',
          name: 'enter_plan_mode',
          status: 'completed',
          output: 'entered plan mode',
        },
      },
      freshState()
    );
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
    const events = mapCodexNotification(
      'item/completed',
      {
        item: {
          id: 'xp-1',
          type: 'mcpToolCall',
          namespace: 'claudia-plugins',
          name: 'exit_plan_mode',
          status: 'completed',
          arguments: JSON.stringify({ plan: '# Plan' }),
          output: 'plan submitted',
        },
      },
      freshState()
    );
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
    const events = mapCodexNotification(
      'item/started',
      {
        item: {
          id: 'xp-2',
          type: 'mcpToolCall',
          namespace: 'claudia-plugins',
          name: 'exit_plan_mode',
          arguments: JSON.stringify({ plan: '# Plan' }),
        },
      },
      freshState()
    );
    expect(events[0]).toMatchObject({
      type: 'tool_started',
      toolName: 'ExitPlanMode',
      toolSemantic: 'plan_proposal',
    });
  });

  describe('reasoning blocks', () => {
    it('opens reasoning block with redacted_thinking tag on first textDelta', () => {
      const state = freshState();
      const events = mapCodexNotification(
        'item/reasoning/textDelta',
        { delta: 'thinking...' },
        state
      );
      expect(events).toEqual([
        { type: 'assistant_delta', content: '<think>' },
        { type: 'assistant_delta', content: 'thinking...' },
      ]);
      expect(state.inReasoningBlock).toBe(true);
    });

    it('continues reasoning block without reopening tag', () => {
      const state = { inReasoningBlock: true };
      const events = mapCodexNotification(
        'item/reasoning/summaryTextDelta',
        { text: ' more' },
        state
      );
      expect(events).toEqual([{ type: 'assistant_delta', content: ' more' }]);
      expect(state.inReasoningBlock).toBe(true);
    });

    it('closes reasoning block when reasoning item completes', () => {
      const state = { inReasoningBlock: true };
      const events = mapCodexNotification(
        'item/completed',
        { item: { id: 'r-1', type: 'reasoning', status: 'completed' } },
        state
      );
      expect(events).toEqual([{ type: 'assistant_delta', content: '</think>' }]);
      expect(state.inReasoningBlock).toBe(false);
    });

    it('closes reasoning block when non-reasoning item starts', () => {
      const state = { inReasoningBlock: true };
      const events = mapCodexNotification(
        'item/started',
        {
          item: {
            id: 'cmd-2',
            type: 'commandExecution',
            command: 'echo hi',
          },
        },
        state
      );
      expect(events[0]).toEqual({
        type: 'assistant_delta',
        content: '</think>',
      });
      expect(events[1]).toMatchObject({
        type: 'tool_started',
        toolName: 'Bash',
      });
      expect(state.inReasoningBlock).toBe(false);
    });
  });

  describe('tool activity', () => {
    it('maps commandExecution outputDelta to tool_activity', () => {
      const events = mapCodexNotification(
        'item/commandExecution/outputDelta',
        { delta: 'output line\n' },
        freshState()
      );
      expect(events).toEqual([{ type: 'tool_activity', content: 'output line\n' }]);
    });

    it('maps fileChange outputDelta to tool_activity', () => {
      const events = mapCodexNotification(
        'item/fileChange/outputDelta',
        { delta: '+added line' },
        freshState()
      );
      expect(events).toEqual([{ type: 'tool_activity', content: '+added line' }]);
    });

    it('maps mcpToolCall progress to tool_activity', () => {
      const events = mapCodexNotification(
        'item/mcpToolCall/progress',
        { progress: '50% done' },
        freshState()
      );
      expect(events).toEqual([{ type: 'tool_activity', content: '50% done' }]);
    });
  });

  describe('file and command completion', () => {
    it('maps commandExecution completed to tool_finished', () => {
      const events = mapCodexNotification(
        'item/completed',
        {
          item: {
            id: 'cmd-3',
            type: 'commandExecution',
            status: 'completed',
            output: 'done',
          },
        },
        freshState()
      );
      expect(events[0]).toMatchObject({
        type: 'tool_finished',
        toolUseId: 'cmd-3',
        toolName: 'Bash',
        toolResult: 'done',
        isToolError: false,
      });
    });

    it('maps fileChange started to tool_started Edit with file effect', () => {
      const events = mapCodexNotification(
        'item/started',
        {
          item: {
            id: 'fc-1',
            type: 'fileChange',
            fileChanges: {
              'src/a.ts': { type: 'modify', unified_diff: '--- a\n+++ b' },
            },
          },
        },
        freshState()
      );
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
      const events = mapCodexNotification(
        'item/completed',
        {
          item: {
            id: 'fc-2',
            type: 'fileChange',
            status: 'completed',
            fileChanges: {
              'src/a.ts': { type: 'modify' },
              'src/b.ts': { type: 'add' },
            },
          },
        },
        freshState()
      );
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
      const started = mapCodexNotification(
        'item/started',
        { item: { id: 'ws-1', type: 'webSearch', query: 'vitest docs' } },
        freshState()
      );
      expect(started[0]).toMatchObject({
        type: 'tool_started',
        toolName: 'WebSearch',
        toolInput: { query: 'vitest docs' },
      });

      const completed = mapCodexNotification(
        'item/completed',
        {
          item: {
            id: 'ws-1',
            type: 'webSearch',
            status: 'completed',
            output: 'results...',
          },
        },
        freshState()
      );
      expect(completed[0]).toMatchObject({
        type: 'tool_finished',
        toolResult: 'results...',
      });
    });
  });

  describe('plan deltas', () => {
    it('maps item/plan/delta to assistant_delta', () => {
      const events = mapCodexNotification('item/plan/delta', { delta: '# Step 1' }, freshState());
      expect(events).toEqual([{ type: 'assistant_delta', content: '# Step 1' }]);
    });
  });

  describe('mcp tool naming', () => {
    it('normalizes non-claudia mcp tools to mcp:namespace:name', () => {
      const events = mapCodexNotification(
        'item/started',
        {
          item: {
            id: 'mcp-1',
            type: 'mcpToolCall',
            namespace: 'my-server',
            name: 'do_thing',
            arguments: '{}',
          },
        },
        freshState()
      );
      expect(events[0]).toMatchObject({
        type: 'tool_started',
        toolName: 'mcp:my-server:do_thing',
      });
    });
  });

  describe('failed tools', () => {
    it('marks failed commandExecution as isToolError', () => {
      const events = mapCodexNotification(
        'item/completed',
        {
          item: {
            id: 'cmd-fail',
            type: 'commandExecution',
            status: 'failed',
            output: 'error output',
          },
        },
        freshState()
      );
      expect(events[0]).toMatchObject({
        type: 'tool_finished',
        isToolError: true,
        toolResult: 'error output',
      });
    });
  });
});
