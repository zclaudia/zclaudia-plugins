import { describe, expect, it, vi } from 'vitest';
import { buildClaudeCanUseTool } from '../permissions.js';

describe('buildClaudeCanUseTool plan mode', () => {
  it('auto-allows EnterPlanMode without a permission prompt', async () => {
    const onPermission = vi.fn();
    const canUseTool = buildClaudeCanUseTool(onPermission)!;

    await expect(
      canUseTool(
        'EnterPlanMode',
        {},
        {
          signal: new AbortController().signal,
          toolUseID: 'enter-plan',
        }
      )
    ).resolves.toEqual({ behavior: 'allow' });
    expect(onPermission).not.toHaveBeenCalled();
  });

  it('recognizes the MCP-prefixed enter_plan_mode tool name', async () => {
    const onPermission = vi.fn();
    const canUseTool = buildClaudeCanUseTool(onPermission)!;

    await expect(
      canUseTool(
        'mcp__plan-mode__enter_plan_mode',
        {},
        {
          signal: new AbortController().signal,
          toolUseID: 'enter-plan-mcp',
        }
      )
    ).resolves.toEqual({ behavior: 'allow' });
    expect(onPermission).not.toHaveBeenCalled();
  });

  it('keeps ExitPlanMode on the regular permission flow', async () => {
    const onPermission = vi.fn().mockResolvedValue({
      behavior: 'deny',
      message: 'Add a rollback step.',
    });
    const canUseTool = buildClaudeCanUseTool(onPermission)!;

    await expect(
      canUseTool(
        'ExitPlanMode',
        { plan: '# Plan\n\n1. Change it' },
        {
          signal: new AbortController().signal,
          toolUseID: 'exit-plan',
        }
      )
    ).resolves.toEqual({ behavior: 'deny', message: 'Add a rollback step.' });
    expect(onPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'exit-plan',
        toolName: 'ExitPlanMode',
      })
    );
  });
});
