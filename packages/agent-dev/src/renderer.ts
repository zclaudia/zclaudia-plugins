import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AgentRuntimeEvent } from '@zclaudia/agent-runtime';

export class EventRenderer {
  constructor(
    private readonly options: {
      jsonl: boolean;
      showRaw: boolean;
      recordPath?: string;
    }
  ) {}

  async render(event: AgentRuntimeEvent): Promise<void> {
    const json = JSON.stringify(event);
    if (this.options.recordPath) {
      await mkdir(path.dirname(this.options.recordPath), { recursive: true });
      await appendFile(this.options.recordPath, `${json}\n`, 'utf8');
    }
    if (this.options.jsonl) {
      process.stdout.write(`${json}\n`);
      return;
    }

    switch (event.type) {
      case 'run.started':
        process.stderr.write(
          `[agent-dev] run=${event.runId} provider=${event.providerType} session=${event.hostSessionId}` +
            `${event.providerSessionId ? ` resume=${event.providerSessionId}` : ''}\n`
        );
        break;
      case 'provider.event':
        if (this.options.showRaw) {
          process.stderr.write(`[provider] ${JSON.stringify(event.event)}\n`);
        }
        break;
      case 'provider.session':
        process.stderr.write(`[agent-dev] provider session=${event.providerSessionId}\n`);
        break;
      case 'system.info':
        process.stderr.write(
          `[agent-dev] model=${event.systemInfo.model || 'unknown'} cwd=${event.systemInfo.cwd || 'unknown'}\n`
        );
        break;
      case 'assistant.delta':
        process.stdout.write(event.content);
        break;
      case 'assistant.thinking':
        if (this.options.showRaw && event.content) {
          process.stderr.write(`[thinking] ${event.content}\n`);
        }
        break;
      case 'tool.started':
        process.stderr.write(`\n[tool:start] ${event.toolName} ${compactJson(event.input)}\n`);
        break;
      case 'tool.activity':
        process.stderr.write(
          `[tool:activity] ${event.toolName || event.toolUseId || 'unknown'} ${event.content || ''}\n`
        );
        break;
      case 'tool.finished':
        process.stderr.write(
          `[tool:${event.isError ? 'error' : 'done'}] ${event.toolName || event.toolUseId} ${compactJson(event.output)}\n`
        );
        break;
      case 'mode.changed':
        process.stderr.write(`[mode] ${event.mode} (${event.reason})\n`);
        break;
      case 'task.updated':
        process.stderr.write(
          `[task] ${event.taskId || 'unknown'} ${event.status || ''} ${event.message || ''}\n`
        );
        break;
      case 'run.retrying':
        process.stderr.write(
          `[retry] ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms\n`
        );
        break;
      case 'permission.requested':
        process.stderr.write(`[permission] waiting for ${event.request.toolName}\n`);
        break;
      case 'permission.resolved':
        process.stderr.write(
          `[permission] ${event.decision.behavior} (${event.source}) request=${event.requestId}\n`
        );
        break;
      case 'runtime.diagnostic':
        if (event.level !== 'debug' || this.options.showRaw) {
          process.stderr.write(`[${event.level}] ${event.code}: ${event.message}\n`);
        }
        break;
      case 'run.completed':
        if (!event.content.endsWith('\n')) process.stdout.write('\n');
        process.stderr.write(
          `[agent-dev] completed${event.degraded ? ' (degraded)' : ''}` +
            `${event.usage ? ` tokens=${event.usage.totalTokens}` : ''}\n`
        );
        break;
      case 'run.failed':
        process.stderr.write(`\n[agent-dev] failed: ${event.error}\n`);
        break;
      case 'run.cancelled':
        process.stderr.write(`\n[agent-dev] cancelled${event.reason ? `: ${event.reason}` : ''}\n`);
        break;
    }
  }
}

function compactJson(value: unknown): string {
  if (value === undefined) return '';
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return json.length > 300 ? `${json.slice(0, 297)}...` : json;
}
