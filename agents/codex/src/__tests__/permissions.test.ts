import { describe, expect, it, vi } from 'vitest';
import { mapApprovalToPermissionRequest, resolveApprovalDecision } from '../permissions.js';

describe('mapApprovalToPermissionRequest', () => {
  it('maps command execution approval to Bash tool', () => {
    const req = mapApprovalToPermissionRequest('item/commandExecution/requestApproval', {
      command: 'npm test',
    });
    expect(req.toolName).toBe('Bash');
    expect(req.toolInput).toEqual({ command: 'npm test' });
    expect(req.detail).toBe('npm test');
    expect(req.requestId).toMatch(/^codex-/);
    expect(req.timeoutSeconds).toBe(0);
  });

  it('maps file change approval to Edit tool', () => {
    const req = mapApprovalToPermissionRequest('item/fileChange/requestApproval', {
      reason: 'fix bug',
      grantRoot: '/path',
    });
    expect(req.toolName).toBe('Edit');
    expect(req.toolInput).toEqual({ grantRoot: '/path', reason: 'fix bug' });
    expect(req.detail).toBe('fix bug');
  });

  it('assigns unique ids to concurrent approval requests', () => {
    const first = mapApprovalToPermissionRequest('item/commandExecution/requestApproval', {
      command: 'command-a',
    });
    const second = mapApprovalToPermissionRequest('item/commandExecution/requestApproval', {
      command: 'command-b',
    });

    expect(first.requestId).not.toBe(second.requestId);
  });
});

describe('resolveApprovalDecision', () => {
  it('declines writes in plan mode', async () => {
    const r = await resolveApprovalDecision('plan', 'item/fileChange/requestApproval', {}, null);
    expect(r.decision).toBe('decline');
  });

  it('denies permissions in plan mode', async () => {
    const r = await resolveApprovalDecision(
      'plan',
      'item/permissions/requestApproval',
      { permissions: { network: { enabled: true } } },
      null
    );
    expect(r.permissions).toEqual({});
    expect(r.scope).toBe('turn');
  });

  it('auto-accepts in bypassPermissions', async () => {
    const r = await resolveApprovalDecision(
      'bypassPermissions',
      'item/commandExecution/requestApproval',
      { command: 'rm -rf /' },
      null
    );
    expect(r.decision).toBe('accept');
  });

  it('grants requested permissions in bypassPermissions', async () => {
    const requested = {
      fileSystem: { write: ['/tmp'] },
      network: { enabled: true },
    };
    const r = await resolveApprovalDecision(
      'bypassPermissions',
      'item/permissions/requestApproval',
      { permissions: requested },
      null
    );
    expect(r.permissions).toEqual(requested);
    expect(r.scope).toBe('session');
  });

  it('auto-accepts file change in acceptEdits', async () => {
    const r = await resolveApprovalDecision(
      'acceptEdits',
      'item/fileChange/requestApproval',
      {},
      null
    );
    expect(r.decision).toBe('accept');
  });

  it('forwards command to callback in default mode', async () => {
    const onPermission = vi.fn(async () => ({ behavior: 'allow' as const }));
    const r = await resolveApprovalDecision(
      'default',
      'item/commandExecution/requestApproval',
      { command: 'npm test' },
      onPermission
    );
    expect(onPermission).toHaveBeenCalled();
    expect(r.decision).toBe('accept');
  });

  it('declines when callback returns deny', async () => {
    const onPermission = vi.fn(async () => ({ behavior: 'deny' as const }));
    const r = await resolveApprovalDecision(
      'default',
      'item/commandExecution/requestApproval',
      { command: 'npm test' },
      onPermission
    );
    expect(r.decision).toBe('decline');
  });

  it('declines when no callback is provided', async () => {
    const r = await resolveApprovalDecision(
      'default',
      'item/commandExecution/requestApproval',
      { command: 'npm test' },
      null
    );
    expect(r.decision).toBe('decline');
  });

  it('grants permissions when callback approves', async () => {
    const requested = { network: { enabled: true } };
    const onPermission = vi.fn(async () => ({ behavior: 'allow' as const }));
    const r = await resolveApprovalDecision(
      'default',
      'item/permissions/requestApproval',
      { permissions: requested },
      onPermission
    );
    expect(onPermission).toHaveBeenCalled();
    expect(r.permissions).toEqual(requested);
    expect(r.scope).toBe('session');
  });
});
