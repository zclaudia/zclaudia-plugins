import { randomUUID } from 'node:crypto';
import type { PermissionRequest } from '@zclaudia/plugin-sdk/interactions';
import type { PermissionCallback } from '@zclaudia/plugin-sdk/providers';

export type ApprovalDecisionResult = {
  decision?: 'accept' | 'decline';
  permissions?: Record<string, unknown>;
  scope?: string;
};

type RequestedPermissions = {
  fileSystem?: { read?: string[] | null; write?: string[] | null };
  network?: { enabled?: boolean | null };
};

function isApprovalMethod(method: string): boolean {
  return (
    method.includes('requestApproval') || method.includes('Approval') || method.includes('approval')
  );
}

export function mapApprovalToPermissionRequest(
  method: string,
  params?: Record<string, unknown>
): PermissionRequest {
  const command = (params?.command as string) || '';
  let toolName = 'Unknown';
  let toolInput: Record<string, unknown> = {};
  let detail = '';

  if (method === 'item/commandExecution/requestApproval') {
    toolName = 'Bash';
    toolInput = { command };
    detail = command || JSON.stringify(params?.commandActions || []).slice(0, 300);
  } else if (method === 'item/fileChange/requestApproval') {
    toolName = 'Edit';
    const reason = (params?.reason as string) || '';
    const grantRoot = (params?.grantRoot as string) || '';
    toolInput = { grantRoot, reason };
    detail = reason || grantRoot || `File change (item: ${params?.itemId || 'unknown'})`;
  } else {
    const lowerMethod = method.toLowerCase();
    if (lowerMethod.includes('commandexecution') || lowerMethod.includes('execcommand')) {
      toolName = 'Bash';
      toolInput = { command };
      detail = command;
    } else if (lowerMethod.includes('filechange') || lowerMethod.includes('applypatch')) {
      toolName = 'Edit';
      detail = (params?.reason as string) || JSON.stringify(params || {}).slice(0, 200);
    } else {
      detail = command || JSON.stringify(params || {}).slice(0, 200);
    }
  }

  return {
    toolName,
    toolInput,
    detail,
    requestId: `codex-${randomUUID()}`,
    timeoutSeconds: 0,
  };
}

function buildPermissionsResponse(
  requestedPermissions: RequestedPermissions | undefined,
  scope: 'session' | 'turn'
): ApprovalDecisionResult {
  if (scope === 'session' && requestedPermissions) {
    return {
      permissions: {
        fileSystem: requestedPermissions.fileSystem || undefined,
        network: requestedPermissions.network || undefined,
      },
      scope: 'session',
    };
  }
  return { permissions: {}, scope: 'turn' };
}

async function resolvePermissionsApproval(
  currentMode: string | undefined,
  params: Record<string, unknown> | undefined,
  onPermission: PermissionCallback | null
): Promise<ApprovalDecisionResult> {
  const requestedPermissions = params?.permissions as RequestedPermissions | undefined;

  if (currentMode === 'plan') {
    return { permissions: {}, scope: 'turn' };
  }

  if (currentMode === 'bypassPermissions' && requestedPermissions) {
    return buildPermissionsResponse(requestedPermissions, 'session');
  }

  if (onPermission) {
    try {
      const detail = requestedPermissions
        ? JSON.stringify(requestedPermissions)
        : (params?.reason as string) || 'Additional permissions requested';
      const permissionRequest: PermissionRequest = {
        toolName: 'Permissions',
        toolInput: requestedPermissions || {},
        detail,
        requestId: `codex-${randomUUID()}`,
        timeoutSeconds: 0,
      };
      const decision = await onPermission(permissionRequest);
      const approved = decision.behavior === 'allow';
      return approved
        ? buildPermissionsResponse(requestedPermissions, 'session')
        : { permissions: {}, scope: 'turn' };
    } catch {
      return { permissions: {}, scope: 'turn' };
    }
  }

  return { permissions: {}, scope: 'turn' };
}

export async function resolveApprovalDecision(
  currentMode: string | undefined,
  method: string,
  params: Record<string, unknown> | undefined,
  onPermission: PermissionCallback | null
): Promise<ApprovalDecisionResult> {
  if (!isApprovalMethod(method)) {
    return {};
  }

  if (method === 'item/permissions/requestApproval') {
    return resolvePermissionsApproval(currentMode, params, onPermission);
  }

  if (currentMode === 'plan') {
    return { decision: 'decline' };
  }

  if (currentMode === 'bypassPermissions') {
    return { decision: 'accept' };
  }

  if (currentMode === 'acceptEdits' && method === 'item/fileChange/requestApproval') {
    return { decision: 'accept' };
  }

  if (onPermission) {
    try {
      const permissionRequest = mapApprovalToPermissionRequest(method, params);
      const decision = await onPermission(permissionRequest);
      const approved = decision.behavior === 'allow';
      return { decision: approved ? 'accept' : 'decline' };
    } catch {
      return { decision: 'decline' };
    }
  }

  return { decision: 'decline' };
}
