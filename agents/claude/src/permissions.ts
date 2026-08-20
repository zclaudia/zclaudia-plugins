import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionCallback } from '@zclaudia/plugin-sdk/providers';

function planToolKind(toolName: string): 'enter' | 'exit' | undefined {
  if (toolName === 'EnterPlanMode' || toolName.endsWith('__enter_plan_mode')) return 'enter';
  if (toolName === 'ExitPlanMode' || toolName.endsWith('__exit_plan_mode')) return 'exit';
  return undefined;
}

function detailFromClaudeRequest(input: {
  title?: string;
  displayName?: string;
  description?: string;
  toolName: string;
}): string {
  const heading = input.title || input.displayName || `Claude wants to use ${input.toolName}`;
  return input.description ? `${heading}\n\n${input.description}` : heading;
}

export function buildClaudeCanUseTool(onPermission?: PermissionCallback): CanUseTool | undefined {
  if (!onPermission) return undefined;

  return async (toolName, toolInput, options): Promise<PermissionResult> => {
    if (options.signal.aborted) {
      return denyAborted();
    }

    // Entering plan mode is an internal mode transition, not a permission or
    // a user decision. ExitPlanMode is the actual approval boundary and stays
    // on the regular permission flow below.
    const planTool = planToolKind(toolName);
    if (planTool === 'enter') return { behavior: 'allow' };

    let decision;
    try {
      decision = await racePermissionWithAbort(
        onPermission({
          requestId: options.toolUseID,
          toolName,
          toolInput,
          detail: detailFromClaudeRequest({
            title: options.title,
            displayName: options.displayName,
            description: options.description,
            toolName,
          }),
          timeoutSeconds: 60,
          timeoutBehavior: 'deny',
        }),
        options.signal
      );
    } catch {
      return options.signal.aborted ? denyAborted() : denyFailed();
    }

    if (decision.behavior === 'allow') {
      return decision.updatedInput === undefined
        ? { behavior: 'allow' }
        : {
            behavior: 'allow',
            updatedInput: decision.updatedInput as Record<string, unknown>,
          };
    }

    return {
      behavior: 'deny',
      message: decision.message || 'Denied by ZClaudia permission policy.',
    };
  };
}

function denyAborted(): PermissionResult {
  return {
    behavior: 'deny',
    interrupt: true,
    message: 'Permission request was aborted.',
  };
}

function denyFailed(): PermissionResult {
  return {
    behavior: 'deny',
    message: 'Permission request failed.',
  };
}

async function racePermissionWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new Error('Permission request was aborted.');
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('Permission request was aborted.'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}
