import { describe, expect, it } from 'vitest';
import { mapCursorEvent } from '../map-events.js';

describe('mapCursorEvent', () => {
  it('maps system init to init with sessionId', () => {
    const { events } = mapCursorEvent({
      type: 'system',
      subtype: 'init',
      session_id: 'sess-1',
      model: 'gpt',
    });
    expect(events).toEqual([expect.objectContaining({ type: 'init', sessionId: 'sess-1' })]);
  });

  it('maps assistant text blocks', () => {
    const { events } = mapCursorEvent({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(events).toEqual([{ type: 'assistant', content: 'hi' }]);
  });

  it('tags createPlan as plan_proposal on tool_use', () => {
    const { events } = mapCursorEvent({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'cp-1',
      tool_call: { createPlanToolCall: { args: { plan: '# Plan\n\n- step 1' } } },
    });
    expect(events[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'createPlan',
      toolSemantic: 'plan_proposal',
    });
  });

  it('emits mode_transition when switchMode to plan completes', () => {
    const { events } = mapCursorEvent({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'sm-1',
      tool_call: {
        switchModeToolCall: {
          args: { targetModeId: 'plan' },
          result: { success: { message: 'switched' } },
        },
      },
    });
    expect(events.some(e => e.type === 'mode_transition')).toBe(true);
    expect(events.find(e => e.type === 'mode_transition')?.modeTransition).toMatchObject({
      mode: 'plan',
      reason: 'enter',
      sourceToolUseId: 'sm-1',
    });
  });

  it('maps result errors to error events', () => {
    const { events } = mapCursorEvent({ type: 'result', subtype: 'error', result: 'boom' });
    expect(events[0]).toMatchObject({ type: 'error', error: 'boom' });
  });

  describe('tool call extraction', () => {
    it('extracts editToolCall with file change effect', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-1',
        tool_call: {
          editToolCall: {
            args: { file: '/path/to/file.ts', content: 'new content' },
          },
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_use',
        toolName: 'Edit',
        toolInput: { file: '/path/to/file.ts', content: 'new content' },
        toolEffect: {
          kind: 'file_change',
          files: [{ path: '/path/to/file.ts', changeKind: 'modify' }],
        },
      });
    });

    it('extracts editToolCall file change effect from target_file arg', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-target-file',
        tool_call: {
          editToolCall: {
            args: { target_file: '/repo/src/lib.ts', content: 'updated' },
          },
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_use',
        toolName: 'Edit',
        toolEffect: {
          kind: 'file_change',
          files: [{ path: '/repo/src/lib.ts', changeKind: 'modify' }],
        },
      });
    });

    it('extracts shellToolCall with shell effect', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-2',
        tool_call: {
          shellToolCall: {
            args: { command: 'ls -la' },
          },
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_use',
        toolName: 'Bash',
        toolInput: { command: 'ls -la' },
        toolEffect: { kind: 'shell', command: 'ls -la' },
      });
    });

    it('extracts readToolCall', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'call-3',
        tool_call: {
          readToolCall: {
            args: { file: '/file.ts' },
          },
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_use',
        toolName: 'Read',
        toolInput: { file: '/file.ts' },
      });
    });
  });

  describe('tool results', () => {
    it('extracts success result with stdout', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'call-3',
        tool_call: {
          shellToolCall: {
            args: { command: 'echo test' },
            result: {
              success: {
                stdout: 'test\n',
                exitCode: 0,
              },
            },
          },
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolResult: 'test\n',
      });
    });

    it('extracts rejected result', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'call-4',
        tool_call: {
          shellToolCall: {
            args: { command: 'rm -rf /' },
            result: {
              rejected: {
                reason: 'Dangerous command',
              },
            },
          },
        },
      });
      expect(events[0].toolResult).toContain('Rejected');
      expect(events[0].toolResult).toContain('Dangerous command');
    });

    it('extracts error result', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'call-5',
        tool_call: {
          readToolCall: {
            args: { file: '/nonexistent' },
            result: {
              error: 'File not found',
            },
          },
        },
      });
      expect(events[0].toolResult).toContain('File not found');
    });

    it('maps editToolCall completed diffString into file change effect', () => {
      const diffString = '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new';
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'call-edit-completed',
        tool_call: {
          editToolCall: {
            args: { path: '/repo/src/app.ts' },
            result: {
              success: {
                path: '/repo/src/app.ts',
                linesAdded: 1,
                linesRemoved: 1,
                diffString,
                message: 'The file /repo/src/app.ts has been updated.',
              },
            },
          },
        },
      });
      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolResult: 'The file /repo/src/app.ts has been updated.',
        toolEffect: {
          kind: 'file_change',
          files: [{ path: '/repo/src/app.ts', changeKind: 'modify', summary: diffString }],
        },
      });
    });
  });

  describe('plan-mode tools', () => {
    it('switchMode(targetModeId=plan) tags as plan_enter and emits enter transition', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'sm-1',
        tool_call: {
          switchModeToolCall: {
            args: { targetModeId: 'plan' },
            result: { success: { message: 'switched' } },
          },
        },
      });

      const transition = events.find(e => e.type === 'mode_transition');
      expect(transition).toBeDefined();
      expect(transition?.modeTransition).toMatchObject({
        mode: 'plan',
        reason: 'enter',
        sourceToolUseId: 'sm-1',
      });
    });

    it('switchMode(targetModeId=agent) tags as plan_exit and emits exit transition', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'completed',
        call_id: 'sm-2',
        tool_call: {
          switchModeToolCall: {
            args: { targetModeId: 'agent' },
            result: { success: { message: 'switched' } },
          },
        },
      });

      const transition = events.find(e => e.type === 'mode_transition');
      expect(transition?.modeTransition).toMatchObject({
        mode: 'default',
        reason: 'exit',
      });
    });

    it('createPlan tags as plan_proposal and does not emit mode_transition', () => {
      const { events } = mapCursorEvent({
        type: 'tool_call',
        subtype: 'started',
        call_id: 'cp-1',
        tool_call: {
          createPlanToolCall: {
            args: { plan: '# Plan\n\n- step 1' },
          },
        },
      });

      const toolUse = events.find(e => e.type === 'tool_use');
      expect(toolUse?.toolName).toBe('createPlan');
      expect(toolUse?.toolSemantic).toBe('plan_proposal');

      const transitions = events.filter(e => e.type === 'mode_transition');
      expect(transitions).toHaveLength(0);
    });
  });

  describe('thinking', () => {
    it('maps a thinking delta to thinking_delta, not assistant text', () => {
      const { events } = mapCursorEvent({
        type: 'thinking',
        subtype: 'delta',
        text: 'Let me think...',
      });
      expect(events).toEqual([{ type: 'thinking_delta', thinkingContent: 'Let me think...' }]);
    });

    it('keeps reasoning out of the assistant content stream entirely', () => {
      const deltas = ['Let me think...', ' more thinking'].flatMap(
        text => mapCursorEvent({ type: 'thinking', subtype: 'delta', text }).events
      );
      expect(deltas.every(event => event.type === 'thinking_delta')).toBe(true);
      // No literal markers to be parsed back out downstream.
      expect(JSON.stringify(deltas)).not.toContain('think>');
    });

    it('emits nothing on completed — there is no open span to close', () => {
      expect(mapCursorEvent({ type: 'thinking', subtype: 'completed' }).events).toEqual([]);
    });

    it('ignores a delta with no text', () => {
      expect(mapCursorEvent({ type: 'thinking', subtype: 'delta', text: '' }).events).toEqual([]);
    });

    it('passes an assistant message through untouched after thinking', () => {
      mapCursorEvent({ type: 'thinking', subtype: 'delta', text: 'reasoning' });
      const { events } = mapCursorEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'answer' }] },
      });
      expect(events).toEqual([{ type: 'assistant', content: 'answer' }]);
    });
  });

  describe('result events', () => {
    it('maps successful result with usage', () => {
      const { events } = mapCursorEvent({
        type: 'result',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      });
      expect(events[0]).toMatchObject({
        type: 'result',
        isComplete: true,
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
        },
      });
    });

    it('maps error result', () => {
      const { events } = mapCursorEvent({
        type: 'result',
        subtype: 'error',
        result: 'Something went wrong',
      });
      expect(events[0]).toMatchObject({
        type: 'error',
        error: 'Something went wrong',
      });
    });

    it('maps result with is_error flag', () => {
      const { events } = mapCursorEvent({
        type: 'result',
        is_error: true,
        result: 'Error occurred',
      });
      expect(events[0]).toMatchObject({
        type: 'error',
        error: 'Error occurred',
      });
    });
  });
});
